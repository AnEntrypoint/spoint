export function lerpScalar(a, b, t) { return a + (b - a) * t }

export function slerpQuat(out, q1, q2, t) {
  if (!q1 || !q2) { if (q2) { out[0] = q2[0]; out[1] = q2[1]; out[2] = q2[2]; out[3] = q2[3] } return }
  let x1 = q1[0], y1 = q1[1], z1 = q1[2], w1 = q1[3]
  let x2 = q2[0], y2 = q2[1], z2 = q2[2], w2 = q2[3]
  let dot = x1 * x2 + y1 * y2 + z1 * z2 + w1 * w2
  if (dot < 0) { x2 = -x2; y2 = -y2; z2 = -z2; w2 = -w2; dot = -dot }
  dot = Math.max(-1, Math.min(1, dot))
  const theta = Math.acos(dot)
  const sinTheta = Math.sin(theta)
  if (sinTheta < 0.001) { out[0] = lerpScalar(x1, x2, t); out[1] = lerpScalar(y1, y2, t); out[2] = lerpScalar(z1, z2, t); out[3] = lerpScalar(w1, w2, t); return }
  const s1 = Math.sin((1 - t) * theta) / sinTheta
  const s2 = Math.sin(t * theta) / sinTheta
  out[0] = x1 * s1 + x2 * s2; out[1] = y1 * s1 + y2 * s2; out[2] = z1 * s1 + z2 * s2; out[3] = w1 * s1 + w2 * s2
}

export function interpolateSnapshot(result, playerPool, entityPool, getPlayerSlot, older, newer, alpha, oldPMap) {
  result.tick = newer.tick
  result.timestamp = newer.timestamp

  oldPMap.clear()
  for (const p of older.players || []) oldPMap.set(p.id, p)

  const newPlayers = newer.players || []
  const pLen = newPlayers.length
  result.players.length = pLen
  for (let i = 0; i < pLen; i++) {
    const np = newPlayers[i]
    const op = oldPMap.get(np.id)
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

  result.entities = newer.entities || []
  return result
}
