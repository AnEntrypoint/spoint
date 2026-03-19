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

- Physics world: `src/physics/World.js` (coordinator, ≤200 lines)
- Character physics: `src/physics/CharacterManager.js` (CharacterVirtual ops)
- Shape builder: `src/physics/ShapeBuilder.js` (convex/trimesh construction)
- App context: `src/apps/AppContext.js`
- App runtime: `src/apps/AppRuntime.js`
- App runtime physics mixin: `src/apps/AppRuntimePhysics.js`
- App runtime tick mixin: `src/apps/AppRuntimeTick.js`
- Tick handler: `src/sdk/TickHandler.js` (orchestrator)
- Player collision: `src/netcode/CollisionSystem.js` (`applyPlayerCollisions` export)
- Snapshot encoder: `src/netcode/SnapshotEncoder.js`
- Snapshot processor: `src/client/SnapshotProcessor.js`
- Client interpolation: `src/client/interpolation.js` (`lerpScalar`, `slerpQuat`, `interpolateSnapshot`)
- Edit panel DOM builders: `client/EditPanelDOM.js`
- Maps: `apps/maps/*.glb` (all Draco compressed)

## AppRuntime Mixin Pattern

`AppRuntime.js` applies two mixins at the bottom of the constructor — order matters:
1. `mixinPhysics(runtime)` from `AppRuntimePhysics.js` — `_syncDynamicBodies`, `_tickPhysicsLOD`. Must be first because tick calls these methods.
2. `mixinTick(runtime)` from `AppRuntimeTick.js` — `tick()`, `_tickTimers`, `_tickCollisions`, `_tickRespawn`, `_tickInteractables`, `_syncPlayerIndex`, `getNearbyPlayers`.

---

## Entity Scale: Physics + Graphics Parity

`entity.scale` is a multiplier on top of GLB node hierarchy transforms, which are always applied automatically on both sides:
- **Physics** (`GLBLoader.js`): `buildNodeTransforms` computes world-space 4x4 matrices, `applyTransformMatrix` bakes into vertices, then `entity.scale` multiplied on top.
- **Visual** (`client/app.js`): Three.js `GLTFLoader` applies node transforms automatically, then `entity.scale` set via `model.scale.set(entity.scale)`.

Collider methods in `AppContext.js`:
- `addBoxCollider`: half-extents multiplied per-axis by `entity.scale`
- `addSphereCollider` / `addCapsuleCollider`: radius multiplied by `max(entity.scale)` — Jolt requires uniform scale for these shapes
- `addConvexFromModel` / `addConvexFromModelAsync`: node hierarchy applied via `extractMeshFromGLB(Async)`, then vertices multiplied per-axis by `entity.scale`
- `addTrimeshCollider`: scale NOT applied — map GLBs have scale baked into vertices

**Non-uniform scale on capsules/spheres**: Not supported by Jolt. Use `max(sx,sy,sz)` as uniform scalar, or switch to box/convex.

Never set scale on an entity after collider creation — the physics body will not update.

## Entity Transform Pipeline

1. **Server**: `entity.position`, `entity.rotation` (quaternion [x,y,z,w]), `entity.scale`
2. **Encoding**: `encodeEntity()` quantizes all three into fixed indices
3. **Decoding**: `SnapshotProcessor._parseEntityNew()` decodes 17 fields; scale at indices 14-16 (defaults to `[1,1,1]`)
4. **Client load**: `loadEntityModel()` applies position, rotation, scale to Three.js mesh at load time
5. **Dynamic updates**: animate loop interpolates position and quaternion each frame; scale applied once at load only

**Rotation is always quaternion [x,y,z,w] — never euler.**

## Snapshot Encoding Format

Positions quantized to 2 decimal places (precision 100), rotations to 4 (precision 10000).

- Player array: `[id, px, py, pz, rx, ry, rz, rw, vx, vy, vz, onGround, health, inputSeq, crouch, lookPitchByte, lookYawByte]`
- Entity array: `[id, model, px, py, pz, rx, ry, rz, rw, vx, vy, vz, bodyType, custom, sx, sy, sz]` — indices 0-13 plus scale at 14-16

Wrong field order breaks clients silently.

---

## App API

### renderCtx + engineCtx

