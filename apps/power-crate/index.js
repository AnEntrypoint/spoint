const CONFIG = {
  spawnInterval: 30,
  pickupRadius: 2.5,
  pickupLifetime: 30,
  crateHitRadius: 1.5,
  buffDuration: 45,
  speedMultiplier: 1.2,
  fireRateMultiplier: 1.2,
  damageMultiplier: 1.2,
  raycastHeight: 20,
  raycastRange: 30,
  minGroundY: -3,
  spawnAboveGround: 1.5,
  gridStart: [-31, -61],
  gridEnd: [17, -1],
  gridStep: 12
}

export default {
  server: {
    setup(ctx) {
      ctx.state.crates = ctx.state.crates || new Set()
      ctx.state.pickups = ctx.state.pickups || new Map()
      ctx.state.spawnPoints = findSpawnPoints(ctx)
      ctx.state.nextCrateId = ctx.state.nextCrateId || 0
      ctx.state.spawnTimer = 0

      ctx.bus.on('combat.fire', (event) => {
        handleFireEvent(ctx, event.data)
      })

      console.log(`[power-crate] ${ctx.state.spawnPoints.length} spawn points, interval ${CONFIG.spawnInterval}s`)
      const initialCount = Math.min(5, ctx.state.spawnPoints.length)
      for (let i = 0; i < initialCount; i++) spawnCrate(ctx)
    },

    update(ctx, dt) {
      ctx.state.spawnTimer += dt
      if (ctx.state.spawnTimer >= CONFIG.spawnInterval) {
        ctx.state.spawnTimer = 0
        spawnCrate(ctx)
      }

      checkPickups(ctx)
      expirePickups(ctx, dt)
    },

    teardown(ctx) {
      for (const id of ctx.state.crates) ctx.world.destroy(id)
      for (const id of ctx.state.pickups.keys()) ctx.world.destroy(id)
      ctx.state.crates.clear()
      ctx.state.pickups.clear()
    }
  },

  client: {
    render(ctx) {
      return {
        position: ctx.entity.position,
        custom: { type: 'power-crate-manager' }
      }
    }
  }
}

function findSpawnPoints(ctx) {
  const valid = []
  for (let x = CONFIG.gridStart[0]; x <= CONFIG.gridEnd[0]; x += CONFIG.gridStep) {
    for (let z = CONFIG.gridStart[1]; z <= CONFIG.gridEnd[1]; z += CONFIG.gridStep) {
      const hit = ctx.raycast([x, CONFIG.raycastHeight, z], [0, -1, 0], CONFIG.raycastRange)
      if (hit.hit && hit.position[1] > CONFIG.minGroundY) {
        valid.push([x, hit.position[1] + CONFIG.spawnAboveGround, z])
      }
    }
  }
  if (valid.length < 4) valid.push([0, 5, 0], [-35, 3, -65], [20, 5, -20], [-20, 5, 20])
  return valid
}

function spawnCrate(ctx) {
  const sp = ctx.state.spawnPoints
  if (sp.length === 0) return
  const pos = sp[Math.floor(Math.random() * sp.length)]
  const id = `power_crate_${ctx.state.nextCrateId++}`
  ctx.world.spawn(id, {
    position: [...pos],
    app: 'physics-crate',
    config: { type: 'power-crate' }
  })
  ctx.state.crates.add(id)
}

function handleFireEvent(ctx, data) {
  if (!data || !data.origin || !data.direction) return
  const origin = data.origin
  const direction = data.direction

  for (const crateId of ctx.state.crates) {
    const ent = ctx.world.getEntity(crateId)
    if (!ent) continue
    const cratePos = ent.position
    const toTarget = [
      cratePos[0] - origin[0],
      cratePos[1] - origin[1],
      cratePos[2] - origin[2]
    ]
    const dot = toTarget[0] * direction[0] + toTarget[1] * direction[1] + toTarget[2] * direction[2]
    if (dot < 0 || dot > 1000) continue
    const proj = [
      origin[0] + direction[0] * dot,
      origin[1] + direction[1] * dot,
      origin[2] + direction[2] * dot
    ]
    const dist = Math.hypot(
      proj[0] - cratePos[0],
      proj[1] - cratePos[1],
      proj[2] - cratePos[2]
    )
    if (dist > CONFIG.crateHitRadius) continue

    const hitPos = [cratePos[0], cratePos[1], cratePos[2]]
    ctx.world.destroy(crateId)
    ctx.state.crates.delete(crateId)
    spawnPickup(ctx, hitPos)
    break
  }
}

function spawnPickup(ctx, pos) {
  const id = `powerup_${ctx.state.nextCrateId++}`
  const e = ctx.world.spawn(id, { position: [...pos] })
  if (e) e.custom = { mesh: 'cylinder', r: 0.4, h: 0.1, seg: 16, color: 0xffd700, roughness: 0.3, metalness: 0.8, emissive: 0xffa000, emissiveIntensity: 0.3, rotZ: Math.PI / 2, light: 0xffd700, lightIntensity: 1, lightRange: 4, spin: 3, hover: 0.3 }
  ctx.state.pickups.set(id, { position: [...pos], lifetime: CONFIG.pickupLifetime })
}

function checkPickups(ctx) {
  const players = ctx.players.getAll()
  for (const [pickupId, pickup] of ctx.state.pickups) {
    for (const player of players) {
      const pp = player.state?.position
      if (!pp) continue
      const dist = Math.hypot(
        pp[0] - pickup.position[0],
        pp[1] - pickup.position[1],
        pp[2] - pickup.position[2]
      )
      if (dist > CONFIG.pickupRadius) continue

      ctx.bus.emit('powerup.collected', {
        playerId: player.id,
        duration: CONFIG.buffDuration,
        speedMultiplier: CONFIG.speedMultiplier,
        fireRateMultiplier: CONFIG.fireRateMultiplier,
        damageMultiplier: CONFIG.damageMultiplier
      })
      ctx.network.broadcast({
        type: 'powerup_collected',
        playerId: player.id,
        position: pickup.position
      })
      ctx.world.destroy(pickupId)
      ctx.state.pickups.delete(pickupId)
      break
    }
  }
}

function expirePickups(ctx, dt) {
  for (const [id, pickup] of ctx.state.pickups) {
    pickup.lifetime -= dt
    if (pickup.lifetime <= 0) {
      ctx.world.destroy(id)
      ctx.state.pickups.delete(id)
    }
  }
}
