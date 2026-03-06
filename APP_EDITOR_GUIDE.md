# App Editor Guide

This guide is for building and maintaining `apps/<name>/index.js` modules quickly.

## 1. Mental Model

- `apps/world/index.js` defines world config and initial entities.
- Each app is a module with optional `server` and `client` sections.
- Server runs authoritative game logic.
- Client renders visuals and handles local UI/input behavior.

## 2. Fast Workflow

```bash
npm install
npm start
node ./bin/create-app.js my-app
```

Then add your app to `apps/world/index.js`:

```js
entities: [
  { id: 'my-app-1', position: [0, 1, 0], app: 'my-app' }
]
```

Save files. Hot reload applies automatically.

## 3. App Skeleton

```js
export default {
  server: {
    setup(ctx) {},
    update(ctx, dt) {},
    teardown(ctx) {},
    onMessage(ctx, msg) {},
    onInteract(ctx, player) {},
    onCollision(ctx, other) {}
  },
  client: {
    setup(engine) {},
    render(ctx) { return null },
    onInput(input, engine) {},
    onFrame(dt, engine) {},
    onEvent(payload, engine) {}
  }
}
```

## 4. Rules That Prevent Most Bugs

- Keep persistent state in `ctx.state`, not module globals.
- Re-register timers/subscriptions in `setup`.
- Use `ctx.time.after/every` for timers that should clear on teardown.
- Use `ctx.physics.*` in `setup` if the entity needs collision.
- Keep `ctx.entity.custom` small; it is included in snapshots.
- Do not emit on `system.*` bus channels.

## 5. Useful Server APIs

- `ctx.world.spawn/destroy/getEntity/query/nearby`
- `ctx.players.getAll/getNearest/send/broadcast/setPosition`
- `ctx.physics.setStatic/setDynamic/addBoxCollider/addSphereCollider/addCapsuleCollider/addTrimeshCollider`
- `ctx.bus.on/once/emit/handover`
- `ctx.raycast(origin, direction, maxDist)`

## 6. Useful Client APIs

- `engine.scene`, `engine.camera`, `engine.renderer`, `engine.THREE`
- `engine.client` for network state access
- `engine.cam` for camera helpers
- `ctx.h(...)` for UI elements in `render`

## 7. Performance Checklist

- Lower `entityTickRate` in world config for heavy app logic.
- Prefer static colliders for non-moving world geometry.
- Avoid frequent object allocations inside `update`/`onFrame`.
- Keep per-frame loops bounded by nearby entities only.

## 8. Debugging

- Server debug handle: `globalThis.__DEBUG__.server`
- Client debug handle: `window.debug`
- Run load test: `node run-bots.js 50 30000 60`
