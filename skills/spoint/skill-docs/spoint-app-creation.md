# Spawnpoint App Creation Guide

## Overview

Apps in spawnpoint are modular, reloadable game systems that run on the server with optional client-side rendering. Each app is a directory containing an `index.js` module that exports a configuration object with lifecycle hooks.

## Quick Start

Create a new app directory in `apps/`:

```bash
mkdir apps/my-awesome-app
cd apps/my-awesome-app
touch index.js
```

Minimal app structure:

```javascript
// apps/my-awesome-app/index.js
export default {
  server: {
    setup(ctx) {
      // Initialize server-side state
    }
  },
  client: {
    render(ctx) {
      // Return renderable data
      return { position: ctx.entity.position }
    }
  }
}
```

That's it. The server will hot-reload your app when the file changes.

---

## App Structure

### File Organization

```
apps/my-app/
├── index.js              # Main app definition (required)
├── index.client.js       # Client-side only (optional)
├── models/               # 3D models directory (optional)
│   ├── model.glb
│   └── model.vrm
├── config.json           # Configuration file (optional)
└── helpers.js            # Utilities (optional)
```

### index.js Format

The `index.js` file must export a default object with optional `server` and `client` properties:

```javascript
export default {
  // Server-side logic
  server: {
    setup(ctx) { },
    update(ctx, dt) { },
    teardown(ctx) { },
    onMessage(ctx, msg) { }
  },
  
  // Client-side logic
  client: {
    setup(engine) { },
    onFrame(dt, engine) { },
    teardown(engine) { },
    onInput(input, engine) { },
    onEvent(payload, engine) { },
    render(ctx) { }
  }
}
```

---

## App Lifecycle

### Server Side

#### setup(ctx)
Called once when the app first spawns an entity. Initialize state, physics, timers, etc.

```javascript
setup(ctx) {
  // Initialize entity state
  ctx.state.health = 100
  ctx.state.mana = 50
  
  // Configure physics
  ctx.physics.setDynamic(true)
  ctx.physics.addBoxCollider([0.5, 1, 0.5])
  
  // Schedule repeating logic
  ctx.time.every(0.1, () => {
    ctx.state.health = Math.min(100, ctx.state.health + 0.5)
  })
  
  // Customize appearance
  ctx.entity.custom = { 
    mesh: 'box',
    color: 0xff0000
  }
}
```

#### update(ctx, dt)
Called every tick. Use for continuous logic.

```javascript
update(ctx, dt) {
  // Update position based on velocity
  const [x, y, z] = ctx.entity.position
  ctx.entity.position = [x + ctx.entity.velocity[0] * dt, y, z]
  
  // Check for nearby players
  const nearby = ctx.players.getNearest(ctx.entity.position, 5)
  if (nearby) {
    ctx.players.send(nearby.id, { type: 'greeting' })
  }
}
```

#### teardown(ctx)
Called when the entity is destroyed. Clean up resources, physics bodies, timers.

```javascript
teardown(ctx) {
  // Remove physics body if needed
  const ent = ctx._entity
  if (ent?._physicsBodyId && ctx._runtime?._physics) {
    ctx._runtime._physics.removeBody(ent._physicsBodyId)
  }
  
  // Clear state
  ctx.state.timers?.forEach(t => clearTimeout(t))
}
```

#### onMessage(ctx, msg)
Handle messages from clients or other apps.

```javascript
onMessage(ctx, msg) {
  if (msg.type === 'player_interact') {
    ctx.state.interactionCount = (ctx.state.interactionCount || 0) + 1
    ctx.network.broadcast({
      type: 'interact_response',
      count: ctx.state.interactionCount
    })
  }
}
```

### Client Side

#### setup(engine)
Initialize client state (DOM refs, three.js objects, etc).

```javascript
client: {
  setup(engine) {
    this.particleSystem = null
    this.audioListener = null
    this.hasRendered = false
  }
}
```

#### onFrame(dt, engine)
Called each render frame. Use for animation, input handling, visual updates.

