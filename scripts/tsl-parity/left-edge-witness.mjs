import fs from 'node:fs'
import path from 'node:path'
import { chromium } from '../lib/cdp-browser.mjs'
import { assertGpu, gpuArgs } from '../lib/gpu-probe.mjs'
import { decodePng, regionMasks, regionMean, regionMeanAbs } from './png.mjs'
import {
  assertServedClientRoot, clientRootTag, CLIENT_ROOT_BUNDLE,
} from '../lib/served-client-root.mjs'

const arg = (k, d) => { const h = process.argv.find(a => a.startsWith('--' + k + '=')); return h ? h.slice(k.length + 3) : d }

const HOST = arg('host', 'http://localhost:3002')
const POSE = arg('pose', '-2750,-750')
const MIN_VEG = Number(arg('min-veg', '233'))
const OUT = path.resolve(arg('out', path.join('data', 'tsl-parity-nv-' + Date.now())))
const ACCELERATED = !process.argv.includes('--software')
const K = 3
const FLOOR_MIN = 1.0

const HOOKS = ['__reliefShade', '__texNrmK', '__flatNormal', '__fsCheap']

function hookState(set) {
  const alb = set.albedo || [0.8, 0.8, 0.8, 1]
  return 'window.__albedoOverride=[' + alb.join(',') + '];window.__hazeMul=0.4;' +
    HOOKS.map(k => (k in set ? 'window.' + k + '=' + set[k] + ';' : 'delete window.' + k + ';')).join('')
}

const RAW_ALBEDO = [0, 0, 0, 0]

const STEPS = [
  ['grey-a', {}],
  ['grey-b', {}],
  ['greyRelief1-a', { __reliefShade: 1 }],
  ['greyRelief1-b', { __reliefShade: 1 }],
  ['texNrmK0', { __texNrmK: 0 }],
  ['flatNormal', { __flatNormal: 1 }],
  ['texNrmK0FlatNormal', { __texNrmK: 0, __flatNormal: 1 }],
  ['nrm', { __fsCheap: 1 }],
  ['nrmFlat', { __fsCheap: 1, __flatNormal: 1 }],
  ['texDnDir', { __fsCheap: 2 }],
  ['texDnMag', { __fsCheap: 3 }],
  ['albRaw-a', { albedo: RAW_ALBEDO }],
  ['albRaw-b', { albedo: RAW_ALBEDO }],
  ['albRawTexNrmK0', { albedo: RAW_ALBEDO, __texNrmK: 0 }],
]

function settleExpr(minVeg) {
  return '(async()=>{const t0=performance.now();' +
    'while(performance.now()-t0<60000){if(window.__app&&window.__app.terrain&&window.__veg&&window.__timeOfDayApi&&window.__app.cam&&window.__rendererInfo)break;await new Promise(r=>setTimeout(r,300))}' +
    "if(!(window.__app&&window.__app.terrain&&window.__veg&&window.__timeOfDayApi&&window.__app.cam))return JSON.stringify({settle:false,reason:'world objects missing',app:!!window.__app,veg:!!window.__veg});" +
    'const T=window.__timeOfDayApi;T.setFractionFromServer=()=>{};T.setPaused(true);T.setFraction(0.45);' +
    "window.__weatherType='clear';window.__weatherIntensity=0;window.__hazeMul=0.4;window.__threeVdrs=false;window.__albedoOverride=[0,0,0,0];delete window.__reliefShade;" +
    'window.__app.cam.restore({yaw:1.0,pitch:0,zoomIndex:2});' +
    'let prev=-1,settled=false;while(performance.now()-t0<115000){await new Promise(r=>setTimeout(r,5000));const v=window.__veg.totalInstances;if(v>=' + minVeg + '&&v===prev){settled=true;break}prev=v}' +
    'const c=window.__app.renderer.domElement;' +
    "return JSON.stringify({settle:settled,veg:window.__veg.totalInstances,elapsedMs:Math.round(performance.now()-t0),href:location.href,cls:window.__rendererInfo.class,backend:window.__rendererInfo.backend,gpu:window.__rendererInfo.glRenderer,hv:window.__app.terrain.frame.hashVersion,surfReady:window.__surfTexReady===undefined?'undef':window.__surfTexReady,surfErr:window.__surfTexErr||null,canvas:[c.width,c.height,c.clientWidth,c.clientHeight],dpr:devicePixelRatio})})()"
}

function stepExpr(assign, waitMs, label) {
  return '(async()=>{' + assign + ';await new Promise(r=>setTimeout(r,' + waitMs + '));' +
    'let prev=-1;const t0=performance.now();while(performance.now()-t0<20000){const v=window.__veg?window.__veg.totalInstances:-1;if(v===prev)break;prev=v;await new Promise(r=>setTimeout(r,5000))}' +
    "return JSON.stringify({frame:'" + label + "',veg:window.__veg?window.__veg.totalInstances:null,cam:window.__app.cam.save(),reliefShade:window.__reliefShade===undefined?'default':window.__reliefShade,fsCheap:window.__fsCheap===undefined?'default':window.__fsCheap,flatNormal:window.__flatNormal===undefined?'default':window.__flatNormal,albedoOverride:window.__albedoOverride})})()"
}

