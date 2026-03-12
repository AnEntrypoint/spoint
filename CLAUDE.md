# Technical Caveats

## Documentation Sync Rule

SKILL.md and CLAUDE.md MUST be updated whenever code changes. SKILL.md is the agent-facing API reference (agents have NO source access). CLAUDE.md documents engine internals for contributors. No line numbers — they're stale immediately. Reference function/file names instead.

## Key Architecture

- Server: `node server.js` (port 3001, 64 TPS in world config, 128 TPS SDK default)
- World config: `apps/world/index.js`
- Apps: `apps/<name>/index.js` with `server` and `client` exports
- Physics: Jolt via `src/physics/World.js`
- GLB extraction: `src/physics/GLBLoader.js`
- Load tester: `src/sdk/BotHarness.js`

## Key File Locations

- Physics world: `src/physics/World.js`
- GLB extraction: `src/physics/GLBLoader.js`
- App context: `src/apps/AppContext.js`
- App runtime: `src/apps/AppRuntime.js`
- Tick handler: `src/sdk/TickHandler.js`
- Snapshot encoder: `src/netcode/SnapshotEncoder.js`
- Snapshot processor: `src/client/SnapshotProcessor.js`
- Map rotator: `src/stage/MapRotator.js`
- Maps: `apps/maps/*.glb` (all Draco compressed)

---

## Entity Scale: Physics + Graphics Parity

**GLB internal node transforms are always applied automatically on both sides. `entity.scale` is a multiplier on top.**

When a GLB is loaded, both pipelines apply node hierarchy transforms identically:
- **Physics** (`GLBLoader.js`): `buildNodeTransforms` walks the full node hierarchy and computes each node's world-space 4×4 matrix. `applyTransformMatrix` bakes the result into vertex positions. Then `entity.scale` is multiplied on top.
- **Visual** (`client/app.js`): Three.js `GLTFLoader` applies node hierarchy transforms automatically. `entity.scale` is set via `model.scale.set(entity.scale)` on the root.

Both pipelines produce: `vertex_world = node_hierarchy_transform(vertex_local) × entity_scale`. App developers set `entity.scale` and both physics and visual scale together — no manual math needed.

All collider creation methods in `AppContext.js` enforce this:
- `addBoxCollider`: half-extents multiplied per-axis by `entity.scale`
- `addSphereCollider`: radius multiplied by `max(entity.scale)` (Jolt spheres must be uniform)
- `addCapsuleCollider`: radius and height multiplied by `max(entity.scale)` (Jolt capsules must be uniform)
- `addConvexFromModel` / `addConvexFromModelAsync`: full node hierarchy applied in `extractMeshFromGLB`/`extractMeshFromGLBAsync`, then vertex positions multiplied per-axis by `entity.scale`
- `addTrimeshCollider`: full hierarchy applied in `extractAllMeshesFromGLBAsync`, then `entity.scale` passed to `World.addStaticTrimeshAsync` which multiplies all vertex positions per-axis

**Snapshot wire format**: `entity.scale` is encoded as three Q1-precision floats appended after `custom` (indices 14,15,16 in the entity array). Old clients default to `[1,1,1]` via nullish coalescing.

**Client** (`app.js`): `_doLoadEntityModel` applies `entityState.scale` to `model.scale.set(sx,sy,sz)` for both GLB models and primitive meshes.

**Static trimesh colliders** (`addTrimeshCollider`, `world.addStaticTrimeshAsync`): scale is NOT applied — map GLBs have scale baked into vertices.

**Non-uniform scale on capsules/spheres**: Not supported by Jolt. The engine uses `max(sx,sy,sz)` as a uniform scalar. Use box/convex colliders for non-uniform shapes.

Never set scale on an entity after collider creation — the physics body will not update.

## Entity Transform Pipeline

Server → Client transform flow:
1. **Server**: `entity.position`, `entity.rotation` (quaternion [x,y,z,w]), `entity.scale` stored on entity object
2. **Encoding**: `encodeEntity()` in `SnapshotEncoder.js` quantizes all three into the entity array at fixed indices
3. **Decoding**: `SnapshotProcessor._parseEntityNew()` decodes all 17 array fields including scale at indices 14-16 (defaults to `[1,1,1]` if absent)
4. **Client load**: `_doLoadEntityModel()` in `client/app.js` applies position, rotation (quaternion), and scale to the Three.js mesh/group at load time
5. **Dynamic updates**: animate loop interpolates position and quaternion each frame from `entityTargets`; scale is applied once at load and not re-applied per frame

**Rotation is always a full quaternion [x,y,z,w]** — never euler.

## Snapshot Encoding Format

