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
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'
import { witnessGpu } from './lib/gpu-probe.mjs'
import { assertServedClientRoot, clientRootTag, CLIENT_ROOT_BUNDLE } from './lib/served-client-root.mjs'
import { mipChainBytes, halvingsFor, LEAF_TEXTURE_MAX_PX_DEFAULT, TREE_TEXTURE_SOURCE_PX } from '../client/core/TreeTextureBudget.js'

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
const [VIEW_W, VIEW_H] = String(flag('viewport', DEFAULT_VIEWPORT.width + 'x' + DEFAULT_VIEWPORT.height)).split('x').map(Number)
const OUT = resolve(flag('out', join(REPO_ROOT, '.gm', 'witness-out', 'leaf-texture-budget')))
const SCRATCH = resolve(flag('scratch', join(tmpdir(), 'spoint-leaftex-budget')))
// A boot that never completes costs the full arm timeout on every arm before it says
// anything. --only=<arm> walks one arm, prints its probe and stops, and states that it
// produced no verdict, so a diagnosis never reads as a pass.
const ONLY = flag('only', null)

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
  { name: 'leaf256', query: `leaftex=256&${BARK}&${FROZEN}`, leafPx: 256, halvings: 2 },
  { name: 'leaf128', query: `leaftex=128&${BARK}&${FROZEN}`, leafPx: 128, halvings: 3 },
  { name: 'leaf64', query: `leaftex=64&${BARK}&${FROZEN}`, leafPx: 64, halvings: 4 },
  // The URL is silent on leaftex, so this arm measures whatever the shipped default
  // resolves to. It is the arm that proves a default change actually reaches the
  // upload: an explicit ?leaftex= arm proves the halver works, only this one proves
  // the value the app picks on its own is the value that gets uploaded.
  { name: 'leafDefault', query: `${BARK}&${FROZEN}`, leafPx: LEAF_TEXTURE_MAX_PX_DEFAULT, halvings: halvingsFor(TREE_TEXTURE_SOURCE_PX, LEAF_TEXTURE_MAX_PX_DEFAULT), isDefault: true },
  { name: 'leaf1024b', query: `leaftex=1024&${BARK}&${FROZEN}`, leafPx: 1024, halvings: 0, control: true },
]
const LEAF_MAPS = 4
const NEAR_BAND_FRAC_GT8_MAX = 0.02
// The floor every delta is judged against is measured, not assumed (see the
// fidelity block): the change under test must stay within CONTROL_SLACK of what two
// loads of the SAME arm measure, and the deliberately coarse 64 arm must sit at
// least NON_VACUITY_FACTOR outside it, which is what keeps the first claim payable.
const CONTROL_SLACK = 1.5
const NON_VACUITY_FACTOR = 2
const FREEZE_TOLERANCE = 0
const FREEZE_SETTLE_MS = 800
const FREEZE_HOLD_MS = 500
// The frame is captured repeatedly until two frames agree (see waitStableFrame).
const STABLE_BUDGET_MS = Number(flag('stableBudget', '60000'))
const STABLE_NEAR_TOL = 0.5
const STABLE_POLL_MS = 400
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
const readB64 = p => readFileSync(p).toString('base64')

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
// A hang here used to report only a page-error count, so a page that never booted and
// a page whose vegetation never built looked identical. Say which gate is missing.
const WHY_EXPR = `(() => {
  const o = { app: !!window.__app, veg: !!window.__veg, texBudget: !!window.__vegTexBudget, warmup: !!window.__warmupInFlight, readyState: document.readyState }
  try { o.revealedAt = window.__app ? window.__app.revealedAt : null } catch (_) { o.revealedAt = 'threw' }
  try { o.appKeys = Object.keys(window.__app || {}).slice(0, 24) } catch (_) { o.appKeys = 'threw' }
  try { o.meshes = window.__veg && window.__veg._meshes ? window.__veg._meshes.length : -1 } catch (_) { o.meshes = 'threw' }
  try { o.vegLog = window.__vegLastError || null } catch (_) {}
  return o
})()`
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
  // A texture-resolution change must not move geometry. The same bundle builds every
  // arm, so the leaf and branch triangle counts and the LOD ladder are read per arm
  // and compared: identical signatures are what makes "texture only" a measurement
  // rather than an assertion about the diff.
  const geo = []
  const triCountOf = (g) => {
    if (!g) return 0
    if (g.index && g.index.count) return g.index.count / 3
    const p = g.attributes && g.attributes.position
    return p ? p.count / 3 : 0
  }
  const lodOf = (mesh) => {
    const li = mesh && mesh.LODinfo
    const objs = (li && (li.objects || li.levels)) || []
    if (!objs.length) return { levels: 1, dists: 'x' }
    const dists = objs.map(o => (o && (o.distance !== undefined ? o.distance : (o.dist !== undefined ? o.dist : o.d))) )
    return { levels: objs.length, dists: dists.map(v => (v === undefined || v === null ? 'x' : String(v))).join(',') }
  }
  if (veg && veg._meshes) {
    for (const m of veg._meshes) {
      for (const which of ['leaf', 'branch']) {
        const mesh = m[which]
        if (!mesh) continue
        const lod = lodOf(mesh)
        geo.push(which + ':' + triCountOf(mesh.geometry) + ':' + lod.levels + ':' + lod.dists)
        const levels = mesh.LODinfo && mesh.LODinfo.objects
        if (levels) for (const l of levels) if (l && l !== mesh) geo.push(which + '/lod:' + triCountOf(l.geometry))
      }
    }
  }
  out.geometry = geo
  out.geometrySig = geo.join('|')
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

