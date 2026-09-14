import * as THREE from 'three'

const STATE_COLOR = {
  visible: 0x00ff00,
  occluded: 0xff0000,
  pending: 0xffff00,
  'failed-open': 0x00ffff,
  'anomaly-skipped': 0xff00ff,
}

const _cubeEdges = [
  [-1,-1,-1, 1,-1,-1], [1,-1,-1, 1,1,-1], [1,1,-1, -1,1,-1], [-1,1,-1, -1,-1,-1],
  [-1,-1,1, 1,-1,1], [1,-1,1, 1,1,1], [1,1,1, -1,1,1], [-1,1,1, -1,-1,1],
  [-1,-1,-1, -1,-1,1], [1,-1,-1, 1,-1,1], [1,1,-1, 1,1,1], [-1,1,-1, -1,1,1],
]

const RENDER_ORDER_BELOW_COLLIDER_DEBUG = 9997

export function createOcclusionQueryVisualizer({ scene }) {
  if (!scene) return { toggle() {}, setVisible() {}, update() {}, registerProvider() {}, dispose() {}, get visible() { return false } }

  const group = new THREE.Group()
  group.visible = false
  group.renderOrder = RENDER_ORDER_BELOW_COLLIDER_DEBUG
  scene.add(group)

  const providers = new Map()
  function registerProvider(name, fn) { if (typeof fn === 'function') providers.set(name, fn) }
  function unregisterProvider(name) { providers.delete(name) }

  let geo = null, mat = null, lines = null
  let _capacity = 0

  function _ensureCapacity(n) {
    if (lines && _capacity >= n) return
    _capacity = Math.max(64, n * 2)
    if (lines) { group.remove(lines); geo.dispose() }
    geo = new THREE.BufferGeometry()
    const positions = new Float32Array(_capacity * _cubeEdges.length * 2 * 3)
    const colors = new Float32Array(_capacity * _cubeEdges.length * 2 * 3)
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    mat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 })
    lines = new THREE.LineSegments(geo, mat)
    lines.frustumCulled = false
    lines.renderOrder = RENDER_ORDER_BELOW_COLLIDER_DEBUG
    group.add(lines)
  }

  const _color = new THREE.Color()

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
