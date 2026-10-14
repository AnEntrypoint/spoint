#!/usr/bin/env node
// Sky parity for the atmosphere LUT change: WebGPU/TSL arm vs legacy-GL arm, same pose, same LUT bytes.
//
// GPU witness: it launches a real accelerated headful Chrome through the project's shared browser
// lease (scripts/lib/cdp-browser.mjs) and boots a real WebGPURenderer page. It therefore CANNOT live
// in the gpu-free arm of scripts/check.mjs and is NOT wired into it: it runs only when
// SPOINT_GPU_WITNESS=1, which no CI job sets. Reported verdicts from this witness are local runs.
//
// usage: SPOINT_GPU_WITNESS=1 node scripts/gpulock.mjs run <owner> -- \
//          node scripts/atmosphere-lut-sky-parity-witness.mjs --host=http://localhost:3001 \
//          --out=.gm/pool/atm-lut-parity-r270-63 [--gpu=amd] [--pose=-2750,-750] [--min-veg=225]

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

if (process.env.SPOINT_GPU_WITNESS !== '1') {
  console.log('atmosphere-lut-sky-parity-witness SKIPPED: SPOINT_GPU_WITNESS!=1 (GPU witness; never in the gpu-free arm of scripts/check.mjs)')
  process.exit(0)
}

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')] }))
const host = args.host || 'http://localhost:3001'
const gpu = args.gpu || 'amd'
const pose = args.pose || '-2750,-750'
const minVeg = Number(args['min-veg'] || 225)
const arms = String(args.arms || 'both').split(',').map(s => s.trim()).filter(Boolean)
const out = resolve(ROOT, args.out || '.gm/pool/atm-lut-parity')
const stamp = Date.now()
const head = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()

const B = await import(pathToFileURL(resolve(HERE, 'tsl-parity', 'bodies.mjs')).href)
const { vendorGpuArgs } = await import(pathToFileURL(resolve(HERE, 'lib', 'gpu-probe.mjs')).href)
const { chromium } = await import(pathToFileURL(resolve(HERE, 'lib', 'cdp-browser.mjs')).href)

const launchArgs = vendorGpuArgs(gpu)
console.log('atmosphere-lut-sky-parity-witness gpu=' + gpu + ' adapterArgs=' + JSON.stringify(launchArgs.filter(a => a.includes('luid'))) + ' host=' + host + ' out=' + out)

fs.mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ root: ROOT, owner: 'atm-lut-sky-parity', args: launchArgs, leaseWaitMs: Number(args.leaseWaitMs || 900000), leaseTtlMs: 20 * 60 * 1000 })

const url = legacy => `${host}/?singleplayer&terrainhash=1${legacy ? '&legacygl=1' : ''}&at=${pose}&v=${legacy ? 'l' : 't'}${stamp}`

async function evalRaw(page, expression, timeout) {
  const r = await page._send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: timeout || 60000 })
  if (r && r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text || 'evaluate failed').slice(0, 400))
  return r && r.result ? r.result.value : null
}