Positions quantized to 2 decimal places (precision 100), rotations to 4 (precision 10000). Player array: `[id, px, py, pz, rx, ry, rz, rw, vx, vy, vz, onGround, health, inputSeq, crouch, lookPitchByte, lookYawByte]`. Entity array: `[id, model, px, py, pz, rx, ry, rz, rw, vx, vy, vz, bodyType, custom, sx, sy, sz]` — indices 0-13 plus scale at 14-16. Wrong field order breaks clients silently.

---

## App Client API Expansions (renderCtx + engineCtx)

`renderCtx` (passed to `render(ctx)`) includes Three.js shortcuts directly: `ctx.THREE`, `ctx.scene`, `ctx.camera`, `ctx.renderer`, `ctx.playerId`, `ctx.clock`. Added in `renderAppUI()` in `client/app.js`.

`engineCtx` (passed to `setup`, `onFrame`, `onInput`, `onEvent`, `onKeyDown`, `onKeyUp`) has `engine.network.send(msg)` — shorthand for `client.send(0x33, msg)`.

`onKeyDown(e, engine)` and `onKeyUp(e, engine)` hooks are dispatched to all app modules from document keydown/keyup listeners in `client/app.js`. Dispatch happens after `editor.onKeyDown(e)`.

## App Design Principle: Apps Are Config, Engine Is Code

Apps must be minimal. The engine handles the boilerplate:

- **No `client.render` needed** unless the app returns a `ui:` field. The snapshot carries `position`, `rotation`, `custom`, `model` automatically to the client.
- **No `onEditorUpdate` needed** unless the app needs to react to changes beyond the standard fields. `ServerHandlers.js` EDITOR_UPDATE handler already applies `position`, `rotation`, `scale`, `custom` to the entity before firing `onEditorUpdate`.
- **Use `addColliderFromConfig(cfg)`** — handles motion type + shape in one call. Replaces separate `setStatic/setDynamic` + `addBoxCollider` chains.
- **Use `spawnChild(id, cfg)`** — auto-destroys children on app teardown. Replaces manual `teardown` loops over spawned entity ids.
- Helper functions belong OUTSIDE the `export default {}` block — `evaluateAppModule` hoists code before the default export.

## Reusable Apps: box-static, prop-static, box-dynamic

- `box-static` — visual box primitive + static collider. Config: `{ hx, hy, hz, color, roughness }`. Spawn via `ctx.world.spawn(id, { app: 'box-static', config: { hx, hy, hz, color } })`. Has `editorProps`.
- `prop-static` — static GLB prop with convex hull collider. Entity must have `model` set. Uses `addColliderFromConfig({ type: 'convex' })`.
- `box-dynamic` — dynamic physics box with primitive mesh. Config: `{ hx, hy, hz, color, roughness, mass }`. Uses `addColliderFromConfig`. Has `editorProps`.

## Primitive Rendering (No GLB Required)

Box, sphere, cylinder meshes are created client-side from `entity.custom` when `entity.model` is null.
- `mesh`: `'box'` | `'sphere'` | `'cylinder'`
- `sx/sy/sz`: full width/height/depth (box); `r`: radius; `h`: height (cylinder); `seg`: segments
- `color`, `roughness`, `metalness`, `emissive`, `emissiveIntensity`
- `hover`: Y oscillation amplitude; `spin`: rotation speed (rad/s)
- `light`: point light color; `lightIntensity`; `lightRange`

## Engine-Level Interactable System

`ctx.interactable({ prompt, radius, cooldown })` in `AppContext.js` — top-level ctx method (NOT `ctx.physics`). Writes `ent.custom._interactable = { prompt, radius }` so the snapshot carries config to the client. `_tickInteractables()` in AppRuntime.js runs every tick, fires `onInteract(ctx, player)` when player is within radius and presses E, subject to per-player-per-entity cooldown.

Client prompt rendered in `_buildInteractPrompt()` → `renderAppUI()` every frame. No app client code needed for basic prompts.

`ctx.physics.setInteractable(radius)` exists for compat but does NOT write `custom._interactable`, so the engine client prompt won't appear. Prefer `ctx.interactable()`.

## evaluateAppModule Helper Function Hoisting

`evaluateAppModule()` converts `export default` to `return`. Helper functions declared AFTER the `export default { ... }` block become unreachable dead code. The regex splits source into code-before-default (hoisted) and the export value (becomes the return). `//# sourceURL=app-module.js` comment appended for Firefox attribution.

Apps cannot use imports — all dependencies come from `engineCtx` (THREE, createElement, etc).

## App Module List Cache

