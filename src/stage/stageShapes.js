export const FLAT_RING_HALF_HEIGHT_M = Infinity

const SMALLEST_POSITIVE_RADIUS_M = Number.MIN_VALUE

const shapes = new Map()

function ownedBand(id, band) {
  if (!band || typeof band !== 'object') {
    throw new TypeError(`[stage] stage shape "${id}" declares no band: a shape owns one half-open radius interval [minInclusive, maxExclusive), so the registry can refuse an overlap instead of letting registration order decide which ring a radius reaches`)
  }
  const { minInclusive, maxExclusive } = band
  const numbers = typeof minInclusive === 'number' && typeof maxExclusive === 'number'
  if (!numbers || Number.isNaN(minInclusive) || Number.isNaN(maxExclusive)) {
    throw new TypeError(`[stage] stage shape "${id}" declares band ${JSON.stringify(band)}: a band is two non-NaN numbers, minInclusive and maxExclusive, so every radius either falls inside the interval or outside it with no third answer`)
  }
  if (minInclusive < 0) {
    throw new TypeError(`[stage] stage shape "${id}" declares band [${minInclusive}, ${maxExclusive}) below 0: no radius is negative, so a band reaching under zero admits a radius no stage can be built at and is refused where the shape is declared`)
  }
  if (!(minInclusive < maxExclusive)) {
    throw new TypeError(`[stage] stage shape "${id}" declares the empty band [${minInclusive}, ${maxExclusive}): a shape no radius can reach is unreachable by construction, so the registry refuses it where the shape is declared rather than at the resolve that never selects it`)
  }
  return Object.freeze({ minInclusive, maxExclusive })
}

function bandHolds(band, planetRadius) {
  return planetRadius >= band.minInclusive && planetRadius < band.maxExclusive
}

function bandsOverlap(a, b) {
  return Math.max(a.minInclusive, b.minInclusive) < Math.min(a.maxExclusive, b.maxExclusive)
}

function refuseOverlap(id, band) {
  for (const [heldId, held] of shapes) {
    if (bandsOverlap(band, held.band)) {
      throw new TypeError(`[stage] stage shape "${id}" declares band [${band.minInclusive}, ${band.maxExclusive}) overlapping the registered shape "${heldId}" [${held.band.minInclusive}, ${held.band.maxExclusive}): one radius resolves to exactly one ring, so either half of the overlap is a shape no radius can ever reach -- the registry refuses the overlap instead of letting registration order hide it`)
    }
  }
}

export function registerStageShape(id, shape) {
  if (!(typeof id === 'string' && id.length > 0)) {
    throw new TypeError(`[stage] registerStageShape got id ${JSON.stringify(id)}: a shape id is a non-empty string, so a stage can name the shape it resolves instead of inferring one`)
  }
  if (shapes.has(id)) {
    throw new TypeError(`[stage] stage shape "${id}" is already registered: one id owns one ring and one cell query, so a second registration is a disagreement the registry refuses instead of discarding`)
  }
  const band = ownedBand(id, shape?.band)
  refuseOverlap(id, band)
  const entry = Object.freeze({ ...shape, band })
  shapes.set(id, entry)
  return entry
}

export function stageShape(id) {
  const shape = shapes.get(id)
  if (!shape) {
    throw new TypeError(`[stage] stage shape "${id}" has no registration: a stage reads its ring and its cell query from one registered shape, so an unregistered id is refused where the shape is chosen rather than at the query that needs it`)
  }
  return shape
}

export function resolveStageShape(planetRadius, declaredId) {
  if (declaredId != null) {
    const shape = stageShape(declaredId)
    if (!bandHolds(shape.band, planetRadius)) {
      throw new TypeError(`[stage] stage shape "${declaredId}" is declared at planetRadius ${JSON.stringify(planetRadius)} outside its band [${shape.band.minInclusive}, ${shape.band.maxExclusive}): the shape and the radius that selects the ring are one fact, so a pair that disagrees is refused where the stage is built instead of resolving to a ring that serves neither radius`)
    }
    return shape
  }
  for (const shape of shapes.values()) {
    if (bandHolds(shape.band, planetRadius)) return shape
  }
  throw new TypeError(`[stage] planetRadius ${JSON.stringify(planetRadius)} matches no registered stage shape: every ring is a registration, so an unmatched radius fails where the stage is built and never silently falls through to the flat ring`)
}

registerStageShape('flat', {
  id: 'flat',
  band: { minInclusive: 0, maxExclusive: SMALLEST_POSITIVE_RADIUS_M },
  ring: (radius) => ({ spherical: false, radius, halfHeight: FLAT_RING_HALF_HEIGHT_M }),
  cellQuery: (stage, position, radius) => stage.getRelevantEntitiesHorizontal(position, radius),
  horizontalQuery: (stage, position, radius) => stage.spatial.nearbyCylinder(position, radius, FLAT_RING_HALF_HEIGHT_M)
})

registerStageShape('planet', {
  id: 'planet',
  band: { minInclusive: SMALLEST_POSITIVE_RADIUS_M, maxExclusive: Infinity },
  ring: (radius) => ({ spherical: true, radius, halfHeight: radius }),
  cellQuery: (stage, position, radius) => stage.getRelevantEntities(position, radius),
  horizontalQuery: (stage, position, radius) => {
    throw new TypeError(`[stage] stage "${stage.name}" got a horizontal relevance query at planetRadius ${radius}: a horizontal query is the flat ring's own shape, so a planet-centred stage answers getRelevantEntitiesForCell and never this one`)
  }
})
