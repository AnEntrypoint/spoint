# Spawnpoint App Creator Skill

A complete development toolkit for creating new Spawnpoint apps with CLI scaffolding, comprehensive documentation, and working examples.

## Overview

This skill makes it fast and easy to create new apps for Spawnpoint. Everything from scaffolding to advanced patterns is covered.

**Time to create first app**: < 1 minute
**Learning curve**: Beginners to advanced
**Documentation**: 1,800+ lines across 3 files

## Quick Start

### 1. Create App
```bash
spoint-create-app my-first-app
```

### 2. Start Server
```bash
npm start
```

### 3. Open Browser
http://localhost:3001

### 4. Spawn Entity
Create new entity with app: `my-first-app`

### 5. Edit & Iterate
Edit `apps/my-first-app/index.js` - changes hot-reload automatically!

## What You Get

### CLI Command: `spoint-create-app`

Creates new apps from templates in seconds.

```bash
# Default (simple box)
spoint-create-app my-app

# Physics-based object
spoint-create-app --template physics my-ball

# Interactive button/chest
spoint-create-app --template interactive my-button

# Entity spawner
spoint-create-app --template spawner my-spawner

# Show help
spoint-create-app --help
```

### 4 App Templates

**1. Simple** (Default)
- Basic box entity
- Static physics
- Perfect starting point
- 30 lines of boilerplate

**2. Physics**
- Dynamic rigidbody
- Gravity affects it
- Auto physics sync
- Proper cleanup

**3. Interactive**
- Detects nearby players
- Responds to interaction input
- Server/client messaging
- UI feedback on client

**4. Spawner**
- Spawns child entities
- Manages entity pool
- Configurable spawn rate
- Cleanup on destroy

### 3 Documentation Files

#### 1. skill-docs/spoint-app-creator.md (11 KB)
Quick reference guide covering:
- Usage examples
- Context API overview
- Common patterns
- Best practices
- Troubleshooting

Perfect for: Quick lookups, refreshing memory

#### 2. skill-docs/spoint-app-creation.md (19 KB)
Comprehensive 800+ line guide:
- Complete lifecycle documentation
- Detailed context API reference with examples
- 5+ working code patterns
- Advanced topics
- Asset management
- Debugging guide
- Complete API Quick Reference

Perfect for: Learning, deep dives, advanced use

#### 3. EXAMPLES.md (11 KB)
Working code examples:
- Health system with damage/healing
- Projectile with collision detection
- Loot drops with pickup
- Environmental hazards
- Interactive objects
- Each example fully commented

Perfect for: Learning by example, copy-paste starting points

## Core Concepts

### App Structure
```javascript
export default {
  server: {
    setup(ctx) { },      // Initialize
    update(ctx, dt) { },  // Per-tick logic
    teardown(ctx) { },    // Cleanup
    onMessage(ctx, msg) { }  // Message handler
  },
  client: {
    setup(engine) { },
    onFrame(dt, engine) { },
    onInput(input, engine) { },
    onEvent(payload, engine) { },
    render(ctx) { },
    teardown(engine) { }
  }
}
```

### Context API (What's Available)

**Entity & Rendering**
```javascript
ctx.entity.position          // [x, y, z]
ctx.entity.rotation          // [x, y, z, w] quaternion
ctx.entity.scale             // [x, y, z]
ctx.entity.custom            // Custom render data
ctx.entity.velocity          // Current velocity
ctx.entity.parent            // Parent entity
ctx.entity.children          // Child entities
ctx.entity.destroy()         // Destroy entity
```

**Persistent State**
```javascript
ctx.state = { }              // Persists across updates & hot-reload
```

**Physics**
```javascript
ctx.physics.setStatic(true)                // Static body
ctx.physics.setDynamic(true)               // Dynamic (gravity)
ctx.physics.setKinematic(true)             // Kinematic (player-controlled)
ctx.physics.setMass(5)                     // Set mass
ctx.physics.addBoxCollider([0.5, 1, 0.5])  // Box collider
ctx.physics.addSphereCollider(0.5)         // Sphere collider
ctx.physics.addCapsuleCollider(0.3, 1.8)   // Capsule collider
ctx.physics.addForce([x, y, z])            // Apply force
ctx.physics.setVelocity([x, y, z])         // Set velocity
ctx.raycast(origin, dir, maxDist)          // Raycast query
```

