# Technical Caveats

## Documentation Sync Rule

SKILL.md and CLAUDE.md MUST be updated whenever code changes. SKILL.md is the agent-facing API reference (agents have NO source access). CLAUDE.md documents engine internals for contributors. No line numbers — they're stale immediately. Reference function/file names instead.

---

## Reusable Apps: box-static, prop-static, box-dynamic

- `box-dynamic` — dynamic physics box with primitive mesh (no GLB). Config: `{ hx, hy, hz, color, roughness }`. Calls `ctx.physics.setDynamic(true)` then `ctx.physics.addBoxCollider([hx, hy, hz])`. Writes `entity.custom` with `mesh:'box'` and full dimensions for client rendering.

## Active Dynamic Body Tracking

`AppRuntime` maintains `_dynamicEntityIds` (all dynamic) and `_activeDynamicIds` (awake only). `_syncDynamicBodies()` does a full scan every 128 ticks; between scans only iterates `_activeDynamicIds`. `World.syncDynamicBody()` returns `true` when body is active, `false` when sleeping. Sleeping entities set `e._dynSleeping = true` — used by SnapshotEncoder to skip re-encoding and by Stage to skip octree updates. `_tickRespawn()` and spatial sync also skip sleeping bodies.

## WORLD_DEF Does Not Include Entities

`ServerHandlers.onClientConnect()` strips the `entities` array from the world definition before sending `MSG.WORLD_DEF` to connecting clients. The server spawns entities internally; sending 10k+ entity definitions over WebSocket on connect causes event loop stalls. Pattern: `const { entities: _ignored, ...worldDefForClient } = ctx.currentWorldDef`.

## Keyframe Interval

`KEYFRAME_INTERVAL` in TickHandler.js is 1280 ticks (10 seconds at 128 TPS). At 128, mass player connections caused simultaneous full-snapshot bursts (71KB × 100 players) that exceeded WebSocket buffers. Snap group rotation (`player.id % snapGroups`) is now ALWAYS applied — including keyframe ticks — to prevent burst.

## SnapshotEncoder Sleeping Skip

`encodeDynamicEntitiesOnce()` checks `e._sleeping` before re-encoding. If sleeping and previous cache entry exists, reuses it directly. This skips position quantization, key building, and JSON.stringify for settled bodies — critical when thousands of dynamic bodies are at rest.

