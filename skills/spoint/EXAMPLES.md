# Spawnpoint App Examples

This guide provides complete, commented examples of different app patterns.

## Table of Contents

1. [Health System](#health-system)
2. [Projectile System](#projectile-system)
3. [Loot Drop](#loot-drop)
4. [Environmental Hazard](#environmental-hazard)
5. [Mobile Interactive](#mobile-interactive)
6. [Ability Trigger](#ability-trigger)
7. [Respawn Point](#respawn-point)
8. [Damage Area](#damage-area)

---

## Health System

An app that manages an entity's health with damage and healing.

```javascript
export default {
  server: {
    setup(ctx) {
      ctx.state.maxHealth = 100
      ctx.state.health = ctx.state.maxHealth
      ctx.state.isDead = false
      ctx.state.lastDamageTime = 0
      ctx.state.damageImmunityDuration = 0.5

      ctx.entity.custom = {
        mesh: 'character.glb',
        color: 0x00ff00
      }

      ctx.physics.setDynamic(true)
      ctx.physics.setMass(80)
      ctx.physics.addCapsuleCollider(0.3, 1.8)
    },

    update(ctx, dt) {
      const now = Date.now()

      // Check immunity duration
      if (now - ctx.state.lastDamageTime > ctx.state.damageImmunityDuration * 1000) {
        ctx.state.isImmune = false
      }

      // Update color based on health
      const healthPercent = ctx.state.health / ctx.state.maxHealth
      if (healthPercent > 0.5) {
        ctx.entity.custom.color = 0x00ff00
      } else if (healthPercent > 0.25) {
        ctx.entity.custom.color = 0xffff00
      } else {
        ctx.entity.custom.color = 0xff0000
      }

      // Handle death
      if (ctx.state.isDead && ctx.state.health > 0) {
        ctx.state.isDead = false
      }
    },

    onMessage(ctx, msg) {
      if (msg.type === 'take_damage' && !ctx.state.isImmune && !ctx.state.isDead) {
        ctx.state.health = Math.max(0, ctx.state.health - msg.amount)
        ctx.state.isImmune = true
        ctx.state.lastDamageTime = Date.now()

        if (ctx.state.health <= 0) {
          ctx.state.isDead = true
          ctx.network.broadcast({
            type: 'entity_died',
            entityId: ctx.entity.id,
            position: ctx.entity.position
          })

          ctx.time.after(3, () => {
            if (ctx._runtime?.entities?.has(ctx.entity.id)) {
              ctx.world.destroy(ctx.entity.id)
            }
          })
        } else {
          ctx.network.broadcast({
            type: 'health_changed',
            entityId: ctx.entity.id,
            health: ctx.state.health,
            maxHealth: ctx.state.maxHealth
          })
        }
      }

      if (msg.type === 'heal' && !ctx.state.isDead) {
        const oldHealth = ctx.state.health
        ctx.state.health = Math.min(ctx.state.maxHealth, ctx.state.health + msg.amount)

        if (ctx.state.health !== oldHealth) {
          ctx.network.broadcast({
            type: 'health_changed',
            entityId: ctx.entity.id,
            health: ctx.state.health,
            maxHealth: ctx.state.maxHealth
          })
        }
      }
    }
  },

  client: {
    setup(engine) {
      this.healthBars = new Map()
    },

    onFrame(dt, engine) {
      // Clean up old health bars
      const entities = engine.client?.state?.entities || []
      const currentIds = new Set(entities.map(e => e.id))
      for (const id of this.healthBars.keys()) {
        if (!currentIds.has(id)) {
          this.healthBars.delete(id)
        }
      }
    },

    onEvent(payload, engine) {
      if (payload.type === 'health_changed') {
        this.healthBars.set(payload.entityId, {
          health: payload.health,
          maxHealth: payload.maxHealth,
          lastUpdate: Date.now()
        })
      }
      if (payload.type === 'entity_died') {
        this.healthBars.delete(payload.entityId)
      }
    },

    render(ctx) {
      const health = this.healthBars.get(ctx.entity.id)

      const ui = []
      if (health && ctx.h) {
        const percent = (health.health / health.maxHealth) * 100
        ui.push(
          ctx.h('div', {
            style: 'position:absolute;top:-40px;left:50%;transform:translateX(-50%);width:60px;height:8px;background:rgba(0,0,0,0.5);border:1px solid white;border-radius:4px'
          },
            ctx.h('div', {
              style: `width:${percent}%;height:100%;background:rgb(${255 - percent * 2.55},${percent * 2.55},0);transition:width 0.1s`
            })
          )
        )
      }

      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: ctx.entity.custom,
        ui: ui.length > 0 ? ctx.h('div', null, ...ui) : null
      }
    }
  }
}
```

---

## Projectile System

A projectile that travels in a direction and collides with entities.

```javascript
const CONFIG = {
  speed: 30,
  lifetime: 10,
  damage: 25,
  radius: 0.2,
  checkInterval: 0.05
}

export default {
  server: {
    setup(ctx) {
      ctx.state.direction = ctx.config.direction || [1, 0, 0]
      ctx.state.spawnTime = Date.now()
      ctx.state.lastCheckTime = Date.now()
      ctx.state.hasHit = false

      ctx.entity.custom = {
        mesh: 'sphere',
        color: 0xffff00,
        scale: CONFIG.radius
      }

      ctx.physics.setKinematic(true)
      ctx.physics.addSphereCollider(CONFIG.radius)
    },

    update(ctx, dt) {
      const now = Date.now()
      const elapsed = (now - ctx.state.spawnTime) / 1000

      // Destroy after lifetime
      if (elapsed > CONFIG.lifetime) {
        ctx.world.destroy(ctx.entity.id)
        return
      }

      // Move in direction
      const [dx, dy, dz] = ctx.state.direction
      const distance = CONFIG.speed * dt
      const [x, y, z] = ctx.entity.position
      ctx.entity.position = [x + dx * distance, y + dy * distance, z + dz * distance]

      // Check collisions periodically
      if (now - ctx.state.lastCheckTime > CONFIG.checkInterval * 1000) {
        ctx.state.lastCheckTime = now

        // Check nearby entities
        const nearby = ctx.world.nearby(ctx.entity.position, CONFIG.radius * 3)
        for (const ent of nearby) {
          if (ent.id === ctx.entity.id || ent._appName === 'projectile') continue

          // Send damage message
          ctx.players.send(ent.id, {
            type: 'take_damage',
            amount: CONFIG.damage,
            sourceId: ctx.config.sourceId
          })

          ctx.network.broadcast({
            type: 'projectile_hit',
            projectileId: ctx.entity.id,
            targetId: ent.id,
            position: ctx.entity.position
          })

          ctx.world.destroy(ctx.entity.id)
          ctx.state.hasHit = true
          return
        }
      }
    }
  },

  client: {
    render(ctx) {
      return {
        position: ctx.entity.position,
        custom: ctx.entity.custom
      }
    }
  }
}
```

---

## Loot Drop

An item on the ground that players can pick up.

```javascript
const CONFIG = {
  pickupRadius: 2,
  pickupCooldown: 100,
  lifetime: 60,
  rotationSpeed: 1.5,
  bobAmount: 0.5,
  bobSpeed: 2
}

export default {
  server: {
    setup(ctx) {
      ctx.state.itemType = ctx.config.itemType || 'coin'
      ctx.state.itemAmount = ctx.config.amount || 1
      ctx.state.spawnTime = Date.now()
      ctx.state.spawnPosition = [...ctx.entity.position]
      ctx.state.pickedUpBy = null

      const colors = {
        coin: 0xffff00,
        health: 0xff0000,
        mana: 0x0099ff,
        ammo: 0xff6600
      }

      ctx.entity.custom = {
        mesh: 'sphere',
        color: colors[ctx.state.itemType] || 0xffffff,
        scale: 0.3,
        label: `${ctx.state.itemType.toUpperCase()} +${ctx.state.itemAmount}`
      }

      ctx.physics.setKinematic(true)
      ctx.physics.addSphereCollider(0.3)
    },

    update(ctx, dt) {
      const now = Date.now()
      const elapsed = (now - ctx.state.spawnTime) / 1000

      // Destroy after lifetime
      if (elapsed > CONFIG.lifetime) {
        ctx.world.destroy(ctx.entity.id)
        return
      }

      // Check for nearby players
      const nearby = ctx.players.getNearest(ctx.entity.position, CONFIG.pickupRadius)
      if (nearby) {
        ctx.players.send(nearby.id, {
          type: 'item_pickup',
          itemId: ctx.entity.id,
          itemType: ctx.state.itemType,
          amount: ctx.state.itemAmount
        })

        ctx.network.broadcast({
          type: 'item_picked_up',
          itemId: ctx.entity.id,
          playerId: nearby.id
        })

        ctx.world.destroy(ctx.entity.id)
      }
    }
  },

  client: {
    setup(engine) {
      this.bobOffset = 0
      this.rotation = 0
    },

    onFrame(dt, engine) {
      this.rotation += CONFIG.rotationSpeed * dt
      this.bobOffset = Math.sin(engine.time * CONFIG.bobSpeed) * CONFIG.bobAmount
    },

    render(ctx) {
      const pos = [...ctx.entity.position]
      pos[1] += this.bobOffset

      const custom = { ...ctx.entity.custom }
      custom.rotation = [0, this.rotation, 0]

      return {
        position: pos,
        custom
      }
    }
  }
}
```

---

## Environmental Hazard

A damaging area like lava or spikes.

```javascript
const CONFIG = {
  damagePerSecond: 10,
  checkInterval: 0.2,
  effectInterval: 0.3
}

export default {
  server: {
    setup(ctx) {
      ctx.state.affectedPlayers = new Map()
      ctx.state.lastEffectTime = 0

      ctx.entity.custom = {
        mesh: 'box',
        color: 0xff3300,
        alpha: 0.7,
        sx: ctx.config.size?.[0] || 5,
        sy: ctx.config.size?.[1] || 0.5,
        sz: ctx.config.size?.[2] || 5
      }

      ctx.physics.setStatic(true)
      ctx.physics.addBoxCollider([
        (ctx.config.size?.[0] || 5) / 2,
        (ctx.config.size?.[1] || 0.5) / 2,
        (ctx.config.size?.[2] || 5) / 2
      ])
    },

    update(ctx, dt) {
      const now = Date.now()

      // Check for players in hazard
      const nearby = ctx.world.nearby(ctx.entity.position, 10)
      for (const ent of nearby) {
        if (ent._appName !== 'player') continue

        if (!ctx.state.affectedPlayers.has(ent.id)) {
          ctx.state.affectedPlayers.set(ent.id, now)
        }

        // Apply damage periodically
        if (now - ctx.state.affectedPlayers.get(ent.id) > CONFIG.checkInterval * 1000) {
          ctx.players.send(ent.id, {
            type: 'take_damage',
            amount: CONFIG.damagePerSecond * CONFIG.checkInterval,
            source: 'hazard'
          })

          ctx.state.affectedPlayers.set(ent.id, now)

          if (now - ctx.state.lastEffectTime > CONFIG.effectInterval * 1000) {
            ctx.network.broadcast({
              type: 'hazard_effect',
              hazardId: ctx.entity.id,
              position: ent.position
            })
            ctx.state.lastEffectTime = now
          }
        }
      }

      // Remove players no longer in hazard
      for (const [playerId] of ctx.state.affectedPlayers) {
        const ent = ctx.world.getEntity(playerId)
        if (!ent) {
          ctx.state.affectedPlayers.delete(playerId)
        }
      }
    }
  },

  client: {
    render(ctx) {
      return {
        position: ctx.entity.position,
        custom: ctx.entity.custom
      }
    }
  }
}
```

---

## More Examples

Additional patterns available in the `apps/` directory:
- **physics-crate** - Dynamic physics object
- **interactable** - Interactive object with messaging
- **power-crate** - Spawner with persistent state
- **tps-game** - Complex multiplayer game

Study these for more advanced patterns!