```javascript
onFrame(dt, engine) {
  // Animate entity
  const ent = engine.client?.state?.entities?.find(e => e.app === 'my-app')
  if (ent) {
    ent.rotation[1] += 0.5 * dt
  }
}
```

#### onInput(input, engine)
Handle keyboard/gamepad input.

```javascript
onInput(input, engine) {
  if (input.forward) {
    this._movementDir = 1
  }
  if (input.interact) {
    this.sendInteraction()
  }
}
```

#### onEvent(payload, engine)
Handle messages from server.

```javascript
onEvent(payload, engine) {
  if (payload.type === 'health_changed') {
    this._updateHealthBar(payload.health)
  }
}
```

#### render(ctx)
Return the entity's visual representation. Called every frame.

```javascript
render(ctx) {
  return {
    position: ctx.entity.position,
    rotation: ctx.entity.rotation,
    custom: ctx.entity.custom,
    ui: this._buildUI(ctx)
  }
}
```

#### teardown(engine)
Cleanup client resources.

```javascript
teardown(engine) {
  this.particleSystem?.dispose()
  this.audioListener?.dispose()
}
```

---

## Context API (ctx)

Available properties and methods on the context object passed to server hooks:

### ctx.entity
The entity this app is attached to.

```javascript
ctx.entity.id              // string: unique ID
ctx.entity.position        // [x, y, z]: world position
ctx.entity.rotation        // [x, y, z, w]: quaternion
ctx.entity.scale           // [x, y, z]: scale
ctx.entity.velocity        // [vx, vy, vz]: velocity vector
ctx.entity.custom          // object: custom rendering data
ctx.entity.model           // string: model path
ctx.entity.parent          // parent entity or null
ctx.entity.children        // [entities]: child entities
ctx.entity.worldTransform  // matrix: world transform
ctx.entity.destroy()       // function: destroy this entity
```

### ctx.state
Mutable object for storing app state. Persists across updates.

```javascript
ctx.state.health = 100
ctx.state.inventory = new Map()
ctx.state.timers = []
// All changes are automatically synchronized
```

### ctx.physics
Control physics for this entity.

```javascript
ctx.physics.setStatic(true)           // Static body
ctx.physics.setDynamic(true)          // Dynamic body
ctx.physics.setKinematic(true)        // Kinematic body
ctx.physics.setMass(10)               // Set mass in kg
ctx.physics.addBoxCollider([0.5, 1, 0.5])    // Box half-extents
ctx.physics.addSphereCollider(0.5)    // Sphere radius
ctx.physics.addCapsuleCollider(0.3, 1.8)    // Radius and height
ctx.physics.addForce([fx, fy, fz])    // Apply force
ctx.physics.setVelocity([vx, vy, vz]) // Set velocity directly
ctx.raycast(origin, direction, maxDist)  // Cast ray, returns hit info
```

### ctx.world
Access and manipulate world state.

```javascript
ctx.world.spawn(id, config)           // Spawn new entity
ctx.world.destroy(id)                 // Destroy entity
ctx.world.getEntity(id)               // Get entity by ID
ctx.world.query(filter)               // Query entities
ctx.world.nearby(pos, radius)         // Get nearby entities
ctx.world.attach(eid, appName)        // Attach app to entity
ctx.world.detach(eid)                 // Detach app from entity
ctx.world.reparent(eid, parentId)     // Change parent
ctx.world.gravity                     // [0, -9.81, 0]
```

### ctx.players
Access and communicate with players.

```javascript
ctx.players.getAll()                  // Get all connected players
ctx.players.getNearest(pos, radius)   // Get nearest player
ctx.players.send(playerId, msg)       // Send message to player
ctx.players.broadcast(msg)            // Send to all players
ctx.players.setPosition(playerId, pos)// Move player
```

### ctx.time
Scheduling and timing.

```javascript
ctx.time.tick                         // Current tick number
ctx.time.deltaTime                    // Delta time in seconds
ctx.time.elapsed                      // Total elapsed time
ctx.time.after(seconds, fn)           // Call function once after delay
ctx.time.every(seconds, fn)           // Call function repeatedly
```

