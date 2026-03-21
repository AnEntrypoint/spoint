# spoint

Physics and netcode SDK for authoritative-server multiplayer games. Jolt physics, hot reload, app-based world logic, Three.js client.

**Demo**: https://anentrypoint.github.io/spoint/

## Quick Start

```bash
npx spoint
# or
npm install && npm start
# open http://localhost:3001
```

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
| `engine.client` | Network client (PhysicsNetworkClient or LocalClient) |
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

Add `?singleplayer` to the URL to run without a server. Loads `client/singleplayer-world.json`.

## Architecture

```
server.js                         Entry point
src/sdk/server.js                 Creates subsystems
src/sdk/TickHandler.js            Per-tick: movement → physics → collisions → apps → snapshot
src/physics/World.js              Jolt physics wrapper
src/netcode/PhysicsIntegration.js CharacterVirtual per player
src/apps/AppRuntime.js            Entity system, app lifecycle
client/app.js                     Three.js renderer, VRM loading, input loop
client/LocalClient.js             Serverless drop-in for singleplayer
```

## Load Testing

```bash
npm run bots
```

Env vars: `BOT_COUNT`, `BOT_DURATION`, `BOT_HZ`, `BOT_URL`

## License

MIT
