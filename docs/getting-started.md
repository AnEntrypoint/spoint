# Getting Started with spoint

> **spoint** is a physics and netcode SDK for authoritative-server multiplayer games. Built on Jolt Physics, Three.js, and WebRTC/WebSocket transport.

---

## Quick Start

```bash
# Clone and install
git clone https://github.com/AnEntrypoint/spoint.git
cd spoint
npm install

# Start the server
npm start
# or: npx spoint
# or: WORLD=tps-game node server.js

# Open in browser
# Multiplayer (connects to server via WebSocket):
http://localhost:3001

# Singleplayer (runs server inside a Web Worker - same origin, no separate process):
http://localhost:3001/?singleplayer

# Select a different world:
http://localhost:3001/?singleplayer&world=matrix-construct
```

---

## Project Structure

```
spoint/
├── apps/                       # World definitions & game logic (apps)
│   ├── world/
│   │   ├── tps-game.js         # Main multiplayer world (default)
│   │   ├── matrix-construct.js # Matrix-style white room demo
│   │   └── sandbox.js          # Minimal test world
│   ├── tps-game/               # TPS game app (server + client)
│   ├── matrix-construct-room/  # Matrix construct room app
│   ├── placed-model/           # GLB model placement with colliders
│   ├── terrain/                # Procedural terrain with vegetation
│   └── ... (50+ built-in apps)
├── client/                     # Three.js client (browser)
│   ├── app.js                  # Entry point
│   ├── core/                   # Rendering, camera, VRM, physics sync
│   └── hud/                    # HUD widgets (chat, voice, emotes)
├── src/                        # Server SDK
│   ├── sdk/                    # Core systems (tick, physics, netcode)
│   ├── apps/                   # App runtime & loader
│   ├── physics/                # Jolt Physics wrapper
│   └── netcode/                # Rollback, lag compensation
├── server.js                   # Entry point (spawns TickHandler)
├── bin/create-app.js           # CLI: create new app template
└── scripts/                    # Build, export, check tools
```

---

## Creating a World

Worlds are defined in `apps/world/<name>.js`. Select with `WORLD=<name>` env var or `?world=<name>` query param.

### Minimal World (`apps/world/sandbox.js`)

```javascript
export default {
  spawnPoint: [0, 5, 0],
  gravity: [0, -9.81, 0],
  entities: [] // Empty - use SANDBOX_APP env to inject one app
}
```

Run: `WORLD=sandbox SANDBOX_APP=box-dynamic node server.js`

### Full World (`apps/world/matrix-construct.js`)

```javascript
const MATRIX_CONSTRUCT = {
  enabled: false,           // Disable procedural terrain
  timeOfDay: { serverAuthoritative: true, dayLengthSec: 600, startFraction: 0.5 },
  weather: { serverAuthoritative: true, type: 'clear', intensity: 0, particleCount: 0 },
  vegetation: { enabled: false }
}

export default {
  port: 3001,
  tickRate: 64,
  gravity: [0, -9.81, 0],
  movement: { maxSpeed: 7, sprintSpeed: 12, groundAccel: 300, airAccel: 30, friction: 5 },
  player: { health: 100, capsuleRadius: 0.28, capsuleHalfHeight: 0.63, modelScale: 1.323 },
  scene: { skyColor: 0xffffff, fogColor: 0xffffff, fogNear: 500, fogFar: 1000 },
  camera: { fov: 70, shoulderOffset: 0.35 },
  trustedApps: ['matrix-construct-room', 'tps-game'],
  entities: [
    { id: 'terrain', app: 'terrain', config: MATRIX_CONSTRUCT },
    { id: 'matrix-room', app: 'matrix-construct-room', position: [0, 0, 0] },
    { id: 'tps-game', position: [0, 0, 0], app: 'tps-game' }
  ],
  spawnPoint: [0, 2, 0],
  playerModel: './apps/tps-game/cleetus.vrm'
}
```

Run: `WORLD=matrix-construct node server.js`

---

## Creating an App

Apps live in `apps/<name>/index.js` and export a default object with optional `server` and `client` sections.

### Generate a Template

```bash
# Basic static entity
npx spoint-create-app my-app

# Or pick a template: simple, physics, interactive, spawner, fsm-game
npx spoint-create-app --template simple my-app
npx spoint-create-app --template physics my-physics-box
npx spoint-create-app --template interactive my-button
npx spoint-create-app --template spawner my-spawner
npx spoint-create-app --template fsm-game my-match
```

