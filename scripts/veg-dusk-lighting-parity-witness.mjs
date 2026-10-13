#!/usr/bin/env node
// Dusk light-discontinuity witness: measured brightness of terrain vs grass vs trees at a STATED
// dusk time-of-day, pose and adapter, plus the TSL-vs-legacy parity of the same measurement.
//
// The measurement is albedo-invariant: each surface's mean display luma is read over a pixel mask
// derived by differencing arms (terrain-only / terrain+grass / terrain+trees) at one pose, and the
// reported discontinuity is the DOUBLE RATIO (veg/terrain at dusk) / (veg/terrain at noon). A fixed
// albedo difference between grass and terrain cancels in that ratio, so what is left is lighting.
//
// The same-code floor is established FIRST: two captures of the SAME arm at the SAME pose give
// QUANT_FLOOR (meanAbs/channel); every cross-comparison is judged against K=3 x that floor.
//
// GPU witness: it needs a real accelerated browser, so it runs only with SPOINT_GPU_WITNESS=1 and
// is NOT in the gpu-free arm of scripts/check.mjs.
//
// usage: SPOINT_GPU_WITNESS=1 node scripts/gpulock.mjs run <owner> -- \
//   node scripts/veg-dusk-lighting-parity-witness.mjs --host=http://localhost:3001 \
//   --gpu=amd --out=.gm/pool/veg-dusk-1013 [--legacy] [--pose=-2750,-750]

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

if (process.env.SPOINT_GPU_WITNESS !== '1') {
  console.log('veg-dusk-lighting-parity-witness SKIPPED: SPOINT_GPU_WITNESS!=1 (GPU witness; never in the gpu-free arm of scripts/check.mjs)')
  process.exit(0)
}

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')] }))
const host = args.host || 'http://localhost:3001'
const gpu = args.gpu || 'amd'
const pose = args.pose || '-2750,-750'
const out = resolve(ROOT, args.out || '.gm/pool/veg-dusk-1013')
const withLegacy = args.legacy === '1' || args.legacy === 'true'
const minTreePx = Number(args['min-tree-px'] || 400)
const K = Number(args.k || 3)
const TOL = Number(args.tol || 0.12)
const FLOOR_MAX = Number(args['floor-max'] || 6)
const MASK_EPS = Number(args.eps || 6)

const DUSK_F = 0.745   // sun elevation 2.10 deg, clock 17:52
const NOON_F = 0.5     // sun elevation 67.00 deg, clock 12:00
const POSE = '{yaw:1.0,pitch:0.25,zoomIndex:2}'

const stamp = Date.now()
const head = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()

const B = await import(pathToFileURL(resolve(HERE, 'tsl-parity', 'bodies.mjs')).href)
const { decodePng } = await import(pathToFileURL(resolve(HERE, 'tsl-parity', 'png.mjs')).href)
const { vendorGpuArgs, SOFTWARE_MARKERS } = await import(pathToFileURL(resolve(HERE, 'lib', 'gpu-probe.mjs')).href)
const { chromium } = await import(pathToFileURL(resolve(HERE, 'lib', 'cdp-browser.mjs')).href)

const launchArgs = vendorGpuArgs(gpu)
console.log('veg-dusk-lighting-parity-witness gpu=' + gpu + ' adapterArgs=' + JSON.stringify(launchArgs.filter(a => a.includes('luid'))) +
  ' host=' + host + ' dusk=' + DUSK_F + ' noon=' + NOON_F + ' pose=' + POSE + ' at=' + pose + ' out=' + out)

fs.mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ root: ROOT, owner: 'veg-dusk-lighting', args: launchArgs, leaseWaitMs: 240000, leaseTtlMs: 30 * 60 * 1000 })

async function evalRaw(page, expression, timeout) {
  const r = await page._send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: timeout || 60000 })
  if (r && r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text || 'evaluate failed').slice(0, 400))
  return r && r.result ? r.result.value : null
}

const SHOTS = ['a', 'b']

