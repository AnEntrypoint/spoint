export default {
  setup(ctx) {
    const cfg = ctx.config || {}
    const speed = cfg.speed ?? 2.0
    const wanderRadius = cfg.wanderRadius ?? 20
    const loopType = cfg.loopType ?? 'walk'

    ctx.state._phase = Math.random() * Math.PI * 2
    ctx.state._spawnPos = [ctx.entity.position[0], ctx.entity.position[1], ctx.entity.position[2]]
    ctx.state._wanderTarget = null
    ctx.state._wanderTimer = 0
    ctx.state._speed = speed
    ctx.state._loopType = loopType

    ctx.physics.setMotionType('kinematic')
    ctx.entity._npc = true

    ctx.entity.custom = ctx.entity.custom || {}
    ctx.entity.custom._npcVat = true
    ctx.entity.custom._npcPhase = ctx.state._phase
    ctx.entity.custom._npcLoopType = loopType
  },

  update(ctx, dt) {
    if (ctx.state._loopType === 'idle') {
      ctx.state._phase = (ctx.state._phase + dt * 0.5) % (Math.PI * 2)
      ctx.entity.custom._npcPhase = ctx.state._phase
      return
    }

    const speed = ctx.state._speed
    ctx.state._phase = (ctx.state._phase + dt * speed * 0.3) % (Math.PI * 2)
    ctx.entity.custom._npcPhase = ctx.state._phase

    ctx.state._wanderTimer -= dt
    if (ctx.state._wanderTimer <= 0) {
      const angle = Math.random() * Math.PI * 2
      const dist = Math.random() * ctx.state._wanderRadius * 0.7
      ctx.state._wanderTarget = [
        ctx.state._spawnPos[0] + Math.cos(angle) * dist,
        ctx.state._spawnPos[1],
        ctx.state._spawnPos[2] + Math.sin(angle) * dist
      ]
      const retargetMinSeconds = 2, retargetJitterSeconds = 4
      ctx.state._wanderTimer = retargetMinSeconds + Math.random() * retargetJitterSeconds
    }

    if (ctx.state._wanderTarget) {
      const dx = ctx.state._wanderTarget[0] - ctx.entity.position[0]
      const dz = ctx.state._wanderTarget[2] - ctx.entity.position[2]
      const dist = Math.sqrt(dx * dx + dz * dz)
      if (dist > 0.3) {
        const step = Math.min(speed * dt, dist)
        ctx.entity.position[0] += (dx / dist) * step
        ctx.entity.position[2] += (dz / dist) * step
        ctx.entity.rotation = [0, Math.atan2(dx, dz), 0]
      } else {
        ctx.state._wanderTarget = null
      }
    }
  },

  clientCode: `
    // NPC client code: the EntityLoader already checks entity.custom._npcVat and routes
    // NPC entities to the shared VAT crowd renderer. This clientCode is a no-op stub --
    // the actual rendering is handled by EntityLoader.js's existing VAT integration path.
    // See client/EntityLoader.js's _attachVatNpc and PlayerLOD.js's REDUCED tier for the
    // live rendering pipeline.
    export default {}
  `
}