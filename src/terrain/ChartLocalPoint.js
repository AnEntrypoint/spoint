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
