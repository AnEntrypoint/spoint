#!/usr/bin/env node
// Witness: foliage must never draw zero instances across a render-quality / settings change.
// Row: perf-foliage-one-frame-disappears-on-change-spoint-orch-b186-u1
//
// Live execution only: real server, real headful browser, real rAF frames. The per-frame
// sample reads the live draw set the renderer will draw (scene InstancedMeshes owned by the
// foliage instancers). The file:line of the state transition that empties it comes from
// stack-traps installed in the page, never from inference.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir, freemem, totalmem } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { vendorPinArgs } from './lib/witness-gpu.mjs'
import { witnessGpu } from './lib/gpu-probe.mjs'
import {
  assertServedClientRoot, clientRootTag, rebuildIfRequested, CLIENT_ROOT_BUNDLE, CLIENT_ROOT_RAW,
} from './lib/served-client-root.mjs'
import { flagListNumber, flagNumber } from './lib/witness-args.mjs'

const LABEL = 'veg-change-vanish-witness'
const LF = String.fromCharCode(10)
const RUN_ID = randomUUID().slice(0, 8)

function flag(name, dflt = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const PORT = flag('port', '3191')
const PARAMS = String(flag('params', 'singleplayer')).split('|')
const WORLD = flag('world', 'tps-game')
const GPU_MODE = flag('gpu', 'accelerated')
const CLIENT_ROOT_ARG = flag('client-root', 'any')
const CLIENT_ROOT = CLIENT_ROOT_ARG === 'bundle' ? CLIENT_ROOT_BUNDLE : CLIENT_ROOT_RAW
// --client-root=any (default) admits whichever root the server chose: both are rebuilt from
// the current client tree (the bundle is served only while its stamp matches every file under
// client/), so either one carries the change under test.
const WANT_ROOT = CLIENT_ROOT_ARG === 'bundle' ? CLIENT_ROOT_BUNDLE : (CLIENT_ROOT_ARG === 'raw-esm' ? CLIENT_ROOT_RAW : null)
// --marker=<text> asserts the served bytes carry this text, so no run can report on a client
// build that predates the change under test: bundle roots are checked in the bundle entry,
// raw roots in the module itself.
const MODULE_MARKER = flag('marker', null)
const MARKER_PATH = flag('marker-path', null)
// --force-raw-esm=1 makes the prebuilt client bundle read as stale for this run, so the server
// serves client/ directly instead. The bundle names every captured site app.js:LINE and ships
// no source map; the raw tree names the real source file, which is the citation the row asks
// for. Both roots run the current client sources, so this changes what the page loads, never
// which code it runs. The stamp is restored on every exit path, including process.exit.
const FORCE_RAW_ESM = flag('force-raw-esm', '0') !== '0'
const PRE_FRAMES = Math.max(1, flagNumber(flag, 'pre', 60, process.argv.slice(2)) | 0)
const POST_FRAMES = Math.max(1, flagNumber(flag, 'post', 60, process.argv.slice(2)) | 0)
const READY_TIMEOUT_MS = flagNumber(flag, 'ready-timeout', 420000, process.argv.slice(2))
const CAPTURE_TIMEOUT_MS = flagNumber(flag, 'capture-timeout', 180000, process.argv.slice(2))
const SETTLE_MS = flagNumber(flag, 'settle', 2500, process.argv.slice(2))
const MIN_FREE_GB = flagNumber(flag, 'min-free-gb', 3, process.argv.slice(2))
const EXPECT_ZERO = flagNumber(flag, 'expect-zero', 0, process.argv.slice(2))
const MAX_ZERO = flagNumber(flag, 'max-zero', 0, process.argv.slice(2))
const ARM = flag('arm', 'unlabelled')
const RESET_SCRATCH = flag('reset-scratch', '1') !== '0'
const DRIVER_FILTER = flag('drivers', null)
// --walk=1 holds W through each capture so the camera keeps moving: updateLOD only
// re-evaluates when the eye moves 0.5 m or the view matrix changes, so a still page
// never exercises the sweep that empties cells.
const WALK = flag('walk', '0') !== '0'
// --look=1 turns the view through each capture (real CDP mouse moves while pointer-locked).
const LOOK = flag('look', '0') !== '0'
const [VIEW_W, VIEW_H] = flagListNumber(flag, 'viewport', [DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height], 'x', process.argv.slice(2))
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = resolve(flag('scratch', join(tmpdir(), 'spoint-veg-change-vanish-witness')))

function finish(verdict, detail) {
  console.log(`RESULT: ${verdict} arm=${ARM} label=${LABEL} run=${RUN_ID} -- ${String(detail).split(LF).join(' ')}`)
  process.exit(verdict === 'PASS' ? 0 : 1)
}
const fail = (detail) => finish('FAIL', detail)

const num = (x) => typeof x === 'number' && Number.isFinite(x)
const OPS = {
  '==': (got, want) => Object.is(got, want),
  '<=': (got, want) => num(got) && got <= want,
  '>=': (got, want) => num(got) && got >= want,
  '>': (got, want) => num(got) && got > want,
}
const checks = []
function expect(label, got, op, want) {
  const pass = OPS[op](got, want) === true
  checks.push({ label, got, op, want, pass })
  return pass
}
const round = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : NaN)
const jsonLine = (v) => JSON.stringify(v, (_, x) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : x))

