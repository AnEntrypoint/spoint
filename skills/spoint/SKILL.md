---
name: spoint
description: Work with spoint - a multiplayer physics game server SDK. Scaffolds apps locally, runs engine from npm package.
---

# Spawnpoint App Development Reference

Complete reference for building apps in a spawnpoint project. Engine source code is not required. Everything needed to build any app is documented here.

---

## Setup

When no `apps/` directory exists in the working directory, scaffold it:

```bash
bunx spoint scaffold
bunx spoint
```

This copies the default apps (world config, tps-game, environment, etc.) into `./apps/` and starts the server. The engine (src/, client/) always comes from the npm package - never from the user's local folder.

```bash
bunx spoint          # start server
```

Open http://localhost:3001 in browser. Apps hot-reload on file save.

```bash
bunx spoint-create-app my-app
bunx spoint-create-app --template physics my-physics-object
bunx spoint-create-app --template interactive my-button
bunx spoint-create-app --template spawner my-spawner
```

---

## Project Structure

```
your-project/
  apps/
    world/index.js          # World config (port, tickRate, gravity, entities, scene, camera)
    my-app/index.js         # Your app (or apps/my-app.js)
```

Start: `node server.js` or `bunx spoint`. Port from world config (default 8080, world default 3001).

---

## App Anatomy

An app is an ES module with a default export containing a `server` object and optionally a `client` object.

```js
export default {
  server: {
    setup(ctx) {},           // Called once when entity is attached
    update(ctx, dt) {},      // Called every tick, dt in seconds
    teardown(ctx) {},        // Called on entity destroy or before hot reload
    onMessage(ctx, msg) {},  // Called for player messages (including player_join, player_leave)
    onEvent(ctx, payload) {}, // Called via ctx.bus or fireEvent
    onCollision(ctx, other) {}, // other = { id, position, velocity }
    onInteract(ctx, player) {},  // Called by fireInteract
    onHandover(ctx, sourceEntityId, stateData) {} // Called via bus.handover
  },

  client: {
    setup(engine) {},          // Called once when app loads on client
    teardown(engine) {},       // Called before hot reload or disconnect
    onFrame(dt, engine) {},    // Called every animation frame
    onInput(input, engine) {}, // Called when input state is available
    onEvent(payload, engine) {}, // Called when server sends message to this client
    onMouseDown(e, engine) {},
    onMouseUp(e, engine) {},
    render(ctx) {}             // Returns entity render state + optional UI
  }
}
```

---

## World Config Schema

`apps/world/index.js` exports a plain object. All fields optional.

```js
export default {
  port: 3001,
  tickRate: 128,
  gravity: [0, -9.81, 0],

  movement: {
    maxSpeed: 4.0,           // Max horizontal speed (m/s). DEFAULT code value is 8.0 but world overrides it
    groundAccel: 10.0,       // Ground acceleration
    airAccel: 1.0,           // Air acceleration (no friction in air)
    friction: 6.0,           // Ground friction coefficient
    stopSpeed: 2.0,          // Speed threshold for minimum friction control
    jumpImpulse: 4.0,        // Upward velocity set on jump
    collisionRestitution: 0.2,
    collisionDamping: 0.25,
    crouchSpeedMul: 0.4,     // Speed multiplier when crouching
    sprintSpeed: null        // null = maxSpeed * 1.75
  },

  player: {
    health: 100,
    capsuleRadius: 0.4,
    capsuleHalfHeight: 0.9,
    crouchHalfHeight: 0.45,
    mass: 120,
    modelScale: 1.323,
    feetOffset: 0.212        // Ratio: feetOffset * modelScale = negative Y offset on model
  },

  scene: {
    skyColor: 0x87ceeb,
    fogColor: 0x87ceeb,
    fogNear: 80,
    fogFar: 200,
    ambientColor: 0xfff4d6,
    ambientIntensity: 0.3,
    sunColor: 0xffffff,
    sunIntensity: 1.5,
    sunPosition: [21, 50, 20],
    fillColor: 0x4488ff,
    fillIntensity: 0.4,
    fillPosition: [-20, 30, -10],
    shadowMapSize: 1024,
    shadowBias: 0.0038,
    shadowNormalBias: 0.6,
    shadowRadius: 12,
    shadowBlurSamples: 8
  },

  camera: {
    fov: 70,
    shoulderOffset: 0.35,
    headHeight: 0.4,
    zoomStages: [0, 1.5, 3, 5, 8],
    defaultZoomIndex: 2,
    followSpeed: 12.0,
    snapSpeed: 30.0,
    mouseSensitivity: 0.002,
    pitchRange: [-1.4, 1.4]
  },

  animation: {
    mixerTimeScale: 1.3,
    walkTimeScale: 2.0,
    sprintTimeScale: 0.56,
    fadeTime: 0.15
  },

  entities: [
    {
      id: 'environment',
      model: './apps/tps-game/schwust.glb',
      position: [0, 0, 0],
      app: 'environment',       // App name matching apps/ folder or file
      config: { myKey: 'val' }  // Accessible as ctx.config.myKey in the app
    }
  ],

  playerModel: './apps/tps-game/Cleetus.vrm',
  spawnPoint: [-35, 3, -65]
}
```