### ctx.network
Send network messages.

```javascript
ctx.network.broadcast(msg)            // Broadcast to all players
ctx.network.sendTo(playerId, msg)     // Send to specific player
```

### ctx.bus
Publish/subscribe event bus.

```javascript
ctx.bus.publish('my_event', { data })
ctx.bus.subscribe('other_event', callback)
```

### ctx.storage
Persistent key-value storage (file-based).

```javascript
ctx.storage.set('key', value)
ctx.storage.get('key')
ctx.storage.has('key')
ctx.storage.delete('key')
ctx.storage.list(prefix)
```

### ctx.config
Configuration passed when entity was spawned.

```javascript
// When spawned with: spawn(id, { config: { difficulty: 'hard' } })
ctx.config.difficulty  // 'hard'
```

### ctx.debug
Debugging output.

```javascript
ctx.debug.log('message')
ctx.debug.warn('warning')
ctx.debug.error('error')
```

### ctx._entity, ctx._runtime
Internal references (for advanced use only).

---

## Common Patterns

### Pattern 1: Interactive Object

An object that responds when players interact with it.

```javascript
export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = {
        mesh: 'box',
        color: 0x00ff00,
        label: 'INTERACT'
      }
      ctx.physics.setStatic(true)
      ctx.physics.addBoxCollider([0.5, 0.5, 0.5])
      ctx.state.interactionCount = 0
    },

    update(ctx, dt) {
      const nearby = ctx.players.getNearest(ctx.entity.position, 3)
      if (nearby?.state?.interact) {
        ctx.state.interactionCount++
        ctx.network.broadcast({
          type: 'object_used',
          count: ctx.state.interactionCount
        })
      }
    }
  },

  client: {
    render(ctx) {
      const custom = { ...ctx.entity.custom }
      const dist = Math.hypot(
        ctx.entity.position[0] - ctx.localPlayer.position[0],
        ctx.entity.position[2] - ctx.localPlayer.position[2]
      )
      
      if (dist < 3) {
        custom.glow = true
        custom.glowColor = 0x00ff00
      }
      
      return {
        position: ctx.entity.position,
        custom
      }
    }
  }
}
```

### Pattern 2: Spawner

Spawns entities at regular intervals.

```javascript
const CONFIG = {
  spawnInterval: 5,
  maxEntities: 10,
  entityType: 'enemy'
}

export default {
  server: {
    setup(ctx) {
      ctx.state.entities = new Set()
      ctx.state.nextId = 0
      
      ctx.time.every(CONFIG.spawnInterval, () => {
        if (ctx.state.entities.size >= CONFIG.maxEntities) return
        
        const id = `${ctx.entity.id}_entity_${ctx.state.nextId++}`
        const pos = [
          ctx.entity.position[0] + Math.random() * 4 - 2,
          ctx.entity.position[1] + 1,
          ctx.entity.position[2] + Math.random() * 4 - 2
        ]
        
        ctx.world.spawn(id, {
          position: pos,
          app: CONFIG.entityType
        })
        ctx.state.entities.add(id)
      })
    },

    onMessage(ctx, msg) {
      if (msg.type === 'entity_destroyed') {
        ctx.state.entities.delete(msg.entityId)
      }
    },

    teardown(ctx) {
      ctx.state.entities.forEach(id => ctx.world.destroy(id))
    }
  }
}
```

### Pattern 3: Visual-Only Decoration

No physics, just visual presentation.

```javascript
export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = {
        mesh: 'decorative_object.glb',
        scale: [1.5, 1.5, 1.5]
      }
    }
  },

  client: {
    setup(engine) {
      this.rotationSpeed = 0.5
    },

    onFrame(dt, engine) {
      // Animate rotation
      if (this.entity) {
        this.entity.rotation[1] += this.rotationSpeed * dt
      }
    },

    render(ctx) {
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: ctx.entity.custom
      }
    }
  }
}
```

### Pattern 4: Physics Object

