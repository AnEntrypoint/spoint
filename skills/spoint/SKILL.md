---
name: spoint
description: Build multiplayer physics games with the Spawnpoint engine. Use when asked to: create a game, add physics objects, spawn entities, build an arena, handle player interaction, add weapons respawn scoring, create moving platforms, manage world config, load 3D models, add HUD/UI, work with the EventBus, or develop any app inside an apps directory.
---

# Spawnpoint App Development Reference

Setup:
```bash
bunx spoint scaffold   # first time — copies default apps/ into cwd
bunx spoint            # start server (localhost:3001)
bunx spoint-create-app my-app
bunx spoint-create-app --template physics my-crate
```

Project structure: `apps/world/index.js` (world config) + `apps/<name>/index.js` (apps). Engine is from npm — never edit engine source.

---

## Quick Start — Minimal Working Arena

### `apps/world/index.js`
```js
export default {
  port: 3001, tickRate: 128, gravity: [0, -9.81, 0],
  movement: { maxSpeed: 4.0, groundAccel: 10.0, airAccel: 1.0, friction: 6.0, stopSpeed: 2.0, jumpImpulse: 4.0 },
  player: { health: 100, capsuleRadius: 0.4, capsuleHalfHeight: 0.9, modelScale: 1.323, feetOffset: 0.212 },
  scene: { skyColor: 0x87ceeb, fogColor: 0x87ceeb, fogNear: 80, fogFar: 200, sunIntensity: 1.5, sunPosition: [20, 40, 20] },
  entities: [{ id: 'arena', position: [0,0,0], app: 'arena' }],
  spawnPoint: [0, 2, 0]
}
```

### `apps/arena/index.js`
```js
const HALF = 12, WH = 3, WT = 0.5
const WALLS = [
  { id:'wn', x:0,     y:WH/2, z:-HALF, hx:HALF,  hy:WH/2, hz:WT/2 },
  { id:'ws', x:0,     y:WH/2, z: HALF, hx:HALF,  hy:WH/2, hz:WT/2 },
  { id:'we', x: HALF, y:WH/2, z:0,     hx:WT/2,  hy:WH/2, hz:HALF },
  { id:'ww', x:-HALF, y:WH/2, z:0,     hx:WT/2,  hy:WH/2, hz:HALF },
]
export default {
  server: {
    setup(ctx) {
      ctx.state.ids = ctx.state.ids || []
      if (ctx.state.ids.length > 0) return  // hot-reload guard
      ctx.entity.custom = { mesh:'box', color:0x5a7a4a, sx:HALF*2, sy:0.5, sz:HALF*2 }
      ctx.physics.setStatic(true)
      ctx.physics.addBoxCollider([HALF, 0.25, HALF])
      for (const w of WALLS) {
        const e = ctx.world.spawn(w.id, { position:[w.x,w.y,w.z], app:'box-static', config:{ hx:w.hx, hy:w.hy, hz:w.hz, color:0x7a6a5a } })
        if (e) ctx.state.ids.push(w.id)
      }
    },
    teardown(ctx) { for (const id of ctx.state.ids||[]) ctx.world.destroy(id); ctx.state.ids = [] }
  },
  client: { render({ entity }) { return { ui: null } } }
}
```

### `apps/box-static/index.js`
```js
export default {
  server: {
    setup(ctx) {
      const c = ctx.config
      ctx.entity.custom = { mesh:'box', color:c.color??0x888888, sx:(c.hx??1)*2, sy:(c.hy??1)*2, sz:(c.hz??1)*2 }
      ctx.physics.setStatic(true)
      ctx.physics.addBoxCollider([c.hx??1, c.hy??1, c.hz??1])
    }
  }
}
```

---

## World Config

`apps/world/index.js` exports a plain object. All fields optional.

**Top-level:** `port` (default 3001), `tickRate` (default 128), `gravity` — `[x,y,z]` array (default `[0,-9.81,0]`), `playerModel` — path to `.vrm` file, `spawnPoint` — `[x,y,z]`.

**`movement`:** `maxSpeed` (code default 8.0 — always override; world template uses 4.0), `groundAccel`, `airAccel`, `friction`, `stopSpeed`, `jumpImpulse` (velocity SET, not added), `crouchSpeedMul` (default 0.4), `sprintSpeed` (null = maxSpeed x 1.75), `collisionRestitution`, `collisionDamping`.

