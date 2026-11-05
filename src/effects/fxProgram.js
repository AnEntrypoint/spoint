const SINKS = new Set(['sprite', 'mesh'])
const BLENDS = new Set(['alpha', 'add', 'multiply', 'subtract', 'screen'])
const MAX_POPULATIONS = 16
const MAX_RATE = 10000
const MAX_BURST = 100000
const MAX_LIFETIME_S = 600
const MAX_SPEED_MPS = 1000
const MAX_DRAG = 100
const MAX_CONE_DEG = 180
const CHANNEL = Object.freeze({ lifetime: 0, azimuth: 1, cone: 2, speed: 3 })
const CHANNELS = 4

export class FxProgramError extends Error {
  constructor(reasonCode, detail) {
    super(`[fxProgram] ${reasonCode}${detail ? `: ${detail}` : ''}`)
    this.name = 'FxProgramError'
    this.reasonCode = reasonCode
  }
}

function finiteIn(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function isVec3(value) {
  return Array.isArray(value) && value.length === 3 && value.every((v) => Number.isFinite(v))
}

function parseVelocity(raw, name) {
  if (raw === undefined || raw === null) return { speed: [0, 0], coneDeg: 0 }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new FxProgramError('velocity-invalid', name)
  const speed = raw.speed ?? [0, 0]
  const coneDeg = raw.coneDeg ?? 0
  if (!Array.isArray(speed) || speed.length !== 2 || !finiteIn(speed[0], 0, MAX_SPEED_MPS) || !finiteIn(speed[1], 0, MAX_SPEED_MPS) || speed[1] < speed[0]) {
    throw new FxProgramError('velocity-invalid', name)
  }
  if (!finiteIn(coneDeg, 0, MAX_CONE_DEG)) throw new FxProgramError('velocity-invalid', name)
  return { speed: [speed[0], speed[1]], coneDeg }
}

function parseAccelerate(raw, name) {
  if (raw === undefined || raw === null) return { gravity: [0, 0, 0], drag: 0 }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new FxProgramError('accelerate-invalid', name)
  const gravity = raw.gravity ?? [0, 0, 0]
  const drag = raw.drag ?? 0
  if (!isVec3(gravity) || !finiteIn(drag, 0, MAX_DRAG)) throw new FxProgramError('accelerate-invalid', name)
  return { gravity: [gravity[0], gravity[1], gravity[2]], drag }
}

function parsePopulation(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new FxProgramError('population-not-object', `index ${index}`)
  const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : null
  if (name === null) throw new FxProgramError('population-name-missing', `index ${index}`)
  const spawn = raw.spawn
  if (spawn === null || typeof spawn !== 'object' || !finiteIn(spawn.rate, 0, MAX_RATE)) throw new FxProgramError('spawn-rate-invalid', name)
  const burst = spawn.burst ?? 0
  if (!Number.isInteger(burst) || !finiteIn(burst, 0, MAX_BURST)) throw new FxProgramError('spawn-burst-invalid', name)
  const life = raw.lifetime ?? [0, 0]
  if (!Array.isArray(life) || life.length !== 2 || !finiteIn(life[0], 0, MAX_LIFETIME_S) || !finiteIn(life[1], 0, MAX_LIFETIME_S) || life[1] < life[0]) {
    throw new FxProgramError('lifetime-invalid', name)
  }
  const sink = raw.render
  if (sink === null || typeof sink !== 'object' || !SINKS.has(sink.kind)) throw new FxProgramError('render-kind-unsupported', name)
  if (sink.blend !== undefined && !BLENDS.has(sink.blend)) throw new FxProgramError('blend-unsupported', name)
  const maxParticles = raw.maxParticles ?? null
  if (maxParticles !== null && !finiteIn(maxParticles, 1, 100000)) throw new FxProgramError('max-particles-invalid', name)
  return {
    name,
    rate: spawn.rate,
    burst,
    lifetime: [life[0], life[1]],
    velocity: parseVelocity(raw.velocity, name),
    accelerate: parseAccelerate(raw.accelerate, name),
    render: { kind: sink.kind, blend: sink.blend ?? 'alpha' },
    maxParticles,
  }
}

export function parseFxProgram(source) {
  const doc = typeof source === 'string' ? parseJson(source) : source
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.populations)) throw new FxProgramError('populations-missing')
  if (doc.populations.length === 0 || doc.populations.length > MAX_POPULATIONS) throw new FxProgramError('population-count-invalid', String(doc.populations.length))
  const seed = doc.seed ?? 0
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new FxProgramError('seed-invalid')
  const populations = doc.populations.map(parsePopulation)
  const names = new Set(populations.map((p) => p.name))
  if (names.size !== populations.length) throw new FxProgramError('population-name-duplicate')
  return Object.freeze({ seed, populations: Object.freeze(populations) })
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new FxProgramError('json-unreadable', error.message)
  }
}

