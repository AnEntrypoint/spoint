function _shapeKey(hx, hy, hz, mass) {
  const round3dp = v => Math.round(v * 1000) / 1000
  return `destructible-debris:${round3dp(hx)},${round3dp(hy)},${round3dp(hz)}:m${round3dp(mass)}`
}

export default {
  server: {
    setup(ctx) {
      const c = ctx.config || {}
      if (c.fracturedAsset && Number.isInteger(c.pieceIndex)) {
        if (!ctx.entity.custom) {
          ctx.entity.custom = { mesh: 'fracturedPiece', color: c.color ?? 0x8b4513, roughness: c.roughness ?? 0.85, fracturedAsset: c.fracturedAsset, pieceIndex: c.pieceIndex }
        }
        ctx.physics.addColliderFromConfig({ type: 'convex', meshIndex: c.pieceIndex, mass: c.mass ?? 1, dynamic: true, shapeKey: `${c.fracturedAsset}#${c.pieceIndex}` })
        return
      }
      const hx = c.hx ?? 0.25, hy = c.hy ?? 0.25, hz = c.hz ?? 0.25
      if (!ctx.entity.custom) {
        ctx.entity.custom = { mesh: 'box', color: c.color ?? 0x8b4513, roughness: c.roughness ?? 0.85, sx: hx * 2, sy: hy * 2, sz: hz * 2 }
      }
      const mass = c.mass ?? 1
      ctx.physics.addColliderFromConfig({ type: 'box', size: [hx, hy, hz], mass, dynamic: true, shapeKey: _shapeKey(hx, hy, hz, mass) })
    }
  }
}
