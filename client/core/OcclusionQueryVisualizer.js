// OcclusionQueryVisualizer -- draws every occlusion candidate's AABB, color-coded by verdict state,
// across ALL culling consumers (TerrainOcclusion, SceneOcclusion, ModelPool) via the uniform stats
// surface (cull-stats-uniform-shape) + a per-consumer per-candidate box-list callback each consumer
// exposes. Mirrors ColliderDebug.js's overlay pattern (LineSegments, depthTest:false, a
// window.__colliderDebug-style toggle) -- see client/core/ColliderDebug.js for the precedent this
// follows (group.renderOrder high, depthTest:false so boxes draw over solid geometry, toggled via a
// hotkey/window global, not a permanent scene cost).
//
// Color code (state -> hex, matches the uniform verdict vocabulary):
//   visible        0x00ff00 (green)  -- candidate resolved visible, not hidden
//   occluded       0xff0000 (red)    -- candidate resolved hidden (streak-confirmed)
//   pending        0xffff00 (yellow) -- query in flight, no resolved verdict yet this cycle
//   failed-open    0x00ffff (cyan)   -- a fail-open just fired for this candidate (eyeAtIssue expiry,
//                                       stale-resolve, or rebuild-staleness) -- shown for one refresh
//                                       cycle so a live session can literally see fail-opens happening
//   anomaly-skipped 0xff00ff (magenta) -- this candidate's verdict was discarded by an anomaly-fraction
//                                       batch reset (cull-false-occlusion-root-cause) this cycle
//
// A consumer opts in by registering a boxProvider(): () => Array<{ key, center:[x,y,z], size:number,
// state: 'visible'|'occluded'|'pending'|'failed-open'|'anomaly-skipped' }>. Missing/throwing
// providers are skipped (defensive, matches CullingHub's own registration philosophy) -- the
// visualizer never takes the frame down for a consumer's own bug.
import * as THREE from 'three'

const STATE_COLOR = {
  visible: 0x00ff00,
  occluded: 0xff0000,
  pending: 0xffff00,
  'failed-open': 0x00ffff,
  'anomaly-skipped': 0xff00ff,
}

// One unit-cube wireframe's local-space line-segment endpoints (12 edges x 2 verts x 3 comps),
// scaled/translated per-candidate via an instance transform written directly into a shared
// BufferGeometry's position attribute each refresh (same non-InstancedMesh direct-buffer-write
// approach ColliderDebug.js's terrain grid uses) -- a real InstancedMesh would need per-instance
// color, which requires an extra attribute anyway, so a flat LineSegments buffer sized to the
// current candidate count is simpler and this overlay is a debug tool, not a hot path.
const _cubeEdges = [
  [-1,-1,-1, 1,-1,-1], [1,-1,-1, 1,1,-1], [1,1,-1, -1,1,-1], [-1,1,-1, -1,-1,-1],
  [-1,-1,1, 1,-1,1], [1,-1,1, 1,1,1], [1,1,1, -1,1,1], [-1,1,1, -1,-1,1],
  [-1,-1,-1, -1,-1,1], [1,-1,-1, 1,-1,1], [1,1,-1, 1,1,1], [-1,1,-1, -1,1,1],
]

