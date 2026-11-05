function refusal(code, message) {
  const err = new TypeError(`[crown-cards] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

function readVec3(value, name) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) throw refusal('crown-vec-invalid', `${name} must be an array of three finite numbers`)
  return value
}

function hash(seed, index, salt) {
  let h = (seed ^ (index * 2654435761) ^ (salt * 1597334677)) >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 2246822507) >>> 0
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

export const CROWN_SHAPES = Object.freeze(['oval', 'box', 'wall'])

export function createCrownLayout({ center = [0, 0, 0], radius = 2, height = 3, headClearanceM = 2, cardCount = 24, normal = [0, 1, 0], tiltMaxRad = 0.6, seed = 1, darkFraction = 0.2, shape = 'oval' } = {}) {
  readVec3(center, 'center')
  readVec3(normal, 'normal')
  if (!Number.isFinite(radius) || radius <= 0) throw refusal('crown-radius-invalid', 'radius must be a positive finite number')
  if (!Number.isFinite(height) || height <= 0) throw refusal('crown-height-invalid', 'height must be a positive finite number')
  if (!Number.isFinite(headClearanceM) || headClearanceM < 0 || headClearanceM >= height) throw refusal('crown-clearance-invalid', 'headClearanceM must be finite, non-negative and below height')
  if (!Number.isInteger(cardCount) || cardCount < 1 || cardCount > 4096) throw refusal('crown-count-invalid', 'cardCount must be an integer in [1,4096]')
  if (!Number.isFinite(tiltMaxRad) || tiltMaxRad < 0 || tiltMaxRad > Math.PI / 2) throw refusal('crown-tilt-invalid', 'tiltMaxRad must be finite in [0,PI/2]')
  if (!Number.isInteger(seed)) throw refusal('crown-seed-invalid', 'seed must be an integer')
  if (!Number.isFinite(darkFraction) || darkFraction < 0 || darkFraction > 1) throw refusal('crown-dark-invalid', 'darkFraction must be finite in [0,1]')
  if (!CROWN_SHAPES.includes(shape)) throw refusal('crown-shape-invalid', `shape must be one of ${CROWN_SHAPES.join(', ')}`)

  const cards = []
  for (let i = 0; i < cardCount; i++) {
    const u = hash(seed, i, 1)
    const v = hash(seed, i, 2)
    const w = hash(seed, i, 3)
    const angle = 2 * Math.PI * u
    let x, z
    if (shape === 'wall') {
      x = (u - 0.5) * 2 * radius
      z = (v - 0.5) * 0.2 * radius
    } else if (shape === 'box') {
      x = (u - 0.5) * 2 * radius
      z = (v - 0.5) * 2 * radius
    } else {
      const r = radius * Math.sqrt(v)
      x = r * Math.cos(angle)
      z = r * Math.sin(angle) * 0.7
    }
    const y = headClearanceM + w * (height - headClearanceM)
    const size = 0.6 + 0.8 * hash(seed, i, 4)
    cards.push({
      position: [center[0] + x, center[1] + y, center[2] + z],
      normal: normal.slice(),
      tiltRad: (hash(seed, i, 5) - 0.5) * 2 * tiltMaxRad,
      scale: [size, size, 1],
      dark: hash(seed, i, 6) < darkFraction,
    })
  }
  return cards
}
