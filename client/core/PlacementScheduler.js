// PlacementScheduler -- decouples vegetation/rock/grass instance PLACEMENT (deciding what to
// stream in/out, computing LOD, writing InstancedMesh2 instance transforms) from
// requestAnimationFrame, so a backgrounded/minimized client tab keeps building its own world.
//
// Root cause (webgpu-veg-placement-decouple-from-raf-for-backgrounded-tab): renderer.setAnimationLoop
// fully halts when a tab is OS-backgrounded (document.visibilityState:"hidden") -- proven via a live
// rAF-counter probe staying at literal 0 across multi-minute windows, not merely throttled. Because
// vegetation.update()/rocks.update()/grass.update() were only ever called from the 'foliage-lod-sync'
// RenderGraph node inside that rAF-gated loop (RenderGraph.nodes.js), a backgrounded tab never placed
// a single tree/rock/blade even though its WebSocket connection, snapshot decode, and terrain height
// data all kept arriving fine (those paths are async/promise-driven, not rAF-gated). Any real player
// who alt-tabs away or has the tab backgrounded by the OS (common on laptops/mobile) would see their
// own world's vegetation/rocks silently stop streaming in until they refocus.
//
// Fix shape: the placement-DECISION logic (this module's runPlacementTick) does not need to be
// synchronized with a paint frame -- only the actual GPU draw call does (that stays exactly where it
// is, a RenderGraph node -- project/render-graph-live-orchestrator: new rendering passes must be
// nodes, never inline animate() steps). This module owns a setInterval loop (mirroring
// TickSystem.js's own render-independent server-side tick -- setInterval+performance.now, no rAF)
// that calls the SAME vegetation/rocks/grass.update(dt,camera,playerPos[,extra]) functions
// RenderGraph.nodes.js's 'foliage-lod-sync' node already calls, via one shared runPlacementTick()
// so there is exactly one placement-decision code path, not two divergent copies.
//
// Double-tick guard: when the tab is FOREGROUND, both the rAF-paced RenderGraph node AND this
// interval fire -- runPlacementTick is idempotent-per-call (each update() call is itself an
// idempotent "reconcile against current camera position" step, matching Vegetation.js's own
// _lastPx/_lastPz still-camera dedup), but calling it twice inside the same wall-clock instant would
// double-count dt for wind/animation-time uniforms and double the streamRing scan cost for zero
// placement benefit. Fix: a single shared `_lastTickAtMs` timestamp both callers check/update via
// `shouldTick(nowMs, minIntervalMs)` -- whichever caller (rAF node or interval) reaches a given
// instant first wins that tick; the other's call in the same window becomes a no-op. This makes the
// foreground path's real per-frame behavior UNCHANGED in practice (rAF ticks every ~16ms, far above
// the interval's own throttle) while guaranteeing the interval is the sole driver the instant rAF
// stops firing.
//
// Cost note: computing what to stream (chunk-ring scan, LOD bucket assignment) is cheap CPU work
// (Vegetation.js's own IDLE_STRIDE stride-skip already exists for exactly this reason); it is the
// GPU draw call that is expensive and rAF-gated correctly. This scheduler intentionally runs at a
// slower cadence than 60fps (see PLACEMENT_INTERVAL_MS) since a backgrounded tab has no visible
// frame to keep in sync with -- streaming progress, not frame-perfect LOD, is the goal while hidden.

import * as THREE from 'three'

const PLACEMENT_INTERVAL_MS = 250   // background cadence; foreground rAF (~16ms) always wins the shouldTick race while visible
const MIN_TICK_GAP_MS = 40          // hard floor between real placement ticks regardless of caller, so a busy rAF frame can't starve dt-accounting into a near-zero-dt spam even when both drivers race the same instant

const _authFocus = { x: 0, y: 0, z: 0 }

// ---- shared scenery-streaming helpers (Vegetation.js / Rocks.js / Grass.js import these) ----------

// Spiral chunk-offset table for a ring of `span` chunks: every (dx,dz) within `span`, nearest-first.
// One builder for all three scenery streamers (was three byte-identical private copies). Must be
// bounded/terminating (a prior manual spiral never terminated and OOM'd the tab).
export function spiralOffsets(span) {
  const out = []
  for (let dz = -span; dz <= span; dz++) for (let dx = -span; dx <= span; dx++) if (Math.hypot(dx, dz) <= span) out.push([dx, dz])
  out.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]))
  return out
}

// Integer chunk key: (cx,cz) packed into one safe integer, unique for |cx|,|cz| < 32768 (a 32m chunk
// grid spanning +-1048km, far past any streamed ring). Replaces `cx + ',' + cz` string keys that were
// built (and re-parsed with indexOf/slice) on every streaming tick.
export function chunkKey(cx, cz) {
  return ((cx + 32768) & 0xffff) * 65536 + ((cz + 32768) & 0xffff)
}

