export function reexpressPlayerRecord(pass, player) {
  pass.point(player.position)
  pass.vector(player.velocity)
  pass.yawRotation(player.rotation)
  pass.look(player, 'lookYaw', 'lookPitch')
  pass.vector(player.groundNormal)
  if (player.wallPlanes) player.wallPlanes.length = 0
}

export function reexpressEntityRecord(pass, entity) {
  pass.point(entity.position)
  pass.vector(entity.velocity)
  pass.rotation(entity.rotation)
}