- `renderCtx` (passed to `render(ctx)`): `ctx.THREE`, `ctx.scene`, `ctx.camera`, `ctx.renderer`, `ctx.playerId`, `ctx.clock`. Added in `renderAppUI()` in `client/AppModuleSystem.js`.
- `engineCtx` (passed to lifecycle hooks): `engine.network.send(msg)` — shorthand for `client.send(0x33, msg)`.
- `onKeyDown/onKeyUp` dispatch happens after `editor.onKeyDown(e)` via `ams.dispatchKeyDown/dispatchKeyUp`.

### Design Principle: Apps Are Config, Engine Is Code

- No `client.render` needed unless the app returns a `ui:` field.
- No `onEditorUpdate` needed for standard field changes — `ServerHandlers.js` already applies `position`, `rotation`, `scale`, `custom` before firing the hook.
- Use `addColliderFromConfig(cfg)` — handles motion type + shape in one call.
- Use `spawnChild(id, cfg)` — auto-destroys children on app teardown.
- Helper functions must go OUTSIDE the `export default {}` block — `evaluateAppModule` hoists only code-before-default; code after becomes unreachable dead code.
- Apps cannot use imports — all dependencies come from `engineCtx`.

### Reusable Apps

- `box-static`: visual box + static collider. Config: `{ hx, hy, hz, color, roughness }`.
- `prop-static`: static GLB with convex hull. Entity must have `model` set.
- `box-dynamic`: dynamic physics box. Config: `{ hx, hy, hz, color, roughness, mass }`.

### Primitive Rendering (No GLB Required)

Set `entity.model = null` and populate `entity.custom`:
- `mesh`: `'box'` | `'sphere'` | `'cylinder'`; `sx/sy/sz`, `r`, `h`, `seg`
- `color`, `roughness`, `metalness`, `emissive`, `emissiveIntensity`
- `hover`: Y oscillation amplitude; `spin`: rotation speed (rad/s)
- `light`: point light color; `lightIntensity`; `lightRange`

### Interactable System

`ctx.interactable({ prompt, radius, cooldown })` — top-level `AppContext.js` method (NOT `ctx.physics`). Writes `ent.custom._interactable` so the snapshot carries config to client. `_tickInteractables()` fires `onInteract(ctx, player)` when player is within radius and presses E.

`ctx.physics.setInteractable(radius)` exists for compat but does NOT write `custom._interactable` — client prompt won't appear. Prefer `ctx.interactable()`.

### App State Survival

`ctx.state` maps to `entity._appState`. On hot reload: new AppContext created, but entity keeps `_appState`. State survives; timers and bus subscriptions are destroyed and re-created.

### App Module List Cache

`_appModuleList` is a cached `[...appModules.values()]` array — avoids Map iteration inside the hot `onAppEvent` handler. Rebuilt on every `appModules` change.

---

## GLB / Model Loading

### Draco Support

- `extractMeshFromGLB(filepath)` — sync, throws on Draco/meshopt
- `extractMeshFromGLBAsync(filepath)` — async, handles Draco
- `world.addStaticTrimeshAsync(glbPath)` — uses `extractAllMeshesFromGLBAsync` which combines ALL meshes + ALL primitives. Critical for map GLBs — missing any causes players to fall through floors.

**Meshopt NOT supported.** Decompress first: `gltfpack -i in.glb -o out.glb -noq`

### GLBTransformer (KTX2 + Draco on first request)

`GLBTransformer.js` applies Draco + KTX2 texture conversion, serves original immediately, caches to `.glb-cache/`.

- **Draco is skipped for VRM** — gltf-transform's NodeIO strips unknown extensions (`VRM`, `VRMC_vrm`). Detected via `json.extensions?.VRM || json.extensions?.VRMC_vrm`.
- **WebP-to-KTX2**: builds `imageSlotHints` from material slots (normalTexture → `uastc`, others → `basis-lz`). Draco runs first, only kept if smaller.
- `prewarm()` scans `.vrm` files in addition to `.glb`.

### Invisible/Trigger Material Filtering

`extractAllMeshesFromGLBAsync` skips primitives with material names in `SKIP_MATS`: `aaatrigger`, `{invisible`, `playerclip`, `clip`, `nodraw`, `toolsclip`, `toolsplayerclip`, `toolsnodraw`, `toolsskybox`, `toolstrigger`. Without this, CS:GO maps have phantom collision walls. Client-side: `loadEntityModel` sets `c.visible = false` for the same names.

