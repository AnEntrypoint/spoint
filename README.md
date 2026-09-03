# spoint

Physics and netcode SDK for authoritative-server multiplayer games. Jolt physics, hot reload, app-based world logic, Three.js client.

**Demo**: https://anentrypoint.github.io/spoint/

## Quick Start

```bash
npx spoint
# or
npm install && npm start
# open http://localhost:3001              -> multiplayer (WebSocket to this server)
# open http://localhost:3001/?singleplayer -> in-browser server (runs the same server in a Worker)
```

There is **one** server. `npm start` runs a single `node server.js` on one port (`worldDef.port`,
default `3001`). Multiplayer is `/`; the in-browser / singleplayer mode is `/?singleplayer` on the
**same origin** — the client (`client/app.js`) picks a WebSocket client vs an in-Worker `BrowserServer`
from the query string, not a second port. Do **not** run a second `node server.js` on a different
`PORT` for the same project: each process freezes its own `node_modules`/asset snapshot at boot, so two
instances drift (the "`:3001` and a script-default `:8090` look different" trap). Dev/eval scripts that
default to `PORT=8090` just start that one server on another port; use one instance and `/?singleplayer`
instead. The server refuses a second instance on an in-use port with a clear message.

## Creating Apps

```bash
node ./bin/create-app.js my-app
```

Or manually create `apps/<name>/index.js`:

```javascript
export default {
  server: {
    setup(ctx) {
      ctx.state.counter = ctx.state.counter || 0
    },
    update(ctx, dt) {
      ctx.state.counter += dt
    },
    onInteract(ctx, player) { },
    onCollision(ctx, other) { }
  },
  client: {
    setup(engine) { },
    render(ctx) {
      return { custom: { mesh: 'box', color: 0xff0000, sx: 1, sy: 1, sz: 1 } }
    }
  }
}
```

## World Config (`apps/world/index.js`)

```javascript
export default {
  port: 3001,
  tickRate: 64,
  gravity: [0, -18, 0],
  movement: { maxSpeed: 14, sprintSpeed: 24, groundAccel: 300, airAccel: 30, friction: 5, stopSpeed: 1, jumpImpulse: 5.5 },
  player: { health: 100, capsuleRadius: 0.28, capsuleHalfHeight: 0.63, modelScale: 1.323, feetOffset: 0.212 },
  scene: { skyColor: 0x54c5eb, sunColor: 0xffffff, sunIntensity: 1.5, sunPosition: [21, 50, 20] },
  camera: { fov: 70, shoulderOffset: 0.35, zoomStages: [0, 1.5, 3, 5, 8], defaultZoomIndex: 2 },
  entities: [
    { id: 'env', model: './apps/maps/mymap.glb', position: [0, 0, 0], scale: [1, 1, 1], bodyType: 'static' },
    { id: 'game', position: [0, 0, 0], app: 'tps-game' }
  ],
  playerModel: './apps/tps-game/cleetus.vrm',
  spawnPoint: [0, 2, 0]
}
```

## Server-Side ctx API

| Property | Description |
|---|---|
| `ctx.state` | Persistent state (survives hot reload) |
| `ctx.entity` | `.id`, `.position`, `.rotation`, `.scale`, `.velocity`, `.custom`, `.destroy()` |
| `ctx.physics` | `.addBoxCollider()`, `.addSphereCollider()`, `.addCapsuleCollider()`, `.addTrimeshCollider()`, `.addConvexFromModel()` |
| `ctx.interactable({ prompt, radius })` | Register E-key interaction |
| `ctx.world` | `.spawn(id, cfg)`, `.destroy(id)`, `.getEntity(id)`, `.query(filter)` |
| `ctx.players` | `.getAll()`, `.send(pid, msg)`, `.broadcast(msg)`, `.setPosition(pid, pos)` |
| `ctx.time` | `.tick`, `.deltaTime`, `.elapsed`, `.after(sec, fn)`, `.every(sec, fn)` |
| `ctx.bus` | `.on(channel, fn)`, `.emit(channel, data)` — wildcard `*` suffix supported |
| `ctx.lagCompensator` | `.getPlayerStateAtTime(pid, ms)` for hit detection |
| `ctx.raycast(origin, dir, maxDist)` | Physics raycast |