// A close-up is only comparable between two arms when both frames look at the same tree
// from the same stand-off, and where the spawn point puts the player is not under this
// witness's control: move first, capture second. A frame with no foliage in the near band
// would make every fidelity delta below read as zero, so the stand-off is claimed, not
// assumed.
const STAND_M = 6
const TRUNK_CLEAR_M = 4
const TOD_FRACTION = 0.28

const readPos = (page) => page.evaluate(() => {
  const c = window.__client || (window.__app && window.__app.client)
  const st = c && c.getLocalState ? c.getLocalState() : null
  const q = st ? st.position : null
  if (!q) return null
  if (typeof q.x === 'number') return { x: +q.x.toFixed(2), z: +q.z.toFixed(2) }
  if (q.length >= 3) return { x: +q[0].toFixed(2), z: +q[2].toFixed(2) }
  return null
}).catch(() => null)

const readTrees = (page) => page.evaluate(() => {
  const veg = window.__veg
  const out = { trees: [], species: 0 }
  if (!veg || !veg._meshes) return out
  const seen = new Set()
  for (const rec of veg._meshes) {
    const b = rec && rec.branch
    if (!b) continue
    out.species++
    const cands = []
    if (b.mesh) cands.push([b.mesh, b.count ?? b.mesh.count ?? 0])
    if (Array.isArray(b.tierMeshes)) for (const m of b.tierMeshes) cands.push([m, b.count ?? m.count ?? 0])
    let took = false
    for (const [m, n] of cands) {
      const im = m && m.instanceMatrix && m.instanceMatrix.array
      if (!im) continue
      const cap = Math.min(n || 0, Math.floor(im.length / 16))
      for (let i = 0; i < cap; i++) {
        const x = im[i * 16 + 12], z = im[i * 16 + 14]
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue
        if (Math.abs(x) < 1e-6 && Math.abs(z) < 1e-6) continue
        const key = Math.round(x) + ':' + Math.round(z)
        if (seen.has(key)) continue
        seen.add(key)
        out.trees.push([+x.toFixed(2), +z.toFixed(2)])
      }
      took = true
      break
    }
    if (!took) continue
  }
  return out
}).catch(() => ({ trees: [], species: 0 }))

async function relocateBesideTree(page, label) {
  const read = await readTrees(page)
  const pos = await readPos(page)
  if (!read.trees.length || !pos) return { error: `no trunk position(s) (${read.trees.length}) or no local state` }
  const ranked = read.trees.map(([x, z]) => ({ x, z, d: Math.hypot(x - pos.x, z - pos.z) })).sort((a, b) => a.d - b.d)
  let plan = null
  for (const t of ranked) {
    const k = t.d > 0 ? STAND_M / t.d : 0
    const sx = t.x + (pos.x - t.x) * k
    const sz = t.z + (pos.z - t.z) * k
    let ok = true
    for (const o of read.trees) if (Math.hypot(o[0] - sx, o[1] - sz) < TRUNK_CLEAR_M) { ok = false; break }
    if (!ok) continue
    plan = { tree: { x: +t.x.toFixed(2), z: +t.z.toFixed(2), distance: +t.d.toFixed(2) }, stand: { x: +sx.toFixed(2), z: +sz.toFixed(2) } }
    break
  }
  if (!plan) return { error: `no trunk with a ${STAND_M} m stand-off clear of ${TRUNK_CLEAR_M} m (${ranked.length} trunk(s))` }
  await page.evaluate(({ x, z }) => {
    window.__goReport = null
    try {
      window.__spoint.go({ x, z })
        .then(r => { window.__goReport = { ms: r && r.ms, placed: r && r.placed } })
        .catch(e => { window.__goReport = { error: String((e && e.message) || e) } })
    } catch (e) { window.__goReport = { error: String((e && e.message) || e) } }
  }, plan.stand)
  const t0 = Date.now()
  let report = null
  while (Date.now() - t0 < 60000) {
    report = await page.evaluate(() => window.__goReport || null).catch(() => null)
    if (report) break
    await new Promise(r => setTimeout(r, 250))
  }
  plan.moved = report || { error: 'window.__spoint.go never reported' }
  console.log(`[${LABEL}] ${label} stand ${JSON.stringify(plan)}`)
  return plan
}

