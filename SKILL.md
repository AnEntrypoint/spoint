---
name: spoint
description: "Build multiplayer physics games with the Spawnpoint engine. Use when asked to: create a game, add physics objects, spawn entities, build a map/level, handle player interaction, add weapons, respawn, scoring, create moving platforms, manage world config, load 3D models, add HUD/UI, work with the EventBus, or develop any app inside an apps/ directory."
---

# Spawnpoint App Development Reference

Setup:
```bash
npx spoint scaffold   # first time — copies default apps/ into cwd
npx spoint            # start server (localhost:3001)
npx spoint-create-app my-app
npx spoint-create-app --template physics my-crate
```

Project structure: `apps/world/index.js` (world config) + `apps/<name>/index.js` (apps). Engine is from npm — never in user project.

**App design principle: apps are config, engine is code.**
- No `client` block unless your app renders custom UI (`ui:` field in render return). The snapshot carries position/rotation/custom automatically.
- No `onEditorUpdate` — the engine applies position/rotation/scale/custom changes from the editor automatically.
- Use `ctx.physics.addColliderFromConfig(cfg)` instead of separate setStatic/setDynamic + addBoxCollider calls.
- Use `ctx.world.spawnChild(id, cfg)` instead of `spawn` + manual `teardown` loop — children are auto-destroyed.
- Keep helper functions outside the `export default {}` block (hoisted by evaluateAppModule).

---

## Quick Start — Minimal Working Arena

### `apps/world/index.js`
```js
export default {
  port: 3001, tickRate: 64, gravity: [0, -9.81, 0],
  movement: { maxSpeed: 4.0, groundAccel: 10.0, airAccel: 1.0, friction: 6.0, stopSpeed: 2.0, jumpImpulse: 4.0 },
  player: { health: 100, capsuleRadius: 0.4, capsuleHalfHeight: 0.9, modelScale: 1.323, feetOffset: 0.212 },
  scene: { skyColor: 0x87ceeb, fogColor: 0x87ceeb, fogNear: 80, fogFar: 200, sunIntensity: 1.5, sunPosition: [20, 40, 20] },
  entities: [{ id: 'environment', model: './apps/game/map.glb', position: [0,0,0], app: 'environment' }],
  spawnPoint: [0, 2, 0]
}
```

### `apps/environment/index.js` — static environment with trimesh physics
```js
// client block not needed — snapshot carries position/model automatically
export default {
  server: {
    async setup(ctx) {
      try {
        await ctx.physics.addColliderFromConfig({ type:'trimesh' })
      } catch (e) {
        console.log(\`Trimesh failed: \${e.message}, using box fallback\`)
        ctx.physics.addColliderFromConfig({ type:'box', size:[100, 25, 100] })
      }
    }
  }
}
```

### `apps/box-static/index.js` — reusable static box primitive
```js
// Apps are config, not code. No client block needed — snapshot carries position/rotation/custom automatically.
export default {
  server: {
    setup(ctx) {
      const c = ctx.config
      const hx = c.hx ?? 1, hy = c.hy ?? 1, hz = c.hz ?? 1
      ctx.entity.custom = { mesh:'box', color:c.color??0x888888, roughness:c.roughness??0.9, sx:hx*2, sy:hy*2, sz:hz*2 }
      ctx.physics.addColliderFromConfig({ type:'box', size:[hx,hy,hz] })
    }
  }
}
```

---

## World Config Schema

All fields optional. `apps/world/index.js` exports a plain object.

