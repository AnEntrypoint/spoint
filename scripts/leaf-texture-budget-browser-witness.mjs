#!/usr/bin/env node
// Browser arm of the leaf-texture budget. Deliberately NOT registered in
// scripts/check.mjs: it reaches the browser and the GPU, so it rides behind
// scripts/gpulock.mjs and SPOINT_GPU_WITNESS, never the gpu-free arm.
//
//   node scripts/gpulock.mjs run leaftex-budget -- \
//     node scripts/leaf-texture-budget-browser-witness.mjs --gpu=nvidia [--out=<dir>]
//
// What it pins, per arm:
//   * COUNTED UNITS -- how many leaf/bark maps were budgeted, and the mip-chain
//     bytes resident before and after, read from the app's own counters and
//     cross-checked by walking the real scene's veg materials.
//   * CPU -- main-thread time inside the vegetation build's await-tex and
//     halve-tex spans. No per-pass GPU timing is cited anywhere in this witness.
//   * FIDELITY -- a screenshot from the same deterministic spawn per arm, diffed
//     in-browser per frame band. Bark is held at one budget across every arm, so
//     a difference between two arms is attributable to the leaf maps alone.
//
// Run under the GPU lock. The client must be served from the BUNDLE: ez-tree
// imports its maps as ESM (`import x from './assets/leaves/oak_color.png'`),
// which only the bundler turns into a URL, so raw-ESM mode has no vegetation.
//
// PARKED: the fidelity arm is UNRESOLVED, not passed. Three runs in the shared
// worktree could not make the frame static or comparable:
//   * two captures 500ms apart inside ONE frozen page (clock + rAF timestamp
//     pinned, ?tod=off) still differed by 1.8..4.5/255 mean |delta|;
//   * a second load of the SAME arm differed by 16.7/255 in the near band;
//   * 512-vs-1024 was 16.8/255 and 64-vs-1024 17.4/255 -- both at that floor.
// The leaf change is smaller than the harness noise, so it is unmeasured, not
// measured-good. Re-running here cannot fix it: the worktree is shared, so the
// bundle rebuild picks up other lanes' uncommitted client sources and no two
// runs describe the same tree.
//
// THE CLEAN RUN (parked spec). It isolates the tree first, so the rebuild
// cannot be contaminated and the arms are comparable:
//   git archive <remote-sha> | tar -x -C /tmp/leaftex-tree     # remote blobs only
//   mklink /J C:/tmp/leaftex-tree/node_modules C:/dev/spoint/node_modules
//   copy C:/dev/spoint/bin -> C:/tmp/leaftex-tree/bin          # bin/ too
//   cd C:/tmp/leaftex-tree && npm run build:client
//   SPOINT_GPU_WITNESS=1 node scripts/gpulock.mjs run leaftex -- \
//     node scripts/leaf-texture-budget-browser-witness.mjs --gpu=nvidia
// Arms wanted: leaf1024, leaf512, leaf64 and control leaf1024b (a second load
// of the same arm), bark held at 64 in every arm, ?tod=off, clock + rAF
// timestamp pinned, two captures per arm to prove the frame is static.
// Thresholds to hold: within-page delta <= 0/255; control near-band mean
// |delta| <= 1/255; 512-vs-1024 near-band mean |delta| <= 2/255 and
// fracGt8 <= 0.02; 64-vs-1024 strictly worse than 512-vs-1024 (non-vacuity).
// What it unblocks: whether halved (512) leaf maps are acceptable per band.
// Until it runs, the byte saving is measured and the visual verdict is OWED.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from './lib/cdp-browser.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'
import { witnessGpu } from './lib/gpu-probe.mjs'
import { assertServedClientRoot, clientRootTag, CLIENT_ROOT_BUNDLE } from './lib/served-client-root.mjs'
import { mipChainBytes } from '../client/core/TreeTextureBudget.js'