// Two loads of the SAME arm differ by more than a halved leaf map unless the scene is
// pinned as well as the clock: the time of day has to sit at one fraction, the quality
// governor must not be free to pick a different tier per load, and the grass wind has to
// be zero or the sway alone moves every near-band pixel.
// Pinning the stand-off POINT is not pinning the VIEW: the spawn a fresh load picks faces
// a different heading, so two loads of the SAME arm were two different pictures (measured
// 18.67/255 near-band mean |delta| between two loads of one arm). Standing beside a tree
// and not aiming at it also leaves the near band full of ground. So the camera is restored
// to one yaw/pitch/zoom -- aimed at the tree the stand-off was chosen for -- and the
// resulting yaw, pitch, zoom and world forward are read back and asserted equal across
// arms, so a near-band delta is a difference in the picture, not a difference in the view.
const CAM_PITCH = -0.12
const CAM_ZOOM = 2
// `window.__camera` is the three.js camera (client/app.js:790), NOT the controller: it has
// no getVRYaw, so every earlier pin silently did nothing and the read answered null. The
// controller is the local `cam` built at client/app.js:688 and exposed as `window.debug.cam`
// (:2911) and as `engineCtx.cam` (:2222). Pinning must reach THAT object, and the read-back
// must prove it moved, or the arms are different pictures with the same stand-off point.
const CAMERA_EXPR = `(() => {
  const d = window.debug || {}
  const e = window.__app && window.__app.engine
  return (d.cam) || (e && e.cam) || null
})()`
const pinCamera = (page, yaw) => page.evaluate(({ yaw, pitch, zoomIndex, expr }) => {
  const out = { ok: false, which: null, restored: false, set: false, yaw: null, pitch: null, zoom: null }
  const num = (v) => (Number.isFinite(Number(v)) ? +Number(v).toFixed(4) : null)
  const cam = new Function('return (' + expr + ')')()
  const which = (window.debug && window.debug.cam) ? 'window.debug.cam'
    : ((window.__app && window.__app.engine && window.__app.engine.cam) ? 'engineCtx.cam'
      : (window.__camera ? 'window.__camera (three.js camera, not the controller)' : null))
  out.which = which
  if (!cam) { out.reason = 'no camera controller is exposed at all'; return out }
  if (typeof cam.getVRYaw !== 'function') { out.reason = `${which} has no getVRYaw, so it cannot be the controller and nothing was aimed`; return out }
  try { cam.restore({ yaw, pitch, zoomIndex }); out.restored = true } catch (e) { out.restoreError = String(e && e.message).slice(0, 120) }
  try { cam.setVRYaw(yaw); cam.setVRPitch(pitch); out.set = true } catch (e) { out.setError = String(e && e.message).slice(0, 120) }
  out.yaw = num(cam.getVRYaw())
  out.pitch = num(cam.getVRPitch())
  out.zoom = cam.getZoomIndex ? cam.getZoomIndex() : null
  // A pin that did not stick is worse than no pin: it looks like a measurement.
  out.ok = out.yaw !== null && out.pitch !== null && Math.abs(out.yaw - +yaw.toFixed(4)) <= 0.02
  if (!out.ok) out.reason = `aimed for yaw ${num(yaw)} but ${which} reads ${out.yaw}`
  return out
}, { yaw, pitch: CAM_PITCH, zoomIndex: CAM_ZOOM, expr: CAMERA_EXPR }).catch(e => ({ ok: false, error: String(e && e.message).slice(0, 200) }))

const READ_CAMERA_EXPR = `(() => {
  const n = (v) => (Number.isFinite(Number(v)) ? +Number(v).toFixed(3) : null)
  const d = window.debug || {}
  const e = window.__app && window.__app.engine
  const cam = d.cam || (e && e.cam) || null
  const c = d.camera || window.__camera
  if (!cam) return { error: 'no camera controller is exposed (window.debug.cam / engineCtx.cam)' }
  let pos = null, fwd = null
  if (c) {
    try {
      const V = c.position.constructor
      const p = new V(), f = new V()
      try { c.getWorldPosition(p) } catch (_) { p.copy(c.position) }
      try { c.getWorldDirection(f) } catch (_) {}
      pos = [n(p.x), n(p.y), n(p.z)]
      fwd = [n(f.x), n(f.y), n(f.z)]
    } catch (_) {}
  }
  return {
    pos, fwd,
    yaw: n(cam.getVRYaw ? cam.getVRYaw() : cam.yaw),
    pitch: n(cam.getVRPitch ? cam.getVRPitch() : cam.pitch),
    zoom: cam.getZoomIndex ? cam.getZoomIndex() : null,
  }
})()`

