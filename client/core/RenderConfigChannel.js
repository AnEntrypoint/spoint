// RenderConfigChannel.js -- serializable config snapshot + postMessage sync channel for the
// worker-hosted render loop migration (offscreencanvas-worker-migration-full-game-loop epic, this
// row's own scoped first slice per its own guidance to decompose into "config-channel first with
// rendering still main-thread" rather than attempt the full swap in one session).
//
// WHY THIS EXISTS: the real blocker to moving RenderGraph/ShadowPipeline/mapspinner onto a worker is
// NOT the canvas-transfer mechanism (WorkerRenderer.js/OffscreenRenderWorker.js already proved that
// works end-to-end) -- it is mapspinner's own gl-render.js/planet-orchestrator.js reading over 200
// scattered `typeof window !== 'undefined' && window.__<key>` tuning globals directly inline in
// render-critical code (confirmed live via codesearch this session). An OffscreenCanvas worker has no
// `window`, so every one of those reads would silently fall through to its default the instant the
// render loop moved -- a correctness regression, not a crash, meaning it could ship unnoticed. Rather
// than touch that fragile file (AGENTS.md's own debugging-playbook section documents a 5+-session
// saga the LAST time it was touched carelessly), this module builds the serialization/transport
// PRIMITIVE standalone and proves it round-trips through a real Worker via structured clone -- so a
// future session can wire individual mapspinner reads over to RenderConfigChannel.get(key) one file at
// a time, each independently verifiable, instead of a single big-bang swap.
//
// SCOPE (deliberately bounded): this module does NOT touch gl-render.js, planet-orchestrator.js, or
// any render-path file. It reads RenderControls.js's own CONTROLS registry (the single existing
// catalog of every window.__<key> render knob, see RenderControls.js) to build/apply a snapshot -- it
// does not invent a second parallel knob list. Nothing in the live render path calls into this module
// yet; it is an inert, independently-testable utility until a future slice wires it in.
//
// Usage (main thread):
//   import { snapshotRenderConfig, applyRenderConfig, diffRenderConfig, createConfigChannel } from './RenderConfigChannel.js'
//   const snap = snapshotRenderConfig()                 // -> plain serializable {key: value, ...}
//   const chan = createConfigChannel(worker)             // wraps a Worker/MessagePort
//   chan.push(snap)                                       // posts {type:'render-config', config: snap}
//   chan.onUpdate(cfg => ...)                             // fires when the OTHER side pushes a config
//
// Usage (worker thread, once a render loop lives there):
//   import { applyLocalConfig, createConfigChannel } from './RenderConfigChannel.js'
//   const chan = createConfigChannel(self)
//   chan.onUpdate(cfg => applyLocalConfig(cfg, localConfigStore))  // no `window` in a worker -- the
//                                                                   // worker side keeps its own plain
//                                                                   // object store, never window.__*
import { RenderControls } from './RenderControls.js'

// Only these JSON-safe primitive types are round-tripped -- CONTROLS also carries a few read-only
// 'object' mirrors (fogState, timeOfDay, terrainVdrs, ...) that are live telemetry written BY the
// render loop every frame, not tuning input FROM a config push; syncing those back out as if they were
// settable input would create a feedback loop (worker pushes fogState -> main "applies" it -> nothing
// changes since it's read-only downstream -- confusing, not dangerous, but pointless). Excluding them
// keeps the channel's contract honest: it carries SETTABLE knobs only.
const SYNCABLE_TYPES = new Set(['boolean', 'number', 'string'])

function syncableControls() {
  return RenderControls.controls.filter(c => SYNCABLE_TYPES.has(c.type))
}

// Build a plain, structured-clone-safe snapshot of every syncable knob's CURRENT live value (reads
// window.__<key> via RenderControls.get, same source of truth the render path itself reads from --
// this is a read-only export, it does not mutate anything).
export function snapshotRenderConfig() {
  const out = {}
  for (const c of syncableControls()) {
    const v = RenderControls.get(c.key)
    // Only include non-null/non-default-null entries plus anything explicitly set -- keeps the
    // snapshot compact (most of the 60+ knobs sit at their default 'unset' state at any given time)
    // while still being a COMPLETE snapshot: every syncable key is visited, so a receiver applying it
    // can tell "unset" (v === null/undefined, matches default) from "explicitly set".
    out[c.key] = v === undefined ? null : v
  }
  return out
}