async function runArm(name, legacy) {
  const page = await browser.newPage()
  const events = []
  page.on('Debugger.scriptParsed', p => { if (events.length < 600) events.push({ event: 'Debugger.scriptParsed', params: { url: p.url, hash: p.hash } }) })
  page.on('Runtime.exceptionThrown', p => { if (events.length < 600) events.push({ event: 'Runtime.exceptionThrown', params: p }) })
  await page._send('Debugger.enable', {}).catch(() => {})
  await page._send('Runtime.enable', {}).catch(() => {})
  await page._send('Input.setIgnoreInputEvents', { ignore: true }).catch(() => {})
  await page._send('Emulation.setDeviceMetricsOverride', JSON.parse(B.DEVICE_METRICS)).catch(() => {})
  await page._send('Network.enable', {}).catch(() => {})
  await page._send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {})
  await page._send('Network.clearBrowserCache', {}).catch(() => {})
  await page._send('Page.addScriptToEvaluateOnNewDocument', { source: B.inputBlockerHook('', head) })

  const bootResults = []
  const push = (arr, value) => arr.push({ result: { value: JSON.stringify(value) } })
  await page._send('Page.navigate', { url: url(legacy) })
  await new Promise(r => setTimeout(r, 1500))
  try { push(bootResults, JSON.parse(await evalRaw(page, B.postNavExpression()))) } catch (e) { bootResults.push({ error: 'postNav: ' + e.message }) }

  let settled = null
  for (let attempt = 0; attempt < 3 && !(settled && settled.settle); attempt++) {
    try { settled = JSON.parse(await evalRaw(page, B.settleExpression(minVeg), 130000)) } catch (e) { settled = { settle: false, reason: e.message } }
    push(bootResults, settled)
  }
  const renderer = settled && settled.gpu ? String(settled.gpu) : null
  const backend = settled && settled.backend ? String(settled.backend) : null
  console.log(name + ' settle=' + !!(settled && settled.settle) + ' veg=' + (settled && settled.veg) + ' backend=' + backend + ' gpu=' + renderer + ' canvas=' + JSON.stringify(settled && settled.canvas))
  if (!settled || !settled.settle) throw new Error(name + ': world never settled -- ' + JSON.stringify(settled && settled.reason || settled))
  if (!renderer) throw new Error(name + ': no window.__rendererInfo.glRenderer -- the adapter pin is not asserted, so this arm proves nothing')

  fs.writeFileSync(path.join(out, name + '-boot.json'), JSON.stringify({ ok: true, data: { results: bootResults, events } }))

  const cap = []
  try { push(cap, JSON.parse(await evalRaw(page, B.inputCountExpression('captureStart')))) } catch (e) { cap.push({ error: 'captureStart: ' + e.message }) }
  const frames = [
    ['skyPose', "window.__app.cam.restore({yaw:1.0,pitch:0.35,zoomIndex:2})", 2500, [['sky-a', B.SKY_CLIP], ['sky-b', B.SKY_CLIP], ['skyFull-a', B.FULL], ['skyFull-b', B.FULL]]],
    ['groundPose', "window.__app.cam.restore({yaw:1.0,pitch:0,zoomIndex:2})", 3000, [['ground-a', B.FULL], ['ground-b', B.FULL]]],
    ['greyStep', "window.__albedoOverride=[0.8,0.8,0.8,1]", 2000, [['grey-a', B.FULL], ['grey-b', B.FULL]]],
    ['relief1Step', "window.__reliefShade=1", 2000, [['greyRelief1-a', B.FULL], ['greyRelief1-b', B.FULL]]],
  ]
  for (const [step, assign, waitMs, shots] of frames) {
    try { push(cap, JSON.parse(await evalRaw(page, B.stepExpression(assign, waitMs, step), 60000))) } catch (e) { cap.push({ error: step + ': ' + e.message }) }
    for (const [label, clip] of shots) {
      try {
        const sig = JSON.parse(await evalRaw(page, B.signature(label)))
        cap.push({ result: { value: JSON.stringify(sig) } })
        const shot = await page._send('Page.captureScreenshot', { format: 'png', clip })
        cap.push({ data: shot.data })
      } catch (e) { cap.push({ error: label + ': ' + e.message }) }
    }
  }
  try { await evalRaw(page, B.stepExpression("delete window.__reliefShade;window.__albedoOverride=[0,0,0,0]", 1000, 'restored'), 30000) } catch (e) {}
  fs.writeFileSync(path.join(out, name + '-capture.json'), JSON.stringify({ ok: true, data: { results: cap, events: [] } }))
  await page.close()
  return { renderer, backend }
}

// --swap captures both arms of a source change inside ONE browser lease: it shoots the shipped
// source, writes the frozen pre-change node body over it, shoots again, and restores. The box runs
// several lanes and the browser lease is the scarce resource, so the before/after pair has to come
// from one lease or it never gets a second one.
const SKY_REL = 'packages/mapspinner/src/tsl/sky-tsl.js'
const SKY_ABS = resolve(ROOT, SKY_REL)
const block = lines => lines.join('\n')
const SINGLE_BLOCK = block([
  '    const wSky = smoothstep(muTangent.sub(ATM_HORIZON_BLEND_MU), muTangent.add(ATM_HORIZON_BLEND_MU), mu)',
  '    const dEnd = mix(max(distToGround(r, mu), 1e-3), distToTop(r, mu), wSky)',
  '    const marched = marchSteps(camera, ray, sun, dEnd)',
  '    const skyVisible = distToTop(r, mu).greaterThan(0.0).and(rIn.lessThanEqual(ATM_TOP).or(dtIn.greaterThanEqual(0.0)))',
  '    const radianceBase = select(skyVisible, marched.radiance, vec3(0.0))',
  '    const trans = select(skyVisible, mix(vec3(0.0), marched.trans, wSky), vec3(1.0))',
])
const TWO_MARCH_BLOCK = block([
  '    const wSky = smoothstep(muTangent.sub(ATM_HORIZON_BLEND_MU), muTangent.add(ATM_HORIZON_BLEND_MU), mu)',
  '    const sky = marchSteps(camera, ray, sun, distToTop(r, mu))',
  '    const ground = marchSteps(camera, ray, sun, max(distToGround(r, mu), 1e-3))',
  '    const skyVisible = distToTop(r, mu).greaterThan(0.0).and(rIn.lessThanEqual(ATM_TOP).or(dtIn.greaterThanEqual(0.0)))',
  '    const radianceBase = select(skyVisible, mix(ground.radiance, sky.radiance, wSky), vec3(0.0))',
  '    const trans = select(skyVisible, mix(vec3(0.0), sky.trans, wSky), vec3(1.0))',
])

