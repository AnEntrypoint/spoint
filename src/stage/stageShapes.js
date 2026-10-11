export const FLAT_RING_HALF_HEIGHT_M = Infinity

const shapes = new Map()

export function registerStageShape(id, shape) {
  if (!(typeof id === 'string' && id.length > 0)) {
    throw new TypeError(`[stage] registerStageShape got id ${JSON.stringify(id)}: a shape id is a non-empty string, so a stage can name the shape it resolves instead of inferring one`)
  }
  if (shapes.has(id)) {
    throw new TypeError(`[stage] stage shape "${id}" is already registered: one id owns one ring and one cell query, so a second registration is a disagreement the registry refuses instead of discarding`)
  }
  shapes.set(id, shape)
  return shape
}

export function stageShape(id) {
  const shape = shapes.get(id)
  if (!shape) {
    throw new TypeError(`[stage] stage shape "${id}" has no registration: a stage reads its ring and its cell query from one registered shape, so an unregistered id is refused where the shape is chosen rather than at the query that needs it`)
  }
  return shape
}

export function resolveStageShape(planetRadius, declaredId) {
  if (declaredId != null) return stageShape(declaredId)
  for (const shape of shapes.values()) {
    if (shape.accepts(planetRadius)) return shape
  }
  throw new TypeError(`[stage] planetRadius ${JSON.stringify(planetRadius)} matches no registered stage shape: every ring is a registration, so an unmatched radius fails where the stage is built and never silently falls through to the flat ring`)
}

registerStageShape('flat', {
  id: 'flat',
  accepts: (planetRadius) => planetRadius === 0,
  ring: (radius) => ({ spherical: false, radius, halfHeight: FLAT_RING_HALF_HEIGHT_M }),
  cellQuery: (stage, position, radius) => stage.getRelevantEntitiesHorizontal(position, radius),
  horizontalQuery: (stage, position, radius) => stage.spatial.nearbyCylinder(position, radius, FLAT_RING_HALF_HEIGHT_M)
})

registerStageShape('planet', {
  id: 'planet',
  accepts: (planetRadius) => planetRadius > 0,
  ring: (radius) => ({ spherical: true, radius, halfHeight: radius }),
  cellQuery: (stage, position, radius) => stage.getRelevantEntities(position, radius),
  horizontalQuery: (stage, position, radius) => {
    throw new TypeError(`[stage] stage "${stage.name}" got a horizontal relevance query at planetRadius ${radius}: a horizontal query is the flat ring's own shape, so a planet-centred stage answers getRelevantEntitiesForCell and never this one`)
  }
})