function resetScratch() {
  const insideRepo = SCRATCH.startsWith(REPO_ROOT + sep) || SCRATCH === REPO_ROOT
  const enclosesRepo = REPO_ROOT.startsWith(SCRATCH + sep)
  if (insideRepo || enclosesRepo || SCRATCH === resolve(tmpdir()) || dirname(SCRATCH) === SCRATCH) {
    fail(`--scratch=${SCRATCH} refused: scratch must be outside the repo, not the temp root, not a filesystem root`)
  }
  if (RESET_SCRATCH) rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
}

const STAMP_REL = join('dist', 'client', 'app.bundlehash.json')
let stampBackup = null

function flipOneHash(tree, target) {
  if (Array.isArray(tree)) return tree.map(x => flipOneHash(x, target))
  if (tree && typeof tree === 'object') {
    const out = {}
    for (const k of Object.keys(tree)) out[k] = flipOneHash(tree[k], target)
    return out
  }
  if (tree === target) return tree.slice(0, -1) + (tree.slice(-1) === 'a' ? 'b' : 'a')
  return tree
}

function firstHashLike(tree) {
  if (Array.isArray(tree)) {
    for (const x of tree) { const h = firstHashLike(x); if (h) return h }
    return null
  }
  if (tree && typeof tree === 'object') {
    for (const k of Object.keys(tree)) { const h = firstHashLike(tree[k]); if (h) return h }
    return null
  }
  return typeof tree === 'string' && /^[0-9a-f]{8,}$/i.test(tree) ? tree : null
}

function perturbClientStamp() {
  const p = join(REPO_ROOT, STAMP_REL)
  if (!existsSync(p)) {
    console.log(`[${LABEL}] force-raw-esm: no client bundle stamp at ${STAMP_REL}; leaving the served root alone`)
    return null
  }
  let bytes
  try { bytes = readFileSync(p) } catch (e) { return null }
  try {
    const tree = JSON.parse(bytes.toString('utf8'))
    const target = firstHashLike(tree)
    if (!target) {
      console.log(`[${LABEL}] force-raw-esm: ${STAMP_REL} holds no hash to perturb; leaving the served root alone`)
      return null
    }
    const modified = JSON.stringify(flipOneHash(tree, target))
    writeFileSync(p, modified)
    console.log(`[${LABEL}] force-raw-esm: ${STAMP_REL} rewritten so the bundle reads stale (backup ${bytes.length} bytes)`)
    return { path: p, bytes, modified }
  } catch (e) {
    console.log(`[${LABEL}] force-raw-esm: could not perturb ${STAMP_REL} (${String(e && e.message)}); leaving the served root alone`)
    return null
  }
}

function restoreClientStamp() {
  const b = stampBackup
  if (!b) return
  stampBackup = null
  try {
    const now = readFileSync(b.path, 'utf8')
    if (now !== b.modified) {
      console.log(`[${LABEL}] force-raw-esm: ${STAMP_REL} changed during the run (rebuilt); leaving the newer stamp in place`)
      return
    }
    writeFileSync(b.path, b.bytes)
    console.log(`[${LABEL}] force-raw-esm: ${STAMP_REL} restored`)
  } catch (e) {
    console.log(`[${LABEL}] force-raw-esm: FAILED to restore ${STAMP_REL}: ${String(e && e.message)}`)
  }
}

// ---------------------------------------------------------------- in-page probe

