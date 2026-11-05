export class ScriptedTerrainError extends Error {
  constructor(reasonCode, detail) {
    super(`[scripted-terrain] ${reasonCode}: ${detail}`)
    this.name = 'ScriptedTerrainError'
    this.reasonCode = reasonCode
  }
}

const refusal = (code, detail) => new ScriptedTerrainError(code, detail)

function requireFinite(value, code, detail) {
  if (!Number.isFinite(value)) throw refusal(code, detail)
  return value
}

export function createScriptedTerrain({
  heightAt,
  materialAt = null,
  minHeight = 0,
  maxHeight = 1,
  seedOffset = 0,
  normalStep = 1,
} = {}) {
  if (typeof heightAt !== 'function') throw refusal('height-at-invalid', 'heightAt must be a function')
  if (materialAt !== null && typeof materialAt !== 'function') throw refusal('material-at-invalid', 'materialAt must be a function or null')
  requireFinite(minHeight, 'height-range-invalid', 'minHeight must be finite')
  requireFinite(maxHeight, 'height-range-invalid', 'maxHeight must be finite')
  if (!(maxHeight > minHeight)) throw refusal('height-range-invalid', 'maxHeight must exceed minHeight')
  requireFinite(seedOffset, 'seed-offset-invalid', 'seedOffset must be finite')
  requireFinite(normalStep, 'normal-step-invalid', 'normalStep must be finite and positive')
  if (!(normalStep > 0)) throw refusal('normal-step-invalid', 'normalStep must be finite and positive')

  const heightSpan = maxHeight - minHeight
  const seedOffsetFor = (index) => {
    requireFinite(index, 'seed-offset-index-non-finite', 'seedOffsetFor needs a finite index')
    return requireFinite(seedOffset + index, 'seed-offset-index-non-finite', 'seedOffsetFor overflowed')
  }

  const readHeight = (x, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw refusal('input-non-finite', 'x and z must be finite numbers')
    const height = heightAt({ x, z, seedOffset, seedOffsetFor, minHeight, maxHeight })
    return requireFinite(height, 'height-non-finite', 'heightAt returned a non-finite height')
  }

  const surfaceHeight = (x, z) => Math.min(maxHeight, Math.max(minHeight, readHeight(x, z)))

  const describe = (x, z) => {
    const height = readHeight(x, z)
    const worldHeight = Math.min(maxHeight, Math.max(minHeight, height))
    const height01 = requireFinite(
      Math.min(1, Math.max(0, (worldHeight - minHeight) / heightSpan)),
      'height01-non-finite',
      'normalised height is non-finite',
    )
    const slope = [
      (surfaceHeight(x + normalStep, z) - surfaceHeight(x - normalStep, z)) / (2 * normalStep),
      (surfaceHeight(x, z + normalStep) - surfaceHeight(x, z - normalStep)) / (2 * normalStep),
    ]
    if (!Number.isFinite(slope[0]) || !Number.isFinite(slope[1])) throw refusal('slope-non-finite', 'the height gradient is non-finite')
    const inverseLength = 1 / Math.hypot(slope[0], 1, slope[1])
    const normal = [-slope[0] * inverseLength, inverseLength, -slope[1] * inverseLength]
    if (!Number.isFinite(normal[0]) || !Number.isFinite(normal[1]) || !Number.isFinite(normal[2])) {
      throw refusal('normal-non-finite', 'the surface normal is non-finite')
    }
    return { x, z, height, worldHeight, height01, slope, normal }
  }

  const readMaterial = ({ x, z, worldHeight, height01, slope, normal }) => {
    if (materialAt === null) return null
    const material = materialAt({ x, z, worldHeight, height01, slope, normal, seedOffset, seedOffsetFor, minHeight, maxHeight })
    if (typeof material === 'number' && !Number.isFinite(material)) throw refusal('material-non-finite', 'materialAt returned a non-finite number')
    if (material === null || typeof material === 'string') return material
    if (typeof material !== 'object' || Array.isArray(material)) throw refusal('material-shape-invalid', 'materialAt must return null, a string or a weight object')
    for (const [key, weight] of Object.entries(material)) {
      requireFinite(weight, 'material-non-finite', `material weight ${key} is non-finite`)
    }
    return { ...material }
  }

  const sample = (x, z) => {
    const surface = describe(x, z)
    return {
      height: surface.height,
      worldHeight: surface.worldHeight,
      height01: surface.height01,
      slope: surface.slope,
      normal: surface.normal,
      material: readMaterial(surface),
    }
  }

  const getTerrainNormal = (x, z) => describe(x, z).normal

  const materialAtPoint = (x, z) => readMaterial(describe(x, z))

  return Object.freeze({ sample, getTerrainNormal, materialAt: materialAtPoint })
}
