function refusal(code, message) {
  const err = new TypeError(`[leaf-spray] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export const LEAF_SPECIES = Object.freeze(['broad', 'needle'])

function hash(seed, index, salt) {
  let h = (seed ^ Math.imul(index, 2654435761) ^ Math.imul(salt, 1597334677)) >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 2246822507) >>> 0
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

export function createLeafSprayTexture({ size = 512, species = 'broad', seed = 1, coverageTarget = 0.4, maxSprigs = 400 } = {}) {
  if (!Number.isInteger(size) || size < 16 || (size & (size - 1)) !== 0) throw refusal('leaf-size-invalid', 'size must be a power of two at least 16')
  if (!LEAF_SPECIES.includes(species)) throw refusal('leaf-species-invalid', `species must be one of ${LEAF_SPECIES.join(', ')}`)
  if (!Number.isInteger(seed)) throw refusal('leaf-seed-invalid', 'seed must be an integer')
  if (!Number.isFinite(coverageTarget) || coverageTarget <= 0 || coverageTarget > 1) throw refusal('leaf-coverage-invalid', 'coverageTarget must be finite in (0,1]')
  if (!Number.isInteger(maxSprigs) || maxSprigs < 1) throw refusal('leaf-sprigs-invalid', 'maxSprigs must be a positive integer')
  const alpha = new Uint8Array(size * size)
  const half = Math.floor(size / 2)
  const targetPixels = Math.ceil(coverageTarget * half * half)
  let covered = 0
  let sprigs = 0
  const paint = (x, y) => {
    if (x < 0 || y < 0 || x >= half || y >= half) return
    const at = y * size + x
    if (alpha[at] <= 128) covered++
    alpha[at] = 255
  }
  for (let i = 0; i < maxSprigs && covered < targetPixels; i++) {
    const cx = Math.floor(hash(seed, i, 1) * (half - 8)) + 4
    const cy = Math.floor(hash(seed, i, 2) * (half - 8)) + 4
    const radius = 3 + Math.floor(hash(seed, i, 3) * 6)
    if (species === 'needle') {
      for (let s = -5; s <= 5; s++) {
        for (let d = 0; d < radius; d++) paint(cx + s * 2, cy + d)
      }
    } else {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy <= radius * radius) paint(cx + dx, cy + dy)
        }
      }
    }
    sprigs++
  }
  return Object.freeze({ size, alpha, coverage: covered / (half * half), covered, targetPixels, sprigs, species })
}