const PROBE_INIT = `(() => {
  const P = { active: false, running: false, result: null, frame: -1, events: [], installed: false, instancers: [], drawSet: [], drawSetKind: 'none', changes: [], stats: { lodCalls: 0 } }
  window.__vegVanishFrameProbe = P
  // The probe is injected as one anonymous script, so every frame of the probe itself carries
  // (<anonymous>:line:col). The first frame that does not is the application code that
  // performed the write, which is the file:line the row asks the witness to cite.
  const stack = () => {
    const lines = String((new Error()).stack || '').split('\\n').slice(2, 16).map(s => s.trim()).filter(Boolean)
    const app = lines.filter(s => !/[(]<anonymous>:/.test(s))
    return (app.length ? app : lines).slice(0, 4)
  }
  function evt(kind, detail) {
    if (P.events.length >= 8000) return
    P.events.push({ f: P.frame, kind, detail: detail || null, at: stack() })
  }
  P.evt = evt

  function trapVisible(obj, tag) {
    if (!obj) return false
    const d = Object.getOwnPropertyDescriptor(obj, 'visible')
    if (!d) return false
    let cur = d.value
    const get = d.get || (() => cur)
    const set = d.set || ((v) => { cur = v })
    Object.defineProperty(obj, 'visible', {
      configurable: true, enumerable: d.enumerable !== false,
      get: () => get.call(obj),
      set: function (v) {
        let before
        try { before = get.call(obj) } catch (_) { before = undefined }
        if (before !== false && !v) evt('visible=false', tag)
        set.call(obj, v)
      },
    })
    return true
  }

  function collectDrawSet() {
    const veg = window.__veg
    const apis = new Set()
    for (const rec of veg._meshes) { if (rec.branch) apis.add(rec.branch); if (rec.leaf) apis.add(rec.leaf) }
    try { if (veg.sharedImpostor) apis.add(veg.sharedImpostor) } catch (_) {}
    const found = []
    const seen = new Set()
    const scene = window.__scene || (window.__app && window.__app.scene) || null
    if (scene && typeof scene.traverse === 'function') {
      scene.traverse((o) => {
        if (!o.isInstancedMesh) return
        const owner = o.userData && o.userData.lodInstancer
        if (!owner || !apis.has(owner)) return
        if (seen.has(o)) return
        seen.add(o); found.push(o)
      })
    }
    if (found.length) { P.drawSet = found; P.drawSetKind = 'scene-instanced-mesh'; return found.length }
    // fallback: the instancer's own reported mesh / legacy LOD levels
    for (const it of P.instancers) {
      const api = it.api
      const m = api.mesh || (api.isObject3D ? api : null)
      if (m && m.isInstancedMesh) found.push(m)
      try { const lv = api.LODinfo && api.LODinfo.objects; if (lv) for (const l of lv) if (l && l.isInstancedMesh) found.push(l) } catch (_) {}
    }
    P.drawSet = found
    P.drawSetKind = found.length ? 'instancer-mesh' : 'none'
    return found.length
  }

  function effectivelyVisible(o) {
    let v = o.visible !== false
    let p = o.parent
    while (v && p) { v = p.visible !== false; p = p.parent }
    return v
  }

  function tierBands(api) {
    try {
      const t = api.tierIds
      if (Array.isArray(t)) return t.map(a => (a ? a.length : 0))
      const lod = api.LODinfo && api.LODinfo.render
      const lc = lod && lod.count
      if (lc && lc.length) return Array.prototype.slice.call(lc).map(n => n || 0)
    } catch (_) {}
    return null
  }

  function snapshot() {
    let drawn = 0, visibleMeshes = 0, detached = 0
    const ds = P.drawSet
    for (let i = 0; i < ds.length; i++) {
      const o = ds[i]
      // A mesh yanked out of the scene graph for a frame draws nothing at all, so it counts
      // as drawn nothing rather than as hidden-but-present.
      if (!o.parent) { detached++; continue }
      if (!effectivelyVisible(o)) continue
      const c = typeof o.count === 'number' ? o.count : 0
      if (c > 0) { drawn += c; visibleMeshes++ }
    }
    const bands = []
    let tieredInstancers = 0, bandlessInstancers = 0
    for (const it of P.instancers) {
      const b = tierBands(it.api)
      if (b) { tieredInstancers++; for (let i = 0; i < b.length; i++) bands[i] = (bands[i] || 0) + b[i] }
      else bandlessInstancers++
    }
    const r = window.__renderer
    let dpr = NaN, cw = 0, ch = 0
    if (r) {
      try { dpr = r.getPixelRatio ? r.getPixelRatio() : NaN } catch (_) {}
      try { cw = r.domElement.width; ch = r.domElement.height } catch (_) {}
    }
    // Camera signature: whether the eye moved or the view changed this frame decides
    // whether updateLOD sweeps at all, so every capture reports how many frames were live.
    let camKey = ''
    try {
      const c = window.__camera || (window.__app && window.__app.camera)
      if (c && c.matrixWorld) {
        const e = c.matrixWorld.elements
        camKey = [e[12], e[13], e[14], c.quaternion.x, c.quaternion.y, c.quaternion.z].map((v) => Math.round(v * 1000) / 1000).join(',')
      }
    } catch (_) {}
    return { drawn, visibleMeshes, detached, bands, tieredInstancers, bandlessInstancers, dpr, cw, ch, total: (window.__veg ? window.__veg.totalInstances : 0), camKey, lodCalls: P.stats.lodCalls }
  }
  P.snapshot = snapshot

  P.install = function () {
    if (P.installed) return { ok: true, instancers: P.instancers.length, drawSet: P.drawSet.length, drawSetKind: P.drawSetKind }
    const veg = window.__veg
    if (!veg || !veg._meshes || !veg._meshes.length) return { ok: false, why: 'no veg meshes on window.__veg' }
    P.installed = true

    for (const k of ['vegAllOff', 'vegHideFar', 'vegLeafOff', 'vegWind', 'ssao', 'bloom', 'ssr', 'thc', 'halfResWater', 'fogFar', 'dprAuto', 'toneMappingExposure', 'grassWind']) {
      const key = '__' + k
      let cur = window[key]
      try {
        Object.defineProperty(window, key, {
          configurable: true, enumerable: true,
          get: () => cur,
          set: (v) => { cur = v; evt('window-knob', { key: k, value: v === null ? null : (Array.isArray(v) ? v.slice(0, 4) : v) }) },
        })
      } catch (_) {}
    }

    const r = window.__renderer
    if (r && r.shadowMap) {
      const dd = Object.getOwnPropertyDescriptor(r.shadowMap, 'needsUpdate')
      if (dd && !dd.get) {
        let nu = r.shadowMap.needsUpdate
        Object.defineProperty(r.shadowMap, 'needsUpdate', {
          configurable: true,
          get: () => nu,
          set: (v) => { nu = v; if (v) evt('shadowMap.needsUpdate=true', null) },
        })
      }
    }

    const list = []
    for (const rec of veg._meshes) {
      for (const api of [rec.branch, rec.leaf]) {
        if (api) list.push({ api, role: api === rec.branch ? 'branch' : 'leaf', name: rec.name || '' })
      }
    }
    try { if (veg.sharedImpostor) list.push({ api: veg.sharedImpostor, role: 'impostor', name: 'sharedImpostor' }) } catch (_) {}
    P.instancers = list

    // Hiding or detaching an ancestor blanks every foliage mesh under it in one write, so the
    // whole ancestor chain of one foliage mesh is trapped as well.
    try {
      let node = list.length ? (list[0].api.mesh || (list[0].api.isObject3D ? list[0].api : null)) : null
      let guard = 0
      while (node && guard++ < 32) {
        trapVisible(node, { role: 'ancestor', name: node.name || node.type || '' })
        node = node.parent
      }
    } catch (_) {}

    for (const it of list) {
      const api = it.api
      const tag = { role: it.role, name: it.name }
      trapVisible(api, tag)
      const mesh = api.mesh || (api.isObject3D ? api : null)
      if (mesh && mesh !== api) trapVisible(mesh, tag)

      if (typeof api.updateLOD === 'function') {
        const orig = api.updateLOD.bind(api)
        const sum = () => { const b = tierBands(api); if (!b) return NaN; let s = 0; for (let i = 0; i < b.length; i++) s += b[i]; return s }
        api.updateLOD = function () {
          P.stats.lodCalls++
          const b = sum()
          const out = orig.apply(null, arguments)
          const a = sum()
          if (b > 0 && a === 0) {
            const g = (function () { try { return api.sweepGrid } catch (_) { return null } })()
            evt('updateLOD-emptied-tiers', { ...tag, before: b, after: a, gridUsable: g && g.usable, gridCells: g && g.cells, gridInstances: g && g.instances })
          }
          return out
        }
      }
      if (typeof api.setMeshFarDistance === 'function') {
        const orig = api.setMeshFarDistance.bind(api)
        api.setMeshFarDistance = function (d) { evt('setMeshFarDistance', { ...tag, value: d }); return orig(d) }
      }
      if (typeof api.build === 'function') {
        const orig = api.build.bind(api)
        api.build = function (d) { evt('instancer-build', { ...tag, cap: d }); return orig(d) }
      }
      if (typeof api.rebuildGrid === 'function') {
        const orig = api.rebuildGrid.bind(api)
        api.rebuildGrid = function () { evt('rebuildGrid', tag); return orig() }
      }
    }

    if (typeof veg.applyOcclusion === 'function') {
      const o = veg.applyOcclusion.bind(veg)
      veg.applyOcclusion = function (keys) { evt('applyOcclusion', { occluded: keys && keys.size != null ? keys.size : null }); return o(keys) }
    }
    if (typeof veg.rebuildPlacement === 'function') {
      const o = veg.rebuildPlacement.bind(veg)
      veg.rebuildPlacement = function () { evt('rebuildPlacement', null); return o() }
    }
    collectDrawSet()
    return { ok: true, instancers: list.length, drawSet: P.drawSet.length, drawSetKind: P.drawSetKind }
  }

  P.start = function (label, pre, driverSrc, post) {
    if (P.running) return 'already-running'
    const total = pre + post
    const samples = []
    const mark = P.events.length
    let i = 0, changedAt = -1, driverOut = null
    P.result = null
    P.running = true
    P.active = true
    const tick = () => {
      P.frame = i
      const s = snapshot()
      s.i = i
      samples.push(s)
      if (i === pre - 1) {
        changedAt = i
        try { driverOut = String(new Function(driverSrc)()) } catch (e) { driverOut = 'threw: ' + String((e && e.message) || e) }
        P.changes.push({ f: i, label, out: driverOut })
      }
      i++
      if (i < total) requestAnimationFrame(tick)
      else {
        P.active = false
        P.running = false
        const all = P.events.slice(mark)
        const first = samples[0], last = samples[samples.length - 1]
        const sorted = samples.map(x => x.drawn).slice().sort((a, b) => a - b)
        let nonzero = 0
        for (let k = 0; k < samples.length; k++) if (samples[k].drawn > 0) nonzero++
        // "Foliage is in view" is a precondition of a disappearance: a window that drew nothing
        // all along (the walker left the vegetated area) has no disappearance to report, so its
        // zero frames are ignored rather than counted.
        const inView = nonzero * 2 >= samples.length && sorted[sorted.length >> 1] > 0
        const zero = []
        for (let k = 0; k < samples.length && inView; k++) {
          if (samples[k].drawn !== 0) continue
          let near = false
          for (let j = Math.max(0, k - 10); j <= Math.min(samples.length - 1, k + 10); j++) {
            if (j !== k && samples[j].drawn > 0) { near = true; break }
          }
          if (!near) continue
          // A frame that also reports zero instances system-wide is the disappearance the row
          // describes, not a reason to skip the frame, so it is counted and its total recorded.
          zero.push({
            i: k,
            dist: k - changedAt,
            total: samples[k].total,
            detached: samples[k].detached,
            bands: samples[k].bands,
            visibleMeshes: samples[k].visibleMeshes,
            events: all.filter(e => e.f === k || e.f === k - 1).slice(0, 12),
          })
        }
        let camChanges = 0
        for (let k = 1; k < samples.length; k++) if (samples[k].camKey !== samples[k - 1].camKey) camChanges++
        const lodCallsDelta = last.lodCalls - first.lodCalls
        let detachedMax = 0
        for (let k = 0; k < samples.length; k++) if (samples[k].detached > detachedMax) detachedMax = samples[k].detached
        const nearChange = all.filter(e => changedAt >= 0 && e.f >= changedAt - 2 && e.f <= changedAt + 6).slice(0, 40)
        P.result = {
          label, frames: samples.length, pre, post, changedAt, driverOut,
          drawnFirst: first.drawn, drawnLast: last.drawn, drawnMin: sorted[0], drawnMedian: sorted[sorted.length >> 1],
          visibleMeshesFirst: first.visibleMeshes, drawSetSize: P.drawSet.length, drawSetKind: P.drawSetKind,
          tieredInstancers: first.tieredInstancers, bandlessInstancers: first.bandlessInstancers,
          zeroFrames: zero, inView, nonzeroFrames: nonzero,
          dprConstant: first.dpr === last.dpr && first.cw === last.cw && first.ch === last.ch,
          dpr: first.dpr, canvas: [first.cw, first.ch],
          bandsFirst: first.bands, bandsLast: last.bands,
          camChanges, lodCallsDelta, detachedMax,
          eventsNearChange: nearChange,
        }
      }
    }
    requestAnimationFrame(tick)
    return 'started'
  }
})()`

