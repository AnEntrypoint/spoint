export function seaLevelDirOf(snapshot, x, z) {
  const radius = snapshot.radius
  const e = snapshot.east, u = snapshot.up, n = snapshot.north
  const r2 = x * x + z * z
  const lift = radius - r2 / (radius + Math.sqrt(radius * radius - r2))
  const ax = u[0] * lift + e[0] * x + n[0] * z
  const ay = u[1] * lift + e[1] * x + n[1] * z
  const az = u[2] * lift + e[2] * x + n[2] * z
  const l = Math.hypot(ax, ay, az)
  return [ax / l, ay / l, az / l]
}

export function seaLevelXZOfDir(snapshot, dir) {
  const e = snapshot.east, n = snapshot.north, r = snapshot.radius
  return [r * (dir[0] * e[0] + dir[1] * e[1] + dir[2] * e[2]), r * (dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2])]
}

export function reanchoredSeaLevelXZ(from, to, x, z) {
  return seaLevelXZOfDir(to, seaLevelDirOf(from, x, z))
}

// --- hot swap -----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapChartLocalPoint = (next) => {
  seaLevelDirOf = next.seaLevelDirOf
  seaLevelXZOfDir = next.seaLevelXZOfDir
  reanchoredSeaLevelXZ = next.reanchoredSeaLevelXZ
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapChartLocalPoint)
