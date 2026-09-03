// Floating-origin / camera-relative rendering for planetary scale.
//
// PROBLEM: every render-space THREE object in this client (camera, player/entity groups added
// directly under `scene` by SceneGraph.js, ModelPool roots, gizmos, colliderDebug wireframes) is
// positioned with the SAME raw local-frame x/y/z spoint's server/physics/mapspinner use (see
// PlanetFrame.js's localToWorld / groundHeightLocal, fed camera.position/mesh.position directly --
// AGENTS.md floating-origin-camera-relative-rendering row). That local frame is planet-scale (whole-
// planet GPU-patch collider, see AGENTS.md project/gpu-patch-whole-planet-collider): a player or the
// editor fly-cam can walk/fly arbitrarily far from (0,0,0) in local-frame meters. THREE stores
// Vector3 components as JS float64, but the GPU-side data derived from them every frame --
// matrixWorld, vertex positions transformed by it, camera-relative view-space math inside every
// shader -- is float32. Float32 has ~7 decimal digits of precision; past roughly 8-16km from the
// coordinate origin, sub-centimeter jitter starts showing up in vertex positions (visible as
// swimming/popping geometry), and it gets steadily worse with distance. At the ~10km mark this is
// the standard "floating origin" problem in any engine built over a big/planetary world.
//
// FIX: track a persistent origin SHIFT (in local-frame meters) and rebase every frame so the render
// graph's coordinate origin stays glued near the camera. Camera.position is kept close to (0,0,0)
// (never itself accumulates float32 error) the instant the camera's authoritative (true, unbounded)
// local-frame position drifts past REBASE_THRESHOLD_M from the last rebase point, by (a) setting
// camera.position directly to (0,0,0) -- exact by construction, since shift is set to the camera's
// own just-received authoritative position on rebase -- and (b) translating every OTHER render-space
// scene-graph object by -delta so it stays in the same place relative to the new origin. Camera gets
// a direct SET, not the same `+= -delta` every other object gets, because camera.position is rewritten
// from a fresh raw authoritative value every single frame by the caller (app.js's camera-input-update
// render-graph node) immediately before calling update() -- `+= -delta` would apply the delta on top
// of that already-authoritative value instead of the STALE render-space value it needs to be correct.
// A uniform translation of every object (including the camera) changes nothing about their RELATIVE
// positions -- everything that only ever compares mesh positions to each other or to camera.position
// (LOD distance checks, culling, raycasts, shadow follow, vegetation/rocks/grass focus) is unaffected;
// this file's only externally-visible effect is keeping those numbers small.
//
// THE ONE REAL BOUNDARY: mapspinner's raw-GL planet renderer (TerrainBackdrop.js's renderPlanet) and
// every "sample the ground at this local x/z" call (groundHeightLocal, used by Vegetation/Rocks/
// Grass/ColliderDebug/the editor fly-cam's altitude speed multiplier) need the AUTHORITATIVE
// (unshifted) local-frame coordinate, not the rebased render-space one -- PlanetFrame.js's
// localToWorld projects local x/z onto the actual planet surface, so feeding it a rebased (near-zero)
// coordinate would sample the wrong point on the planet entirely. toAuthoritative()/fromRender() below
// convert a render-space THREE position back to the true local-frame coordinate by adding the
// current shift back in -- callers that need "where is this render-space thing in the REAL world"
// (mapspinner, terrain height sampling) use it; everything else keeps reading camera.position/
// mesh.position untouched exactly as before.
import * as THREE from 'three'

// 8km: comfortably inside float32's clean-precision range (round-trip error is sub-millimeter well
// past 10km, but the AGENTS.md brief calls out ~10km as where it starts, so this rebases with margin
// well before any visible artifact could occur) while still infrequent (a player sprinting at 10m/s
// would take ~13 minutes between rebases).
export const REBASE_THRESHOLD_M = 8000