const wait = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => process.stderr.write(a.join(' ') + '\n')
const DETACHED = /not attached to an active page|target closed|session closed/i
process.on('unhandledRejection', e => {
  const m = String((e && e.message) || e)
  log('[unhandledRejection] ' + m.slice(0, 160))
  if (DETACHED.test(m)) log('[fatal] page detached -- witness invalid')
})

async function runArm(browser, { legacy, tag, gpuProbe }) {
  const stamp = Date.now()
  const url = `${HOST}/?singleplayer&terrainhash=1${legacy ? '&legacygl=1' : ''}&at=${POSE}&v=${tag}${stamp}`
  const page = await browser.newPage({ viewport: { width: 1036, height: 647 } })
  const report = { url, frames: {}, sigs: {} }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    const servedRoot = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: tag })
    log(`[${tag}] served ${clientRootTag(servedRoot)} required=${CLIENT_ROOT_BUNDLE}`)
    const gp = await assertGpu(page, ACCELERATED ? { requireAccelerated: true, expectVendor: 'nvidia' } : {})
    report.rasterizer = gp.rasterizer
    report.renderer = gp.renderer
    report.haystack = gp.haystack
    log(`[${tag}] rasterizer=${gp.rasterizer} renderer=${gp.renderer}`)
    let raw = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      await wait(2000)
      raw = await page.evaluate(settleExpr(MIN_VEG)).catch(e => ({ settle: false, reason: String(e.message).slice(0, 120) }))
      report.settle = typeof raw === 'string' ? JSON.parse(raw) : raw
      log(`[${tag}] settle attempt ${attempt} = ${JSON.stringify(report.settle)}`)
      if (report.settle && report.settle.settle === true) break
      if (attempt < 3) { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); log(`[${tag}] reloading for attempt ${attempt + 1}`) }
    }
    if (!report.settle || report.settle.settle !== true) return report
    for (const [label, set] of STEPS) {
      const sig = await page.evaluate(stepExpr(hookState(set), 2000, label)).catch(e => ({ error: String(e.message).slice(0, 200) }))
      report.sigs[label] = typeof sig === 'string' ? JSON.parse(sig) : sig
      const buf = await page.screenshot({ path: path.join(OUT, `${tag}-${label}.png`) }).catch(e => { log(`[${tag}/${label}] shot failed ${e.message}`); return null })
      if (!buf) continue
      report.frames[label] = decodePng(buf.toString('base64'))
      log(`[${tag}/${label}] veg=${report.sigs[label] && report.sigs[label].veg}`)
    }
  } catch (e) {
    log(`[${tag}] FAILED ${e.message.slice(0, 200)}`)
    report.error = String(e.message).slice(0, 300)
  } finally {
    await page.close().catch(() => {})
  }
  return report
}

fs.mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ args: gpuArgs({ accelerated: ACCELERATED }) })
const result = { host: HOST, pose: POSE, minVeg: MIN_VEG, accelerated: ACCELERATED, out: OUT, arms: {} }
try {
  result.arms.tsl = await runArm(browser, { legacy: false, tag: 'tsl' })
  result.arms.legacy = await runArm(browser, { legacy: true, tag: 'legacy' })
} finally {
  await browser.close().catch(() => {})
}

const tsl = result.arms.tsl, leg = result.arms.legacy
const refImg = leg && leg.frames && leg.frames['grey-a']
if (!refImg) {
  console.log('NO LEGACY REFERENCE FRAME -- cannot build region masks')
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, (k, v) => (k === 'frames' ? Object.keys(v) : v), 1))
  process.exit(1)
}
const { masks, horizon } = regionMasks(refImg)
const REGIONS = ['terrain', 'grass', 'water', 'leftLower', 'leftEdge', 'vegColumn', 'sky']

const floorOf = (arm, k) => {
  const a = arm.frames['grey-a'], b = arm.frames['grey-b']
  if (!a || !b) return FLOOR_MIN
  return Math.max(regionMeanAbs(a, b, masks[k]) || 0, FLOOR_MIN)
}

const rows = []
for (const [label] of STEPS) {
  const t = tsl.frames[label], l = leg.frames[label]
  if (!t || !l) continue
  for (const k of REGIONS) {
    const idx = masks[k]
    if (!idx || idx.length < 200) continue
    const tm = regionMean(t, idx), lm = regionMean(l, idx)
    const mad = regionMeanAbs(t, l, idx)
    const floor = Math.max(floorOf(tsl, k), floorOf(leg, k), FLOOR_MIN)
    rows.push({
      label, region: k, n: idx.length,
      delta: tm.map((v, c) => +(v - lm[c]).toFixed(2)),
      meanAbs: mad, floor: +floor.toFixed(3), ratio: +(mad / floor).toFixed(3),
      pass: mad <= K * floor,
    })
  }
}