---

## Server-Side Context API (ctx)

The `ctx` object is passed to every server lifecycle method.

### ctx.entity

```js
ctx.entity.id           // string - unique ID (read-only)
ctx.entity.model        // string|null - GLB/VRM asset path
ctx.entity.position     // [x, y, z] array - read/write
ctx.entity.rotation     // [x, y, z, w] quaternion - read/write
ctx.entity.scale        // [x, y, z] array - read/write
ctx.entity.velocity     // [x, y, z] array - read/write
ctx.entity.custom       // any - arbitrary data sent to clients in snapshots (keep small)
ctx.entity.parent       // string|null - parent entity ID (read-only)
ctx.entity.children     // string[] - copy of child entity IDs (read-only)
ctx.entity.worldTransform  // { position, rotation, scale } - computed world space transform
ctx.entity.destroy()    // Destroy this entity and all children
```

### ctx.state

Persistent state object. Survives hot reload. Assign properties directly or merge.

```js
ctx.state.score = 0
ctx.state.players = new Map()
ctx.state = { key: 'value' }  // Object.assign merge (does NOT replace the object)
```

Initialize with `||` to preserve values across hot reload:

```js
setup(ctx) {
  ctx.state.score = ctx.state.score || 0
  ctx.state.data = ctx.state.data || new Map()
}
```

### ctx.config

Read-only. Set in the world entities array under `config: {}`.

```js
// world/index.js:
{ id: 'my-entity', app: 'my-app', config: { radius: 5 } }
// In app:
ctx.config.radius  // 5
```

### ctx.interactable

Declares this entity as interactable. The engine handles proximity detection, the E-key prompt UI, and cooldown automatically. The app only needs to implement `onInteract`.

```js
setup(ctx) {
  ctx.interactable({ prompt: 'Press E to open', radius: 2, cooldown: 1000 })
},

onInteract(ctx, player) {
  ctx.players.send(player.id, { type: 'opened', message: 'Opened!' })
}
```

Options:
- `prompt` — text shown in the HUD when player is within range (default: `'Press E'`)
- `radius` — interaction distance in world units (default: `3`)
- `cooldown` — milliseconds between allowed interactions per player (default: `500`)

The engine client automatically shows and hides the prompt when the local player enters or leaves the radius. No client-side code is needed for basic interactables.

### ctx.physics

```js
ctx.physics.setStatic(true)    // Immovable
ctx.physics.setDynamic(true)   // Affected by physics
ctx.physics.setKinematic(true) // Moved by code, pushes dynamic bodies
ctx.physics.setMass(kg)

ctx.physics.addBoxCollider(size)
// size: number (uniform) or [hx, hy, hz] half-extents
// Example: ctx.physics.addBoxCollider([0.75, 0.25, 0.75])

ctx.physics.addSphereCollider(radius)

ctx.physics.addCapsuleCollider(radius, fullHeight)
// fullHeight is the FULL height. Internally divided by 2 for Jolt.

ctx.physics.addTrimeshCollider()
// Builds static mesh from entity.model path. Static only.

ctx.physics.addConvexCollider(points)
// points: flat Float32Array or Array of [x,y,z,x,y,z,...] vertex positions
// Builds a ConvexHullShape from the provided point cloud. Supports all motion types.

ctx.physics.addConvexFromModel(meshIndex = 0)
// Extracts vertex positions from entity.model GLB and builds ConvexHullShape.
// Simpler and faster than trimesh for dynamic objects like vehicles/crates.

ctx.physics.addForce([fx, fy, fz])    // Impulse: velocity += force / mass
ctx.physics.setVelocity([vx, vy, vz]) // Set velocity directly
```

### ctx.world

```js
ctx.world.spawn(id, config)
// id: string|null (null = auto-generate as 'entity_N')
// Returns: entity object or null

ctx.world.destroy(id)
ctx.world.getEntity(id)           // Returns entity object or null
ctx.world.query(filterFn)         // Returns entity[] matching filter
ctx.world.nearby(pos, radius)     // Returns entity IDs within radius
ctx.world.reparent(eid, parentId) // Change parent (null = detach from parent)
ctx.world.attach(entityId, appName)
ctx.world.detach(entityId)
ctx.world.gravity                 // [x, y, z] read-only
```

Entity config for spawn:

```js
ctx.world.spawn('my-id', {
  model: './path/to/model.glb',
  position: [x, y, z],            // default [0,0,0]
  rotation: [x, y, z, w],         // default [0,0,0,1]
  scale: [x, y, z],               // default [1,1,1]
  parent: 'parent-entity-id',
  app: 'app-name',                 // Auto-attach app
  config: { ... },                 // ctx.config in attached app
  autoTrimesh: true                // Auto-add trimesh collider from model
})
```

