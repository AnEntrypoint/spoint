# Skill: spoint-app-creator

**Status**: Complete and Ready

Create new Spawnpoint apps with templates, CLI scaffolding, and comprehensive documentation.

## Usage

```bash
# Create a new app
spoint-create-app my-app

# Create with specific template
spoint-create-app --template physics bouncy-ball
spoint-create-app --template interactive chest
spoint-create-app --template spawner enemy-spawner

# Show help
spoint-create-app --help
```

## What's Included

### 1. CLI Tool
- **Location**: `bin/create-app.js`
- **Entry in package.json**: `spoint-create-app`
- **Templates**: simple, physics, interactive, spawner
- **Features**: Auto-scaffolding, intelligent defaults

### 2. Documentation (3 Files)

**A. skill-docs/spoint-app-creator.md** (11KB)
- Quick reference guide
- Context API overview
- Common patterns
- Best practices

**B. skill-docs/spoint-app-creation.md** (19KB)
- Complete comprehensive guide (~800 lines)
- Detailed lifecycle documentation
- Full context API reference
- 5+ working patterns
- Troubleshooting guide
- Advanced topics

**C. EXAMPLES.md** (11KB)
- Health system with damage/healing
- Projectile system with collision
- Loot drops with pickup
- Environmental hazards
- Interactive objects
- Comments explaining each part

### 3. App Templates (4 Types)

**Simple** (default)
```
- Basic box entity
- Static physics
- Good starting point
- Minimal boilerplate
```

**Physics**
```
- Dynamic rigidbody
- Gravity affected
- Physics sync
- Teardown cleanup
```

**Interactive**
```
- Player interaction detection
- Server/client messaging
- Event broadcasting
- UI feedback
```

**Spawner**
```
- Spawns child entities
- Pool management
- Configurable count
- Cleanup on destroy
```

## Files Created

```
C:/dev/devbox/spawnpoint/
├── bin/
│   └── create-app.js                    # CLI command
├── skill-docs/
│   ├── spoint-app-creator.md            # Quick reference (11KB)
│   └── spoint-app-creation.md           # Full guide (19KB)
├── EXAMPLES.md                          # Code examples (11KB)
└── package.json                         # Updated with bin entry
```

## Quick Start Guide

### Step 1: Create App
```bash
spoint-create-app my-first-app
```

Creates: `apps/my-first-app/index.js`

### Step 2: Start Server
```bash
npm start
```

Server runs on http://localhost:3001

### Step 3: Connect Browser
Open http://localhost:3001 in your browser

### Step 4: Spawn Entity
In the game console or via API:
```
api.spawn('entity1', { app: 'my-first-app' })
```

### Step 5: Edit App
Edit `apps/my-first-app/index.js`

Server hot-reloads automatically! No restart needed.

## Context API Reference

### Server-Side (ctx parameter)

**Entity & Position**
- ctx.entity.id, position, rotation, scale, velocity
- ctx.entity.custom (render properties)
- ctx.entity.model, parent, children
- ctx.entity.destroy()

**State & Config**
- ctx.state (mutable persistent object)
- ctx.config (spawn configuration)

**Physics**
- ctx.physics.setStatic/Dynamic/Kinematic
- ctx.physics.addBoxCollider/SphereCollider/CapsuleCollider
- ctx.physics.setMass, addForce, setVelocity
- ctx.physics.raycast()

**World**
- ctx.world.spawn(id, config)
- ctx.world.destroy(id)
- ctx.world.query(filter)
- ctx.world.nearby(pos, radius)
- ctx.world.getEntity(id)

**Players**
- ctx.players.getAll(), getNearest(pos, radius)
- ctx.players.send(id, msg), broadcast(msg)
- ctx.players.setPosition(id, pos)

**Timing**
- ctx.time.tick, deltaTime, elapsed
- ctx.time.after(seconds, fn)
- ctx.time.every(seconds, fn)

**Networking & Storage**
- ctx.network.broadcast(msg), sendTo(id, msg)
- ctx.storage.get/set/has/delete/list()
- ctx.bus.publish/subscribe()
- ctx.debug.log/warn/error()

### Client-Side (render ctx)

**Position & Rendering**
- ctx.entity.position, rotation
- ctx.entity.custom (all properties)
- ctx.h (hyperscript for UI)
- ctx.localPlayer