**`player`:** `health`, `capsuleRadius`, `capsuleHalfHeight`, `crouchHalfHeight`, `mass`, `modelScale` (default 1.323), `feetOffset` (feetOffset x modelScale = negative Y on model, default 0.212).

**`scene`:** `skyColor`, `fogColor`, `fogNear`, `fogFar`, `ambientColor`, `ambientIntensity`, `sunColor`, `sunIntensity`, `sunPosition` — `[x,y,z]`, `fillColor`, `fillIntensity`, `fillPosition`, `shadowMapSize`, `shadowBias`, `shadowNormalBias`, `shadowRadius`, `shadowBlurSamples`.

**`camera`:** `fov`, `shoulderOffset`, `headHeight`, `zoomStages` — array of distances, `defaultZoomIndex`, `followSpeed`, `snapSpeed`, `mouseSensitivity`, `pitchRange` — `[min,max]` radians.

**`animation`:** `mixerTimeScale`, `walkTimeScale`, `sprintTimeScale`, `fadeTime`.

**`entities`:** array of `{ id, app, model, position, rotation, scale, config }`. Entities listed here are part of the loading gate. Entities spawned at runtime via `ctx.world.spawn()` are not.

---

## Loading Screen Gate

Holds until all pass simultaneously: WebSocket connected, player VRM downloaded, first snapshot received, all `world.entities` entries with a `model` field loaded. Runtime-spawned entities never block the gate.

---

## Remote Models

URL base: `https://raw.githubusercontent.com/anEntrypoint/assets/main/FILENAME.glb`

Never guess filenames — wrong URLs 404 silently.

Known filenames: `broken_car_b6d2e66d_v1.glb`, `broken_car_b6d2e66d_v2.glb`, `crashed_car_f2b577ae_v1.glb`, `crashed_pickup_truck_ae555020_v1.glb`, `crashed_rusty_minivan_f872ff37_v1.glb`, `Bus_junk_1.glb`, `blue_shipping_container_60b5ea93_v1.glb`, `blue_shipping_container_63cc3905_v1.glb`, `dumpster_b076662a_v1.glb`, `dumpster_b076662a_v2.glb`, `garbage_can_6b3d052b_v1.glb`, `crushed_oil_barrel_e450f43f_v1.glb`, `fire_hydrant_ba0175c1_v1.glb`, `fire_extinguisher_wall_mounted_bc0dddd4_v1.glb`, `break_room_chair_14a39c7b_v1.glb`, `break_room_couch_444abf63_v1.glb`, `break_room_table_09b9fd0d_v1.glb`, `filing_cabinet_0194476c_v1.glb`, `fancy_reception_desk_58fde71d_v1.glb`, `cash_register_0c0dcad2_v1.glb`, `espresso_machine_e722ed8c_v1.glb`, `Couch.glb`, `Couch_2.glb`, `3chairs.glb`, `large_rock_051293c4_v1.glb`, `Tin_Man_1.glb`, `Tin_Man_2.glb`, `Plants_3.glb`, `Urinals.glb`, `V_Machine_2.glb`.

Remote models are not in the loading gate. Remote URLs cannot be read server-side by `addTrimeshCollider` or `addConvexFromModel` — use primitive colliders instead.

---

## App Module Shape

Every app exports a plain object with `server` and/or `client` keys. All hooks are optional.

Server hooks: `setup(ctx)`, `update(ctx, dt)`, `teardown(ctx)`, `onInteract(ctx, player)`, `onMessage(ctx, msg)`, `onCollision(ctx, other)`, `onHandover(ctx, sourceEntityId, data)`.

Client hooks: `setup(engine)`, `render({ entity, state, h, engine, players })`, `onEvent(payload, engine)`, `onInput(input, engine)`, `onFrame(dt, engine)`, `onMouseDown(event, engine)`, `onMouseUp(event, engine)`.

`onCollision` — other is `{ id, position, velocity }`. Entity-entity sphere overlap only; separate from Jolt physics collisions.

`onHandover` — fired when another entity calls `ctx.bus.handover(thisEntityId, data)`.

