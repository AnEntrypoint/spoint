export function createModelExclusionField(entities) {
  const circles = []
  if (Array.isArray(entities)) {
    for (const e of entities) {
      if (!e || !e.model || !Array.isArray(e.position)) continue
      if (e.custom && e.custom._interior) continue
      const x = e.position[0], z = e.position[2]
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue
      const scale = Array.isArray(e.scale) ? Math.max(e.scale[0] || 1, e.scale[2] || 1) : (Number.isFinite(e.scale) ? e.scale : 1)
      const radius = Math.max(1.5, scale * 2.5)
      circles.push({ x, z, radius })
    }
  }

  function blockedAt(x, z) {
    for (const c of circles) {
      const dx = x - c.x, dz = z - c.z
      if (dx * dx + dz * dz < c.radius * c.radius) return true
    }
    return false
  }

  function wrapClimateField(baseField) {
    if (circles.length === 0) return baseField
    if (!baseField || typeof baseField.climateAtLocal !== 'function') return baseField
    return {
      ...baseField,
      climateAtLocal(x, z) {
        const base = baseField.climateAtLocal(x, z)
        if (!blockedAt(x, z)) return base
        return base ? { ...base, blocked: 'model' } : { blocked: 'model' }
      },
    }
  }

  return { wrapClimateField, blockedAt, get circleCount() { return circles.length } }
}
