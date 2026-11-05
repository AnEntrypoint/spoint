const SLOPE_STEP_M = 0.5

function groundAt(ctx, x, z) {
  const y = ctx.terrainHeightAt(x, z)
  return Number.isFinite(y) ? y : null
}

function groundNormalAt(ctx, x, z, y) {
  const hx = groundAt(ctx, x + SLOPE_STEP_M, z)
  const hz = groundAt(ctx, x, z + SLOPE_STEP_M)
  if (hx === null || hz === null) return null
  const dx = (hx - y) / SLOPE_STEP_M
  const dz = (hz - y) / SLOPE_STEP_M
  const len = Math.hypot(dx, 1, dz)
  return [-dx / len, 1 / len, -dz / len]
}

function sampleFootprint(ctx, origin, offsets) {
  const posts = offsets.map(([ox, oz], i) => {
    const x = origin[0] + ox
    const z = origin[2] + oz
    const y = groundAt(ctx, x, z)
    const normal = y === null ? null : groundNormalAt(ctx, x, z, y)
    if (y === null || normal === null) throw new Error(`[placed-model] footprint post ${i} at (${x}, ${z}) has no ground`)
    return { x, y, z, normal }
  })
  const groundY = posts.reduce((sum, p) => sum + p.y, 0) / posts.length
  const nx = posts.reduce((sum, p) => sum + p.normal[0], 0)
  const ny = posts.reduce((sum, p) => sum + p.normal[1], 0)
  const nz = posts.reduce((sum, p) => sum + p.normal[2], 0)
  const len = Math.hypot(nx, ny, nz)
  return { posts, groundY, groundNormal: [nx / len, ny / len, nz / len] }
}

export default {
  server: {
    editorProps: [
      { key: '_collider', label: 'Collider', type: 'select', options: ['none', 'box', 'sphere', 'capsule', 'convex', 'trimesh'], default: 'none' },
      { key: '_wetness', label: 'Wetness', type: 'range', min: 0, max: 1, step: 0.05, default: 0 }
    ],
    setup(ctx) {
      const bodyType = ctx.entity.bodyType || 'static'
      const requested = ctx.config.collider || ctx.entity.custom?._collider
      const collider = requested || (bodyType === 'static' ? 'trimesh' : 'convex')
      ctx.physics.addColliderFromConfig({ type: collider, dynamic: bodyType === 'dynamic', kinematic: bodyType === 'kinematic' })
      if (!ctx.entity.custom) ctx.entity.custom = {}
      ctx.entity.custom._collider = collider
      const wetness = ctx.config._wetness
      if (wetness !== undefined) ctx.entity.custom._wetness = wetness
      const offsets = ctx.config.footprint
      if (Array.isArray(offsets) && offsets.length > 0) {
        const footprint = sampleFootprint(ctx, ctx.entity.position, offsets)
        ctx.entity.custom._footprint = footprint
        const flatten = ctx.config.flatten
        if (Number.isFinite(flatten) && flatten > 0) ctx.entity.custom._flatten = { radius: flatten, y: footprint.groundY }
      }
    }
  }
}