`onMessage` — receives all APP_EVENT messages from clients and system events. Player join/leave arrive here as `{ type: 'player_join', playerId }` and `{ type: 'player_leave', playerId }`. Client-sent custom events include `senderId` (the client's player id).

Client `setup(engine)` fires once at module load time, not per entity. All other client hooks fire for every registered app module per event.

---

## Server ctx API

### ctx.entity

- `id` — string, read-only
- `model` — string|null, read-only
- `position` — `[x,y,z]`, readable and writable
- `rotation` — `[x,y,z,w]` quaternion, readable and writable
- `scale` — `[x,y,z]`, readable and writable
- `velocity` — `[x,y,z]`, readable and writable
- `custom` — any value; sent in every snapshot — keep small
- `parent` — entity id string|null, read-only
- `children` — copy of child id Set as array; mutating the array does not affect the entity
- `worldTransform` — `{ position, rotation, scale }` computed recursively up parent chain, read-only
- `destroy()` — destroys this entity

### ctx.state

Persists across hot reloads. `ctx.state` is a plain object reference stored on the entity. Re-register all timers and bus subscriptions in every `setup()` call — they are cleared on teardown. Use `ctx.state.x = ctx.state.x || defaultValue` to preserve values across reloads.

### ctx.config

Read-only. Populated from the `config` field in `world.entities` or `ctx.world.spawn()` config.

### ctx.physics

- `setStatic(true)` — marks entity bodyType static
- `setDynamic(true)` — marks entity bodyType dynamic
- `setKinematic(true)` — marks entity bodyType kinematic
- `setMass(kg)` — sets entity mass
- `addBoxCollider(size)` — size is a number (cube) or `[hx,hy,hz]` half-extents. Creates Jolt physics body.
- `addSphereCollider(radius)` — creates sphere physics body
- `addCapsuleCollider(radius, fullHeight)` — fullHeight is total height; halved internally before passing to Jolt
- `addTrimeshCollider()` — exact triangle mesh from `entity.model` GLB. Static only. Reads from disk.
- `addConvexCollider(points)` — flat `[x,y,z,x,y,z,...]` vertex array. Any motion type.
- `addConvexFromModel(meshIndex=0)` — extracts vertices from `entity.model` GLB and builds convex hull. Any motion type.
- `addForce([fx,fy,fz])` — instant velocity change: velocity += force / mass. Not continuous.
- `setVelocity([vx,vy,vz])` — sets velocity directly

Shape rules: box/sphere/capsule are fastest and work with any motion type. Trimesh is static only — use for terrain and environments. Convex hull works with any motion type — use for all dynamic props.

### ctx.interactable(config)

Registers entity as interactable. Engine handles proximity detection, E-key prompt, and cooldown. Config fields: `prompt` (string, default `'Press E'`), `radius` (number, default 3), `cooldown` (milliseconds, default 500). The `onInteract(ctx, player)` hook fires when a player presses E within range.

### ctx.world

- `spawn(id, config)` — id is string|null (null auto-generates id). Returns entity object or null. Config fields: `model`, `position`, `rotation`, `scale`, `parent`, `app`, `config`, `autoTrimesh`. Setting `autoTrimesh: true` automatically calls `addStaticTrimesh` on `entity.model` at spawn — static only.
- `destroy(id)` — destroys entity by id string. Cascades to all children.
- `getEntity(id)` — returns entity object or null
- `query(filterFn)` — returns array of entity objects passing the filter. filterFn receives the raw entity object.
- `nearby(pos, radius)` — returns array of entity id strings, not entity objects. Call `getEntity(id)` to resolve each.
- `reparent(entityId, parentId)` — parentId null detaches from parent
- `attach(entityId, appName)` — attaches a named app to an existing entity
- `detach(entityId)` — detaches current app from entity
- `gravity` — `[x,y,z]`, read-only

### ctx.players

- `getAll()` — returns array of player objects. Each player: `{ id, state: { position, velocity, health, onGround, crouch, lookPitch, lookYaw, interact } }`. `interact` is true the tick the player pressed E.
- `getNearest(pos, radius)` — returns nearest player object within radius or null
- `send(playerId, msg)` — client receives in `onEvent(payload, engine)`
- `broadcast(msg)` — sends to all connected clients
- `setPosition(playerId, [x,y,z])` — teleports player; no collision check

Mutate `player.state.health` and `player.state.velocity` directly — changes propagate in next snapshot.

### ctx.bus

- `on(channel, handler)` — subscribes; returns unsubscribe function. Handler receives `{ data, channel, meta }`. `meta.sourceEntity` is the emitting entity's id.
- `once(channel, handler)` — one-time subscription
- `emit(channel, data)` — emits event; `meta.sourceEntity` auto-set to this entity's id
- `handover(targetEntityId, data)` — fires `onHandover(ctx, sourceEntityId, data)` on target entity
- Wildcard: subscribing to `'combat.*'` matches `combat.fire`, `combat.hit`, etc.
- `system.*` prefix is reserved — do not emit on it
- All subscriptions auto-cleaned on teardown — no manual cleanup needed

### ctx.time

- `tick` — current tick count, read-only
- `deltaTime` — seconds since last tick, read-only
- `elapsed` — total elapsed seconds, read-only
- `after(seconds, fn)` — one-shot timer; cleared on teardown
- `every(seconds, fn)` — repeating timer; cleared on teardown

### ctx.raycast(origin, direction, maxDistance)

Returns `{ hit: bool, distance: number, body: bodyId|null, position: [x,y,z]|null }`. Returns `{ hit: false }` if physics not initialized.

### ctx.storage

Null if no storage adapter is configured — always guard with `if (ctx.storage)`. Keys are auto-namespaced as `appName/key`.

- `get(key)` — Promise resolving to value or undefined
- `set(key, value)` — Promise
- `delete(key)` — Promise
- `list(prefix)` — Promise resolving to array of keys matching prefix (after namespace)
- `has(key)` — Promise resolving to bool

### ctx.network

- `broadcast(msg)` — alias for `ctx.players.broadcast`
- `sendTo(playerId, msg)` — alias for `ctx.players.send`

### ctx.debug

All methods prefix output with entity id and elapsed time; output goes to server console.

- `log(message)`
- `spawn(entity, position)` — logs spawn event
- `collision(a, b, position)` — logs collision between two entity ids
- `hit(shooter, target, damage)` — logs hit event with hp value
- `death(entity, damage)`
- `respawn(entity, position)`
- `state(entity, key, value)` — logs state change
- `perf(label, ms)` — logs timing with pass/warn/fail indicator (green <10ms, yellow <20ms, red >=20ms)
- `error(category, message)` — logs to stderr

---

## GLB File Pipeline

Place GLB under `apps/<appname>/`. The static server resolves `GET /apps/<appname>/file.glb` from disk; project-local `apps/` checked before SDK `apps/`. Files are gzip-compressed on first serve and memory-cached with ETag.

Declare in `world.entities` with a `model` field to add the model to the loading gate. The `model` path is resolved relative to `process.cwd()`. Use `./apps/...` prefix.

Server-side physics: `addTrimeshCollider()` reads `entity.model` from disk synchronously and builds an exact triangle mesh (static only). `addConvexFromModel(meshIndex)` reads vertices and builds a convex hull (any motion type). Remote URLs cannot be used by either method.

Client-side display: the client receives entity snapshots and fetches the model URL automatically. `renderer.compileAsync()` is called immediately after `scene.add()` to avoid GPU stall on first render. The `client.render()` function cannot affect model, position, or rotation — those are driven by the server snapshot.

---

## Client API

### engine object

- `engine.THREE` — Three.js library
- `engine.scene` — `THREE.Scene`
- `engine.camera` — `THREE.PerspectiveCamera`
- `engine.renderer` — `THREE.WebGLRenderer`
- `engine.playerId` — local player id string
- `engine.worldConfig` — full world config object, read-only
- `engine.inputConfig` — current input config object
- `engine.setInputConfig(cfg)` — merges cfg into inputConfig; `{ pointerLock: false }` releases mouse lock
- `engine.playerVrms` — `Map<playerId, VRM>` for direct VRM object access
- `engine.mobileControls` — mobile controls instance or null on desktop
- `engine.createElement` — hyperscript function (same as `h` in render)
- `engine.client` — raw network client; do not use directly
- `engine.cam.getAimDirection()` — normalized `[dx,dy,dz]` from camera look direction
- `engine.cam.punch(intensity)` — visual camera recoil (number, e.g. 0.05)
- `engine.players.getMesh(playerId)` — `THREE.Group|undefined`
- `engine.players.getState(playerId)` — player snapshot state or undefined
- `engine.players.getAnimator(playerId)` — `THREE.AnimationMixer|undefined`
- `engine.players.setExpression(playerId, expressionName, weight)` — VRM facial expression, weight 0-1
- `engine.players.setAiming(playerId, isAiming)` — controls VRM aim IK blend

### render()

Called once per entity per frame. Return shape: `{ ui: element|null }`. Only `ui` is consumed — returning position, rotation, model, or custom has no effect on display. Parameters: `entity` (snapshot: `{ id, position, rotation, scale, model, custom, parent }`), `state` (alias for `entity.custom`, same object reference), `players` (array of all player snapshot objects), `h` (hyperscript), `engine`.

### h — hyperscript

`h(tag, props, ...children)` — props are attributes/inline styles or null; null children are ignored. Client apps cannot use `import` — all import statements are stripped before evaluation. Use `engine.*` for all dependencies.

### onInput fields

Desktop: `forward`, `backward`, `jump`, `sprint`, `crouch`, `shoot`, `reload`, `interact`, `editToggle`, `mouseX` (screen pixels), `mouseY` (screen pixels), `yaw` (cumulative radians), `pitch` (cumulative radians). `editToggle` is true while P key is held — engine edit mode, not for app use.

Mobile additionally provides: `isMobile: true`, `analogForward`, `analogRight`, `zoom`, `weapon`, `yawDelta`, `pitchDelta`.

Mutating input inside `onInput` does not affect what is sent to the server — treat as read-only.

---

## Procedural Mesh (custom field)

When no `model` is set on an entity, `entity.custom` drives client-side geometry.

Box: `{ mesh:'box', color:0xff8800, roughness:0.8, sx:2, sy:1, sz:2 }` — sx/sy/sz are FULL dimensions.

Sphere: `{ mesh:'sphere', color:0x00ff00, r:1, seg:16 }`.

Cylinder: `{ mesh:'cylinder', r:0.4, h:0.1, seg:16, color:0xffd700, metalness:0.8, emissive:0xffa000, emissiveIntensity:0.3, light:0xffd700, lightIntensity:1, lightRange:4 }`.

Animation fields (any mesh type): `hover` — Y oscillation amplitude in units per cycle; `spin` — Y rotation in rad/sec; `rotX` — static X rotation offset in radians; `rotZ` — static Z rotation offset in radians.

Label: add `label: 'text'` to any custom object to display text above the entity.

`glow`, `glowColor`, `glowIntensity` do not exist — no glow post-process is implemented. Use `emissive` + `emissiveIntensity` for bright materials.

`addBoxCollider` takes HALF-extents. If `custom` has `sx:4, sy:2`, use `addBoxCollider([2, 1, ...])`.

---

## AppLoader Blocked Strings

Any of these anywhere in app source — including comments — silently prevents the app from loading with no error thrown:

`process.exit`, `child_process`, `require(`, `__proto__`, `Object.prototype`, `globalThis`, `eval(`, `import(`

---

## Debug Globals

Server Node REPL: `globalThis.__DEBUG__.server` — full server API.

Browser console: `window.debug` — exposes `scene`, `camera`, `renderer`, `client`, player mesh maps, and input handler.

---

## Critical Caveats

**Physics only activates inside app `setup()`** — setting `entity.bodyType = 'static'` outside an app does nothing. Always use `ctx.physics.setStatic(true)` plus a collider method inside setup.

**`maxSpeed` code default is 8.0** — always set `movement.maxSpeed` explicitly in world config.

**Horizontal velocity is wish-based** — after the physics step, wish velocity overwrites XZ physics. `player.state.velocity[0]` and `[2]` reflect wish velocity. Only `velocity[1]` (Y) comes from physics.

**`addCapsuleCollider(radius, fullHeight)`** — second argument is total height, halved internally. This is reversed from Jolt's native `(halfHeight, radius)` order.

**Trimesh is static only** — use `addConvexCollider` or `addConvexFromModel` for dynamic or kinematic bodies.

**`ctx.time.*` timers are cleared on teardown — raw `setTimeout` calls are not.** Manage raw timers in teardown manually.

**Destroying a parent destroys all children** — reparent to null first to preserve children: `ctx.world.reparent(childId, null)`.

**`setPosition` teleports through walls** — physics resolves overlap next tick.

**`ctx.world.nearby()` returns entity id strings, not entity objects** — call `ctx.world.getEntity(id)` to resolve.

**`render()` return value only drives `ui`** — returning position/rotation/model/custom from render is ignored.

**No `ctx` on the client side** — client hooks receive `engine` as argument. There is no `ctx` in any client hook.

**`ctx.world.spawn()` returns the entity object, not its id** — access `entity.id` for the string id.

**Snapshots only broadcast when players > 0** — entity state still updates server-side; nothing is sent with zero connected players.

**App sphere collision is O(n^2)** — keep interactive entity count under ~50. The hook name is `onCollision`, not `onCollide`.