async function runArm(name, qs, legacy) {
  const page = await browser.newPage()
  await page._send('Debugger.enable', {}).catch(() => {})
  await page._send('Runtime.enable', {}).catch(() => {})
  await page._send('Input.setIgnoreInputEvents', { ignore: true }).catch(() => {})
  await page._send('Emulation.setDeviceMetricsOverride', JSON.parse(B.DEVICE_METRICS)).catch(() => {})
  await page._send('Network.enable', {}).catch(() => {})
  await page._send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {})
  await page._send('Network.clearBrowserCache', {}).catch(() => {})
  await page._send('Page.addScriptToEvaluateOnNewDocument', { source: B.inputBlockerHook('', head) })

  const url = `${host}/?singleplayer&terrainhash=1${legacy ? '&legacygl=1' : ''}&at=${pose}&${qs}&v=${legacy ? 'l' : 't'}${stamp}`
  await page._send('Page.navigate', { url })
  await new Promise(r => setTimeout(r, 1500))

  const settleExpr = "(async()=>{const t0=performance.now();" +
    "while(performance.now()-t0<60000){if(window.__app&&window.__app.terrain&&window.__timeOfDayApi&&window.__app.cam&&window.__rendererInfo)break;await new Promise(r=>setTimeout(r,300))}" +
    "if(!(window.__app&&window.__app.terrain&&window.__timeOfDayApi&&window.__app.cam))return JSON.stringify({settle:false,reason:'world never booted',msgs:window.__witness&&window.__witness.msgs});" +
    "const T=window.__timeOfDayApi;T.setFractionFromServer=()=>{};T.setPaused(true);" +
    "window.__weatherType='clear';window.__weatherIntensity=0;window.__hazeMul=0.4;window.__threeVdrs=false;window.__vegWind=0;" +
    "window.__app.cam.restore(" + POSE + ");" +
    "let prev=-1;while(performance.now()-t0<115000){await new Promise(r=>setTimeout(r,5000));const v=window.__veg?window.__veg.totalInstances:-1;if(v===prev)break;prev=v}" +
    "return JSON.stringify({settle:true,vegInstances:window.__veg?window.__veg.totalInstances:null,hasGrass:!!(window.__app&&window.__app.grass)," +
    "cls:window.__rendererInfo.class,backend:window.__rendererInfo.backend,gpu:window.__rendererInfo.glRenderer,vendor:window.__rendererInfo.glVendor," +
    "hv:window.__app.terrain.frame?window.__app.terrain.frame.hashVersion:null})})()"

  let settled = null
  for (let attempt = 0; attempt < 3 && !(settled && settled.settle); attempt++) {
    try { settled = JSON.parse(await evalRaw(page, settleExpr, 130000)) } catch (e) { settled = { settle: false, reason: e.message } }
  }
  if (!settled || !settled.settle) throw new Error(name + ': world never settled -- ' + JSON.stringify(settled))
  if (!settled.gpu) throw new Error(name + ': no window.__rendererInfo.glRenderer -- the adapter pin is not asserted, so this arm proves nothing')
  if (SOFTWARE_MARKERS.test(String(settled.gpu) + ' ' + String(settled.vendor || ''))) throw new Error(name + ': rasterizer is software (' + settled.gpu + ') -- the adapter pin was not honoured')

  console.log(name + ' settle=true vegInstances=' + settled.vegInstances + ' backend=' + settled.backend + ' gpu=' + settled.gpu + ' hashVersion=' + settled.hv)

  const shots = {}
  for (const [label, frac] of [['dusk', DUSK_F], ['noon', NOON_F]]) {
    await evalRaw(page, "(async()=>{window.__timeOfDayApi.setFraction(" + frac + ");await new Promise(r=>setTimeout(r,3000))})()", 60000)
    for (const k of SHOTS) {
      const r = await page._send('Page.captureScreenshot', { format: 'png', clip: B.FULL })
      const png = decodePng(r.data)
      shots[label + k] = png
      fs.writeFileSync(path.join(out, name + '-' + label + k + '.png'), Buffer.from(r.data, 'base64'))
    }
  }
  const tod = JSON.parse(await evalRaw(page, "JSON.stringify({deg:window.__timeOfDay.elevationDeg,clock:window.__timeOfDay.clock,f:window.__timeOfDayApi.getFraction()})"))
  await page.close()
  return { info: settled, shots, tod }
}

const ARMS = [
  ['terrain', 'veg=none&nograss&norocks', false],
  ['grass', 'veg=none&norocks', false],
  ['trees', 'nograss&norocks', false],
]
if (withLegacy) {
  ARMS.push(['terrainL', 'veg=none&nograss&norocks', true])
  ARMS.push(['grassL', 'veg=none&norocks', true])
  ARMS.push(['treesL', 'nograss&norocks', true])
}

