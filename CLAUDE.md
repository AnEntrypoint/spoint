# Technical Caveats

## Reusable Apps: box-static, prop-static

Two reusable apps are bundled in `apps/`:

- `box-static` — visual box primitive + static box collider. Config: `{ hx, hy, hz, color, roughness }`. Half-extents drive both the collider and the visual (visual `sx/sy/sz` = `hx/hy/hz * 2`). Spawn via `ctx.world.spawn(id, { app: 'box-static', config: { hx, hy, hz, color } })`.
- `prop-static` — static GLB prop with convex hull collider. No config needed. Entity must have `model` set. Calls `addConvexFromModel(0)` in setup.

These enable building full scenes without any GLB for structure.

## Physics Bodies Only Created Via App setup()

Setting `entity.bodyType` or `entity.collider` directly on a spawned entity (e.g. `e.bodyType = 'static'`) has NO effect on the physics simulation. A Jolt physics body is only created when `ctx.physics.addBoxCollider()`, `addSphereCollider()`, etc. is called inside an app's `setup(ctx)`. To give a spawned entity physics, attach an app to it (`app: 'box-static'` or similar) that calls the physics API.

## Primitive Rendering (No GLB Required)

Box, sphere, and cylinder meshes are created client-side from `entity.custom` when `entity.model` is null. Fields:
- `mesh`: `'box'` | `'sphere'` | `'cylinder'`
- `sx/sy/sz`: full width/height/depth (box)
- `r`: radius (sphere, cylinder)
- `h`: height (cylinder)
- `seg`: polygon segments
- `color`: hex integer
- `roughness`, `metalness`, `emissive`, `emissiveIntensity`
- `hover`: Y oscillation amplitude
- `spin`: rotation speed (rad/s)
- `light`: point light color, `lightIntensity`, `lightRange`

## Documentation Sync Rule

SKILL.md and CLAUDE.md MUST both be reviewed and updated whenever code changes.

- **SKILL.md** is the agent-facing API reference. Agents working in user projects have NO access to engine source. Every new `ctx` API, lifecycle hook, config field, caveat, or behavior change must be reflected in SKILL.md immediately.
- **CLAUDE.md** documents engine internals and gotchas for contributors working on the engine itself.
- Both files must be kept accurate. Stale documentation causes agents to generate broken app code.
- Do NOT add line numbers to either file. Line numbers are stale the moment code changes. Reference function names, file names, and behavior instead.

---

## GLB/VRM IndexedDB Model Cache

`client/ModelCache.js` (mirrored to `skills/spoint/client/`) caches raw GLB/VRM ArrayBuffers in IndexedDB keyed by URL. On repeat page loads, a HEAD request validates the cached entry against the server ETag. If the ETag matches, the cached ArrayBuffer is returned directly, bypassing the network fetch entirely. On a miss or stale entry, the full GET response is streamed via `ReadableStream`, stored in IndexedDB, and returned.

`fetchCached(url, onProgress)` is the exported function. It checks gzip via the `content-encoding` response header — when gzip is present, the `content-length` header (compressed size) is not used as a progress denominator since the stream delivers decompressed bytes. `onProgress(received, total)` is only called when `content-length` is available AND the response is not gzip-encoded.

`StaticHandler.js` emits an `ETag` header for GLB/VRM/GLTF responses (hex-encoded mtime) and handles `If-None-Match` returning 304 when matched. Without the ETag, `fetchCached` always does a full fetch.

Cache failures (IndexedDB unavailable, quota exceeded) are silently caught and fall back to a normal fetch transparently.

## Engine-Level Interactable System

`ctx.interactable({ prompt, radius, cooldown })` in `AppContext.js` is a top-level ctx method (NOT under `ctx.physics`). It sets `ent._interactable=true`, `ent._interactRadius`, `ent._interactCooldown`, and writes `ent.custom._interactable = { prompt, radius }` into the entity's custom data so the client snapshot carries the config.

`_tickInteractables()` in `AppRuntime.js` runs every tick: for each entity with `_interactable=true`, it checks all players within `_interactRadius`. If a player's `lastInput.interact` is true and the per-player-per-entity cooldown (keyed as `entityId:playerId`) has elapsed, it fires `onInteract(ctx, player)` on that entity's app. Cooldown defaults to 500ms if `_interactCooldown` is not set.

