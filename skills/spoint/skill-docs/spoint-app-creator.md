# Spawnpoint App Creator Skill

A comprehensive skill for creating and managing spawnpoint apps.

## Quick Start

```bash
# Create a new app from template
spoint-create-app my-awesome-app
spoint-create-app --template physics my-physics-object
spoint-create-app --template interactive my-interactable
```

## What This Skill Provides

### 1. CLI Command: `spoint-create-app`

Located at: `bin/create-app.js`

Creates new apps with automatic scaffolding:

```bash
spoint-create-app [options] <app-name>

Options:
  --template <type>   Template: simple, physics, interactive, spawner
  --help              Show help

Examples:
  spoint-create-app my-game
  spoint-create-app --template physics bouncy-ball
  spoint-create-app --template spawner npc-spawner
```

**Available Templates:**
- **simple** - Basic box with static physics (good starting point)
- **physics** - Dynamic object affected by gravity (rigidbodies)
- **interactive** - Object that responds to player interaction
- **spawner** - Spawns other entities at intervals

### 2. Comprehensive Documentation

#### skill-docs/spoint-app-creation.md
Complete guide covering:
- App lifecycle and hooks (setup, update, teardown)
- Context API reference (ctx.entity, ctx.physics, ctx.world, etc.)
- Common patterns (interactive objects, spawners, physics bodies)
- Best practices
- Asset management
- Debugging tips
- ~800 lines of detailed documentation

#### EXAMPLES.md
Working code examples:
- Health system
- Projectile system
- Loot drops
- Environmental hazards
- Interactive objects
- Ability triggers

### 3. App Structure

Each app is a directory with:

```
apps/my-app/
├── index.js              # Main app code (required)
├── models/               # 3D models (optional)
│   └── model.glb
└── config.json          # Configuration (optional)
```

### 4. App Anatomy

Every app exports default configuration:

```javascript
export default {
  server: {
    setup(ctx) {
      // Initialize on spawn
      ctx.entity.custom = { mesh: 'box', color: 0x00ff00 }
      ctx.physics.setStatic(true)
      ctx.physics.addBoxCollider([0.5, 0.5, 0.5])
    },

    update(ctx, dt) {
      // Called every tick for continuous logic
      const nearby = ctx.players.getNearest(ctx.entity.position, 5)
      if (nearby) {
        ctx.network.broadcast({ type: 'hello' })
      }
    },

    teardown(ctx) {
      // Cleanup on destroy
      ctx.state.timers?.forEach(t => clearTimeout(t))
    },

    onMessage(ctx, msg) {
      // Handle messages from clients
      if (msg.type === 'interact') {
        ctx.state.interactionCount++
      }
    }
  },

  client: {
    setup(engine) {
      // Initialize client-side state
      this.lastMessage = null
    },

    onFrame(dt, engine) {
      // Called every render frame
    },

    onInput(input, engine) {
      // Handle keyboard/gamepad input
    },

    onEvent(payload, engine) {
      // Handle messages from server
    },

    render(ctx) {
      // Return visual representation
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: ctx.entity.custom,
        ui: this.buildUI(ctx)
      }
    },

    teardown(engine) {
      // Cleanup client resources
    }
  }
}
```

## Context API (What's Available Inside Apps)

### ctx.entity
```javascript
ctx.entity.id                 // Unique identifier
ctx.entity.position           // [x, y, z]
ctx.entity.rotation           // [x, y, z, w] quaternion
ctx.entity.scale              // [x, y, z]
ctx.entity.velocity           // [vx, vy, vz]
ctx.entity.custom             // Custom render data
ctx.entity.model              // Model file path
ctx.entity.parent             // Parent entity or null
ctx.entity.children           // Child entities array
ctx.entity.worldTransform     // World space matrix
ctx.entity.destroy()          // Destroy this entity
```

### ctx.state
Persistent mutable object - survives updates and hot-reloads:
```javascript
ctx.state.health = 100
ctx.state.inventory = new Map()
ctx.state.timers = []
```

### ctx.physics
```javascript
ctx.physics.setStatic(true)              // Static body
ctx.physics.setDynamic(true)             // Dynamic (affected by gravity)
ctx.physics.setKinematic(true)           // Kinematic (player-controlled)
ctx.physics.setMass(10)                  // Mass in kg
ctx.physics.addBoxCollider([0.5, 1, 0.5])
ctx.physics.addSphereCollider(0.5)
ctx.physics.addCapsuleCollider(0.3, 1.8)
ctx.physics.addForce([fx, fy, fz])
ctx.physics.setVelocity([vx, vy, vz])
ctx.raycast(origin, direction, maxDist)
```

### ctx.world
```javascript
ctx.world.spawn(id, config)     // Create entity
ctx.world.destroy(id)            // Destroy entity
ctx.world.getEntity(id)          // Get by ID
ctx.world.query(filter)          // Query entities
ctx.world.nearby(pos, radius)    // Get nearby entities
ctx.world.attach(eid, appName)   // Attach app to entity
ctx.world.detach(eid)            // Remove app
ctx.world.gravity                // [0, -9.81, 0]
```

### ctx.players
```javascript
ctx.players.getAll()                      // Get all players
ctx.players.getNearest(pos, radius)       // Closest player
ctx.players.send(playerId, msg)           // Send to player
ctx.players.broadcast(msg)                // Send to all
ctx.players.setPosition(playerId, pos)    // Move player
```

### ctx.time
```javascript
ctx.time.tick                    // Current tick
ctx.time.deltaTime               // Delta in seconds
ctx.time.elapsed                 // Total elapsed
ctx.time.after(seconds, fn)      // One-time callback
ctx.time.every(seconds, fn)      // Repeating callback
```