### ctx.players

```js
ctx.players.getAll()
// Returns Player[] where each player has:
// { id: string, state: { position, velocity, health, onGround, crouch, lookPitch, lookYaw, interact } }

ctx.players.getNearest([x, y, z], radius)
// Returns nearest player within radius, or null

ctx.players.send(playerId, { type: 'my_type', ...data })
// Client receives in onEvent(payload, engine)

ctx.players.broadcast({ type: 'my_type', ...data })

ctx.players.setPosition(playerId, [x, y, z])
// Teleports player - no collision check during teleport
```

Player state fields:

```js
player.state.position   // [x, y, z]
player.state.velocity   // [x, y, z]
player.state.health     // number
player.state.onGround   // boolean
player.state.crouch     // 0 or 1
player.state.lookPitch  // radians
player.state.lookYaw    // radians
player.state.interact   // boolean - true if player pressed interact this tick
```

You can directly mutate `player.state.health`, `player.state.velocity`, etc. and the change propagates in the next snapshot.

### ctx.network

```js
ctx.network.broadcast(msg)        // Same as ctx.players.broadcast
ctx.network.sendTo(playerId, msg) // Same as ctx.players.send
```

### ctx.bus

Scoped EventBus. Auto-cleaned on teardown.

```js
ctx.bus.on('channel.name', (event) => {
  event.channel  // string
  event.data     // your payload
  event.meta     // { timestamp, sourceEntity }
})

ctx.bus.once('channel.name', handler)
ctx.bus.emit('channel.name', data)
ctx.bus.handover(targetEntityId, stateData)
// Fires onHandover(ctx, sourceEntityId, stateData) on the target entity's app
```

### ctx.time

```js
ctx.time.tick       // Current tick number
ctx.time.deltaTime  // Same as dt in update()
ctx.time.elapsed    // Total seconds since runtime start

ctx.time.after(seconds, fn)   // One-shot timer
ctx.time.every(seconds, fn)   // Repeating timer
// All timers are cleared on teardown automatically
```

### ctx.storage

Async key-value storage, namespaced to app name. Null if no adapter configured.

```js
if (ctx.storage) {
  await ctx.storage.set('key', value)
  const val = await ctx.storage.get('key')
  await ctx.storage.delete('key')
  const exists = await ctx.storage.has('key')
  const keys = await ctx.storage.list('')  // all keys in namespace
}
```

### ctx.debug

```js
ctx.debug.log('message', optionalData)
```

### ctx.raycast

```js
const hit = ctx.raycast(origin, direction, maxDistance)
// origin: [x, y, z]
// direction: [x, y, z] normalized unit vector
// maxDistance: number (default 1000)
// Returns: { hit: boolean, distance: number, body: bodyId|null, position: [x,y,z]|null }

const result = ctx.raycast([x, 20, z], [0, -1, 0], 30)
if (result.hit) {
  const groundY = result.position[1]
}
```

---

## Client-Side Context API

### render(ctx)

```js
client: {
  render(ctx) {
    // ctx.entity   - entity data from latest snapshot
    // ctx.players  - array of all player states from snapshot
    // ctx.engine   - reference to engineCtx
    // ctx.h        - hyperscript function for UI
    // ctx.playerId - local player's ID

    return {
      position: ctx.entity.position,  // Required
      rotation: ctx.entity.rotation,  // Optional
      model: ctx.entity.model,        // Optional - override model
      custom: ctx.entity.custom,      // Optional - drives procedural mesh
      ui: ctx.h ? ctx.h('div', ...) : null  // Optional - HTML overlay
    }
  }
}
```

### engine Object (client callbacks)

Available in `setup(engine)`, `onFrame(dt, engine)`, `onInput(input, engine)`, `onEvent(payload, engine)`, `teardown(engine)`.

```js
engine.THREE          // THREE.js library
engine.scene          // THREE.Scene
engine.camera         // THREE.Camera
engine.renderer       // THREE.WebGLRenderer
engine.playerId       // Local player's string ID
engine.client.state   // { players: [...], entities: [...] } - latest snapshot

engine.cam.getAimDirection(position)  // Returns normalized [dx, dy, dz]
engine.cam.punch(intensity)           // Aim punch (visual recoil)

engine.players.getAnimator(playerId)
engine.players.setExpression(playerId, expressionName, weight)
engine.players.setAiming(playerId, isAiming)

engine.mobileControls?.registerInteractable(id, label)
engine.mobileControls?.unregisterInteractable(id)
```

### ctx.h (hyperscript for UI)