const LABEL = 'leaf-texture-budget-browser-witness'
const LF = String.fromCharCode(10)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const flag = (name, dflt = null) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const PORT = flag('port', '3192')
const WORLD = flag('world', 'tps-game')
const GPU_MODE = flag('gpu', 'nvidia')
const TIMEOUT_MS = Number(flag('timeout', '240000'))
const SETTLE_MS = Number(flag('settle', '4000'))
const [VIEW_W, VIEW_H] = String(flag('viewport', '1280x720')).split('x').map(Number)
const OUT = resolve(flag('out', join(REPO_ROOT, '.gm', 'witness-out', 'leaf-texture-budget')))
const SCRATCH = resolve(flag('scratch', join(tmpdir(), 'spoint-leaftex-budget')))

// Bark is held constant across every arm so a pixel difference is a leaf difference.
// The sun is frozen (?tod=off) and the animation clock is frozen in-page before
// every capture, so the frame is a function of the scene alone: vegetation sway is
// `uVegTime += dt`, which otherwise makes any two captures differ by more than the
// texture change being measured. leaf1024b is a SECOND load of the full-size arm and
// is the control -- without it a near-band delta has no floor to be judged against
// and every fidelity gate below is vacuous.
const BARK = 'barktex=64'
const FROZEN = 'tod=off'
const ARMS = [
  { name: 'leaf1024', query: `leaftex=1024&${BARK}&${FROZEN}`, leafPx: 1024, halvings: 0 },
  { name: 'leaf512', query: `leaftex=512&${BARK}&${FROZEN}`, leafPx: 512, halvings: 1 },
  { name: 'leaf64', query: `leaftex=64&${BARK}&${FROZEN}`, leafPx: 64, halvings: 4 },
  { name: 'leaf1024b', query: `leaftex=1024&${BARK}&${FROZEN}`, leafPx: 1024, halvings: 0, control: true },
]
const LEAF_MAPS = 4
const NEAR_BAND_MEAN_ABS_MAX = 2
const NEAR_BAND_FRAC_GT8_MAX = 0.02
const CONTROL_NEAR_MEAN_ABS_MAX = 1
const FREEZE_TOLERANCE = 0
const FREEZE_SETTLE_MS = 800
const FREEZE_HOLD_MS = 500
// A frozen clock that blacked the frame out would make every diff 0 and pass every
// fidelity gate, so the capture has to be shown to still carry an image.
const FRAME_MIN_STDDEV = 10

const checks = []
const unresolved = []
const OPS = {
  '==': (a, b) => Object.is(a, b),
  '<': (a, b) => typeof a === 'number' && Number.isFinite(a) && a < b,
  '<=': (a, b) => typeof a === 'number' && Number.isFinite(a) && a <= b,
  '>': (a, b) => typeof a === 'number' && Number.isFinite(a) && a > b,
  '>=': (a, b) => typeof a === 'number' && Number.isFinite(a) && a >= b,
}
function expect(label, got, op, want) {
  const pass = OPS[op](got, want) === true
  checks.push({ label, got, op, want, pass })
  return pass
}
const jsonLine = o => JSON.stringify(o)

// The sway is `uVegTime += dt`, so two captures of one scene differ by more than a
// halved leaf map until dt is 0. Only performance.now is pinned: the server tick
// keeps its own clock, so the sim keeps running while the animation stops.
const FREEZE_EXPR = `(() => {
  if (typeof performance === 'undefined' || typeof window === 'undefined') return { froze: false, why: 'no-window' }
  const t = performance.now()
  performance.now = () => t
  // The frame clock is the rAF TIMESTAMP, not performance.now: animate(ts) reads
  // now = ts || performance.now(), so pinning the clock alone leaves the scene
  // animating. Pin the timestamp the render loop is handed. The server tick keeps
  // Date.now, so the sim stays alive while the frame stops moving.
  const raf0 = window.requestAnimationFrame
  if (typeof raf0 !== 'function') return { froze: false, why: 'no-raf' }
  window.requestAnimationFrame = function (cb) { return raf0.call(window, function () { return cb(t) }) }
  let tod = null
  try {
    if (window.__timeOfDayApi && typeof window.__timeOfDayApi.setPaused === 'function') {
      window.__timeOfDayApi.setPaused(true)
      tod = window.__timeOfDayApi.isPaused ? !!window.__timeOfDayApi.isPaused() : true
    }
  } catch (_) { tod = false }
  return { froze: true, at: +t.toFixed(3), tod, raf: true }
})()`