### Other Context Properties
```javascript
ctx.network.broadcast(msg)       // Network broadcast
ctx.network.sendTo(id, msg)      // Send to player
ctx.bus.publish(event, data)     // Event bus publish
ctx.bus.subscribe(event, cb)     // Event bus subscribe
ctx.storage.get/set/has/list()  // File-based storage
ctx.config                       // Spawn config
ctx.debug.log/warn/error()       // Logging
```

## Common Patterns

### Pattern 1: Simple Interactive Object

```javascript
export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = { mesh: 'box', color: 0x00ff00, label: 'INTERACT' }
      ctx.physics.setStatic(true)
      ctx.physics.addBoxCollider([0.5, 0.5, 0.5])
      ctx.state.interactionCount = 0
    },

    update(ctx, dt) {
      const nearby = ctx.players.getNearest(ctx.entity.position, 3)
      if (nearby?.state?.interact) {
        ctx.state.interactionCount++
        ctx.network.broadcast({
          type: 'interacted',
          count: ctx.state.interactionCount
        })
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

### Pattern 2: Spawner

```javascript
export default {
  server: {
    setup(ctx) {
      ctx.state.entities = new Set()
      ctx.state.nextId = 0

      ctx.time.every(5, () => {
        if (ctx.state.entities.size >= 10) return
        const id = `spawned_${ctx.state.nextId++}`
        ctx.world.spawn(id, {
          position: [ctx.entity.position[0] + Math.random() * 4 - 2, ctx.entity.position[1] + 2, ctx.entity.position[2] + Math.random() * 4 - 2],
          app: 'physics-crate'
        })
        ctx.state.entities.add(id)
      })
    },

    teardown(ctx) {
      ctx.state.entities.forEach(id => ctx.world.destroy(id))
    }
  }
}
```

### Pattern 3: Physics Object

```javascript
export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = { mesh: 'box', color: 0xff8800 }
      ctx.physics.setDynamic(true)
      ctx.physics.setMass(5)
      ctx.physics.addBoxCollider([0.5, 0.5, 0.5])
    },

    update(ctx, dt) {
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

## Lifecycle Hooks

### Server Hooks

**setup(ctx)** - Called once when entity spawns
- Initialize state
- Setup physics
- Schedule timers

**update(ctx, dt)** - Called every tick
- Continuous logic
- Movement, animations
- Check for nearby players/objects

**teardown(ctx)** - Called when entity destroyed
- Clean up physics bodies
- Clear timers
- Release resources

**onMessage(ctx, msg)** - Receive client messages
- Handle interactions
- Process input
- Respond to events

### Client Hooks

**setup(engine)** - Initialize client state
- DOM references
- Three.js objects
- Audio listeners

**onFrame(dt, engine)** - Called each render frame
- Animate entities
- Update visuals
- Handle frame logic

**onInput(input, engine)** - Keyboard/gamepad input
- Movement input
- Action buttons
- Special inputs

**onEvent(payload, engine)** - Receive server messages
- UI updates
- Audio cues
- Visual effects

**render(ctx)** - Return visual representation
- Position/rotation
- Custom properties
- UI elements

**teardown(engine)** - Cleanup client resources
- Stop animations
- Clear listeners
- Dispose objects

## Best Practices

1. **Use ctx.state for Persistence**
   - Module variables reset on hot-reload
   - Use ctx.state for data that must survive

2. **Clean Up in teardown()**
   - Remove physics bodies
   - Cancel timers
   - Clear listeners

3. **Use Physics Correctly**
   - Static: world geometry
   - Dynamic: gravity-affected
   - Kinematic: player-controlled

4. **Non-Blocking Code**
   - Use ctx.time.every() instead of loops
   - Use ctx.time.after() for delays
   - Avoid blocking operations

5. **Network Messages are Async**
   - Messages arrive via onMessage()
   - Use ctx.network.broadcast() to send
   - Plan for network latency

6. **Keep Apps Focused**
   - One responsibility per app
   - Compose complex behavior from multiple apps
   - Reuse existing apps

7. **Use Asset Paths Correctly**
   - Reference models relative to app dir
   - Use ctx._runtime.resolveAssetPath() for lookup

## File Locations

- **CLI Command**: `bin/create-app.js`
- **Guide**: `skill-docs/spoint-app-creation.md`
- **Examples**: `EXAMPLES.md`
- **Existing Apps**: `apps/`
- **Your Apps**: Create new directories in `apps/`

## Getting Started

1. **Read the Guide**
   `skill-docs/spoint-app-creation.md`

2. **Study Examples**
   - `apps/physics-crate` - Simplest example
   - `apps/interactable` - Interactive pattern
   - `apps/power-crate` - Spawner pattern
   - `apps/tps-game` - Complex multiplayer

3. **Create Your App**
   ```bash
   spoint-create-app my-first-app
   ```

4. **Start Server**
   ```bash
   npm start
   ```

5. **Connect**
   Open http://localhost:3001 in browser

6. **Spawn Your App**
   Create entity with app: "my-first-app"

7. **Edit & Iterate**
   Changes hot-reload automatically

## Documentation Files

- **skill-docs/spoint-app-creation.md** - Complete reference (~800 lines)
- **EXAMPLES.md** - Working code examples
- **README.md** - Quick start (updated)
- **apps/** - Existing app implementations

## Support

- Check console for error messages
- Use `ctx.debug.log()` for debugging
- Study existing apps for patterns
- Refer to Context API section above

