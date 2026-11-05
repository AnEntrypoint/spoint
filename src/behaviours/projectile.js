const isFinite3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)

export function sweepProjectile(raycast, from, velocity, dt) {
  if (typeof raycast !== 'function') throw new TypeError('[projectile] raycast must be a function')
  if (!isFinite3(from) || !isFinite3(velocity) || !Number.isFinite(dt) || dt < 0) {
    throw new TypeError('[projectile] from and velocity must be finite length-3 arrays and dt a finite non-negative number')
  }
  const speed = Math.hypot(velocity[0], velocity[1], velocity[2])
  const reach = speed * dt
  if (reach === 0) return { position: [...from], hit: null }
  const dir = velocity.map((c) => c / speed)
  const r = raycast(from, dir, reach)
  if (r && r.hit) {
    if (!isFinite3(r.position)) throw new TypeError('[projectile] raycast hit carries no finite position')
    return { position: [...r.position], hit: { point: [...r.position], entityId: r.entityId ?? null } }
  }
  return { position: from.map((c, i) => c + dir[i] * reach), hit: null }
}