const PLAYABLE_EXPR = 'window.__app && window.__app.revealedAt != null'
const BUDGET_EXPR = `(() => {
  const b = window.__vegTexBudget
  if (!b) return { present: false }
  const out = { present: true, budget: b.budget, stats: b.stats, refusals: b.refusals || [] }
  const r = window.__renderer || (window.__app && window.__app.renderer)
  if (r && r.info && r.info.memory) out.gpuTextures = r.info.memory.textures
  const seen = new Map()
  const veg = window.__veg
  if (veg && veg._meshes) {
    for (const m of veg._meshes) {
      for (const which of ['leaf', 'branch']) {
        const mesh = m[which]
        if (!mesh) continue
        const mats = mesh.material ? [mesh.material] : []
        const levels = mesh.LODinfo && mesh.LODinfo.objects
        if (levels) for (const l of levels) if (l && l.material) mats.push(l.material)
        for (const mat of mats) {
          if (!mat) continue
          for (const k of ['map','normalMap','roughnessMap','aoMap','alphaMap','bumpMap']) {
            const t = mat[k]
            const img = t && t.image
            if (!img) continue
            const key = (img.src || 'canvas') + '|' + which + '|' + k + '|' + img.width + 'x' + img.height
            const hit = seen.get(key)
            if (hit) hit.n++
            else seen.set(key, { w: img.width || 0, h: img.height || 0, slot: k, leaf: which === 'leaf', n: 1 })
          }
        }
      }
    }
  }
  out.sceneTextures = [...seen.values()]
  let halveMs = 0, halveN = 0, awaitMs = 0, awaitN = 0
  try {
    for (const e of performance.getEntriesByType('measure')) {
      if (/halve-tex$/.test(e.name)) { halveMs += e.duration; halveN++ }
      else if (/await-tex$/.test(e.name)) { awaitMs += e.duration; awaitN++ }
    }
  } catch (_) {}
  out.cpu = { halveMs: +halveMs.toFixed(3), halveN, awaitMs: +awaitMs.toFixed(3), awaitN }
  return out
})()`