```js
ctx.h(tagName, props, ...children)
// tagName: 'div', 'span', 'button', etc.
// props: object with HTML attributes and inline styles, or null
// children: strings, numbers, h() calls, null (null ignored)

ctx.h('div', { style: 'color:red;font-size:24px' }, 'Hello World')
ctx.h('div', { class: 'hud' },
  ctx.h('span', null, `HP: ${hp}`),
  hp < 30 ? ctx.h('span', { style: 'color:red' }, 'LOW HP') : null
)
```

Client apps cannot use `import`. All dependencies come via `engine`.

### onInput(input, engine)

```js
input.forward   // boolean
input.backward  // boolean
input.left      // boolean
input.right     // boolean
input.jump      // boolean
input.crouch    // boolean
input.sprint    // boolean
input.shoot     // boolean
input.reload    // boolean
input.interact  // boolean
input.yaw       // number - camera yaw in radians
input.pitch     // number - camera pitch in radians
```

---

## App Lifecycle

```
Server start:
  AppLoader.loadAll() -> registers all apps in apps/
  For each entity in world.entities:
    spawnEntity() -> _attachApp() -> server.setup(ctx)

Each tick (128/sec):
  for each entity with app: server.update(ctx, dt)
  tick timers
  tick sphere collisions -> server.onCollision()

On file save (hot reload):
  AppLoader detects change, queues reload
  End of current tick: drain queue
    server.teardown(ctx)        [bus scope destroyed, timers cleared]
    new AppContext               [ctx.state reference PRESERVED on entity]
    server.setup(ctx)           [fresh context, same state data]

On entity destroy:
  Cascade to all children
  server.teardown(ctx)
  entity removed from Map

Client:
  Receives APP_MODULE message with app source
  client.setup(engine) called once
  Each frame: client.onFrame(dt, engine), client.render(ctx)
  On server message: client.onEvent(payload, engine)
  On hot reload: client.teardown(engine) -> location.reload()
```

---

## Entity System

Entities are plain objects in a Map. Not class instances.

```js
{
  id: string,
  model: string|null,
  position: [x, y, z],
  rotation: [x, y, z, w],     // quaternion
  scale: [x, y, z],
  velocity: [x, y, z],
  mass: 1,
  bodyType: 'static'|'dynamic'|'kinematic',
  collider: null | { type, ...params },
  parent: string|null,
  children: Set<string>,
  custom: any,                  // sent to clients in every snapshot - keep small
  _appState: object,            // ctx.state - persists across hot reloads
  _appName: string|null,
  _config: object|null
}
```

Destroying a parent destroys all children. World transform is computed recursively up the parent chain.

---

## Physics API

### Shape Types and Methods

```js
ctx.physics.addBoxCollider(size)
// size: number (uniform half-extent) or [hx, hy, hz]

ctx.physics.addSphereCollider(radius)

ctx.physics.addCapsuleCollider(radius, fullHeight)
// fullHeight = total height. Halved internally before passing to Jolt.

ctx.physics.addTrimeshCollider()
// Static trimesh from entity.model. Only for static bodies.

ctx.physics.addConvexCollider(points)
// points: flat array [x,y,z,x,y,z,...]. Supports all motion types (dynamic/kinematic/static).

ctx.physics.addConvexFromModel(meshIndex = 0)
// Extracts vertices from entity.model GLB and builds ConvexHullShape. Good for dynamic vehicles/crates.

ctx.physics.addForce([fx, fy, fz])     // velocity += force / mass
ctx.physics.setVelocity([vx, vy, vz])
```

### Body Types

- `static`: immovable, other bodies collide with it
- `dynamic`: affected by gravity and forces
- `kinematic`: moved by code, pushes dynamic bodies

### Jolt WASM Memory Rules

Do NOT call Jolt methods directly from app code. Use `ctx.physics` only. The engine destroys all WASM heap objects internally. Every Jolt getter call and raycast creates temporary heap objects that must be destroyed - the engine handles this automatically via the ctx API.

---

## EventBus

Shared pub/sub system. Scoped per entity - all subscriptions auto-cleaned on teardown.

```js
// Subscribe
const unsub = ctx.bus.on('channel.name', (event) => {
  event.data     // your payload
  event.channel  // 'channel.name'
  event.meta     // { timestamp, sourceEntity }
})
unsub()  // manual unsubscribe if needed

// One-time
ctx.bus.once('channel.name', handler)

// Emit (meta.sourceEntity = this entity's ID automatically)
ctx.bus.emit('channel.name', { key: 'value' })

// Wildcard - subscribe to prefix
ctx.bus.on('combat.*', (event) => {
  // Receives: combat.fire, combat.hit, combat.death, etc.
})

// Handover - transfer state to another entity's app
ctx.bus.handover(targetEntityId, stateData)
// Fires: server.onHandover(ctx, sourceEntityId, stateData) on target
```

### Reserved Channels

`system.*` prefix is reserved. Events on `system.*` do NOT trigger the `*` catch-all logger. Do not emit on `system.*` from app code.

### Cross-App Pattern