**Return from render()**
```javascript
{
  position: [x, y, z],
  rotation: [x, y, z, w],
  custom: { /* render props */ },
  ui: h('div', { /* UI elements */ })
}
```

## Common Patterns

### Pattern: Interactive Button
```javascript
export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = { mesh: 'box', color: 0x00ff00, label: 'INTERACT' }
      ctx.physics.setStatic(true)
      ctx.physics.addBoxCollider([0.5, 0.5, 0.5])
    },
    update(ctx, dt) {
      const near = ctx.players.getNearest(ctx.entity.position, 3)
      if (near?.state?.interact) {
        ctx.network.broadcast({ type: 'button_pressed' })
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

### Pattern: Spawner
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

### Pattern: Physics Object
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

- **setup(ctx)**: Initialize on spawn
  - Set up entity properties
  - Configure physics
  - Schedule timers
  
- **update(ctx, dt)**: Called every tick
  - Continuous logic
  - Check for nearby entities
  - Movement, animations

- **teardown(ctx)**: Cleanup on destroy
  - Remove physics bodies
  - Clear timers
  - Release resources

- **onMessage(ctx, msg)**: Handle messages
  - Player interactions
  - Input events
  - Network messages

### Client Hooks

- **setup(engine)**: Initialize client
  - Store references
  - Initialize UI

- **onFrame(dt, engine)**: Each render frame
  - Animations
  - Visual updates

- **onInput(input, engine)**: Keyboard/gamepad
  - Movement
  - Actions

- **onEvent(payload, engine)**: Server messages
  - UI updates
  - Effects

- **render(ctx)**: Return visual data
  - Position/rotation
  - Custom properties
  - UI elements

- **teardown(engine)**: Cleanup
  - Stop animations
  - Clear resources

## Best Practices

1. **Persistent State**: Use `ctx.state` not module variables
2. **Clean Teardown**: Always remove physics bodies
3. **Non-Blocking**: Use `ctx.time.every()` not loops
4. **Focused Apps**: One responsibility per app
5. **Network Async**: Messages arrive via onMessage()
6. **Asset Paths**: Relative to app directory
7. **Composition**: Reuse existing apps

## File Organization

```
apps/my-app/
├── index.js              # Main app code
├── models/               # 3D models
│   ├── model.glb
│   └── model.vrm
├── config.json          # Configuration
└── helpers.js           # Utility functions
```

## Debugging

### Check Console
- Browser console for client errors
- Server logs for server errors

### Use Debug Output
```javascript
ctx.debug.log('Message', value)
ctx.debug.warn('Warning')
ctx.debug.error('Error')
```

### Inspect State
```javascript
ctx.debug.log('State:', ctx.state)
ctx.debug.log('Entity:', ctx.entity)
ctx.debug.log('Nearby:', ctx.world.nearby(ctx.entity.position, 10))
```

## Troubleshooting

**App not loading?**
- Check console for errors
- Verify index.js exports default object

**Physics not working?**
- Call ctx.physics.add*Collider() in setup
- Check body type (static/dynamic/kinematic)

**State not persisting?**
- Use ctx.state instead of module variables
- Avoid reassigning ctx.state entirely

**No message from client?**
- Verify onMessage is implemented
- Check network.broadcast() vs send()

**Performance issues?**
- Reduce check intervals
- Use ctx.world.nearby() instead of full scans

## Documentation

See these files for more:
- **skill-docs/spoint-app-creator.md** - This file
- **skill-docs/spoint-app-creation.md** - Complete 800-line guide
- **EXAMPLES.md** - Working code examples
- **apps/** - Real app implementations to study

## Next Steps

1. Read: `skill-docs/spoint-app-creator.md` (this file)
2. Study: `apps/physics-crate` (simplest existing app)
3. Create: `spoint-create-app my-app`
4. Start: `npm start`
5. Spawn: Create entity with app: "my-app"
6. Iterate: Edit and hot-reload

## Summary

This skill provides everything needed to create spawnpoint apps:
- ✓ CLI tool for quick scaffolding
- ✓ 4 templates for different patterns
- ✓ 30+ KB of detailed documentation
- ✓ Working code examples
- ✓ Complete context API reference
- ✓ Best practices and patterns
- ✓ Troubleshooting guide

Create your first app in seconds, then customize it with full documentation support.