// Whatever still differs between two loads of the SAME arm, this is what it is. It is
// read per arm and asserted equal, so a near-band delta that is really a different sun
// or a different weather state is caught as that instead of being reported as texture
// damage. A field that no arm exposes reads null and is simply not asserted.
const READ_SCENE_EXPR = `(() => {
  const n = (v) => (Number.isFinite(Number(v)) ? +Number(v).toFixed(3) : null)
  const out = {}
  const api = window.__timeOfDayApi
  const t = window.__timeOfDay
  if (api) { try { out.todFraction = n(api.getFraction()) } catch (_) {} try { out.todPaused = !!api.isPaused() } catch (_) {} }
  if (t) {
    try { out.sunElevDeg = n(t.elevationDeg) } catch (_) {}
    try { out.clock = String(t.clock || '') } catch (_) {}
    try { out.sunIntensity = n(t.sunIntensity) } catch (_) {}
  }
  const w = window.__weather
  if (w) {
    try { out.weather = String(w.getType ? w.getType() : '') } catch (_) {}
    try { out.intensity = n(w.getIntensity ? w.getIntensity() : null) } catch (_) {}
    try { out.wetness = n(w.getWetness ? w.getWetness() : null) } catch (_) {}
    // Wetness drifts by ~0.012 between loads from the rain that fell before the pin;
    // quantising it to 0.05 keeps that from reading as a different scene.
    if (Number.isFinite(out.wetness)) out.wetness = Math.round(out.wetness * 20) / 20
  }
  const g = window.__qualityGovernorApi
  if (g && typeof g.state === 'function') { try { const s = g.state(); out.tier = s ? s.tier : null } catch (_) {} }
  return out
})()`

