const SINKS = new Set(['sprite', 'mesh'])
const BLENDS = new Set(['alpha', 'add', 'multiply', 'subtract', 'screen'])
const MAX_POPULATIONS = 16
const MAX_RATE = 10000
const MAX_LIFETIME_S = 600

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

function parsePopulation(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new FxProgramError('population-not-object', `index ${index}`)
  const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : null
  if (name === null) throw new FxProgramError('population-name-missing', `index ${index}`)
  const spawn = raw.spawn
  if (spawn === null || typeof spawn !== 'object' || !finiteIn(spawn.rate, 0, MAX_RATE)) throw new FxProgramError('spawn-rate-invalid', name)
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
    lifetime: [life[0], life[1]],
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
  const pops = program.populations.map((p, i) => ({ def: p, index: i, carry: 0, spawned: [] }))
  let time = 0

  function step(dt) {
    if (!finiteIn(dt, 0, 1)) throw new FxProgramError('dt-invalid', String(dt))
    time += dt
    for (const pop of pops) {
      pop.carry += pop.def.rate * dt
      const whole = Math.floor(pop.carry)
      pop.carry -= whole
      for (let k = 0; k < whole; k += 1) {
        if (pop.def.maxParticles !== null && aliveOf(pop) >= pop.def.maxParticles) break
        const n = pop.spawned.length
        const [lo, hi] = pop.def.lifetime
        const life = lo + (hi - lo) * hash01(program.seed, pop.index, n)
        pop.spawned.push({ born: time, dies: time + life })
      }
      pop.spawned = pop.spawned.filter((p) => p.dies > time)
    }
    return snapshot()
  }

  function aliveOf(pop) {
    return pop.spawned.reduce((count, p) => count + (p.dies > time ? 1 : 0), 0)
  }

  function snapshot() {
    return Object.fromEntries(pops.map((pop) => [pop.def.name, { alive: aliveOf(pop), render: pop.def.render }]))
  }

  return { step, snapshot }
}