`_buildInteractPrompt(state)` in `client/app.js` runs inside `renderAppUI()` on the client every frame. It iterates all entities in the snapshot, finds the first with `custom._interactable` where the local player is within `cfg.radius` (distance-squared check), and renders the prompt string as a fixed HUD element via `createElement`. No app client code is needed for basic prompts.

`InputHandler.getInput()` in `src/client/InputHandler.js` includes `interact: this.keys.get('e') || false` in the keyboard path. The E key fires the interact signal.

`ctx.physics.setInteractable(radius)` still exists for backward compatibility — it sets `_interactable` and `_interactRadius` but does NOT set `_interactCooldown` or write `custom._interactable`, so the engine client prompt will not appear. Prefer `ctx.interactable()`.

## Animation Library Two-Phase Cache

`client/animation.js` exports two functions with separate module-level caches (`_gltfPromise`, `_normalizedCache`):

- `preloadAnimationLibrary()` — synchronously returns or creates the GLB fetch promise (`_gltfPromise`). Does not block on normalization. Called during `initAssets` in `app.js` to kick off the GLB download in parallel with the VRM download.
- `loadAnimationLibrary(vrmVersion, vrmHumanoid)` — awaits `preloadAnimationLibrary()`, then normalizes the clips into `_normalizedCache`. The double-check `if (_normalizedCache) return _normalizedCache` inside handles concurrent callers racing past the first check.

`initAssets` calls `preloadAnimationLibrary()` early (fire-and-forget) so the GLB is fetching while VRM loads. When the VRM is ready, `loadAnimationLibrary()` is called and the GLB is already in flight or done.

## Loading Screen Gate Conditions

`checkAllLoaded()` in `client/app.js` gates on four conditions simultaneously: `assetsLoaded`, `environmentLoaded`, `firstSnapshotReceived`, and `firstSnapshotEntityPending.size === 0`. The last condition ensures all entity GLBs from the first snapshot are fully loaded and in the scene before the loading screen hides.

When the first snapshot arrives, any entity with a model not yet in `entityMeshes` is added to `firstSnapshotEntityPending`. Each `loadEntityModel` success/error callback removes the entity from that set and calls `checkAllLoaded()` when it empties.

When all four conditions pass: `loadingScreen.hide()` fires immediately, then `warmupShaders()` runs asynchronously in the background. The loading screen does not wait for shader warmup.

## warmupShaders Sequence

`warmupShaders()` in `client/app.js` runs AFTER `loadingScreen.hide()` (async, `.catch(() => {})`). It is guarded by `_shaderWarmupDone` flag. Sequence:

1. `renderer.compileAsync(scene, camera)` — compiles all shaders in the scene (falls back to `renderer.compile` if async not supported)
2. Disable `frustumCulled` on all scene objects (so off-screen geometry is uploaded)
3. `renderer.render(scene, camera)` — first GPU upload pass
4. `await requestAnimationFrame` — yield one frame
5. `renderer.render(scene, camera)` — second GPU upload pass
6. Restore `frustumCulled` on all previously-culled objects

This covers all entity models already in the scene when `checkAllLoaded()` fires. For entities loaded AFTER the loading screen is hidden, `loadEntityModel` calls `renderer.compileAsync(scene, camera)` immediately after the new model is added to the scene.

## compileAsync Per Dynamic Entity (Post-Loading-Screen)

After the loading screen is hidden, `loadEntityModel` in `client/app.js` calls `renderer.compileAsync(scene, camera).catch(() => renderer.compile(scene, camera))` after adding a new mesh to the scene. This covers entities that load dynamically after initial load. It does NOT run per-entity during the initial load phase — scene-level `warmupShaders()` handles those collectively.

VRM player warmup uses a separate one-time flag (`_vrmWarmupDone`) that calls `renderer.compileAsync(scene, camera)` after the first player model loads.

## PointLight Warmup Dummy

A zero-intensity `THREE.PointLight` (`_warmupPointLight`) is added to the scene at startup. This forces Three.js to compile the point-light shader variant upfront. Without it, the first dynamic entity that uses a point light causes a GPU stall on first render.

## Three.js Performance Settings

