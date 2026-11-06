function refusal(code, message) {
  const err = new TypeError(`[water-level] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

function readCircle(spec, name) {
  if (!spec || typeof spec !== 'object') throw refusal('water-body-invalid', `${name} must be an object`)
  const { x, z, radius, level } = spec
  if (![x, z, radius, level].every(Number.isFinite) || radius <= 0) throw refusal('water-body-invalid', `${name} needs finite x, z, radius > 0 and level`)
  return { x, z, radius, level }
}

export function createWaterLevel({ seaLevel = 0, lakes = [], ponds = [], sampleAt = null, liquidAt = null } = {}) {
  if (!Number.isFinite(seaLevel)) throw refusal('water-sea-invalid', 'seaLevel must be finite')
  if (!Array.isArray(lakes) || !Array.isArray(ponds)) throw refusal('water-bodies-invalid', 'lakes and ponds must be arrays')
  if (sampleAt !== null && typeof sampleAt !== 'function') throw refusal('water-sampler-invalid', 'sampleAt must be a function or null')
  if (liquidAt !== null && typeof liquidAt !== 'function') throw refusal('water-liquid-invalid', 'liquidAt must be a function or null')
  const circles = [...lakes.map((b, i) => readCircle(b, `lakes[${i}]`)), ...ponds.map((b, i) => readCircle(b, `ponds[${i}]`))]
  let sea = seaLevel

  return {
    setSeaLevel(value) {
      if (!Number.isFinite(value)) throw refusal('water-sea-invalid', 'seaLevel must be finite')
      sea = value
      return sea
    },
    get seaLevel() { return sea },
    getWaterLevelAt(x, z, place = null) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) throw refusal('water-position-invalid', 'x and z must be finite')
      const painted = sampleAt === null ? null : sampleAt(x, z, place)
      if (painted !== null && !Number.isFinite(painted)) throw refusal('water-painted-invalid', 'sampleAt must return a finite level or null')
      let level = painted === null ? sea : Math.max(sea, painted)
      for (const c of circles) {
        const d2 = (x - c.x) ** 2 + (z - c.z) ** 2
        if (d2 <= c.radius ** 2) level = Math.max(level, c.level)
      }
      const liquid = liquidAt === null ? null : liquidAt(x, z)
      if (liquid !== null && !Number.isFinite(liquid)) throw refusal('water-liquid-invalid', 'liquidAt must return a finite level or null')
      if (liquid !== null) level = Math.max(level, liquid)
      return level
    },
    liquidStateAt(x, z, feetY, place = null) {
      if (!Number.isFinite(feetY)) throw refusal('water-position-invalid', 'feetY must be finite')
      const level = this.getWaterLevelAt(x, z, place)
      const depth = level - feetY
      return {
        inWater: depth > 0,
        level,
        depth: Math.max(0, depth),
        density: depth > 0 ? (depth > 1.5 ? 'diving' : 'floating') : 'air',
      }
    },
  }
}