function hash01(seed, pop, n) {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(pop + 1, 0xc2b2ae35) ^ Math.imul(n + 1, 0x27d4eb2f)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

export function createFxSimulation(program) {
  const pops = program.populations.map((p, i) => ({ def: p, index: i, carry: 0, emitted: 0, bursted: false, live: [] }))
  let time = 0

  function channel(pop, c) {
    return hash01(program.seed, pop.index, pop.emitted * CHANNELS + c)
  }

  function emit(pop) {
    if (pop.def.maxParticles !== null && pop.live.length >= pop.def.maxParticles) return
    const [lo, hi] = pop.def.lifetime
    const life = lo + (hi - lo) * channel(pop, CHANNEL.lifetime)
    const { speed, coneDeg } = pop.def.velocity
    const magnitude = speed[0] + (speed[1] - speed[0]) * channel(pop, CHANNEL.speed)
    const cosCone = Math.cos((coneDeg * Math.PI) / 180)
    const cosTheta = cosCone + channel(pop, CHANNEL.cone) * (1 - cosCone)
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta))
    const azimuth = channel(pop, CHANNEL.azimuth) * 2 * Math.PI
    pop.emitted += 1
    pop.live.push({
      dies: time + life,
      pos: [0, 0, 0],
      vel: [magnitude * sinTheta * Math.cos(azimuth), magnitude * cosTheta, magnitude * sinTheta * Math.sin(azimuth)],
    })
  }

  function integrate(pop, dt) {
    const [gx, gy, gz] = pop.def.accelerate.gravity
    const damping = Math.max(0, 1 - pop.def.accelerate.drag * dt)
    for (const p of pop.live) {
      p.vel[0] = (p.vel[0] + gx * dt) * damping
      p.vel[1] = (p.vel[1] + gy * dt) * damping
      p.vel[2] = (p.vel[2] + gz * dt) * damping
      p.pos[0] += p.vel[0] * dt
      p.pos[1] += p.vel[1] * dt
      p.pos[2] += p.vel[2] * dt
    }
  }

  function step(dt) {
    if (!finiteIn(dt, 0, 1)) throw new FxProgramError('dt-invalid', String(dt))
    time += dt
    for (const pop of pops) {
      integrate(pop, dt)
      if (!pop.bursted) {
        pop.bursted = true
        for (let k = 0; k < pop.def.burst; k += 1) emit(pop)
      }
      pop.carry += pop.def.rate * dt
      const whole = Math.floor(pop.carry)
      pop.carry -= whole
      for (let k = 0; k < whole; k += 1) emit(pop)
      pop.live = pop.live.filter((p) => p.dies > time)
    }
    return snapshot()
  }

  function snapshot() {
    return Object.fromEntries(
      pops.map((pop) => [
        pop.def.name,
        {
          alive: pop.live.length,
          render: pop.def.render,
          particles: pop.live.map((p) => ({ pos: p.pos.slice(), vel: p.vel.slice() })),
        },
      ]),
    )
  }

  return { step, snapshot }
}
