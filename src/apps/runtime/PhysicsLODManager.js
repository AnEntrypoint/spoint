export class PhysicsLODManager {
  constructor(runtime) { this._runtime = runtime }
  tick(players, grid) {
    const r = this._runtime; if (!r._physics || !r._physicsLODRadius || r._entityManager._dynamicEntityIds.size === 0) return; r._entityManager._rebuildEntityLists()
    const r2 = r._physicsLODRadius * r._physicsLODRadius; const cellSz = r._physicsIntegration?.config?.capsuleRadius * 8 || 2.5; const rCells = Math.ceil(r._physicsLODRadius / cellSz)
    const dynEntities = r._entityManager._dynamicEntities
    for (let i = 0; i < dynEntities.length; i++) {
      const e = dynEntities[i]; if (!e || !e._bodyDef) continue; let inRange = false
      if (grid && rCells < 10) { const cx = Math.floor(e.position[0] / cellSz), cz = Math.floor(e.position[2] / cellSz); loop: for (let dx = -rCells; dx <= rCells; dx++) { for (let dz = -rCells; dz <= rCells; dz++) { const neighbors = grid.get((cx + dx) * 65536 + (cz + dz)); if (!neighbors) continue; for (const p of neighbors) { const pp = p.state.position; const ddx = pp[0] - e.position[0], ddy = pp[1] - e.position[1], ddz = pp[2] - e.position[2]; if (ddx * ddx + ddy * ddy + ddz * ddz <= r2) { inRange = true; break loop } } } } }
      else { for (let i = 0; i < players.length; i++) { const pp = players[i].state?.position; if (!pp) continue; const dx = pp[0] - e.position[0], dy = pp[1] - e.position[1], dz = pp[2] - e.position[2]; if (dx * dx + dy * dy + dz * dz <= r2) { inRange = true; break } } }
      if (inRange && e._bodyActive === false) { const d = e._bodyDef, bid = r._physics.addBody(d.shapeType, d.params, e.position, d.motionType, { rotation: e.rotation, mass: d.opts.mass }); e._physicsBodyId = bid; e._bodyActive = true; r._physicsBodyToEntityId.set(bid, e.id); r._activeDynamicIds.add(e.id); r._suspendedEntityIds.delete(e.id) }
      else if (!inRange && e._bodyActive !== false && e._physicsBodyId !== undefined && !r._physics.isBodyActive(e._physicsBodyId)) { r._physicsBodyToEntityId.delete(e._physicsBodyId); r._activeDynamicIds.delete(e.id); r._physics.removeBody(e._physicsBodyId); e._physicsBodyId = undefined; e._bodyActive = false; r._suspendedEntityIds.add(e.id) }
    }
  }
}