`_appModuleList` is a cached `[...appModules.values()]` array. Avoids Map iteration inside the hot `onAppEvent` handler. Rebuilt on every `appModules` change.

## App State Survival

`ctx.state` → `entity._appState`. On hot reload: new AppContext is created but entity keeps `_appState` reference. State survives; timers and bus subscriptions are destroyed and re-created.

---

## GLB/VRM IndexedDB Model Cache

`client/ModelCache.js` caches raw GLB/VRM ArrayBuffers in IndexedDB keyed by URL. On repeat loads, a HEAD request checks the server ETag. Match → return cached buffer; miss → stream full GET, store in IndexedDB.

`fetchCached(url, onProgress)`: gzip detection via `content-encoding` — when gzip is present, `content-length` (compressed size) is NOT used as progress denominator since the stream delivers decompressed bytes.

`StaticHandler.js` emits ETag (hex-encoded mtime) and handles `If-None-Match` → 304. Cache failures fall back to normal fetch silently.

## GLBTransformer: GLB + VRM KTX2 Transform

`GLBTransformer.js` applies Draco + KTX2 texture conversion to `.glb` and `.vrm` files on first request, serving original immediately while caching transforms to `.glb-cache/`.

**VRM-specific rules:**
- **Draco is skipped for VRM** — gltf-transform's NodeIO strips unknown extensions (`extensions.VRM`, `extensions.VRMC_vrm`). Detected via `json.extensions?.VRM || json.extensions?.VRMC_vrm`.
- **PNG/JPEG converted** — VRM textures are typically PNG/JPEG. `imageToKtx2()` handles all sharp-readable formats.
- **Normal map hints** — from `extensions.VRM.materialProperties[].textureProperties._BumpMap` → `uastc` encode mode.
- **Texture extension** — plain textures (with `tex.source`) get `KHR_texture_basisu` replacing `source` directly.
- `prewarm()` scans `.vrm` files in addition to `.glb`.

**WebP-to-KTX2 (GLB maps):** builds `imageSlotHints` from material slots (normalTexture → `uastc`, others → `basis-lz`). Replaces image buffer views in-place, updates mime types, swaps `EXT_texture_webp` → `KHR_texture_basisu`. Draco runs first via gltf-transform, only kept if smaller.

## Draco Compressed Model Support

- `extractMeshFromGLB(filepath)` — sync, throws on Draco/meshopt
- `extractMeshFromGLBAsync(filepath)` — async, handles Draco
- `world.addStaticTrimeshAsync(glbPath)` — uses `extractAllMeshesFromGLBAsync` which combines ALL meshes + ALL primitives. Critical for map GLBs with dozens of meshes and hundreds of Draco primitives.

**Meshopt NOT supported.** Decompress first: `gltfpack -i model-compressed.glb -o model-uncompressed.glb -noq`

## Invisible/Trigger Material Filtering (CS:GO Maps)

`extractAllMeshesFromGLBAsync` in GLBLoader.js skips primitives whose material name is in `SKIP_MATS`: `aaatrigger`, `{invisible`, `playerclip`, `clip`, `nodraw`, `toolsclip`, `toolsplayerclip`, `toolsnodraw`, `toolsskybox`, `toolstrigger`. Without this, CS:GO maps have phantom collision walls.

Client-side: `loadEntityModel` sets `c.visible = false` for meshes with these material names.

## Map GLB Structure

All maps in `apps/maps/` use Draco compression (`KHR_draco_mesh_compression`). Typically 1 root scene node + N mesh nodes with identity transforms. 40-80 meshes with 80-100+ Draco primitives each — `extractAllMeshesFromGLBAsync` must combine ALL meshes + ALL primitives or players fall through floors.

---

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

## Convex Hull Collider

`addBody('convex', ...)` in World.js accepts `params` as flat `[x,y,z,...]` vertex array. Uses Jolt's `ConvexHullShapeSettings` + `VertexList`. Both destroyed after shape creation. `addConvexFromModel(meshIndex)` in AppContext.js reads vertices from entity GLB at setup time via `extractMeshFromGLB`.

## Capsule Shape Parameter Order

Jolt CapsuleShape takes `(halfHeight, radius)` NOT `(radius, halfHeight)`. `addCapsuleCollider(r, h)` in AppContext.js passes `[r, h/2]`; World.js uses `params[1]` for halfHeight, `params[0]` for radius.

## Physics Bodies Only Created Via App setup()

Setting `entity.bodyType` or `entity.collider` directly has NO effect. A Jolt body is only created when `ctx.physics.addBoxCollider()` etc. is called inside `setup(ctx)`.

## CharacterVirtual Gravity