**World Access**
```javascript
ctx.world.spawn(id, config)         // Create entity
ctx.world.destroy(id)               // Destroy entity
ctx.world.getEntity(id)             // Get by ID
ctx.world.query(filter)             // Query all matching
ctx.world.nearby(pos, radius)       // Get nearby entities
```

**Player Interaction**
```javascript
ctx.players.getAll()                // All connected players
ctx.players.getNearest(pos, radius) // Closest player
ctx.players.send(id, msg)           // Send to player
ctx.players.broadcast(msg)          // Send to all
ctx.players.setPosition(id, pos)    // Move player
```

**Timing**
```javascript
ctx.time.tick                       // Current tick number
ctx.time.deltaTime                  // Delta time (seconds)
ctx.time.elapsed                    // Total elapsed time
ctx.time.after(seconds, fn)         // Call once after delay
ctx.time.every(seconds, fn)         // Call repeatedly
```

**Networking & Storage**
```javascript
ctx.network.broadcast(msg)          // Broadcast to all players
ctx.network.sendTo(id, msg)         // Send to specific player
ctx.storage.get/set/has/delete(key) // Persistent storage
ctx.bus.publish/subscribe()         // Event bus
ctx.debug.log/warn/error()          // Logging
```

### Lifecycle Hooks

**Server Hooks**
- `setup(ctx)` - Called once on spawn
- `update(ctx, dt)` - Called every tick
- `teardown(ctx)` - Called on destroy
- `onMessage(ctx, msg)` - Receive messages

**Client Hooks**
- `setup(engine)` - Initialize client
- `onFrame(dt, engine)` - Each render frame
- `onInput(input, engine)` - Keyboard/gamepad
- `onEvent(payload, engine)` - Server messages
- `render(ctx)` - Return visual data
- `teardown(engine)` - Cleanup

## Common Patterns

### Pattern 1: Interactive Object
```javascript
export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = { mesh: 'box', color: 0x00ff00 }
      ctx.physics.setStatic(true)
      ctx.physics.addBoxCollider([0.5, 0.5, 0.5])
    },
    update(ctx, dt) {
      const nearby = ctx.players.getNearest(ctx.entity.position, 3)
      if (nearby?.state?.interact) {
        ctx.network.broadcast({ type: 'interacted' })
      }
    }
  },
  client: {
    render(ctx) {
      return { position: ctx.entity.position, custom: ctx.entity.custom }
    }
  }
}
```

### Pattern 2: Physics Object
```javascript
export default {
  server: {
    setup(ctx) {
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
      if (ent?._physicsBodyId) {
        ctx._runtime._physics.removeBody(ent._physicsBodyId)
      }
    }
  },
  client: {
    render(ctx) {
      return { position: ctx.entity.position, rotation: ctx.entity.rotation, custom: ctx.entity.custom }
    }
  }
}
```

### Pattern 3: Spawner
```javascript
export default {
  server: {
    setup(ctx) {
      ctx.state.entities = new Set()
      ctx.time.every(5, () => {
        if (ctx.state.entities.size < 10) {
          const id = 'entity_' + Math.random()
          ctx.world.spawn(id, {
            position: [ctx.entity.position[0] + Math.random() * 4 - 2, ctx.entity.position[1] + 2, ctx.entity.position[2]],
            app: 'physics-crate'
          })
          ctx.state.entities.add(id)
        }
      })
    },
    teardown(ctx) {
      ctx.state.entities.forEach(id => ctx.world.destroy(id))
    }
  }
}
```

See EXAMPLES.md for 5+ more working examples with full comments.

## File Structure

```
C:/dev/devbox/spawnpoint/
├── bin/
│   └── create-app.js                    # CLI command
├── skill-docs/
│   ├── spoint-app-creator.md            # Quick reference
│   └── spoint-app-creation.md           # Complete guide
├── EXAMPLES.md                          # Code examples
├── SKILL.md                             # This skill definition
├── apps/
│   ├── my-first-app/                    # Your app here
│   │   └── index.js
│   ├── physics-crate/                   # Examples to study
│   ├── interactable/
│   ├── power-crate/
│   └── tps-game/
└── package.json                         # Updated with CLI
```