const served = await servedBytesGuard()
console.log('served-bytes ' + JSON.stringify(served))
expect('served-bytes-match-workspace', served.length === SERVED_GUARD.length && served.every(r => r.ok),
  'the dev server served ' + served.filter(r => r.ok).length + '/' + served.length + ' surface file(s) byte-identical to the workspace: ' + JSON.stringify(served))

const runs = {}
try {
  for (const [name, qs, legacy] of ARMS) runs[name] = await runArm(name, qs, legacy)
} catch (e) {
  console.log('veg-dusk-lighting-parity-witness CAPTURE FAILED: ' + e.message)
  await browser.close().catch(() => {})
  console.log('RESULT: FAIL')
  process.exit(1)
}
await browser.close().catch(() => {})

const LUMA = [0.2126, 0.7152, 0.0722]

function lumaOf(img, i) { return LUMA[0] * img.rgb[i * 3] + LUMA[1] * img.rgb[i * 3 + 1] + LUMA[2] * img.rgb[i * 3 + 2] }

function horizonOf(img) {
  for (let y = 0; y < img.h; y++) {
    let skyish = 0
    for (let x = 0; x < img.w; x++) { const i = y * img.w + x; if (img.rgb[i * 3 + 2] > img.rgb[i * 3] + 40 && img.rgb[i * 3 + 2] > 150) skyish++ }
    if (skyish < 0.5 * img.w) return y
  }
  return 0
}

// A pixel is grass/trees only when BOTH captures of the veg arm differ from BOTH captures of the
// terrain-only arm, so a one-frame wind sway cannot mint a mask pixel.
function diffMask(withX, base, horizon, w, h) {
  const mask = new Uint8Array(w * h)
  let n = 0
  for (let y = horizon; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x
    let d1 = 0, d2 = 0
    for (let c = 0; c < 3; c++) {
      d1 = Math.max(d1, Math.abs(withX.a.rgb[i * 3 + c] - base.a.rgb[i * 3 + c]))
      d2 = Math.max(d2, Math.abs(withX.b.rgb[i * 3 + c] - base.b.rgb[i * 3 + c]))
    }
    if (d1 > MASK_EPS && d2 > MASK_EPS) { mask[i] = 1; n++ }
  }
  return { mask, n }
}

function meanLuma(img, list) {
  if (!list.length) return null
  let s = 0
  for (const i of list) s += lumaOf(img, i)
  return +(s / list.length).toFixed(3)
}

function meanAbsChannel(a, b, list) {
  if (!list.length) return null
  let s = 0
  for (const i of list) for (let c = 0; c < 3; c++) s += Math.abs(a.rgb[i * 3 + c] - b.rgb[i * 3 + c])
  return +(s / (list.length * 3)).toFixed(3)
}

// A node_modules/@spoint/<pkg> that is a real directory instead of a junction into packages/ makes
// the dev server serve a stale published copy, so an A/B arm can compare the wrong terrain lighting
// against the right vegetation. Every arm is preceded by a byte-compare of what the server actually
// serves for the files this witness's verdict depends on.
const SERVED_GUARD = [
  ['packages/mapspinner/src/tsl/terrain-lighting-tsl.js', '/node_modules/mapspinner/src/tsl/terrain-lighting-tsl.js'],
  ['packages/mapspinner/src/tsl/planet-tsl.js', '/node_modules/mapspinner/src/tsl/planet-tsl.js'],
  ['client/core/VegetationTSL.js', '/core/VegetationTSL.js'],
]

async function servedBytesGuard() {
  const { createHash } = await import('node:crypto')
  const rows = []
  for (const [diskRel, urlPath] of SERVED_GUARD) {
    const disk = fs.readFileSync(resolve(ROOT, diskRel))
    let served = null
    try {
      const res = await fetch(host.replace(/\/$/, '') + urlPath)
      served = Buffer.from(await res.arrayBuffer())
    } catch (e) { rows.push({ diskRel, ok: false, reason: 'fetch failed: ' + e.message }); continue }
    const sha = b => createHash('sha256').update(b).digest('hex').slice(0, 16)
    rows.push({ diskRel, ok: served.equals(disk), diskBytes: disk.length, servedBytes: served.length, diskSha: sha(disk), servedSha: sha(served) })
  }
  return rows
}