`CharacterVirtual.ExtendedUpdate()` does NOT apply gravity. PhysicsIntegration.js manually applies `gravity[1] * dt` to vy. The gravity vector passed to ExtendedUpdate only controls step-down/step-up behavior.

## Physics Step Substeps

`jolt.Step(dt, 2)` — always 2 substeps regardless of dt. At 64 TPS with gravity=-18 m/s² small props still tunnel at 1 substep. Fixed to always use 2 substeps for reliable CCD on small fast objects.

## TickHandler Velocity Override

After `updatePlayerPhysics()`, wished XZ velocity is written back over the physics result. Only Y comes from physics. Changing this breaks movement feel entirely.

## Movement Uses Quake-style Air Strafing

`groundAccel` applies WITH friction, `airAccel` WITHOUT. World config `maxSpeed: 4.0` overrides `DEFAULT_MOVEMENT.maxSpeed: 8.0` — defaults in movement.js are NOT what runs in production.

## Active Dynamic Body Tracking

`AppRuntime` maintains `_dynamicEntityIds` (all dynamic) and `_activeDynamicIds` (awake only). `_syncDynamicBodies()` runs every tick and only iterates `_activeDynamicIds`. `World.syncDynamicBody()` returns `true` when body is active, `false` when sleeping. Sleeping entities set `e._dynSleeping = true` — used by SnapshotEncoder to skip re-encoding and by Stage to skip octree updates.

## Spatial Physics LOD

`physicsRadius` in world config (default 0 = disabled) enables spatial LOD for dynamic Jolt bodies. When enabled, `AppRuntime._tickPhysicsLOD(players)` runs every `tickRate/2` ticks. Uses player AABB precompute to skip entities clearly outside all players' combined bounding box — skips ~89% of entities on large maps. Only suspends bodies that are sleeping; awake bodies remain until they settle. `physicsRadius` must be explicitly included in the `config` object passed to `createServer()`.

`entityTickRate` in world config sets the Hz at which app `update()` callbacks fire (default = tickRate). `entityTickDivisor = round(tickRate / entityTickRate)`. Update fires every N ticks; `entityDt` passed to callback = `dt * divisor`.

**Suspend flow**: `_physics.removeBody` removes the Jolt body; entity position/rotation preserved in JS; `entity._bodyActive = false`; `entity._physicsBodyId = undefined`; entity added to `_suspendedEntityIds`.

**Restore flow**: `_physics.addBody` re-creates Jolt body at entity's current position; `entity._physicsBodyId` set to new body id; `entity._bodyActive = true`; `_physicsBodyToEntityId` updated with new id.

**`entity._bodyDef`** — stored by `AppContext` collider methods when `bodyType === 'dynamic'`. Contains `{ shapeType, params, motionType, opts }` needed to re-create the body. Static bodies never get `_bodyDef`.

**destroyEntity** — `_suspendedEntityIds.delete` ensures suspended entity ids are cleaned up. No `removeBody` call needed for suspended entities (body already removed from Jolt).

**Jolt body id stability** — Jolt reuses sequence numbers after `DestroyBody`. Restored bodies get new ids. `_physicsBodyToEntityId` is always updated on restore.

## SpatialIndex (Octree) Update Threshold

`SpatialIndex.update()` in `src/spatial/Octree.js` skips re-insertion if entity moved less than 1.0 unit (distance² < 1.0). This threshold is intentionally coarse — for relevance radius=60, sub-1m octree accuracy is irrelevant. Without this, 991 moving physics bodies each trigger an octree remove+insert per tick.

## Dynamic Body Position Sync

`AppRuntime._syncDynamicBodies()` runs every tick before `_spatialSync()`. Reads position/rotation from Jolt for entities with `bodyType === 'dynamic'` and `_physicsBodyId`. Uses `World.isBodyActive()` to skip sleeping bodies — settled bodies cost 1 `IsActive` check instead of 3 calls.

---

## Snapshot Delivery Architecture

### SNAP_GROUPS Rotation

TickHandler sends snapshots to `1/SNAP_GROUPS` of players per tick. Formula: `snapGroups = Math.max(4, Math.ceil(playerCount / 25))`. At 100p: 4 groups (50 sends/tick). Effective snapshot rate = 32 Hz at all player counts.

**Bottleneck**: Windows WebSocket kernel I/O ~166μs per send. SNAP_GROUPS tuning halves writes at 100p, gaining 46% improvement (1,186→1,358 snaps/sec).

**sendPacked optimization** (broadcast path, no StageLoader): snapshot is msgpack-encoded ONCE, sent to all bucket recipients via `connections.sendPacked()`.

### Per-Player Spatial Snapshots

