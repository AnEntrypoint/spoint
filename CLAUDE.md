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
- Maps: `apps/maps/*.glb` (Draco-compressed at source; CI strips Draco before deploy via `scripts/optimize-models.js`)

## Renderer

`createRenderer(isMobile)` in `client/SceneSetup.js` returns a `THREE.WebGLRenderer` (synchronous). No WebGPU — it was removed due to persistent GPU OOM crashes across browsers.

**Shadow maps**: `renderer.shadowMap.type` is `THREE.PCFShadowMap` (`PCFSoftShadowMap` was deprecated in Three.js 0.183). `shadow.radius` and `shadow.blurSamples` are set for soft shadow quality.

**Pixel ratio**: Mobile uses `devicePixelRatio * 0.5`, desktop uses native `devicePixelRatio`. No cap.

**Loaders**: `createLoaders(renderer)` returns `{ gltfLoader, dracoLoader, ktx2Loader }`. Single `gltfLoader` used for both map and entity loading. `THREE.Cache.enabled = true`. Draco workers = 4 with `preload()`.

**Shader warmup**: `warmupShaders` disables `frustumCulled` on all objects, makes all hidden objects visible, calls `compileAsync` once for the whole scene with the real camera, then renders twice (with shadow map update). Restores culling/visibility after. Cached in `localStorage` by entity count + sorted IDs to skip on reload when scene is unchanged.

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

`GLBTransformer.js` (orchestrator) + `GLBDraco.js` (`hasDraco`, `applyDraco`) + `GLBKtx2.js` (`imageToKtx2`, `encodeMode`, `applyKtx2`) in `src/static/`. Applies Draco + KTX2 texture conversion, serves original immediately, caches to `.glb-cache/`.

- **Draco is skipped for VRM** — gltf-transform's NodeIO strips unknown extensions (`VRM`, `VRMC_vrm`). Detected via `json.extensions?.VRM || json.extensions?.VRMC_vrm`.
- **WebP-to-KTX2**: builds `imageSlotHints` from material slots (normalTexture → `uastc`, others → `basis-lz`). Draco runs first, only kept if smaller.
- `prewarm()` scans `.vrm` files in addition to `.glb`.

**KTX binary auto-discovery**: `imageToKtx2` searches `bin/ktx.exe` (Windows bundled), `bin/ktx` (Linux/Mac bundled), `/usr/bin/ktx`, `/usr/local/bin/ktx` in order. When no binary is found, falls back to PNG downscale (≤1024px via `sharp`) instead of failing — GPU VRAM is still reduced proportionally. Return type is `{ buf, mimeType }` where mimeType is `'image/ktx2'` or `'image/png'`. `KHR_texture_basisu` extension is only injected into GLTF JSON when actual KTX2 was produced.

**`prewarm()` blocks server start**: `boot()` in `server.js` now `await`s `prewarm()` before calling `server.start()`. All clients receive GPU-optimized models — no first-client penalty. Uses `Promise.allSettled()` over all in-flight transform promises; never times out.

### Draco OOM Fix (Build-Time Stripping)

**Root cause**: Large Draco-compressed GLBs (e.g. `aim_sillos.glb`) decompress to ~1.5GB in the JS heap during Three.js `GLTFLoader.parse()`. The `_parsedGltfCache` held a permanent reference, causing 300MB/s heap growth and OOM crashes before the session ended.

**Runtime mitigation**: `EntityLoader.js` implements `_parsedGltfRefCount` cache eviction — once all meshes from a GLB are instantiated, the parsed GLTF object is released from cache. This reduces peak persistent memory but does NOT prevent the during-parse OOM spike.