- `THREE.Cache.enabled = true` — enables Three.js's built-in asset cache for URL-keyed loads.
- `matrixAutoUpdate = false` on all static environment meshes — prevents Three.js from recomputing world matrices every frame for non-moving geometry. Set after environment GLB loads.
- `material.shadowSide = THREE.DoubleSide` on environment meshes — prevents bright corner-line artifacts at geometry seams. Note: the current code uses `DoubleSide`, NOT `BackSide`.
- `PCFSoftShadowMap` must be used — `VSMShadowMap` causes blurred cutout artifacts.
- `Map.forEach` is used instead of `for...of` in the `animate()` loop for player iteration. This avoids iterator object allocation per frame.

## evaluateAppModule Helper Function Hoisting

`evaluateAppModule()` in `client/app.js` converts `export default` to `return`. If the app file declares helper functions AFTER the `export default { ... }` block closes, those functions become unreachable dead code after the return statement. The fix: the regex now locates the `default` keyword and splits the source into code-before-default (helper functions hoist to before the return) and the object/function being exported (becomes the return value). A `//# sourceURL=app-module.js` comment is appended so Firefox attributes warnings to the correct virtual file.

## App Module List Cache

`appModules` is a `Map` of app name to client module object. A parallel `_appModuleList` array is kept as a cached `[...appModules.values()]` snapshot. This avoids `Map` iteration inside the hot `onAppEvent` handler which runs for every server event. `_appModuleList` is rebuilt (via spread) whenever `appModules` changes.

## Convex Hull Collider

`World.js addBody()` accepts `shapeType === 'convex'` with `params` as a flat array of vertex positions `[x,y,z,x,y,z,...]`. It uses Jolt's `ConvexHullShapeSettings` + `VertexList`. The VertexList and settings object are destroyed after the shape is created to avoid WASM leaks. `AppContext.js` exposes `addConvexCollider(points)` and `addConvexFromModel(meshIndex)`. `addConvexFromModel` uses `extractMeshFromGLB` (imported at module top) to read vertices from the entity's GLB file at setup time.

---

## Invisible/Trigger Material Filtering

CS:GO and Source Engine maps exported as GLB contain special materials that must be excluded from both physics and rendering:

- `aaatrigger` — buy zones, bomb plant zones, trigger volumes (invisible in CS:GO)
- `{invisible` — explicitly invisible surfaces
- `playerclip`, `clip`, `nodraw`, `toolsclip`, `toolsplayerclip`, `toolsnodraw`, `toolsskybox`, `toolstrigger` — various Source Engine tool textures

`extractAllMeshesFromGLBAsync` in `GLBLoader.js` skips primitives whose material name is in this set (`SKIP_MATS`). Without this, CS:GO maps have phantom collision walls where there's no visible geometry.

On the client side, `loadEntityModel` in `client/app.js` sets `c.visible = false` for meshes with these material names during the `model.traverse()` pass.

## Draco Compressed Model Support

Physics collider extraction supports Draco-compressed meshes (KHR_draco_mesh_compression extension) via `extractMeshFromGLBAsync()` which uses the `draco3dgltf` package for decompression.

**Sync vs Async:**
- `extractMeshFromGLB(filepath)` — synchronous, throws on Draco/meshopt
- `extractMeshFromGLBAsync(filepath)` — async, handles Draco via decompression

**Trimesh colliders with Draco:**
- `world.addStaticTrimesh(glbPath)` — sync, throws on Draco
- `world.addStaticTrimeshAsync(glbPath)` — async, combines ALL meshes and ALL primitives via `extractAllMeshesFromGLBAsync`. The `meshIndex` parameter is ignored (deprecated). This is critical for map GLBs which have dozens of meshes with hundreds of Draco primitives.

## Dynamic Body Position Sync

