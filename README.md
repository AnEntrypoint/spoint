# Spawnpoint SDK

Multiplayer physics + netcode SDK. 128 TPS, hot-reload, display-engine agnostic.

## Quick Start

```bash
npm install
node server.js
```

Open `http://localhost:8080` in browser.

## Apps

Single-file modules in `apps/<name>/index.js`:

```javascript
export default {
  server: {
    setup(ctx) { },
    update(ctx, dt) { },
    teardown(ctx) { },
    onCollision(ctx, other) { },
    onInteract(ctx, player) { }
  },
  client: {
    render(ctx) {
      return { model: ctx.entity.model, position: ctx.entity.position, rotation: ctx.entity.rotation }
    }
  }
}
```

World config in `apps/world/index.js` defines entities, gravity, movement, spawn point.

## Dependencies

- `jolt-physics` - Physics (WASM)
- `msgpackr` - Binary encoding
- `ws` - WebSocket server

## License

GPL-3.0-only