With StageLoader active and `relevanceRadius > 0`, each player gets a per-player snapshot of entities within radius. `connections.send()` is called per player. Without StageLoader: shared snapshot, `sendPacked` used.

### Static Entity Snapshot Optimization

Static entities are pre-encoded once per tick via `SnapshotEncoder.encodeStaticEntities()` and only when `appRuntime._staticVersion` changes. In steady state the 1000-entity scan is skipped entirely.

`encodeDelta` receives:
- `staticEntries` (all statics) for new players
- `changedEntries` (only mutated statics) for existing players when statics change
- `null` for existing players when statics are unchanged — zero cost

`AppRuntime._dynamicEntityIds` caches the Set of non-static entity IDs, rebuilt on spawn/destroy.

`AppRuntime._updateList` caches `[entityId, server, ctx]` tuples where `server.update` is a function. Built in `_rebuildUpdateList()` called from `_attachApp`/`detachApp`. `tick()` iterates `_updateList` instead of all `this.apps`.

### Dynamic Entity Cache: In-Place Mutation

`SnapshotEncoder.buildDynamicCache(activeIds, sleepingIds, suspendedIds, entities)` — cold-start cache build. Called when `prevDynCache` is null (first tick, keyframe, or entity spawn/destroy).

`SnapshotEncoder.refreshDynamicCache(cache, activeIds, entities)` — hot-path in-place mutation. Only iterates `_activeDynamicIds` (O(N_active)), mutating the cache entries for awake bodies only. Sleeping entries remain in cache untouched.

`TickHandler` resets `prevDynCache = null` when `_staticVersion` changes or on keyframe ticks. Normal ticks call `refreshDynamicCache`. Cost: 0.1ms for 100 active of 10k total.

