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

Open http://localhost:3001 in browser. Apps hot-reload on file save.

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
    render(ctx) {
      return { position: ctx.entity.position, rotation: ctx.entity.rotation, custom: ctx.entity.custom }
    }
  }
}
```

## World Config

Edit `apps/world/index.js` to configure port, tickRate, gravity, movement, entities, and scene. The `entities` array auto-spawns apps on start.

## Key Facts

- Engine files (src/, client/) come from the npm package - never edit them
- Only `apps/` is local to the user's project (their CWD)
- `ctx.state` survives hot reload; timers and bus subscriptions do not
- 128 TPS server, 60Hz client input, exponential lerp interpolation

## Physics

```js
// Static
ctx.physics.setStatic(true)
ctx.physics.addBoxCollider([halfX, halfY, halfZ])

// Dynamic
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