```js
// App A (power-crate) emits:
ctx.bus.emit('powerup.collected', { playerId, duration: 45, speedMultiplier: 1.2 })

// App B (tps-game) subscribes:
ctx.bus.on('powerup.collected', (event) => {
  const { playerId, duration } = event.data
  ctx.state.buffs.set(playerId, { expiresAt: Date.now() + duration * 1000 })
})
```

---

## Message Types (Hex Reference)

Apps do not use these directly. Listed for debugging and understanding the transport layer.

| Name | Hex | Direction | Notes |
|------|-----|-----------|-------|
| HANDSHAKE | 0x01 | C→S | Initial connection |
| HANDSHAKE_ACK | 0x02 | S→C | Connection accepted |
| HEARTBEAT | 0x03 | C→S | Every 1000ms, 3s timeout |
| HEARTBEAT_ACK | 0x04 | S→C | |
| SNAPSHOT | 0x10 | S→C | Full world state |
| INPUT | 0x11 | C→S | Player input |
| STATE_CORRECTION | 0x12 | S→C | Physics correction |
| DELTA_UPDATE | 0x13 | S→C | Delta snapshot |
| PLAYER_JOIN | 0x20 | S→C | Player connected |
| PLAYER_LEAVE | 0x21 | S→C | Player disconnected |
| ENTITY_SPAWN | 0x30 | S→C | New entity |
| ENTITY_DESTROY | 0x31 | S→C | Entity removed |
| ENTITY_UPDATE | 0x32 | S→C | Entity state change |
| APP_EVENT | 0x33 | S→C | ctx.players.send/broadcast payload |
| HOT_RELOAD | 0x70 | S→C | Triggers location.reload() on client |
| WORLD_DEF | 0x71 | S→C | World configuration |
| APP_MODULE | 0x72 | S→C | Client app source code |
| BUS_EVENT | 0x74 | S→C | Bus event forwarded to client |

Heartbeat: any message from client resets the 3-second timeout. Client sends explicit heartbeat every 1000ms. 3s silence = disconnected.

---

## Snapshot Format

Snapshots sent at tickRate (128/sec) only when players are connected.

### Player Array (positional - do not reorder)

```
[0]id  [1]px [2]py [3]pz  [4]rx [5]ry [6]rz [7]rw  [8]vx [9]vy [10]vz  [11]onGround  [12]health  [13]inputSeq  [14]crouch  [15]lookPitch  [16]lookYaw
```

- Position precision: 2 decimal places (×100 quantization)
- Rotation precision: 4 decimal places (×10000 quantization)
- health: rounded integer
- onGround: 1 or 0
- lookPitch/lookYaw: 0-255 (8-bit encoded, full range)

### Entity Array (positional - do not reorder)

```
[0]id  [1]model  [2]px [3]py [4]pz  [5]rx [6]ry [7]rz [8]rw  [9]bodyType  [10]custom
```

- Same position/rotation quantization as players
- custom: any JSON-serializable value (null if not set)

Changing field order or count breaks all clients silently (wrong positions, no error).

### Delta Snapshots

Unchanged entities are omitted. Removed entities appear in a `removed` string array. Players are always fully encoded (no delta). When StageLoader is active, each player gets a different snapshot with only nearby entities (within relevanceRadius, default 200 units).

---

## Collision Detection

Two separate systems run simultaneously.

### Jolt Physics (player-world, rigid bodies)

Automatic. Players collide with static trimesh geometry. Dynamic bodies collide with everything. No app API needed.

### App Sphere Collisions (entity-entity)

Runs every tick. For entities that have both a collider AND an attached app, sphere-overlap tests fire `onCollision`:

```js
server: {
  setup(ctx) {
    ctx.physics.addSphereCollider(1.5)  // Must set collider to receive events
  },
  onCollision(ctx, other) {
    // other: { id, position, velocity }
  }
}
```

Collision radius per shape type:
- sphere: radius value
- capsule: max(radius, height/2)
- box: max of all half-extents

This is sphere-vs-sphere approximation. Use for pickups, triggers, proximity - not precise physics.

### Player-Player Collision

Custom capsule separation runs after the physics step. Engine-managed. No app API.

---

## Movement Config

Quake-style movement. Defined in `world.movement`.

```js
movement: {
  maxSpeed: 4.0,      // IMPORTANT: code default is 8.0, world config overrides. Always set explicitly.
  groundAccel: 10.0,  // Ground acceleration (applied with friction simultaneously)
  airAccel: 1.0,      // Air acceleration (no friction in air = air strafing)
  friction: 6.0,      // Ground friction
  stopSpeed: 2.0,     // Min speed for friction calculation (prevents infinite decel)
  jumpImpulse: 4.0,   // Upward velocity SET (not added) on jump
  crouchSpeedMul: 0.4,
  sprintSpeed: null   // null = maxSpeed * 1.75
}
```

