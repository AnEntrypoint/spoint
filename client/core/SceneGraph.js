import { applyPlayerTransform, tickBatch } from './TransformLerp.js'

// floatingOrigin (optional; see core/FloatingOrigin.js) converts every incoming server-authoritative
// entity/player position (raw, unbounded local-frame meters -- what state.entities/state.players
// carry over the wire, see app.js's onStateUpdate) to render space BEFORE it is stored as a lerp
// target. Without this, a rebase only ever touches camera.position and each node's group.position
// directly (the one-time _translateChildren pass) -- but setEntityTransforms/setPlayerTransforms are
// called on EVERY snapshot (far more often than a rebase), each call re-writing node.target straight
// from the raw authoritative snapshot, so the very next snapshot after a rebase overwrites the
// just-translated target with the old, huge, unrebased coordinate again. Live-witnessed via the
// floating-origin-jitter-test-100km-physics-audio-particles-shadow PRD row's browser dispatch: a
// remote/networked entity's mesh ended up sitting at ~100,000 render-space units from camera.position
// (i.e. still at the raw authoritative distance, completely unrebased) after a 100km traversal,
// while camera.position itself correctly stayed near 0 -- meshes were, in effect, invisible/broken at
// planetary distances despite the camera-side floating-origin fix. toRender() is a no-op (identity)
// when floatingOrigin's shift is still (0,0,0) (nothing rebased yet), so behavior is unchanged for
// any world that never crosses REBASE_THRESHOLD_M.
const _toRenderTmp = { x: 0, y: 0, z: 0 }

export function createSceneGraph(scene, floatingOrigin) {
  const _nodes = new Map()
  const root = scene
  const _batchState = { buf: null }
  // _batchRecords holds POOLED ROW REFERENCES only and is .length-reset each tick -- the same convention
  // as RenderGraph.nodes.js:26-29's _benderPool/_benderScratch. It previously pushed a FRESH
  // `{mesh, target, last:{hasRot}}` PLUS a fresh nested `{hasRot}` (two objects) for every non-player
  // node that moved this frame, every frame -- exactly the `length=0` + `push({...})` shape that removes
  // no garbage at all. Unlike _benderPool, overflow GROWS the pool instead of being dropped: a dropped
  // grass-bend candidate is cosmetic, a dropped transform record would freeze a real entity's mesh in
  // place, so capacity is grow-only (the gl-render.js:1721-1737 _ensureScratch shape) and settles at the
  // peak simultaneous-moving-node count.
  // Row lifetime: tickBatch (TransformLerp.js:74-138) reads mesh/target/last.hasRot inside three
  // synchronous loops and retains nothing, and tick() is called once per frame from one render-graph
  // node, so a row can never be observed after its frame. mesh/target are nulled after the batch so a
  // removed node's Object3D isn't held alive by an idle pool slot.
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
      // e.position is a raw authoritative (unbounded local-frame) coordinate straight off the wire --
      // convert to render space before storing as the lerp target, or a rebase's translate of
      // node.group.position gets silently undone by the very next snapshot (see this file's header).
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
      // Same authoritative->render conversion as setEntityTransforms above, applied after the
      // feetOffset subtraction (feetOffset is a render-space-invariant local adjustment, not part of
      // the authoritative coordinate).
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

  // SharedArrayBuffer transform-ring hot path (physics-dedicated-worker-transform-offload +
  // physics-transform-ring-disconnect-release-and-render-consumption): refreshes existing player node
  // TARGETS from `ringMap` (a Map<playerId,{position,rotation,velocity,stale}>, as returned by
  // BrowserServer.readTransformRing()) -- called every rAF frame, alongside setPlayerTransforms which
  // still only runs once per snapshot. Design: the ring FEEDS the same interpolation-target layer
  // setPlayerTransforms already writes (never bypasses TransformLerp's tick() smoothing), for every
  // player sharing this in-Worker singleplayer/host session (local + any wireweave-peer/host-migration
  // reconnects) -- not just the local player -- since a remote peer's transform benefits from the same
  // zero-postMessage-round-trip freshness the local player does when both share one Worker's physics
  // tick. Only touches a node that ALREADY exists (setPlayerTransforms/addNode owns node lifecycle) and
  // only when the reader reports a clean (non-torn) read for that slot, so a torn read simply keeps the
  // last-known-good target for that frame instead of momentarily snapping to garbage.
  function setPlayerTransformsFromRing(ringMap, lid) {
    if (!ringMap || ringMap.size === 0) return
    for (const [id, xf] of ringMap) {
      if (xf.stale) continue // torn read after all retries -- keep whatever target is already set
      const node = _nodes.get(id)
      if (!node) continue // ring may carry a slot for a player this client has no mesh for yet (join race) -- next snapshot creates the node, ring picks it up next frame
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