const normals = {}
for (const label of ['nrm', 'nrmFlat']) {
  const t = tsl.frames[label], l = leg.frames[label]
  if (!t || !l) continue
  normals[label] = {}
  for (const k of REGIONS) {
    const idx = masks[k]
    if (!idx || idx.length < 200) continue
    const tm = regionMean(t, idx), lm = regionMean(l, idx)
    normals[label][k] = {
      n: idx.length,
      tslVec: tm.map(v => +((v / 255) * 2 - 1).toFixed(4)),
      legacyVec: lm.map(v => +((v / 255) * 2 - 1).toFixed(4)),
      diffVec: tm.map((v, c) => +(((v - lm[c]) / 255) * 2).toFixed(4)),
      meanAbs: regionMeanAbs(t, l, idx),
    }
  }
}

const texDn = {}
for (const label of ['texDnDir', 'texDnMag']) {
  const t = tsl.frames[label], l = leg.frames[label]
  if (!t || !l) continue
  const decode = v => (label === 'texDnMag' ? v / 255 / 8 : (v / 255 - 0.5) / 4)
  texDn[label] = {}
  for (const k of REGIONS) {
    const idx = masks[k]
    if (!idx || idx.length < 200) continue
    const tm = regionMean(t, idx), lm = regionMean(l, idx)
    texDn[label][k] = {
      n: idx.length,
      tsl: tm.map(v => +decode(v).toFixed(5)),
      legacy: lm.map(v => +decode(v).toFixed(5)),
      meanAbs: regionMeanAbs(t, l, idx),
    }
  }
}
result.texDn = texDn

result.criterion = { K, floorMin: FLOOR_MIN }
result.horizon = horizon
result.rows = rows
result.normals = normals
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, (k, v) => (k === 'frames' ? Object.keys(v) : v), 1))

const lines = []
lines.push(`rasterizer: tsl=${tsl.rasterizer} legacy=${leg.rasterizer}  accelerated=${ACCELERATED}`)
lines.push(`renderer:   ${tsl.renderer}`)
lines.push(`head:       ${result.head || 'n/a'}  host=${HOST} pose=${POSE}`)
lines.push(`settle:     tsl=${JSON.stringify(tsl.settle && { settle: tsl.settle.settle, veg: tsl.settle.veg, cls: tsl.settle.cls, backend: tsl.settle.backend, hv: tsl.settle.hv })}`)
lines.push(`settle:     legacy=${JSON.stringify(leg.settle && { settle: leg.settle.settle, veg: leg.settle.veg, cls: leg.settle.cls, backend: leg.settle.backend, hv: leg.settle.hv })}`)
lines.push('')
lines.push(`floors (grey a-vs-b repeatability, K=${K}, floorMin=${FLOOR_MIN}):`)
for (const k of REGIONS) lines.push(`  ${k.padEnd(11)} tslFloor=${floorOf(tsl, k).toFixed(3)} legacyFloor=${floorOf(leg, k).toFixed(3)} n=${masks[k].length}`)
lines.push('')
for (const [label] of STEPS) {
  const rs = rows.filter(r => r.label === label)
  if (!rs.length) continue
  for (const r of rs) {
    lines.push(`${label.padEnd(20)} ${r.region.padEnd(11)} delta=[${r.delta.join(',')}] meanAbs=${String(r.meanAbs).padEnd(7)} ratio=${String(r.ratio).padEnd(7)} ${r.pass ? 'PASS' : 'FAIL'}`)
  }
}
lines.push('')
lines.push('numeric normal comparison (fsCheap=1, world-space n decoded as pixel*2-1):')
for (const label of Object.keys(normals)) {
  for (const [k, v] of Object.entries(normals[label])) {
    lines.push(`  ${label.padEnd(8)} ${k.padEnd(11)} tsl=[${v.tslVec.join(', ')}] legacy=[${v.legacyVec.join(', ')}] diff=[${v.diffVec.join(', ')}] meanAbs=${v.meanAbs}`)
  }
}
lines.push('')
lines.push('numeric texDn comparison (fsCheap=2 -> texDn vector; fsCheap=3 -> length(texDn)):')
for (const label of Object.keys(texDn)) {
  for (const [k, v] of Object.entries(texDn[label])) {
    lines.push(`  ${label.padEnd(8)} ${k.padEnd(11)} tsl=[${v.tsl.join(', ')}] legacy=[${v.legacy.join(', ')}] meanAbs=${v.meanAbs}`)
  }
}
lines.push('')
lines.push('surface texture readiness:')
for (const arm of ['tsl', 'legacy']) {
  const s = result.arms[arm] && result.arms[arm].settle
  lines.push(`  ${arm.padEnd(7)} surfReady=${s ? s.surfReady : 'n/a'} surfErr=${s ? s.surfErr : 'n/a'}`)
}
const text = lines.join('\n')
console.log(text)
fs.writeFileSync(path.join(OUT, 'regions.txt'), text + '\n')
