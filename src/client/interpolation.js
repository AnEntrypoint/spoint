export function lerpScalar(a, b, t) { return a + (b - a) * t }

export function slerpQuat(out, q1, q2, t) {
  if (!q1 || !q2) {
    // if both missing, write identity -- out is a reused slot, leaving it stale would carry over last frame's rotation forever
    const src = q2 || q1 || [0, 0, 0, 1]
    out[0] = src[0]; out[1] = src[1]; out[2] = src[2]; out[3] = src[3]
    return
  }
  let x1 = q1[0], y1 = q1[1], z1 = q1[2], w1 = q1[3]
  let x2 = q2[0], y2 = q2[1], z2 = q2[2], w2 = q2[3]
  let dot = x1 * x2 + y1 * y2 + z1 * z2 + w1 * w2
  if (dot < 0) { x2 = -x2; y2 = -y2; z2 = -z2; w2 = -w2; dot = -dot }
  if (dot > 0.9995) {
    const ox = x1+(x2-x1)*t, oy = y1+(y2-y1)*t, oz = z1+(z2-z1)*t, ow = w1+(w2-w1)*t
    const len = Math.sqrt(ox*ox+oy*oy+oz*oz+ow*ow)
    out[0]=ox/len; out[1]=oy/len; out[2]=oz/len; out[3]=ow/len; return
  }
  dot = Math.min(1, dot)
  const theta = Math.acos(dot)
  const sinTheta = Math.sin(theta)
  if (sinTheta < 0.001) { out[0] = x1+(x2-x1)*t; out[1] = y1+(y2-y1)*t; out[2] = z1+(z2-z1)*t; out[3] = w1+(w2-w1)*t; return }
  const s1 = Math.sin((1 - t) * theta) / sinTheta
  const s2 = Math.sin(t * theta) / sinTheta
  out[0] = x1 * s1 + x2 * s2; out[1] = y1 * s1 + y2 * s2; out[2] = z1 * s1 + z2 * s2; out[3] = w1 * s1 + w2 * s2
}