const READY = () => {
  const a = window.__app || {}
  const veg = window.__veg
  return {
    prewarmed: performance.getEntriesByName('boot:foliage-prewarmed').length > 0,
    playable: a.revealedAt != null,
    vegInstances: veg ? veg.totalInstances : 0,
    vegMeshes: veg && veg._meshes ? veg._meshes.length : 0,
    hasRenderer: !!window.__renderer,
    hasQuality: !!window.__qualityPresets,
    hasControls: !!window.__renderControls,
    hasTod: !!window.__timeOfDayApi,
  }
}

// The changes the owner means: quality preset first, then render-control toggles,
// then time-of-day and an LOD transition.
// A render-control toggle driven the way the owner drives it: flip the live value through
// window.__renderControls.set. dprAuto is left alone (it rescales the device pixel ratio, which
// the fix is forbidden to touch) and vegAllOff / vegHideFar / vegLeafOff are left alone (they
// are documented kill switches, not the defect).
const toggleKnob = (k) => `const cur=window['__${k}']; const v=(typeof cur==='number'&&isFinite(cur))?(cur===0?1:cur*0.5):(cur?false:true); window.__renderControls.set('${k}', v); return JSON.stringify({from:cur,to:v})`

const ALL_DRIVERS = [
  { id: 'preset-Low', src: "window.__qualityPresets.setPreset('Low', { renderer: window.__renderer }); return 'ok'" },
  { id: 'preset-High', src: "window.__qualityPresets.setPreset('High', { renderer: window.__renderer }); return 'ok'" },
  { id: 'preset-Ultra', src: "window.__qualityPresets.setPreset('Ultra', { renderer: window.__renderer }); return 'ok'" },
  { id: 'knob-ssr', src: toggleKnob('ssr') },
  { id: 'knob-ssao', src: toggleKnob('ssao') },
  { id: 'knob-bloom', src: toggleKnob('bloom') },
  { id: 'knob-thc', src: toggleKnob('thc') },
  { id: 'knob-halfResWater', src: toggleKnob('halfResWater') },
  { id: 'knob-fogFar', src: toggleKnob('fogFar') },
  { id: 'knob-vegWind', src: toggleKnob('vegWind') },
  { id: 'knob-grassWind', src: toggleKnob('grassWind') },
  { id: 'knob-exposure', src: toggleKnob('toneMappingExposure') },
  { id: 'knob-maxLevel', src: toggleKnob('maxLevel') },
  { id: 'knob-splitFactor', src: toggleKnob('splitFactor') },
  { id: 'tod-19', src: "const a=window.__timeOfDayApi; if(!a) return 'no-tod-api'; const names=Object.keys(a).filter(k=>typeof a[k]==='function'); const skip=/length|scale|speed|rate|duration|offset|pause|enabled/i; const cands=names.filter(n=>/hour|timeofday|tod|time|day/i.test(n)&&!skip.test(n)); for(const n of cands){ try{ a[n](19); return 'called '+n }catch(e){ return 'threw '+n+': '+e.message } } return 'no-hour-method:'+names.join(',')" },
  { id: 'lod-30-all', src: "const m=window.__veg._meshes; if(!m.length) return 'no-meshes'; for(const r of m){ if(r.branch&&r.branch.setMeshFarDistance) r.branch.setMeshFarDistance(30); if(r.leaf&&r.leaf.setMeshFarDistance) r.leaf.setMeshFarDistance(30) } return 'ok'" },
  { id: 'lod-200-all', src: "const m=window.__veg._meshes; if(!m.length) return 'no-meshes'; for(const r of m){ if(r.branch&&r.branch.setMeshFarDistance) r.branch.setMeshFarDistance(200); if(r.leaf&&r.leaf.setMeshFarDistance) r.leaf.setMeshFarDistance(200) } return 'ok'" },
  { id: 'lod-30', src: "const m=window.__veg._meshes; if(!m.length) return 'no-meshes'; m[0].branch.setMeshFarDistance(30); return 'ok'" },
  { id: 'rebuild-placement', src: "const v=window.__veg; if(!v||typeof v.rebuildPlacement!=='function') return 'no-rebuildPlacement'; v.rebuildPlacement(); return 'ok'" },
]
const DRIVERS = DRIVER_FILTER
  ? ALL_DRIVERS.filter(d => String(DRIVER_FILTER).split(',').includes(d.id))
  : ALL_DRIVERS

