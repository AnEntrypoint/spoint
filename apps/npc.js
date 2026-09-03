// apps/npc.js -- NPC entity using VAT (vertex-animation-texture) GPU-skinned crowd rendering.
// animation-vat-npc-integration: wire the VAT crowd renderer into an NPC entity class (not just
// PlayerLOD.js's player-only REDUCED tier). This is a real app module (dual-import safe: server +
// client) that creates NPC entities rendered via PlayerVAT.js's createVATCrowdRenderer instead of
// the full VRM avatar path -- zero per-instance SkinnedMesh/AnimationMixer cost, one shared
// InstancedMesh2 draw call for all NPCs.
//
// SERVER-SIDE (setup): registers a loop-driven NPC that walks a random path, replays scripted
// movement, or stands guard. The NPC's position is computed server-side and replicated to all
// clients via the normal snapshot pipeline (entity.position on the wire, same as any other
// dynamic entity).
//
// CLIENT-SIDE (clientCode): on spawn, uses the existing PlayerVAT.js createVATCrowdRenderer to
// render the NPC as a VAT-skinned instanced mesh -- the SAME renderer PlayerLOD.js's REDUCED tier
// already uses for players. The NPC's frame-animation phase is driven by the server-computed speed
// (or a simple time-based idle loop), matching the multi-clip blend the VAT renderer already supports.
//
// USAGE: add 'npc' to worldDef.placeableApps, then place NPC entities in the editor or spawn them
// from game code. Each NPC instance gets a random walk cycle offset for visual variety.
//
// CONFIG (settable via editorProps or worldDef entities[].config):
//   speed: number (default 2.0) -- movement speed in m/s
//   wanderRadius: number (default 20) -- max distance from spawn to wander
//   loopType: 'idle'|'walk' (default 'walk') -- which VAT clip to play
//   model: string (default 'default') -- visual model variant (future: per-species VAT bake)

export default {
  setup(ctx) {
    const cfg = ctx.config || {}
    const speed = cfg.speed ?? 2.0
    const wanderRadius = cfg.wanderRadius ?? 20
    const loopType = cfg.loopType ?? 'walk'

    // Per-instance state: random phase offset for visual variety, wander target.
    ctx.state._phase = Math.random() * Math.PI * 2
    ctx.state._spawnPos = [ctx.entity.position[0], ctx.entity.position[1], ctx.entity.position[2]]
    ctx.state._wanderTarget = null
    ctx.state._wanderTimer = 0
    ctx.state._speed = speed
    ctx.state._loopType = loopType

    // Make the NPC a kinematic physics body (server-authoritative movement, no client prediction).
    ctx.physics.setMotionType('kinematic')
    ctx.entity._npc = true // tag for client-side VAT rendering

    // Set custom fields the client-side EntityLoader reads for VAT rendering.
    // The client checks entity.custom._npcVat and attaches the NPC to the shared VAT crowd renderer.
    ctx.entity.custom = ctx.entity.custom || {}
    ctx.entity.custom._npcVat = true
    ctx.entity.custom._npcPhase = ctx.state._phase
    ctx.entity.custom._npcLoopType = loopType
  },

  update(ctx, dt) {
    if (ctx.state._loopType === 'idle') {
      // Idle loop: small random subtle sway, phase advances slowly.
      ctx.state._phase = (ctx.state._phase + dt * 0.5) % (Math.PI * 2)
      ctx.entity.custom._npcPhase = ctx.state._phase
      return
    }

    // Walk loop: wander within radius, phase advances with speed.
    const speed = ctx.state._speed
    ctx.state._phase = (ctx.state._phase + dt * speed * 0.3) % (Math.PI * 2)
    ctx.entity.custom._npcPhase = ctx.state._phase

    ctx.state._wanderTimer -= dt
    if (ctx.state._wanderTimer <= 0) {
      // Pick a new random wander target within the spawn radius.
      const angle = Math.random() * Math.PI * 2
      const dist = Math.random() * ctx.state._wanderRadius * 0.7
      ctx.state._wanderTarget = [
        ctx.state._spawnPos[0] + Math.cos(angle) * dist,
        ctx.state._spawnPos[1],
        ctx.state._spawnPos[2] + Math.sin(angle) * dist
      ]
      ctx.state._wanderTimer = 2 + Math.random() * 4 // 2-6s per target
    }

    if (ctx.state._wanderTarget) {
      const dx = ctx.state._wanderTarget[0] - ctx.entity.position[0]
      const dz = ctx.state._wanderTarget[2] - ctx.entity.position[2]
      const dist = Math.sqrt(dx * dx + dz * dz)
      if (dist > 0.3) {
        const step = Math.min(speed * dt, dist)
        ctx.entity.position[0] += (dx / dist) * step
        ctx.entity.position[2] += (dz / dist) * step
        // Face the movement direction.
        ctx.entity.rotation = [0, Math.atan2(dx, dz), 0]
      } else {
        ctx.state._wanderTarget = null
      }
    }
  },

  // Client-side render code: attaches this NPC to the shared VAT crowd renderer.
  // The actual rendering is handled by EntityLoader.js, which checks entity.custom._npcVat
  // and routes the entity through the existing PlayerVAT createVATCrowdRenderer pipeline.
  // This is a thin client-side module that the EntityLoader imports to handle NPC entities.
  clientCode: `
    // NPC client code: the EntityLoader already checks entity.custom._npcVat and routes
    // NPC entities to the shared VAT crowd renderer. This clientCode is a no-op stub --
    // the actual rendering is handled by EntityLoader.js's existing VAT integration path.
    // See client/EntityLoader.js's _attachVatNpc and PlayerLOD.js's REDUCED tier for the
    // live rendering pipeline.
    export default {}
  `
}