export function createFloatingOrigin(scene, camera) {
  // _shift = the value CURRENTLY SUBTRACTED from every authoritative local-frame coordinate to get
  // its render-space position: render = authoritative - shift. Starts at zero (render space ==
  // authoritative space until the first rebase).
  const _shift = new THREE.Vector3(0, 0, 0)
  // Authoritative camera position, tracked independently of camera.position (which is rebased to
  // near-zero and therefore NOT a reliable running total on its own). Set directly from update()'s
  // own input every call, so it is exact regardless of how camera.position itself is rebased.
  const _authCam = new THREE.Vector3(0, 0, 0)
  let _initialized = false
  let _rebaseCount = 0
  let _lastDelta = new THREE.Vector3(0, 0, 0)
  const _listeners = new Set()

  // Called once per frame with the camera's CURRENT authoritative local-frame position (whatever
  // last set camera.position this frame -- gameplay follow-cam, editor fly-cam, spectate orbit, VR --
  // all already write real local-frame meters into camera.position, same as every other consumer in
  // this codebase; see camera.js/app.js). On the very first call this just anchors _authCam with zero
  // shift (nothing to rebase yet, camera.position is left exactly as the caller set it).
  function update(authoritativeX, authoritativeY, authoritativeZ) {
    _authCam.set(authoritativeX, authoritativeY, authoritativeZ)
    if (!_initialized) {
      _initialized = true
      _lastDelta.set(0, 0, 0)
      return false
    }
    // Render-space camera position implied by the current shift: renderX = authX - shift.x. If the
    // camera (in render space) has drifted past the threshold from the origin, rebase.
    const rx = authoritativeX - _shift.x, ry = authoritativeY - _shift.y, rz = authoritativeZ - _shift.z
    const d2 = rx * rx + ry * ry + rz * rz
    if (d2 < REBASE_THRESHOLD_M * REBASE_THRESHOLD_M) { _lastDelta.set(0, 0, 0); return false }
    // Rebase: shift becomes the camera's authoritative position (render-space camera position drops
    // to exactly zero); delta is how much every render-space object must move to stay in the same
    // place relative to the new origin.
    const deltaX = rx, deltaY = ry, deltaZ = rz
    _shift.set(authoritativeX, authoritativeY, authoritativeZ)
    // camera.position is NOT translated by -delta like every other scene-graph object: it is
    // re-derived DIRECTLY from the just-received authoritativeX/Y/Z (== authoritative - newShift,
    // always exactly 0 the instant of rebase) instead of `+= -delta`. This is deliberately
    // different from scene.children's `+=`, and required, not optional -- every real call site
    // (app.js's camera-input-update render-graph node) writes a FRESH raw authoritative local-
    // frame position into camera.position every single frame, immediately before calling update()
    // with that same camera.position -- so by the time this function runs, camera.position ALREADY
    // holds the NEW authoritative value, not the prior frame's render-space one that `+= -delta`
    // would need to be correct. Applying `+= -delta` to an already-authoritative camera.position
    // computed the wrong result (authoritative - delta = authoritative - (authoritative - oldShift)
    // = oldShift, not the intended authoritative - newShift = 0) and, live-witnessed via a 100km
    // floating-origin-jitter-test-100km-physics-audio-particles-shadow browser dispatch, left the
    // camera drifting back toward raw (unbounded) authoritative coordinates after every rebase --
    // the exact float32-precision-loss failure floating origin exists to prevent, fully defeating
    // it well before 100km (observed camera render-space distance from origin growing unboundedly,
    // reaching ~88km after 12 rebases in a 100km straight-line traversal, instead of staying near 0).
    camera.position.set(0, 0, 0)
    _translateChildren(scene, camera, -deltaX, -deltaY, -deltaZ)
    _lastDelta.set(-deltaX, -deltaY, -deltaZ)
    _rebaseCount++
    for (const fn of _listeners) { try { fn(-deltaX, -deltaY, -deltaZ, _shift) } catch (_) {} }
    return true
  }

  // Subscribe to rebase events: fn(dx, dy, dz, shift) is called with the render-space translation
  // just applied to the built-in scene graph (camera + direct scene children) whenever a rebase
  // happens, so a caller owning render-space state OUTSIDE the THREE scene graph (raw-GL systems,
  // cached screen-space anchors, anything storing its own copy of a render-space position) can apply
  // the identical shift and stay consistent. Returns an unsubscribe function.
  function onRebase(fn) { _listeners.add(fn); return () => _listeners.delete(fn) }

  // Render-space (THREE) position/object -> authoritative local-frame coordinate. Use this to feed
  // mapspinner (PlanetFrame.localToWorld/groundHeightLocal) or anything else that needs the TRUE,
  // unbounded local-frame coordinate from a render-space THREE.Vector3-like {x,y,z}.
  function toAuthoritative(renderPos, out) {
    const o = out || new THREE.Vector3()
    o.x = renderPos.x + _shift.x; o.y = renderPos.y + _shift.y; o.z = renderPos.z + _shift.z
    return o
  }

  // Authoritative local-frame coordinate -> render-space (THREE) position. Use when placing a NEW
  // object whose position arrived in authoritative/local-frame meters (e.g. a freshly spawned entity
  // at a server-authoritative position) directly into the THREE scene graph.
  function toRender(authPos, out) {
    const o = out || new THREE.Vector3()
    o.x = authPos.x - _shift.x; o.y = authPos.y - _shift.y; o.z = authPos.z - _shift.z
    return o
  }

  return {
    update, onRebase, toAuthoritative, toRender,
    getShift: () => _shift,
    getAuthoritativeCamera: () => _authCam,
    getRebaseCount: () => _rebaseCount,
    getLastDelta: () => _lastDelta,
  }
}

// Translates every direct child of `scene` (excluding camera, handled separately by the caller --
// see update()'s camera.position.set(0,0,0) and its comment) by (dx,dy,dz). Only top-level children
// need translating -- SceneGraph.js parents every player/entity group directly under `scene` (root =
// scene, see SceneGraph.js's `root.add(group)`), ModelPool roots and gizmo/colliderDebug helpers are
// likewise added directly to `scene`, and any object PARENTED under one of those (skinned meshes,
// VRM rigs, child entities reparented via SceneGraph.setParent) moves for free via matrixWorld
// composition -- translating the parent is sufficient and correct, translating both parent and child
// would double-apply the shift to the child. Unlike camera.position (rewritten from authoritative
// data every frame, so `+=` on it would apply the delta to the WRONG base -- see update()), every
// scene.children entry here genuinely needs the incremental `+=`: its position was left as-is since
// the last render-space write (a prior frame/network snapshot, already in the OLD render space), not
// freshly re-derived from authoritative data this same call.
function _translateChildren(scene, camera, dx, dy, dz) {
  for (const child of scene.children) {
    if (child === camera) continue
    child.position.x += dx; child.position.y += dy; child.position.z += dz
  }
}