let swapped = false
let verdict = 'FAIL'
try {
  if (args.swap) {
    const shipped = fs.readFileSync(SKY_ABS, 'utf8')
    const norm = shipped.replace(/\r\n/g, '\n')
    if (!norm.includes(SINGLE_BLOCK)) throw new Error('sky-tsl.js does not hold the single-march node body -- refusing to swap')
    await runArm('after', false)
    fs.writeFileSync(SKY_ABS, norm.replace(SINGLE_BLOCK, TWO_MARCH_BLOCK))
    try { await runArm('before', false); swapped = true } finally { fs.writeFileSync(SKY_ABS, shipped) }
  } else {
    if (arms.includes('tsl')) await runArm('tsl', false)
    if (arms.includes('legacy')) await runArm('legacy', true)
  }
  verdict = 'CAPTURED'
} catch (e) {
  console.log('atmosphere-lut-sky-parity-witness CAPTURE FAILED: ' + e.message)
  await browser.close().catch(() => {})
  console.log('RESULT: FAIL')
  process.exit(1)
}
await browser.close().catch(() => {})

const { decodePng, regionMeanAbs, regionMean } = await import(pathToFileURL(resolve(HERE, 'tsl-parity', 'png.mjs')).href)

const QUANT_FLOOR = 1.0
const K = 3
const BAND_ROWS = 8

function shots(dir, arm) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, arm + '-capture.json'), 'utf8'))
  const map = new Map()
  let label = null
  for (const entry of j.data.results) {
    if (entry && entry.result && typeof entry.result.value === 'string') {
      try { const sig = JSON.parse(entry.result.value); if (sig && typeof sig.frame === 'string') label = sig.frame } catch (e) { label = null }
    } else if (entry && typeof entry.data === 'string' && label) { map.set(label, entry.data); label = null }
  }
  return map
}

// The frame's w/h come from decodePng and the horizon row from the captured pixels: regionMasks
// answers {horizon, masks, pixels} and carries no .w/.h, so a split that read them off the mask
// built EMPTY index lists, and regionMeanAbs on an empty list returns null, which compares as PASS.
// That silent pass is the failure this block exists to prevent, so: every region is asserted
// non-empty, the three regions are asserted to partition the frame, and the horizon search skips
// the top 5% so a dark HUD strip cannot zero it.
function horizonRow(img) {
  const { w, h, rgb } = img
  const x1 = Math.max(1, Math.floor(0.25 * w))
  for (let y = Math.floor(0.05 * h); y < h; y++) {
    let skyish = 0
    for (let x = 0; x < x1; x++) { const i = (y * w + x) * 3; if (rgb[i + 2] > rgb[i] + 40 && rgb[i + 2] > 150) skyish++ }
    if (skyish < 0.5 * x1) return y
  }
  return h
}

function bandSplit(A, A2, B, B2) {
  if (A.w !== B.w || A.h !== B.h) throw new Error('sky-band: frame size differs ' + [A.w, A.h, B.w, B.h])
  const w = A.w, h = A.h
  const horizon = horizonRow(B)
  const band = new Set()
  for (let dy = -BAND_ROWS; dy <= BAND_ROWS; dy++) { const y = horizon + dy; if (y >= 0 && y < h) band.add(y) }
  const idx = { all: [], horizonBand: [], skyAway: [], belowHorizon: [] }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x
    idx.all.push(i)
    if (band.has(y)) idx.horizonBand.push(i)
    else if (y < horizon) idx.skyAway.push(i)
    else idx.belowHorizon.push(i)
  }
  if (idx.horizonBand.length + idx.skyAway.length + idx.belowHorizon.length !== w * h) throw new Error('sky-band: regions do not partition the frame')
  const out = { frame: w + 'x' + h, horizonRow: horizon, bandRows: band.size }
  for (const k of Object.keys(idx)) {
    if (idx[k].length === 0) throw new Error('sky-band: region ' + k + ' is empty -- the band split is vacuous')
    out[k] = {
      delta: regionMeanAbs(A, B, idx[k]),
      floor: Math.max(regionMeanAbs(A, A2, idx[k]), regionMeanAbs(B, B2, idx[k])),
      n: idx[k].length,
      meanA: regionMean(A, idx[k]),
      meanB: regionMean(B, idx[k]),
    }
  }
  return out
}

