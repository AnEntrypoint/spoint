export class ProceduralGeometryError extends Error {
  constructor(reasonCode, detail) {
    super(`[procedural-geometry] ${reasonCode}: ${detail}`)
    this.name = 'ProceduralGeometryError'
    this.reasonCode = reasonCode
  }
}

const OPS = Object.freeze(['albedo', 'color', 'tri', 'quad', 'lod', 'repeat'])

export function seededStream(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function resolveScalar(value, rng, where) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ProceduralGeometryError('non-finite-number', where)
    return value
  }
  if (value !== null && typeof value === 'object' && Array.isArray(value.rand) && value.rand.length === 2) {
    const [lo, hi] = value.rand
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new ProceduralGeometryError('non-finite-number', where)
    return lo + (hi - lo) * rng()
  }
  throw new ProceduralGeometryError('bad-scalar', where)
}

function resolveVec3(value, rng, where) {
  if (!Array.isArray(value) || value.length !== 3) throw new ProceduralGeometryError('bad-vec3', where)
  return value.map((v, i) => resolveScalar(v, rng, `${where}[${i}]`))
}

function resolveRgb(value, where) {
  if (!Array.isArray(value) || value.length !== 3 || value.some(v => typeof v !== 'number' || !(v >= 0 && v <= 1))) {
    throw new ProceduralGeometryError('bad-rgb', where)
  }
  return value
}

function validateOp(op, path) {
  if (op === null || typeof op !== 'object' || !OPS.includes(op.op)) {
    throw new ProceduralGeometryError('unknown-op', path)
  }
  if (op.op === 'lod' || op.op === 'repeat') {
    if (!Array.isArray(op.body)) throw new ProceduralGeometryError('missing-body', path)
    op.body.forEach((child, i) => validateOp(child, `${path}.body[${i}]`))
  }
}

export function validateProgram(program) {
  if (!Array.isArray(program)) throw new ProceduralGeometryError('program-not-array', 'program')
  program.forEach((op, i) => validateOp(op, `program[${i}]`))
  return program
}

export function buildProceduralGeometry(program, { seed, lod = 0 }) {
  if (!Number.isInteger(seed)) throw new ProceduralGeometryError('bad-seed', String(seed))
  if (!Number.isInteger(lod) || lod < 0) throw new ProceduralGeometryError('bad-lod', String(lod))
  validateProgram(program)
  const rng = seededStream(seed)
  const positions = []
  const albedos = []
  const state = { albedo: [1, 1, 1], lod }

  const emitTri = (a, b, c) => {
    for (const p of [a, b, c]) {
      positions.push(p[0], p[1], p[2])
      albedos.push(state.albedo[0], state.albedo[1], state.albedo[2])
    }
  }

  const run = (ops, path) => {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]
      const here = `${path}[${i}]`
      switch (op.op) {
        case 'albedo':
          state.albedo = resolveRgb(op.rgb, `${here}.rgb`)
          break
        case 'color':
          state.albedo = resolveRgb(op.rgb, `${here}.rgb`)
          break
        case 'tri':
          emitTri(resolveVec3(op.a, rng, `${here}.a`), resolveVec3(op.b, rng, `${here}.b`), resolveVec3(op.c, rng, `${here}.c`))
          break
        case 'quad': {
          const a = resolveVec3(op.a, rng, `${here}.a`)
          const b = resolveVec3(op.b, rng, `${here}.b`)
          const c = resolveVec3(op.c, rng, `${here}.c`)
          const d = resolveVec3(op.d, rng, `${here}.d`)
          emitTri(a, b, c)
          emitTri(a, c, d)
          break
        }
        case 'lod':
          if (state.lod >= op.min && state.lod <= op.max) run(op.body, `${here}.body`)
          break
        case 'repeat': {
          const count = resolveScalar(op.count, rng, `${here}.count`)
          if (!Number.isInteger(count) || count < 0) throw new ProceduralGeometryError('bad-count', `${here}.count`)
          for (let k = 0; k < count; k++) run(op.body, `${here}.body`)
          break
        }
        default:
          throw new ProceduralGeometryError('unknown-op', here)
      }
    }
  }

  run(program, 'program')
  return {
    triangleCount: positions.length / 9,
    positions: Float32Array.from(positions),
    albedos: Float32Array.from(albedos),
  }
}