function diffExpr(aB64, bB64) {
  return `(async () => {
    const load = (b64) => new Promise((res, rej) => {
      const im = new Image()
      im.onload = () => res(im)
      im.onerror = () => rej(new Error('diff: image failed to decode'))
      im.src = 'data:image/png;base64,' + b64
    })
    const A = await load(${JSON.stringify(aB64)})
    const B = await load(${JSON.stringify(bB64)})
    if (A.width !== B.width || A.height !== B.height) return { sameSize: false, aw: A.width, ah: A.height, bw: B.width, bh: B.height }
    const W = A.width, H = B.height
    const ca = document.createElement('canvas'); ca.width = W; ca.height = H
    const cb = document.createElement('canvas'); cb.width = W; cb.height = H
    const ga = ca.getContext('2d', { willReadFrequently: true }); ga.drawImage(A, 0, 0)
    const gb = cb.getContext('2d', { willReadFrequently: true }); gb.drawImage(B, 0, 0)
    const da = ga.getImageData(0, 0, W, H).data
    const db = gb.getImageData(0, 0, W, H).data
    // A frozen clock that blacked the frame out would make every delta 0, so the
    // first image's own contrast is reported and gated on.
    let sl = 0, sl2 = 0
    for (let i = 0; i < da.length; i += 4) {
      const l = 0.299 * da[i] + 0.587 * da[i + 1] + 0.114 * da[i + 2]
      sl += l; sl2 += l * l
    }
    const nA = da.length / 4
    const meanA = sl / nA
    const stdA = Math.sqrt(Math.max(0, sl2 / nA - meanA * meanA))
    const out = document.createElement('canvas'); out.width = W; out.height = H
    const go = out.getContext('2d', { willReadFrequently: true })
    const od = go.createImageData(W, H)
    // Frame bands, bottom-up: the closest geometry occupies the lower part of a
    // ground-level view and distant geometry compresses toward the horizon.
    const bands = { near: [0.60, 1.0], mid: [0.30, 0.60], far: [0.0, 0.30] }
    const acc = {}
    for (const k of Object.keys(bands)) acc[k] = { n: 0, sum: 0, gt2: 0, gt8: 0, gt16: 0, max: 0, hist: new Float64Array(256) }
    const all = { n: 0, sum: 0, gt2: 0, gt8: 0, gt16: 0, max: 0 }
    for (let y = 0; y < H; y++) {
      const t = y / H
      let band = 'far'
      if (t >= bands.near[0]) band = 'near'
      else if (t >= bands.mid[0]) band = 'mid'
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        let d = 0
        for (let c = 0; c < 3; c++) { const v = Math.abs(da[i + c] - db[i + c]); if (v > d) d = v }
        const a = acc[band]
        a.n++; a.sum += d; if (d > 2) a.gt2++; if (d > 8) a.gt8++; if (d > 16) a.gt16++; if (d > a.max) a.max = d
        a.hist[d]++
        all.n++; all.sum += d; if (d > 2) all.gt2++; if (d > 8) all.gt8++; if (d > 16) all.gt16++; if (d > all.max) all.max = d
        const m = Math.min(255, d * 8)
        od.data[i] = m; od.data[i + 1] = m; od.data[i + 2] = m; od.data[i + 3] = 255
      }
    }
    go.putImageData(od, 0, 0)
    const pct = (v, n) => { let seen = 0; for (let i = 0; i < 256; i++) { seen += v[i]; if (seen >= n * 0.99) return i } return 255 }
    const pack = (o) => ({ meanAbs: +(o.sum / Math.max(1, o.n)).toFixed(4), maxAbs: o.max, fracGt2: +(o.gt2 / Math.max(1, o.n)).toFixed(6), fracGt8: +(o.gt8 / Math.max(1, o.n)).toFixed(6), fracGt16: +(o.gt16 / Math.max(1, o.n)).toFixed(6) })
    const res = { sameSize: true, width: W, height: H, all: pack(all) }
    res.frame = { mean: +meanA.toFixed(3), std: +stdA.toFixed(3) }
    for (const k of Object.keys(acc)) res[k] = pack(acc[k])
    res.p99 = { near: pct(acc.near.hist, acc.near.n), mid: pct(acc.mid.hist, acc.mid.n), far: pct(acc.far.hist, acc.far.n) }
    res.diffPng = out.toDataURL('image/png').split(',')[1]
    return res
  })()`
}

async function runArm(browser, base, arm, scratchPage) {
  const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H } })
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e)))
  try {
    await page.goto(`${base}/?singleplayer&dprOff=true&${arm.query}`, { waitUntil: 'domcontentloaded' })
    const root = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: LABEL }).catch(e => e)
    if (root instanceof Error) throw root
    const gpu = await witnessGpu(page, GPU_MODE)
    const t0 = Date.now()
    let probe = null
    while (Date.now() - t0 < TIMEOUT_MS) {
      const st = await page.evaluate(`({ playable: !!(${PLAYABLE_EXPR}), budget: !!window.__vegTexBudget })`).catch(() => ({}))
      if (st.playable && st.budget) { probe = await page.evaluate(BUDGET_EXPR); break }
      await new Promise(r => setTimeout(r, 250))
    }
    if (!probe) throw new Error(`arm ${arm.name}: the page never became playable with a vegetation budget within ${TIMEOUT_MS}ms (pageErrors=${pageErrors.length}${pageErrors[0] ? ': ' + pageErrors[0].slice(0, 200) : ''})`)
    await page.waitForTimeout(SETTLE_MS)
    const frozen = await page.evaluate(FREEZE_EXPR)
    await page.waitForTimeout(FREEZE_SETTLE_MS)
    const pngPath = join(OUT, `${arm.name}.png`)
    const buf = await page.screenshot({ path: pngPath })
    await page.waitForTimeout(FREEZE_HOLD_MS)
    const pngBPath = join(OUT, `${arm.name}-b.png`)
    await page.screenshot({ path: pngBPath })
    return { arm, probe, gpu, root: clientRootTag(root), pngPath, pngBPath, frozen, bytes: buf.length, pageErrors }
  } finally {
    await page.close().catch(() => {})
  }
}