const checks = []
function expect(name, ok, detail) {
  checks.push({ check: name, ok: !!ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + ': ' + detail)
  if (!ok) failures++
}
let failures = 0


console.log('--- analysis ---')
const report = { head, gpu, dusk: DUSK_F, noon: NOON_F, pose: POSE, at: pose, K, tol: TOL, arms: {} }

for (const [name, qs, legacy] of ARMS) {
  const r = runs[name]
  report.arms[name] = { qs, legacy, gpu: r.info.gpu, backend: r.info.backend, vegInstances: r.info.vegInstances, hasGrass: r.info.hasGrass, hashVersion: r.info.hv }
}
console.log('arms ' + JSON.stringify(report.arms))

expect('adapter-pinned', Object.values(runs).every(r => r.info.gpu && !SOFTWARE_MARKERS.test(String(r.info.gpu))),
  'every arm reports window.__rendererInfo.glRenderer and no software rasterizer: ' + JSON.stringify(Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, v.info.gpu]))))

const treeCount = runs.trees.info.vegInstances
expect('trees-actually-rendered', Number(treeCount) > 0, 'window.__veg.totalInstances=' + treeCount + ' in the trees arm (a zero means no tree is on screen and no tree number below is a measurement)')

// per-ToD surface luma
function surfacesAt(frac) {
  const key = frac === DUSK_F ? 'dusk' : 'noon'
  const pick = n => {
    const s = runs[n].shots
    if (!s[key + 'a'] || !s[key + 'b']) throw new Error('arm ' + n + ' captured no ' + key + ' shot, so no ' + key + ' number below is a measurement')
    return { a: s[key + 'a'], b: s[key + 'b'] }
  }
  const terrain = pick('terrain'), grass = pick('grass'), trees = pick('trees')
  const ref = terrain.a
  const horizon = horizonOf(ref)
  const w = ref.w, h = ref.h
  const gm = diffMask(grass, terrain, horizon, w, h)
  const tm = diffMask(trees, terrain, horizon, w, h)
  const grassIdx = [], treeIdx = [], terrIdx = []
  for (let y = horizon; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x
    if (tm.mask[i] && gm.mask[i]) continue
    if (tm.mask[i]) { treeIdx.push(i); continue }
    if (gm.mask[i]) { grassIdx.push(i); continue }
  }
  for (let y = horizon; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x
    if (tm.mask[i] || gm.mask[i]) continue
    let near = false
    for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -2; dx <= 2; dx++) {
      const yy = y + dy, xx = x + dx
      if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue
      if (tm.mask[yy * w + xx]) { near = true; break }
    }
    if (!near) terrIdx.push(i)
  }
  const union = [...terrIdx, ...grassIdx, ...treeIdx]
  return {
    horizon, w, h,
    counts: { terrain: terrIdx.length, grass: grassIdx.length, trees: treeIdx.length },
    floorUnion: meanAbsChannel(terrain.a, terrain.b, union),
    floorTerrain: meanAbsChannel(terrain.a, terrain.b, terrIdx),
    floorGrass: meanAbsChannel(grass.a, grass.b, grassIdx),
    floorTrees: meanAbsChannel(trees.a, trees.b, treeIdx),
    lumaTerrain: meanLuma(terrain.a, terrIdx),
    lumaGrass: meanLuma(grass.a, grassIdx),
    lumaTrees: meanLuma(trees.a, treeIdx),
  }
}

const dusk = surfacesAt(DUSK_F)
const noon = surfacesAt(NOON_F)
report.dusk = dusk
report.noon = noon
console.log('dusk ' + JSON.stringify({ counts: dusk.counts, lumaTerrain: dusk.lumaTerrain, lumaGrass: dusk.lumaGrass, lumaTrees: dusk.lumaTrees, floor: dusk.floorUnion }))
console.log('noon ' + JSON.stringify({ counts: noon.counts, lumaTerrain: noon.lumaTerrain, lumaGrass: noon.lumaGrass, lumaTrees: noon.lumaTrees, floor: noon.floorUnion }))

const floor = Math.max(dusk.floorUnion || 0, noon.floorUnion || 0)
expect('same-code-floor-established', floor > 0 && floor <= FLOOR_MAX,
  'QUANT_FLOOR (meanAbs/channel, two captures of one arm at one pose) = ' + dusk.floorUnion + ' dusk / ' + noon.floorUnion + ' noon, must be > 0 and <= ' + FLOOR_MAX)