**Build-time fix (gh-pages)**: `scripts/optimize-models.js` strips Draco at CI time. Uses `NodeIO.registerDependencies({'draco3d.decoder': decoderModule, 'draco3d.encoder': encoderModule})` — NOT `KHRDracoMeshCompression.withConfig` (that method does not exist in @gltf-transform v4 and throws silently swallowed by `|| true` in CI). After `io.readBinary`, dispose the `KHR_draco_mesh_compression` extension object from `doc.getRoot().listExtensionsUsed()` before `io.writeBinary` — otherwise gltf-transform re-encodes with Draco. Textures with no `source` field (EXT_texture_webp-only) must be patched to `source: 0` before read or gltf-transform crashes on null sampler lookup. Draco stripping must happen before texture rewrite — bufferView indices change after Draco strip.

**Server-side VRAM optimization (live server)**: `GLBTransformer.js` applies KTX2 + Draco at request time for models served to connected clients. This is separate from the build-time optimizer and handles runtime model loading.

### Build-Time Model Optimizer (GitHub Pages / Static Hosting)

`scripts/optimize-models.js` — standalone build-time optimizer for environments without a server (GitHub Pages). Run during CI via `.github/workflows/gh-pages.yml` before the deploy step.

- Downscales textures >256px in-place using `sharp`, preserving aspect ratio (`fit: 'inside', withoutEnlargement: true`)
- Strips Draco mesh compression using gltf-transform `NodeIO` + `KHRDracoMeshCompression` — prevents Three.js parse OOM
- Accepts directories (recursive) and individual `.glb`/`.vrm` files as positional arguments
- Rewrites GLB binary in-place: patches bufferView offsets, updates mimeTypes, strips `EXT_texture_webp`
- Returns `null` (no write) when already optimized — safe to run unconditionally
- CI step: `node scripts/optimize-models.js dist/apps dist/anim-lib.glb || true`

### Invisible/Trigger Material Filtering

`extractAllMeshesFromGLBAsync` skips primitives with material names in `SKIP_MATS`: `aaatrigger`, `{invisible`, `playerclip`, `clip`, `nodraw`, `toolsclip`, `toolsplayerclip`, `toolsnodraw`, `toolsskybox`, `toolstrigger`. Without this, CS:GO maps have phantom collision walls. Client-side: `loadEntityModel` sets `c.visible = false` for the same names.

### IndexedDB Model Cache