const pinScene = (page) => page.evaluate(async (frac) => {
  const out = { tod: false, governor: false, wind: false, fraction: null, paused: null, tier: null }
  // The time-of-day API is created during boot, and setting a fraction on a page that
  // has not built it yet is a silent no-op: the first arm of one run kept the boot sun
  // (fraction 0.55, elevation 63.7 deg) while every later arm sat at 0.28 / 12.6 deg,
  // which alone made two loads of the SAME arm differ by 109/255 in the far band.
  const deadline = Date.now() + 20000
  while (!window.__timeOfDayApi && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
  const tod = window.__timeOfDayApi
  out.apiWaitedMs = 20000 - Math.max(0, deadline - Date.now())
  if (tod) {
    try {
      // Setting the fraction once is not setting it: on the first arm of one run the
      // read-back stayed at the boot fraction, so the arm rendered at 63.7 deg sun
      // elevation while every other arm sat at 12.6 deg. Set it, read it back, retry.
      const settle = async (pauseFirst) => {
        for (let i = 0; i < 20; i++) {
          try {
            if (pauseFirst) tod.setPaused(true)
            tod.setFraction(frac)
            const got = Number(tod.getFraction())
            if (Number.isFinite(got) && Math.abs(got - frac) <= 0.002) return { ok: true, tries: i + 1 }
          } catch (_) {}
          await new Promise(r => setTimeout(r, 250))
        }
        return { ok: false, tries: 20 }
      }
      let r = await settle(true)
      if (!r.ok) {
        // A clock that refuses the fraction while paused takes it once it is running.
        try { tod.setPaused(false) } catch (_) {}
        r = await settle(false)
        try { tod.setPaused(true) } catch (_) {}
        if (r.ok) out.unpausedToSet = true
      }
      out.tod = r.ok
      out.todTries = r.tries
      out.fraction = tod.getFraction()
      out.paused = tod.isPaused()
    } catch (_) {}
  }
  if (!out.tod) out.todReason = window.__timeOfDayApi ? 'setFraction never read back as the target' : 'no window.__timeOfDayApi'
  const gov = window.__qualityGovernorApi
  if (gov && typeof gov.setTier === 'function') {
    try { gov.setTier(0); out.governor = true } catch (_) {}
    try { const s = gov.state ? gov.state() : window.__qualityGovernorState; out.tier = s ? s.tier : null } catch (_) {}
  }
  // Weather is the one remaining per-load difference that is not a texture: two loads of
  // the SAME arm measured frame means of 128 and 74, and rain redraws every frame, so a
  // wet load is both a different picture and a permanently moving one.
  const w = window.__weather
  if (w) {
    out.weather = true
    try { out.weatherWas = w.getType ? w.getType() : null } catch (_) {}
    try { out.intensityWas = w.getIntensity ? w.getIntensity() : null } catch (_) {}
    try { w.setType('clear'); out.cleared = true } catch (_) {}
    try { w.setIntensity(0); out.intensity = w.getIntensity ? w.getIntensity() : null } catch (_) {}
    try { out.wetness = w.getWetness ? w.getWetness() : null } catch (_) {}
  }
  try { window.__grassWind = 0; out.wind = true } catch (_) {}
  return out
}, TOD_FRACTION).catch(e => ({ error: e.message }))

// A frozen clock is not a frozen frame: grass still streams in for seconds after a
// relocation and rain keeps drawing, so two captures a fixed delay apart measured a
// scene that was still arriving (measured 8.6..30.8/255 mean |delta| within ONE page).
// So the capture pair is not taken on a timer -- it is taken REPEATEDLY until the two
// frames agree, and the pair that agreed is the pair every diff below compares. A view
// that never settles keeps its best measured delta and is reported as not static rather
// than being silently diffed.
async function waitStableFrame(page, scratchPage, armName, pngPath, pngBPath) {
  const t0 = Date.now()
  let best = null
  let attempts = 0
  let bytes = 0
  while (Date.now() - t0 < STABLE_BUDGET_MS) {
    attempts++
    const b = await page.screenshot({ path: pngPath })
    bytes = b.length
    await page.waitForTimeout(FREEZE_HOLD_MS)
    await page.screenshot({ path: pngBPath })
    const res = await scratchPage.evaluate(diffExpr(readB64(pngPath), readB64(pngBPath)))
    delete res.diffPng
    const near = res.near ? res.near.meanAbs : Infinity
    const all = res.all ? res.all.meanAbs : Infinity
    const row = { near, all, attempts, ms: Date.now() - t0 }
    if (!best || near < best.near) best = row
    if (near <= STABLE_NEAR_TOL) {
      console.log(`[${LABEL}] ${armName} frame settled after ${attempts} capture pair(s) in ${row.ms}ms (near ${near}/255)`)
      return { ok: true, bytes, ...row }
    }
    if (attempts % 5 === 0) console.log(`[${LABEL}] ${armName} frame still moving at ${row.ms}ms (best near ${best.near}/255, this pair ${near}/255)`)
    await page.waitForTimeout(STABLE_POLL_MS)
  }
  console.log(`[${LABEL}] ${armName} frame NEVER settled in ${STABLE_BUDGET_MS}ms (best near ${best.near}/255 over ${attempts} pair(s))`)
  return { ok: false, bytes, ...best }
}

async function runArm(browser, base, arm, scratchPage) {
  const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', e => pageErrors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error' && consoleErrors.length < 20) consoleErrors.push(String(m.text()).slice(0, 300)) })
  try {
    await page.goto(`${base}/?singleplayer&dprOff=true&${arm.query}`, { waitUntil: 'domcontentloaded' })
    const root = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: LABEL }).catch(e => e)
    if (root instanceof Error) throw root
    const gpu = await witnessGpu(page, GPU_MODE)
    const t0 = Date.now()
    let probe = null
    let lastWhy = null
    let nextLog = 0
    while (Date.now() - t0 < TIMEOUT_MS) {
      const st = await page.evaluate(`({ playable: !!(${PLAYABLE_EXPR}), budget: !!window.__vegTexBudget })`).catch(() => ({}))
      if (st.playable && st.budget) { probe = await page.evaluate(BUDGET_EXPR); break }
      const el = Date.now() - t0
      if (el >= nextLog) {
        nextLog = el + 30000
        lastWhy = await page.evaluate(WHY_EXPR).catch(e => ({ evalFailed: String(e && e.message).slice(0, 200) }))
        console.log(`[${LABEL}] arm ${arm.name} waiting ${el}ms for playable+budget: ${jsonLine(lastWhy)}`)
      }
      await new Promise(r => setTimeout(r, 250))
    }
    if (!probe) {
      const why = await page.evaluate(WHY_EXPR).catch(e => ({ evalFailed: String(e && e.message).slice(0, 200) }))
      throw new Error(
        `arm ${arm.name}: the page never became playable with a vegetation budget within ${TIMEOUT_MS}ms` +
        ` (pageErrors=${pageErrors.length}${pageErrors[0] ? ': ' + pageErrors[0].slice(0, 200) : ''}` +
        `, why=${jsonLine(why)}` +
        `, consoleErrors=${consoleErrors.length}${consoleErrors.length ? ': ' + consoleErrors.slice(0, 4).join(' | ') : ''})`
      )
    }
    const stand = await relocateBesideTree(page, arm.name)
    await page.waitForTimeout(SETTLE_MS)
    const aimYaw = (stand && !stand.error && stand.stand && stand.tree)
      ? Math.atan2(stand.tree.x - stand.stand.x, stand.tree.z - stand.stand.z)
      : 0
    const view = await pinCamera(page, aimYaw)
    await page.waitForTimeout(600)
    const pin = await pinScene(page)
    await page.waitForTimeout(600)
    const frozen = await page.evaluate(FREEZE_EXPR)
    await page.waitForTimeout(FREEZE_SETTLE_MS)
    // The governor keeps ticking after the first pin -- one arm was captured at tier 1
    // while the other six sat at tier 0 -- so the scene is pinned again as late as
    // possible, immediately before the capture.
    const pin2 = await pinScene(page)
    await page.waitForTimeout(400)
    const pngPath = join(OUT, `${arm.name}.png`)
    const pngBPath = join(OUT, `${arm.name}-b.png`)
    const stable = await waitStableFrame(page, scratchPage, arm.name, pngPath, pngBPath)
    const buf = { length: stable.bytes }
    const camState = await page.evaluate(READ_CAMERA_EXPR).catch(e => ({ error: String(e && e.message).slice(0, 160) }))
    const sceneState = await page.evaluate(READ_SCENE_EXPR).catch(e => ({ error: String(e && e.message).slice(0, 160) }))
    return { arm, probe, gpu, root: clientRootTag(root), pngPath, pngBPath, frozen, stable, view, camState, sceneState, bytes: buf.length, pageErrors, stand, pin, pin2 }
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
    const scratchPage = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
    const walk = ONLY ? ARMS.filter(a => a.name === ONLY) : ARMS
    if (ONLY && walk.length !== 1) {
      console.error(`${LABEL}: --only=${ONLY} names no arm (arms: ${ARMS.map(a => a.name).join(',')})`)
      process.exit(2)
    }
    for (const arm of walk) results.push(await runArm(browser, base, arm, scratchPage))
    if (ONLY) {
      for (const r of results) console.log(`[${LABEL}] ONLY ${r.arm.name} ${jsonLine({ budget: r.probe.budget, leaf: r.probe.stats && r.probe.stats.leaf, bark: r.probe.stats && r.probe.stats.bark, refusals: (r.probe.refusals || []).length, geometry: r.probe.geometrySig, gpu: r.gpu, root: r.root })}`)
      console.log(`[${LABEL}] --only=${ONLY} printed the probe and stopped: NO VERDICT was produced`)
      if (browser) await browser.close().catch(() => {})
      server.stop()
      process.exit(0)
    }

    const shots = {}
    for (const r of results) shots[r.arm.name] = r.pngPath
    const a512 = results.find(r => r.arm.name === 'leaf512')
    const a256 = results.find(r => r.arm.name === 'leaf256')
    const a128 = results.find(r => r.arm.name === 'leaf128')
    const a1024 = results.find(r => r.arm.name === 'leaf1024')
    const a64 = results.find(r => r.arm.name === 'leaf64')
    const aDefault = results.find(r => r.arm.name === 'leafDefault')

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
    const diff256v512 = await pair('leaf256', 'leaf512', 'leaf256-vs-leaf512')
    const diff128v512 = await pair('leaf128', 'leaf512', 'leaf128-vs-leaf512')
    const diffDefault512 = await pair('leafDefault', 'leaf512', 'leafDefault-vs-leaf512')
    const diff64v512 = await pair('leaf64', 'leaf512', 'leaf64-vs-leaf512')
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
      expect(`${arm.name}: the capture frames a real tree from a fixed ${STAND_M} m stand-off`, !!(r.stand && !r.stand.error && r.stand.moved && !r.stand.moved.error), '==', true)
      expect(`${arm.name}: the time of day is pinned to one fraction before the capture`, !!(r.pin && r.pin.tod === true && r.pin.paused !== false), '==', true)
      expect(`${arm.name}: the quality governor is pinned to one tier before the capture`, !!(r.pin && r.pin.governor === true), '==', true)
    }

    // --- the change moved texture resolution only ----------------------------
    const distinctGeo = new Set(results.map(r => r.probe.geometrySig))
    console.log(`[${LABEL}] geometry ${jsonLine(results.map(r => ({ arm: r.arm.name, n: (r.probe.geometry || []).length, sig: String(r.probe.geometrySig || '').slice(0, 160) })))}`)
    expect('geometry: every arm reports a geometry signature (an empty signature is a silent pass)', results.every(r => (r.probe.geometry || []).length > 0), '==', true)
    expect(`geometry: all ${results.length} arms carry the same leaf/branch triangle counts and LOD ladder (texture resolution moved, geometry did not)`, distinctGeo.size, '==', 1)

    // The spawn point a fresh load picks varies by a few centimetres, so the arm's own
    // stand is compared to 0.1 m: below that the view is the same view for the purpose
    // of a per-band delta, above it a near-band delta is two different places.
    const standKey = (r) => {
      const s = r.stand && !r.stand.error && r.stand.stand
      return s ? `${Math.round(s.x * 10) / 10}/${Math.round(s.z * 10) / 10}` : 'error'
    }
    const distinctStands = new Set(results.map(standKey))
    expect(`close-up: all ${results.length} arms frame the same stand-off point to 0.1 m (every near-band delta below is the same view)`, distinctStands.size, '==', 1)

    for (const r of results) console.log(`[${LABEL}] ${r.arm.name} camera ${jsonLine(r.camState)}`)
    for (const r of results) console.log(`[${LABEL}] ${r.arm.name} scene ${jsonLine(r.sceneState)}`)
    // An unreadable camera is not an agreeing camera. The previous run reported "all
    // arms are aimed at the same view" because EVERY arm's read had thrown, so the one
    // distinct key was the error string -- a pass that proved nothing while the two
    // loads of one arm differed by 93/255 in the far band. The read must succeed, and
    // the pin must report it held, before any delta below means anything.
    const unread = results.filter(r => !r.camState || r.camState.error || !Number.isFinite(Number(r.camState.yaw)))
    expect(`close-up: the camera state was read in all ${results.length} arms (an unread camera cannot be compared)`, unread.length, '==', 0)
    const unpinned = results.filter(r => !(r.view && r.view.ok === true))
    expect(`close-up: the camera pin held in all ${results.length} arms`, unpinned.length, '==', 0)
    const quant = (v) => (typeof v === 'number' ? Math.round(v * 20) / 20 : v)
    const camKey = (r) => {
      const c = r.camState || {}
      return c.error || !Number.isFinite(Number(c.yaw)) ? `error:${String(c.error || 'no yaw').slice(0, 40)}` : `${quant(c.yaw)}/${quant(c.pitch)}/${c.zoom}/${(c.fwd || []).map(quant).join(',')}`
    }
    const distinctCams = new Set(results.map(camKey))
    console.log(`[${LABEL}] camera keys ${jsonLine([...distinctCams])}`)
    expect(`close-up: all ${results.length} arms are aimed at the same view (yaw/pitch/zoom/forward identical to ~3 degrees)`, distinctCams.size, '==', 1)
    const sameView = distinctCams.size === 1 && distinctStands.size === 1 && unread.length === 0 && unpinned.length === 0
    // The sun, the weather and the quality tier are not textures: if they move between
    // loads, every delta below is a difference in lighting, not in leaf resolution.
    const sceneKey = (r) => JSON.stringify(r.sceneState || {})
    const distinctScenes = new Set(results.map(sceneKey))
    console.log(`[${LABEL}] scene keys ${jsonLine([...distinctScenes])}`)
    expect(`close-up: all ${results.length} arms render under the same sun, weather and tier`, distinctScenes.size, '==', 1)
    const sameScene = distinctScenes.size === 1

    // --- a frozen frame, or the fidelity claim has no floor -------------------
    for (const r of results) {
      const d = await diffPaths(r.pngPath, r.pngBPath)
      r.freezeDiff = d
      console.log(`[${LABEL}] ${r.arm.name} frozen ${jsonLine({ clock: r.frozen, frame: d.frame, meanAbs: d.all && d.all.meanAbs, maxAbs: d.all && d.all.maxAbs })}`)
      expect(`${r.arm.name}: the animation clock was frozen before the capture`, r.frozen && r.frozen.froze, '==', true)
      expect(`${r.arm.name}: the frozen frame still carries an image (stddev > ${FRAME_MIN_STDDEV})`, d.frame && d.frame.std, '>', FRAME_MIN_STDDEV)
      // Settling is NOT a pass/fail gate per arm. A scene that never quite stops
      // moving makes the WITHIN-page floor unproven for that arm, and failing the
      // run on it would report "128 is worse than 512" when the truth is "this
      // capture cannot isolate the difference". The cross-arm claim is carried by
      // the same-arm control below, so a non-settling arm is parked, not failed --
      // but it is parked out loud, with its best measured value.
      console.log(`[${LABEL}] ${r.arm.name} stable ${jsonLine(r.stable)}`)
      if (!(r.stable && r.stable.ok === true)) {
        unresolved.push(`${r.arm.name}: the frame never settled to within ${STABLE_NEAR_TOL}/255 inside one page -- best of ${r.stable ? r.stable.attempts : 0} capture pair(s) over ${STABLE_BUDGET_MS / 1000}s is ${r.stable ? r.stable.near : 'unmeasured'}/255 in the near band, so this arm's own noise floor is unproven (the cross-arm claim is judged against the control, below)`)
      }
    }
    const worstWithin = Math.max(...results.map(r => (r.stable ? r.stable.near : Infinity)))
    const frameStatic = results.every(r => r.stable && r.stable.ok === true)
    console.log(`[${LABEL}] every arm settled ${frameStatic} -- worst within-page near-band delta ${worstWithin}/255`)

    // --- non-vacuity: the full-size arm must NOT meet the budget -------------
    const leaf1024 = a1024.probe.stats.leaf
    const leaf512 = a512.probe.stats.leaf
    const leaf256 = a256.probe.stats.leaf
    expect('non-vacuity: with the halving disabled the leaf maps stay at the source size', leaf1024.residentBytes, '==', leaf1024.sourceBytes)
    expect('non-vacuity: the 512 arm frees real leaf bytes', leaf512.sourceBytes - leaf512.residentBytes, '>', 0)
    expect('non-vacuity: the 512 arm frees exactly 16777216 B of leaf mip chain', leaf512.sourceBytes - leaf512.residentBytes, '==', 16777216)
    expect('non-vacuity: halving the 512 default to 256 frees exactly 4194304 more B of leaf mip chain', leaf512.residentBytes - leaf256.residentBytes, '==', 4194304)
    expect('non-vacuity: the 256 arm frees exactly 20971520 B of leaf mip chain from the source', leaf256.sourceBytes - leaf256.residentBytes, '==', 20971520)
    const leaf128 = a128.probe.stats.leaf
    expect('non-vacuity: halving the old 512 default all the way to 128 frees exactly 5242880 B of leaf mip chain', leaf512.residentBytes - leaf128.residentBytes, '==', 5242880)
    expect('non-vacuity: halving 256 to 128 frees exactly 1048576 more B of leaf mip chain', leaf256.residentBytes - leaf128.residentBytes, '==', 1048576)
    expect('non-vacuity: the 128 arm frees exactly 22020096 B of leaf mip chain from the source', leaf128.sourceBytes - leaf128.residentBytes, '==', 22020096)
    // The arm that decides the claim: no ?leaftex= in the URL, so this is the value the
    // app picks on its own, and it is read off the textures the live scene actually
    // carries rather than off the constant.
    expect('the arm with no ?leaftex= resolves to the shipped LEAF_TEXTURE_MAX_PX_DEFAULT', aDefault.probe.budget.leafMaxPx, '==', LEAF_TEXTURE_MAX_PX_DEFAULT)
    const defaultLeafPx = aDefault.probe.budget.leafMaxPx
    expect(`the default arm's leaf maps are resident at ${defaultLeafPx}px an edge`, aDefault.probe.stats.leaf.residentBytes, '==', LEAF_MAPS * mipChainBytes(defaultLeafPx, defaultLeafPx))
    const defaultSceneLeaf = aDefault.probe.sceneTextures.filter(t => t.leaf)
    expect(`every leaf map in the live default scene is ${defaultLeafPx}px an edge`, defaultSceneLeaf.length > 0 && defaultSceneLeaf.every(t => t.w === defaultLeafPx), '==', true)

    console.log(`[${LABEL}] diff control ${jsonLine(diffControl)}`)
    // --- fidelity is a separate claim from the byte saving -------------------
    console.log(`[${LABEL}] diff 256-vs-512 ${jsonLine(diff256v512)}`)
    console.log(`[${LABEL}] diff default-vs-512 ${jsonLine(diffDefault512)}`)
    console.log(`[${LABEL}] diff 64-vs-512 ${jsonLine(diff64v512)}`)
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
    console.log(`[${LABEL}] diff 128-vs-512 ${jsonLine(diff128v512)}`)
    // The floor every delta is judged against is not a constant: it is what two loads of
    // the SAME arm measure. An absolute threshold would be a guess about a scene that
    // streams, so the change under test is required to stay within CONTROL_SLACK of the
    // same-arm noise, and the 64 arm is required to sit clearly outside it, which is what
    // stops the first claim from being vacuous.
    // STABLE_NEAR_TOL is a resolution limit the capture already proved inside one page,
    // so two loads of the same arm cannot legitimately agree more closely than that;
    // a control reading below it is a lucky pair, not a tighter floor.
    const noiseFloor = Math.max(diffControl.near.meanAbs, STABLE_NEAR_TOL)
    if (sameView && sameScene) {
      expect(`fidelity: halving the shipped default to 128 stays within ${CONTROL_SLACK}x the load-to-load noise floor of the SAME arm in the near band (128-vs-512 ${diff128v512.near.meanAbs}/255 against a control of ${noiseFloor}/255)`, diff128v512.near.meanAbs, '<=', noiseFloor * CONTROL_SLACK)
      expect(`fidelity: halving to 256 stays within ${CONTROL_SLACK}x the same floor (256-vs-512 ${diff256v512.near.meanAbs}/255)`, diff256v512.near.meanAbs, '<=', noiseFloor * CONTROL_SLACK)
      expect(`fidelity: halving to 512 stays within ${CONTROL_SLACK}x the same floor (512-vs-1024 ${diff512v1024.near.meanAbs}/255)`, diff512v1024.near.meanAbs, '<=', noiseFloor * CONTROL_SLACK)
      expect(`fidelity: the 64 arm is at least ${NON_VACUITY_FACTOR}x that same floor (64-vs-512 ${diff64v512.near.meanAbs}/255), so the gates above are not vacuous`, diff64v512.near.meanAbs, '>', noiseFloor * NON_VACUITY_FACTOR)
      expect(`fidelity: fewer than ${NEAR_BAND_FRAC_GT8_MAX * 100}% of near-band pixels differ by more than 8/255 between 128 and 512`, diff128v512.near.fracGt8, '<=', NEAR_BAND_FRAC_GT8_MAX)
    } else {
      unresolved.push(`fidelity: no per-band claim is made -- the arms did not end up on the same view or under the same scene state, so every delta below is two different pictures. Camera keys: ${[...distinctCams].join(' | ')}. Scene keys: ${[...distinctScenes].join(' | ')}. A second load of the SAME arm differs by ${noiseFloor}/255 in the near band; 512-vs-1024 is ${diff512v1024.near.meanAbs}/255, 256-vs-512 is ${diff256v512.near.meanAbs}/255, 128-vs-512 is ${diff128v512.near.meanAbs}/255 and 64-vs-512 is ${diff64v512.near.meanAbs}/255. Unmeasured, not measured-good.`)
    }
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