## Best Practices

### 1. Use ctx.state for Persistence
```javascript
// Good - persists across updates
ctx.state.health = 100

// Bad - resets every update
let health = 100
```

### 2. Clean Up on Teardown
```javascript
teardown(ctx) {
  const ent = ctx._entity
  if (ent?._physicsBodyId) {
    ctx._runtime._physics.removeBody(ent._physicsBodyId)
  }
}
```

### 3. Use Non-Blocking Code
```javascript
// Good
ctx.time.every(0.1, () => { /* runs 10 times/sec */ })

// Bad
for (let i = 0; i < 1000000; i++) { /* blocks! */ }
```

### 4. Keep Apps Focused
- One responsibility per app
- Compose complex behavior from multiple apps
- Reuse existing apps

### 5. Handle Async Messaging
```javascript
// Messages are async - handle in onMessage()
onMessage(ctx, msg) {
  if (msg.type === 'take_damage') {
    ctx.state.health -= msg.amount
  }
}
```

## Documentation Map

| File | Size | Content | Best For |
|------|------|---------|----------|
| skill-docs/spoint-app-creator.md | 11 KB | Quick reference, examples, patterns | Quick lookups |
| skill-docs/spoint-app-creation.md | 19 KB | Complete guide, full API, advanced topics | Learning |
| EXAMPLES.md | 11 KB | 5+ working code examples | Copy-paste starting points |
| SKILL.md | 9 KB | Skill definition and overview | Understanding scope |

**Total**: 41 KB of comprehensive documentation + 338 line CLI tool

## Troubleshooting

### App not loading?
Check browser console and server logs for errors in index.js

### Physics not working?
Make sure to call `ctx.physics.add*Collider()` in setup()

### State not persisting?
Use `ctx.state` instead of module-level variables

### Messages not arriving?
Use `ctx.network.broadcast()` or `ctx.players.send()` - messages go through WebSocket

### Performance issues?
- Reduce check intervals
- Use `ctx.world.nearby()` instead of full entity scans
- Keep update() fast

## Examples to Study

Learn by reading existing apps:
- `apps/physics-crate` - Simplest app (physics object)
- `apps/interactable` - Interactive pattern
- `apps/power-crate` - Spawner pattern
- `apps/tps-game` - Complex multiplayer game

## Next Steps

1. **Read the Skill Overview**
   Read: skill-docs/spoint-app-creator.md (this file)

2. **Study an Example App**
   Read: apps/physics-crate/index.js

3. **Create Your First App**
   `spoint-create-app my-awesome-app`

4. **Start the Server**
   `npm start`

5. **Open in Browser**
   http://localhost:3001

6. **Spawn Your App**
   Create entity with app: "my-awesome-app"

7. **Edit and Iterate**
   Changes to index.js hot-reload automatically

8. **For Deep Dive**
   Read: skill-docs/spoint-app-creation.md (800 lines)

9. **Copy Working Patterns**
   Reference: EXAMPLES.md

## Support

- **Quick questions**: skill-docs/spoint-app-creator.md
- **Deep learning**: skill-docs/spoint-app-creation.md
- **Code examples**: EXAMPLES.md
- **API reference**: See "Context API" section above
- **Real code**: Check apps/ directory

## Summary

This skill provides:
- ✓ CLI tool for instant scaffolding (`spoint-create-app`)
- ✓ 4 working templates (simple, physics, interactive, spawner)
- ✓ 1,800+ lines of documentation
- ✓ 5+ complete working examples
- ✓ Full context API reference
- ✓ Best practices and patterns
- ✓ Troubleshooting guide
- ✓ Integration with package.json

Everything you need to build Spawnpoint apps, from quick prototypes to complex systems.

---

**Created**: 2026-02-21
**Total Lines of Code**: 1,800+ (documentation + CLI)
**Templates**: 4
**Examples**: 5+
**Documentation Files**: 3
**Time to First App**: < 1 minute
