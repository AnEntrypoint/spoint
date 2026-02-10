# Technical Caveats

## Jolt Physics WASM Memory

Jolt getter methods (GetPosition, GetRotation, GetLinearVelocity) return WASM heap objects. Every call MUST be followed by `Jolt.destroy(returnedObj)` or WASM heap grows unbounded (~30MB/5min). See World.js `getCharacterPosition`, `getBodyPosition` etc for correct pattern.

Jolt setter methods: reuse pre-allocated `_tmpVec3` and `_tmpRVec3` via `.Set()` instead of `new`. Creating new Vec3/RVec3 per call leaks WASM memory. World.js stores these as instance fields.

Raycast creates 7 temporary Jolt objects (ray, settings, collector, 2 filters, body filter, shape filter). ALL must be destroyed after use. Missing any one leaks.

## CharacterVirtual Gravity

`CharacterVirtual.ExtendedUpdate()` does NOT apply gravity internally despite accepting a gravity vector (the gravity param only affects sticking-to-floor behavior). PhysicsIntegration.js line 52 manually applies `gravity[1] * dt` to vy. Removing this line causes zero gravity. The gravity vector passed to ExtendedUpdate controls step-down/step-up only.

## Physics Step Substeps

World.js line 194: `jolt.Step(dt, dt > 1/55 ? 2 : 1)` - uses 2 substeps when dt exceeds ~18ms. At 128 TPS (7.8ms ticks) this is always 1 substep. Only matters if tick rate drops below 55.

## TickHandler Velocity Override

TickHandler.js lines 38-41: After `physicsIntegration.updatePlayerPhysics()`, the wished XZ velocity from `applyMovement()` is written BACK over the physics result. Only Y velocity comes from physics. This means horizontal movement is pure wish-based, physics only controls vertical (gravity/jumping). Changing this breaks movement feel entirely.

## Movement Uses Quake-style Air Strafing

`shared/movement.js` implements Quake-style ground friction + air acceleration. `groundAccel` applies WITH friction, `airAccel` applies WITHOUT friction. The `stopSpeed` threshold prevents infinite deceleration at low speeds. World config `maxSpeed: 4.0` overrides `DEFAULT_MOVEMENT.maxSpeed: 8.0` - the defaults in movement.js are NOT what runs in production.

## Snapshot Encoding Format

SnapshotEncoder.js quantizes positions to 2 decimal places (precision 100) and rotations to 4 decimal places (precision 10000). Player arrays are positional: `[id, px, py, pz, rx, ry, rz, rw, vx, vy, vz, onGround, health, inputSeq]`. Entity arrays: `[id, model, px, py, pz, rx, ry, rz, rw, bodyType, custom]`. Changing field order or count breaks all clients silently (no error, just wrong positions).

## Message Types Are Hex Not Sequential

MessageTypes.js uses hex grouping (0x01-0x04 handshake, 0x10-0x13 state, 0x20-0x22 player, 0x30-0x33 entity, 0x70-0x74 hot reload). The old CLAUDE.md listed decimal types 1-6 which are WRONG. Actual snapshot is 0x10, input is 0x11.

## Custom msgpack Implementation

`src/protocol/msgpack.js` is a hand-rolled msgpack encoder/decoder, NOT the `msgpackr` npm package (which is listed in old README but not in package.json dependencies). The encoder reuses a single growing buffer (`buf`) and resets `pos` on each `pack()` call. This is NOT thread-safe but works because Node is single-threaded and ticks are synchronous.

## Snapshot Skip at 0 Players

TickHandler.js line 80: `if (players.length > 0)` guards snapshot creation AND broadcast. Without this, msgpack encoding runs 128x/sec encoding empty snapshots for no recipients.

## Per-Player Spatial Snapshots

When a StageLoader with spatial indexing is active, each player gets a DIFFERENT snapshot containing only entities within `relevanceRadius` (default 200 units). This means players in different areas see different entities. Without StageLoader, all players get identical full snapshots via broadcast.

## LagCompensator Ring Buffer

