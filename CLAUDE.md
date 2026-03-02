# Technical Caveats

## Documentation Sync Rule

SKILL.md and CLAUDE.md MUST be updated whenever code changes. SKILL.md is the agent-facing API reference (agents have NO source access). CLAUDE.md documents engine internals for contributors. No line numbers — they're stale immediately. Reference function/file names instead.

---

## Reusable Apps: box-static, prop-static

- `box-static` — visual box primitive + static collider. Config: `{ hx, hy, hz, color, roughness }`. Half-extents drive both collider and visual (`sx/sy/sz = hx/hy/hz * 2`). Spawn via `ctx.world.spawn(id, { app: 'box-static', config: { hx, hy, hz, color } })`.
- `prop-static` — static GLB prop with convex hull collider. No config needed. Entity must have `model` set. Calls `addConvexFromModel(0)` in setup.

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

TickHandler sends snapshots to `1/SNAP_GROUPS` of players per tick (default 4). Effective snapshot rate = 32 Hz. At 100 players: 25 sends/tick × 166μs (Windows WebSocket kernel I/O) = 4ms/tick — within 7.8ms budget. SNAP_GROUPS is computed dynamically from player count.

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