```js
export default {
  port: 3001, tickRate: 64, gravity: [0,-9.81,0],
  entityTickRate: 16,      // app update() Hz (default = tickRate). Lower = fewer update() calls, less CPU
  physicsRadius: 0,        // dynamic body LOD radius (0 = disabled). Bodies outside all players suspended from Jolt
  movement: {
    maxSpeed: 4.0,         // code default is 8.0 — always override explicitly
    groundAccel: 10.0, airAccel: 1.0, friction: 6.0, stopSpeed: 2.0,
    jumpImpulse: 4.0,      // velocity SET (not added) on jump
    crouchSpeedMul: 0.4, sprintSpeed: null  // null = maxSpeed * 1.75
  },
  player: {
    health: 100, capsuleRadius: 0.4, capsuleHalfHeight: 0.9, crouchHalfHeight: 0.45,
    mass: 120, modelScale: 1.323,
    feetOffset: 0.212      // feetOffset * modelScale = negative Y on model
  },
  scene: {
    skyColor: 0x87ceeb, fogColor: 0x87ceeb, fogNear: 80, fogFar: 200,
    ambientColor: 0xfff4d6, ambientIntensity: 0.3,
    sunColor: 0xffffff, sunIntensity: 1.5, sunPosition: [21,50,20],
    fillColor: 0x4488ff, fillIntensity: 0.4, fillPosition: [-20,30,-10],
    shadowMapSize: 1024, shadowBias: 0.0038, shadowNormalBias: 0.6, shadowRadius: 12, shadowBlurSamples: 8
  },
  camera: {
    fov: 70, shoulderOffset: 0.35, headHeight: 0.4,
    zoomStages: [0,1.5,3,5,8], defaultZoomIndex: 2,
    followSpeed: 12.0, snapSpeed: 30.0, mouseSensitivity: 0.002, pitchRange: [-1.4,1.4]
  },
  animation: { mixerTimeScale: 1.3, walkTimeScale: 2.0, sprintTimeScale: 0.56, fadeTime: 0.15 },
  entities: [{ id:'env', model:'./apps/my-app/env.glb', position:[0,0,0], app:'environment', config:{} }],
  playerModel: './apps/tps-game/Cleetus.vrm',
  spawnPoint: [0,2,0]
}
```

---

## Asset Loading Gate

Loading screen holds until ALL pass simultaneously:
1. WebSocket connected
2. Player VRM downloaded
3. Any entity with `model` field (or entity creating a mesh) loaded
4. First snapshot received
5. All `world.entities` entries with `model` field loaded

Entities spawned via `ctx.world.spawn()` at runtime are NOT in the gate. Declare in `world.entities` to block loading screen on a model.

---

## Remote Models — Verified Filenames

URL: `https://raw.githubusercontent.com/anEntrypoint/assets/main/FILENAME.glb`

**Never guess filenames** — wrong URLs silently 404, no error.

```
broken_car_b6d2e66d_v1.glb  broken_car_b6d2e66d_v2.glb  crashed_car_f2b577ae_v1.glb
crashed_pickup_truck_ae555020_v1.glb  crashed_rusty_minivan_f872ff37_v1.glb  Bus_junk_1.glb
blue_shipping_container_60b5ea93_v1.glb  blue_shipping_container_63cc3905_v1.glb
dumpster_b076662a_v1.glb  dumpster_b076662a_v2.glb  garbage_can_6b3d052b_v1.glb
crushed_oil_barrel_e450f43f_v1.glb  fire_hydrant_ba0175c1_v1.glb
fire_extinguisher_wall_mounted_bc0dddd4_v1.glb
break_room_chair_14a39c7b_v1.glb  break_room_couch_444abf63_v1.glb
break_room_table_09b9fd0d_v1.glb  filing_cabinet_0194476c_v1.glb
fancy_reception_desk_58fde71d_v1.glb  cash_register_0c0dcad2_v1.glb
espresso_machine_e722ed8c_v1.glb  Couch.glb  Couch_2.glb  3chairs.glb
large_rock_051293c4_v1.glb  Tin_Man_1.glb  Tin_Man_2.glb  Plants_3.glb  Urinals.glb  V_Machine_2.glb
```

Remote models are NOT in the loading gate. Use `prop-static` app for physics:
```js
// apps/prop-static/index.js — already built-in, no need to recreate
// Spawn:
const BASE = 'https://raw.githubusercontent.com/anEntrypoint/assets/main'
ctx.world.spawn('dumpster-1', { model:`${BASE}/dumpster_b076662a_v1.glb`, position:[5,0,-3], app:'prop-static' })
```