`SnapshotEncoder.encodeDeltaFromCache()` iterates `relevantIds` (player's visible set) instead of the full `dynCache` when smaller. Cost reduction: O(N × P) encodeEntity calls → O(N). For 1000 entities × 100 players: 100,000 → 1,000 encodeEntity calls per tick.

### Spatial Player Culling

When `relevanceRadius > 0`, `AppRuntime.getNearbyPlayers()` filters players to include only those within the viewer's radius. Compares distance squared vs radius squared (no sqrt). Bandwidth reduction: 250 players @ 128 TPS = 28.77 → 2.00 MB/s (93% saved).

`AppRuntime._playerIndex` (SpatialIndex) is updated every tick in `_syncPlayerIndex()`. Falls back to linear scan when index is empty (first tick).

### Keyframe Interval

`KEYFRAME_INTERVAL` in TickHandler.js is `tickRate * 10` (10 seconds). Snap group rotation is ALWAYS applied — including keyframe ticks — to prevent burst.

On keyframe ticks, per-player spatial snapshots must use `encodeDelta(combined, new Map())` only (empty map = full keyframe). Calling both `encode()` AND `encodeDelta()` causes double-encoding.

### Entity Key Caching

`encodeDelta` stores `[key, customRef, customStr]` per entity. Unchanged `entity.custom` object reference skips `JSON.stringify`. Static entities cost ~0 per tick.

---

## Performance Optimizations

### Physics Player Divisor

`PHYSICS_PLAYER_DIVISOR = 3` in `TickHandler.js`. Runs Jolt physics for a player only every 3rd tick. Exceptions: always runs on jump ticks (`inp?.jump`) and airborne ticks (`!st.onGround`). Passes fixed per-tick `dt` (NOT accumulated dt) — at divisor=3 with 64 TPS, accumulated=3/64≈0.047s exceeds Jolt's 2-substep threshold (1/55≈0.018s), which doubles CharacterVirtual cost.

### Idle Player Physics Skip

`playerIdleCounts` Map in `TickHandler.js` tracks consecutive idle ticks per player. A player is physics-idle when: no directional input, onGround=true, and horizontal velocity magnitude < 0.01 m/s. After 1 settling tick, subsequent idle ticks skip `physicsIntegration.updatePlayerPhysics()`, saving ~47µs per skip. Counter resets to 0 when player moves.

### Snap Phase Spatial Cache

`spatialCache` Map groups players by `floor(x/R)*65536+floor(z/R)` cell key. All players in the same cell reuse the same `nearbyPlayerIds` and `relevantIds`. Each player still gets their own `filterEncodedPlayersWithSelf` and unique `encodeDeltaFromCache` result. Eliminates redundant octree queries for co-located players.

### Client-Side Optimizations

1. **BVH deferred to idle callback (`_scheduleBvhBuild`)** — `computeBoundsTree()` deferred to `requestIdleCallback` (2ms time slice) via `_bvhQueue`. Camera raycast falls back to brute-force on un-built geometries.
2. **`SKIP_MATS_SET` hoisted to module level** — was creating a new `Set` on every `_doLoadEntityModel` call.
3. **O(n²) `.find()` eliminated in `onStateUpdate`** — replaced with a `Set` built once per call, making lookups O(1).
4. **`warmupShaders` uses `compileAsync`** — eliminates GPU stalls during per-mesh shader compilation.

### Capacity Table (64 TPS, divisor=3, 1000 dynamic entities, relevanceRadius=60)

| Players | Avg Tick | mv (skip) | mv (physics) | snap | Budget |
|---------|----------|-----------|--------------|------|--------|
| 50      | ~6ms     | ~0.5ms    | ~2ms         | ~4ms | OK     |
| 100     | ~8ms     | ~0.8ms    | ~3ms         | ~5ms | OK     |
| 200     | ~13ms    | ~1.6ms    | ~6ms         | ~6ms | OK     |
| 300     | ~9.5ms*  | ~2.5ms    | ~9ms         | ~4ms | OK     |
| 400     | >15ms    | ~3.5ms    | ~12ms        | ~8ms | OVER   |

*300p avg includes mixed skip+physics ticks. Physics ticks peak at ~16ms but are 1-in-3.

---

## Hot Reload Architecture

Three independent systems:
1. **ReloadManager** — watches SDK source files. Uses `swapInstance()` to replace prototype/non-state properties while preserving state (e.g. `playerBodies` survives PhysicsIntegration reload).
2. **AppLoader** — watches `apps/`. Reloads drain via `appRuntime._drainReloadQueue()` at end of each tick (never mid-tick). `_resetHeartbeats()` called after each reload to prevent heartbeat timeout disconnects.
3. **Client hot reload** — `MSG.HOT_RELOAD` (0x70) triggers `location.reload()`. Camera state preserved via sessionStorage.

AppLoader blocks these patterns (even in comments): `process.exit`, `child_process`, `require(`, `__proto__`, `Object.prototype`, `globalThis`, `eval(`, `import(`.

After 3 consecutive reload failures, a module stops auto-reloading until server restart. Exponential backoff: 100ms → 200ms → 400ms.

## Module Cache Busting

Hot-reloaded imports use `?t=${Date.now()}` to bust Node's ESM module cache.

## WORLD_DEF Does Not Include Entities

`ServerHandlers.onClientConnect()` strips the `entities` array from the world definition before sending `MSG.WORLD_DEF` to connecting clients. Pattern: `const { entities: _ignored, ...worldDefForClient } = ctx.currentWorldDef`.

## Message Types Are Hex Not Sequential

MessageTypes.js uses hex grouping. Snapshot = 0x10, input = 0x11. Old docs listed decimal 1-6 which is wrong.

## Editor Message Types (0x80–0x8F)

Inspector excludes the 0x80–0x8F range to avoid intercepting editor traffic.

| Hex  | Name             | Direction       | Purpose |
|------|-----------------|-----------------|---------|
| 0x80 | EDITOR_UPDATE   | C→S             | Move/rotate/scale selected entity |
| 0x81 | EDITOR_SELECT   | S→C             | Tell client which entity to select (+ editorProps) |
| 0x82 | PLACE_MODEL     | C→S             | Upload GLB and place as `placed-model` entity |
| 0x83 | PLACE_APP       | C→S             | Place a named app at a world position |
| 0x84 | LIST_APPS       | C→S             | Request app list |
| 0x85 | APP_LIST        | S→C             | App list response `{ apps: [{name, description, hasEditorProps}] }` |
| 0x86 | GET_SOURCE      | C→S             | Request source of `apps/<name>/<file>` |
| 0x87 | SOURCE          | S→C             | Source response `{ appName, file, source }` |
| 0x88 | SAVE_SOURCE     | C→S             | Save source to disk (hot-reload fires automatically) |
| 0x89 | SCENE_GRAPH     | C↔S             | C→S: request refresh. S→C: entity tree |
| 0x8A | LIST_APP_FILES  | C→S             | Request file list for an app |
| 0x8B | APP_FILES       | S→C             | File list response `{ appName, files }` |
| 0x8C | DESTROY_ENTITY  | C→S + S→C       | Delete entity; server destroys+persists+broadcasts |
| 0x8D | CREATE_APP      | C→S             | Scaffold new `apps/<name>/index.js` from template |
| 0x8E | GET_EDITOR_PROPS| C→S             | Request editorProps for a specific entity |
| 0x8F | EDITOR_PROPS    | S→C             | editorProps response `{ entityId, editorProps }` |

`editorProps` on the server module (or `appDef.server.editorProps`) is an array of field descriptors:
```js
editorProps: [
  { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
  { key: 'size',  label: 'Size',  type: 'number', default: 1 },
  { key: 'mode',  label: 'Mode',  type: 'select', options: ['a','b'], default: 'a' },
  { key: 'label', label: 'Label', type: 'text',   default: '' },
]
```
These are rendered in the editor Inspector panel as live-editable fields. Changes fire `onEditorUpdate` on the server (position/rotation/scale/custom already applied by `ServerHandlers` before the hook fires).

## msgpack Implementation

`src/protocol/msgpack.js` re-exports `pack`/`unpack` from `msgpackr`. All snapshot encoding uses msgpackr.

---

## Client Rendering

## Three.js Performance Settings

- `THREE.Cache.enabled = true`
- `matrixAutoUpdate = false` on all static environment meshes (set post-load)
- `material.shadowSide = THREE.DoubleSide` on environment meshes — prevents bright corner-line seam artifacts. Current code uses `DoubleSide`, NOT `BackSide`.
- `PCFSoftShadowMap` — `VSMShadowMap` causes blurred cutout artifacts.
- `Map.forEach` in the `animate()` loop for player iteration — avoids iterator object allocation per frame.

## Loading Screen Gate Conditions

`checkAllLoaded()` gates on all four simultaneously: `assetsLoaded`, `environmentLoaded`, `firstSnapshotReceived`, `firstSnapshotEntityPending.size === 0`. Then `warmupShaders()` runs async in the background.

## warmupShaders + compileAsync

`warmupShaders()` runs AFTER `loadingScreen.hide()` (guarded by `_shaderWarmupDone`): disables frustumCulled on all scene objects → renders twice → restores frustumCulled.

For entities loaded post-loading-screen, `loadEntityModel` calls `renderer.compileAsync(scene, camera)` after adding the mesh. VRM players use a separate one-time `_vrmWarmupDone` flag.

A zero-intensity `THREE.PointLight` (`_warmupPointLight`) is added at startup to force the point-light shader variant to compile upfront.

## Shadow Frustum Auto-Fit

`fitShadowFrustum()` in app.js adjusts directional light shadow camera bounds to actual scene geometry. Called once after environment GLB loads.

## Camera Collision Raycast Rate

20Hz (every 50ms) via `fpsRayTimer`/`tpsRayTimer`. Cached clip distance used between raycasts. Snaps faster toward player (speed 30) than away (speed 12). BVH via `three-mesh-bvh` vendored at `client/vendor/three-mesh-bvh.module.js` (NOT npm/CDN). `computeBoundsTree()` called on each collider mesh at environment load. Without BVH: ~65% of frame CPU in FPS mode.

`cam.setEnvironment(meshes)` must be populated from non-skinned static meshes only. Never fall back to `scene.children` — includes skinned VRM meshes, causes massive CPU overhead.

## DRACOLoader Worker Pool

Default 4 workers, each initializes Draco WASM on first use. `dracoLoader.setWorkerLimit(1)` to cap startup cost when few Draco meshes are expected.

## Client Position Interpolation

Exponential lerp: `lerp(1 - exp(-16 * dt))` + velocity extrapolation per frame (`goalX = target.x + vx * dt`). Without extrapolation, movement appears jittery at 128 TPS.

## Client Jitter Gotchas

- **Spawn point Y**: Keep low (Y≈5). Spawning high causes fall jitter on join.
- **Velocity extrapolation**: `SmoothInterpolation.getDisplayState()` adds `position += velocity * dt`.
- **Rotation interpolation**: `JitterBuffer._slerp()` uses quaternion SLERP, not linear lerp.
- **Kalman filter**: `positionR = 0.1` — lower values cause overshoot.
- **RTT measurement**: Uses snapshot `serverTime` field, not heartbeat ping (heartbeat gives ~500ms on localhost; snapshot gives <20ms).

## Static File Serving Priority

staticDirs order: `/src/` → `/apps/` → `/node_modules/` → `/` (client). SDK paths take priority. Project-local `apps/` overrides SDK `apps/` if it exists.

---

## VRM / Animation

## VRM Model Scale Pipeline

`modelScale` (default 1.323) on vrm.scene.scale. `feetOffset` ratio (0.212) × modelScale = negative Y offset. `userData.feetOffset = 1.3` hardcoded for client-side position offset. Mismatching any of these misaligns model with physics capsule.

## Animation Library Two-Phase Cache

`preloadAnimationLibrary(loader)` — fire-and-forget in `initAssets`, accepts the main gltfLoader (required since server Draco-compresses anim-lib.glb via GLBTransformer). `loadAnimationLibrary(vrmVersion, vrmHumanoid)` — awaits the preload, then normalizes clips. Returns `{ normalizedClips, rawClips }`.

## Animation State Machine Thresholds

Locomotion transitions use hysteresis (idle-to-walk: 0.8 vs walk-to-idle: 0.3). Locomotion cooldown: 0.3s. Air grace period: 0.15s before jump detection.

## Animation Retargeting Track Filtering

`filterValidClipTracks()` removes bone references that don't exist in the target VRM before `mixer.clipAction()`. Without it, THREE.js PropertyBinding throws errors for every invalid track. Applied to all clips (retargeted and normalized).

## AFAN Webcam Live Streaming Architecture

**What it is**: Opt-in live face tracking that streams ARKit blendshape weights from webcam to nearby players' VRM morph targets.

**Binary format**: `Uint8Array(52)` — one byte per ARKit blendshape (see `ARKIT_NAMES` in `client/webcam-afan.js` and `client/facial-animation.js`). Each byte = weight × 255. 52 bytes per frame at 30Hz = ~1.5 KB/s per sender.

**Lazy load**: `client/webcam-afan.js` is NOT imported by `client/app.js`. Only loaded when user explicitly starts webcam tracking via `window.enableWebcamAFAN()`.

**Face tracking**: Uses MediaPipe FaceMesh (CDN, `@mediapipe/face_mesh@0.4`) loaded lazily inside `WebcamAFANTracker.init()`. Falls back to animated demo data if MediaPipe fails to load.

**Network path**: client → `afan_frame` → server `webcam-avatar` app → nearby players only (30-unit radius) → each receiver's `onAppEvent` → `_applyAfanFrame()` in `client/app.js` → `FacialAnimationPlayer.applyFrame()`.

**Receiver**: `_applyAfanFrame(playerId, Uint8Array)` in `client/app.js` decodes the 52-byte frame and applies it to the target player's VRM via `FacialAnimationPlayer`. Player lookup uses `playerVrms` Map. `_afanPlayers` Map caches `FacialAnimationPlayer` instances per playerId.

**Server message type**: `afan_frame` with `{ playerId, data: number[] }`. Server uses `ctx.players.send()` for per-player delivery, not broadcast.

---

## Multiplayer Systems

## LagCompensator Ring Buffer

Fixed 128-slot ring buffer. Entries pruned by timestamp (default 500ms window), not by count. Pre-allocated entry objects avoid GC.

`ctx.lagCompensator` is exposed on server app context (`AppContext.js`). Call `lagCompensator.getPlayerStateAtTime(playerId, millisAgo)` to get rewound position for hit validation.

**Hit detection pattern**: client sends `clientTime: Date.now()` in `fire` message. Server computes `latencyMs = Math.min(600, Date.now() - msg.clientTime)`. `handleFire` calls `lagCompensator.getPlayerStateAtTime(target.id, latencyMs)` to rewind target position. Cap at 600ms prevents abuse.

## Collision Detection (Entity-Entity vs Player-Player)

`AppRuntime._tickCollisions()` — sphere-based entity-entity collision for app `onCollide` events. Separate from Jolt.

`TickHandler.js` — player-player separation: capsule radius overlap check + push-apart after physics step. The `other.id <= player.id` guard processes each pair exactly once.

## Spatial Grid for Player Collision

Cell size = `capsuleRadius * 8`. Each player checks 9 neighboring cells. At 100 players, reduces from 4,950 pairs to near-zero. Profile: col=0.04ms at 100 players.

## Heartbeat Timeout

3-second timeout. ANY message from client resets the timer. Client sends explicit heartbeat every 1000ms.

## Client Input Rate vs Server Tick Rate

Client sends at 60Hz. Server processes all buffered inputs per tick but uses only the LAST input's data. `inputSequence` increments per input for reconciliation.

---

## Misc Engine Details

## TickSystem

`loop()` processes max 4 ticks per iteration — drops ticks if further behind to prevent death spirals. Timer: `setTimeout(1ms)` when gap > 2ms, `setImmediate` when ≤ 2ms.

## Entity Hierarchy

`getWorldTransform()` walks up parent chain recursively. Destroying parent cascades to children.

## EventBus

Wildcard `*` suffix patterns (`combat.*` receives `combat.fire`, `combat.hit`). `system.*` prefix is reserved. Each entity gets a scoped bus via `bus.scope(entityId)` — `destroyScope()` unsubscribes all on entity destroy. Leaking bus subscriptions persist across hot reloads.

## Debug Globals

Server: `globalThis.__DEBUG__.server`. Client: `window.debug` (scene, camera, renderer, client, mesh maps, input handler). Always set, not gated by flags.