Fixed 128-slot ring buffer with head/len tracking. Old entries are pruned by timestamp (historyWindow default 500ms), not by count. At 128 TPS, 500ms = ~64 entries max. The ring buffer pre-allocates entry objects to avoid GC pressure.

## Hot Reload Architecture

Three independent hot reload systems run simultaneously:
1. **ReloadManager** watches SDK source files (TickHandler, PhysicsIntegration, etc). Uses `swapInstance()` which replaces prototype and non-state properties while preserving state properties (e.g. `playerBodies` survives PhysicsIntegration reload).
2. **AppLoader** watches `apps/` directory. Queues reloads into HotReloadQueue which drains at end of each tick (TickHandler.js line 98). This ensures app reload never happens mid-tick.
3. **Client hot reload** sends MSG.HOT_RELOAD (0x70) which triggers full `location.reload()` on all browsers. Camera state is preserved via sessionStorage.

## HotReloadQueue Resets Heartbeats

HotReloadQueue._resetHeartbeats() sets `lastHeartbeat = Date.now()` on ALL clients after each reload. Without this, slow reloads cause heartbeat timeout (3s default) disconnecting clients during reload.

## App State Survival

`ctx.state` points to `entity._appState` which is an object reference on the entity itself. On hot reload, HotReloadQueue creates a new AppContext but the entity keeps its `_appState` reference. So `ctx.state` survives reload. Everything else (timers, bus subscriptions) is destroyed and re-created via teardown+setup.

## AppLoader Blocks Dangerous Patterns

AppLoader._validate() blocks: `process.exit`, `child_process`, `require(`, `__proto__`, `Object.prototype`, `globalThis`, `eval(`, `import(`. If your app source contains any of these strings (even in comments), it silently fails to load with only a console error.

## Client App Module Evaluation

Client receives raw source code via APP_MODULE message. `evaluateAppModule()` in app.js strips all `import` statements with regex and replaces `export default` with `return`, then runs via `new Function()`. Apps cannot use imports on the client side. All dependencies must come from `engineCtx` (which provides THREE, createElement, etc).

## Client Input Rate vs Server Tick Rate

Client sends input at 60Hz (setInterval 1000/60) regardless of server tick rate (128 TPS). Server processes ALL buffered inputs per tick but only uses the LAST input's data (`player.lastInput = inputs[inputs.length - 1].data`). Intermediate inputs are discarded. Only inputSequence increments per input.

## Heartbeat Timeout

ConnectionManager heartbeat timeout is 3 seconds. Any message from client resets the heartbeat timer (not just heartbeat messages). Client sends explicit heartbeat every 1000ms. If client stops sending anything for 3s, server disconnects them.

## Collision Detection is Sphere-Based

AppRuntime._tickCollisions() uses distance-based sphere collision between entities. The collision radius `_colR()` extracts max dimension from collider config. This is SEPARATE from Jolt physics collisions - Jolt handles player-world and dynamic body collisions, AppRuntime handles entity-entity app collision events.

## Player-Player Collision is Custom

TickHandler lines 54-73 implement custom player-player separation using capsule radius overlap check and position push-apart. This runs AFTER physics step. Uses a `separated` Set to avoid processing the same pair twice.

## ReloadManager Max 3 Failures

After 3 consecutive reload failures for a module, ReloadManager stops auto-reloading that module permanently until server restart. Uses exponential backoff (100ms, 200ms, 400ms max) between retries.

## TickSystem Max 4 Steps Per Loop

TickSystem.loop() processes max 4 ticks per loop iteration. If server falls behind more than 4 ticks, it resets lastTickTime to now (line 46-48), dropping those ticks entirely. This prevents death spirals where catching up causes more falling behind.

## TickSystem Timer Strategy

Uses setTimeout(1ms) when gap > 2ms, setImmediate when gap <= 2ms. This gives better tick timing accuracy than pure setTimeout while not busy-spinning.

## Entity Hierarchy

Entities support parent-child relationships. `getWorldTransform()` recursively computes world position/rotation/scale by walking up parent chain. Destroying a parent cascades to all children. Entity reparenting updates both old and new parent's children sets.