### Available Templates

| Template | Purpose | Includes |
|----------|---------|----------|
| **simple** | Static entity, basic setup | mesh, collider, update stub |
| **physics** | Dynamic body with collision tracking | mass, dynamic collider, onCollide handler |
| **interactive** | Press-E interaction primitive | interactable, radius, onInteract handler |
| **spawner** | Entity spawner on timer | spawn loop, max entities, despawn cleanup |
| **fsm-game** | Game state machine | waiting/countdown/active/roundEnd/done phases |

All templates include:
- Description and editor properties
- TODO comments for extension points
- Server setup/update/teardown lifecycle
- Client render and state management
- Hot-reload support (edit `apps/<name>/index.js`, server auto-reloads)

### App Structure

```javascript
// apps/my-app/index.js
export default {
  // SERVER-SIDE (runs on authoritative server)
  server: {
    setup(ctx) {
      // Called once when entity is created
      ctx.state.counter = 0
      
      // Add physics collider
      ctx.physics.addColliderFromConfig({
        type: 'box',        // 'box' | 'sphere' | 'capsule' | 'convex' | 'trimesh' | 'none'
        size: [1, 1, 1],    // half-extents for box
        mass: 0,            // 0 = static, >0 = dynamic
        dynamic: false
      })
    },
    update(ctx, dt) {
      // Called every tick (64Hz by default)
      ctx.state.counter += dt
    },
    onMessage(ctx, msg) {
      // Handle client messages
      if (msg.type === 'interact') { ... }
    },
    onInteract(ctx, player) { },
    onCollision(ctx, other) { }
  },

  // CLIENT-SIDE (runs in browser)
  client: {
    setup(engine) {
      // Called once - create Three.js objects here
      const { THREE, scene } = engine
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(2, 2, 2),
        new THREE.MeshStandardMaterial({ color: 0xff0000 })
      )
      scene.add(mesh)
      this.mesh = mesh
    },
    render(ctx) {
      // Called every frame - return transform for network sync
      return {
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        custom: { mesh: 'box', color: 0xff0000, sx: 2, sy: 2, sz: 2 }
      }
    },
    onInput(input, engine) { },
    onFrame(dt, engine) { },
    onEvent(payload, engine) { }
  }
}
```

---

## Server-Side ctx API

| Property | Description |
|----------|-------------|
| `ctx.entity` | Current entity: `.id`, `.position`, `.rotation`, `.scale`, `.velocity`, `.custom`, `.destroy()` |
| `ctx.state` | Persistent state (survives hot reload) |
| `ctx.config` | Live config (world def `config` + editor `custom` props) |
| `ctx.physics.addColliderFromConfig({ type, size, radius, height, mass, dynamic, kinematic })` | Add physics body |
| `ctx.world.spawn(id, config)` | Spawn new entity |
| `ctx.world.destroy(id)` | Destroy entity |
| `ctx.world.getEntity(id)` | Get entity by ID |
| `ctx.world.query(filterFn)` | Query entities |
| `ctx.players.getAll()` | All connected players |
| `ctx.players.getById(id)` | Get player by ID |
| `ctx.players.send(playerId, msg)` | Send to specific player |
| `ctx.players.broadcast(msg)` | Broadcast to all |
| `ctx.players.broadcastNearby(pos, radius, msg)` | Broadcast to nearby |
| `ctx.bus.on('channel', handler)` | Subscribe to channel |
| `ctx.bus.emit('channel', data)` | Emit to channel (supports `combat.*` wildcards) |
| `ctx.time.after(seconds, fn)` | One-shot timer |
| `ctx.time.every(seconds, fn)` | Recurring timer |
| `ctx.raycast(origin, dir, maxDist)` | Physics raycast |

---

## Client-Side Engine API

Available in `client.setup`, `client.render`, `client.onInput`, `client.onFrame`, `client.onEvent`:

| Property | Description |
|----------|-------------|
| `engine.THREE` | Three.js module |
| `engine.scene` | THREE.Scene |
| `engine.camera` | THREE.PerspectiveCamera |
| `engine.renderer` | THREE.WebGLRenderer / WebGPURenderer |
| `engine.client` | Network client (PhysicsNetworkClient or BrowserServer) |
| `engine.playerId` | Local player ID |
| `engine.cam` | Camera controller (`.getAimDirection(pos)`, `.punch(intensity)`) |
| `engine.players.getMesh(id)` | Get player's Three.js mesh |
| `engine.players.getState(id)` | Get player's network state |
| `engine.players.getAnimator(id)` | Get player's VRM animator |
| `ctx.entity` | Current entity (in render) |
| `ctx.state` | Persistent state (in render) |
| `ctx.h` | HyperScript helper for UI (`ctx.h('div', { class: 'btn' }, 'Click')`) |
| `ctx.network.send(msg)` | Send message to server |

### Procedural Meshes (No GLB Needed)

```javascript
render(ctx) {
  return {
    custom: {
      mesh: 'box',        // 'box' | 'sphere' | 'cylinder'
      color: 0xff8800,
      roughness: 0.8,
      sx: 2, sy: 1, sz: 2,  // FULL dimensions (collider uses HALF-extents)
      r: 1, seg: 16, h: 1,  // sphere/cylinder params
      hover: 0.15,           // bob animation
      spin: 1,               // rotation speed
      glow: true,
      glowColor: 0x00ff88,
      label: 'PRESS E'       // interaction prompt
    }
  }
}
```

---

## Built-in Define* Factories

Use these instead of hand-rolling common mechanics:

```javascript
ctx.defineGameFSM(spec)         // xstate5 state machine
ctx.defineGameMode(spec)        // lobby/warmup/rounds/end
ctx.defineHealth(spec)          // HP/damage/death/respawn
ctx.defineSteering(spec)        // AI movement
ctx.defineCheckpoint(spec)      // checkpoint/fall-respawn
ctx.defineBuffStack(spec)       // timed buffs/debuffs
ctx.defineShrinkingZone(spec)   // battle-royale circle
ctx.definePickup(spec)          // collect trigger
ctx.defineDestructible(spec)    // breakable objects
ctx.defineTeams(spec)           // team membership + scoreboard
ctx.defineWeapon(spec)          // combat (hitscan/ammo/reload)
ctx.definePlayerInventory(spec) // inventory system
ctx.definePath(points)          // waypoint path
```

---

## Editor Mode

Press `P` to toggle in-browser editor:

| Key | Action |
|-----|--------|
| `G` / `R` / `S` | Translate / Rotate / Scale gizmo |
| `F` | Focus camera on selected entity |
| `Del` | Delete selected entity |
| Drag `.glb` | Place model in world |

---

## Singleplayer Mode

Add `?singleplayer` to run the **same server inside a Web Worker** (same origin, same code, no separate process):

```
http://localhost:3001/?singleplayer
http://localhost:3001/?singleplayer&world=matrix-construct
```

- Uses `BrowserServer` + `WorkerEntry.js`
- Same physics, same apps, same world config
- No WebSocket - direct function calls

---

## Verification Commands

```bash
# Parse-check all source files
npm run check

# Run tests (same as check)
npm test

# Build client bundle for production
npm run build:client

# Static export for itch.io / GitHub Pages
npm run static-export

# Check SDK types
npm run check:sdk-types
```

---

## Common Pitfalls

1. **Physics only activates in `setup()`** — `entity.bodyType = 'static'` does nothing without `ctx.physics.*`
2. **Set `movement.maxSpeed` explicitly** — code default is 8.0
3. **Horizontal velocity is wish-based** — only Y velocity comes from physics
4. **Capsule params**: `addCapsuleCollider(radius, fullHeight)` — full height, halved internally
5. **Trimesh is static-only** — use `addConvexCollider` for dynamic/kinematic
6. **AppLoader blocked strings** — `process.exit`, `child_process`, `require(`, `__proto__`, `Object.prototype`, `globalThis`, `eval(`, `import(` silently prevent load
7. **Single server only** — don't run second `node server.js` on different PORT; use `/?singleplayer`
8. **Loading screen waits for**: WebSocket, VRM, entity models, first snapshot, world entities

---

## Useful Links

- **Demo**: https://anentrypoint.github.io/spoint/
- **Architecture**: `docs/architecture-decisions.md`
- **Rendering**: `docs/rendering.md`
- **Editor**: `docs/editor-composing.md`
- **Publishing**: `docs/publish.md`
- **Anticheat**: `docs/anticheat.md`