---

## Server ctx API

### ctx.entity
```js
ctx.entity.id / model / position / rotation / scale / velocity / custom / parent / children / worldTransform
ctx.entity.destroy()
// position: [x,y,z]  rotation: [x,y,z,w] quaternion  custom: any (sent in every snapshot — keep small)
```

### ctx.state

Persists across hot reloads. Re-register timers and bus subscriptions in every setup:
```js
setup(ctx) {
  ctx.state.score = ctx.state.score || 0      // || preserves value on reload
  ctx.state.data  = ctx.state.data  || new Map()
  ctx.bus.on('event', handler)                // always re-register
  ctx.time.every(1, ticker)                   // always re-register
}
```

### ctx.config

Read-only. Set in world: `{ id:'x', app:'y', config:{ radius:5 } }` → `ctx.config.radius`

### ctx.interactable

Engine handles proximity, E-key prompt, and cooldown. App only needs `onInteract`:
```js
setup(ctx) { ctx.interactable({ prompt:'Press E', radius:2, cooldown:1000 }) },
onInteract(ctx, player) { ctx.players.send(player.id, { type:'opened' }) }
```

### ctx.physics
```js
// One-call setup — handles motion type + collider in one step (preferred)
ctx.physics.addColliderFromConfig({
  type: 'box'|'sphere'|'capsule'|'convex'|'trimesh'|'none',
  size: [hx,hy,hz],    // box only
  radius: 0.5,          // sphere/capsule
  height: 1.8,          // capsule (full height)
  meshIndex: 0,         // convex: GLB mesh index
  mass: 10,             // dynamic only
  dynamic: true,        // motion type flag (default: static)
  kinematic: true,      // alternative motion type
  linearDamping: 1.5,
  angularDamping: 4.0,
})

// Low-level methods (use addColliderFromConfig instead for new code)
ctx.physics.setStatic(true) / setDynamic(true) / setKinematic(true)
ctx.physics.setMass(kg)
ctx.physics.addBoxCollider([hx,hy,hz])
ctx.physics.addSphereCollider(radius)
ctx.physics.addCapsuleCollider(radius, fullHeight)
ctx.physics.addTrimeshCollider()              // static-only, uses entity.model
ctx.physics.addConvexCollider(points)         // flat [x,y,z,...], all motion types
ctx.physics.addConvexFromModel(meshIndex=0)   // extracts verts from entity.model GLB
ctx.physics.addForce([fx,fy,fz])              // velocity += force/mass
ctx.physics.setVelocity([vx,vy,vz])
```

### ctx.world
```js
ctx.world.spawn(id, config)        // id: string|null (null=auto-generate). Returns entity|null.
ctx.world.spawnChild(id, config)   // like spawn, but auto-destroyed when parent app tears down
ctx.world.destroy(id)
ctx.world.getEntity(id)            // entity|null
ctx.world.query(filterFn)          // entity[]
ctx.world.nearby(pos, radius)      // entity IDs within radius
ctx.world.reparent(eid, parentId)  // parentId null = detach
ctx.world.attach(entityId, appName) / detach(entityId)
ctx.world.gravity                  // [x,y,z] read-only

// spawn config keys: model, position, rotation, scale, parent, app, config, autoTrimesh
```

### ctx.players
```js
ctx.players.getAll()
// Player: { id, state: { position, velocity, health, onGround, crouch, lookPitch, lookYaw, interact } }
ctx.players.getById(id)                   // Player|null — direct lookup
ctx.players.getNearest([x,y,z], radius)   // Player|null
ctx.players.send(playerId, msg)           // client receives in onEvent(payload, engine)
ctx.players.broadcast(msg)
ctx.players.broadcastNearby(pos, radius, msg)  // send to all players within radius of pos
ctx.players.setPosition(playerId, [x,y,z])     // teleport — no collision check
```
Mutate `player.state.health` / `player.state.velocity` directly — propagates in next snapshot.