// ---------------------------------------------------------------- main

async function main() {
  const freeGB = freemem() / 2 ** 30
  const totalGB = totalmem() / 2 ** 30
  console.log(`[${LABEL}] run=${RUN_ID} arm=${ARM} freeGB=${round(freeGB)} totalGB=${round(totalGB)} viewport=${VIEW_W}x${VIEW_H} gpu=${GPU_MODE} clientRoot=${CLIENT_ROOT} drivers=${DRIVERS.map(d => d.id).join(',')}`)
  expect(`free memory at run start >= ${MIN_FREE_GB} GB`, round(freeGB), '>=', MIN_FREE_GB)

  rebuildIfRequested(LABEL)
  // Perturb only after a requested rebuild, so a fresh stamp is what gets rewritten.
  if (FORCE_RAW_ESM) {
    stampBackup = perturbClientStamp()
    process.on('exit', restoreClientStamp)
  }
  resetScratch()
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'
  process.env.SPOINT_STATIC_CACHE_DIR = join(SCRATCH, 'static')

  console.log(`[${LABEL}] booting real server on port ${PORT} (world=${process.env.WORLD}) ...`)
  const { boot } = await import('../src/sdk/server.js')
  const { STATIC_CACHE_DIR } = await import('../src/sdk/StaticCache.js')
  if (STATIC_CACHE_DIR !== join(SCRATCH, 'static')) fail(`static cache resolved to ${STATIC_CACHE_DIR}, not the scratch dir`)
  const server = await boot({ storageDir: join(SCRATCH, 'data') })
  const base = `http://127.0.0.1:${PORT}`

  const ev = (expr) => `(() => { ${expr} })()`

  let browser = null
  const reports = []
  try {
    browser = await chromium.launch({ headless: false, args: vendorPinArgs(GPU_MODE) })
    for (const params of PARAMS) {
      const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
      const pageErrors = []
      page.on('pageerror', e => pageErrors.push(String(e)))
      await page._send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE_INIT })
      await page.goto(`${base}/?${params}`, { waitUntil: 'domcontentloaded' })

      const root = await assertServedClientRoot(page, { want: WANT_ROOT, label: LABEL }).catch(e => e)
      if (root instanceof Error) fail(root.message)
      if (MODULE_MARKER) {
        // Read from node rather than from inside the page: it is the same served bytes, and a page
        // side fetch would depend on how this witness wraps an in-page body.
        const mPath = MARKER_PATH || (root.kind === CLIENT_ROOT_BUNDLE ? '/app.js' : '/core/Vegetation.js')
        const res = await globalThis.fetch(`${base}${mPath}`, { cache: 'no-store' }).catch(() => null)
        const t = res ? await res.text().catch(() => '') : ''
        const hit = { status: res ? res.status : 0, bytes: t.length, found: t.indexOf(MODULE_MARKER) >= 0 }
        console.log(`[${LABEL}] params=${params} marker check path=${mPath} status=${hit.status} bytes=${hit.bytes} found=${hit.found}`)
        if (!hit.found) fail(`params=${params}: served client root ${root.kind} does not carry marker ${JSON.stringify(MODULE_MARKER)} at ${mPath} (status=${hit.status} bytes=${hit.bytes}): the page is not running the change under test`)
      }
      const gpu = await witnessGpu(page, GPU_MODE)

      const t0 = Date.now()
      let ready = null
      while (Date.now() - t0 < READY_TIMEOUT_MS) {
        ready = await page.evaluate(READY).catch(() => null)
        if (ready && ready.prewarmed && ready.playable && ready.vegInstances > 0 && ready.vegMeshes > 0 && ready.hasRenderer && ready.hasQuality && ready.hasControls) break
        await new Promise(r => setTimeout(r, 400))
      }
      if (!ready || !(ready.prewarmed && ready.playable && ready.vegInstances > 0 && ready.vegMeshes > 0 && ready.hasRenderer && ready.hasQuality && ready.hasControls)) {
        fail(`params=${params}: never reached a playable page with live foliage in ${READY_TIMEOUT_MS}ms (ready=${jsonLine(ready)} pageErrors=${pageErrors.length}${pageErrors[0] ? ': ' + pageErrors[0].slice(0, 200) : ''})`)
      }
      if (SETTLE_MS > 0) await page.waitForTimeout(SETTLE_MS)

      const installed = await page.evaluate(ev('return window.__vegVanishFrameProbe.install()'))
      if (!installed.ok) fail(`params=${params}: probe install failed: ${installed.why}`)
      console.log(`[${LABEL}] params=${params} clientRoot=${clientRootTag(root)} adapter=${gpu.renderer || gpu.adapter || 'unknown'} instancers=${installed.instancers} drawSet=${installed.drawSet}(${installed.drawSetKind}) vegInstances=${ready.vegInstances} tod=${ready.hasTod}`)
      expect(`params=${params} probe found a foliage draw set`, installed.drawSet, '>', 0)

      const base0 = await page.evaluate(ev('return window.__vegVanishFrameProbe.snapshot()'))
      console.log(`[${LABEL}] params=${params} baseline drawn=${base0.drawn} visibleMeshes=${base0.visibleMeshes} total=${base0.total} bands=${jsonLine(base0.bands)} tiered=${base0.tieredInstancers}/${base0.tieredInstancers + base0.bandlessInstancers} dpr=${base0.dpr} canvas=${base0.cw}x${base0.ch}`)
      expect(`params=${params} foliage drawn before any change`, base0.drawn, '>', 0)

      const caps = []
      // Real user input: CDP key events reach the app input bucket, so the walker moves.
      const key = (type) => page._send('Input.dispatchKeyEvent', {
        type, code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87,
      }).catch(() => null)
      const CX = VIEW_W >> 1, CY = VIEW_H >> 1
      const mouse = (type, x, y) => page._send('Input.dispatchMouseEvent', {
        type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
      }).catch(() => null)
      // --look=1 keeps the view turning during each capture: updateLOD sweeps only when the
      // eye moved or the view changed, so a still page never exercises the LOD transition
      // that the change kicks off.
      let lookX = CX
      let pump = null
      const startPump = () => { if (LOOK && !pump) pump = setInterval(() => { lookX = CX + (((lookX - CX) + 12 + 240) % 480) - 240; mouse('mouseMoved', lookX, CY) }, 25) }
      const stopPump = () => { if (pump) { clearInterval(pump); pump = null } }
      // The app binds mouse look only while pointer-locked, and a CDP click is a real
      // gesture, so the click on the canvas is what makes the view move at all. A capture
      // can drop the lock, so it is re-taken before any capture that would run unlocked.
      const relock = async () => {
        await mouse('mousePressed', CX, CY)
        await mouse('mouseReleased', CX, CY)
        await page.waitForTimeout(200)
        return page.evaluate(ev('return !!document.pointerLockElement')).catch(() => 'unknown')
      }
      let locked = null
      if (LOOK || WALK) {
        locked = await relock()
        console.log(`[${LABEL}] params=${params} pointerLock=${locked}`)
      }
      for (const d of DRIVERS) {
        if (LOOK && locked !== true) locked = await relock()
        if (WALK) await key('keyDown')
        startPump()
        const started = await page.evaluate(ev(
          `return window.__vegVanishFrameProbe.start(${JSON.stringify(d.id)}, ${PRE_FRAMES}, ${JSON.stringify(d.src)}, ${POST_FRAMES})`,
        )).catch(e => 'threw: ' + String((e && e.message) || e))
        if (started !== 'started') {
          if (WALK) await key('keyUp')
          stopPump()
          console.log(`[${LABEL}] params=${params} cap ${d.id}: ERROR ${String(started)}`)
          caps.push({ label: d.id, error: String(started) }); continue
        }
        const ct = Date.now()
        let res = null
        while (Date.now() - ct < CAPTURE_TIMEOUT_MS) {
          await new Promise(r => setTimeout(r, 250))
          res = await page.evaluate(ev('return window.__vegVanishFrameProbe.result')).catch(() => null)
          if (res) break
        }
        if (WALK) await key('keyUp')
        stopPump()
        if (!res) {
          console.log(`[${LABEL}] params=${params} cap ${d.id}: ERROR capture did not finish in ${CAPTURE_TIMEOUT_MS}ms`)
          caps.push({ label: d.id, error: `capture did not finish in ${CAPTURE_TIMEOUT_MS}ms` }); continue
        }
        res.params = params
        caps.push(res)
        console.log(`[${LABEL}] params=${params} cap ${d.id}: frames=${res.frames} drawnFirst=${res.drawnFirst} drawnLast=${res.drawnLast} drawnMin=${res.drawnMin} drawnMedian=${res.drawnMedian} visMeshes=${res.visibleMeshesFirst}/${res.drawSetSize} zeroFrames=${res.zeroFrames.length} driverOut=${res.driverOut} dprConstant=${res.dprConstant} bands=${jsonLine(res.bandsLast)} camChanges=${res.camChanges} lodCalls=${res.lodCallsDelta} detached=${res.detachedMax} inView=${res.inView} nonzero=${res.nonzeroFrames} locked=${locked}`)
        for (const z of res.zeroFrames.slice(0, 6)) {
          console.log(`[${LABEL}] params=${params} ZERO ${d.id} frame ${z.i} (+${z.dist} from change) total=${z.total} detached=${z.detached} visMeshes=${z.visibleMeshes} bands=${jsonLine(z.bands)}`)
          for (const e of (z.events || []).slice(0, 8)) console.log(`[${LABEL}] params=${params} ZERO-SITE ${d.id} f=${e.f} ${e.kind} ${jsonLine(e.detail)} at ${(e.at || []).join(' <- ')}`)
        }
        for (const e of (res.eventsNearChange || []).slice(0, 14)) {
          console.log(`[${LABEL}] params=${params} near ${d.id} f=${e.f} ${e.kind} ${e.at && e.at[0] ? e.at[0] : ''} ${jsonLine(e.detail)}`)
        }
      }
      reports.push({ params, gpu: gpu.renderer || gpu.adapter || null, clientRoot: clientRootTag(root), baseline: base0, caps, pageErrors })

      const vanished = caps.filter(c => c.zeroFrames && c.zeroFrames.length > 0)
      expect(`params=${params} zero-foliage frames reproduced (arm=${ARM})`, vanished.length, '>=', EXPECT_ZERO)
      expect(`params=${params} zero-foliage frames remaining (arm=${ARM})`, vanished.length, '<=', MAX_ZERO)
      expect(`params=${params} every capture reached ${PRE_FRAMES + POST_FRAMES} frames`, caps.every(c => c.frames >= PRE_FRAMES + POST_FRAMES) ? 1 : 0, '==', 1)
      expect(`params=${params} dpr and canvas unchanged across every change`, caps.every(c => c.dprConstant === true) ? 1 : 0, '==', 1)
      // A capture where LOD never re-evaluated proves nothing: updateLOD returns early on a
      // still page, so no sweep and no LOD transition happened around the change at all.
      expect(`params=${params} LOD re-evaluated during every capture`, caps.every(c => c.lodCallsDelta > 0) ? 1 : 0, '==', 1)
      // A capture that lost foliage for good (the walker left the vegetated area) cannot show a
      // disappearance, so it fails the run instead of passing it vacuously.
      expect(`params=${params} every capture kept foliage in view`, caps.every(c => c.inView === true) ? 1 : 0, '==', 1)
      expect(`params=${params} uncaught page errors`, pageErrors.length, '==', 0)
      await page.close().catch(() => {})
    }
    await browser.close().catch(() => {})
    browser = null
    server.stop()
    restoreClientStamp()
  } catch (e) {
    if (browser) await browser.close().catch(() => {})
    server.stop()
    restoreClientStamp()
    throw e
  }

  const totalZero = reports.reduce((s, r) => s + r.caps.reduce((t, c) => t + (c.zeroFrames ? c.zeroFrames.length : 0), 0), 0)
  const named = []
  for (const r of reports) for (const c of r.caps) for (const z of (c.zeroFrames || [])) for (const e of (z.events || [])) if (e.at && e.at[0]) named.push(`${c.label}@${z.i}: ${e.kind} ${e.at[0]}`)
  console.log(`[${LABEL}] summary arm=${ARM} run=${RUN_ID} totalZeroFrames=${totalZero}`)
  for (const n of [...new Set(named)].slice(0, 40)) console.log(`[${LABEL}] named ${n}`)

  for (const c of checks) console.log(`[${LABEL}] ${c.pass ? 'check PASS' : 'check FAIL'} ${c.label}: got ${jsonLine(c.got)} expected ${c.op} ${jsonLine(c.want)}`)
  const failed = checks.filter(c => !c.pass)
  if (failed.length) finish('FAIL', `${failed.length} of ${checks.length} check(s) failed: ${failed.map(c => `${c.label} got ${jsonLine(c.got)} expected ${c.op} ${jsonLine(c.want)}`).join('; ')}`)
  finish('PASS', `${checks.length}/${checks.length} checks passed run=${RUN_ID} arm=${ARM} totalZeroFrames=${totalZero} named=${[...new Set(named)].slice(0, 3).join(' | ') || 'none'}`)
}

main().catch(e => {
  console.error(e && e.stack ? e.stack : e)
  finish('FAIL', `run threw: ${e && e.message ? e.message : e}`)
})
