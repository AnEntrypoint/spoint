import { applyPlayerTransform, tickBatch } from './TransformLerp.js'

const _toRenderTmp = { x: 0, y: 0, z: 0 }

export function createSceneGraph(scene, floatingOrigin) {
  const _nodes = new Map()
  const root = scene
  const _batchState = { buf: null }
  const _batchPool = []
  const _batchRecords = []

  function _batchRow(i) {
    let r = _batchPool[i]
    if (!r) { r = { mesh: null, target: null, last: { hasRot: false } }; _batchPool[i] = r }
    return r
  }

  function addNode(id, group, opts = {}) {
    const existing = _nodes.get(id)
    if (existing) { existing.group.removeFromParent(); _nodes.delete(id) }
    const target = {}
    _nodes.set(id, { group, target, isPlayer: !!opts.isPlayer, feetOffset: opts.feetOffset ?? 0.91 })
    root.add(group)
  }

  function removeNode(id) {
    const node = _nodes.get(id)
    if (!node) return
    node.group.removeFromParent()
    _nodes.delete(id)
  }

  function setParent(childId, parentId) {
    const child = _nodes.get(childId), parent = _nodes.get(parentId)
    if (!child) return
    if (parent && parent.group !== child.group.parent) parent.group.add(child.group)
    else if (!parent && child.group.parent !== root) root.add(child.group)
  }

  function setEntityTransforms(entities) {
    for (const e of entities) {
      const node = _nodes.get(e.id)
      if (!node || !e.position) continue
      const t = node.target
      let px = e.position[0], py = e.position[1], pz = e.position[2]
      if (floatingOrigin) {
        _toRenderTmp.x = px; _toRenderTmp.y = py; _toRenderTmp.z = pz
        const r = floatingOrigin.toRender(_toRenderTmp); px = r.x; py = r.y; pz = r.z
      }
      t.x = px; t.y = py; t.z = pz
      t.vx = e.velocity?.[0] || 0; t.vy = e.velocity?.[1] || 0; t.vz = e.velocity?.[2] || 0
      t.rx = e.rotation?.[0] || 0; t.ry = e.rotation?.[1] || 0; t.rz = e.rotation?.[2] || 0; t.rw = e.rotation?.[3] || 1
    }
  }

  function setPlayerTransforms(players, lid, getLocalState) {
    for (const p of players) {
      const node = _nodes.get(p.id)
      if (!node) continue
      const lc = p.id === lid ? getLocalState() : null
      const fo = node.feetOffset
      const src = lc ? (lc.position || p.position) : p.position
      let px = src[0], py = src[1] - fo, pz = src[2]
      if (floatingOrigin) {
        _toRenderTmp.x = px; _toRenderTmp.y = py; _toRenderTmp.z = pz
        const r = floatingOrigin.toRender(_toRenderTmp); px = r.x; py = r.y; pz = r.z
      }
      const t = node.target
      t.x = px; t.y = py; t.z = pz
      t.vx = (lc || p).velocity?.[0] || 0; t.vy = (lc || p).velocity?.[1] || 0; t.vz = (lc || p).velocity?.[2] || 0
    }
  }

  function setPlayerTransformsFromRing(ringMap, lid) {
    if (!ringMap || ringMap.size === 0) return
    for (const [id, xf] of ringMap) {
      if (xf.stale) continue
      const node = _nodes.get(id)
      if (!node) continue
      const fo = node.feetOffset
      let px = xf.position[0], py = xf.position[1] - fo, pz = xf.position[2]
      if (floatingOrigin) {
        _toRenderTmp.x = px; _toRenderTmp.y = py; _toRenderTmp.z = pz
        const r = floatingOrigin.toRender(_toRenderTmp); px = r.x; py = r.y; pz = r.z
      }
      const t = node.target
      t.x = px; t.y = py; t.z = pz
      t.vx = xf.velocity[0] || 0; t.vy = xf.velocity[1] || 0; t.vz = xf.velocity[2] || 0
    }
  }

  const _recordPool = []
  function tick(frameDt, lerpFactor) {
    let moved = false
    _batchRecords.length = 0
    for (const node of _nodes.values()) {
      const t = node.target
      if (t.x === undefined) continue
      if (node.isPlayer) {
        if (t.x !== node.group.position.x || t.z !== node.group.position.z) moved = true
        applyPlayerTransform(node.group, t, lerpFactor)
      } else {
        if (node.group.visible === false) continue
        if (t.x === node._lx && t.y === node._ly && t.z === node._lz && t.rx === node._lrx &&
            t.ry === node._lry && t.rz === node._lrz && t.rw === node._lrw &&
            node.group.position.x === t.x && node.group.position.y === t.y && node.group.position.z === t.z) continue
        const hasRot = Number.isFinite(t.rx) && Number.isFinite(t.ry) && Number.isFinite(t.rz) && Number.isFinite(t.rw)
        const row = _batchRow(_batchRecords.length)
        row.mesh = node.group; row.target = t; row.last.hasRot = hasRot
        _batchRecords.push(row)
        node._lx = t.x; node._ly = t.y; node._lz = t.z
        node._lrx = t.rx; node._lry = t.ry; node._lrz = t.rz; node._lrw = t.rw
        moved = true
      }
    }
    if (_batchRecords.length > 0) {
      tickBatch(_batchState, _batchRecords, lerpFactor, frameDt)
      for (let i = 0; i < _batchRecords.length; i++) { const r = _batchRecords[i]; r.mesh = null; r.target = null }
    }
    return moved
  }

  function getNode(id) { return _nodes.get(id)?.group }
  function getTarget(id) { return _nodes.get(id)?.target }
  function has(id) { return _nodes.has(id) }
  function nodes() { return _nodes }

  function setLocalPlayer(id) {}

  return { addNode, removeNode, setParent, setEntityTransforms, setPlayerTransforms, setPlayerTransformsFromRing, tick, getNode, getTarget, has, nodes, setLocalPlayer }
}