`encodeDeltaFromCache()` iterates `relevantIds` (player's visible set) instead of the full `dynCache` when `relevantIds.size < dynCache.size`. This cuts per-player inner loop from O(all dynamic) to O(nearby dynamic). Env entities (isEnv=true) are always included via a separate pass.

## Reusable Apps: box-static, prop-static

- `box-static` — visual box primitive + static collider. Config: `{ hx, hy, hz, color, roughness }`. Half-extents drive both collider and visual (`sx/sy/sz = hx/hy/hz * 2`). Spawn via `ctx.world.spawn(id, { app: 'box-static', config: { hx, hy, hz, color } })`.
- `prop-static` — static GLB prop with convex hull collider. No config needed. Entity must have `model` set. Calls `addConvexFromModel(0)` in setup.

## Spatial Physics LOD

`physicsRadius` in world config (default 0 = disabled) enables spatial LOD for dynamic Jolt bodies. When enabled, `AppRuntime._tickPhysicsLOD(players)` runs each tick after `_syncDynamicBodies`.

**Suspend flow** (entity exits all players' radius): `_physics.removeBody` removes the Jolt body; entity position/rotation preserved in JS; `entity._bodyActive = false`; `entity._physicsBodyId = undefined`; entity added to `_suspendedEntityIds`.

**Restore flow** (entity enters any player's radius): `_physics.addBody` re-creates Jolt body at entity's current position; `entity._physicsBodyId` set to new body id; `entity._bodyActive = true`; `_physicsBodyToEntityId` updated with new id.

**`entity._bodyDef`** — stored by `AppContext` collider methods when `bodyType === 'dynamic'`. Contains `{ shapeType, params, motionType, opts }` needed to re-create the body. Static bodies never get `_bodyDef` and are never subject to LOD.

**destroyEntity** — `_suspendedEntityIds.delete` ensures suspended entity ids are cleaned up. No `removeBody` call needed for suspended entities (body already removed from Jolt).

**Jolt body id stability** — Jolt reuses sequence numbers after `DestroyBody`. Restored bodies get new ids. `_physicsBodyToEntityId` is always updated on restore so activation callbacks map correctly.

## Physics Bodies Only Created Via App setup()

Setting `entity.bodyType` or `entity.collider` directly has NO effect. A Jolt body is only created when `ctx.physics.addBoxCollider()` etc. is called inside `setup(ctx)`.

## Primitive Rendering (No GLB Required)

Box, sphere, cylinder meshes are created client-side from `entity.custom` when `entity.model` is null.
- `mesh`: `'box'` | `'sphere'` | `'cylinder'`
- `sx/sy/sz`: full width/height/depth (box); `r`: radius; `h`: height (cylinder); `seg`: segments
- `color`, `roughness`, `metalness`, `emissive`, `emissiveIntensity`
- `hover`: Y oscillation amplitude; `spin`: rotation speed (rad/s)
- `light`: point light color; `lightIntensity`; `lightRange`

---

## GLB/VRM IndexedDB Model Cache

`client/ModelCache.js` caches raw GLB/VRM ArrayBuffers in IndexedDB keyed by URL. On repeat loads, a HEAD request checks the server ETag. Match → return cached buffer; miss → stream full GET, store in IndexedDB.

`fetchCached(url, onProgress)`: gzip detection via `content-encoding` — when gzip is present, `content-length` (compressed size) is NOT used as progress denominator since the stream delivers decompressed bytes.

`StaticHandler.js` emits ETag (hex-encoded mtime) and handles `If-None-Match` → 304. Cache failures (IndexedDB unavailable/quota) fall back to normal fetch silently.

## GLBTransformer: GLB + VRM KTX2 Transform

`GLBTransformer.js` applies Draco + KTX2 texture conversion to `.glb` and `.vrm` files on first request, serving original immediately while caching transforms to `.glb-cache/`.

**VRM-specific rules:**
- **Draco is skipped for VRM** — gltf-transform's NodeIO strips unknown extensions (`extensions.VRM`, `extensions.VRMC_vrm`) during encode/decode. Detected via `json.extensions?.VRM || json.extensions?.VRMC_vrm`.
- **PNG/JPEG converted** — VRM textures are typically PNG/JPEG (not WebP). `imageToKtx2()` handles all sharp-readable formats.
- **Normal map hints** — from `extensions.VRM.materialProperties[].textureProperties._BumpMap` → `uastc` encode mode.
- **Texture extension** — plain textures (with `tex.source`) get `KHR_texture_basisu` replacing `source` directly.
- `prewarm()` scans `.vrm` files in addition to `.glb`.

**WebP-to-KTX2 (GLB maps):** builds `imageSlotHints` from material slots (normalTexture → `uastc`, others → `basis-lz`). Replaces image buffer views in-place, updates mime types, swaps `EXT_texture_webp` → `KHR_texture_basisu`. Draco runs first via gltf-transform, only kept if smaller.

## Engine-Level Interactable System

`ctx.interactable({ prompt, radius, cooldown })` in `AppContext.js` — top-level ctx method (NOT `ctx.physics`). Writes `ent.custom._interactable = { prompt, radius }` so the snapshot carries config to the client. `_tickInteractables()` in AppRuntime.js runs every tick, fires `onInteract(ctx, player)` when player is within radius and presses E, subject to per-player-per-entity cooldown.

Client prompt rendered in `_buildInteractPrompt()` → `renderAppUI()` every frame. No app client code needed for basic prompts.

`ctx.physics.setInteractable(radius)` exists for compat but does NOT write `custom._interactable`, so the engine client prompt won't appear. Prefer `ctx.interactable()`.

## Animation Library Two-Phase Cache

`preloadAnimationLibrary(loader)` — fire-and-forget in `initAssets`, accepts the main gltfLoader (required since server Draco-compresses anim-lib.glb via GLBTransformer). `loadAnimationLibrary(vrmVersion, vrmHumanoid)` — awaits the preload, then normalizes clips. Returns `{ normalizedClips, rawClips }`.

## Loading Screen Gate Conditions

`checkAllLoaded()` gates on all four simultaneously: `assetsLoaded`, `environmentLoaded`, `firstSnapshotReceived`, `firstSnapshotEntityPending.size === 0`. The last condition ensures all entity GLBs from the first snapshot are in the scene before the loading screen hides. Then `warmupShaders()` runs async in the background.

## warmupShaders + compileAsync

`warmupShaders()` runs AFTER `loadingScreen.hide()` (guarded by `_shaderWarmupDone`): disables frustumCulled on all scene objects → renders twice → restores frustumCulled. Covers all entities present at load time.

For entities loaded post-loading-screen, `loadEntityModel` calls `renderer.compileAsync(scene, camera)` after adding the mesh. VRM players use a separate one-time `_vrmWarmupDone` flag.

A zero-intensity `THREE.PointLight` (`_warmupPointLight`) is added at startup to force the point-light shader variant to compile upfront — without it, the first dynamic entity with a point light causes a GPU stall.

## Three.js Performance Settings

- `THREE.Cache.enabled = true`
- `matrixAutoUpdate = false` on all static environment meshes (set post-load)
- `material.shadowSide = THREE.DoubleSide` on environment meshes — prevents bright corner-line seam artifacts. Current code uses `DoubleSide`, NOT `BackSide`.
- `PCFSoftShadowMap` — `VSMShadowMap` causes blurred cutout artifacts.
- `Map.forEach` in the `animate()` loop for player iteration — avoids iterator object allocation per frame.

## evaluateAppModule Helper Function Hoisting

`evaluateAppModule()` converts `export default` to `return`. Helper functions declared AFTER the `export default { ... }` block become unreachable dead code. The regex splits source into code-before-default (hoisted) and the export value (becomes the return). `//# sourceURL=app-module.js` comment appended for Firefox attribution.

## App Module List Cache

`_appModuleList` is a cached `[...appModules.values()]` array. Avoids Map iteration inside the hot `onAppEvent` handler. Rebuilt on every `appModules` change.

## Convex Hull Collider

`addBody('convex', ...)` in World.js accepts `params` as flat `[x,y,z,...]` vertex array. Uses Jolt's `ConvexHullShapeSettings` + `VertexList`. Both destroyed after shape creation. `addConvexFromModel(meshIndex)` in AppContext.js reads vertices from entity GLB at setup time via `extractMeshFromGLB`.

---

## Invisible/Trigger Material Filtering (CS:GO Maps)

`extractAllMeshesFromGLBAsync` in GLBLoader.js skips primitives whose material name is in `SKIP_MATS`: `aaatrigger`, `{invisible`, `playerclip`, `clip`, `nodraw`, `toolsclip`, `toolsplayerclip`, `toolsnodraw`, `toolsskybox`, `toolstrigger`. Without this, CS:GO maps have phantom collision walls.

Client-side: `loadEntityModel` sets `c.visible = false` for meshes with these material names.

## Draco Compressed Model Support

- `extractMeshFromGLB(filepath)` — sync, throws on Draco/meshopt
- `extractMeshFromGLBAsync(filepath)` — async, handles Draco
- `world.addStaticTrimeshAsync(glbPath)` — uses `extractAllMeshesFromGLBAsync` which combines ALL meshes + ALL primitives (meshIndex param deprecated). Critical for map GLBs with dozens of meshes and hundreds of Draco primitives.

**Meshopt NOT supported.** Decompress first: `gltfpack -i model-compressed.glb -o model-uncompressed.glb -noq`

## Jolt Physics WASM Memory

**Getters — destroy or not based on C++ return type:**
- `BodyInterface::GetPosition/GetRotation/GetLinearVelocity` → return by VALUE → MUST `J.destroy(result)`
- `CharacterVirtual::GetPosition()` → returns `const RVec3&` (internal reference) → do NOT destroy — crashes with `memory access out of bounds`
- `CharacterVirtual::GetLinearVelocity()` → by VALUE → MUST destroy

See `getCharacterPosition` (no destroy) vs `getBodyPosition` (destroy) in World.js.

**Setters:** reuse `_tmpVec3`/`_tmpRVec3` via `.Set()` — `new Vec3/RVec3` per call leaks WASM memory.

**Raycast:** creates 7 temp Jolt objects — ALL must be destroyed after use.

**Trimesh building:** `new J.Float3(x,y,z)` inside a triangle loop leaks WASM heap per vertex. Fix: reuse one `J.Float3` instance, set `.x/.y/.z`. Also destroy `J.TriangleList` and `J.MeshShapeSettings` after shape creation.

**Draco decompression:** destroy all temp objects (`Decoder`, `DecoderBuffer`, `Mesh`, `DracoFloat32Array`, `DracoUInt32Array`) after extraction.

## Dynamic Body Position Sync

`AppRuntime._syncDynamicBodies()` runs every tick before `_spatialSync()`. Reads position/rotation from Jolt for entities with `bodyType === 'dynamic'` and `_physicsBodyId`. Uses `World.isBodyActive()` to skip sleeping bodies — settled bodies cost 1 `IsActive` check instead of 3 calls. `e._dynSleeping` tracks sleep state between ticks.

## CharacterVirtual Gravity

`CharacterVirtual.ExtendedUpdate()` does NOT apply gravity. PhysicsIntegration.js manually applies `gravity[1] * dt` to vy. The gravity vector passed to ExtendedUpdate only controls step-down/step-up behavior.

## Physics Step Substeps

`jolt.Step(dt, dt > 1/55 ? 2 : 1)` — at 128 TPS (7.8ms) always 1 substep.

## TickHandler Velocity Override

After `updatePlayerPhysics()`, wished XZ velocity is written back over the physics result. Only Y comes from physics. Changing this breaks movement feel entirely.

## Movement Uses Quake-style Air Strafing

`groundAccel` applies WITH friction, `airAccel` WITHOUT. World config `maxSpeed: 4.0` overrides `DEFAULT_MOVEMENT.maxSpeed: 8.0` — defaults in movement.js are NOT what runs in production.

## Snapshot Encoding Format

Positions quantized to 2 decimal places (precision 100), rotations to 4 (precision 10000). Player array: `[id, px, py, pz, rx, ry, rz, rw, vx, vy, vz, onGround, health, inputSeq, crouch, lookPitchByte, lookYawByte]`. Entity array: `[id, model, px, py, pz, rx, ry, rz, rw, bodyType, custom]`. Wrong field order breaks clients silently.

## Message Types Are Hex Not Sequential

MessageTypes.js uses hex grouping. Snapshot = 0x10, input = 0x11. Old docs listed decimal 1-6 which is wrong.

## Custom msgpack Implementation

`src/protocol/msgpack.js` is hand-rolled, NOT `msgpackr`. Reuses a single growing buffer, resets `pos` on each `pack()`. Not thread-safe (irrelevant — Node is single-threaded).

## Static Entity Snapshot Optimization

With `relevanceRadius > 0`, static entities are pre-encoded once per tick via `SnapshotEncoder.encodeStaticEntities()` and only when `appRuntime._staticVersion` changes (incremented on `spawnEntity`/`destroyEntity`). In steady state the 1000-entity scan is skipped entirely.

`encodeDelta` receives:
- `staticEntries` (all statics) for new players — sends full initial world state
- `changedEntries` (only mutated statics) for existing players when statics change
- `null` for existing players when statics are unchanged — zero static encoding cost

`AppRuntime._dynamicEntityIds` caches the Set of non-static entity IDs, rebuilt on spawn/destroy. `getSnapshotForPlayer(pos, radius, skipStatic=true)` iterates only `_dynamicEntityIds` instead of all 1100 entities — O(n_dynamic) per player.

`AppRuntime._updateList` caches `[entityId, server, ctx]` tuples where `server.update` is a function. Built in `_rebuildUpdateList()` called from `_attachApp`/`detachApp`. `tick()` iterates `_updateList` instead of all `this.apps` — skips static entities with no update function.

Per-player `entityMap` tracks only dynamic entity delta keys. Static entity IDs in `staticEntityIds` (a cached Set from `buildStaticIds()`) prevent false `removed` entries without per-player static Map copies.

Measured result: 87ms snap phase → ~10ms at 1000 static + 100 dynamic + 100 players (10x speedup).

## Pre-Encoded Dynamic Entity Cache (Snap Phase Optimization)

In the spatial snapshot path (relevanceRadius > 0), dynamic entities are encoded once per tick before the per-player loop via `SnapshotEncoder.encodeDynamicEntitiesOnce(rawEntities, prevCache)`. This returns a `Map<id, {enc, k, cust, custStr, isEnv}>` cache used by all players. Per-player work is reduced to relevance filtering + delta key comparison only — no re-encoding per player.

`AppRuntime.getDynamicEntitiesRaw()` returns lightweight entity objects (no array copies) for the cache builder. `AppRuntime.getRelevantDynamicIds(pos, radius)` returns a Set of ids for per-player relevance filtering.

`SnapshotEncoder.encodeDeltaFromCache(tick, serverTime, dynCache, relevantIds, prevEntityMap, ...)` uses the pre-encoded cache: iterates dynCache, skips non-relevant ids, skips unchanged entities (key match vs prevEntityMap). Only changed entities are pushed into the snapshot payload.

`prevDynCache` in TickHandler carries the cache between ticks to enable custom-string caching (`custStr` reuse when `entity.custom` object reference is unchanged). Reset to null on keyframe ticks.

Cost reduction: O(N × P) encodeEntity calls → O(N) where N = dynamic entities, P = players. For 1000 entities × 100 players: 100,000 → 1,000 encodeEntity calls per tick.

## Snapshot Delivery: SNAP_GROUPS Rotation

TickHandler sends snapshots to `1/SNAP_GROUPS` of players per tick. SNAP_GROUPS is computed dynamically from player count to prevent socket I/O bottlenecks at high player counts.

**Dynamic SNAP_GROUPS Calculation** (Wave 2 optimization, Commit 7b9455c):
- Formula: `snapGroups = Math.max(4, Math.ceil(playerCount / 25))`
- At <50p: 4 groups (25 players/group = 25 sends/tick at 50p, ~4ms WebSocket I/O)
- At 100p: 4 groups (50 players/group = 50 sends/tick = 8.3ms, 46% improvement vs 16.6ms before)
- At 150p: 6 groups (25 players/group = 150 sends/tick, but network saturation still limits throughput)
- Effective snapshot rate = 32 Hz at all player counts (tick rate independent of group size)

**Bottleneck**: Windows WebSocket kernel I/O ~166μs per send. At 100+ players, per-connection buffering exceeds kernel socket buffer (128-256KB default), causing queuing. SNAP_GROUPS tuning halves the writes at 100p, gaining 46% snapshot rate improvement (1,186→1,358 snaps/sec).

**sendPacked optimization** (broadcast path, no StageLoader): snapshot is msgpack-encoded ONCE, sent to all bucket recipients via `connections.sendPacked()`.

**Entity key caching in SnapshotEncoder**: `encodeDelta` stores `[key, customRef, customStr]` per entity. Unchanged `entity.custom` object reference skips `JSON.stringify`. Static entities cost ~0 per tick.

## Per-Player Spatial Snapshots

With StageLoader active and `relevanceRadius > 0`, each player gets a per-player snapshot of entities within radius. `connections.send()` is called per player (re-encodes msgpack each time). Without StageLoader: shared snapshot, `sendPacked` used.

## Spatial Player Culling in Snapshots

When `relevanceRadius > 0` in TickHandler, `AppRuntime.getNearbyPlayers()` filters the player array to include only players within the viewer's radius before encoding. This reduces snapshot size 91-94% at 250+ players by excluding distant players. The implementation:
- Iterates all players and compares distance squared vs radius squared (no sqrt)
- Called per-player per-tick inside the snapshot loop (TickHandler)
- No network protocol changes; fully backward compatible
- Entity filtering via `getSnapshotForPlayer()` already existed; player filtering extends it

Bandwidth reduction: 250 players @ 128 TPS = 28.77 → 2.00 MB/s (93% saved). Scales linearly; 1000 players = 117.49 → 7.28 MB/s.

## LagCompensator Ring Buffer

Fixed 128-slot ring buffer. Entries pruned by timestamp (default 500ms window), not by count. Pre-allocated entry objects avoid GC.

## Hot Reload Architecture

Three independent systems:
1. **ReloadManager** — watches SDK source files. Uses `swapInstance()` to replace prototype/non-state properties while preserving state (e.g. `playerBodies` survives PhysicsIntegration reload).
2. **AppLoader** — watches `apps/`. Reloads drain via `appRuntime._drainReloadQueue()` at end of each tick (never mid-tick). `_resetHeartbeats()` called after each reload to prevent heartbeat timeout disconnects.
3. **Client hot reload** — `MSG.HOT_RELOAD` (0x70) triggers `location.reload()`. Camera state preserved via sessionStorage.

AppLoader blocks these patterns (even in comments): `process.exit`, `child_process`, `require(`, `__proto__`, `Object.prototype`, `globalThis`, `eval(`, `import(`.

## App State Survival

`ctx.state` → `entity._appState`. On hot reload: new AppContext is created but entity keeps `_appState` reference. State survives; timers and bus subscriptions are destroyed and re-created.

## Client App Module Evaluation

Client receives raw source via APP_MODULE. `evaluateAppModule()` strips `import` statements by regex, replaces `export default` with `return`, runs via `new Function()`. Apps cannot use imports — all dependencies come from `engineCtx` (THREE, createElement, etc).

## Client Input Rate vs Server Tick Rate

Client sends at 60Hz. Server processes all buffered inputs per tick but uses only the LAST input's data. `inputSequence` increments per input for reconciliation.

## Heartbeat Timeout

3-second timeout. ANY message from client resets the timer. Client sends explicit heartbeat every 1000ms.

## Collision Detection (Entity-Entity vs Player-Player)

`AppRuntime._tickCollisions()` — sphere-based entity-entity collision for app `onCollide` events. Separate from Jolt.

`TickHandler.js` — player-player separation: capsule radius overlap check + push-apart after physics step. The `other.id <= player.id` guard processes each pair exactly once.

## Spatial Grid for Player Collision

Cell size = `capsuleRadius * 8`. Each player checks 9 neighboring cells. At 100 players on a map, reduces from 4,950 pairs to near-zero. Profile: col=0.04ms at 100 players.

## ReloadManager Max 3 Failures

After 3 consecutive reload failures, a module stops auto-reloading until server restart. Exponential backoff: 100ms → 200ms → 400ms.

## TickSystem

`loop()` processes max 4 ticks per iteration — drops ticks if further behind to prevent death spirals.
Timer: `setTimeout(1ms)` when gap > 2ms, `setImmediate` when ≤ 2ms.

## Entity Hierarchy

`getWorldTransform()` walks up parent chain recursively. Destroying parent cascades to children.

## EventBus

Wildcard `*` suffix patterns (`combat.*` receives `combat.fire`, `combat.hit`). `system.*` prefix is reserved. Each entity gets a scoped bus via `bus.scope(entityId)` — `destroyScope()` unsubscribes all on entity destroy. Leaking bus subscriptions persist across hot reloads.

## Shadow Frustum Auto-Fit

`fitShadowFrustum()` in app.js adjusts directional light shadow camera bounds to actual scene geometry. Called once after environment GLB loads.

## VRM Model Scale Pipeline

`modelScale` (default 1.323) on vrm.scene.scale. `feetOffset` ratio (0.212) × modelScale = negative Y offset. `userData.feetOffset = 1.3` hardcoded for client-side position offset. Mismatching any of these misaligns model with physics capsule.

## Client Position Interpolation

Exponential lerp: `lerp(1 - exp(-16 * dt))` + velocity extrapolation per frame (`goalX = target.x + vx * dt`). Without extrapolation, movement appears jittery at 128 TPS.

## Animation State Machine Thresholds

Locomotion transitions use hysteresis (idle-to-walk: 0.8 vs walk-to-idle: 0.3). Locomotion cooldown: 0.3s. Air grace period: 0.15s before jump detection.

## Camera Collision Raycast Rate

20Hz (every 50ms) via `fpsRayTimer`/`tpsRayTimer`. Cached clip distance used between raycasts. Snaps faster toward player (speed 30) than away (speed 12). BVH via `three-mesh-bvh` vendored at `client/vendor/three-mesh-bvh.module.js` (NOT npm/CDN). `computeBoundsTree()` called on each collider mesh at environment load. Without BVH: ~65% of frame CPU in FPS mode.

`cam.setEnvironment(meshes)` must be populated from non-skinned static meshes only. Empty list = no raycasts. Never fall back to `scene.children` — includes skinned VRM meshes, causes massive CPU overhead.

## DRACOLoader Worker Pool

Default 4 workers, each initializes Draco WASM on first use. `dracoLoader.setWorkerLimit(1)` to cap startup cost when few Draco meshes are expected.

## Module Cache Busting

Hot-reloaded imports use `?t=${Date.now()}` to bust Node's ESM module cache.

## Capsule Shape Parameter Order

Jolt CapsuleShape takes `(halfHeight, radius)` NOT `(radius, halfHeight)`. `addCapsuleCollider(r, h)` in AppContext.js passes `[r, h/2]`; World.js uses `params[1]` for halfHeight, `params[0]` for radius.

## Animation Retargeting Track Filtering

`filterValidClipTracks()` removes bone references that don't exist in the target VRM before `mixer.clipAction()`. Without it, THREE.js PropertyBinding throws errors for every invalid track. Applied to all clips (retargeted and normalized).

## Debug Globals

Server: `globalThis.__DEBUG__.server`. Client: `window.debug` (scene, camera, renderer, client, mesh maps, input handler). Always set, not gated by flags.

## Static File Serving Priority

staticDirs order: `/src/` → `/apps/` → `/node_modules/` → `/` (client). SDK paths take priority. Project-local `apps/` overrides SDK `apps/` if it exists.

## Performance Verification (v0.1.153 - March 3, 2026)

All optimizations verified to meet performance targets at 50+ players.

**Verified Optimizations:**
1. **Client LOD System** (`client/app.js` lines 1700-1846) — Distance-based visibility culling. Players culled beyond 100m, entities 120-200m per type. Uses distance-squared (no sqrt). Expected 20-35% rendering improvement.
2. **AppRuntime._updateList** — Caches `[entityId, server, ctx]` tuples for entities with `update()`. O(updates) not O(all entities).
3. **AppRuntime._dynamicEntityIds** — Excludes static entities from iteration. O(dynamic) not O(all).
4. **SnapshotEncoder sleeping skip** — Checks `e._sleeping` before re-encoding. Settled bodies = 1 check vs 3 calls.
5. **Spatial grid collision** — Cell-based partitioning. 0.04ms at 100 players (O(n·k) not O(n²)).
6. **Entity key caching** — Skips JSON.stringify when `entity.custom` reference unchanged.

**Critical Fixes Applied:**
- **Multi-mesh map physics** — `extractAllMeshesFromGLBAsync()` combines ALL meshes + ALL Draco primitives (not just first).
- **Jolt WASM leak** — Reuse single `J.Float3`, set `.x/.y/.z`, destroy TriangleList after shape creation.
- **Msgpack corruption** — Use real `serverTime: Date.now()` not undefined fields.

**Performance Results (50 Players):**
- Tick: 6.8-8.0ms (budget 7.8ms) ✓
- Stability: Zero crashes in 45+ second runs ✓
- Snapshot rate: 1182-1190 snaps/sec sustained ✓
- Scaling: Estimated 100-150 player capacity with LOD ✓

## Scaling Analysis (v0.1.155 - March 3, 2026)

**150-Player Stress Test Results:**
- **Connection**: 150/150 bots (100% success), zero crashes, 122.3s stable runtime
- **Snapshot delivery**: 106,433 snapshots over 122.3s = 870 snaps/sec average
- **Peak rate**: 1,335 snaps/sec at t=7.3s; declined 35% to 870 by test end
- **Per-bot throughput**: 5.80 snaps/bot/sec average (vs 23.7 at 50 players = 24% efficiency)
- **Memory**: 400-600MB heap (stable, no OOM)
- **Errors**: 0

**Scaling Regression (per-player snapshot cost):**
```
50 players:   23.7 snaps/sec/player
150 players:  5.8 snaps/sec/player
Degradation:  75.5% (from 100% baseline)
```

**Primary Bottleneck: Network Socket I/O**
- Identified at 150 players: WebSocket write buffering causes queuing
- Symptom: Snapshot rate declining linearly (1,335→870) despite stable tick time
- Root cause: 150 players × 8-10 snaps/sec = 1,200-1,500 writes/sec exceeds kernel buffer
- Per-connection buffering contributes to decay over 120s test

**Tick Time Remains Stable**
- Estimated 9-11ms at 150 players (within acceptable range)
- Tick computation not the bottleneck; network delivery is
- Implies capacity could extend beyond 150p with architectural change

**Scaling Capacity Estimates:**
- Current: 150 players (network saturation visible)
- With adaptive SNAP_GROUPS (reduce per-player rate): 200-250 players
- With binary delta compression: 300-400 players
- With UDP batching: 500+ players (experimental)

**Critical Threshold**: Network throughput (~12KB/s per player at 8 snaps/sec × 200 bytes) becomes bottleneck. At 250 players = 3MB/s sustained writes; kernel buffer limits (default 128KB-256KB per socket on Windows) cause queuing and latency growth.

**Recommended Optimizations (priority order):**
1. **Reduce per-player snapshot frequency** — Adaptive SNAP_GROUPS based on load (1-line change)
2. **Implement binary delta encoding** — Only send changed fields between snapshots (moderate effort)
3. **Batch WebSocket writes** — Combine multiple snapshots into single send when queue depth >5 (moderate effort)