// Resolves the camera's world position + orientation ONCE per tick/frame into a plain pose record
// {x,y,z,qx,qy,qz,qw} so Vegetation/Rocks/Grass never each re-run camera.getWorldPosition/
// getWorldQuaternion (each a full matrixWorld decompose) inside their own still-camera checks.
const _poseV = new THREE.Vector3(), _poseQ = new THREE.Quaternion()
export function resolveCameraPose(camera, out) {
  out = out || { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
  camera.getWorldPosition(_poseV); camera.getWorldQuaternion(_poseQ)
  out.x = _poseV.x; out.y = _poseV.y; out.z = _poseV.z
  out.qx = _poseQ.x; out.qy = _poseQ.y; out.qz = _poseQ.z; out.qw = _poseQ.w
  return out
}
const _tickPose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }

export function createPlacementScheduler(getHandles) {
  let _lastTickAtMs = -Infinity
  let _timer = null
  let _lastRealMs = null

  function shouldTick(nowMs) {
    if (nowMs - _lastTickAtMs < MIN_TICK_GAP_MS) return false
    _lastTickAtMs = nowMs
    return true
  }

  // runPlacementTick(nowMs) -- the single shared placement-decision body, callable from either the
  // rAF-paced RenderGraph node or this module's own background setInterval. Returns true if it
  // actually ran (false if the double-tick guard skipped it, e.g. rAF already ticked this instant).
  function runPlacementTick(nowMs) {
    if (!shouldTick(nowMs)) return false
    const h = getHandles()
    if (!h) return false
    const { vegetation, rocks, grass, camera, floatingOrigin, pm } = h
    if (!camera || !(vegetation || rocks || grass)) return false

    const dt = _lastRealMs == null ? 0 : Math.min(Math.max((nowMs - _lastRealMs) / 1000, 0.001), 1.0)
    _lastRealMs = nowMs

    let focus = camera.position
    if (floatingOrigin) {
      focus = floatingOrigin.toAuthoritative(
        focus.position ? { x: focus.position[0], y: focus.position[1], z: focus.position[2] } : focus,
        _authFocus,
      )
    }

    // Streaming-only ticks: the per-frame visibility half (still-camera cull freeze, chunk frustum
    // cull) is driven by RenderGraph.nodes.js's foliage-lod-sync every rendered frame; a backgrounded
    // tab has no frame to keep it in sync with, and any instance mutation made here is picked up by
    // the next foreground updateVisibility() call through each system's own mutation flag.
    const pose = resolveCameraPose(camera, _tickPose)
    if (vegetation) {
      try { if (typeof vegetation.updateStreaming === 'function') vegetation.updateStreaming(dt, camera, focus, pose); else if (typeof vegetation.update === 'function') vegetation.update(dt, camera, focus, true) } catch (_) {}
    }
    if (rocks) {
      try { if (typeof rocks.updateStreaming === 'function') rocks.updateStreaming(dt, camera, focus, pose); else if (typeof rocks.update === 'function') rocks.update(dt, camera, focus) } catch (_) {}
    }
    if (grass) {
      // Background ticks skip the nearby-player bend-buffer computation (a rendering-feel detail,
      // not a placement decision) -- an empty array is the same "no benders this call" shape
      // RenderGraph.nodes.js's own foliage-lod-sync passes when ctx.pm has zero playerMeshes.
      try { if (typeof grass.updateStreaming === 'function') grass.updateStreaming(dt, camera, focus, _EMPTY_BENDERS, pose); else if (typeof grass.update === 'function') grass.update(dt, camera, focus, _EMPTY_BENDERS) } catch (_) {}
    }
    return true
  }

  function start() {
    if (_timer != null) return
    _timer = setInterval(() => {
      const now = (typeof performance !== 'undefined') ? performance.now() : Date.now()
      runPlacementTick(now)
    }, PLACEMENT_INTERVAL_MS)
    // Node's setInterval returns a Timeout object with unref(); browsers return a plain number with
    // no unref -- guard so this never throws in either environment (this module is browser-only in
    // practice, but stays defensive since it has no other environment guard of its own).
    if (_timer && typeof _timer.unref === 'function') _timer.unref()
  }

  function stop() {
    if (_timer != null) { clearInterval(_timer); _timer = null }
  }

  return { start, stop, runPlacementTick, shouldTick }
}

const _EMPTY_BENDERS = []

if (typeof window !== 'undefined') {
  window.__placementScheduler = { create: createPlacementScheduler }
}