async function main() {
  if (!process.env.SPOINT_GPU_WITNESS) {
    console.error(`${LABEL}: refusing to run without SPOINT_GPU_WITNESS=1 -- this arm reaches the GPU and must ride behind scripts/gpulock.mjs`)
    process.exit(2)
  }
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  // The worktree is shared, so a lane editing any client source between the lock
  // being granted and this arm booting leaves dist/client/app.js stale and the
  // server silently falls through to raw ESM, which has no vegetation at all
  // (ez-tree imports its maps as ESM, so only the bundler turns them into URLs).
  // Building here, after gpulock has been granted, is the only point where the
  // bundle is guaranteed to describe the sources this arm is about to measure.
  if (process.argv.includes('--rebuild-bundle')) {
    console.log(`[${LABEL}] rebuilding dist/client so this arm measures the current sources`)
    execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'bundle-client.mjs')], { cwd: REPO_ROOT, stdio: 'inherit' })
  }
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'
  process.env.SPOINT_STATIC_CACHE_DIR = join(SCRATCH, 'static')
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot({ storageDir: join(SCRATCH, 'data') })
  const base = `http://127.0.0.1:${PORT}`
  let browser = null
  const results = []
  try {
    browser = await chromium.launch({ headless: false, args: vendorLaunchArgs(GPU_MODE) })
    const scratchPage = await browser.newPage({ viewport: { width: 64, height: 64 } })
    for (const arm of ARMS) results.push(await runArm(browser, base, arm, scratchPage))

    const shots = {}
    for (const r of results) shots[r.arm.name] = r.pngPath
    const a512 = results.find(r => r.arm.name === 'leaf512')
    const a1024 = results.find(r => r.arm.name === 'leaf1024')
    const a64 = results.find(r => r.arm.name === 'leaf64')

    const readB64 = p => readFileSync(p).toString('base64')
    const diffPaths = async (x, y) => {
      const res = await scratchPage.evaluate(diffExpr(readB64(x), readB64(y)))
      delete res.diffPng
      return res
    }
    const pair = async (x, y, tag) => {
      const res = await scratchPage.evaluate(diffExpr(readB64(shots[x]), readB64(shots[y])))
      const diffPng = res.diffPng
      delete res.diffPng
      if (diffPng) writeFileSync(join(OUT, `diff-${tag}.png`), Buffer.from(diffPng, 'base64'))
      writeFileSync(join(OUT, `diff-${tag}.json`), JSON.stringify(res, null, 2) + LF)
      return res
    }
    const diff512v1024 = await pair('leaf512', 'leaf1024', 'leaf512-vs-leaf1024')
    const diff64v1024 = await pair('leaf64', 'leaf1024', 'leaf64-vs-leaf1024')
    const diffControl = await pair('leaf1024', 'leaf1024b', 'control-leaf1024-vs-leaf1024b')

    // --- counted units -------------------------------------------------------
    for (const r of results) {
      const { arm, probe } = r
      const leaf = probe.stats && probe.stats.leaf
      const bark = probe.stats && probe.stats.bark
      const wantLeafResident = LEAF_MAPS * mipChainBytes(arm.leafPx, arm.leafPx)
      const wantLeafSource = LEAF_MAPS * mipChainBytes(1024, 1024)
      console.log(`[${LABEL}] ${arm.name} ${jsonLine({ budget: probe.budget, leaf, bark, cpu: probe.cpu, gpuTextures: probe.gpuTextures, sceneTex: probe.sceneTextures.length, refusals: (probe.refusals || []).length })}`)
      expect(`${arm.name}: the leaf budget resolved to ${arm.leafPx}px`, probe.budget && probe.budget.leafMaxPx, '==', arm.leafPx)
      expect(`${arm.name}: all ${LEAF_MAPS} leaf maps reached the halver`, leaf && leaf.seen, '==', LEAF_MAPS)
      expect(`${arm.name}: ${arm.halvings} halving step(s) were applied to each leaf map`, leaf && leaf.halved, '==', arm.halvings === 0 ? 0 : LEAF_MAPS)
      expect(`${arm.name}: leaf mip-chain bytes resident == ${wantLeafResident}`, leaf && leaf.residentBytes, '==', wantLeafResident)
      expect(`${arm.name}: leaf source mip-chain bytes == ${wantLeafSource}`, leaf && leaf.sourceBytes, '==', wantLeafSource)
      // The bark count is world-scoped: only the bark maps of the species this world
      // actually builds reach the halver, so the pinned claim is per-map, not per-file.
      const barkSeen = bark ? bark.seen : 0
      expect(`${arm.name}: at least one bark map reached the halver`, barkSeen, '>', 0)
      expect(`${arm.name}: every bark map that reached the halver is resident at 64px (${barkSeen} x ${mipChainBytes(64, 64)} B)`, bark && bark.residentBytes, '==', barkSeen * mipChainBytes(64, 64))
      expect(`${arm.name}: no bark map was skipped without being reported`, bark && bark.notDecoded, '==', 0)
      expect(`${arm.name}: no texture was left unbudgeted and unreported`, (probe.refusals || []).length, '==', 0)
      expect(`${arm.name}: the halver actually ran (a never-incremented counter is a silent pass)`, probe.cpu.halveN, '>', 0)
      expect(`${arm.name}: the scene walk found the leaf and bark maps on real veg materials`, probe.sceneTextures.length, '>', 0)
      const leafOnScene = probe.sceneTextures.filter(t => t.leaf)
      const leafObservations = leafOnScene.reduce((a, t) => a + (t.n || 0), 0)
      expect(`${arm.name}: the live scene carries at least ${LEAF_MAPS} leaf map slot(s)`, leafObservations, '>=', LEAF_MAPS)
      expect(`${arm.name}: every leaf map found in the live scene is ${arm.leafPx}px an edge`, leafOnScene.length > 0 && leafOnScene.every(t => t.w === arm.leafPx), '==', true)
      expect(`${arm.name}: no uncaught page errors`, r.pageErrors.length, '==', 0)
    }

    // --- a frozen frame, or the fidelity claim has no floor -------------------
    for (const r of results) {
      const d = await diffPaths(r.pngPath, r.pngBPath)
      r.freezeDiff = d
      console.log(`[${LABEL}] ${r.arm.name} frozen ${jsonLine({ clock: r.frozen, frame: d.frame, meanAbs: d.all && d.all.meanAbs, maxAbs: d.all && d.all.maxAbs })}`)
      expect(`${r.arm.name}: the animation clock was frozen before the capture`, r.frozen && r.frozen.froze, '==', true)
      expect(`${r.arm.name}: the frozen frame still carries an image (stddev > ${FRAME_MIN_STDDEV})`, d.frame && d.frame.std, '>', FRAME_MIN_STDDEV)
      expect(`${r.arm.name}: two captures ${FREEZE_HOLD_MS}ms apart inside one frozen page are pixel-identical`, d.sameSize === true ? d.all.meanAbs : -1, '<=', FREEZE_TOLERANCE)
    }
    const worstWithin = Math.max(...results.map(r => (r.freezeDiff && r.freezeDiff.all ? r.freezeDiff.all.meanAbs : Infinity)))
    const frameStatic = results.every(r => r.freezeDiff && r.freezeDiff.sameSize === true && r.freezeDiff.all.meanAbs <= FREEZE_TOLERANCE)

    // --- non-vacuity: the full-size arm must NOT meet the budget -------------
    const leaf1024 = a1024.probe.stats.leaf
    const leaf512 = a512.probe.stats.leaf
    expect('non-vacuity: with the halving disabled the leaf maps stay at the source size', leaf1024.residentBytes, '==', leaf1024.sourceBytes)
    expect('non-vacuity: the 512 arm frees real leaf bytes', leaf512.sourceBytes - leaf512.residentBytes, '>', 0)
    expect('non-vacuity: the 512 arm frees exactly 16777216 B of leaf mip chain', leaf512.sourceBytes - leaf512.residentBytes, '==', 16777216)

    console.log(`[${LABEL}] diff control ${jsonLine(diffControl)}`)
    // --- fidelity is a separate claim from the byte saving -------------------
    console.log(`[${LABEL}] diff 512-vs-1024 ${jsonLine(diff512v1024)}`)
    console.log(`[${LABEL}] diff 64-vs-1024 ${jsonLine(diff64v1024)}`)
    writeFileSync(join(OUT, 'arms.json'), JSON.stringify(results.map(r => ({
      arm: r.arm.name, query: r.arm.query, budget: r.probe.budget, stats: r.probe.stats,
      cpu: r.probe.cpu, gpuTextures: r.probe.gpuTextures, sceneTextures: r.probe.sceneTextures,
      refusals: r.probe.refusals, gpu: r.gpu.renderer || r.gpu.adapter || null, clientRoot: r.root,
      png: r.pngPath, pngB: r.pngBPath, frozen: r.frozen, frame: r.freezeDiff && r.freezeDiff.frame,
    })), null, 2) + LF)
    expect('fidelity: the 512 vs 1024 captures are the same frame size', diff512v1024.sameSize, '==', true)
    // Fidelity is only a claim this arm can make while the frame is static. When it
    // is not, the deltas are dominated by the scene and asserting a threshold would
    // report "512 is worse than 1024" when the truth is "this capture cannot tell
    // them apart" -- so the arm says so instead of printing a verdict it cannot pay
    // for.
    if (frameStatic) {
      expect(`fidelity: a second load of the SAME arm is pixel-stable in the near band (the floor every delta below is judged against) <= ${CONTROL_NEAR_MEAN_ABS_MAX}/255`, diffControl.near.meanAbs, '<=', CONTROL_NEAR_MEAN_ABS_MAX)
      expect(`fidelity: near-band mean |delta| between 512 and 1024 stays <= ${NEAR_BAND_MEAN_ABS_MAX}/255`, diff512v1024.near.meanAbs, '<=', NEAR_BAND_MEAN_ABS_MAX)
      expect(`fidelity: fewer than ${NEAR_BAND_FRAC_GT8_MAX * 100}% of near-band pixels differ by more than 8/255`, diff512v1024.near.fracGt8, '<=', NEAR_BAND_FRAC_GT8_MAX)
    } else {
      unresolved.push(`fidelity: no per-band claim is made -- the frame is not static, so every delta below sits at the noise floor. Two captures ${FREEZE_HOLD_MS}ms apart inside ONE frozen page still differ by up to ${worstWithin}/255 mean |delta|; a second load of the SAME arm differs by ${diffControl.near.meanAbs}/255 in the near band; 512-vs-1024 is ${diff512v1024.near.meanAbs}/255 and 64-vs-1024 is ${diff64v1024.near.meanAbs}/255. The texture effect is smaller than the floor, so it is unmeasured, not measured-good.`)
    }
    expect('fidelity: the 64 arm is measurably coarser than the 512 arm in the near band (so the gate is not vacuous)', diff64v1024.near.meanAbs, '>', diff512v1024.near.meanAbs)
  } catch (e) {
    console.error(`[${LABEL}] ${e && e.stack ? e.stack : e}`)
    if (browser) await browser.close().catch(() => {})
    server.stop()
    process.exit(1)
  }
  if (browser) await browser.close().catch(() => {})
  server.stop()
  const failed = checks.filter(c => !c.pass)
  for (const c of failed) console.log(`[${LABEL}] FAILED ${c.label}: got ${JSON.stringify(c.got)} ${c.op} ${JSON.stringify(c.want)}`)
  for (const u of unresolved) console.log(`[${LABEL}] UNRESOLVED ${u}`)
  console.log(`[${LABEL}] checks ${checks.length - failed.length}/${checks.length} passed, ${unresolved.length} unresolved`)
  console.log(`RESULT: ${failed.length === 0 && unresolved.length === 0 ? 'PASS' : 'FAIL'} label=${LABEL} gpu=${GPU_MODE} unresolved=${unresolved.length} out=${OUT}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch(e => { console.error(`[${LABEL}] ${e && e.stack ? e.stack : e}`); process.exit(1) })