### ctx.bus
```js
ctx.bus.on('channel', (e) => { e.data; e.channel; e.meta })
ctx.bus.once('channel', handler)
ctx.bus.emit('channel', data)            // meta.sourceEntity set automatically
ctx.bus.on('combat.*', handler)          // wildcard prefix
ctx.bus.handover(targetEntityId, data)   // fires onHandover on target
```
`system.*` prefix is reserved — do not emit on it.

### ctx.time
```js
ctx.time.tick / deltaTime / elapsed
ctx.time.after(seconds, fn)  // one-shot, cleared on teardown
ctx.time.every(seconds, fn)  // repeating, cleared on teardown
```

### ctx.raycast
```js
const hit = ctx.raycast([x,y,z], [dx,dy,dz], maxDist)
// { hit:bool, distance:number, body:bodyId|null, position:[x,y,z]|null }
```

### ctx.storage
```js
if (ctx.storage) {
  await ctx.storage.set('key', value)
  const val = await ctx.storage.get('key')
  await ctx.storage.delete('key')
  const keys = await ctx.storage.list('')
}
```

---

## Client API

### render(ctx) — return value
```js
{ position:[x,y,z], rotation:[x,y,z,w], model:'path.glb', custom:{...}, ui:ctx.h('div',...) }
```

### render(ctx) — available fields
```js
ctx.entity          // { id, position, rotation, custom, model }
ctx.state           // alias for ctx.entity.custom
ctx.players         // array of all player states
ctx.h               // hyperscript createElement
ctx.network.send(msg)  // send message to server (entityId auto-attached)
ctx.engine          // full engineCtx (see below)

// Three.js shortcuts — same as ctx.engine.* but directly accessible:
ctx.THREE           // THREE namespace (BoxGeometry, MeshStandardMaterial, etc.)
ctx.scene           // THREE.Scene — ctx.scene.add(mesh)
ctx.camera          // THREE.PerspectiveCamera
ctx.renderer        // THREE.WebGLRenderer
ctx.playerId        // local player ID string
ctx.clock           // { elapsed: seconds since page load }
```

### engine object (setup/onFrame/onInput/onEvent/onKeyDown/onKeyUp second arg)
```js
engine.THREE / scene / camera / renderer
engine.playerId                              // local player ID
engine.network.send(msg)                     // send message to server from any hook
engine.client.state                          // { players:[...], entities:[...] }
engine.cam.getAimDirection(position)         // normalized [dx,dy,dz]
engine.cam.punch(intensity)                  // visual recoil
engine.players.getAnimator(playerId)
engine.players.setExpression(playerId, name, weight)
engine.players.setAiming(playerId, isAiming)
```

### App hooks — full list
```js
setup(engine)                     // called once on module load
render(ctx)                       // called every 250ms, returns render state + ui
onInput(input, engine)            // called every input tick (60Hz)
onEvent(payload, engine)          // called on server broadcast
onFrame(dt, engine)               // called every animation frame
onMouseDown(e, engine)            // mouse button press on canvas
onMouseUp(e, engine)              // mouse button release on canvas
onKeyDown(e, engine)              // keyboard key press (document-level)
onKeyUp(e, engine)                // keyboard key release (document-level)
```

### ctx.h — hyperscript + Ripple UI
```js
ctx.h(tag, props, ...children)  // props = attrs/inline styles or null; null children ignored
ctx.h('div', { style:'color:red' }, 'Hello')
```
Ripple UI CSS is loaded — use DaisyUI-compatible class names directly:
```js
ctx.h('button', { class: 'btn btn-primary' }, 'Click me')
ctx.h('div', { class: 'card bg-base-200 shadow-xl' },
  ctx.h('div', { class: 'card-body' },
    ctx.h('h2', { class: 'card-title' }, 'Hello'),
    ctx.h('button', { class: 'btn btn-sm btn-error' }, 'Delete')
  )
)
```
Client apps cannot use `import` — all import statements stripped before evaluation. Use `engine.*` for deps.

### onInput fields
`forward backward left right jump crouch sprint shoot reload interact yaw pitch`