// Gated: skyAway (every sky row outside the blend band -- the change must leave those exactly as
// they were) and horizonBand (the window around the horizon -- the only rows it may move).
// Printed but NOT gated: belowHorizon, which at this pose carries the third-person character and
// wind-driven vegetation; a same-code pair of boots moves it more than this change does, so gating
// on it would be undecidable rather than strict. `all` is printed for the record and never gated:
// a whole-frame average hides a horizon artifact inside the terrain and the character.
const GATED = ['skyAway', 'horizonBand']

function reportBand(tag, A, A2, B, B2) {
  const r = bandSplit(A, A2, B, B2)
  const bar = +(K * Math.max(QUANT_FLOOR, ...GATED.map(k => r[k].floor))).toFixed(3)
  const rows = []
  let worst = 0
  for (const k of ['all', 'skyAway', 'horizonBand', 'belowHorizon']) {
    const v = r[k]
    if (GATED.includes(k)) worst = Math.max(worst, v.delta)
    rows.push(k + ' meanAbs=' + v.delta + ' floor=' + v.floor + ' n=' + v.n + ' meanB=' + JSON.stringify(v.meanB) + ' meanA=' + JSON.stringify(v.meanA) + (GATED.includes(k) ? (v.delta <= bar ? ' PASS' : ' FAIL') : ' (reported)'))
  }
  console.log('[sky-band] ' + tag + ' frame=' + r.frame + ' horizonRow=' + r.horizonRow + ' band=±' + BAND_ROWS + ' (' + r.bandRows + ' rows) bar=' + bar + ' (K=' + K + ' x gated floor, QUANT_FLOOR=' + QUANT_FLOOR + ') ' + rows.join(' | '))
  return { worst, bar, detail: r }
}

// A 0.000 delta is only a measurement if the browser actually ran different sky bytes: the parsed
// script hash of sky-tsl.js has to differ between the two arms, or "nothing moved" is just a swap
// that never reached the page.
function skyScriptHash(arm) {
  const j = JSON.parse(fs.readFileSync(path.join(out, arm + '-boot.json'), 'utf8'))
  for (const e of j.data.events || []) {
    if (e.event === 'Debugger.scriptParsed' && /sky-tsl/.test(String(e.params && e.params.url || ''))) return String(e.params.hash)
  }
  return null
}

const comparePairs = []
if (swapped) {
  const hAfter = skyScriptHash('after'), hBefore = skyScriptHash('before')
  const control = hAfter && hBefore && hAfter !== hBefore
  console.log('[sky-band] swap control: sky-tsl.js parsed script hash after=' + hAfter + ' before=' + hBefore + ' ' + (control ? 'DIFFERS (the two arms ran different sky bytes)' : 'IDENTICAL OR MISSING -- the delta below is vacuous'))
  if (!control) { console.log('RESULT: REFUSED capture=' + verdict + ' swap control failed'); process.exit(3) }
  comparePairs.push([shots(out, 'after'), shots(out, 'before'), 'in-session swap (before = two marches)'])
} else if (args.compare) comparePairs.push([shots(out, 'tsl'), shots(resolve(ROOT, args.compare), 'tsl'), args.compare])

