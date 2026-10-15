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

// --- hot swap -----
// An edit here is accepted by this module: every export is re-assigned to the freshly imported copy,
// so importers already holding the live binding read the edited code without a page reload.
const _hotSwapExports = (next) => {
  reexpressPlayerRecord = next.reexpressPlayerRecord
  reexpressEntityRecord = next.reexpressEntityRecord
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapExports)
