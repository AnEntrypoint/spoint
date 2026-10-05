import { rayOpticalDepth, sampledOpticalDepth } from '../shared/fire/fireQueries.js'

const FALLBACK_TICK_RATE = 60

export function createFireGameplay({ appCtx, gameplay, getWorld, cellOfPosition, frameOf }) {
  const burning = new Map()
  const scratch = { face: 0, I: 0, J: 0 }
  const startCell = { face: 0, I: 0, J: 0 }
  const endPoint = [0, 0, 0]
  let accumulatedSeconds = 0

  function defaultTargets() {
    const out = []
    for (const p of appCtx.players.getAll()) if (p.state && p.state.position) out.push({ id: p.id, position: p.state.position, holder: p.state, entity: false })
    return out
  }

  function targetsOf() { return gameplay.targets ? gameplay.targets(appCtx) : defaultTargets() }

  function hurt(target, amount) {
    if (!(amount > 0)) return
    if (target.entity) { appCtx.world.sendToEntity(target.id, { type: 'damage', amount, source: 'fire' }); return }
    const h = target.holder
    if ((h.health ?? 1) <= 0) return
    const before = h.health ?? 100
    h.health = Math.max(0, before - amount)
    if (h.health <= 0 && before > 0) appCtx.players.send(target.id, { type: 'fire_death' })
  }

  function tickDamage(simTick, dt) {
    accumulatedSeconds += dt
    if (simTick % gameplay.damageEveryTicks !== 0) return
    const seconds = accumulatedSeconds
    accumulatedSeconds = 0
    const world = getWorld()
    const statusTicks = Math.ceil(gameplay.burnStatusSeconds * FALLBACK_TICK_RATE)
    if (!world || (world.kernel.activeCount === 0 && burning.size === 0)) return
    const { kernel } = world
    for (const target of targetsOf()) {
      let rate = 0
      if (kernel.activeCount > 0) {
        const c = cellOfPosition(target.position)
        rate = kernel.damageAt(c.face, c.I, c.J)
      }
      if (rate > 0) { hurt(target, rate * seconds); burning.set(target.id, statusTicks); continue }
      const left = burning.get(target.id)
      if (left === undefined) continue
      hurt(target, gameplay.statusDamagePerSec * seconds)
      if (left <= gameplay.damageEveryTicks) burning.delete(target.id); else burning.set(target.id, left - gameplay.damageEveryTicks)
    }
  }

  function smokeDepth(origin, direction, distance) {
    const world = getWorld()
    if (!world || world.kernel.activeCount === 0) return 0
    const { kernel, lattice } = world
    const c0 = cellOfPosition(origin)
    startCell.face = c0.face; startCell.I = c0.I; startCell.J = c0.J
    endPoint[0] = origin[0] + direction[0] * distance; endPoint[1] = origin[1] + direction[1] * distance; endPoint[2] = origin[2] + direction[2] * distance
    const c1 = cellOfPosition(endPoint)
    if (c1.face === startCell.face) return rayOpticalDepth(kernel, startCell.face, startCell.I, startCell.J, c1.I, c1.J, distance, gameplay.eyeHeightM, direction[1], gameplay.smokeHeightM, lattice.cellM)
    return sampledOpticalDepth(kernel, lattice, frameOf(), origin, direction, distance, gameplay.eyeHeightM, gameplay.smokeHeightM, scratch)
  }

  function rayBlocked(origin, direction, distance) { return smokeDepth(origin, direction, distance) >= gameplay.smokeBlockDepth }

  function blast(position, radiusM, damage) {
    const r2 = radiusM * radiusM
    for (const target of targetsOf()) {
      const dx = target.position[0] - position[0], dy = target.position[1] - position[1], dz = target.position[2] - position[2]
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 > r2) continue
      const d = Math.sqrt(d2), falloff = 1 - d / radiusM
      hurt(target, damage * falloff)
      const inv = d > 1e-6 ? 1 / d : 0
      if (target.entity) appCtx.world.applyImpulse(target.id, [dx * inv * gameplay.explosionImpulse * falloff, gameplay.explosionImpulse * falloff, dz * inv * gameplay.explosionImpulse * falloff])
      else if (target.holder.velocity) { target.holder.velocity[0] += dx * inv * gameplay.explosionImpulse * falloff; target.holder.velocity[1] += gameplay.explosionImpulse * falloff; target.holder.velocity[2] += dz * inv * gameplay.explosionImpulse * falloff }
    }
  }

  return { tickDamage, smokeDepth, rayBlocked, blast, isBurning: id => burning.has(id), get burningCount() { return burning.size } }
}