## EventBus Wildcard Pattern

EventBus supports `*` suffix patterns: subscribing to `combat.*` receives `combat.fire`, `combat.hit`, etc. The `system.*` channel prefix is reserved - events starting with `system.` are filtered from the general `*` catch-all logger in AppRuntime.

## EventBus Scope Cleanup

Each entity gets a scoped EventBus via `bus.scope(entityId)`. The scope tracks all subscriptions. When entity is destroyed or app is detached, `destroyScope()` unsubscribes everything. Forgetting to use the scoped bus means listeners leak across hot reloads.

## Three.js Shadow Artifacts

`material.shadowSide = THREE.BackSide` on environment meshes prevents bright corner-line artifacts at geometry seams. VSMShadowMap causes blurred cutout artifacts - must use PCFSoftShadowMap (set in app.js).

## Shadow Frustum Auto-Fit

`fitShadowFrustum()` in app.js dynamically adjusts directional light shadow camera bounds to fit scene geometry. Called once after environment model loads. Shadow near/far are computed from actual geometry projection onto light direction.

## VRM Model Scale Pipeline

Player VRM scale chain: `modelScale` (default 1.323) applied to vrm.scene.scale, then `feetOffset` ratio (0.212) * modelScale applied as negative Y offset. The group's `userData.feetOffset` is hardcoded to 1.3 for client-side position offset. Changing any of these values misaligns the visual model with the physics capsule.

## Client Position Interpolation

Client interpolates player positions using exponential lerp: `lerp(1 - exp(-16 * dt))`. Additionally applies velocity extrapolation per frame (`goalX = target.x + vx * dt`). This compensates for the ~7.8ms gap between server snapshots. Without velocity extrapolation, movement appears jittery at 128 TPS.

## Animation State Machine Thresholds

Locomotion transitions use hysteresis: idle-to-walk threshold differs from walk-to-idle (0.8 vs 0.3). Locomotion cooldown (0.3s) prevents rapid oscillation between walk/jog/sprint states. Air grace period (0.15s) delays jump detection to handle single-frame ground-loss.

## Camera Collision Raycast Rate

Camera raycasts against environment run every 50ms (20Hz), not every frame. Cached clip distance is used between raycasts. Camera snaps faster toward player (speed 30) than away (speed 12) to prevent seeing through walls.

## Debug Globals

Server: `globalThis.__DEBUG__.server` exposes full server API. Client: `window.debug` exposes scene, camera, renderer, client, all mesh maps, and input handler. These are always set, not gated by debug flags.

## Static File Serving Priority

server.js staticDirs order matters: `/src/` first, then `/apps/`, then `/node_modules/`, then `/` (client). The SDK's own paths take priority. Project-local `apps/` directory overrides SDK `apps/` if it exists.

## Module Cache Busting

All hot-reloaded imports use `?t=${Date.now()}` query param to bust Node's ESM module cache. Without this, `import()` returns the cached module.

## Capsule Shape Parameter Order

Jolt CapsuleShape constructor takes `(halfHeight, radius)` NOT `(radius, halfHeight)`. World.js line 82 passes them correctly. AppContext.js line 66 passes `[r, h/2]` to `addBody('capsule', ...)` which World.js receives as `params` and uses `params[1]` for halfHeight, `params[0]` for radius (line 57).

## Animation Retargeting Track Filtering

Animation retargeting (client/animation.js) uses `THREE.SkeletonUtils.retargetClip()` to adapt source animations to each player's VRM skeleton. The retargeted clip may reference bones that don't exist in the target VRM. `filterValidClipTracks()` removes these invalid bone references before passing clips to the THREE.AnimationMixer. Without filtering, THREE.js PropertyBinding throws "Can not bind to bones as node does not have a skeleton" errors for each invalid track. The filter is applied to all clips (both retargeted and normalized) at line 237 in animation.js before `mixer.clipAction()` is called.

## Entry Points

Server: `node server.js` (port 8080, 128 TPS). World config: `apps/world/index.js`. Apps: `apps/<name>/index.js` with `server` and `client` exports.