`AppRuntime._syncDynamicBodies()` runs every tick before `_spatialSync()`. It reads position and rotation back from Jolt for all entities with `bodyType === 'dynamic'` and `_physicsBodyId` set. Uses `World.isBodyActive()` (Jolt's `bodyInterface.IsActive()`) to skip sleeping bodies — a settled dynamic body costs 1 `IsActive` check instead of 3 calls (position + rotation). The `e._dynSleeping` flag tracks sleep state between ticks.

Without this sync, dynamic entity positions never update from Jolt simulation and stay frozen at their spawn position in the snapshot.

**Multi-mesh map GLBs:** Maps like de_dust2_kosovo.glb have 56 meshes with 99 Draco primitives total. The old code only extracted mesh[0] prim[0] — 98% of geometry had no collision. `extractAllMeshesFromGLBAsync` iterates all meshes, all primitives, decompresses each Draco primitive, applies node world-space transforms (full scene graph hierarchy), and returns one combined vertex/index buffer.

**Jolt Float3 WASM leak in trimesh building:** `new J.Float3(x,y,z)` inside the triangle loop leaks WASM heap. The fix reuses a single `J.Float3` instance with `.x/.y/.z` property assignment. Also `J.TriangleList` and `J.MeshShapeSettings` must be explicitly destroyed after shape creation.

The async methods allocate temporary Draco objects (`Decoder`, `DecoderBuffer`, `Mesh`, `DracoFloat32Array`, `DracoUInt32Array`) which are destroyed after extraction to prevent WASM memory leaks.

**Meshopt compression (EXT_meshopt_compression) is NOT supported.** Models using meshopt must be decompressed first:
```bash
gltfpack -i model-compressed.glb -o model-uncompressed.glb -noq
```

The `detectDracoInGLB(filepath)` utility returns `{hasDraco, hasMeshopt, meshes}` for pre-checking models.

## Jolt Physics WASM Memory

Jolt getter methods return WASM heap objects in some cases but NOT all — depends on whether C++ returns by value vs const reference:
- `BodyInterface::GetPosition/GetRotation/GetLinearVelocity` → return by VALUE → MUST call `J.destroy(result)` after extracting values
- `CharacterVirtual::GetPosition()` → returns `const RVec3&` (INTERNAL REFERENCE) → do NOT call `J.destroy()` on the result — doing so frees memory Jolt still owns, corrupting the WASM heap and causing `memory access out of bounds` crashes
- `CharacterVirtual::GetLinearVelocity()` → returns by VALUE → MUST call `J.destroy(result)`

See World.js `getCharacterPosition` (no destroy) vs `getBodyPosition` (destroy) for the correct patterns.

Jolt setter methods: reuse pre-allocated `_tmpVec3` and `_tmpRVec3` via `.Set()` instead of `new`. Creating new Vec3/RVec3 per call leaks WASM memory. World.js stores these as instance fields.

Raycast creates 7 temporary Jolt objects (ray, settings, collector, 2 filters, body filter, shape filter). ALL must be destroyed after use. Missing any one leaks.

## CharacterVirtual Gravity

`CharacterVirtual.ExtendedUpdate()` does NOT apply gravity internally despite accepting a gravity vector (the gravity param only affects sticking-to-floor behavior). PhysicsIntegration.js manually applies `gravity[1] * dt` to vy inside `updatePlayerPhysics`. Removing this causes zero gravity. The gravity vector passed to ExtendedUpdate controls step-down/step-up only.

## Physics Step Substeps

World.js `step()`: `jolt.Step(dt, dt > 1/55 ? 2 : 1)` - uses 2 substeps when dt exceeds ~18ms. At 128 TPS (7.8ms ticks) this is always 1 substep. Only matters if tick rate drops below 55.

## TickHandler Velocity Override

In TickHandler.js, after `physicsIntegration.updatePlayerPhysics()`, the wished XZ velocity from `applyMovement()` is written BACK over the physics result (`st.velocity[0] = wishedVx`, `st.velocity[2] = wishedVz`). Only Y velocity comes from physics. This means horizontal movement is pure wish-based, physics only controls vertical (gravity/jumping). Changing this breaks movement feel entirely.

## Movement Uses Quake-style Air Strafing

`shared/movement.js` implements Quake-style ground friction + air acceleration. `groundAccel` applies WITH friction, `airAccel` applies WITHOUT friction. The `stopSpeed` threshold prevents infinite deceleration at low speeds. World config `maxSpeed: 4.0` overrides `DEFAULT_MOVEMENT.maxSpeed: 8.0` - the defaults in movement.js are NOT what runs in production.

## Snapshot Encoding Format

SnapshotEncoder.js quantizes positions to 2 decimal places (precision 100) and rotations to 4 decimal places (precision 10000). Player arrays are positional: `[id, px, py, pz, rx, ry, rz, rw, vx, vy, vz, onGround, health, inputSeq]`. Entity arrays: `[id, model, px, py, pz, rx, ry, rz, rw, bodyType, custom]`. Changing field order or count breaks all clients silently (no error, just wrong positions).

## Message Types Are Hex Not Sequential

MessageTypes.js uses hex grouping (0x01-0x04 handshake, 0x10-0x13 state, 0x20-0x22 player, 0x30-0x33 entity, 0x70-0x74 hot reload). The old CLAUDE.md listed decimal types 1-6 which are WRONG. Actual snapshot is 0x10, input is 0x11.

## Custom msgpack Implementation

`src/protocol/msgpack.js` is a hand-rolled msgpack encoder/decoder, NOT the `msgpackr` npm package (which is listed in old README but not in package.json dependencies). The encoder reuses a single growing buffer (`buf`) and resets `pos` on each `pack()` call. This is NOT thread-safe but works because Node is single-threaded and ticks are synchronous.

## Snapshot Skip at 0 Players

TickHandler.js guards snapshot encoding with `if (players.length > 0)`. Without this, msgpack encoding runs 128x/sec encoding empty snapshots for no recipients.

## Player-Player Collision: Spatial Grid

TickHandler uses a spatial grid (cell size = `capsuleRadius * 8`) instead of O(n²) brute-force collision checks. Players are bucketed by XZ cell. Each player checks only the 9 neighboring cells. The `other.id <= player.id` guard processes each pair exactly once, replacing the old string-keyed `separated` Set. At 100 players spread over a map, this reduces collision checks from 4,950 pairs to near-zero. Profile: col=0.04ms at 100 players (vs would have been ~5ms with O(n²)). Collision uses `player.state.position` (already updated by physics) — no additional WASM calls.

## Snapshot Delivery: SNAP_GROUPS Rotation

TickHandler delivers snapshots to `1/SNAP_GROUPS` of players per tick (default SNAP_GROUPS=4). Players are bucketed by `player.id % SNAP_GROUPS` and each bucket gets a snapshot every 4 ticks = 32 Hz effective snapshot rate (physics remains 128 Hz). This keeps per-tick socket send cost proportional to `N/SNAP_GROUPS` rather than `N`, making 100-player ticks fit within 7.8ms budget.

**Why this matters**: At SNAP_GROUPS=1 (old behavior), 100 players × 128 TPS = 12,800 socket writes/sec. On Windows, each WebSocket write costs ~166μs of kernel I/O. 100 writes = 16.6ms/tick which blows the 7.8ms budget. With SNAP_GROUPS=4: 25 writes/tick = 4ms/tick — within budget.

**sendPacked optimization**: On the broadcast path (no StageLoader), the snapshot is msgpack-encoded ONCE via `pack()` and the raw buffer is sent to all recipients via `connections.sendPacked()`. Without this, `connections.send()` would re-encode the same payload per recipient.

**Entity key caching in SnapshotEncoder**: `encodeDelta` stores `[key, customRef, customStr]` per entity in the entityMap. When the `entity.custom` object reference is unchanged between ticks, JSON.stringify is skipped and the cached string is reused. This eliminates redundant serialization for static entities.

## Per-Player Spatial Snapshots

When a StageLoader with spatial indexing is active, each player gets a DIFFERENT snapshot containing only entities within `relevanceRadius` (default 200 units). This means players in different areas see different entities. Without StageLoader, all players get identical full snapshots (packed once, sent to current SNAP_GROUP bucket).

## LagCompensator Ring Buffer

Fixed 128-slot ring buffer with head/len tracking. Old entries are pruned by timestamp (historyWindow default 500ms), not by count. At 128 TPS, 500ms = ~64 entries max. The ring buffer pre-allocates entry objects to avoid GC pressure.

## Hot Reload Architecture

Three independent hot reload systems run simultaneously:
1. **ReloadManager** watches SDK source files (TickHandler, PhysicsIntegration, etc). Uses `swapInstance()` which replaces prototype and non-state properties while preserving state properties (e.g. `playerBodies` survives PhysicsIntegration reload).
2. **AppLoader** watches `apps/` directory. Queues reloads into HotReloadQueue which drains at the end of each tick via `appRuntime._drainReloadQueue()`. This ensures app reload never happens mid-tick.
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

TickHandler.js implements custom player-player separation after the physics step using capsule radius overlap check and position push-apart. Uses a `separated` Set to avoid processing the same pair twice.

## ReloadManager Max 3 Failures

After 3 consecutive reload failures for a module, ReloadManager stops auto-reloading that module permanently until server restart. Uses exponential backoff (100ms, 200ms, 400ms max) between retries.

## TickSystem Max 4 Steps Per Loop

TickSystem.loop() processes max 4 ticks per loop iteration. If server falls behind more than 4 ticks, it resets lastTickTime to now, dropping those ticks entirely. This prevents death spirals where catching up causes more falling behind.

## TickSystem Timer Strategy

Uses setTimeout(1ms) when gap > 2ms, setImmediate when gap <= 2ms. This gives better tick timing accuracy than pure setTimeout while not busy-spinning.

## Entity Hierarchy

Entities support parent-child relationships. `getWorldTransform()` recursively computes world position/rotation/scale by walking up parent chain. Destroying a parent cascades to all children. Entity reparenting updates both old and new parent's children sets.

## EventBus Wildcard Pattern

EventBus supports `*` suffix patterns: subscribing to `combat.*` receives `combat.fire`, `combat.hit`, etc. The `system.*` channel prefix is reserved - events starting with `system.` are filtered from the general `*` catch-all logger in AppRuntime.

## EventBus Scope Cleanup

Each entity gets a scoped EventBus via `bus.scope(entityId)`. The scope tracks all subscriptions. When entity is destroyed or app is detached, `destroyScope()` unsubscribes everything. Forgetting to use the scoped bus means listeners leak across hot reloads.

## Shadow Frustum Auto-Fit

`fitShadowFrustum()` in app.js dynamically adjusts directional light shadow camera bounds to fit scene geometry. Called once after environment model loads. Shadow near/far are computed from actual geometry projection onto light direction.

## VRM Model Scale Pipeline

Player VRM scale chain: `modelScale` (default 1.323) applied to vrm.scene.scale, then `feetOffset` ratio (0.212) * modelScale applied as negative Y offset. The group's `userData.feetOffset` is hardcoded to 1.3 for client-side position offset. Changing any of these values misaligns the visual model with the physics capsule.

## Client Position Interpolation

Client interpolates player positions using exponential lerp: `lerp(1 - exp(-16 * dt))`. Additionally applies velocity extrapolation per frame (`goalX = target.x + vx * dt`). This compensates for the ~7.8ms gap between server snapshots. Without velocity extrapolation, movement appears jittery at 128 TPS.

## Animation State Machine Thresholds

Locomotion transitions use hysteresis: idle-to-walk threshold differs from walk-to-idle (0.8 vs 0.3). Locomotion cooldown (0.3s) prevents rapid oscillation between walk/jog/sprint states. Air grace period (0.15s) delays jump detection to handle single-frame ground-loss.

## Camera Collision Raycast Rate

Camera raycasts against environment run every 50ms (20Hz) via `fpsRayTimer` / `tpsRayTimer` trackers (separate timers per mode). Cached clip distance is used between raycasts. Camera snaps faster toward player (speed 30) than away (speed 12) to prevent seeing through walls.

FPS mode fires 1 forward ray (wall-push). TPS mode fires 2 rays (clip distance + aim point). All raycasts use BVH acceleration via `three-mesh-bvh` vendored locally at `client/vendor/three-mesh-bvh.module.js` — `computeBoundsTree()` is called on each collider mesh geometry at environment load time. Without BVH, raw triangle iteration consumed ~65% of frame CPU in FPS mode.

## Camera Environment Mesh List

`cam.setEnvironment(meshes)` in camera.js defines what the camera raycasts against for collision and aim. In app.js, this is populated from all non-skinned static meshes in the loaded environment model (any `isMesh && !isSkinnedMesh`). If this list is empty, raycasts are skipped entirely — never falling back to `scene.children` which would include skinned VRM player meshes and cause massive CPU overhead.

## three-mesh-bvh Vendored Locally

`three-mesh-bvh` is vendored at `client/vendor/three-mesh-bvh.module.js`. It is NOT loaded from npm or a CDN. This avoids MIME/CORS/CSP issues with external module loading. The vendor file must be updated manually when upgrading the library.

## Debug Globals

Server: `globalThis.__DEBUG__.server` exposes full server API. Client: `window.debug` exposes scene, camera, renderer, client, all mesh maps, and input handler. These are always set, not gated by debug flags.

## Static File Serving Priority

server.js staticDirs order matters: `/src/` first, then `/apps/`, then `/node_modules/`, then `/` (client). The SDK's own paths take priority. Project-local `apps/` directory overrides SDK `apps/` if it exists.

## StaticHandler In-Memory Cache + ETag

StaticHandler caches gzip-compressed file content in memory keyed by file path, invalidated by mtime. Large binary assets (GLB, VRM, WASM) are gzipped once on first request and served from memory thereafter. The `getCached(fp, ext)` function handles the mtime check and compression.

For GLB/VRM/GLTF files, StaticHandler also emits an `ETag` header (hex-encoded mtime) and handles `If-None-Match` returning 304 Not Modified when the ETag matches. This feeds `fetchCached()` in ModelCache.js.

## DRACOLoader Worker Pool

`DRACOLoader` spawns a worker pool (default 4 workers) that each independently initialize a Draco WASM module. If the scene has no Draco-compressed meshes, all 4 workers still spin up and initialize WASM on first use, costing ~1 second of startup. `dracoLoader.setWorkerLimit(1)` caps this to 1 worker. Set this in app.js after `setDecoderPath`. If a scene uses many large Draco meshes in parallel, increasing the limit may help decode throughput.

## Module Cache Busting

All hot-reloaded imports use `?t=${Date.now()}` query param to bust Node's ESM module cache. Without this, `import()` returns the cached module.

## Capsule Shape Parameter Order

Jolt CapsuleShape constructor takes `(halfHeight, radius)` NOT `(radius, halfHeight)`. World.js `addPlayerCharacter` passes them correctly. AppContext.js `addCapsuleCollider(r, h)` passes `[r, h/2]` to `addBody('capsule', ...)` which World.js receives as `params` and uses `params[1]` for halfHeight, `params[0]` for radius.

## Animation Retargeting Track Filtering

Animation retargeting (client/animation.js) uses `THREE.SkeletonUtils.retargetClip()` to adapt source animations to each player's VRM skeleton. The retargeted clip may reference bones that don't exist in the target VRM. `filterValidClipTracks()` removes these invalid bone references before passing clips to the THREE.AnimationMixer. Without filtering, THREE.js PropertyBinding throws "Can not bind to bones as node does not have a skeleton" errors for each invalid track. The filter is applied to all clips (both retargeted and normalized) before `mixer.clipAction()` is called.

## Entry Points

Server: `node server.js` (port 8080, 128 TPS). World config: `apps/world/index.js`. Apps: `apps/<name>/index.js` with `server` and `client` exports.

## Mobile Support Foundation (Phase 0)

Planned minimal foundation for eventual mobile support. Not implementing touch controls yet, but preparing architecture so it's possible later without major refactoring.

### Goals
- Device-agnostic architecture (webXR already enforces performance constraints)
- Input abstraction (keyboard/mouse/gamepad/touch all emit same normalized events)
- No mobile UI yet - just foundation

### Phase 0: Foundation (Do Now)

**1. Input Abstraction**
Refactor InputHandler to emit normalized events regardless of source:
```javascript
{ move: {x, y}, look: {yaw, pitch}, action: 'jump' }
```
Keyboard, gamepad, and future touch all feed into same interface.

**2. Device Detection Utility**
```javascript
const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0
const isMobile = /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent)
```

**3. Performance Telemetry**
Track FPS on client, expose to server. When mobile is added, we'll have data on what devices can handle 128 TPS + Three.js.

### Phase 1: Minimal Touch (Later)
If/when mobile is prioritized:
- One virtual joystick (nipple.js) for movement
- "Jump" button
- Tap-to-shoot
- That's it. No aim, no crouch, no swipe-to-look.

### Skipped (Not Worth It)
- Swipe-to-look (awkward, use device orientation or don't bother)
- Complex button layouts (screen clutter)
- Gyroscope (permissions headache)
- Full PWA, native wrappers, advanced haptics

### Rationale
The 80/20 rule: joystick + jump + shoot = 80% of "playable on mobile" with 20% effort. Everything else is diminishing returns against desktop pulls.
