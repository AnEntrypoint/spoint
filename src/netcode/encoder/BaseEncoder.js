export function quantize(v, p) { return Math.round(v * p) / p }
export function encodePlayer(p) {
  const pos = p.position, rot = p.rotation, vel = p.velocity
  return [ p.id, quantize(pos[0], 100), quantize(pos[1], 100), quantize(pos[2], 100), quantize(rot[0], 10000), quantize(rot[1], 10000), quantize(rot[2], 10000), quantize(rot[3], 10000), quantize(vel[0], 100), quantize(vel[1], 100), quantize(vel[2], 100), p.onGround ? 1 : 0, Math.round(p.health || 0), p.inputSequence || 0, p.crouch || 0, Math.round(((p.lookPitch || 0) + Math.PI) / (2 * Math.PI) * 255), Math.round(((p.lookYaw || 0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI) * 255) ]
}
export function encodeEntity(e) {
  const pos = e.position, rot = e.rotation, vel = e.velocity
  return [ e.id, e.model || '', quantize(pos[0], 100), quantize(pos[1], 100), quantize(pos[2], 100), quantize(rot[0], 10000), quantize(rot[1], 10000), quantize(rot[2], 10000), quantize(rot[3], 10000), quantize(vel ? vel[0] : 0, 100), quantize(vel ? vel[1] : 0, 100), quantize(vel ? vel[2] : 0, 100), e.bodyType || 'static', e.custom || null ]
}
