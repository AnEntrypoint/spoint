---
name: spoint
description: Work with spoint - a multiplayer physics game server SDK. Scaffolds apps locally, runs engine from npm package.
---

# spoint

You are helping a developer work with the spoint multiplayer game server SDK.

## Setup (First Time)

When no `apps/` directory exists in the current working directory, scaffold it:

```bash
bunx spoint scaffold
bunx spoint
```

This copies the default apps (world config, tps-game, environment, etc.) into `./apps/` and starts the server. The engine (src/, client/) always comes from the npm package - never from the user's local folder.

## Daily Use

```bash
bunx spoint          # start server (port 3001, 128 TPS)
```

Open http://localhost:3001 in browser. Apps hot-reload on file save — both server AND client receive updated code automatically, no manual refresh needed.

## Creating Apps

```bash
bunx spoint-create-app my-app
bunx spoint-create-app --template physics my-physics-object
bunx spoint-create-app --template interactive my-button
bunx spoint-create-app --template spawner my-spawner
```

## App Structure

Apps live in `apps/<name>/index.js` and export a default object:

```js
export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = { mesh: 'box', color: 0x00ff00 }
      ctx.physics.setStatic(true)
      ctx.physics.addBoxCollider([0.5, 0.5, 0.5])
    },
    update(ctx, dt) {},
    teardown(ctx) {}
  },
  client: {
    setup(engineCtx) {},       // runs once when app module loads on client
    teardown(engineCtx) {},    // called before hot reload replaces the module
    onFrame(dt, engineCtx) {}, // called every render frame
    onEvent(payload, engineCtx) {}, // called on APP_EVENT from server
    render(ctx) {              // called ~4x/sec for UI overlay only (not 3D)
      return { ui: null }
    }
  }
}
```

## World Config

Edit `apps/world/index.js` to configure port, tickRate, gravity, movement, entities, and scene. The `entities` array auto-spawns apps on start:

```js
export default {
  port: 3001,
  tickRate: 128,
  entities: [
    { id: 'my-thing', position: [0, 0, 0], app: 'my-app' }
  ]
}
```

## Spawning Entities Dynamically

`ctx.world.spawn(id, config)` creates a new entity and returns it. You can mutate the returned object:

```js
const entity = ctx.world.spawn('my-car', {
  position: [10, 5, 0],
  rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],  // quaternion [x,y,z,w]
  model: './apps/my-app/car.glb'
})
// CRITICAL: scale MUST go in custom.scale — it is not in the snapshot wire format
entity.custom = { scale: [1.5, 1.5, 1.5] }

ctx.world.destroy('my-car')
ctx.world.getEntity('my-car')  // returns entity or null
```

**Rotation is quaternion `[x, y, z, w]`**. For Y-axis rotation of angle θ: `[0, Math.sin(θ/2), 0, Math.cos(θ/2)]`.

## Simulating Gravity for Spawned Entities

Spawned entities are NOT automatically simulated by Jolt. To make them fall, simulate gravity in `update()`:

```js
setup(ctx) {
  ctx.state.velocities = {}
},
update(ctx, dt) {
  for (const [id, vy] of Object.entries(ctx.state.velocities)) {
    const ent = ctx.world.getEntity(id)
    if (!ent || ent.position[1] <= GROUND_Y) continue
    ctx.state.velocities[id] += -9.81 * dt
    ent.position[1] = Math.max(GROUND_Y, ent.position[1] + ctx.state.velocities[id] * dt)
  }
}
```

Mutating `ent.position` directly updates the snapshot sent to all clients.

## Key Facts

- Engine files (src/, client/) come from the npm package — never edit them
- Only `apps/` is local to the user's project (their CWD)
- `ctx.state` survives hot reload; timers and bus subscriptions do not
- 128 TPS server, 60Hz client input, exponential lerp interpolation
- **Client app modules cannot use `import` or `globalThis`** — evaluated via `new Function()`. All dependencies come from `engineCtx`.
- Hot reload: server tears down + restarts app; client receives new module and calls `teardown()` then `setup()` automatically
- AppLoader blocks these strings (app silently fails if found, even in comments): `process.exit`, `child_process`, `require(`, `__proto__`, `Object.prototype`, `globalThis`, `eval(`, `import(`

## ctx API Reference

```js
ctx.entity.id / .position / .rotation / .scale / .velocity / .custom / .model

ctx.physics.setStatic(true)
ctx.physics.setDynamic(true)
ctx.physics.setMass(kg)
ctx.physics.addBoxCollider([halfX, halfY, halfZ])
ctx.physics.addSphereCollider(radius)
ctx.physics.addCapsuleCollider(radius, height)
ctx.physics.addTrimeshCollider()  // uses entity.model as collision mesh

ctx.world.spawn(id, config)    // returns entity object
ctx.world.destroy(id)
ctx.world.getEntity(id)
ctx.world.query(filterFn)
ctx.world.nearby(pos, radius)
ctx.world.gravity              // [x, y, z]

ctx.players.getAll()
ctx.players.send(playerId, msg)
ctx.players.broadcast(msg)
ctx.players.setPosition(playerId, pos)

ctx.state                      // persists across hot reloads
ctx.time.tick / .deltaTime / .elapsed
ctx.time.after(seconds, fn)
ctx.time.every(seconds, fn)

ctx.bus.on(channel, fn)
ctx.bus.emit(channel, data)

ctx.network.broadcast(msg)
ctx.network.sendTo(playerId, msg)

ctx.storage.get(key) / .set(key, value) / .delete(key)

ctx.debug.log(...)
```

## Server App Hooks

```js
server: {
  setup(ctx) {},
  update(ctx, dt) {},
  teardown(ctx) {},
  onMessage(ctx, msg) {},        // msg from client APP_EVENT
  onInteract(ctx, player) {},    // player pressed interact near entity
  onCollision(ctx, other) {}     // entity-entity collision (sphere-based)
}
```

## Physics

```js
// Static ground collider
ctx.physics.setStatic(true)
ctx.physics.addBoxCollider([halfX, halfY, halfZ])

// Dynamic entity (ctx.entity only — spawned entities need manual gravity)
ctx.physics.setDynamic(true)
ctx.physics.setMass(5)
```

## EventBus

```js
ctx.bus.on('combat.hit', (data) => {})
ctx.bus.emit('combat.hit', { damage: 10 })
// Wildcard: 'combat.*' catches all combat.* events
```

## Debugging

- Server: `globalThis.__DEBUG__.server` in Node REPL
- Client: `window.debug` in browser console (exposes scene, camera, renderer, client)