Key behavior: horizontal velocity (XZ) is wish-based. After physics step, the wish velocity overwrites the XZ physics result. Only Y velocity comes from physics (gravity/jumping). This is why `player.state.velocity[0]` and `[2]` reflect wish velocity, not physics result.

---

## Hot Reload

### What Survives

`ctx.state` (stored on `entity._appState`) survives. The reference is kept on the entity across hot reloads.

### What Does NOT Survive

- `ctx.time` timers (must re-register in setup)
- `ctx.bus` subscriptions (must re-subscribe in setup)
- Any closures
- Client `this` properties (reset on location.reload)

### Hot Reload Safety Pattern

```js
setup(ctx) {
  // Preserve existing values:
  ctx.state.score = ctx.state.score || 0
  ctx.state.data = ctx.state.data || new Map()

  // Always re-register (cleared on teardown):
  ctx.bus.on('some.event', handler)
  ctx.time.every(1, ticker)
}
```

### Timing

App reloads never happen mid-tick. Queue drains at end of each tick. After each reload, client heartbeat timers are reset for all connections to prevent disconnect during slow reloads. After 3 consecutive failures, AppLoader stops auto-reloading that module until server restart (exponential backoff: 100ms, 200ms, 400ms max).

---

## Client Rendering

### GLB Shader Stall Prevention

The engine handles GPU shader warmup in two phases — no action is needed from app code:

1. **Initial load**: After the loading screen gates pass (assets, environment, first snapshot, first-snapshot entities all loaded), the loading screen hides and `warmupShaders()` runs asynchronously. It calls `renderer.compileAsync(scene, camera)`, disables frustum culling, renders twice to upload GPU data, then restores culling. This covers all entities present at startup.

2. **Post-load dynamic entities**: For GLBs added after the loading screen is hidden, `loadEntityModel` calls `renderer.compileAsync(scene, camera)` immediately after adding the mesh to the scene.

VRM players use a separate one-time warmup (`_vrmWarmupDone`) that fires `renderer.compileAsync(scene, camera)` after the first player model loads.

### render(ctx) Return Value

```js
return {
  position: [x, y, z],      // Required
  rotation: [x, y, z, w],   // Optional
  model: 'path.glb',         // Optional - override model
  custom: { ... },           // Optional - drives procedural mesh rendering
  ui: h('div', ...)          // Optional - HTML overlay
}
```

### Entity custom Field - Procedural Mesh Conventions

When no GLB model is set, `custom` drives procedural geometry:

```js
// Box
custom: { mesh: 'box', color: 0xff8800, sx: 1, sy: 1, sz: 1 }

// Sphere
custom: { mesh: 'sphere', color: 0x00ff00, radius: 1 }

// Cylinder
custom: {
  mesh: 'cylinder',
  r: 0.4, h: 0.1, seg: 16,
  color: 0xffd700,
  roughness: 0.3, metalness: 0.8,
  emissive: 0xffa000, emissiveIntensity: 0.3,
  rotZ: Math.PI / 2,
  light: 0xffd700, lightIntensity: 1, lightRange: 4
}

// Animation
custom: { ..., hover: 0.15, spin: 1 }
// hover: Y oscillation amplitude (units)
// spin: rotation speed (radians/sec)

// Glow (interaction feedback)
custom: { ..., glow: true, glowColor: 0x00ff88, glowIntensity: 0.5 }

// Label
custom: { mesh: 'box', label: 'PRESS E' }
```

---

## AppLoader Security Restrictions

The following strings in app source (including in comments or string literals) cause silent load failure:

- `process.exit`
- `child_process`
- `require(`
- `__proto__`
- `Object.prototype`
- `globalThis`
- `eval(`
- `import(`

If blocked, AppLoader logs a console error and the app does not register. Entities using it spawn without a server app.

Static ES module `import` at the top of the file is fine - AppLoader uses dynamic import internally to load the file. Do NOT use dynamic `import(` inside app code.

---

## Common Patterns

### Spawn entities on setup, destroy on teardown

```js
server: {
  setup(ctx) {
    ctx.state.spawned = ctx.state.spawned || []
    if (ctx.state.spawned.length === 0) {
      for (let i = 0; i < 5; i++) {
        const id = `item_${Date.now()}_${i}`
        const e = ctx.world.spawn(id, { position: [i * 3, 1, 0] })
        if (e) {
          e.custom = { mesh: 'sphere', color: 0xffff00, radius: 0.5 }
          ctx.state.spawned.push(id)
        }
      }
    }
  },
  teardown(ctx) {
    for (const id of ctx.state.spawned || []) ctx.world.destroy(id)
    ctx.state.spawned = []
  }
}
```

### Raycast to find ground spawn points

```js
function findSpawnPoints(ctx) {
  const points = []
  for (let x = -50; x <= 50; x += 10) {
    for (let z = -50; z <= 50; z += 10) {
      const hit = ctx.raycast([x, 30, z], [0, -1, 0], 40)
      if (hit.hit && hit.position[1] > -5) {
        points.push([x, hit.position[1] + 2, z])
      }
    }
  }
  if (points.length < 4) points.push([0, 5, 0], [10, 5, 10])
  return points
}
```