expect('tree-pixels-measured', dusk.counts.trees >= minTreePx, 'tree mask pixels at dusk = ' + dusk.counts.trees + ' (min ' + minTreePx + ')')
expect('grass-pixels-measured', dusk.counts.grass >= minTreePx, 'grass mask pixels at dusk = ' + dusk.counts.grass + ' (min ' + minTreePx + ')')
expect('terrain-pixels-measured', dusk.counts.terrain >= minTreePx, 'terrain mask pixels at dusk = ' + dusk.counts.terrain + ' (min ' + minTreePx + ')')

const relDuskGrass = dusk.lumaGrass / dusk.lumaTerrain
const relNoonGrass = noon.lumaGrass / noon.lumaTerrain
const relDuskTrees = dusk.lumaTrees / dusk.lumaTerrain
const relNoonTrees = noon.lumaTrees / noon.lumaTerrain
const discGrass = relDuskGrass / relNoonGrass - 1
const discTrees = relDuskTrees / relNoonTrees - 1
report.discontinuity = { relDuskGrass, relNoonGrass, relDuskTrees, relNoonTrees, discGrass, discTrees }
console.log('double-ratio discontinuity grass=' + discGrass.toFixed(4) + ' trees=' + discTrees.toFixed(4) +
  ' (relDusk grass=' + relDuskGrass.toFixed(4) + ' trees=' + relDuskTrees.toFixed(4) +
  '; relNoon grass=' + relNoonGrass.toFixed(4) + ' trees=' + relNoonTrees.toFixed(4) + '; tol=' + TOL + ')')

expect('grass-dusk-discontinuity-removed', Math.abs(discGrass) <= TOL,
  'grass/terrain double ratio (dusk over noon) = ' + discGrass.toFixed(4) + ', |.| <= ' + TOL)
expect('tree-dusk-discontinuity-removed', Math.abs(discTrees) <= TOL,
  'trees/terrain double ratio (dusk over noon) = ' + discTrees.toFixed(4) + ', |.| <= ' + TOL)

if (withLegacy) {
  const duskL = (() => {
    const pick = n => ({ a: runs[n + 'L'].shots.duska, b: runs[n + 'L'].shots.duskb })
    const terrain = pick('terrain'), grass = pick('grass'), trees = pick('trees')
    const ref = terrain.a
    const horizon = horizonOf(ref)
    const w = ref.w, h = ref.h
    const gm = diffMask(grass, terrain, horizon, w, h)
    const tm = diffMask(trees, terrain, horizon, w, h)
    const idx = { terrain: [], grass: [], trees: [] }
    for (let y = horizon; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (tm.mask[i] && gm.mask[i]) continue
      if (tm.mask[i]) idx.trees.push(i)
      else if (gm.mask[i]) idx.grass.push(i)
      else idx.terrain.push(i)
    }
    return {
      floor: meanAbsChannel(terrain.a, terrain.b, [...idx.terrain, ...idx.grass, ...idx.trees]),
      lumaTerrain: meanLuma(terrain.a, idx.terrain),
      lumaGrass: meanLuma(grass.a, idx.grass),
      lumaTrees: meanLuma(trees.a, idx.trees),
    }
  })()
  report.legacyDusk = duskL
  console.log('legacy dusk ' + JSON.stringify(duskL))
  const budget = K * Math.max(floor, duskL.floor || 0)
  const d = {
    terrain: Math.abs(dusk.lumaTerrain - duskL.lumaTerrain),
    grass: Math.abs(dusk.lumaGrass - duskL.lumaGrass),
    trees: Math.abs(dusk.lumaTrees - duskL.lumaTrees),
  }
  report.legacyDelta = d
  expect('tsl-vs-legacy-parity', d.terrain <= budget && d.grass <= budget && d.trees <= budget,
    'TSL-vs-legacy |dLuma| terrain=' + d.terrain.toFixed(3) + ' grass=' + d.grass.toFixed(3) + ' trees=' + d.trees.toFixed(3) +
    ' vs ' + K + ' x floor = ' + budget.toFixed(3))
} else {
  console.log('legacy arm not run (pass --legacy=1 for the TSL-vs-legacy parity check)')
}

fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
console.log('report ' + path.join(out, 'report.json'))
console.log('RESULT: ' + (failures === 0 ? 'PASS' : 'FAIL') + ' checks=' + checks.length + ' failed=' + failures)
process.exit(failures === 0 ? 0 : 1)