Dynamic object affected by gravity and collisions.

```javascript
export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = { mesh: 'crate.glb', color: 0xaa6600 }
      ctx.physics.setDynamic(true)
      ctx.physics.setMass(5)
      ctx.physics.addBoxCollider([0.5, 0.5, 0.5])
    },

    update(ctx, dt) {
      // Physics body automatically updates position/rotation
      // Just sync it back to entity
      const ent = ctx._entity
      if (ent?._physicsBodyId && ctx._runtime?._physics) {
        const pw = ctx._runtime._physics
        ent.position = pw.getBodyPosition(ent._physicsBodyId)
        ent.rotation = pw.getBodyRotation(ent._physicsBodyId)
      }
    },

    teardown(ctx) {
      const ent = ctx._entity
      if (ent?._physicsBodyId && ctx._runtime?._physics) {
        ctx._runtime._physics.removeBody(ent._physicsBodyId)
        ent._physicsBodyId = null
      }
    }
  },

  client: {
    render(ctx) {
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: ctx.entity.custom
      }
    }
  }
}
```

### Pattern 5: Configurable App

Load configuration from spawn parameters or file.

```javascript
const DEFAULT_CONFIG = {
  color: 0xff0000,
  size: 1,
  health: 100,
  respawnTime: 5
}

export default {
  server: {
    setup(ctx) {
      // Merge default config with spawn config
      const config = { ...DEFAULT_CONFIG, ...ctx.config }
      ctx.state.config = config
      
      ctx.entity.custom = {
        mesh: 'box',
        color: config.color,
        sx: config.size,
        sy: config.size,
        sz: config.size
      }
      
      ctx.state.health = config.health
    },

    update(ctx, dt) {
      // Use config values
      if (ctx.state.health <= 0) {
        ctx.state.dead = true
        ctx.time.after(ctx.state.config.respawnTime, () => {
          ctx.state.health = ctx.state.config.health
          ctx.state.dead = false
        })
      }
    }
  }
}
```

---

## Best Practices

### 1. Keep Apps Focused
Each app should do one thing well. Split complex logic across multiple apps.

### 2. Use State for Persistence
Use `ctx.state` for data that should survive updates. Local variables in functions don't persist.

```javascript
// Good: state persists
setup(ctx) {
  ctx.state.health = 100
}

update(ctx) {
  ctx.state.health -= 5  // Remembered next tick
}

// Bad: resets every update
let health = 100
update(ctx) {
  health -= 5  // Forgotten next update
}
```

### 3. Clean Up on Teardown
Always clean up physics bodies, timers, listeners in `teardown()`.

### 4. Use Physics Correctly
- Static bodies for world geometry
- Dynamic for affected by gravity
- Kinematic for player-controlled movement
- Always remove bodies in teardown

### 5. Network Messages are Async
Messages from clients arrive via `onMessage()`. Plan for async behavior.

```javascript
// Bad: assumes immediate response
const damage = requestDamage()  // doesn't work
applyDamage(damage)

// Good: handle as message
onMessage(ctx, msg) {
  if (msg.type === 'take_damage') {
    applyDamage(msg.amount)
  }
}
```

### 6. Load Assets Correctly
Use `ctx._runtime.resolveAssetPath()'` for models/textures.

```javascript
const modelPath = ctx._runtime.resolveAssetPath('models/my-model.glb')
ctx.entity.model = modelPath
```

### 7. Avoid Blocking Code
Don't use `while` loops or synchronous waits. Use timers instead.

```javascript
// Bad
for (let i = 0; i < 1000000; i++) { }

// Good
ctx.time.every(0.1, () => {
  // This runs 10 times per second, non-blocking
})
```

---

## Asset Management

### Models
Place 3D models in an `models/` subdirectory:

```
apps/my-app/
└── models/
    ├── my-model.glb
    └── my-model.vrm
```

Reference in custom render data:

```javascript
ctx.entity.custom = {
  model: 'models/my-model.glb'  // relative to app dir
}
```

### Configuration Files
Store config in a `config.json`:

```json
{
  "spawnInterval": 5,
  "maxEntities": 10,
  "colors": {
    "primary": "0xff0000",
    "secondary": "0x00ff00"
  }
}
```

Load in your app:

```javascript
import config from './config.json' assert { type: 'json' }

export default {
  server: {
    setup(ctx) {
      ctx.state.spawnInterval = config.spawnInterval
    }
  }
}
```

---

## Debugging

### Debug Output
Use `ctx.debug` for logging:

```javascript
ctx.debug.log('Entity spawned at', ctx.entity.position)
ctx.debug.warn('Health critically low:', ctx.state.health)
ctx.debug.error('Physics body not found')
```

### Inspect State
Access internal state through `ctx._entity` and `ctx._runtime`:

```javascript
// Not recommended for production, but useful for debugging
console.log('Full entity:', ctx._entity)
console.log('All entities:', ctx._runtime.entities)
console.log('All apps:', ctx._runtime.apps)
```

### Test Locally
Run the server and connect to `localhost:3001` to test your app in real-time. Changes to `index.js` hot-reload automatically.

---

## Troubleshooting

### App isn't loading
Check the console for errors. Verify `index.js` exports a valid object.

### Physics not working
Make sure you call `addBoxCollider()`, `addSphereCollider()`, etc. in `setup()`.

### State not persisting
Use `ctx.state` instead of module-level variables. State is only synchronized through `ctx.state`.

### Players not receiving messages
Use `ctx.network.broadcast()` or `ctx.players.send()`. Messages go through WebSocket.

### Entity stuck in floor
Adjust collider size and position. Use `ctx.entity.position = [x, y, z]` to move it up.

---

## Advanced Topics

### Hot Reloading
The system automatically reloads your app when `index.js` changes. State is preserved when possible.

### Entity Parenting
Create hierarchical entity structures:

```javascript
ctx.world.spawn('child', { parent: ctx.entity.id })
const parent = ctx.entity.parent
const children = ctx.entity.children
```

### Event Bus
Publish events across apps:

```javascript
// In one app
ctx.bus.publish('enemy_defeated', { enemyId: 'e123' })

// In another app
ctx.bus.subscribe('enemy_defeated', (event) => {
  console.log('Enemy defeated:', event.data.enemyId)
})
```

### Custom Entity Properties
Add arbitrary data to entities:

```javascript
ctx.entity.custom = {
  mesh: 'box',
  color: 0xff0000,
  // Custom properties
  isOnFire: true,
  damagePerSecond: 5,
  fireColor: 0xff6600
}
```

---

## Examples

See the `apps/` directory for complete examples:
- `physics-crate` - Dynamic physics object
- `interactable` - Interactive object with messaging
- `power-crate` - Spawner with configuration
- `tps-game` - Complex game with weapons, respawning, etc.

---

## API Quick Reference

### Server Hooks
- `setup(ctx)` - Initialize on spawn
- `update(ctx, dt)` - Called every tick
- `teardown(ctx)` - Clean up on destroy
- `onMessage(ctx, msg)` - Handle messages

### Client Hooks
- `setup(engine)` - Initialize
- `onFrame(dt, engine)` - Called every render frame
- `onInput(input, engine)` - Handle input
- `onEvent(payload, engine)` - Handle server messages
- `render(ctx)` - Return renderable data
- `teardown(engine)` - Clean up

### Context Objects
- `ctx.entity` - Entity reference
- `ctx.state` - Persistent state
- `ctx.physics` - Physics control
- `ctx.world` - World query/spawn
- `ctx.players` - Player interaction
- `ctx.time` - Scheduling
- `ctx.network` - Broadcasting
- `ctx.storage` - Persistence
- `ctx.config` - Spawn config
- `ctx.debug` - Logging

---

## Next Steps

1. Pick an existing app to study (`physics-crate` is simplest)
2. Create your own directory in `apps/`
3. Copy the template and modify it
4. Run `npm start` and connect to `localhost:3001`
5. Watch hot reloads as you edit
6. Check console for errors