### Player join/leave handling

```js
onMessage(ctx, msg) {
  if (!msg) return
  const pid = msg.playerId || msg.senderId
  if (msg.type === 'player_join') {
    ctx.state.scores = ctx.state.scores || new Map()
    ctx.state.scores.set(pid, 0)
  }
  if (msg.type === 'player_leave') {
    ctx.state.scores?.delete(pid)
  }
}
```

### Interact detection with cooldown

Use `ctx.interactable()` — the engine handles proximity, prompt UI, and cooldown automatically.

```js
setup(ctx) {
  ctx.interactable({ prompt: 'Press E', radius: 4, cooldown: 500 })
},

onInteract(ctx, player) {
  ctx.players.send(player.id, { type: 'interact_response', message: 'Hello!' })
  ctx.network.broadcast({ type: 'interact_effect', position: ctx.entity.position })
}
```

### Area damage hazard

```js
update(ctx, dt) {
  ctx.state.damageTimer = (ctx.state.damageTimer || 0) - dt
  if (ctx.state.damageTimer > 0) return
  ctx.state.damageTimer = 0.5
  const radius = ctx.config.radius || 3
  for (const player of ctx.players.getAll()) {
    if (!player.state) continue
    const pp = player.state.position
    const dist = Math.hypot(
      pp[0] - ctx.entity.position[0],
      pp[1] - ctx.entity.position[1],
      pp[2] - ctx.entity.position[2]
    )
    if (dist < radius) {
      player.state.health = Math.max(0, (player.state.health || 100) - 10)
      ctx.players.send(player.id, { type: 'hazard_damage', damage: 10 })
    }
  }
}
```

### Moving platform

```js
update(ctx, dt) {
  const s = ctx.state
  if (!s.waypoints || s.waypoints.length < 2) return
  s.waitTimer = (s.waitTimer || 0) - dt
  if (s.waitTimer > 0) return
  const wp = s.waypoints[s.wpIndex || 0]
  const next = s.waypoints[((s.wpIndex || 0) + 1) % s.waypoints.length]
  const dx = next[0] - ctx.entity.position[0]
  const dy = next[1] - ctx.entity.position[1]
  const dz = next[2] - ctx.entity.position[2]
  const dist = Math.sqrt(dx*dx + dy*dy + dz*dz)
  if (dist < 0.1) {
    s.wpIndex = ((s.wpIndex || 0) + 1) % s.waypoints.length
    s.waitTimer = s.waitTime || 1
    return
  }
  const step = Math.min((s.speed || 5) * dt, dist)
  ctx.entity.position[0] += (dx/dist) * step
  ctx.entity.position[1] += (dy/dist) * step
  ctx.entity.position[2] += (dz/dist) * step
}
```

### Client UI with custom HUD

For interaction prompts, use `ctx.interactable()` on the server — the engine renders the prompt automatically. For custom HUD elements (health bars, messages), use `render()`:

```js
client: {
  onEvent(payload) {
    if (payload.type === 'interact_response') { this._msg = payload.message; this._expire = Date.now() + 3000 }
  },

  render(ctx) {
    const h = ctx.h
    if (!h) return { position: ctx.entity.position }
    return {
      position: ctx.entity.position,
      custom: ctx.entity.custom,
      ui: this._msg && Date.now() < this._expire
        ? h('div', { style: 'position:fixed;top:30%;left:50%;transform:translate(-50%,-50%);padding:16px 32px;background:rgba(0,0,0,0.8);border-radius:12px;color:#0f0;font-weight:bold' }, this._msg)
        : null
    }
  }
}
```

### Client health HUD

```js
client: {
  render(ctx) {
    const h = ctx.h
    if (!h) return { position: ctx.entity.position }
    const local = ctx.players?.find(p => p.id === ctx.engine?.playerId)
    const hp = local?.health ?? 100
    return {
      position: ctx.entity.position,
      ui: h('div', { style: 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);width:200px;height:20px;background:#333;border-radius:4px;overflow:hidden' },
        h('div', { style: `width:${hp}%;height:100%;background:${hp > 60 ? '#0f0' : hp > 30 ? '#ff0' : '#f00'};transition:width 0.2s` }),
        h('span', { style: 'position:absolute;width:100%;text-align:center;color:#fff;font-size:12px;line-height:20px' }, String(hp))
      )
    }
  }
}
```

### Cross-app EventBus communication

```js
// Emitter app setup:
ctx.bus.emit('combat.fire', { shooterId, origin, direction })

// Listener app setup:
ctx.bus.on('combat.fire', (event) => {
  const { shooterId, origin, direction } = event.data
  // handle shot...
})
ctx.bus.on('combat.*', (event) => {
  // catches combat.fire, combat.hit, combat.kill, etc.
})
```