`client/ModelCache.js` caches GLB/VRM ArrayBuffers in IndexedDB keyed by URL. HEAD request checks ETag on repeat loads; 304 returns cache; miss fetches full GET. When gzip is present, `content-length` is NOT used as progress denominator (it's the compressed size, not decompressed).

**LRU eviction**: `lru-manifest` entry in the same IndexedDB store tracks `{ url, size, lastAccess }` per entry. On every cache store or hit, the manifest is updated. After each store, entries exceeding 200MB total are pruned oldest-first until under 150MB. Size estimated from `buffer.byteLength`.

### Client-Side Geometry Cache

`client/GeometryCache.js` — two caches sharing IndexedDB store `geometry-cache`:

**Draco decompression cache** (`getGeometry` / `storeGeometry`): After `gltfLoader.parseAsync()` on a GLB with `KHR_draco_mesh_compression`, non-skinned mesh geometries are serialized (attributes as ArrayBuffers, index, drawRange, material props) and stored keyed by URL. On next load with same ETag (ModelCache validates freshness before returning the buffer), `getGeometry(url)` returns the cached descriptors and `reconstructGeometry(d)` rebuilds `THREE.BufferGeometry` from them — Draco WASM decompression is skipped entirely.

**LOD index cache** (`getLodIndex` / `storeLodIndex`): After MeshoptSimplifier produces a simplified index buffer in `_simplifyObject`, it is stored keyed by `url:lod0` or `url:lod1`. On next load, `_scheduleLodUpgrades` checks for cached indices before calling `MeshoptSimplifier.simplify`. `url` is carried via `model.userData.url` set at parse time and passed through `_generateLODEager` → `_lodUpgradeQueue` entries.

### Shader Warmup Persistence

`warmupShaders` in `client/SceneSetup.js` stores `lastShaderWarmupKey` in `localStorage` (was `sessionStorage`). The scene key includes entity count and ID hash — same world across browser sessions skips re-compilation.

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
- **Entity load concurrency**: `MAX_CONCURRENT_LOADS_INITIAL=4`, `MAX_CONCURRENT_LOADS_RUNTIME=3` — reduced from 8/4 to halve peak GLTF parse memory during initial load window.
- **Draco worker preload**: `dracoLoader.preload()` called immediately in `createLoaders()` — starts worker pool + WASM init at page load instead of paying that cost on first entity decode.
- **RippleUI non-blocking**: CDN stylesheet loaded with `media="print" onload="this.media='all'"` — never render-blocks first paint.
- **All imports vendored locally** (`index.html` importmap): three@0.183, three/addons/, @pixiv/three-vrm, webjsx, msgpackr all served from `/node_modules/` at localhost. Eliminates 500ms–1700ms CDN round-trips per module. `<link rel="modulepreload">` for 9 critical modules fires parallel fetches before `app.js` parses. Combined: cold load 34–36s → 22s (36% faster). `@pixiv/three-vrm` added as a real `package.json` dependency (was CDN-only).
- **`firstSnapshotEntityPending` only tracks dynamic entities**: static entities (map, environment props) no longer block the loading screen gate. `bodyType==='dynamic'` filter means only moving/interactive entities are waited for. A 5-second timeout (`_entityLoadTimeout`) clears the set as a safety net so no entity load failure can block the game forever.
- **`fitShadowFrustum` reuses Box3 instances**: `_fitBox3` and `_fitMeshBox` are module-level singletons. Replaces `box.expandByObject(o)` (which does internal sub-traverse per mesh) with direct `geometry.computeBoundingBox()` + `Box3.copy().applyMatrix4()` — O(N) single pass with zero allocation.
- **AnimationLibrary clip extraction memory**: `_gltfPromise = null` after `_normalizeClips()` completes — releases the full GLTF scene graph (geometry, bones, scene nodes) once clips are extracted, freeing ~5–10MB.
- **EntityLoader `_animatedEntities` tracks `finalMesh`**: push `finalMesh` (the THREE.LOD wrapper when `_generateLODEager` runs), not `model`. `removeEntity` looks up via `entityMeshes` which stores `finalMesh` — `indexOf` must match or the animator leaks.
- **VRM recreate orphan prevention**: `scene.remove(g)` on the existing Group before `playerMeshes.delete` and `recreatePlayerVRM` — prevents empty Group nodes accumulating in the scene when VRM assets reload.

### Client Loading Pipeline (2026-03-19)

**Critical path**: `checkAllLoaded` gates on four simultaneous conditions: `assetsLoaded` (VRM + animation library), `environmentLoaded` (first entity mesh ready), `firstSnapshotReceived` (WebSocket snapshot), `firstSnapshotEntityPending.size === 0` (all entities in first snapshot loaded).

**`initAssets` parallel pattern**: `_readVrmVersion(buffer)` extracts VRM version from GLB binary header immediately. `loadAnimationLibrary(vrmVersion)` fires concurrently with VRM cache validation — `animPromise` resolves in parallel with the VRM `dbDelete/fetch` edge case path. `preloadAnimationLibrary(gltfLoader)` fires at the start of `initAssets`, so `anim-lib.glb` is fetched in parallel with the VRM download.

**Singleplayer OOM (intermittent, cache-dependent)**: On animation cache miss (`anim-lib-v1` key absent from IndexedDB), `normalizeClips` + `cacheClips` previously ran concurrently with VRM parse and up to 8 simultaneous entity GLTF parses — heap reached 3GB → OOM. Cache warm path (subsequent loads) was fast → no OOM, explaining why it worked most of the time but crashed after storage clear or first visit. Fixes: (1) `rawClips` no longer holds original GLTF animation object references — GLTF binary can be GC'd immediately after normalization; (2) `cacheClips` is now `await`ed so IndexedDB serialization completes before VRM parse begins; (3) entity loading in `app.js` is gated on `assetsLoaded` — entity GLTFs cannot overlap with VRM+animation loading; (4) `MAX_CONCURRENT_LOADS_INITIAL` reduced 8→4. To test cold path: DevTools → Application → IndexedDB → delete `spawnpoint-anim-cache` → reload.

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

## Editor DX

**Editor shell** (`client/EditorShell.js`): Full-screen fixed overlay. Exports `createEditPanel` with identical API — app.js only needed a one-line import change. Layout: left sidebar 250px (scene hierarchy), right sidebar 300px (Inspector/Apps/HookFlow/Events tabs), top bar 40px (creation toolbar + snap controls), bottom bar 24px (status + key hints). Center area uses `pointer-events:none` so THREE.js canvas events pass through. All panels use glassmorphism: `rgba(5,12,10,0.82) + backdrop-filter:blur(18px)` — `GLASS` constant at top of file.

**Scene hierarchy** (`client/SceneHierarchy.js`): webjsx-based entity tree. Filters by `id`/`_appName`. Closure state. Emerald selection: `rgba(16,185,129,0.14)` bg, `#a7f3d0` text. `updateEntities(ents)` re-renders via `applyDiff`.

**Inspector panel** (`client/EditorInspector.js`): Direct DOM manipulation (not webjsx) to avoid re-render conflicts during drag-input mouse drags. Reuses `drag/v3/propField` from `EditPanelDOM.js`. Fully rebuilds DOM on `showEntity(entity, eProps)` call.

**Apps panel** (`client/EditorApps.js`): Apps list + Monaco editor. Calls `renderEditorPane` from `EditPanelEditor.js` when a file is open. `openCode(app,file,code)` switches to editor view.

**HookFlow viewer** (`client/HookFlowViewer.js`): SVG-based entity-app node graph. Pan via background drag, zoom via wheel. Nodes rendered as raw SVG string via `dangerouslySetInnerHTML` on the `<g>` transform wrapper inside the SVG element. `applyDiff` manages the outer SVG container only.

**Event log panel** (`client/EditorEventLog.js`): Live server event table (tick/type/entity/app columns). Polls `MSG.EVENT_LOG_QUERY (0x90)` every 2s when Events tab is active; stops on tab switch or panel hide. `EditorHandlers.js` responds with last 60 events from `ctx.eventLog`. Empty in singleplayer (server not present). Auto-scrolls unless user scrolled up.

**Gizmo modes** (`client/editor.js`): `[G]` translate, `[R]` rotate, `[S]` scale. `[F]` focus, `[Del]` destroy. Mode in `_gizmoMode`. Mouseup sends `EDITOR_UPDATE`. `setSnap(enabled, size)` (module-level export) quantizes translate positions when active — `_snapEnabled`/`_snapSize` are module-level so EditorShell can call `setSnap` directly via `onSnapChange` callback. `onTransformCommit(cb)` fires `{entityId, before, after, kind}` on every gizmo mouseup — used by app.js undo/redo.

**Snap grid** (top bar): SNAP toggle pill + 6 size presets (0.1/0.25/0.5/1.0/2.0/5.0). Snap state (`_snapOn`/`_snapSz`) lives inside `_buildTopBar` closure — survives tab switches. `onSnapChange` callback prop wires EditorShell → app.js → `editor.setSnap()`.

**Undo/redo** (`app.js`): `_undoStack`/`_redoStack` capped at 20. `Ctrl+Z` sends reverse `EDITOR_UPDATE` with `before` state; `Ctrl+Y`/`Ctrl+Shift+Z` resends `after`. Stack cleared when new transform committed. Before-state captured in `_dragBeforeState` at mousedown; after-state from mesh at mouseup.

**Monaco offline** (`client/EditPanelEditor.js`): Loaded from `/node_modules/monaco-editor/min/vs/loader.js`. Requires `monaco-editor` devDependency. Falls back to `<textarea>` on failure.