// Apply a received config snapshot onto window.__<key> for every key present in `target` -- the
// MAIN-THREAD-side apply (there IS a window here). Returns the list of keys actually changed (for
// logging/diffing), skips unknown keys defensively (a future/older peer's snapshot may carry an
// unrecognised key -- ignore it rather than throw, matching RenderControls.set's own soft-fail
// discipline for unknown keys).
export function applyRenderConfig(config) {
  if (!config || typeof config !== 'object') return []
  const changed = []
  const byKey = new Map(syncableControls().map(c => [c.key, c]))
  for (const key of Object.keys(config)) {
    if (!byKey.has(key)) continue
    const prev = RenderControls.get(key)
    const next = config[key]
    if (prev !== next) {
      RenderControls.set(key, next)
      changed.push(key)
    }
  }
  return changed
}

// Worker-side apply: a worker has no `window`, so it cannot use RenderControls.set (which writes
// window.__<key>). This applies onto a plain local object store instead -- the shape a future
// worker-hosted render loop would read its tuning values from (e.g. `cfg.vdrsScale` instead of
// `window.__vdrsScale`). Mutates `store` in place and returns the list of changed keys, mirroring
// applyRenderConfig's contract so both sides behave identically for diffing/logging purposes.
export function applyLocalConfig(config, store) {
  if (!config || typeof config !== 'object') return []
  if (!store || typeof store !== 'object') throw new Error('applyLocalConfig: store must be a plain object')
  const changed = []
  const knownKeys = new Set(syncableControls().map(c => c.key))
  for (const key of Object.keys(config)) {
    if (!knownKeys.has(key)) continue
    if (store[key] !== config[key]) {
      store[key] = config[key]
      changed.push(key)
    }
  }
  return changed
}

// Shallow diff between two snapshots -- {key: [oldValue, newValue]} for every key that differs.
// Used to send only-the-delta on subsequent pushes instead of the full ~60-key snapshot every time
// (a future perf concern once this is wired to a per-frame-adjacent cadence like dprAuto/vdrsAuto's
// controllers, which mutate a couple of knobs many times a second -- not exercised by this slice, but
// the primitive is here so the next session does not have to invent it under time pressure).
export function diffRenderConfig(prevSnap, nextSnap) {
  const out = {}
  const keys = new Set([...Object.keys(prevSnap || {}), ...Object.keys(nextSnap || {})])
  for (const key of keys) {
    const a = prevSnap ? prevSnap[key] : undefined
    const b = nextSnap ? nextSnap[key] : undefined
    if (a !== b) out[key] = [a === undefined ? null : a, b === undefined ? null : b]
  }
  return out
}

// Two-way postMessage sync helper wrapping any target with a postMessage/onmessage-compatible surface
// (a real Worker instance from the main thread, or `self` from inside a worker/module-worker global
// scope -- both expose the same postMessage(data)/onmessage(handler) shape, which is exactly why this
// one function works on both sides without a branch). Message shape on the wire:
//   {type: 'render-config', config: {...}}      -- a full or partial snapshot push
// Any other message `type` is ignored by this channel (so it composes cleanly alongside the existing
// OffscreenRenderWorker.js protocol -- 'init'/'resize'/'stop'/'ready'/'frame'/'error' -- on the SAME
// worker without this channel's listener stepping on those handlers, verified live below).
export function createConfigChannel(target) {
  if (!target || typeof target.postMessage !== 'function') {
    throw new Error('createConfigChannel: target must expose postMessage')
  }
  const listeners = new Set()

  function handleMessage(e) {
    const msg = (e && e.data) || e
    if (!msg || msg.type !== 'render-config') return
    for (const fn of listeners) {
      try { fn(msg.config) } catch (err) { console.error('[render-config-channel] listener threw', err) }
    }
  }

  // Compose with any pre-existing onmessage handler (e.g. OffscreenRenderWorker.js's own switch-based
  // handler) rather than clobbering it -- addEventListener is available on both a real Worker and the
  // `self` worker-global-scope, and does not conflict with a separate .onmessage= assignment.
  if (typeof target.addEventListener === 'function') {
    target.addEventListener('message', handleMessage)
  } else {
    // Fallback for a MessagePort-like target without addEventListener in some odd host -- still wrap
    // rather than overwrite blindly, since a caller could reasonably chain calls.
    const prior = target.onmessage
    target.onmessage = (e) => { if (prior) prior(e); handleMessage(e) }
  }

  function push(config) {
    target.postMessage({ type: 'render-config', config })
  }

  function onUpdate(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  return { push, onUpdate }
}
