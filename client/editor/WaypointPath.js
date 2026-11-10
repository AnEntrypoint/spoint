import * as THREE from 'three'

export function collectWaypointPathPoints(entities) {
  const flat = []
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n && n.id) flat.push(n)
      if (n && n.children && n.children.length) walk(n.children)
    }
  }
  walk(entities)
  return flat
    .filter(n => n.custom && n.custom._waypoint)
    .map(n => ({ id: n.id, order: n.custom.order ?? 0, position: Array.isArray(n.position) ? n.position : [0, 0, 0] }))
    .sort((a, b) => a.order - b.order)
}

const _LINE_COLOR = 0xffcc00
const _LINE_COLOR_SELECTED = 0x00ffff

const _labelTextures = []
function _labelTexture(index) {
  if (_labelTextures[index]) return _labelTextures[index]
  const canvas = document.createElement('canvas')
  canvas.width = 64; canvas.height = 64
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, 64, 64)
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.beginPath(); ctx.arc(32, 32, 28, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 32px sans-serif'
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(String(index), 32, 34)
  _labelTextures[index] = new THREE.CanvasTexture(canvas)
  return _labelTextures[index]
}
function _makeOrderLabelSprite(index) {
  const mat = new THREE.SpriteMaterial({ map: _labelTexture(index), depthTest: false, transparent: true })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(0.6, 0.6, 1)
  sprite.renderOrder = 998
  return sprite
}

export function createWaypointPathOverlay({ scene, entityMeshes }) {
  let _group = null
  let _lastIds = null, _lastSel = '', _lastPos = new Float64Array(0)
  let _live = new Float64Array(0)
  let _sourceEntities = null, _points = []

  function _pointsFrom(entities) {
    if (entities !== _sourceEntities) {
      _sourceEntities = entities
      _live = new Float64Array(0)
      _points = collectWaypointPathPoints(entities).map(p => ({ id: p.id, order: p.order, position: [p.position[0], p.position[1], p.position[2]] }))
    }
    return _points
  }

  function _sampleLive(points) {
    const need = points.length * 3
    if (_live.length !== need) {
      _live = new Float64Array(need)
      for (let i = 0; i < points.length; i++) { const q = points[i].position, o = i * 3; _live[o] = q[0]; _live[o + 1] = q[1]; _live[o + 2] = q[2] }
    }
    if (!entityMeshes) return
    for (let i = 0; i < points.length; i++) {
      const m = entityMeshes.get(points[i].id)
      if (!m) continue
      const o = i * 3
      _live[o] = m.position.x; _live[o + 1] = m.position.y; _live[o + 2] = m.position.z
    }
  }

  function _unchanged(points, selectedId) {
    if (!_lastIds || _lastIds.length !== points.length || _lastSel !== (selectedId || '')) return false
    for (let i = 0; i < _live.length; i++) if (_live[i] !== _lastPos[i]) return false
    return true
  }

  function _adoptLive(points) {
    for (let i = 0; i < points.length; i++) { const q = points[i].position, o = i * 3; q[0] = _live[o]; q[1] = _live[o + 1]; q[2] = _live[o + 2] }
  }

  function _remember(points, selectedId) {
    _lastIds = points.map(p => p.id)
    _lastSel = selectedId || ''
    _lastPos = new Float64Array(points.length * 3)
    points.forEach((p, i) => { _lastPos[i * 3] = p.position[0]; _lastPos[i * 3 + 1] = p.position[1]; _lastPos[i * 3 + 2] = p.position[2] })
  }

  function _teardown() {
    if (!_group) return
    scene.remove(_group)
    _group.traverse(o => {
      if (o.geometry) o.geometry.dispose()
      if (o.material) o.material.dispose()
    })
    _group = null
  }

  function _build(points, selectedId) {
    const g = new THREE.Group()
    g.userData.isWaypointPath = true
    if (points.length >= 2) {
      const verts = new Float32Array(points.length * 3)
      points.forEach((p, i) => { verts[i * 3] = p.position[0]; verts[i * 3 + 1] = p.position[1]; verts[i * 3 + 2] = p.position[2] })
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
      const mat = new THREE.LineBasicMaterial({ color: _LINE_COLOR, depthTest: false, transparent: true, opacity: 0.85, linewidth: 2 })
      const line = new THREE.Line(geo, mat)
      line.renderOrder = 997
      g.add(line)
    }
    points.forEach((p, i) => {
      const sprite = _makeOrderLabelSprite(i)
      sprite.position.set(p.position[0], p.position[1] + 0.9, p.position[2])
      if (p.id === selectedId) sprite.material.color.setHex(_LINE_COLOR_SELECTED)
      g.add(sprite)
    })
    return g
  }

  return {
    update(entities, selectedId) {
      const points = _pointsFrom(entities)
      _sampleLive(points)
      if (_unchanged(points, selectedId)) return
      _adoptLive(points)
      _remember(points, selectedId)
      _teardown()
      if (points.length < 1) return
      _group = _build(points, selectedId)
      scene.add(_group)
    },
    get visible() { return !!_group },
    destroy() { _teardown(); _lastIds = null; _sourceEntities = null; _points = []; _live = new Float64Array(0) }
  }
}

export { collectWaypointPathPoints as _collectWaypointPathPoints }