## Client Engine API

| Property | Description |
|---|---|
| `engine.scene` | THREE.Scene |
| `engine.camera` | THREE.PerspectiveCamera |
| `engine.renderer` | THREE.WebGLRenderer or WebGPURenderer |
| `engine.THREE` | Three.js module |
| `engine.client` | Network client (PhysicsNetworkClient for multiplayer, or in-Worker BrowserServer for `?singleplayer`) |
| `engine.playerId` | Local player ID |
| `engine.cam` | Camera controller |
| `engine.players` | `.getMesh(id)`, `.getState(id)`, `.getAnimator(id)` |

## Editor (in-browser)

Press `P` to toggle editor mode:
- `G` / `R` / `S` — translate / rotate / scale gizmo
- `F` — focus camera on selected entity
- `Del` — delete selected entity
- Drag-and-drop `.glb` files to place models

## Singleplayer Mode

Add `?singleplayer` to the URL to run the **same server inside a Web Worker** (`BrowserServer` +
`src/sdk/WorkerEntry.js`) instead of connecting to it over WebSocket — same origin, same code, no
separate process. `?world=<name>` selects the world (default `tps-game`); `singleplayer-world.json`
is the last-resort fallback.

## Architecture

```
server.js                         Entry point
src/sdk/server.js                 Creates subsystems
src/sdk/TickHandler.js            Per-tick: movement → physics → collisions → apps → snapshot
src/physics/World.js              Jolt physics wrapper
src/netcode/PhysicsIntegration.js CharacterVirtual per player
src/apps/AppRuntime.js            Entity system, app lifecycle
client/app.js                     Three.js renderer, VRM loading, input loop
client/BrowserServer.js           Runs the server in a Web Worker for ?singleplayer (same origin)
```

## Production Build

```bash
npm run build:client
```

Bundles `client/app.js` and its static relative-import graph (`client/core/`, `client/hud/`, etc.)
into a single minified `dist/client/app.js` via esbuild (`scripts/bundle-client.mjs`). Third-party
packages that rely on `import.meta.url`-relative asset loading (`three`, `mapspinner`,
`jolt-physics`, `streaming-gltf`'s worker/loader siblings) and runtime-determined dynamic
`import()`s (per-world app modules) are left external, not inlined.

`buildStaticDirs` (`src/sdk/server.js`) mounts `dist/client/` at the same `/` prefix as the raw
`client/` dir, listed first — `StaticHandler`'s per-mount fallthrough serves the bundled
`dist/client/app.js` in place of the raw `client/app.js` automatically whenever the bundle exists
on disk, and falls back to raw ESM (no-cache, hot-reload-friendly) otherwise. No env var or flag
needed: build once (`npm run build:client`) before deploying, or skip it entirely for local dev.

### Publishing to itch.io / GitHub Pages (no backend server)

```bash
node scripts/static-export.mjs dist-static
```

Assembles a fully static, backend-less export (bundled client + bundled Worker-side server code +
the exact `node_modules`/`apps` subset needed) ready for itch.io's HTML5 upload or a GitHub Pages
branch — see [`docs/publish.md`](docs/publish.md) for the full recipe, base-path handling for
project-site subpaths, and verification steps.

## Load Testing

```bash
npm run bots
```

Env vars: `BOT_COUNT`, `BOT_DURATION`, `BOT_HZ`, `BOT_URL`

## Documentation

- **Getting Started**: `docs/getting-started.md` — Full tutorial, world/app creation, API reference
- **Quick Reference**: `docs/quick-reference.md` — Cheatsheet for config, physics, client, network messages
- **Architecture**: `docs/architecture-decisions.md`
- **Rendering**: `docs/rendering.md`
- **Editor**: `docs/editor-composing.md`
- **Publishing**: `docs/publish.md`
- **Anticheat**: `docs/anticheat.md`

## License

MIT