export function createOcclusionQueryVisualizer({ scene }) {
  if (!scene) return { toggle() {}, setVisible() {}, update() {}, registerProvider() {}, dispose() {}, get visible() { return false } }

  const group = new THREE.Group()
  group.visible = false
  group.renderOrder = 9997   // below ColliderDebug's 9998/9999 so a collider overlay still draws on top if both are on
  scene.add(group)

  const providers = new Map()   // name -> () => candidate[]
  function registerProvider(name, fn) { if (typeof fn === 'function') providers.set(name, fn) }
  function unregisterProvider(name) { providers.delete(name) }

  let geo = null, mat = null, lines = null
  let _capacity = 0

  function _ensureCapacity(n) {
    if (lines && _capacity >= n) return
    _capacity = Math.max(64, n * 2)   // headroom so a candidate-count jump doesn't reallocate every refresh
    if (lines) { group.remove(lines); geo.dispose() }
    geo = new THREE.BufferGeometry()
    const positions = new Float32Array(_capacity * _cubeEdges.length * 2 * 3)
    const colors = new Float32Array(_capacity * _cubeEdges.length * 2 * 3)
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    mat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 })
    lines = new THREE.LineSegments(geo, mat)
    lines.frustumCulled = false
    lines.renderOrder = 9997
    group.add(lines)
  }

  const _color = new THREE.Color()

  // Pulls every registered provider's current candidate list and rewrites the shared buffer. Called
  // on a throttled cadence by the caller (app.js RenderGraph node or a plain setInterval-equivalent
  // wired outside this module -- this file only owns the overlay itself, not its refresh cadence, to
  // stay a pure primitive matching ColliderDebug.js's own update(playerPos, entityMeshes) shape,
  // which the caller decides when to invoke).
  function update() {
    if (!group.visible) return
    const all = []
    for (const [name, fn] of providers) {
      let list
      try { list = fn() } catch (_) { list = null }
      if (Array.isArray(list)) for (const c of list) all.push(c)
    }
    _ensureCapacity(all.length)
    const posAttr = geo.attributes.position
    const colAttr = geo.attributes.color
    let vi = 0
    for (const c of all) {
      if (!c || !c.center) continue
      const [cx, cy, cz] = c.center
      const s = Number.isFinite(c.size) ? c.size : 1
      const hex = STATE_COLOR[c.state] ?? 0x888888
      _color.setHex(hex)
      for (const edge of _cubeEdges) {
        posAttr.array[vi * 3 + 0] = cx + edge[0] * s
        posAttr.array[vi * 3 + 1] = cy + edge[1] * s
        posAttr.array[vi * 3 + 2] = cz + edge[2] * s
        colAttr.array[vi * 3 + 0] = _color.r; colAttr.array[vi * 3 + 1] = _color.g; colAttr.array[vi * 3 + 2] = _color.b
        vi++
        posAttr.array[vi * 3 + 0] = cx + edge[3] * s
        posAttr.array[vi * 3 + 1] = cy + edge[4] * s
        posAttr.array[vi * 3 + 2] = cz + edge[5] * s
        colAttr.array[vi * 3 + 0] = _color.r; colAttr.array[vi * 3 + 1] = _color.g; colAttr.array[vi * 3 + 2] = _color.b
        vi++
      }
    }
    // Degenerate (zero-length, same point) segments for any unused capacity past the live candidate
    // count -- cheaper than reallocating the buffer down every time the candidate count shrinks.
    for (; vi < _capacity * _cubeEdges.length * 2; vi++) {
      posAttr.array[vi * 3 + 0] = 0; posAttr.array[vi * 3 + 1] = 0; posAttr.array[vi * 3 + 2] = 0
      colAttr.array[vi * 3 + 0] = 0; colAttr.array[vi * 3 + 1] = 0; colAttr.array[vi * 3 + 2] = 0
    }
    posAttr.needsUpdate = true
    colAttr.needsUpdate = true
    geo.setDrawRange(0, all.length * _cubeEdges.length * 2)
    geo.computeBoundingSphere()
  }

  function setVisible(v) { group.visible = !!v; if (v) update() }
  function toggle() { setVisible(!group.visible) }
  function dispose() {
    setVisible(false)
    scene.remove(group)
    if (geo) geo.dispose()
    if (mat) mat.dispose()
    providers.clear()
  }

  const api = { toggle, setVisible, update, registerProvider, unregisterProvider, dispose, get visible() { return group.visible } }
  if (typeof window !== 'undefined') window.__occlusionQueryDebug = api
  return api
}