export function interpolateSnapshot(result, playerPool, entityPool, getPlayerSlot, getEntitySlot, older, newer, alpha, oldPMap, oldEMap) {
  result.tick = newer.tick
  result.timestamp = newer.timestamp

  // Removes the per-frame id->entry Map rebuild (one clear + one Map.set per player, every render
  // frame) that the id lookup below used to require. older/newer are consecutive SnapshotProcessor
  // outputs, whose players[] are emitted in the same _playerStates iteration order, so entry i of
  // `older` is almost always the same player as entry i of `newer` -- an index probe + id compare
  // answers the lookup with zero Map traffic. The map is still the authority whenever the probe
  // misses (a join/leave/tier change shifts the order), built lazily at the first miss only, so the
  // result is identical either way (player ids are unique within a snapshot, so the entry at index i
  // with id X *is* the map's entry for X).
  const oldPlayers = older.players || []
  let pMapBuilt = false
  const newPlayers = newer.players || []
  const pLen = newPlayers.length
  result.players.length = pLen
  for (let i = 0; i < pLen; i++) {
    const np = newPlayers[i]
    let op = oldPlayers[i]
    if (op === undefined || op.id !== np.id) {
      if (!pMapBuilt) { oldPMap.clear(); for (let j = 0; j < oldPlayers.length; j++) oldPMap.set(oldPlayers[j].id, oldPlayers[j]); pMapBuilt = true }
      op = oldPMap.get(np.id)
    }
    const slot = getPlayerSlot(i)
    result.players[i] = slot
    if (op) {
      slot.id = np.id
      slot.position[0] = lerpScalar(op.position[0], np.position[0], alpha)
      slot.position[1] = lerpScalar(op.position[1], np.position[1], alpha)
      slot.position[2] = lerpScalar(op.position[2], np.position[2], alpha)
      slerpQuat(slot.rotation, op.rotation || np.rotation, np.rotation, alpha)
      slot.velocity[0] = lerpScalar(op.velocity?.[0] || 0, np.velocity?.[0] || 0, alpha)
      slot.velocity[1] = lerpScalar(op.velocity?.[1] || 0, np.velocity?.[1] || 0, alpha)
      slot.velocity[2] = lerpScalar(op.velocity?.[2] || 0, np.velocity?.[2] || 0, alpha)
      slot.onGround = np.onGround
      slot.health = np.health
      slot.inputSequence = np.inputSequence
      slot.crouch = np.crouch
      slot.lookPitch = lerpScalar(op.lookPitch || 0, np.lookPitch || 0, alpha)
      slot.lookYaw = lerpScalar(op.lookYaw || 0, np.lookYaw || 0, alpha)
    } else {
      slot.id = np.id
      slot.position[0] = np.position[0]; slot.position[1] = np.position[1]; slot.position[2] = np.position[2]
      const r = np.rotation || [0, 0, 0, 1]; slot.rotation[0] = r[0]; slot.rotation[1] = r[1]; slot.rotation[2] = r[2]; slot.rotation[3] = r[3]
      const v = np.velocity || [0, 0, 0]; slot.velocity[0] = v[0]; slot.velocity[1] = v[1]; slot.velocity[2] = v[2]
      slot.onGround = np.onGround; slot.health = np.health; slot.inputSequence = np.inputSequence
      slot.crouch = np.crouch; slot.lookPitch = np.lookPitch || 0; slot.lookYaw = np.lookYaw || 0
    }
  }

  // Entities (physics-simulated props/debris) previously snapped straight to `newer` every call with
  // no interpolation at all, unlike players just above -- visible as jumpy/stepped motion on any moving
  // dynamic body, since a rendered frame lands between two snapshots but showed the raw newest one
  // regardless of alpha. Mirrors the player lerp above; a static/sleeping body's position/rotation are
  // identical between snapshots so lerping it is a correctness-preserving no-op, not a special case.
  // Same index-probe-before-Map lookup as the player loop above (see its comment) -- this is the
  // larger of the two loops in practice, so it is where most of the removed Map traffic was.
  const oldEntities = older.entities || []
  let eMapBuilt = false
  const newEntities = newer.entities || []
  const eLen = newEntities.length
  result.entities.length = eLen
  for (let i = 0; i < eLen; i++) {
    const ne = newEntities[i]
    let oe = oldEntities[i]
    if (oe === undefined || oe.id !== ne.id) {
      if (!eMapBuilt) { oldEMap.clear(); for (let j = 0; j < oldEntities.length; j++) oldEMap.set(oldEntities[j].id, oldEntities[j]); eMapBuilt = true }
      oe = oldEMap.get(ne.id)
    }
    const slot = getEntitySlot(i)
    result.entities[i] = slot
    slot.id = ne.id
    slot.model = ne.model
    slot.bodyType = ne.bodyType
    slot.custom = ne.custom
    slot.sleeping = ne.sleeping
    if (oe) {
      slot.position[0] = lerpScalar(oe.position[0], ne.position[0], alpha)
      slot.position[1] = lerpScalar(oe.position[1], ne.position[1], alpha)
      slot.position[2] = lerpScalar(oe.position[2], ne.position[2], alpha)
      slerpQuat(slot.rotation, oe.rotation || ne.rotation, ne.rotation, alpha)
      slot.velocity[0] = lerpScalar(oe.velocity?.[0] || 0, ne.velocity?.[0] || 0, alpha)
      slot.velocity[1] = lerpScalar(oe.velocity?.[1] || 0, ne.velocity?.[1] || 0, alpha)
      slot.velocity[2] = lerpScalar(oe.velocity?.[2] || 0, ne.velocity?.[2] || 0, alpha)
      slot.scale[0] = lerpScalar(oe.scale?.[0] ?? ne.scale[0], ne.scale[0], alpha)
      slot.scale[1] = lerpScalar(oe.scale?.[1] ?? ne.scale[1], ne.scale[1], alpha)
      slot.scale[2] = lerpScalar(oe.scale?.[2] ?? ne.scale[2], ne.scale[2], alpha)
    } else {
      slot.position[0] = ne.position[0]; slot.position[1] = ne.position[1]; slot.position[2] = ne.position[2]
      const r = ne.rotation || [0, 0, 0, 1]; slot.rotation[0] = r[0]; slot.rotation[1] = r[1]; slot.rotation[2] = r[2]; slot.rotation[3] = r[3]
      const v = ne.velocity || [0, 0, 0]; slot.velocity[0] = v[0]; slot.velocity[1] = v[1]; slot.velocity[2] = v[2]
      const sc = ne.scale || [1, 1, 1]; slot.scale[0] = sc[0]; slot.scale[1] = sc[1]; slot.scale[2] = sc[2]
    }
  }
  return result
}