### Webcam AFAN — lazy-loaded face tracking
Opt-in only. Not loaded at startup. Enable via the `webcam-avatar` app or manually:
```js
// In setup(engine) or onKeyDown — only loaded on demand
if (!window.enableWebcamAFAN) await import('/webcam-afan.js')
const tracker = await window.enableWebcamAFAN((data) => {
  // data: Uint8Array(52) — ARKit blendshape weights, each byte = weight * 255
  engine.network.send({ type: 'afan_frame', data: Array.from(data) })
})
// tracker.stop() to release camera
```
On the server, forward afan_frame to nearby players. Engine auto-applies received frames to target VRM morph targets when payload `{ type: 'afan_frame', playerId, data }` arrives via onAppEvent.

---

## Procedural Mesh (custom field)

When no GLB set, `custom` drives geometry — primary way to create primitives without any GLB file.

```js
{ mesh:'box',      color:0xff8800, roughness:0.8, sx:2, sy:1, sz:2 }   // sx/sy/sz = FULL dimensions
{ mesh:'sphere',   color:0x00ff00, r:1, seg:16 }
{ mesh:'cylinder', r:0.4, h:0.1, seg:16, color:0xffd700, metalness:0.8,
                   emissive:0xffa000, emissiveIntensity:0.3,
                   light:0xffd700, lightIntensity:1, lightRange:4 }
{ ..., hover:0.15, spin:1 }                  // Y oscillation amplitude (units), rotation (rad/sec)
{ ..., glow:true, glowColor:0x00ff88, glowIntensity:0.5 }
{ mesh:'box', label:'PRESS E' }
```

**sx/sy/sz are FULL size. addBoxCollider takes HALF-extents.** `sx:4,sy:2` → `addBoxCollider([2,1,...])`

---

## AppLoader — Blocked Strings

Any of these anywhere in source (including comments) silently prevents load, no throw:

`process.exit`  `child_process`  `require(`  `__proto__`  `Object.prototype`  `globalThis`  `eval(`  `import(`

---

## Critical Caveats

**Physics only activates inside app setup().** `entity.bodyType = 'static'` does nothing without an app calling `ctx.physics.*`.

```js
// WRONG — entity renders but players fall through:
const e = ctx.world.spawn('floor', {...}); e.bodyType = 'static'  // ignored

// CORRECT:
ctx.world.spawn('floor', { app:'box-static', config:{ hx:5, hy:0.25, hz:5 } })
```

**maxSpeed default mismatch.** Code default is 8.0. Always set `movement.maxSpeed` explicitly.

**Horizontal velocity is wish-based.** After physics step, wish velocity overwrites XZ physics result. `player.state.velocity[0/2]` = wish velocity. Only `velocity[1]` (Y) comes from physics.

**Capsule parameter order.** `addCapsuleCollider(radius, fullHeight)` — full height, halved internally. Reversed from Jolt's direct API which takes (halfHeight, radius).

**Trimesh is static-only.** Use `addConvexCollider` or `addConvexFromModel` for dynamic/kinematic.

**`setTimeout` not cleared on hot reload.** `ctx.time.*` IS cleared. Manage raw timers manually in teardown.

**Destroying parent destroys all children.** Reparent first to preserve: `ctx.world.reparent(childId, null)`

**setPosition teleports through walls** — physics pushes out next tick.

**App sphere collision is O(n²).** Keep interactive entity count under ~50.

**Snapshots only sent when players > 0.** Entity state still updates, nothing broadcast.

**TickSystem max 4 steps per loop.** >4 ticks behind (~62ms at 64TPS) = silent drop.

**Player join/leave arrive via onMessage:**
```js
onMessage(ctx, msg) {
  if (!msg) return
  const pid = msg.playerId || msg.senderId
  if (msg.type === 'player_join') { /* ... */ }
  if (msg.type === 'player_leave') { /* ... */ }
}
```

---

## Debug Globals

```
Server (Node REPL): globalThis.__DEBUG__.server
Client (browser):   window.debug  →  scene, camera, renderer, client, players, input
```