### IndexedDB Model Cache

`client/ModelCache.js` caches GLB/VRM ArrayBuffers in IndexedDB keyed by URL. HEAD request checks ETag on repeat loads; 304 returns cache; miss fetches full GET. When gzip is present, `content-length` is NOT used as progress denominator (it's the compressed size, not decompressed).

---

## Jolt Physics WASM Memory

**Getters — destroy based on C++ return type:**
- `BodyInterface::GetPosition/GetRotation/GetLinearVelocity` → return by VALUE → MUST `J.destroy(result)`
- `CharacterVirtual::GetPosition()` → `const RVec3&` (internal reference) → do NOT destroy — crashes with `memory access out of bounds`
- `CharacterVirtual::GetLinearVelocity()` → by VALUE → MUST destroy

**Setters:** reuse `_tmpVec3`/`_tmpRVec3` via `.Set()` — `new Vec3/RVec3` per call leaks WASM memory.

**Raycast:** creates 7 temp Jolt objects — ALL must be destroyed after use.

**Trimesh building:** `new J.Float3(x,y,z)` inside a triangle loop leaks WASM heap per vertex. Fix: reuse one `J.Float3` instance, set `.x/.y/.z`. Destroy `J.TriangleList` and `J.MeshShapeSettings` after shape creation.

**Draco decompression:** destroy all temp objects (`Decoder`, `DecoderBuffer`, `Mesh`, `DracoFloat32Array`, `DracoUInt32Array`) after extraction.

**Convex hull:** `addBody('convex', ...)` in `World.js` accepts `params` as flat `[x,y,z,...]` vertex array. Destroy `ConvexHullShapeSettings` + `VertexList` after shape creation.

**Capsule parameter order:** Jolt `CapsuleShape` takes `(halfHeight, radius)` NOT `(radius, halfHeight)`. `addCapsuleCollider(r, h)` passes `[r, h/2]`; `World.js` uses `params[1]` for halfHeight, `params[0]` for radius.

## Physics Rules

- **Bodies only created in `setup()`**: setting `entity.bodyType` or `entity.collider` directly has no effect. A Jolt body is only created when `ctx.physics.addBoxCollider()` etc. is called inside `setup(ctx)`.
- **CharacterVirtual gravity**: `ExtendedUpdate()` does NOT apply gravity. `PhysicsIntegration.js` manually applies `gravity[1] * dt` to vy. The gravity vector passed to `ExtendedUpdate` controls only step-down/step-up.
- **Physics substeps**: `jolt.Step(dt, 2)` — always 2 substeps. 1 substep causes tunneling of small props at 64 TPS with gravity=-18 m/s².
- **TickHandler velocity override**: after `updatePlayerPhysics()`, wished XZ velocity is written back over the physics result. Only Y comes from physics. Changing this breaks movement feel.
- **Movement**: Quake-style air strafing. `groundAccel` applies WITH friction, `airAccel` WITHOUT. World config `maxSpeed: 4.0` overrides `DEFAULT_MOVEMENT.maxSpeed: 8.0` — defaults in movement.js are NOT what runs in production.

## Spatial Physics LOD

`physicsRadius` in world config (default 0 = disabled) enables spatial LOD. `_tickPhysicsLOD(players)` runs every `tickRate/2` ticks, suspends sleeping bodies outside all players' combined AABB (~89% skip rate on large maps). `physicsRadius` must be in the `config` object passed to `createServer()`.

- **Suspend**: `_physics.removeBody` removes Jolt body; position/rotation preserved in JS; `entity._bodyActive = false`; added to `_suspendedEntityIds`.
- **Restore**: `_physics.addBody` re-creates body at current position; `_physicsBodyToEntityId` updated with new id.
- **`entity._bodyDef`**: stored by collider methods when `bodyType === 'dynamic'`. Contains `{ shapeType, params, motionType, opts }` for body recreation. Static bodies never get `_bodyDef`.
- **Jolt body id stability**: Jolt reuses sequence numbers after `DestroyBody`. Restored bodies get new ids — always update `_physicsBodyToEntityId`.
- **destroyEntity**: `_suspendedEntityIds.delete` cleans up suspended ids. No `removeBody` needed (body already removed from Jolt).

`entityTickRate` in world config sets app `update()` callback Hz (default = tickRate). `entityDt` passed to callback = `dt * divisor`.

## Active Dynamic Body Tracking

`AppRuntime` maintains `_dynamicEntityIds` (all dynamic) and `_activeDynamicIds` (awake only). `_syncDynamicBodies()` runs every tick, only iterates `_activeDynamicIds`. `World.syncDynamicBody()` returns `true` when active, `false` when sleeping. Sleeping entities set `e._dynSleeping = true` — SnapshotEncoder skips re-encoding; Stage skips octree updates.

SpatialIndex skips re-insertion if entity moved less than 1.0 unit (distance² < 1.0) — intentionally coarse for relevance radius=60.

---

## Snapshot Delivery

### SNAP_GROUPS Rotation

`snapGroups = Math.max(1, Math.ceil(playerCount / 50))` — sends to 1/N of players per tick. At 100p: 2 groups → 32 Hz. At 200p: 4 groups → 16 Hz. Caps at ~50 sends/tick. Windows WebSocket kernel I/O ~166μs per send.

Snap group rotation is ALWAYS applied including keyframe ticks. On keyframe ticks, use `encodeDelta(combined, new Map())` only — calling both `encode()` AND `encodeDelta()` causes double-encoding.

### Static vs Dynamic Entity Encoding

Static entities pre-encoded once per tick via `encodeStaticEntities()`, only when `_staticVersion` changes. `encodeDelta` receives `staticEntries` for new players, `changedEntries` when statics change, `null` otherwise.

`buildDynamicCache()` — cold-start build (first tick, keyframe, spawn/destroy). `refreshDynamicCache()` — hot-path in-place mutation via `fillEntityEnc()`, zero allocation. `entry._dirty = true`; key lazily rebuilt in `applyEntry()` only when sent.

`encodeDeltaFromCache()` iterates `relevantIds` instead of full `dynCache`. `_updateList` caches `[entityId, server, ctx]` tuples for entities with `update` functions — rebuilt on `_attachApp`/`detachApp`.

### Spatial Player Culling

When `relevanceRadius > 0`, `getNearbyPlayers()` filters by distance² vs radius² (no sqrt). `_playerIndex` updated every tick in `_syncPlayerIndex()`.

### Entity Key Caching

`encodeDelta` stores `[key, customRef, customStr]` per entity. Unchanged `entity.custom` reference skips `JSON.stringify`. `JSON.stringify` is used (not `pack+hex`) — 8-12x faster for change detection.

---

## Performance Optimizations

### Physics Player Divisor

`PHYSICS_PLAYER_DIVISOR = 3` in `TickHandler.js` — runs Jolt for a player every 3rd tick. **Staggered by player ID**: `(tick + player.id) % PHYSICS_PLAYER_DIVISOR` — prevents thundering herd (all players hitting Jolt simultaneously causes 128ms spikes). Always runs on jump ticks and airborne ticks. Uses fixed per-tick `dt` NOT accumulated dt — accumulated at divisor=3 (≈0.047s) exceeds Jolt's 2-substep threshold (≈0.018s), doubling CharacterVirtual cost.

### Idle Player Physics Skip

Player is physics-idle when: no directional input, `onGround=true`, horizontal velocity < 0.01 m/s. After 1 settling tick, subsequent idle ticks skip `updatePlayerPhysics()`. Counter resets on movement.

### Snap Phase Spatial Cache

`_spatialCache` (module-level, cleared each tick) groups players by `floor(x/R)*65536+floor(z/R)` cell. Players in the same cell share `nearbyPlayerIds` and `relevantIds`. `_cellPackCache` caches packed snapshot buffers by cell key — ~43% hit rate in spread scenarios.

### Allocation Reduction

- Module-level `_spatialCache`, `_precomputedRemoved`, `_sendObj`, `_packWrapper`, `_packPayload` — reused each tick
- `pack()` + `sendPacked()` in spatial path avoids double-packing the `{type, payload}` wrapper
- `SNAP_UNRELIABLE = true` hoisted as constant
- Yaw sin/cos cached via `_lastYaw`/`_lastSinHalf`/`_lastCosHalf`
- `_tickTimers` uses in-place array compaction instead of allocating a new array

### Hot Path Micro-optimizations (2026-03-19)

**`fillEntityEnc` pre-destructure** (`SnapshotEncoder.js`): replaced array destructuring `const [px,py,pz]=e.position` with indexed access `const pos=e.position; const px=pos[0],...`. 46% improvement per call, **59% improvement at 500 entities/tick** (0.049 → 0.020 ms/tick saved).

**`fillEntityArr` scale null-check** (`SnapshotProcessor.js`): replaced `e[14]??1` with `const s14=e[14]; s14==null?1:s14`. 12% improvement. Avoids potential deoptimization from `??` operator on undefined array indices.

**`slerpQuat` fast path** (`interpolation.js`): added `dot>0.9995` branch that skips `Math.acos`+`Math.sin` and uses normalized lerp. 36% improvement for close rotations (common case during interpolation between nearby frames). Full slerp path unchanged for large-angle rotations.

### Collision Grid Pruning

Entity-entity: O(n²) brute-force for <100 entities, grid-based (cell=4 units, 9-neighbor) for >=100. Grid cells pruned every 64 ticks or when `size > count * 4`. Cooldown keys use `e.id * 100000 + p.id` (numeric, not string template). `_interactCooldowns` prunes entries older than 10s every 256 ticks when size > 100.

### Client-Side Optimizations

- **BVH deferred** to `requestIdleCallback` (2ms slice) via `_bvhQueue`. Camera raycast falls back to brute-force on un-built geometries.
- **`warmupShaders`**: disables `frustumCulled` on all objects, renders twice, restores. Post-load entities use `renderer.compileAsync`. A zero-intensity `_warmupPointLight` forces point-light shader variant to compile upfront. Session cache key uses entity count + sorted entity IDs (truncated to 200 chars) — prevents cross-scene cache collisions. Two `scene.traverse` passes merged into one.
- **Shadow map** updated only when scene moves (`_shadowDirty` flag), gated at max 15Hz.
- **`cam.setEnvironment(meshes)`** must use non-skinned static meshes only — never `scene.children` (includes skinned VRM meshes, causes massive CPU overhead).
- **SnapshotProcessor object pooling**: `makePlayerSlot`/`makeEntitySlot` with pool indexing; `fillPlayerArr`/`fillEntityArr` mutate in-place — zero allocation for existing entities.
- **Invisible player skip**: `tickPlayerAnimators` skips VRM update, bone overrides, and anim for invisible players (always runs for local player).
- Swap-and-pop entity removal (O(1) vs O(n) splice). GLTF cache LRU capped at 64 entries.
- **`LOD_CONFIGS.skipBeyondSq`**: precomputed squared distances in `EntityLoader.js`. `updateVisibility` uses `dx*dx+dy*dy+dz*dz` and compares directly — no per-frame `skipBeyond*skipBeyond` multiplication and no `**` operator.
- **Entity load concurrency**: `MAX_CONCURRENT_LOADS_INITIAL=8`, `MAX_CONCURRENT_LOADS_RUNTIME=4` — drains `firstSnapshotEntityPending` faster during loading screen.
- **Draco worker preload**: `dracoLoader.preload()` called immediately in `createLoaders()` — starts worker pool + WASM init at page load instead of paying that cost on first entity decode.
- **RippleUI non-blocking**: CDN stylesheet loaded with `media="print" onload="this.media='all'"` — never render-blocks first paint.
- **All imports vendored locally** (`index.html` importmap): three@0.183, three/addons/, @pixiv/three-vrm, webjsx, msgpackr all served from `/node_modules/` at localhost. Eliminates 500ms–1700ms CDN round-trips per module. `<link rel="modulepreload">` for 9 critical modules fires parallel fetches before `app.js` parses. Combined: cold load 34–36s → 22s (36% faster). `@pixiv/three-vrm` added as a real `package.json` dependency (was CDN-only).
- **`firstSnapshotEntityPending` only tracks dynamic entities**: static entities (map, environment props) no longer block the loading screen gate. `bodyType==='dynamic'` filter means only moving/interactive entities are waited for. A 5-second timeout (`_entityLoadTimeout`) clears the set as a safety net so no entity load failure can block the game forever.
- **`fitShadowFrustum` reuses Box3 instances**: `_fitBox3` and `_fitMeshBox` are module-level singletons. Replaces `box.expandByObject(o)` (which does internal sub-traverse per mesh) with direct `geometry.computeBoundingBox()` + `Box3.copy().applyMatrix4()` — O(N) single pass with zero allocation.

### Client Loading Pipeline (2026-03-19)

**Critical path**: `checkAllLoaded` gates on four simultaneous conditions: `assetsLoaded` (VRM + animation library), `environmentLoaded` (first entity mesh ready), `firstSnapshotReceived` (WebSocket snapshot), `firstSnapshotEntityPending.size === 0` (all entities in first snapshot loaded).

**`initAssets` parallel pattern**: `_readVrmVersion(buffer)` extracts VRM version from GLB binary header immediately. `loadAnimationLibrary(vrmVersion)` fires concurrently with VRM cache validation — `animPromise` resolves in parallel with the VRM `dbDelete/fetch` edge case path. `preloadAnimationLibrary(gltfLoader)` fires at the start of `initAssets`, so `anim-lib.glb` is fetched in parallel with the VRM download.

**`LoadingManager.fetchWithProgress`** passes `onProgress` callback to `fetchCached` for byte-level streaming progress during first-load downloads.

### Capacity Table (64 TPS, divisor=3, 1000 dynamic entities, relevanceRadius=60)

| Players | Avg Tick | Budget |
|---------|----------|--------|
| 50      | ~6ms     | OK     |
| 100     | ~8ms     | OK     |
| 200     | ~13ms    | OK     |
| 300     | ~9.5ms*  | OK     |
| 400     | >15ms    | OVER   |

*300p avg includes mixed skip+physics ticks; physics ticks peak ~16ms but are 1-in-3.

---

## Hot Reload Architecture

Three independent systems:
1. **ReloadManager** — watches SDK source files. Uses `swapInstance()` to replace prototype/non-state properties while preserving state (e.g. `playerBodies` survives PhysicsIntegration reload).
2. **AppLoader** — watches `apps/`. Reloads drain via `_drainReloadQueue()` at end of each tick (never mid-tick). `_resetHeartbeats()` called after each reload to prevent heartbeat timeout disconnects.
3. **Client hot reload** — `MSG.HOT_RELOAD` (0x70) triggers `location.reload()`. Camera state preserved via sessionStorage.

AppLoader blocks these patterns even in comments: `process.exit`, `child_process`, `require(`, `__proto__`, `Object.prototype`, `globalThis`, `eval(`, `import(`.

After 3 consecutive reload failures, module stops auto-reloading until server restart. Exponential backoff: 100ms → 200ms → 400ms. Hot-reloaded imports use `?t=${Date.now()}` to bust Node's ESM module cache.

---

## Misc Engine Details

- **WORLD_DEF strips entities**: `ServerHandlers.onClientConnect()` removes the `entities` array before sending `MSG.WORLD_DEF`. Pattern: `const { entities: _ignored, ...worldDefForClient } = ctx.currentWorldDef`.
- **Message types are hex**: `MessageTypes.js` uses hex grouping. Snapshot = 0x10, input = 0x11.
- **msgpack**: `src/protocol/msgpack.js` re-exports `pack`/`unpack` from `msgpackr`.
- **TickSystem**: `loop()` processes max 4 ticks per iteration to prevent death spirals. `setTimeout(1ms)` when gap > 2ms, `setImmediate` when <= 2ms.
- **Entity hierarchy**: `getWorldTransform()` walks parent chain recursively. Destroying parent cascades to children.
- **EventBus**: wildcard `*` suffix (`combat.*` receives `combat.fire`). `system.*` prefix reserved. `bus.scope(entityId)` — `destroyScope()` unsubscribes all on entity destroy. Leaking subscriptions persist across hot reloads.
- **Debug globals**: Server: `globalThis.__DEBUG__.server`. Client: `window.debug` (scene, camera, renderer, client, mesh maps, input handler). Always set.
- **Static file serving priority**: `/src/` → `/apps/` → `/node_modules/` → `/` (client). Project-local `apps/` overrides SDK `apps/`.
- **Heartbeat**: 3-second timeout. ANY message resets timer. Client sends heartbeat every 1000ms.
- **Client input rate**: 60Hz. Server uses only LAST buffered input per tick. `inputSequence` increments for reconciliation.
- **Spatial grid for player collision**: cell size = `capsuleRadius * 8`, 9-neighbor check. `other.id <= player.id` guard processes each pair once.

## Editor Message Types (0x80-0x8F)

Inspector excludes the 0x80-0x8F range to avoid intercepting editor traffic.

| Hex  | Name             | Direction | Purpose |
|------|------------------|-----------|---------|
| 0x80 | EDITOR_UPDATE    | C->S      | Move/rotate/scale selected entity |
| 0x81 | EDITOR_SELECT    | S->C      | Tell client which entity to select (+ editorProps) |
| 0x82 | PLACE_MODEL      | C->S      | Upload GLB and place as `placed-model` entity |
| 0x83 | PLACE_APP        | C->S      | Place a named app at a world position |
| 0x84 | LIST_APPS        | C->S      | Request app list |
| 0x85 | APP_LIST         | S->C      | `{ apps: [{name, description, hasEditorProps}] }` |
| 0x86 | GET_SOURCE       | C->S      | Request source of `apps/<name>/<file>` |
| 0x87 | SOURCE           | S->C      | `{ appName, file, source }` |
| 0x88 | SAVE_SOURCE      | C->S      | Save source to disk (hot-reload fires automatically) |
| 0x89 | SCENE_GRAPH      | C<->S     | C->S: request refresh. S->C: entity tree |
| 0x8A | LIST_APP_FILES   | C->S      | Request file list for an app |
| 0x8B | APP_FILES        | S->C      | `{ appName, files }` |
| 0x8C | DESTROY_ENTITY   | C->S+S->C | Delete entity; server destroys+persists+broadcasts |
| 0x8D | CREATE_APP       | C->S      | Scaffold new `apps/<name>/index.js` from template |
| 0x8E | GET_EDITOR_PROPS | C->S      | Request editorProps for a specific entity |
| 0x8F | EDITOR_PROPS     | S->C      | `{ entityId, editorProps }` |

`editorProps` schema:
```js
editorProps: [
  { key: 'color', label: 'Color', type: 'color',  default: '#ffffff' },
  { key: 'size',  label: 'Size',  type: 'number', default: 1 },
  { key: 'mode',  label: 'Mode',  type: 'select', options: ['a','b'], default: 'a' },
  { key: 'label', label: 'Label', type: 'text',   default: '' },
]
```
Changes fire `onEditorUpdate` — `position/rotation/scale/custom` already applied by `ServerHandlers` before the hook fires.

---

## VRM / Animation

- **VRM model scale pipeline**: `modelScale` (default 1.323) on `vrm.scene.scale`. `feetOffset` ratio (0.212) × modelScale = negative Y offset. `userData.feetOffset = 1.3` hardcoded for client-side offset. Mismatching any of these misaligns model with physics capsule.
- **Animation library**: `preloadAnimationLibrary(loader)` — fire-and-forget in `initAssets`, requires the main gltfLoader (server Draco-compresses anim-lib.glb). `loadAnimationLibrary(vrmVersion, vrmHumanoid)` awaits preload, returns `{ normalizedClips, rawClips }`.
- **Locomotion hysteresis**: idle-to-walk: 0.8, walk-to-idle: 0.3. Locomotion cooldown: 0.3s. Air grace period: 0.15s before jump detection.
- **Track filtering**: `filterValidClipTracks()` removes bone references missing from target VRM before `mixer.clipAction()`. Without it, THREE.js PropertyBinding throws errors for every invalid track.

## AFAN Webcam Live Streaming

Opt-in face tracking streaming ARKit blendshape weights from webcam to nearby players' VRM morph targets.

- **Format**: `Uint8Array(52)` — one byte per ARKit blendshape (see `ARKIT_NAMES` in `client/webcam-afan.js`). Each byte = weight x 255. ~1.5 KB/s per sender at 30Hz.
- **Lazy load**: `client/webcam-afan.js` NOT imported by `client/app.js` — loaded only via `window.enableWebcamAFAN()`.
- **Face tracking**: MediaPipe FaceMesh (`@mediapipe/face_mesh@0.4`, CDN) loaded lazily in `WebcamAFANTracker.init()`. Falls back to demo data if MediaPipe fails.
- **Network path**: client -> `afan_frame` -> `webcam-avatar` app -> nearby players (30-unit radius) -> `onAppEvent` -> `applyAfanFrame()` in `client/PlayerManager.js` -> `FacialAnimationPlayer.applyFrame()`.
- **Server delivery**: `ctx.players.send()` per-player, not broadcast. Message: `{ playerId, data: number[] }`.

## LagCompensator

Fixed 128-slot ring buffer. Entries pruned by timestamp (500ms window). Pre-allocated entries avoid GC.

`ctx.lagCompensator.getPlayerStateAtTime(playerId, millisAgo)` — exposed on `AppContext.js`. Hit detection pattern: client sends `clientTime: Date.now()` in fire message. Server: `latencyMs = Math.min(600, Date.now() - msg.clientTime)`, then rewinds target position. 600ms cap prevents abuse.

## Three.js Settings

- `THREE.Cache.enabled = true`
- `matrixAutoUpdate = false` on all static environment meshes
- `material.shadowSide = THREE.DoubleSide` on environment meshes — prevents bright corner-line seam artifacts. Use `DoubleSide`, NOT `BackSide`.
- `PCFSoftShadowMap` — `VSMShadowMap` causes blurred cutout artifacts.
- BVH via `three-mesh-bvh` vendored at `client/vendor/three-mesh-bvh.module.js` (NOT npm/CDN). Camera raycast at 20Hz; cached clip distance between raycasts. Without BVH: ~65% of frame CPU in FPS mode.

## Loading Screen Gate

`checkAllLoaded()` gates on all four simultaneously: `assetsLoaded`, `environmentLoaded`, `firstSnapshotReceived`, `firstSnapshotEntityPending.size === 0`. Then `warmupShaders()` runs async.

## Client Loading Pipeline Optimizations (2026-03-19)

**warmupShaders** (`client/SceneSetup.js`): replaced per-mesh loop (N × compileAsync + render + RAF) with a single pass — disable `frustumCulled` on everything, one `compileAsync(scene, camera)`, two renders, restore. Session key bumped to `shader-warmup-v2` to invalidate old warm-cache entries. Improvement: O(N) GPU submits → O(1).

**ModelCache stale-while-revalidate** (`client/ModelCache.js`): when a cached entry exists, return the cached buffer immediately and fire the HEAD revalidation in the background. Eliminates the HEAD RTT from the critical path on all warm-cache loads. Cache misses go straight to GET with no HEAD round-trip.

**IndexedDBStore in-flight dedup** (`client/IndexedDBStore.js`): `openStore` now caches the Promise itself (not the resolved IDBDatabase). Concurrent calls for the same store key share one `indexedDB.open()` call. On rejection, the cached promise is deleted so retries work.

**AnimationClipCache ArrayBuffer serialization** (`client/AnimationClipCache.js`): `serializeClip` now stores `track.times.buffer.slice(...)` and `track.values.buffer.slice(...)` (ArrayBuffer) instead of `Array.from(Float32Array)`. IndexedDB structured clone handles ArrayBuffer natively. Measured: 27x faster per track (44.9μs → 1.7μs for 1000-element Float32Array). DB_VERSION bumped to 3. `deserializeClip` reconstructs `Float32Array` from stored ArrayBuffer.

**EntityLoader concurrency** (`client/EntityLoader.js`): `MAX_CONCURRENT_LOADS` split into `MAX_CONCURRENT_LOADS_INITIAL = 4` (during loading screen) and `MAX_CONCURRENT_LOADS_RUNTIME = 3` (after). Initial load now saturates all 4 Draco workers instead of leaving one idle.

## Client Jitter Gotchas

- **Spawn point Y**: keep low (Y~5) — spawning high causes fall jitter on join.
- **Velocity extrapolation**: `SmoothInterpolation.getDisplayState()` adds `position += velocity * dt`. Without this, movement appears jittery at 128 TPS.
- **Rotation interpolation**: quaternion SLERP, not linear lerp.
- **RTT measurement**: uses snapshot `serverTime` field, not heartbeat ping (heartbeat gives ~500ms on localhost; snapshot gives <20ms).