let refused = comparePairs.length === 0
for (const [A, B, tag] of comparePairs) {
  const dec = m => Object.fromEntries([...m.keys()].map(k => [k, decodePng(m.get(k))]))
  const dA = dec(A), dB = dec(B)

  // NON-VACUITY CONTROLS. A band split whose index lists came out empty reads 0.000 and PASSES,
  // so before any verdict the instrument has to prove it can see a horizon that moved.
  //  1. partition/non-empty is asserted inside bandSplit;
  //  2. the two poses of one arm have DIFFERENT horizon rows and the split must see a nonzero band;
  //  3. a synthetic +6 confined to the band must raise horizonBand and leave skyAway bit-identical.
  if (dA['skyFull-a'] && dB['ground-a']) {
    const hFull = horizonRow(dB['skyFull-a']), hGround = horizonRow(dB['ground-a'])
    const seen = hFull !== hGround && reportBand('CONTROL horizon-differing pair (skyPose vs groundPose, one arm)', dA['skyFull-a'], dA['skyFull-b'], dB['ground-a'], dB['ground-b']).worst > 0
    const base = reportBand('CONTROL baseline before injection (skyPose)', dA['skyFull-a'], dA['skyFull-b'], dB['skyFull-a'], dB['skyFull-b'])
    const nudge = { w: dB['skyFull-a'].w, h: dB['skyFull-a'].h, rgb: Uint8Array.from(dB['skyFull-a'].rgb) }
    for (let y = Math.max(0, hFull - BAND_ROWS); y <= Math.min(nudge.h - 1, hFull + BAND_ROWS); y++)
      for (let x = 0; x < nudge.w; x++) { const i = (y * nudge.w + x) * 3; for (let c = 0; c < 3; c++) nudge.rgb[i + c] = Math.min(255, nudge.rgb[i + c] + 6) }
    const inj = reportBand('CONTROL injected +6 on the horizon band only', dA['skyFull-a'], dA['skyFull-b'], nudge, dB['skyFull-b'])
    const inject = inj.detail.horizonBand.delta > base.detail.horizonBand.delta + 2.0 && inj.detail.skyAway.delta === base.detail.skyAway.delta
    console.log('[sky-band] non-vacuity controls: poseHorizon ' + hFull + ' vs ' + hGround + ' ' + (seen ? 'SEEN' : 'NOT SEEN') +
      '; injected band ' + base.detail.horizonBand.delta + ' -> ' + inj.detail.horizonBand.delta + ' with skyAway ' + base.detail.skyAway.delta + ' -> ' + inj.detail.skyAway.delta + ' ' + (inject ? 'SEEN' : 'NOT SEEN'))
    if (!seen || !inject) { console.log('RESULT: REFUSED capture=' + verdict + ' band-split non-vacuity controls failed'); process.exit(3) }
  }

  if (dA['skyFull-a'] && dB['skyFull-a']) {
    const v = reportBand('skyFull vs ' + tag, dA['skyFull-a'], dA['skyFull-b'], dB['skyFull-a'], dB['skyFull-b'])
    if (v.worst > v.bar) refused = true
  } else { console.log('[sky-band] skyFull MISSING in ' + out + ' / ' + tag); refused = true }

  // The pure-sky clip holds no horizon at all, so it is measured whole: its every pixel is a wSky=1
  // pixel, which the change must leave bit-identical.
  if (dA['sky-a'] && dB['sky-a']) {
    const all = [...Array(dA['sky-a'].w * dA['sky-a'].h).keys()]
    const delta = regionMeanAbs(dA['sky-a'], dB['sky-a'], all)
    const floor = Math.max(regionMeanAbs(dA['sky-a'], dA['sky-b'], all), regionMeanAbs(dB['sky-a'], dB['sky-b'], all))
    const bar = +(K * Math.max(QUANT_FLOOR, floor)).toFixed(3)
    console.log('[sky-band] skyClip vs ' + tag + ' frame=' + dA['sky-a'].w + 'x' + dA['sky-a'].h + ' (no horizon in clip) meanAbs=' + delta + ' floor=' + floor + ' bar=' + bar + (delta <= bar ? ' PASS' : ' FAIL'))
    if (delta > bar) refused = true
  } else { console.log('[sky-band] skyClip MISSING in ' + out + ' / ' + tag); refused = true }
}
if (comparePairs.length) {
  console.log('RESULT: ' + (refused ? 'REFUSED' : 'PASS') + ' capture=' + verdict + ' band-split arms=' + comparePairs.length)
  process.exit(refused ? 3 : 0)
}

if (arms.length !== 2) {
  console.log('atmosphere-lut-sky-parity-witness arms=' + arms.join(',') + ' -- cross-renderer analyze.mjs needs both arms, skipped')
  console.log('RESULT: PASS capture=' + verdict + ' analyze=skipped')
  process.exit(0)
}

console.log('--- scripts/tsl-parity/analyze.mjs (the project criterion: K=3 x same-renderer noise floor) ---')
let code = 1
try {
  const a = execFileSync(process.execPath, [resolve(HERE, 'tsl-parity', 'analyze.mjs'), '--gpu=' + gpu, '--dir=' + out], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  console.log(a.trim())
  code = 0
} catch (e) {
  console.log(String(e.stdout || '').trim())
  console.log(String(e.stderr || '').trim().slice(0, 800))
  code = e.status === undefined ? 1 : e.status
}
console.log('RESULT: ' + (code === 0 ? 'PASS' : 'FAIL') + ' capture=' + verdict + ' analyzeExit=' + code)
process.exit(code === 0 ? 0 : 1)
