const SPEED = 4
const SEPARATION_RADIUS = 1.1
const SEPARATION_GAIN = 6
const ATTACK_RADIUS = 1.6
const SIGHT_RADIUS = 9
const ARRIVE_RADIUS = 0.5
const DAMAGE = 12
const MAX_HP = 100
const ATTACK_COOLDOWN_S = 0.6

function unitId(squad, slot) { return `unit-${squad}-${slot}` }

function basePosition(squad, arena) { return [squad === 0 ? -arena * 0.75 : arena * 0.75, 0] }

function byPlayerId(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0 }

function createSim(squads, perSquad, arena) {
  const n = squads * perSquad
  const sim = { n, squads, perSquad, arena, x: new Float64Array(n), z: new Float64Array(n), hp: new Float64Array(n), cooldown: new Int32Array(n), squad: new Int32Array(n), tx: new Float64Array(squads), tz: new Float64Array(squads), attack: new Uint8Array(squads), prevShoot: new Uint8Array(squads), kills: new Int32Array(squads) }
  for (let q = 0; q < squads; q++) {
    const [bx, bz] = basePosition(q, arena)
    sim.tx[q] = bx; sim.tz[q] = bz
    for (let k = 0; k < perSquad; k++) spawnUnit(sim, q * perSquad + k, q, k)
  }
  return sim
}

function spawnUnit(sim, i, q, k) {
  const [bx, bz] = basePosition(q, sim.arena)
  const cols = 4
  sim.squad[i] = q
  sim.x[i] = bx + ((k % cols) - (cols - 1) / 2) * 1.2
  sim.z[i] = bz + (Math.floor(k / cols) - 1) * 1.2
  sim.hp[i] = MAX_HP
  sim.cooldown[i] = 0
}

function nearestEnemy(sim, i, radius) {
  let best = -1, bestD2 = radius * radius
  for (let j = 0; j < sim.n; j++) {
    if (sim.squad[j] === sim.squad[i]) continue
    const dx = sim.x[j] - sim.x[i], dz = sim.z[j] - sim.z[i], d2 = dx * dx + dz * dz
    if (d2 < bestD2) { bestD2 = d2; best = j }
  }
  return best
}

function applyCommands(sim, players) {
  for (let q = 0; q < sim.squads; q++) {
    const p = players[q]
    if (!p) continue
    const inp = p.lastInput || {}
    if (inp.interact && p.state?.position) { sim.tx[q] = p.state.position[0]; sim.tz[q] = p.state.position[2] }
    const shoot = inp.shoot ? 1 : 0
    if (shoot && !sim.prevShoot[q]) sim.attack[q] ^= 1
    sim.prevShoot[q] = shoot
  }
}

function moveUnits(sim, dt) {
  const lim = sim.arena - 0.5
  for (let i = 0; i < sim.n; i++) {
    const q = sim.squad[i]
    let tx = sim.tx[q], tz = sim.tz[q]
    if (sim.attack[q]) { const e = nearestEnemy(sim, i, SIGHT_RADIUS); if (e >= 0) { tx = sim.x[e]; tz = sim.z[e] } }
    let dx = tx - sim.x[i], dz = tz - sim.z[i]
    const d = Math.sqrt(dx * dx + dz * dz)
    let vx = 0, vz = 0
    if (d > ARRIVE_RADIUS) { vx = dx / d * SPEED; vz = dz / d * SPEED }
    for (let j = 0; j < sim.n; j++) {
      if (j === i) continue
      dx = sim.x[i] - sim.x[j]; dz = sim.z[i] - sim.z[j]
      const d2 = dx * dx + dz * dz
      if (d2 >= SEPARATION_RADIUS * SEPARATION_RADIUS || d2 === 0) continue
      const dist = Math.sqrt(d2), push = (SEPARATION_RADIUS - dist) * SEPARATION_GAIN / dist
      vx += dx * push; vz += dz * push
    }
    sim.x[i] = Math.max(-lim, Math.min(lim, sim.x[i] + vx * dt))
    sim.z[i] = Math.max(-lim, Math.min(lim, sim.z[i] + vz * dt))
  }
}

function resolveCombat(sim, cooldownTicks) {
  let killed = false
  for (let i = 0; i < sim.n; i++) {
    if (sim.cooldown[i] > 0) { sim.cooldown[i]--; continue }
    const e = nearestEnemy(sim, i, ATTACK_RADIUS)
    if (e < 0) continue
    sim.hp[e] -= DAMAGE
    sim.cooldown[i] = cooldownTicks
  }
  for (let i = 0; i < sim.n; i++) {
    if (sim.hp[i] > 0) continue
    const q = sim.squad[i]
    sim.kills[(q + 1) % sim.squads]++
    spawnUnit(sim, i, q, i - q * sim.perSquad)
    killed = true
  }
  return killed
}

export default {
  description: 'Deterministic RTS-style squad sim for the lockstep netcode profile: hold E to rally your squad to you, click to toggle attack-move.',
  server: {
    setup(ctx) {
      const c = ctx.config || {}
      ctx._sim = createSim(c.squads ?? 2, c.unitsPerSquad ?? 12, c.arena ?? 18)
      ctx.entity.custom = { kills: [...ctx._sim.kills], attack: [...ctx._sim.attack] }
    },
    update(ctx, dt) {
      const sim = ctx._sim
      if (!sim) return
      applyCommands(sim, ctx.players.getAll().slice().sort(byPlayerId))
      moveUnits(sim, dt)
      const killed = resolveCombat(sim, Math.max(1, Math.round(ATTACK_COOLDOWN_S / dt)))
      for (let i = 0; i < sim.n; i++) {
        const e = ctx.world.getEntity(unitId(sim.squad[i], i - sim.squad[i] * sim.perSquad))
        if (!e) continue
        e.position[0] = sim.x[i]
        e.position[2] = sim.z[i]
      }
      const attackChanged = ctx.entity.custom.attack.some((a, q) => a !== sim.attack[q])
      if (killed || attackChanged) ctx.entity.custom = { kills: [...sim.kills], attack: [...sim.attack] }
    }
  }
}