---

## Critical Caveats

### ctx.state survives hot reload; timers and bus subscriptions do not

Re-register all timers and bus subscriptions in `setup`. Use `||` to preserve state:

```js
setup(ctx) {
  ctx.state.counter = ctx.state.counter || 0  // preserved
  ctx.bus.on('event', handler)   // re-registered fresh
  ctx.time.every(1, ticker)      // re-registered fresh
}
```

### Snapshot field order is fixed and positional

Player arrays and entity arrays use positional indexing. Changing the order or count of fields breaks all clients silently (wrong positions, no error thrown).

### maxSpeed default mismatch

`DEFAULT_MOVEMENT.maxSpeed` in the movement code is 8.0. World config overrides this. The example world config uses 4.0. Always set `movement.maxSpeed` explicitly in world config.

### Horizontal velocity is wish-based, not physics-based

After the physics step, wish velocity overwrites XZ physics result. `player.state.velocity[0]` and `[2]` are the wish velocity. Only `velocity[1]` (Y) comes from physics. This means horizontal movement ignores physics forces.

### CharacterVirtual gravity must be applied manually

The engine manually applies `gravity[1] * dt` to Y velocity. This is already handled. If you override `player.state.velocity[1]`, gravity still accumulates on top next tick.

### Capsule parameter order

`addCapsuleCollider(radius, fullHeight)` - full height, not half height. The API divides by 2 internally. This differs from Jolt's direct API which takes (halfHeight, radius).

### Trimesh colliders are static only

`addTrimeshCollider()` creates a static mesh. No dynamic or kinematic trimesh support.

### Convex hull for dynamic objects

Use `addConvexCollider(points)` or `addConvexFromModel()` for dynamic/kinematic bodies that need shape-accurate physics (vehicles, crates). Convex hulls support all motion types unlike trimesh. `addConvexFromModel()` reads vertices from the entity's GLB at setup time - call it after setting `entity.model`.

### Animation library uses two-phase cache

`preloadAnimationLibrary()` kicks off the `/anim-lib.glb` fetch and caches the promise (`_gltfPromise`). `loadAnimationLibrary(vrmVersion, vrmHumanoid)` awaits that fetch and caches the normalized clip result (`_normalizedCache`). The engine calls `preloadAnimationLibrary()` early during asset init so the GLB is already fetching while the VRM downloads. Subsequent calls to `loadAnimationLibrary()` return the normalized cache immediately. Both functions are idempotent and safe to call concurrently.

### Tick drops under load

TickSystem processes max 4 ticks per loop. If the server falls more than 4 ticks behind (31ms at 128 TPS), those ticks are dropped silently.

### Snapshots not sent with zero players

`if (players.length > 0)` guards snapshot creation. Entity state still updates when no players are connected but nothing is broadcast.

### Collision detection is O(n²)

`_tickCollisions` runs sphere-vs-sphere for all entities with both a collider and an app. Keep interactive entity count under ~50 for this to be cheap.

### AppLoader blocks entire file on pattern match

If any blocked string (including in comments) appears anywhere in the source, the app silently fails to load. No throw, only console error.

### Client apps cannot use import statements

All `import` statements in client app source are stripped by regex before evaluation. Use `engine.THREE`, `engine.scene`, etc. for all dependencies.

### GLB/VRM assets are cached in IndexedDB

On repeat page loads, `fetchCached()` in `client/ModelCache.js` validates cached GLB/VRM ArrayBuffers against the server ETag via a HEAD request. If the ETag matches, the cached bytes are returned without a network fetch. Cache misses or stale entries trigger a full fetch and re-store. Cache failures (quota, unavailable) fall back to normal fetch transparently. This is fully automatic — no app code needed.

### Loading screen hides before shader warmup completes

After the four gate conditions pass, the loading screen hides immediately. `warmupShaders()` then runs asynchronously in the background. The very first rendered frame after the loading screen hides may have a brief GPU stall if shader compilation is not yet complete. This is a deliberate tradeoff to avoid the loading screen adding warmup time on top of actual asset loading.

### setTimeout not cleared on hot reload

`ctx.time.after/every` timers are cleared on teardown. `setTimeout` and `setInterval` are NOT. Use `ctx.time` for game logic. Use `setTimeout` only for external timing (e.g., reload cooldown) and manage cleanup in teardown manually.

### Entity children destroyed with parent

`destroyEntity` recursively destroys all children. Reparent first if you need to preserve a child: `ctx.world.reparent(childId, null)`.

### setPosition teleports through walls

`ctx.players.setPosition` directly sets physics body position with no collision check. The physics solver pushes out on the next tick, which may look jarring.

---

## Debug Globals

```
Server: globalThis.__DEBUG__.server   (Node REPL)
Client: window.debug                  (browser console)
  window.debug.scene, camera, renderer, client, players, input
```
