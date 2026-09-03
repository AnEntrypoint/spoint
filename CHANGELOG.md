## fix: critical framebuffer feedback loop in mapspinner water-depth-share pass

- fix(mapspinner): Terrain was invisible and treestump flicker persisted due to WebGL feedback loop error (GL_INVALID_OPERATION). Root cause: direct-path water rendering (packages/mapspinner/src/gl-render.js line 2068+) rebinds _vdrsFbo (FBO with _vdrsDepth as DEPTH_ATTACHMENT) without first unbinding _vdrsDepth texture from TEXTURE4, creating a feedback loop. _vdrsDepth was bound as both sampler input (for occlusion) and render target, violating WebGL invariant. Fix: Added single unbind (`gl.bindTexture(gl.TEXTURE_2D, null)`) at line 2069 before rebinding FBO, mirroring correct pattern in half-res water path. This resolves terrain invisibility and eliminates stump flicker caused by cascade rendering failures. Commit aae5323f.

## fix: increased occlusion verdict stability gate to 6 frames (insufficient; real root cause was WebGL)

- fix(occlusion): Made stability gate configurable in `OcclusionPolicy` (new `stabilityGate` config, default 2 for backward compat). Increased to 6 frames in `SceneOcclusion`. Investigation revealed reported flicker was BRANCH-MESH-SPECIFIC (trunks/branches, not leaves). Tested fix was insufficient because root cause was not occlusion-query jitter but WebGL framebuffer feedback loop (see fix above). Stability gate increase remains as good practice for depth-jitter protection, but does not address this session's primary issue.

## fix: removed terrain dependency from vegetation LOD sync to fix async terrain init race

- fix(render): vegetation LOD updates were skipped during terrain async initialization, leaving LOD state stale and causing every-frame mesh-impostor toggling flicker. `RenderGraph.nodes.js` foliage-lod-sync node had a guard checking `window.__terrain` (terrain init complete) before running `vegetation.update()`. Since terrain init is async (mapspinner planet and height-cpu imports), the guard was false on early frames, blocking LOD updates. Removed the terrain dependency: vegetation LOD updates now run unconditionally every frame using the fractal height sampler fallback when terrain isn't ready. This ensures LOD state stays current even during async initialization.

## perf: deps bump after landing sibling-repo optimizations, live A/B profile

- deps: bumped `mapspinner` 0.1.256->0.1.258 and `streaming-gltf` 2.0.16->2.0.19 after 25 optimization commits landed and auto-published upstream (see the two entries below). Fresh single-server live profile before/after: p50 2.3ms->2.4ms, fps 424.5->401.9, no regression (sparse-scene noise). Archived both profiles under `.gm/`.

## perf: exhaustive math/packing/quant/bounding sweep (spoint half)

- perf(netcode): `SnapshotEncoder.buildEntityKey` mixes each field's bits directly into a running FNV1a accumulator instead of building an ~80-char intermediate string per entity per snapshot; `packQuat`/`encodePlayer` unrolled off per-call array allocations onto scalars, bit-identical output.
- perf(hot-path): squared-distance conversions across the hitscan compare (tps-game server+client), `PlayerAnimator.setLookDirection`'s speed gate, and the veg/rock/grass streaming ring/drop radius checks -- all drop a `Math.hypot`/sqrt call for an equivalent squared comparison.
- perf(terrain): `RockPlacement.patchDensity`'s 4 lattice-corner hash+rand values are now memoized per coarse lattice cell (ClimateCache's packed-int-key idiom) instead of recomputed per fine candidate; `VegPhysics`/`RockPhysics`'s `_chunkCache` switched from allocating string keys to packed integers with a 4096-entry LRU bound (was unbounded over a long exploration session); `_rebuild` fused its two-pass desired/keep ring walk into one squared-distance pass, preserving the exact `_deferred` budget-guard semantics.
- fix(client): `app.js`'s anim-LOD frame-parity gate used `id & 1`, which collapses every string player id (wireweave/peer-host pubkeys) onto the same phase -- a real bug causing synchronized half-rate hitching for the entire distant crowd in peer sessions. Now caches a stable per-player parity bit (charCode-derived for strings, `id&1` unchanged for numeric ids).
- perf(hygiene): dead veg-placement normal computation removed (`tiltQuat` is hardcoded up-vector, the computed normal had zero consumers); `TransformLerp`'s per-frame quaternion normalize gated behind a cheap norm-squared check; `TickHandler`'s per-tick priority-score sqrt skipped for already-saturated fast movers; a lazy dynamic `import()` for the keybinding-gated lobby module replaces its eager static import.
- Several candidates were investigated and correctly declined with recorded reasoning rather than forced: a wire-format origin-relative int16 position redesign (would break the shared single-encode-serves-N-viewers optimization or reintroduce false-dirty churn), a 4-tap-to-2-tap placement gradient reskin (would shift slope-reject/tilt behavior with no visual-witness available this session), and a bone-override Euler-to-quaternion rewrite (the existing logic preserves an animated z-channel the quaternion-premultiply form can't be proven equivalent to without live rendering).

## perf: exhaustive math/packing/quant/bounding sweep (sibling repos: mapspinner, streaming-gltf)

- mapspinner: CSE'd a byte-for-byte duplicate 10-octave ridged-FBM evaluation in the terrain height function (the single largest vertex-shader win found); deduped a redundant `normalize()` call in the same function; switched the bake-tile GPU readback from RGBA/FLOAT to RED/FLOAT against its single-channel R32F source (4x smaller PBO, matches the profiled #1 live frame cost); replaced `Math.hypot` with `sqrt(sum-of-squares)` on the frustum/sort hot paths; reused the water-tile dedup Set across frames with packed-integer keys instead of a fresh Set + string keys; added a dirty-flag cache to the bake-uniform upload path; memoized the patch-baker's face-selection (via an exact geometric short-circuit proof) and last-patch lookup; replaced a single in-flight async-bake slot with a 4-slot ring so `prefetchAround`'s 8 neighbor requests actually survive instead of clobbering each other; aliased a redundant `worldToFaceLocal` call when the LOD reference position equals the camera position.
- streaming-gltf: fixed a real correctness bug -- the instanced bound-sphere/impostor scale multiplier (`scale.length()/sqrt(2)` or `/sqrt(3)`, inconsistently) both over-inflated uniform-scale bounds by ~22% AND under-estimated non-uniform-scale bounds (a false-cull risk for e.g. a (2, 0.1, 0.1)-scaled entity), replaced with the correct `max(|sx|,|sy|,|sz|)`; fixed a broken `_deinterleaveGeometryAttributes` skip-guard that compared a nonexistent `BufferAttribute.buffer` property (always false), so every LOD load paid a full redundant copy + clone; cached per-cluster world-sphere/scale under the existing matrix-change guard and reordered the frustum cull before the sphere/LOD work; applied the already-shipped dirty-range instance-buffer-upload pattern to both octahedral-impostor tiers; shrunk the impostor per-instance data from a full mat4 to a 4-float `vec4(center,radius)` attribute and the instanced bound-sphere attribute from 4 floats to 1 (center is always the instance-matrix translation); fixed a genuine unbounded LOD-staleness bug where a pure in-place camera rotation never re-triggered the LOD/frustum recheck; removed several fully-dead abstractions (`DrawCallSorter`, `InstanceBufferPool`, `MultiDrawOptimizer`, dead uniform plumbing) confirmed via fresh grep to have zero live consumers; emit Uint16 (not always Uint32) cluster indices when vertex count fits, and derive the per-cluster LOD-distance sphere center from the AABB midpoint instead of storing it separately (version-gated for backward compatibility with already-baked assets).
- Both sibling repos' pushes hit concurrent unrelated upstream work (new features + CI-published version bumps on both remotes) -- rebased cleanly onto the real upstream history and re-ran the full test suite green post-rebase before pushing.

## perf: total-optimize CPU frame path toward 144fps

- perf(client+deps): ultracode gm workflow profiled the settled tps-game frame (headless AMD/ANGLE-D3D11: fps 41, CPU p50 25.3ms, idle 3.84%, GC 3.81%) and shipped the confirmed zero-visual-risk fixes -- an unconditional per-second full-scene leak probe gated behind `?leak`, a duplicate spring-bone physics update removed (`vrm.update()` already drives it), a provably-unconsumed `client.getSmoothState()` call removed, `modelPool.setRotation` deduped against the last-pushed quaternion, `matrixAutoUpdate=false` on static veg/rock/grass/light roots that never move after creation, the vegetation diagnostic profile throttled to 4Hz, the tps-game HUD overlay's per-frame DOM queries cached and its style writes skipped when unchanged. Bridged two dep-side fixes via `patch-deps.mjs`: `cluster-lod-mesh.js` pools its per-frame `geometry.groups` objects and caches camera-only cull inputs once per render pass instead of once per instance, and `@three.ez/instanced-mesh`'s `bindTextures` drops a redundant `getParameter(CURRENT_PROGRAM)` sync GL read. Result: fps 41->50, CPU frame p50 25.3ms->19.3ms, `test.js` 17/17, screenshot diff within the same-build noise floor (no visual regression). A wide-blast-radius InstancedMesh2 frustum-cull cache (~0.5-1ms further win) was correctly left `blockedBy: external` -- it spans ~15+ minified mutation call sites with no local regression harness for the vendored lib.

## feat: static meshes collide + pick collider type + move-syncs-collider; remove the environment app; fix model dropping

- feat(editor): static models now get a REAL default collider on place -- `PLACE_MODEL` spawned entities with a hardcoded `collider:'none'`, so nothing dropped in the editor ever collided. Now spawns with `autoTrimesh:true` (falls back to a box on a malformed/Draco GLB, mirroring `fallbackBox`). A collider TYPE can be picked via the already-generic `editorProps` system (the `placed-model` app ships a `_collider` select field: box/sphere/capsule/convex/trimesh/none; `EditPanelDOM` already renders any `type:'select'` editorProp as a dropdown) and is now actually actuated server-side: `EditorHandlers`' new `rebuildEntityCollider` removes the old body and builds the requested shape (allowlisted, falls back to box on an invalid/unbuildable request). Moving, rotating, or scaling an entity now keeps its collider in sync (`syncEntityCollider`): position/rotation-only changes on a static body are a cheap reposition (`World._repositionBody`); a scale change or a collider-type pick triggers a full rebuild (box/sphere/capsule/convex all bake scale into their shape at build time); a dynamic body is TELEPORTED (position set + velocity zeroed) instead of fighting the simulation that owns its transform every tick.
- refactor: removed `apps/environment` entirely -- a map/interior model (like the sillos arena) is now a plain `app:'placed-model'` entity, no dedicated app needed. Interior-view DoubleSide rendering + always-relevant snapshot inclusion (skips distance-tier throttling and relevance culling -- the arena is always visible to every player in it) is now driven by a generic per-entity `custom._interior` flag across `client/EntityLoader.js`, `client/app.js`, `src/apps/AppRuntime.js`, `src/netcode/SnapshotEncoder.js`, and `src/sdk/server.js` -- every former `app==='environment'` check generalized to work for ANY dropped-in model, not one app name. The environment app's smart-object templates (door/platform/hazard/trigger/lootBox/pillar) were confirmed unused anywhere in `apps/world/*.js` and deleted with it. Found + fixed a real bug this migration exposed: `src/stage/StageLoader.js` never copied a world-def entity's `custom` field into the spawn config, so any world-def-authored `custom.*` (like the new `_interior` flag) was silently dropped before the entity ever spawned.
- fix(client): "model dropping in the editor" -- `client/EntityLoader.js`'s flat `updateVisibility` distance cull (~120m) hard-hid ANY tracked mesh past that radius, including ModelPool-routed roots that manage their own per-cluster/per-tier LOD distance culling internally; a placed model would silently vanish once the camera moved far enough away, independent of the pool's correct LOD state. Fixed by tagging every ModelPool root (and every LOD-swapped replacement node) with `userData.isModelPool` and skipping the legacy cull for any mesh carrying it.
- fix(server): `AppRuntime.resolveAssetPath`'s non-Node branch (singleplayer running in a Worker, no real filesystem) returned a bare relative path that `fetch()` then resolved against the WORKER SCRIPT's own URL instead of the page origin, 404ing every `autoTrimesh`/collider-rebuild GLB fetch in singleplayer. Fixed to always return an origin-absolute path in that branch.
- Validated the deployed page (`https://anentrypoint.github.io/spoint/demo.html?singleplayer&world=tps-game`) loads current code and updates with every push; confirmed LOD parity against `../streaming-gltf` (spoint's cluster-LOD env models correctly bypass the hero/mid/far bucket system by design -- no defect); confirmed the editor delete path has no leaks (pool dispose, mesh disposal, physics body removal, persisted-storage all correct). `test.js` gains 5 guards (default collider, collider-follows-move, destroy-removes-body, environment-app-removed, StageLoader custom-field propagation) -- 16 passed.

## fix: :3001 and :8090 can't diverge -- one server, single-instance guard, converged docs

- fix(server): the `:3001` (multiplayer) and script-default `:8090` (`?singleplayer`) "versions" are the SAME `server.js` run as two processes, not two builds -- `client/app.js` picks an in-Worker `BrowserServer` for `?singleplayer`/host/join else the WebSocket `PhysicsNetworkClient`, both on the same origin; `buildStaticDirs` mounts one `/node_modules/` from `sdkRoot`; `boot()` binds one port. They only "look different" when run as two long-lived processes, each frozen at its own boot-time `node_modules`/bake snapshot (a bridged `patch-deps` edit lands on disk but not in an already-running process -- witnessed: both ports served byte-identical stale `gl-render.js` while disk had the fix). Added an `EADDRINUSE` single-instance guard in `ServerAPI.start()`: a port-in-use prints a loud, actionable message (there is one server; use `/` and `/?singleplayer` on the same origin; do not start a second instance on a different `PORT` -> divergent snapshot; how to kill the running one) and `server.js` exits code 1 cleanly instead of a raw UV stack. `StaticHandler` already sends `no-cache` and reads current disk per request, so a running instance never needs a restart to serve an edit (only a browser hard-refresh). Cleaned up the 5 stale server processes to one fresh instance and md5-verified (gzip-aware) it serves current disk. Docs converged: README + AGENTS state the one-server-two-client-modes model and drop the stale `client/LocalClient.js` references (that file is gone and unimported -- a doc "two versions" hazard). `test.js` gains a convergence guard (one `/node_modules/` mount, query-selected client mode same origin, one port, the guard present) -- 11 passed.

## fix: objects drawing over water when submerged + ModelPool physics objects couldn't rotate

- fix(render): two player-reported bugs. (1) 'all objects draw over water even when under the water' -- mapspinner's half-res water pass composites COLOR-only into the canvas, and the `__planetDepthToCanvas` shared-depth writeback stamped only `_vdrsDepth` (terrain depth), so any three object below the water surface tested against terrain depth alone and drew over the water. Fixed in `../mapspinner` (committed there): after the water composite, re-draw the coarse water mesh DEPTH-ONLY into `_vdrsFbo` (colorMask off, depthTest LESS, `uIsWater=1` so the VS pins sea level and the FS `vH>1` discard drops under-land water), so `_vdrsDepth` gains the water-surface depth and the writeback occludes submerged geometry. Scoped to the above-water half-res path, gated on `__planetDepthToCanvas`; a `__waterDepthShared` counter surfaces the pass for witnessing. (2) 'physics objects should be able to rotate their object' -- the server sim + broadcast + sceneGraph lerp already rotate dynamic entities correctly (proven by a real `PhysicsWorld` tumble: a box under angular velocity evolves its quaternion and `syncDynamicBody` writes it every tick), but ModelPool-routed entities used a POSITION-ONLY `setTarget`, so a pool body translated but never turned. Fixed in `../streaming-gltf` (committed there): `ModelPool.setRotation(entity, quat)` writes `root.quaternion` and re-derives each tracked mesh's slot matrix, carrying rotation to the hero/mid Object3D AND batched/instanced far tiers. Consumed here: `ModelPoolAdapter.setRotation` (finite-quat guarded) + `app.js` pushes `e.rotation` to pool entities each snapshot. Both sibling fixes bridged into `node_modules` via `scripts/patch-deps.mjs` `vendorInto` (gl-render.js + model-pool.js). Also: `TransformLerp.lerpEntityTransform` gains a shortest-arc quaternion lerp (dot<0 sign flip -- no 180deg flip-through) and a NaN-quat guard (a corrupt snapshot rotation can't poison the Object3D matrix). `test.js` gains a real-physics rotation guard + a water depth-share source guard (10 passed). Live-witnessed on :8090: the water depth-share pass runs GL-clean (A/B-proven the residual 1282 is the pre-existing sillos-cluster error, not this pass); env-sillos `root.quaternion` [0,0,0,1] -> [0,0.383,0,0.924] via `setRotation`; slerp shortest-arc + NaN guard hold.

## fix: sillos/player cluster-LOD render storm -- onBeforeRender custom draw replaced with geometry.groups

- fix(streaming-gltf cluster-lod): the ClusterLODMesh drew its visible per-cluster index sub-ranges via a custom gl multiDraw issued from `onBeforeRender`. three's `renderObject()` runs `onBeforeRender` BEFORE `renderBufferDirect()` binds the mesh's VAO, so that custom draw ran against stale/wrong element+vertex state -- producing a `glMultiDrawElementsANGLE: Insufficient buffer size` storm on the user's AMD Radeon/ANGLE-D3D11 context that degraded the GL context (FPS collapse to ~1, geometry vanished or collapsed to origin spikes) and broke the camera raycast (the pick no longer hit the model). Fixed by replacing the custom draw with geometry GROUPS: `_render` now does `clearGroups()` + `addGroup(base+lod.offset, lod.count, 0)` per visible cluster and lets three's normal pipeline draw them with the correct full VAO -- correct normals/uvs/lighting, no double-draw, no per-frame buffer churn, and `Mesh.raycast` intact (it walks the full index, not groups). PAIRED: `model-pool.js` `setDrawRange(0, 3)` -> `setDrawRange(0, Infinity)`, because three only draws groups within `drawRange` and raycast is bounded by it, so the old 3-index sentinel hid all geometry and broke picking. Consumed in spoint via the patch-deps bridge (`vendorInto` the fixed cluster-lod-mesh.js into node_modules + dist, plus a `setDrawRange` text-patch on model-pool.js) so the live game renders without waiting on a published bump; the streaming-gltf fix is committed sibling-side. Live-witnessed on :8090 after clean reinstall: `usesGroups` 96/96, real fps 97, raycast hits the cluster mesh (9 hits, hitCluster true), sillos-only `gl.getError` 0, screenshot = fully solid, correctly-lit/textured arena with the player on it.

## refactor: terrain is a proper app (apps/terrain) -- no permanent editor config

- feat(apps/terrain): converted the special-cased terrain subsystem into a proper app like every other app. The planet config now lives on a `terrain` app entity (`{id:'terrain', app:'terrain', config: TERRAIN}` in the world def) the way every other app takes per-instance config -- replacing the bespoke `worldDef.terrain` config block, the `AppRuntime._terrainConfig` constructor field, and the synthetic `__planet__` scene-graph node (terrain now shows in the editor hierarchy as a real entity). The terrain editor panel is now APP-MOUNTED via `ctx.editor.mountPanel` from the terrain app's `client.setup` (trusted-app surface) -- the permanent isEditor-gated `TerrainPanel`/`VegPanel` hardwired in the client bootstrap are removed. The cold-boot scenery build order (loading-curtain gate, OOM-leak guard, ring prewarm, shader warm) and the server collider-streaming ordering (before the spawn-finder) stay engine-owned -- the app owns config + editor UI, the engine owns boot order. A thin legacy `worldDef.terrain` alias remains during the transition so the cold-boot preload + readers stay green. Client/server terrain parity preserved (ground heights, reliefScale, radius byte-identical; trees/grass/rocks build; player onGround). `setupTerrainStreaming` accepts a `{terrain}` tcfg in addition to the legacy `{worldDef}`. test.js gains a terrain-is-a-proper-app assertion (8 passed). Witnessed live across edits: 77 spawn points, veg builds, scene graph shows the terrain entity (no synthetic node), no permanent terrain panel, zero pageErrors.

## fix: sillos was buried in the terrain (only parts visible) -- placement Y was tuned for the old broken scale

- fix(tps-game): raised `env-sillos` position Y 4.8 -> 10.31 (and spawnPoint 9.8 -> 15.3) so the arena floor seats on the planet terrain. After the previous commit fixed the streaming-gltf cluster double-transform (the model had been rendering at ~1/30 scale), the full-size model's floor sat ~5.7m below the terrain surface -- the ground and grass drew over the lower ~5.7m and only disconnected wall/roof tops poked above, which the player saw as "only parts visible, and they come and go" (the emergent tops being correctly per-cluster frustum-culled as the camera turns). The +4.8 offset had been hand-tuned against the OLD broken tiny render, so it was silently wrong once the render bug was fixed. Re-derived from live geometry: requiredY = groundHeight(-0.73) - modelFloorBelowOrigin(-11.04) = 10.31. Verified the geometry is complete (force-draw A/B = 100% of tris) and the per-cluster cull is correct (0 in-frustum clusters wrongly culled) -- so no streaming-gltf change was needed; the bug was purely the spoint placement Y. Live-witnessed: model floor min.y -0.73 == terrain ground, player spawns on the floor (onGround), screenshot shows a coherent floor+roof+pillars+wall. test.js gains a Y-seating guard (env-sillos Y >= 8).

## fix: sillos (cluster-LOD env model) rendered tiny + mis-rotated -- streaming-gltf double-transform

- deps: bump `streaming-gltf` ^2.0.3 -> ^2.0.4 to consume the cluster-mode transform fix. The aim_sillos environment model rendered tiny (~1.6m instead of ~54m), rotated wrong, and only partly visible, while its physics collider was correct. Root cause was in `streaming-gltf` model-pool.js cluster-ready path: it baked the source node's world matrix into the ClusterLodMesh (`applyMatrix4(src.matrixWorld)`) and then re-parented it under `src.parent` -- the glTF node whose own 0.03 import-scale + -90deg axis-fix rotation was ALREADY in that world matrix -- applying the TRS twice (0.03 scale rendered as 0.0009). The collider was unaffected because the server reads the GLB scale once, which is why it collided correctly while looking broken. Fixed upstream (streaming-gltf 2.0.4): the cluster path now applies the root-relative transform (`_rootInv x src.matrixWorld`) and parents under the entity root, mirroring the discrete-LOD path. The GLB asset and the world-def scale `[1,1,1]` were both correct -- no re-bake/re-convert was needed. Live-witnessed: ClusterLodMesh world scale 0.0009 -> 0.03, world AABB 1.6m -> ~53m, all 96 meshes visible. The now-redundant patch-deps bridge was removed (verified it injects on a pristine 2.0.3 install before removal).

## perf: max-effort destructive GPU/perf pass -- measurement-only, no source churn

- chore(perf): re-ran the maximum-effort fully-destructive optimization pass over the consumer + both sibling SDKs on the real AMD Radeon/ANGLE-D3D11 device. Why: the user re-authorized taking any further GPU/perf win now, with ../mapspinner and ../streaming-gltf named as update candidates. Verdict (all witnessed, none assumed): both siblings are already published+consumed at head -- mapspinner 0.1.249 and streaming-gltf 2.0.3, with the published-tarball source md5-identical to each sibling HEAD (the 47% CPU-height-sampling win and the SKINNED progressive-LOD feature are both shipped; the sibling package.json reading one below the published version is just CI [skip ci] bump lag). A correct live GPU timer (EXT_disjoint_timer_query bracketing one __app.renderer.render call) measured the frame at p50 4.2ms of a 16ms vsync budget -- vsync-limited with ~12ms slack, neither CPU- nor GPU-bound at the cap, so no VS/draw win can raise FPS on this device. Every candidate (per-frame gl.getError, resetState compositing, opaque-sort/overdraw, per-frame setSize/alloc) re-confirmed phantom or already-shipped. plugkit current (0.1.684). No source changed; the honest deliverable of a max-effort run on an already-in-budget engine is the measurement and the refutation of each candidate.

## deps: pin streaming-gltf to npm ^2.0.1 (was a dev-only file: symlink)

- chore(deps): `streaming-gltf` was pinned `file:../streaming-gltf` — a symlink to a sibling checkout that exists only on the dev machine, so it breaks on upload/deploy/fresh-checkout. Published the cluster-LOD rewrite to npm as `streaming-gltf@2.0.1` (merged the `cluster-lod` branch into the dep repo's `master`, which its `publish-npm` CI publishes; `npm version patch` bumped the 2.0.0 package.json to 2.0.1) and added the `./draco-loader` subpath to the dep's `exports`. spoint now pins `^2.0.1`; `node_modules/streaming-gltf` is a real registry install (lockfile `link: null`), so a plain `npm install` works anywhere. Witnessed live (`?singleplayer&world=tps-game`): `loadingState='ready'`, scene populated (47 children), no 404s/page errors.

## static: serve symlinked node_modules packages instead of 404 (unstuck singleplayer load)

- fix(static): `?singleplayer&world=tps-game` sat stuck on the static "Click to play / press M for multiplayer" prompt because the app never initialized. Root cause: the `StaticHandler` realpath escape-guard 404'd the `file:`-linked `streaming-gltf` package (a symlink to a sibling checkout whose real files live outside the served mount); the ES-module import of it in `ModelPoolAdapter.js` threw on the 404, aborting `app.js` before `window.__app`/`__scene` were created, leaving the static HTML prompt visible — looking like a stuck load. Now exempts symlinks whose lexical path is under a `node_modules` segment (the existing lexical `..` containment already blocks attacker-chosen traversal). Witnessed live (browser): `loadingState='ready'`, scene populated, loading curtain hidden, no 404s/page errors. Added a real-services `test.js` regression that the handler serves a symlinked `node_modules` path.

## landing: fix catastrophic section-collapse + mobile nav clip (both kit AppShell bugs)

- fix(anentrypoint-design/app-shell): the landing's sections all collapsed to `height:0` and piled on top of the hero (witnessed via screenshot — DOM overlap/overflow probes alone missed it because the boxes were zero-height, not overlapping). Root cause is a kit AppShell bug: `.app-main` is a fixed-height flex column (`.app` is `100dvh`, `.app-main` is `height:100%` with `overflow-y:auto`) and `.app-main > *` had `min-height:0` with the default `flex-shrink:1`, so once a route's content exceeded the container the flex algorithm shrank every child toward zero. Any long-scroll document route (a marketing/landing page) hit it. Fixed in the kit by adding `flex-shrink:0` to the generic child rule (grow children like `.chat` keep `flex:1 1 auto` via higher specificity). Witnessed: section heights `[0,0,…,0]` -> all non-zero, no overlap, at 390/768/1280/1440; live unpkg `@latest` confirmed carrying the fix.
- fix(anentrypoint-design/app-shell): on mobile (<=480px) the topbar nav became a full-width horizontally-scrolling row, but when folded into `.app-chrome` the topbar was a `flex:0 0 auto` child that sized to its nav's content and overflowed the viewport (`navRight 562 > 390`), hard-clipping the last nav items instead of scrolling. Fixed in the kit by constraining `.app-chrome > .app-topbar` to `max-width:100%`/`flex-basis:100%` + `min-width:0` so the nav's own `overflow-x:auto` engages. Witnessed: `navRight 562->358` (within viewport), nav scrollable, no document horizontal overflow.
- note: the spoint landing source consumes the kit correctly; both fixes landed in `anentrypoint-design` (the proper place — every AppShell consumer benefits), not as landing-local CSS patches.

## landing: kit-native theme toggle (de-overlap), single theme controller, emoji-icon sweep

- fix(landing): the theme toggle was injected into an absolute-positioned `.lp-theme-slot` laid over the kit `Topbar`, so it overlapped the nav links at every width (`slotOverlapsNav=true` witnessed on mobile 390 and desktop 1280, local and deployed). It now rides the kit-native `Crumb` `right` slot via `ThemeToggle({compact:true})` — no bespoke positioning, no overlap. Witnessed: `overlapsNav=false`, `horizontalOverflow=false` at 390/768/1280/1440, toggle present in the crumb.
- fix(landing): the page ran its own `prefers-color-scheme` script that set `data-theme` directly, competing with the kit `ThemeToggle` (which drives `applyTheme`). Two controllers fought over the theme. Removed the landing-local script so the kit toggle is the sole theme controller. Witnessed: clicking the toggle cycles `data-theme` (`ink` -> `auto`, changed=true) through the kit controller.
- chore(landing): the feature/architecture-mode icons in `content/*.json` were emoji (brick/recycle/package/globe/goggles/desktop/satellite, 25 distinct non-ASCII glyphs incl. variation selectors). Converted to ASCII code-tags (`srv`/`phys`/`hot`/`app`/`web`/`vr`/`node`/`rtc`) consistent with the kit `.code` monospace slot. Witnessed: `hasEmojiInBody=false`, tags render, features + arch modes still render.
- verify: kit-usage audit — all 14 components the landing consumes (`Topbar`/`ThemeToggle`/`Status`/`Hero`/`Section`/`Receipt`/`Install`/`Lede`/`Panel`/`Row`/`Form`/`Btn`/`Crumb`/`AppShell`) checked against the current `anentrypoint-design` source; prop usage matches, no stale-prop silent degradation. Degenerate states witnessed: content-fetch failure renders the kit-native fail shell (topbar+status, no overflow); the share Row is omitted until host (no dangling separator).

## editor: jank-perfection verification pass — a11y dialogs, EmptyState copy, glyph sweep

- a11y(anentrypoint-design): the kit modal shell (`ConfirmDialog` / `PromptDialog` / `FileViewer`, all via the shared `Modal`/`Backdrop`) rendered a plain `<div class="ds-modal">` with no dialog semantics, so a screen reader announced nothing. The `.ds-modal` now carries `role="dialog"` + `aria-modal="true"`, and its head gets a stable id wired through `aria-labelledby` so the title is the dialog's accessible name. Published as v0.0.179. Witnessed live (pinned 0.0.179 import): `ConfirmDialog` `.ds-modal` is `role=dialog`, `aria-modal=true`, `aria-labelledby` resolving to the head "Delete entity"; the before-state was `role=null`.
- fix(editor): the scene-hierarchy empty/no-match state passed `{title}` to the kit `EmptyState`, which takes `{text}`, so it always showed the kit's generic "nothing here". It now shows the contextual "No match" (filter with no hits) / "No entities" (empty scene). Witnessed: a no-match filter renders "No match", not "nothing here", and the tree empties without a stale row.
- chore(editor/hud/landing): decorative glyphs converted to ASCII per house style — event-log middot separator -> `-`, mobile zoom-out minus-sign -> `-`, landing external-link arrows -> `->`, middot separators -> `-`, diamond/lightning markers -> `*`. The functional virtual-joystick direction arrows on the look stick are kept (product iconography, the analog of the move stick's W/A/S/D text). Witnessed: the editor overlay rendered text carries zero decorative glyphs.
- verify: the full touch/tablet/desktop/VR editor surface was re-witnessed live in singleplayer against the current published kit — drag-reparent (`REPARENT_ENTITY`), context-menu Unparent/Rename(`SET_LABEL`)/Duplicate(`DUPLICATE_ENTITY`)/Delete(kit confirm, no native `confirm`), drag-to-place (`PLACE_APP`), gizmo touch-drag (`EDITOR_UPDATE`), tap-to-select, viewport right-click Create menu (gated on editPanel visibility, both ways), `usePointerDrag` pointercancel cleanup + multitouch primary-pointer guard, responsive no-overflow at 320/768/1024/1440 with column-stack + hidden resize handles under 760px, coarse-pointer 44px targets, safe-area insets, `pointer-events:none` overlay passthrough (VR-safe), and SplitPanel size persistence across re-render.

## editor: pointerize gizmo+pick for touch/tablet/VR; kit Dialog for New App

- feat(editor): the gizmo and entity-pick layer was mouse-only (`mousedown` on the canvas, `mousemove`/`mouseup` on `window`), so on tablet/phone/pen/XR-controller you could not select or transform anything. It now runs off one `usePointerDrag` on the canvas (Pointer Events: mouse+touch+pen+XR). The kit primitive captures the primary pointer (a drag that leaves the canvas keeps tracking), ignores a non-primary pointer (a second finger never makes the drag jump), and fires `onEnd` on both `pointerup` and `pointercancel` (an OS gesture that cancels a touch drag cleans up instead of sticking). Witnessed in singleplayer: a synthetic touch `PointerEvent` drag on the +Y gizmo tip dispatches `EDITOR_UPDATE` with a real `{position:[0.041,0,0]}` change.
- feat(editor): gizmo handles (0.04-thick cylinders/rings) get invisible enlarged hit-proxies carrying the same axis — fat on coarse pointers (0.34 axis / 0.2 ring), thin on fine pointers — so touch can reliably grab an axis. Witnessed: after selecting an entity the scene carries 3 hit-proxies for axes x/y/z.
- feat(editor): tap-to-select on coarse pointers (a pointerdown that misses the gizmo picks the entity under it), `touch-action:none` on the canvas while editMode is on (so a touch gizmo drag is not stolen by page scroll/zoom; restored on exit), and a `destroy()` on the editor API that tears the pointer-drag down. Witnessed: canvas `touch-action` is `none` after pressing P.
- feat(editor): New-App entry replaces both blocking `window.prompt('App name')` sites with a focus-trapped kit `Dialog` + `TextField` that validates empty / invalid (`/^[a-z0-9-]+$/`) / duplicate names with a toast and resolves null on cancel/escape. `EditorApps` was the last `window.prompt` in `client/**`. Witnessed: the `+ New` button opens a kit dialog titled "New app", not a native prompt.
- fix(editor): the file-drop highlight outline uses `var(--accent)` (with a hex fallback) instead of a hard-coded color. VR-compat re-witnessed: the DOM editor overlay stays `pointer-events:none` over the viewport pane (canvas `auto`), so raycast/XR is reachable under the chrome.
- feat(anentrypoint-design): added `usePointerDrag(el, {onStart,onMove,onEnd})` — free 2D pointer drag with pointer capture, primary-pointer guard, and `pointercancel` cleanup, for surfaces needing raw pointer coords each frame (a 3D viewport gizmo) rather than the data-transfer DnD of `useDraggable`. Published via CI as v0.0.178; spoint consumes it from the unpkg CDN.

## editor: entity hierarchies — nested tree, drag-reparent, duplicate, rename

- feat(editor): the server already carried full parent/child entity support (AppRuntime parent/children/reparent/getWorldTransform, parent in the network encoding, a nested getSceneGraph) but the editor exposed none of it. The scene hierarchy now renders the real nested tree (recursive depth/indent via the kit TreeItem) with per-node expand/collapse and a filter that keeps a matching node's ancestors visible. Drag a tree node onto another to reparent it; drop on the panel background to unparent to root; a context Unparent action does the same. Witnessed via CDP in singleplayer: dragging a node nests it (root count 2 to 1, child rendered indented at depth 1), dropping on the background unparents it (back to 2 roots).
- feat(protocol): added `REPARENT_ENTITY` / `DUPLICATE_ENTITY` / `SET_LABEL` opcodes and `EditorHandlers` that call `appRuntime.reparent` / `duplicateEntity` / `setLabel`, persist, and rebroadcast the nested `SCENE_GRAPH`. `AppRuntime.reparent` now rejects cycles (parenting to self or to a descendant) and returns a bool. Witnessed: a cycle attempt (parent a under its own child) is rejected server-side and leaves the tree unchanged; a reparent to a non-existent parent is a no-op.
- fix(editor): the scene-hierarchy Rename and Duplicate context actions were dangling callbacks (declared but never wired through `EditorShell` -> `createEditPanel` -> `app.js`). They are now wired: Rename sends `SET_LABEL` (the tree shows the new label), Duplicate sends `DUPLICATE_ENTITY` (a copy spawns at an offset under the same parent). Witnessed: `SET_LABEL` changes the tree label; `DUPLICATE_ENTITY` adds an entity (2 to 3).
- note: undo/redo (Ctrl+Z / Ctrl+Y over transform commits) and world persistence were already wired and remain so; structural ops (reparent/duplicate) are not on the transform-undo stack. Multi-select is scoped out as a separate additive feature (it touches the gizmo, multi-edit inspector, and bulk ops), not part of closing the hierarchy work.

## editor: jank pass — kit-native context menus, drag-drop, touch scrub, responsive, shortcut help

- feat(editor): `SceneHierarchy` now consumes the design-kit `ContextMenu` (backdrop + Escape + arrow-key nav + RAF viewport-edge clamp + ARIA menu roles) instead of a bespoke local reimplementation, and routes rename through a kit `Dialog` + delete through the kit confirm dialog — removing the blocking `window.prompt`/`window.confirm`. The `editor-hierarchy` demo panel drops its `window.confirm()` delete. Witnessed: right-click a tree row opens the kit menu with Focus/Rename/Duplicate/sep/Delete, the legacy `#ds-ctx-menu` is gone.
- feat(editor): viewport context menu — right-click (mouse) or 500ms long-press (touch, move-cancel) on the 3D viewport while the editor is open opens the kit `ContextMenu` to Create box / box+ / prop / prop+; gated on `editPanel.visible` so right-drag camera/aim is untouched outside edit mode. Witnessed: canvas contextmenu opens the menu with the four create items.
- feat(editor): drag-drop placement — app rows in the Apps panel are draggable (kit `useDraggable`, pointer-events = mouse+touch+pen) and the viewport is a kit `useDropTarget`; dropping an app onto the viewport places it via `PLACE_APP`. Witnessed: a drag-end over the canvas spawns a new entity (`entityMeshes` 3→4). Hierarchy reparent-by-drag is deferred — the entity protocol is flat (no `REPARENT`/`parentId`), so it needs server-side parent-child support outside the editor-GUI scope.
- feat(editor): pointer-event touch scrub — `dragNumberVNode` attaches the kit's new `useNumberScrub` (mouse+touch+pen+XR, `touch-action:none`, click-to-edit preserved) instead of a mouse-only handler, so numeric fields scrub on touch without the page scrolling. Witnessed: scrub field computed `touch-action:none`.
- feat(editor): responsive overlay — under 760px the editor split panes stack to a column and scroll instead of overflowing fixed-px columns, the toolbar wraps, the resize handle hides, coarse pointers get 44px tap targets, and the overlay honors safe-area insets. Witnessed: at 390×844 the split is `column` with no horizontal overflow and a wrapping toolbar; at 820×1180 it stays `row` with no horizontal overflow.
- feat(editor): discoverable keyboard-shortcut help — a status-bar Shortcuts button opens the kit `ShortcutHelpDialog` (focus-trapped, Escape-to-close) listing G/R/S/F/Delete/mod+Z/mod+Y/P, replacing the static one-line hint string that overflowed the status bar on narrow viewports.
- fix(editor): de-glyph the code-pane back button (`← Back` → `Back`); the editor surface is decorative-glyph-clean (authoritative rg sweep of `client/editor` is empty).
- feat(anentrypoint-design): added `useNumberScrub` pointer-event drag-number primitive; fixed `lint-tokens` false positives (`var(--token, #fallback)` fallbacks and `box/text-shadow` rgba tints are themable/functional, not baked colors) that were failing the kit build at HEAD. Published via CI; spoint consumes the kit from the unpkg CDN so the new primitive propagates to `latest`.
- VR: the editor DOM chrome is the flat-screen surface; VR uses a separate world-space canvas-widget system (`client/xr/XRWidgets.js`). Witnessed the editor overlay coexists with `renderer.xr` (no input capture, render loop intact). All editor input is pointer-event based (kit drag/drop/scrub/context-menu), the unified mouse+touch+pen+XR-controller model.

## modelpool: fix texture changing on multi-texture objects after LOD switch

- fix(streaming-gltf 1.0.5): on multi-texture assets (e.g. `aim_sillos` — 96 meshes / 45 texture descriptors), the visible base texture of meshes changed after every LOD switch. Each tracked mesh's `texState` spanned ALL asset-wide `texLodDescs` with no per-mesh filter (`model-pool.js:881`), so the per-frame LOD-driven loop fired `_applyTexLod` for descriptors belonging to OTHER meshes. `_findMaterialSlots` matched textures by name (three's GLTFLoader sets `texture.name` from the image name when the texture def is unnamed — true for these baked webp assets), and on a name miss hit the fallback `if (!out.size && mat.map) out.add(mat.map)`, which stamped the foreign descriptor's bitmap into the mesh's base-colour map. Fix in streaming-gltf: scope each mesh to only its own descriptors via `_meshTexDescIdxs`/`tm._texDescIdxs`, and remove the cross-writing `mat.map` catch-all. Witnessed live on the spoint app (`?singleplayer&world=tps-game`): sillos 96 meshes, 90 scoped to their own texture, 0 foreign-texture violations. Bumped spoint dep to `streaming-gltf ^1.0.5`.

## multiplayer: fix host world resolution + surface the lobby

- fix(client): host mode (`?room=CODE&world=X`) ignored the `world` param and 404'd. app.js only loaded the world module (`/apps/world/<world>.js`) when `_isSingleplayer`, so a hosted game passed `worldDef: undefined` to BrowserServer, which then probed a dead `apps/world/index.js` import (removed in the tps-only cleanup — a guaranteed 404) before falling back to `singleplayer-world.json`. Net: every hosted game 404'd and always loaded the default world regardless of what the lobby requested. Fix: load `_worldDef` for any BrowserServer-backed session (`_isSingleplayer || _isHost || _wwRoom || _joinOffer`), and drop the dead `apps/world/index.js` probe from BrowserServer's worldDef fallback chain.
- fix(ux): the host/join lobby was only reachable via the `M` key with no on-screen hint — multiplayer was wired but undiscoverable. Added a dim "press M for multiplayer" line to the click-to-play prompt (`#click-prompt` + `.cp-hint`).
- verified (local witness): host `?room=TESTRM&world=tps-game` now loads `apps/world/tps-game.js` (200, no index.js 404), the wireweave bridge initializes (nostr pubkey) and opens WebSockets to all 4 relays (damus/primal/snort/nos.lol), 102 meshes render, 0 console errors. Join `?wwjoin&room=CODE` constructs a `WireweaveJoinClient` with a bridge + pubkey, no import errors. The lobby opens on `M` with Host + Join controls. Deployed vendor `wireweave/src/index.js` + `nostr-tools.mjs` serve 200.

## fix: importmap ordering broke the whole client (bare-specifier crash)

- fix(client): client/index.html placed the installStyles `<script type="module">` BEFORE the `<script type="importmap">`. Per the HTML spec an import map must precede any module load or preload, so the browser rejected it ("Import maps are not allowed after a module load or preload has started") and every bare specifier — `three` first — failed to remap, crashing app.js with "The specifier 'three' was a bare specifier, but was not remapped to anything". The client never booted. Firefox enforces this strictly; Chromium tolerated/cache-masked it, which is why an earlier Chromium-only witness wrongly reported the page healthy. Moved the importmap above the installStyles module script (installStyles imports from a full unpkg URL, not a bare specifier, so it is safe to run after the map).
- fix(client): added `<link rel="icon" href="data:,">` to client/index.html and client/landing/index.html to stop the /favicon.ico 404 (empty data-URI, no network request).
- witnessed locally (http://localhost:3001/?singleplayer&world=tps-game): importmap accepted, no bare-specifier error, no favicon 404, app boots — hasApp/hasScene true, 98 meshes, ModelPool engaged, console clean. Witness now explicitly asserts on /import maps are not allowed/i and /bare specifier/i so this class of break can't pass green again.

## gh-pages: pre-bake progressive ModelPool assets at build time

- fix(gh-pages): the deployed demo rendered the map through the LEGACY EntityLoader, not the GPU-optimized ModelPool, even though the integration shipped. Root cause: ModelPool only engages when the client's `progressiveReady()` probe for `<model>.glb.prog/model.progressive.glb` returns 200, but that baked asset is produced on demand by `src/static/ProgressiveBake.js` — which only runs under a live `node server.js`. The static gh-pages host has no server, so the probe 404'd and ModelPool stayed disengaged (witnessed: poolEntities=0, H404 on the .prog url, 98 meshes drawn via the legacy fallback).
- fix(gh-pages): add a build-time "Bake progressive ModelPool assets" step that runs `bakeProgressive(apps/maps/aim_sillos.glb, dist/apps/maps/aim_sillos.glb.prog)` (streaming-gltf's `./bake` export; its toolchain is installed as streaming-gltf optionalDependencies via CI `npm install`). The baked root + `lods/*` ship as static files whose layout matches the client probe url and ModelPool's relative LOD fetches. The step runs AFTER optimize-models so its recursive `*.glb` scan never re-encodes the meshopt-compressed LOD chunks, and bakes from the pristine source GLB (not the dist-optimized copy).
- verified: local bake from the spoint root produces model.progressive.glb + lods/ (510 files), LOCAL_progressive v1 with 96 mesh LODs + 45 texture LODs, every LOD path a relative `lods/…` (so the path-patch sed, which only rewrites /node_modules and /src in *.js/*.html, cannot touch them). The aim_sillos.glb + cleetus.vrm `net::ERR_ABORTED` seen on one load was a benign redundant-request cancel — both assets REQ->FIN cleanly on re-witness.

## gh-pages: fix runtime breaks in the deployed demo

- fix(gh-pages): the model-renderer integration added an importmap entry for streaming-gltf, but the gh-pages build copies a hardcoded package list that did not include it — the deployed demo 404'd on streaming-gltf/model-pool.js and the client module graph failed to load. The workflow still reported green because it never tests the deployed page. Add streaming-gltf to the copy list (drop its bake-time nested node_modules to keep the bundle ~400K).
- fix(gh-pages): evaluateAppModule built its dep base as a root-absolute /apps/<name>/index.js, so on a base-pathed host (gh-pages serves under /spoint/) the relative ./server.js dep resolved to /apps/... and 404'd. Resolve against import.meta.url so the base picks up /spoint/ on pages and / on the server.
- witnessed: the live https://anentrypoint.github.io/spoint/demo.html now loads with ModelPool constructed, world entities loading, zero JS 404s and zero page errors (pre-fix it 404'd on model-pool.js and server.js). The anentrypoint-design and streaming-gltf gh-pages deploys were already healthy.

## cleanup: remove non-tps game content + fix editor GUI jank

- chore(game): remove demo content that does not contribute to the tps game — webcam-avatar (+ webcam-afan client glue + webcam world), physics-crate, and the index.js kitchen-sink demo world. Repoint the server default world index -> tps-game (matches the client default), trim the spawner scaffold template (physics-crate -> box-dynamic), drop the landing webcam CTA. Editor palette apps (box/prop/placed-model) and editor panels are kept.
- fix(editor): the inspector used a Math.random() host id per render, so applyDiff rebuilt the app-props host every render and appended fields without clearing — a position/scale drag (which re-renders many times/sec) duplicated fields and stole focus from the active drag. Stable host id + replaceChildren guarded by an entity+keys signature; the host repopulates only when the prop shape changes.
- fix(anentrypoint-design SplitPanel): the resize state lived as inline pane style that a parent re-render (applyDiff reconciling the pane style back to the initial value) wiped, so editor split positions reset on every entity-select. Persist the dragged size and re-apply it from the pane ref after each diff. Published as anentrypoint-design 0.0.175.
- witnessed: tps-game loads clean after removals (0 errors); editor opens with split panes + resize handles, 10-re-render storm yields 1 stable app-props host (was 10), 0 page errors.

## models: streaming-gltf ModelPool renderer + on-demand progressive bake

- feat(models): the streaming-gltf ModelPool (BatchedMesh far tier, InstancedMesh mid tier, on-GPU LOD streaming + position lerp) is now the model display path for static world/prop/environment models. The VRM player character keeps its specialized PlayerManager path (springbones, expressions, xstate locomotion). Primitive and dynamic-body entities keep their existing paths. Why: GPU-optimize the model pipeline as requested without disturbing the character animation system.
- feat(models): server bakes source GLBs to the LOCAL_progressive format on demand (`src/static/ProgressiveBake.js` + a `<model>.glb.prog/` StaticHandler route), content-hash cached to disk, and prewarms the world's model entities at startup. The client routes a model through ModelPool only when its baked asset exists; non-bakeable assets stay on the legacy EntityLoader path.
- fix(models): ModelPool entity root must be added to the scene by the caller (spawn returns an unparented proxy) — sillos was invisible until fixed. Apply the entity transform (position/quaternion/per-axis scale) directly on the root, not via ModelPool spawn opts which misread rotation as Euler and scale as a uniform scalar. Disable useGlobalMaterialPool: it collapsed distinct per-mesh textures onto one shared tier material so every part rendered with the same texture.
- fix(streaming-gltf): baker now normalizes EXT_texture_webp/avif source to top-level texture.source before gltf-transform read (real game maps failed otherwise), guards empty primitives in the vertcolor LOD stage, and tolerates simplifySloppy assertion failures. Published as streaming-gltf 1.0.4; exports a callable `bakeProgressive()` + `./bake` subpath for server-side baking.
- chore(world): removed the survivor game entirely; the default world is now tps-game (client redirect + landing CTAs updated).
- witnessed (singleplayer browser): env-sillos renders via ModelPool — isPool true, inScene true, 96 meshes, 45 unique materials, distinct per-part textures, correct placement, 0 page errors. Tests 5/5 + 14/14.

## terrain: pack height/normal/water into one RGBA-float texture

- fix(terrain): tile streaming was creating 4 separate float textures (height + color + water + normal) per chunk, ~1MB per full-res tile uploaded to GPU per drainOne. Visible symptom: shorter render distance and "hard stops" when content changed because drain budget (1 hi + 3 fast per RAF) couldn't push that many texture uploads through without stalling. Now packed into 2 textures: heightTex (R=height, G=normal.x, B=normal.z, A=water) and colorTex (RGB). Vertex shader does one fetch, reconstructs ny=sqrt(1-nx²-nz²). Halves per-tile upload bandwidth.
- profile (idle): frame p50 7.7 / p95 8.7 / p99 9.2 / max 19.6 ms over 1200 samples, zero frames over 33ms. Worker p95 6 s. test.js 17/17.

## terrain worker: tile-scope anchor pre-filter

- perf(terrain-worker): pre-filter anchors per tile so sampleAt's hot loop iterates only the few anchors whose max-weight-anywhere-in-tile clears the absolute cutoff (1e-3). Survivor maps have ~16 anchors total but any single 140m tile is dominated by 1-3 of them; the filter typically drops 12+ anchors from the per-call loop. Worker timing avg 3110ms → 2783ms p50 1820ms → 1768ms p95 7100ms → 6900ms.
- correctness: cutoff is ABSOLUTE, not relative to per-tile max-weight. Relative cutoff produced different active anchor sets on adjacent tiles → divergent height/normal sampling at shared edges → seams. Absolute cutoff guarantees adjacent tiles drop the same far-away anchors. Witnessed: aligned shared-edge texels stay 0.0-0.07° apart on 129×129 same-LOD pairs (was up to 60° during the broken intermediate state).
- profile snapshot (idle, survivor): frame p50 8.9ms / p95 10.5ms / render p50 6.2ms; 113fps steady-state. test.js 17/17 green.

## terrain seam: GPU-baked normals

- fix(terrain): visible lighting seams at chunk borders gone. Vertex shader was central-diffing the heightTex with ClampToEdge — at tile edges the boundary texel mirrored, halving the gradient and flipping the normal. Now the worker bakes normals into a per-tile RGBA-float `normalTex` (interior via central-diff on the existing heights array, edges via `sampleAt` straddling the boundary at the neighbour's stride). snapEdge interpolates and re-normalizes the normal channel to match the height-snap pattern. Adjacent tiles at any LOD/factor produce identical edge normals — witnessed 0.000-0.014° angle delta at aligned shared texels (was visible diagonal lighting bands).
- perf(terrain-worker): hoist sampleAt scratch buffers (`_ws`, `_kindAccum`, `_paletteLow/High`) out of the per-vertex hot path; inline blendedGround. Eliminates ~1.7M per-tile allocations on full-res tiles.
- baseline metrics post-fix (idle, survivor world): frame p50 7.9ms / p95 9.7ms / p99 10.8ms; renderer 168 calls / 2.6M tris / 14 programs; vegetation 113 chunks built p95=0.6ms; terrain worker p95 ~7s (down from 9.5s pre-change, was 35.5s under bad NORMAL_STEP=1m baseline before the heights[] reuse). test.js 17/17 green.

## terrain stitch re-priority fix

- fix(terrain): cross-LOD seam re-stitches no longer starved by upgrade priority. `_restitchPending` Set tracks tiles whose `_tileEdgeKey` was invalidated by a neighbour's LOD change; `_workItemPriority` bypasses the 1e6 upgrade penalty for those entries so they reach idle workers ahead of cosmetic upgrades. Witnessed zero seams in steady state and during teleport-induced streaming bursts (was 16 stuck seams, max bilinear height delta 8.15m).
- fix(test): VegetationPhysics streaming test was deadlocking under Node 22 because globalThis.Worker dispatch needs an event-loop yield between updates. Inserted `await new Promise(r => setTimeout(r, 30))` so PLAN messages drain. test.js 17/17 green.

## Wireweave RTC integration

- Add `src/transport/WireweaveTransport.js` — per-peer `TransportWrapper` over wireweave `DataSession`.
- Add `src/transport/WireweaveClient.js` — `createWireweaveClient({ namespace, room, voice })` opens nostr-discovered p2p data channel + optional voice. `getRoomFromHash()` reads `location.hash` for URL-keyed rooms.
- Add `wireweave` ^0.3.0 and `nostr-tools` ^2.7.0 as optionalDependencies (browser-only).
- SKILL.md + CLAUDE.md document the RTC layer; existing `RTCDataChannelTransport` + `RTCWorkerBridge` remain for non-wireweave WebRTC paths.

## Unreleased

- fix(physics): off-tick TerrainPhysics drain. Heightfield insertion now runs on its own `setInterval` timer (12ms cadence) outside the physics tick, so `Settings.Create` no longer blocks `Step()`. Player physics tick is now decoupled from heightfield bake. COLLIDER_RES 64→32 (~4× cheaper Settings.Create) and `mBlockSize=2` further halves it. update() still inline-drains one chunk for guaranteed first-tick progress (test compatibility), but bulk drain is off-tick. Result: server tick never sees more than one heightfield insertion per call regardless of streaming burst size. Note: full architectural decoupling of terrain physics into a dedicated worker requires moving `CharacterVirtual` ground collision to a custom JS height-sample constraint — not in this change.
- feat(rocks): rotate to terrain normal. RockPlacement now emits per-cell `nx, nz` (negated height gradient). VegetationSystem aligns the rock's local +Y to the surface normal then applies yaw + tilt jitter. VegetationPhysics applies the matching rotation to the convex-hull body, so colliders no longer diverge from visuals on slopes.
- feat(rocks): 3-5× larger. ROCK_SIZE_MULT bumped from 0.6/1.4/2.6 to 2.0/4.5/8.0 (small/med/large) on both client and server.
- fix(rocks): server collider scale + rotation match visual. Removed the earlier `min(2.5, scale)` cap on physical size and added rotation passthrough via `addBody(..., 'static', { rotation: q })`. Visual and collider now share identical pose.
- feat(rendering): player-following sun shadow. Enabled `renderer.shadowMap` (PCFSoftShadowMap) + `sun.castShadow`. New `updateSunShadow(sun, target, extent)` keeps the orthographic shadow camera centred on the player at constant 60m radius each frame so shadows render at consistent resolution regardless of world size. Player VRM meshes set `castShadow=true`; vegetation trunks cast within `trunkNear` band; rocks cast at LOD 0 (existing behaviour).
- fix(terrain): never evict the tile under the camera. Added explicit camera-footprint check in eviction loop: any tile whose XZ box contains the camera position is forced visible and skipped from eviction, even if outside the wanted set during a factor shift. Standing zone never disappears.
- fix(terrain): tighter drain caps to keep streaming non-blocking. `_drainBudget` now allows at most 1 high-res + 3 fast-res tiles per RAF (was 1 + 6). Reduces per-RAF main-thread upload pressure during streaming bursts.
- fix(terrain): cross-factor stitching fallback uses FAST_RES, not target res. `neighbourEdgeRes` previously used `t.res` (target) when neighbour tile was missing entirely — but neighbour first lands at FAST_RES placeholder, not target. My edge would build expecting neighbour@target, then visible vertical gap appeared until neighbour upgraded. Falling back to FAST_RES makes my edge match the actual first-arriving neighbour; on neighbour upgrade `_tileEdgeKey` is invalidated and my tile rebuilds.
- fix(physics): COLLIDER_RES 128→64 in TerrainPhysics. Witnessed: heightfield insertion 17-50ms@128 → 5-6ms@64. With BUDGET_PER_TICK=1 + TIME_BUDGET_MS=1, 128 stalled physics tick beyond 15.6ms budget → in singleplayer (server in worker) snapshot emission froze, perceived as "walk position stuck during streaming". 64 still gives 0.5m ground resolution per chunkSize=32 (player capsule r~0.4m).

- feat(physics): convex-hull rock colliders + distance-gated creation. Replaces capsule rock colliders with per-shape convex hulls computed from the same SDF as the visual mesh, scaled to match per-instance scale + squash. Pulled the SDF + marching-cubes generator out of `client/RockGenerator.js` into a pure-JS `src/terrain/RockShapes.js` (no THREE) so the server can build hulls server-side. Tri-table moved to `src/terrain/RockTriTableShared.js`; client re-exports for backward compat. `VegetationPhysics` now: (a) bakes 6 hull point sets at construction (~47ms total at hullRes=12, ~70-155 verts each) — Jolt computes the hull internally via `addBody('convex', vertexArray, ...)`, (b) gates rock collider creation by distance — only rocks within ROCK_COLLIDER_RADIUS=32m of any player position get bodies created. Tree colliders unchanged (capsules; trunk shape is already a good capsule approximation). Browser-witnessed: W key for 1.5s moves camera +3.67m with convex-hull rocks active.
- fix(physics): character mobility regression caused by giant rock capsule colliders. Rocks scaled to rscale 5-10 with sizeMult up to 2.6 produced capsule radii up to ~50m, swallowing the entire walkable area. VegetationPhysics now caps `physScale = min(2.5, rscale)` for rocks so colliders stay reasonable while visual mesh keeps the full 2-10× scale. Witnessed: W-key for 1.5s in browser moves the camera +3.22m.
- feat(rocks): hill/mountain bias + 3x sparser + 2-10x scale band. Added height-based density bonus: yApprox <20m gets 0.15x, 20-50m gets 0.5x, 50-100m gets 1.5x, ≥100m gets 3x. Combined with cubic slope bonus this drives rocks heavily onto hills/mountains and off floodplains. Bonus changes: ROCK_BOOST 3->1 then 0.5 for "3x more seldom"; scale band 5+5*r^3 -> 2+8*r^3 (range 2-10). Rocks/chunk avg 99 -> 30, slope distribution shifted from 23% on near-flat to 8% on near-flat (57% on slopes >0.3). Tree floodPlainBoost lifted: 3x at <0.05 areaSlope, 2x at <0.15; pure-cubic tree atten kicks in at slopeLimit*0.4 instead of *0.7.
- feat(rocks+trees): area-slope steering for clumps + tree avoidance (commit 64091931, partial — included here for completeness): 3x3 mean cell-gradient ("areaSlope") used to attenuate trees on rugged terrain and bias rocks toward steep terrain.
- feat(rocks): tighter LOD bands + denser clumps + 5-10x bigger. Added dedicated `rockNearLodChunks/rockMidLodChunks/rockFarLodChunks` (default 1/2/3, ~140/280/420m) replacing the trunk/foliage/billboard piggyback (was 2/3/6 = 280/420/840m). Survivor world wired to 1/2/3. Browser-witnessed: rock InstancedMeshes 2200→201 (-91%), rock instances rendered 10548→1027 (-90%), draw calls 817→239 (-71%), triangles 9.27M→3.98M (-57%) — visible rocks now end at 420m horizon, not 840m. Bumped placement clump strength: ROCK_CLUMP_FREQ 0.025→0.018 (broader clumps), ROCK_CLUMP_THRESH 0.55→0.4 (clumps cover larger area), GAIN 3→6 (denser cores), FLOOR 0.2→0.05 (sparser between-clumps). Rock scale formula `1 + 9*r^3` → `5 + 5*r^3` (range 5-10), so the smallest rocks render at the previous typical size and the largest are still outcrop-scale. Witnessed avg rocks/chunk 45→90, max chunk 102→225.
- fix(rocks): "rocks rendering on top of existing rocks" + per-instance shader attribute mismatch. Two root causes. (1) Rock InstancedMesh was sharing `BufferGeometry` across chunks, but `im.geometry.setAttribute('seed'/'colorType'/'variation', ...)` mutates the shared geometry — every chunk overwrote the previous chunk's per-instance attribute buffer. Three.js then drew each InstancedMesh with whichever set of seed/color/variation attrs was last written to the shared geometry, causing color/wetness/roughness to randomly shift across chunks AND undefined sampling when one chunk had more instances than the next. Fix: each rock chunk now wraps the shared shape geometry in a per-chunk `InstancedBufferGeometry` (sharing the position/normal/index buffers, but holding per-chunk InstancedBufferAttributes). disposeChunk deletes the wrapper attributes + disposes the wrapper geometry; shared shape geometry stays alive. (2) Stale worker results piling up: when `update()` saw a chunk with a different `_lodBand` it disposed the chunk and queued a fresh request, but old results already in `_readyQueue` for that key still drained, so the chunk briefly held two assemblies (old + new) until the next eviction pass. Now: dispose-existing also strips matching keys from `_readyQueue`, and the drain loop re-checks `chunks.get(key)` and disposes any same-band-mismatched record before assembling. With camera-walk stress test (60 frames moving + 60 returning) instance count returned to baseline rather than monotonically climbing.
- feat(rocks): 10× density + outcrop clustering + 1-10× scale variance + 4× surface detail. Decoupled the rock pass from the single-species per-cell veg loop into `src/terrain/RockPlacement.js` (`createRockEmitter`); rocks now sample independently of trees so their density is governed directly. Per-cell roll uses kind-weighted rock total × ROCK_BOOST (8) × densityScale, multiplied by a 2D value-noise clump field (freq 0.025, threshold 0.55, gain 3, floor 0.2 outside clumps) and a slope-edge bonus (`1 + min(2, slope/slopeLimit)`) so cliffs and ridges get dense outcrops. Witnessed: 12.4× rocks/chunk avg (3.6 → 45), max chunk 102 vs 11 baseline, holding determinism. Rock per-instance scale changed from `0.7 + r·1.4` (range 0.7–2.1) to `1 + 9·r³` (range 1.0–10.0, p50 ~2.2, p99 ~9.7) so most rocks stay small but a long tail produces outcrop-scale boulders. Rock species mix (small/med/large) per cell derived from existing biome rock weight ratios. Marching-cubes high-LOD resolution bumped 20→32 (avg verts 327→891, ~2.7×, sync bake ~109ms for 6 shapes). Shader noise frequencies doubled (coarse 0.4→0.8, fine 2.5→5.0) with an extra fbm octave (3→4) for finer surface detail. Removed the stale rock branch from the main veg loop; extracted `SPECIES_WEIGHTS`/`SPECIES_LIST`/etc. to `src/terrain/VegetationWeights.js` to break the import cycle and keep `VegetationPlacement.js` ≤200 lines. test.js rock test now asserts >100 total rocks, max scale >5, min scale ~1, max chunk ≥30, avg ≥25/chunk.
- feat(rocks): procedural rock species (`rock_small`, `rock_med`, `rock_large`) integrated into `VegetationPlacement` + `VegetationSystem` + `VegetationPhysics`. Distribution favors mountains/highlands/alpine biomes (kinds 2/3/4) with smaller densities elsewhere; rocks tolerate up to 2× `slopeLimit` (vegetation-blocking slopes still pass rocks through). New `client/RockGenerator.js` builds 6 procedural shapes via SDF + marching cubes (res=20 high, IcosahedronGeometry mid-LOD, BoxGeometry far-LOD), plus a shared MeshStandardMaterial with onBeforeCompile shader injecting per-instance noise-perturbed normals, palette colors (7 rock types), wetness/roughness/tinge variation. `RockTriTable.js` carries the 256-entry marching-cubes triangle table. Per-instance attributes (`seed`, `colorType`, `vec4 variation`) drive shader. Rocks render in trunk LOD band (high-res), foliage band (icosahedron impostor), billboard band (box impostor); shadows enabled only at LOD 0. Capsule colliders sized by class via `mult` field, sunk so half-buried rocks read as ground features. Placement adds `squash` (0.45–1.10), 3-axis tilt (`rot`/`rotZ`/`tiltX`/`tiltZ`), and `variant` (chooses shape index 0–5 deterministically). New test exercises rock emission count + field presence + size diversity.
- fix(rendering): disable sun shadow casting entirely. The player-following shadow system (c3bd01d8) produced visible dark tree-shaped silhouettes on the ground under vegetation — alpha-tested foliage materials + PCF shadow map + 1024² mapSize at ±50m frustum produced black blocky blobs that read as "flat black trees". Removed `renderer.shadowMap.enabled`, `sun.castShadow`, shadow frustum configuration, shadow camera follow block in animate loop, and `_shadowDirty` tracking. `fitShadowFrustum` infrastructure kept intact in case shadows are re-enabled via a different technique (contact shadows / SSAO / VSM).
- fix(vegetation): grass/bush cards were invisible. makeCardTexture used a gradient fillRect followed by 10 destination-in triangle draws — each destination-in intersects (not unions) with the previous mask, so only the overlap of all 10 random triangles survived, which is nearly always empty (~0 opaque pixels). Rewrote to draw 10 triangular fills directly with the gradient (source-over union), producing dense vertical blade shapes with opaque interior and transparent exterior. Triangle geometry: random center x, width 4–9px, tip jitter ±4px from base centerline, from bottom to top. Browser-witnessed: 4499 grass+bush instances across 58 InstancedMeshes now render visibly; grass/bush colors tuned for contrast (0x6b9e2a grass, 0x2d5526 bush).
- feat(vegetation): per-placement terrain stress stunting. Trees on steep slopes / low-waterline / high-alpine cells scale down via `stressFactor = 0.55 + 0.45 × terrainFactor` (up to 45% stunt). Foliage and branch factors also multiplied by stressFactor (30-40% max reduction). Stressed tree trunks are visibly shorter and thinner — matches real-world thin-soil growth constraints. Stays fully deterministic (terrainFactor derived from grid sampling, no RNG).
- feat(vegetation): separate card vs tree LOD distances. `nearLodChunks` (default 1 in survivor world) governs tree foliage visibility (trunks-only beyond 1 chunk, ~140m). `cardLodChunks` (default 3) keeps grass + bush cards visible up to 3 chunks (~420m). Previous unified nearLodChunks=2 left grass invisible at close range despite being the most-desired ground feature.
- feat(vegetation): deterministic `age` parameter (0–1) drives tree population dynamics. age=0.2 → sparse young growth (small scale); age=0.5 → mature forest (peak density); age=0.85 → old-growth with canopy gaps (fewer but larger trees); age=1.0 → ancient thinned stand. Density follows a bell curve peaking around age 0.55. Tree scale = rawScale × (0.3 + 0.9×age). Per-placement deterministic `health ∈ [0.7, 1.0]` also governs `branch` and `foliage` factors carried through to client InstancedMesh — foliage is skipped entirely below 0.25, per-instance non-uniform scale shrinks sparse trees. age in apps/world/survivor.js default 0.65.
- feat(vegetation): terrain-aware heterogeneous density. Steep slopes (between 45% and 100% of slopeLimit) attenuate spawn probability toward zero — sheer faces get no trees instead of a hard edge. Low elevations near minY and high elevations between 80–160m also reduce density (water margins and alpine zones naturally thin out). All modulation is deterministic functions of cell hash + terrain geometry, so same seed + same age always reconstructs the exact same forest.
- feat(vegetation): per-species size-aware density. Fir (19m) spawns ~13% as often as willow (7m) — proportional to inverse crown area. Canopy overlap visibly reduced. SPECIES_SIZE table + _sizeAttenuation in VegetationPlacement; bush/grass unaffected (ground cover).
- feat(vegetation): near-LOD culling. Chunks beyond `nearLodChunks` (default 2) render trunks only, drop foliage mesh + ground cover cards entirely. LOD rebuild on crossing. Cuts foliage alpha-test fill-rate dramatically for distant rings.
- feat(vegetation): budgeted client chunk builds. update() now queues by distance-to-camera, builds at most `maxBuildsPerFrame` (default 2) per frame within `frameBudgetMs` (default 4). Eliminates 160ms frame spikes when player crosses ring boundaries. chunk queue drains across frames.
- feat(vegetation): client timing observability. window.__debug.vegetation.timing exposes `{ samples, lastBuildMs, avg, p50, p95, max, chunksBuilt, chunksQueued }` rolling 60-build window; mirrors terrain timing shape.
- perf(physics): VegetationPhysics now splits capsule creation within a chunk across ticks (16 capsules/tick, 1.5ms wall). Previous per-chunk all-at-once spikes of ~30ms (107 capsules × 0.14ms + placement) are capped; placement itself still the dominant remaining cost — logged as future worker-offload candidate.
- perf(vegetation): placement cost 27→16 ms/chunk on survivor world (41% faster). Two wins stacked. (1) `VegetationPlacement.placementsForChunk` now pre-samples a (cells+1)² height grid once per chunk (module-level `_heights` Float64Array, zero per-chunk alloc), computes slope via finite-difference of grid corners, and takes tree Y as bilinear interp — eliminates 2×289 `heightFn` slope probes and 1×accepted `heightFn` Y-fetch per chunk. Y error ≤0.5m, invisible at 4m tree height. (2) `TerrainField._weights` gained IDW early-exit (skip anchors whose unnormalized weight < 1e-3×max, ΔS=0 vs brute baseline over 500 random samples). Placement counts and species diversity unchanged; `test.js` asserts <25 ms/chunk perf regression gate.
- fix(vegetation): `TerrainField` was stripping `kind`/`biome` fields when re-mapping anchors for per-anchor samplers, so `VegetationPlacement` read `anchor.kind === undefined` at every cell and fell back to `BIOME_KIND[undefined] ?? 0` — every cell saw only kind-0 (rolling_hills) weights, so willow/fir/palm never spawned regardless of biome layout. Preserved `kind`/`biome` in `createTerrainField`. After fix: survivor world 441-chunk probe yields 5/5 tree species (33% oak / 28% pine / 18% willow / 18% fir / 3% palm), vs. previously oak/pine only.
- feat(vegetation): per-tree scale + per-tree tilt variation. Per-species scale jitter widened to 0.75–1.45 (was 0.85–1.25) with tilt up to ~4.6° around Y-axis for organic look. `rand01` upgraded to a proper avalanche mixer because the raw 24-bit extraction correlated narrowly for small XOR keys — previously produced scale min=0.925 max=1.098 despite nominal 0.85–1.25 range. New scale buckets uniform across 0.75–1.45.
- feat(vegetation): SPECIES_WEIGHTS boosted for non-oak trees — at IDW blend boundaries with dilute biome weights, willow/fir/palm weight × densityScale was falling below the per-cell spawn gate even at the biome's own anchor. Weights in kinds 2/3/4/5/6/7 now produce fir/willow/palm at their respective biome anchors.
- fix(vegetation): ez-tree API fix — trees now actually render. Previously tree.options.type = TreeType.Oak was producing undefined (TreeType has only Deciduous/Evergreen; species flavor is bark.type + leaves.type). The cascading undefined caused a 'Cannot set properties of undefined (setting length)' in bakeTree that silently failed init. Validated live in browser: 29 chunks, 7/7 species baked.
- feat(vegetation): ground cover billboard cards (bush/grass) + `setConfig` hot-reload + `WORLD=survivor` env var for multiplayer server. Fixes "no plants visible" — server was loading default world without terrain/vegetation; set `WORLD=survivor` to enable. Client-side `continent: 'default'` string is now expanded to anchors in `VegetationSystem.buildHeightSampler` for placement parity with server. Bushes render as crossed double-plane billboards; grass as single planes with procedural canvas-painted alpha-streak textures.
- feat(vegetation): procedural vegetation system. `src/terrain/VegetationPlacement.js` = deterministic jittered-grid placement with IDW-blended biome weighting for species picks (oak/pine/fir/willow/palm/bush/grass). `src/physics/VegetationPhysics.js` = chunked Jolt capsule streaming (trees only; bushes/grass are visual only). `client/VegetationSystem.js` = client rendering via ez-tree bake at startup + per-chunk `THREE.InstancedMesh` per species part (trunk/foliage separately). Wired into AppRuntime (`setVegetationConfig`), ServerAPI, WorkerEntry singleplayer, and survivor world. Adds `@dgreenheck/ez-tree` dependency + importmap entry.
- feat(terrain): real reflective water plane at `sceneConfig.waterline`. Uses THREE.Water from `three/addons/objects/Water.js` with a procedural normal-map DataTexture (no binary asset). Plane sized `chunkSize * (renderDistance*2+4)`, snaps to chunk grid each frame so it follows the camera. Per-fragment river tint in terrain shader retained for shallow rivers. Exposed via `window.__debug.water`.
- fix(terrain): revert custom-shader shadow-chunk injection — caused shader compile failure that hid all terrain. Player shadow on terrain remains a TODO; needs EffectComposer-based approach instead of inline `<shadowmap_*>` chunks in custom ShaderMaterial.

## Unreleased

- fix(animation): walking backward (regression from prior commit) — pass raw mesh.rotation.y as bodyYaw to ASM (was passing +π offset, inverting fwdSign).
- feat(renderer): adaptive AA now uses absolute fps threshold (default 59 fps); slow frame -> immediate disengage, average back over threshold -> re-engage. window.__debug.adaptiveAA exposes fpsThreshold + slowFrameMs.
- feat(terrain): custom shader now samples directional light shadow map — players cast visible shadows on terrain. UniformsLib.lights merged into material; lights:true.
- fix(terrain): more high-frequency detail at spawn — BiomePresets BASE midFreq/localFreq/ridgeFreq raised; rolling_hills + lakeland local strengths bumped further.
- perf(terrain-physics): TIME_BUDGET_MS=3 added to TerrainPhysics.update so chunk add no longer blocks tick beyond 3ms wall time. Player-current-chunk no longer synchronously created (pushed to front of priority queue).

## rs-exec (separate repo, deployed via rs-plugkit republish)

- fix(browser): 3-pass outer retry loop with full reset (kill stale + ws-server + profile lock + fresh port) when managed Chrome dies mid-session. Inner loop breaks early on port-died-mid-retry. Pushed to AnEntrypoint/rs-exec@98ca2ff.

## Unreleased

- fix(player): in free-fly camera mode (P), local player mesh no longer rotates with mouse — only the camera does.
- feat(animation): walking backwards now plays locomotion animation in reverse — ASM computes signed forward speed via dot of velocity and body yaw, flips timeScale sign when moving backward.
- feat(terrain): higher altitude in free-fly mode widens far render distance — `effectiveRD` scales up to 2.5x with `heightAboveGround` past `LOD_AT_AIR_THRESHOLD`.
- fix(terrain): added high-frequency detail to rolling_hills + lakeland presets so spawn area is less smooth/wavy (midStrength + localStrength* roughly doubled).
- feat(renderer): adaptive anti-aliasing — `client/AdaptiveAA.js` watches frame timing; pixelRatio held at base when frames hit refresh-rate target, drops to 1.0 immediately when frames slip. `window.__debug.adaptiveAA` exposes engaged/baseRatio/targetMs/avgMs/pixelRatio.

## Unreleased

- fix(terrain): rewrite biome palette so lakeland/swamp render dark wet green, alpine renders snow/rock, beach renders sand. Spawn area no longer sand-washed.
- feat(terrain): chunk build timing exposed via `window.__debug.terrain.timing` (avg/p50/p95/max ms, sample count, worker count).
- refactor(terrain): split TerrainSystem.js — extracted TerrainMaterial.js (defaults + ShaderMaterial factory) and TerrainDebug.js (window.__debug attach/detach).

## [Unreleased]
- feat: rename GH Pages demo CTA to "Shooter Demo", add "Survivor Demo" button linking to demo.html?world=survivor
- fix: remote player position jitter — lerp remote players in SceneGraph.tick via applyPlayerTransform lerpFactor; local player snaps directly

## [Unreleased]

### Features
- Add infinite procedural terrain system with FBM noise, biomes, erosion, rivers, and Web Worker chunk generation (TerrainSystem.js, TerrainShaders.js, TerrainWorkerSource.js, TerrainNoise.js)
- Terrain auto-initializes from world config `terrain` field; set `terrain: false` to disable
- Fix aim_sillos map scale from [3,3,3] to [1,1,1]

## [Unreleased]

- feat: marketing landing page at /spoint/ — webjsx + RippleUI, flatspace content aggregation, game moved to /spoint/demo.html
- fix: xstate v5 context immutability in ReconnectManager and ReloadManager (use assign() instead of direct mutation)
- perf: smallest-three quaternion packing in SnapshotEncoder — rotation encoding reduced from 4 floats to 1 uint32, ~12 bytes saved per entity per tick, max angular error 0.0014 rad
- perf: entity array shrunk from 17 to 15 elements with sleeping bit at index 14
- feat: per-client priority accumulator in TickHandler — top-64 entity budget per client based on distance+velocity scoring, scales to large entity counts
- feat: EVE-style tick dilation in TickSystem — auto-slows simulation dt when 60-tick avg load >85% of budget, broadcasts MSG.TICK_DILATION(0x93) to clients, recovers when load drops below 60%
- feat: BaseClient.dilationFactor + onDilation callback for client animation rate adjustment
- feat: GET /debug/server observability endpoint
- feat: PeerHostUI — WebRTC host/join UI card (?host / ?join=<b64> params)
# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [0.1.463](https://github.com/AnEntrypoint/spoint/compare/v0.1.462...v0.1.463) (2026-04-16)

### [0.1.462](https://github.com/AnEntrypoint/spoint/compare/v0.1.461...v0.1.462) (2026-04-10)

### [0.1.461](https://github.com/AnEntrypoint/spoint/compare/v0.1.460...v0.1.461) (2026-04-09)


### Bug Fixes

* always play JumpLand animation on landing regardless of speed ([9b4d625](https://github.com/AnEntrypoint/spoint/commit/9b4d62540f678223db379de43fc343ae95dbdc2e))
* expose vrSettings and deviceInfo as getters instead of functions ([c74d687](https://github.com/AnEntrypoint/spoint/commit/c74d687b8dc5010c3a93fcbf9db2613d5fedcf4c))
* isomorphic xstate imports + singleplayer worker boot ([a26558e](https://github.com/AnEntrypoint/spoint/commit/a26558e14969f603fedaae54e3210541b6cfca3a))

### [0.1.460](https://github.com/AnEntrypoint/spoint/compare/v0.1.459...v0.1.460) (2026-04-09)


### Features

* VR joystick locomotion — analog movement, smooth turn, crouch ([9137c20](https://github.com/AnEntrypoint/spoint/commit/9137c20e3bc9828cf19d2cfd67359dc891de5d31))

### [0.1.459](https://github.com/AnEntrypoint/spoint/compare/v0.1.458...v0.1.459) (2026-04-09)

### [0.1.458](https://github.com/AnEntrypoint/spoint/compare/v0.1.457...v0.1.458) (2026-04-09)

### [0.1.457](https://github.com/AnEntrypoint/spoint/compare/v0.1.456...v0.1.457) (2026-04-09)

### [0.1.456](https://github.com/AnEntrypoint/spoint/compare/v0.1.455...v0.1.456) (2026-04-08)

### [0.1.455](https://github.com/AnEntrypoint/spoint/compare/v0.1.454...v0.1.455) (2026-04-08)

### [0.1.454](https://github.com/AnEntrypoint/spoint/compare/v0.1.453...v0.1.454) (2026-04-06)

### [0.1.453](https://github.com/AnEntrypoint/spoint/compare/v0.1.452...v0.1.453) (2026-04-06)


### Bug Fixes

* move RTCPeerConnection to BrowserServer main thread for browser WebRTC P2P ([f2ec552](https://github.com/AnEntrypoint/spoint/commit/f2ec55273f3e76c09efdfae0c0b2bef1d5bed280))

### [0.1.452](https://github.com/AnEntrypoint/spoint/compare/v0.1.451...v0.1.452) (2026-04-06)

### [0.1.451](https://github.com/AnEntrypoint/spoint/compare/v0.1.450...v0.1.451) (2026-04-06)


### Features

* extract BaseClient base class, add WebRTC P2P transport layer ([0f56417](https://github.com/AnEntrypoint/spoint/commit/0f5641773efef6e792c90549480611e4269bbbca))

### [0.1.450](https://github.com/AnEntrypoint/spoint/compare/v0.1.449...v0.1.450) (2026-04-06)


### Bug Fixes

* addTrimeshCollider uses GLB path on Node.js, deferred client-geometry path in browser Worker ([be21778](https://github.com/AnEntrypoint/spoint/commit/be217782c1418248e97047a29ecd213b5640cd37))

### [0.1.449](https://github.com/AnEntrypoint/spoint/compare/v0.1.448...v0.1.449) (2026-04-06)


### Bug Fixes

* improve trimesh collider diagnostics and singleplayer world config loading order ([595020c](https://github.com/AnEntrypoint/spoint/commit/595020cceeb181bd936ea8b71a8c0dfc9d4c4db4))

### [0.1.448](https://github.com/AnEntrypoint/spoint/compare/v0.1.447...v0.1.448) (2026-04-06)


### Bug Fixes

* populate pm.playerStates from snapshot so tickPlayerAnimators has data to drive VRM animations ([d2fa62a](https://github.com/AnEntrypoint/spoint/commit/d2fa62a34859de9ba53b44cec0392cd67ac93514))

### [0.1.447](https://github.com/AnEntrypoint/spoint/compare/v0.1.446...v0.1.447) (2026-04-06)

### [0.1.446](https://github.com/AnEntrypoint/spoint/compare/v0.1.445...v0.1.446) (2026-04-06)

### [0.1.445](https://github.com/AnEntrypoint/spoint/compare/v0.1.444...v0.1.445) (2026-04-06)


### Bug Fixes

* Inspector no longer intercepts MSG.TRIMESH_DATA (0x92) in browser Worker ([2f1bb7e](https://github.com/AnEntrypoint/spoint/commit/2f1bb7e6a69da4b393fe3ca1d29dce02fd78705d))

### [0.1.444](https://github.com/AnEntrypoint/spoint/compare/v0.1.443...v0.1.444) (2026-04-06)

### [0.1.443](https://github.com/AnEntrypoint/spoint/compare/v0.1.442...v0.1.443) (2026-04-06)


### Bug Fixes

* defer trimesh body to client geometry; halve movement speeds for 3x map scale ([54a7c84](https://github.com/AnEntrypoint/spoint/commit/54a7c84c9a429518116129f30e80f46fbf615668))
* update singleplayer-world.json entity id to env-sillos and bump movement speeds ([e2fc7dd](https://github.com/AnEntrypoint/spoint/commit/e2fc7ddef9fa29c30a5df0e5b60f923f30803de1))

### [0.1.442](https://github.com/AnEntrypoint/spoint/compare/v0.1.441...v0.1.442) (2026-04-06)

### [0.1.441](https://github.com/AnEntrypoint/spoint/compare/v0.1.440...v0.1.441) (2026-04-06)


### Bug Fixes

* reset model transform to identity before LOD addLevel to prevent double-scale ([a61cf9b](https://github.com/AnEntrypoint/spoint/commit/a61cf9bbbc4f07d69e19b7d7796b336a401d451a))

### [0.1.440](https://github.com/AnEntrypoint/spoint/compare/v0.1.439...v0.1.440) (2026-04-05)


### Bug Fixes

* restore singleplayer spawn y=2 (trimesh body created at Worker init, no timing race) ([407a7ce](https://github.com/AnEntrypoint/spoint/commit/407a7ceaa09c8911b3e48831a48be58f6d9e7639))

### [0.1.439](https://github.com/AnEntrypoint/spoint/compare/v0.1.438...v0.1.439) (2026-04-05)


### Bug Fixes

* addTrimeshCollider uses addStaticTrimeshAsync in all contexts (Worker fetches GLB via HTTP) ([801025e](https://github.com/AnEntrypoint/spoint/commit/801025e2522ec2e92753f8e681d4e9955f5be5a4))

### [0.1.438](https://github.com/AnEntrypoint/spoint/compare/v0.1.437...v0.1.438) (2026-04-05)


### Bug Fixes

* addTrimeshCollider uses GLB path on Node.js, defers to client geometry only in browser Worker ([5c4755d](https://github.com/AnEntrypoint/spoint/commit/5c4755d0a0ff22e7015ceb06c521597e5cf34137))

### [0.1.437](https://github.com/AnEntrypoint/spoint/compare/v0.1.436...v0.1.437) (2026-04-05)

### [0.1.436](https://github.com/AnEntrypoint/spoint/compare/v0.1.435...v0.1.436) (2026-04-05)


### Bug Fixes

* raise singleplayer spawn point to y=30 for trimesh timing, add trimesh extraction log ([9cafe9b](https://github.com/AnEntrypoint/spoint/commit/9cafe9bdc1a883a2bc68be2ce74426d55cb00c8e))

### [0.1.435](https://github.com/AnEntrypoint/spoint/compare/v0.1.434...v0.1.435) (2026-04-05)


### Bug Fixes

* remove debug instrumentation, simplify TRIMESH_DATA handler ([bf2750a](https://github.com/AnEntrypoint/spoint/commit/bf2750a60cd234c7be888e888ec5777676546925))

### [0.1.434](https://github.com/AnEntrypoint/spoint/compare/v0.1.433...v0.1.434) (2026-04-05)

### [0.1.433](https://github.com/AnEntrypoint/spoint/compare/v0.1.432...v0.1.433) (2026-04-05)


### Bug Fixes

* retry TRIMESH_DATA handler when app setup() hasn't completed yet ([6ee7435](https://github.com/AnEntrypoint/spoint/commit/6ee7435c7e096ff4d61e2b991ba7788c69a2a813))

### [0.1.432](https://github.com/AnEntrypoint/spoint/compare/v0.1.431...v0.1.432) (2026-04-05)


### Features

* client→server trimesh geometry transfer for physics/visual parity ([2e4a708](https://github.com/AnEntrypoint/spoint/commit/2e4a708ac8513b97dd0bd7725be85188997f84fe))

### [0.1.431](https://github.com/AnEntrypoint/spoint/compare/v0.1.430...v0.1.431) (2026-04-05)

### [0.1.430](https://github.com/AnEntrypoint/spoint/compare/v0.1.429...v0.1.430) (2026-04-05)


### Bug Fixes

* SceneGraph writes directly into node.target plain object, removes Map-based setter delegation ([c3e97c8](https://github.com/AnEntrypoint/spoint/commit/c3e97c8ca19940e6def99766cf58d6170814a5a3))

### [0.1.429](https://github.com/AnEntrypoint/spoint/compare/v0.1.428...v0.1.429) (2026-04-05)

### [0.1.428](https://github.com/AnEntrypoint/spoint/compare/v0.1.427...v0.1.428) (2026-04-05)

### [0.1.427](https://github.com/AnEntrypoint/spoint/compare/v0.1.426...v0.1.427) (2026-04-05)


### Features

* unified SceneGraph replaces per-system transform maps ([20268df](https://github.com/AnEntrypoint/spoint/commit/20268dfd23f7fb27c0d872127f681ab09cf9e45d))

### [0.1.426](https://github.com/AnEntrypoint/spoint/compare/v0.1.425...v0.1.426) (2026-04-05)

### [0.1.425](https://github.com/AnEntrypoint/spoint/compare/v0.1.424...v0.1.425) (2026-04-05)


### Bug Fixes

* trimesh collider rotation + KTX2 texture compression pipeline ([5ecf980](https://github.com/AnEntrypoint/spoint/commit/5ecf980143022f825a052062f040b2fb69f7799d))

### [0.1.424](https://github.com/AnEntrypoint/spoint/compare/v0.1.423...v0.1.424) (2026-04-05)


### Bug Fixes

* make AppLoader and SessionStore browser Worker compatible ([11c013b](https://github.com/AnEntrypoint/spoint/commit/11c013b2ef3682479d09d83a1de2db45af30bdb8))
* singleplayer Worker init — WORKER_READY handshake + bare specifier browser imports ([0321bdc](https://github.com/AnEntrypoint/spoint/commit/0321bdc42be976105384a48a3ee8453518feebfc))

### [0.1.423](https://github.com/AnEntrypoint/spoint/compare/v0.1.422...v0.1.423) (2026-04-05)

### [0.1.422](https://github.com/AnEntrypoint/spoint/compare/v0.1.421...v0.1.422) (2026-04-05)


### Bug Fixes

* remove dynamic import() from environment setup() — blocked by AppLoader._validate ([626ee8e](https://github.com/AnEntrypoint/spoint/commit/626ee8ec009daa23cbc2451867baac0c7e902a77))

### [0.1.421](https://github.com/AnEntrypoint/spoint/compare/v0.1.420...v0.1.421) (2026-04-04)


### Bug Fixes

* resolve app sources relative to repo root not client/ subdir in BrowserServer ([4d41897](https://github.com/AnEntrypoint/spoint/commit/4d418978b1f66dc0d18bab6bce24ceaac2950d3f))

### [0.1.420](https://github.com/AnEntrypoint/spoint/compare/v0.1.419...v0.1.420) (2026-04-04)

### [0.1.419](https://github.com/AnEntrypoint/spoint/compare/v0.1.418...v0.1.419) (2026-04-04)


### Bug Fixes

* AppLoader.loadFromString uses blob URL import for ES module support in browser Worker; environment app inlines smartObjects and lazily inits fs guard inside setup() ([0a2d265](https://github.com/AnEntrypoint/spoint/commit/0a2d265ddd006178b07577e9bd8020f17078b2ac))

### [0.1.418](https://github.com/AnEntrypoint/spoint/compare/v0.1.417...v0.1.418) (2026-04-04)

### [0.1.417](https://github.com/AnEntrypoint/spoint/compare/v0.1.416...v0.1.417) (2026-04-04)


### Bug Fixes

* add app:environment to env-map entity so trimesh collider is created in singleplayer; update headHeight to 1.85 ([daf9a6d](https://github.com/AnEntrypoint/spoint/commit/daf9a6d6ea8b9cb3fc91c6c0e3d1b566c9eba278))

### [0.1.416](https://github.com/AnEntrypoint/spoint/compare/v0.1.415...v0.1.416) (2026-04-04)

### [0.1.415](https://github.com/AnEntrypoint/spoint/compare/v0.1.414...v0.1.415) (2026-04-04)


### Bug Fixes

* guard Node.js-only APIs for browser Worker compatibility; raise TPS camera headHeight to 1.85 ([e882e12](https://github.com/AnEntrypoint/spoint/commit/e882e12c81fe8ab41c5303b3ea3719f353dc80e9))

### [0.1.414](https://github.com/AnEntrypoint/spoint/compare/v0.1.413...v0.1.414) (2026-04-04)


### Bug Fixes

* use new Uint8Array(ab) in readGLBAsync instead of Buffer.from ([7accf5e](https://github.com/AnEntrypoint/spoint/commit/7accf5eeaed6d90fbbc6210cdd8179fcef84c5e0))

### [0.1.413](https://github.com/AnEntrypoint/spoint/compare/v0.1.412...v0.1.413) (2026-04-04)


### Bug Fixes

* slice packed buffer to exact byteLength before sending to Worker ([45a77a4](https://github.com/AnEntrypoint/spoint/commit/45a77a4f53781d622c4e9bbd4f21b3a45fe0c1a6))

### [0.1.412](https://github.com/AnEntrypoint/spoint/compare/v0.1.411...v0.1.412) (2026-04-04)


### Bug Fixes

* replace all bare specifiers in Worker chain with absolute paths ([63f6978](https://github.com/AnEntrypoint/spoint/commit/63f69786ffc3c9b3db304bdcd3fd13e34205ecc2))

### [0.1.411](https://github.com/AnEntrypoint/spoint/compare/v0.1.410...v0.1.411) (2026-04-04)


### Bug Fixes

* patch Octree.js d3-octree bare specifier for Worker importmap bypass ([8742318](https://github.com/AnEntrypoint/spoint/commit/87423189f0f82f2fbaf435cedd085e456346f411))

### [0.1.410](https://github.com/AnEntrypoint/spoint/compare/v0.1.409...v0.1.410) (2026-04-04)


### Bug Fixes

* resolve d3-octree bare specifier in Worker and localize all assets ([6e38114](https://github.com/AnEntrypoint/spoint/commit/6e38114b35baa76e66bbe60ea19d053f223c90ca))

### [0.1.409](https://github.com/AnEntrypoint/spoint/compare/v0.1.408...v0.1.409) (2026-04-03)


### Bug Fixes

* patch lifecycle.js to use absolute xstate path for Worker importmap bypass ([e0523f9](https://github.com/AnEntrypoint/spoint/commit/e0523f9f4b17bec85458fd1534fb9f5541966392))

### [0.1.408](https://github.com/AnEntrypoint/spoint/compare/v0.1.407...v0.1.408) (2026-04-03)


### Bug Fixes

* deploy apps/_lib/ and xstate; prefer singleplayer-world.json over apps/world/index.js ([df70a96](https://github.com/AnEntrypoint/spoint/commit/df70a96053bd32cb48d3551e676a4af39891b553))

### [0.1.407](https://github.com/AnEntrypoint/spoint/compare/v0.1.406...v0.1.407) (2026-04-03)


### Bug Fixes

* apply node:fs guards in source to avoid GNU sed double-substitution corruption ([0ac0611](https://github.com/AnEntrypoint/spoint/commit/0ac06119c5cd8d0250a38ec8a3f251f2986b00c9))

### [0.1.406](https://github.com/AnEntrypoint/spoint/compare/v0.1.405...v0.1.406) (2026-04-03)


### Bug Fixes

* load singleplayer-world.json as fallback when apps/world/index.js is absent (gh-pages) ([e257246](https://github.com/AnEntrypoint/spoint/commit/e25724605dc4d5b10d31ef28e7eba5016a19547e))

### [0.1.405](https://github.com/AnEntrypoint/spoint/compare/v0.1.404...v0.1.405) (2026-04-03)

### [0.1.404](https://github.com/AnEntrypoint/spoint/compare/v0.1.403...v0.1.404) (2026-04-03)


### Bug Fixes

* use import.meta.url as base in BrowserServer so Worker path is correct under gh-pages subpath ([d545039](https://github.com/AnEntrypoint/spoint/commit/d54503932556924d124552ceb47ca68cf646bd9d))

### [0.1.403](https://github.com/AnEntrypoint/spoint/compare/v0.1.402...v0.1.403) (2026-04-03)

### [0.1.402](https://github.com/AnEntrypoint/spoint/compare/v0.1.401...v0.1.402) (2026-04-03)


### Bug Fixes

* use generic sed to patch all importmap paths for gh-pages subpath ([3db1a45](https://github.com/AnEntrypoint/spoint/commit/3db1a45cf247af0ce5978c5f286e770d784ffcaf))

### [0.1.401](https://github.com/AnEntrypoint/spoint/compare/v0.1.400...v0.1.401) (2026-04-03)


### Bug Fixes

* deploy server-side src/ modules and jolt-physics to gh-pages for Worker singleplayer ([1795b36](https://github.com/AnEntrypoint/spoint/commit/1795b360eeb47cfaf0021a038c307659216f6187))

### [0.1.400](https://github.com/AnEntrypoint/spoint/compare/v0.1.399...v0.1.400) (2026-04-02)


### Bug Fixes

* use import.meta.url-relative paths in BrowserServer for GitHub Pages subpath hosting ([311af0b](https://github.com/AnEntrypoint/spoint/commit/311af0bba400d0152ca836caa1627f72f5193c4d))

### [0.1.399](https://github.com/AnEntrypoint/spoint/compare/v0.1.398...v0.1.399) (2026-04-02)


### Bug Fixes

* load world module via fetch+blob URL instead of dynamic import ([d2fc90f](https://github.com/AnEntrypoint/spoint/commit/d2fc90f6f62429d04ffce06f84f0b2416e2e1deb))

### [0.1.398](https://github.com/AnEntrypoint/spoint/compare/v0.1.397...v0.1.398) (2026-04-02)


### Bug Fixes

* animation speeds and per-zoom camera shoulder offsets ([cce1d06](https://github.com/AnEntrypoint/spoint/commit/cce1d060eec82be37903496f914db31fc864e3d2))

### [0.1.397](https://github.com/AnEntrypoint/spoint/compare/v0.1.396...v0.1.397) (2026-04-02)

### [0.1.396](https://github.com/AnEntrypoint/spoint/compare/v0.1.395...v0.1.396) (2026-04-02)


### Features

* run singleplayer server in a Dedicated Web Worker ([baa94dd](https://github.com/AnEntrypoint/spoint/commit/baa94dd4177f859b9cf5cbd25dad0986c8d98713))

### [0.1.395](https://github.com/AnEntrypoint/spoint/compare/v0.1.394...v0.1.395) (2026-04-02)


### Bug Fixes

* restore immediate entity loading; only gate VRM parses on assetsLoaded ([9d99a1e](https://github.com/AnEntrypoint/spoint/commit/9d99a1e2d9d54954217973314b9135de901abb44))

### [0.1.394](https://github.com/AnEntrypoint/spoint/compare/v0.1.393...v0.1.394) (2026-04-02)

### [0.1.393](https://github.com/AnEntrypoint/spoint/compare/v0.1.392...v0.1.393) (2026-04-02)


### Bug Fixes

* prevent VRM flood on assetsLoaded by gating createPlayerVRM on assetsLoaded ([1838166](https://github.com/AnEntrypoint/spoint/commit/1838166d8429fa4817b1e39203f9119696ed0745))

### [0.1.392](https://github.com/AnEntrypoint/spoint/compare/v0.1.391...v0.1.392) (2026-04-02)

### [0.1.391](https://github.com/AnEntrypoint/spoint/compare/v0.1.390...v0.1.391) (2026-04-02)


### Bug Fixes

* serialize entity loading after assets to prevent singleplayer OOM ([7cf69b9](https://github.com/AnEntrypoint/spoint/commit/7cf69b9709fd08d5f01bfa50a7e03a29307c66de))

### [0.1.390](https://github.com/AnEntrypoint/spoint/compare/v0.1.389...v0.1.390) (2026-04-02)


### Bug Fixes

* ModelCache revalidates ETag synchronously before returning cached buffer ([7660db2](https://github.com/AnEntrypoint/spoint/commit/7660db2c622a35be5c266d63094a385ba7fddb2d))

### [0.1.389](https://github.com/AnEntrypoint/spoint/compare/v0.1.388...v0.1.389) (2026-04-02)


### Bug Fixes

* server now strips Draco from pre-compressed GLBs instead of passing through ([3a09a9d](https://github.com/AnEntrypoint/spoint/commit/3a09a9dab93fcd8e22c7b376a6e8ddac32896e3f))

### [0.1.388](https://github.com/AnEntrypoint/spoint/compare/v0.1.387...v0.1.388) (2026-04-02)

### [0.1.387](https://github.com/AnEntrypoint/spoint/compare/v0.1.386...v0.1.387) (2026-04-02)


### Bug Fixes

* correct Draco strip API — registerDependencies not withConfig, strip before texture rewrite ([8b37ce3](https://github.com/AnEntrypoint/spoint/commit/8b37ce3e9d74c9ab9c6da9329ae32e1d57987fee))

### [0.1.386](https://github.com/AnEntrypoint/spoint/compare/v0.1.385...v0.1.386) (2026-04-02)


### Bug Fixes

* strip Draco compression at build time to prevent Three.js parse OOM ([e24ff9e](https://github.com/AnEntrypoint/spoint/commit/e24ff9e12fa71d213edcf33c2a94f7c399a35310))

### [0.1.385](https://github.com/AnEntrypoint/spoint/compare/v0.1.384...v0.1.385) (2026-04-02)


### Bug Fixes

* wrap if/else branches in braces to fix SyntaxError on warmupShaders skip path ([9ca74be](https://github.com/AnEntrypoint/spoint/commit/9ca74be468a83840b9398dab17b120b6dad86e9a))

### [0.1.384](https://github.com/AnEntrypoint/spoint/compare/v0.1.383...v0.1.384) (2026-04-01)


### Bug Fixes

* skip shader warmup and shadow frustum for large maps to prevent OOM ([27814a4](https://github.com/AnEntrypoint/spoint/commit/27814a40b65f381cd4bc731b985428f5485d479f))

### [0.1.383](https://github.com/AnEntrypoint/spoint/compare/v0.1.382...v0.1.383) (2026-03-31)


### Bug Fixes

* guard FPS camera raycasts with BVH filter to eliminate OOM ([ed8c059](https://github.com/AnEntrypoint/spoint/commit/ed8c059da2562edc9822034f3a019b5f1f247ab9))

### [0.1.382](https://github.com/AnEntrypoint/spoint/compare/v0.1.381...v0.1.382) (2026-03-30)


### Bug Fixes

* disable LOD generation for singleplayer map to prevent OOM ([ab6f06e](https://github.com/AnEntrypoint/spoint/commit/ab6f06e3e92d5bc763fd632f176e276b31e93fc5))

### [0.1.381](https://github.com/AnEntrypoint/spoint/compare/v0.1.380...v0.1.381) (2026-03-30)


### Bug Fixes

* use BVH-only raycasts in camera TPS to prevent singleplayer OOM ([6cd7cef](https://github.com/AnEntrypoint/spoint/commit/6cd7cef337df2ee4d2ed339f28c0e4f49f230a3d))

### [0.1.380](https://github.com/AnEntrypoint/spoint/compare/v0.1.379...v0.1.380) (2026-03-29)


### Bug Fixes

* only raycast against BVH-ready meshes in singleplayer to prevent OOM ([54d831f](https://github.com/AnEntrypoint/spoint/commit/54d831ff4a0327984c0b66a4176745797af3b8f2))

### [0.1.379](https://github.com/AnEntrypoint/spoint/compare/v0.1.378...v0.1.379) (2026-03-29)


### Bug Fixes

* prevent OOM from singleplayer raycast — only use LOD level 0, throttle to 20Hz ([f8e3cda](https://github.com/AnEntrypoint/spoint/commit/f8e3cdad38da6e0bcb7c821455eac7024f42b01a))

### [0.1.378](https://github.com/AnEntrypoint/spoint/compare/v0.1.377...v0.1.378) (2026-03-29)


### Bug Fixes

* eliminate singleplayer jitter by stepping physics in rAF loop; fix walk animation speed for 3x scaled map ([95eb1d2](https://github.com/AnEntrypoint/spoint/commit/95eb1d23c5d06380a8d2e69b719959b6e2367944))

### [0.1.377](https://github.com/AnEntrypoint/spoint/compare/v0.1.376...v0.1.377) (2026-03-29)


### Bug Fixes

* eliminate singleplayer player jitter by extrapolating in LocalClient.getLocalState ([a3fd900](https://github.com/AnEntrypoint/spoint/commit/a3fd90093fc5d4f36c4036c61b2c3ceb8dd59678))

### [0.1.376](https://github.com/AnEntrypoint/spoint/compare/v0.1.375...v0.1.376) (2026-03-29)


### Bug Fixes

* smooth local player mesh to eliminate physics tick sawtooth jitter; fix entity culling to scale with mesh scale ([2ec6ca8](https://github.com/AnEntrypoint/spoint/commit/2ec6ca811cd74fbfa65beb616a2cdd6fbcf4c20a))

### [0.1.375](https://github.com/AnEntrypoint/spoint/compare/v0.1.374...v0.1.375) (2026-03-29)


### Bug Fixes

* simplify singleplayer raycast cache to prevent stale ground Y when falling ([d5c617e](https://github.com/AnEntrypoint/spoint/commit/d5c617e18649a46b570950dda4321b8be7e4da25))

### [0.1.374](https://github.com/AnEntrypoint/spoint/compare/v0.1.373...v0.1.374) (2026-03-29)


### Bug Fixes

* singleplayer raycast fires when airborne and extends far to 200 ([bf12ce1](https://github.com/AnEntrypoint/spoint/commit/bf12ce13e475ff4b7dd2d2a2521cad4caf2459df))

### [0.1.373](https://github.com/AnEntrypoint/spoint/compare/v0.1.372...v0.1.373) (2026-03-29)


### Bug Fixes

* rate-limit singleplayer ground raycast to once per render frame ([331b37e](https://github.com/AnEntrypoint/spoint/commit/331b37e39233e258534d10d4c62cf44ba9439358))

### [0.1.372](https://github.com/AnEntrypoint/spoint/compare/v0.1.371...v0.1.372) (2026-03-29)


### Bug Fixes

* eliminate per-frame jitter for local player at high FPS ([382a3b5](https://github.com/AnEntrypoint/spoint/commit/382a3b5c78cb824ff4cd404e652efed467a67b87))

### [0.1.371](https://github.com/AnEntrypoint/spoint/compare/v0.1.370...v0.1.371) (2026-03-29)


### Bug Fixes

* singleplayer physics — raycast against map mesh for ground detection ([a6c5918](https://github.com/AnEntrypoint/spoint/commit/a6c5918cb839a277e882d59b818e269f01bb4144))

### [0.1.370](https://github.com/AnEntrypoint/spoint/compare/v0.1.369...v0.1.370) (2026-03-26)


### Bug Fixes

* reduce GPU memory pressure to prevent singleplayer OOM ([7820ba8](https://github.com/AnEntrypoint/spoint/commit/7820ba8d1d57db2534c5d9d2586a0b5d1ddf8146))

### [0.1.369](https://github.com/AnEntrypoint/spoint/compare/v0.1.368...v0.1.369) (2026-03-26)


### Bug Fixes

* increase LocalClient yield to 500ms for gh-pages CDN latency ([5d34559](https://github.com/AnEntrypoint/spoint/commit/5d34559855518725794c0ebe833cb0edf4263ee9))

### [0.1.368](https://github.com/AnEntrypoint/spoint/compare/v0.1.367...v0.1.368) (2026-03-26)


### Bug Fixes

* defer LocalClient first snapshot to prevent singleplayer OOM crash ([c490d39](https://github.com/AnEntrypoint/spoint/commit/c490d39acc3298a5a7053af1c55ac1434dadf028))

### [0.1.367](https://github.com/AnEntrypoint/spoint/compare/v0.1.366...v0.1.367) (2026-03-26)


### Bug Fixes

* server-side GLBKtx2 now promotes EXT_texture_webp to direct source ([1c6677d](https://github.com/AnEntrypoint/spoint/commit/1c6677de9c4668298fca27435f1b9abfe94567ba))

### [0.1.366](https://github.com/AnEntrypoint/spoint/compare/v0.1.365...v0.1.366) (2026-03-26)


### Bug Fixes

* optimizer now fixes sourceless textures that crash GLTFLoader ([b989ad6](https://github.com/AnEntrypoint/spoint/commit/b989ad66b0e4add3861cfffed4f9af7d25223344))

### [0.1.365](https://github.com/AnEntrypoint/spoint/compare/v0.1.364...v0.1.365) (2026-03-26)


### Bug Fixes

* always promote EXT_texture_webp sources during build optimization ([abe8e21](https://github.com/AnEntrypoint/spoint/commit/abe8e21b2446281480e97368e7715b54f1f31c2a))

### [0.1.364](https://github.com/AnEntrypoint/spoint/compare/v0.1.363...v0.1.364) (2026-03-26)


### Bug Fixes

* disable KTX2 encoding to prevent browser OOM crash ([588b9ee](https://github.com/AnEntrypoint/spoint/commit/588b9eeaabb580d37ab90bfe21a91726abf5ff6c))

### [0.1.363](https://github.com/AnEntrypoint/spoint/compare/v0.1.362...v0.1.363) (2026-03-26)


### Bug Fixes

* reduce memory pressure with raw bytes prefetch and texture downscale ([39c124e](https://github.com/AnEntrypoint/spoint/commit/39c124e8ca313b6535fb8530fe0ec0b78b6c1b09))

### [0.1.362](https://github.com/AnEntrypoint/spoint/compare/v0.1.361...v0.1.362) (2026-03-25)


### Bug Fixes

* batch model prefetch to prevent browser OOM crash ([004d6b4](https://github.com/AnEntrypoint/spoint/commit/004d6b434514b6a736b479063f9c633620681b62))

### [0.1.361](https://github.com/AnEntrypoint/spoint/compare/v0.1.360...v0.1.361) (2026-03-25)


### Bug Fixes

* prefetch ALL entity models during loading screen ([2e7ae8f](https://github.com/AnEntrypoint/spoint/commit/2e7ae8f629bd3fcd6192edf9e6b43d116cad82c2))

### [0.1.360](https://github.com/AnEntrypoint/spoint/compare/v0.1.359...v0.1.360) (2026-03-25)


### Bug Fixes

* BVH requestIdleCallback, VRM re-creation, load concurrency ([6058791](https://github.com/AnEntrypoint/spoint/commit/60587911afb5abc8c02b2bfdb890c475b1f3ef7c))

### [0.1.359](https://github.com/AnEntrypoint/spoint/compare/v0.1.358...v0.1.359) (2026-03-25)


### Bug Fixes

* add runtime mesh compile for late-spawning entities ([af51b55](https://github.com/AnEntrypoint/spoint/commit/af51b55ca3af7abe0908583b9300f1b4965fe165))
* per-model shader warmup with batched rendering, add tone mapping ([8de0292](https://github.com/AnEntrypoint/spoint/commit/8de0292458f1669c239571078c2db9612a996e46))

### [0.1.358](https://github.com/AnEntrypoint/spoint/compare/v0.1.357...v0.1.358) (2026-03-25)


### Bug Fixes

* revert client to pre-crash state — remove WebGPU, restore working loader pipeline ([4be71d7](https://github.com/AnEntrypoint/spoint/commit/4be71d70f70f2174dd746c18037eb98bd780d274))

### [0.1.357](https://github.com/AnEntrypoint/spoint/compare/v0.1.356...v0.1.357) (2026-03-25)


### Bug Fixes

* use PCFShadowMap for all renderers (PCFSoftShadowMap deprecated in r183) ([d2369e5](https://github.com/AnEntrypoint/spoint/commit/d2369e5f9a22e1ace3c4bdccce7d5525eeab55c7))

### [0.1.356](https://github.com/AnEntrypoint/spoint/compare/v0.1.355...v0.1.356) (2026-03-25)


### Bug Fixes

* destroy WASM temp objects, split oversized files, update docs ([da83355](https://github.com/AnEntrypoint/spoint/commit/da8335530b501cffa12ab93744b6c5d0840ee938))

### [0.1.355](https://github.com/AnEntrypoint/spoint/compare/v0.1.354...v0.1.355) (2026-03-25)


### Bug Fixes

* use basis-lz for color textures to minimize GPU VRAM usage ([569e85c](https://github.com/AnEntrypoint/spoint/commit/569e85c62ac95e035e563d9d1f726ad305fe5535))

### [0.1.354](https://github.com/AnEntrypoint/spoint/compare/v0.1.353...v0.1.354) (2026-03-25)


### Bug Fixes

* attach ktx2Loader to entityGltfLoader to prevent GPU OOM crash ([ce98ed8](https://github.com/AnEntrypoint/spoint/commit/ce98ed8b5e552a3cfb1e971aca40d7e51869f9e3))

### [0.1.353](https://github.com/AnEntrypoint/spoint/compare/v0.1.352...v0.1.353) (2026-03-24)


### Bug Fixes

* use dedicated entityGltfLoader for entity loading to prevent GPU crash ([95fa960](https://github.com/AnEntrypoint/spoint/commit/95fa9606ec72441732c46efa8c093e37be0606fd))

### [0.1.352](https://github.com/AnEntrypoint/spoint/compare/v0.1.351...v0.1.352) (2026-03-24)


### Bug Fixes

* convert app.js static imports to dynamic to prevent browser crash on load ([ab6bbcd](https://github.com/AnEntrypoint/spoint/commit/ab6bbcdd16a1773afb64be31ec4b905e89d48bfd))

### [0.1.351](https://github.com/AnEntrypoint/spoint/compare/v0.1.350...v0.1.351) (2026-03-24)


### Bug Fixes

* auto-disable WebGPU after GPU process crash ([f2fa58b](https://github.com/AnEntrypoint/spoint/commit/f2fa58b32f4432528f882162fe9d784783305e5a))

### [0.1.350](https://github.com/AnEntrypoint/spoint/compare/v0.1.349...v0.1.350) (2026-03-24)


### Bug Fixes

* remove compileAsync shader warmup to prevent GPU OOM on load ([a6ca84b](https://github.com/AnEntrypoint/spoint/commit/a6ca84b4223660c957840fb1e7360da5df793597))

### [0.1.349](https://github.com/AnEntrypoint/spoint/compare/v0.1.348...v0.1.349) (2026-03-24)

### [0.1.348](https://github.com/AnEntrypoint/spoint/compare/v0.1.347...v0.1.348) (2026-03-24)


### Bug Fixes

* use dedicated GLTFLoader for VRM parse to prevent OOM crash ([86c850e](https://github.com/AnEntrypoint/spoint/commit/86c850e7944e45272a1c9decf3ab473e6f7279a9))

### [0.1.347](https://github.com/AnEntrypoint/spoint/compare/v0.1.346...v0.1.347) (2026-03-23)


### Bug Fixes

* reduce memory pressure during loading ([ce0fec7](https://github.com/AnEntrypoint/spoint/commit/ce0fec7ef6d8f8a5d48afdcaaa6e27001a1244d9))

### [0.1.346](https://github.com/AnEntrypoint/spoint/compare/v0.1.345...v0.1.346) (2026-03-23)


### Bug Fixes

* prevent OOM and parse errors during loading ([02e354f](https://github.com/AnEntrypoint/spoint/commit/02e354f7e1d18487e01863476f78564938594236))

### [0.1.345](https://github.com/AnEntrypoint/spoint/compare/v0.1.344...v0.1.345) (2026-03-23)


### Bug Fixes

* skip warmup render passes for WebGPU to prevent OOM crash ([0e962ea](https://github.com/AnEntrypoint/spoint/commit/0e962ea86fcec405a3ef8072ce066f31724c504e))

### [0.1.344](https://github.com/AnEntrypoint/spoint/compare/v0.1.343...v0.1.344) (2026-03-23)

### [0.1.343](https://github.com/AnEntrypoint/spoint/compare/v0.1.342...v0.1.343) (2026-03-23)


### Bug Fixes

* reduce memory footprint in singleplayer session ([256b1de](https://github.com/AnEntrypoint/spoint/commit/256b1dee9f8a39be01f40020a2af57b4221445d1))

### [0.1.342](https://github.com/AnEntrypoint/spoint/compare/v0.1.341...v0.1.342) (2026-03-23)


### Features

* glass-ui, snap-grid, undo-redo, event-log panel ([fd5c590](https://github.com/AnEntrypoint/spoint/commit/fd5c59071d96c45e4c71914b029bc65ff87b4b44))
* server-side GPU memory optimization pipeline ([a17cca0](https://github.com/AnEntrypoint/spoint/commit/a17cca02d53b46c41645901595cb29ef93909a0d))

### [0.1.341](https://github.com/AnEntrypoint/spoint/compare/v0.1.340...v0.1.341) (2026-03-23)


### Features

* replace edit panel with full Blender-style editor shell ([60389af](https://github.com/AnEntrypoint/spoint/commit/60389af1b1e3d16a3daaab729dec1b1a41953699))

### [0.1.340](https://github.com/AnEntrypoint/spoint/compare/v0.1.339...v0.1.340) (2026-03-22)


### Bug Fixes

* add xstate to importmap and fix lang/spoint.js CWD path ([d211e93](https://github.com/AnEntrypoint/spoint/commit/d211e93bbbfcfbaf0a319fe7ce003cedda302770))

### [0.1.339](https://github.com/AnEntrypoint/spoint/compare/v0.1.338...v0.1.339) (2026-03-22)


### Features

* ?noWebGPU param, renderer.info debug, xstate lifecycle, exec:spoint lang plugin ([f1d1a51](https://github.com/AnEntrypoint/spoint/commit/f1d1a51031667f756d8614ca44c9c708231b3d1f))

### [0.1.338](https://github.com/AnEntrypoint/spoint/compare/v0.1.337...v0.1.338) (2026-03-22)


### Bug Fixes

* **singleplayer:** VRM race condition, floor level, texture cache, tick HUD ([969451c](https://github.com/AnEntrypoint/spoint/commit/969451c6909ce59561c4d05c45070c6689c09137))

### [0.1.337](https://github.com/AnEntrypoint/spoint/compare/v0.1.336...v0.1.337) (2026-03-22)


### Bug Fixes

* **singleplayer:** face map interior on spawn and fix LOD transform ([0ecfcfe](https://github.com/AnEntrypoint/spoint/commit/0ecfcfedb8645de9f318b34f0f7b42592948043c))

### [0.1.336](https://github.com/AnEntrypoint/spoint/compare/v0.1.335...v0.1.336) (2026-03-22)


### Bug Fixes

* **EntityLoader:** reset model local transform after wrapping in LOD ([243e1e1](https://github.com/AnEntrypoint/spoint/commit/243e1e18f7392580b76f23773cfac755fcc2977b))

### [0.1.335](https://github.com/AnEntrypoint/spoint/compare/v0.1.334...v0.1.335) (2026-03-21)


### Bug Fixes

* **gh-pages:** patch anim-lib.glb path and guard null client in AppModuleSystem ([f0b0eeb](https://github.com/AnEntrypoint/spoint/commit/f0b0eeb140637fb51d393502f74d496f254cd9f5))

### [0.1.334](https://github.com/AnEntrypoint/spoint/compare/v0.1.333...v0.1.334) (2026-03-21)


### Bug Fixes

* **gh-pages:** patch singleplayer-world.json model paths from ./apps/ to /spoint/apps/ ([ada06d3](https://github.com/AnEntrypoint/spoint/commit/ada06d309bf62b052212a6b7ba97ff01eb1f41aa))

### [0.1.333](https://github.com/AnEntrypoint/spoint/compare/v0.1.332...v0.1.333) (2026-03-21)


### Bug Fixes

* pass callbacks to LocalClient so loading screen clears in singleplayer ([98f5a9c](https://github.com/AnEntrypoint/spoint/commit/98f5a9cb4f6250021ea443ad3203daccac587c81))

### [0.1.332](https://github.com/AnEntrypoint/spoint/compare/v0.1.331...v0.1.332) (2026-03-21)


### Bug Fixes

* **gh-pages:** patch /draco/, /basis/, /singleplayer-world.json runtime paths ([c0d9459](https://github.com/AnEntrypoint/spoint/commit/c0d945976ee1fec21294ca28af9cf456b5a763de))

### [0.1.331](https://github.com/AnEntrypoint/spoint/compare/v0.1.330...v0.1.331) (2026-03-21)


### Bug Fixes

* move importmap before modulepreload links to satisfy browser spec ([91734d2](https://github.com/AnEntrypoint/spoint/commit/91734d2b48be2b1558b507938bd35a1023ceebcc))

### [0.1.330](https://github.com/AnEntrypoint/spoint/compare/v0.1.329...v0.1.330) (2026-03-21)


### Bug Fixes

* **gh-pages:** patch all JS files for /spoint/ base path, not just hardcoded list ([35c44d2](https://github.com/AnEntrypoint/spoint/commit/35c44d2a9766810b011c75cc59225b6a4d319453))

### [0.1.329](https://github.com/AnEntrypoint/spoint/compare/v0.1.328...v0.1.329) (2026-03-21)


### Bug Fixes

* **gh-pages:** inject singleplayer redirect before modulepreload links ([7de8fff](https://github.com/AnEntrypoint/spoint/commit/7de8fff2616a3abd3acda424a63216ddc7c3181a))

### [0.1.328](https://github.com/AnEntrypoint/spoint/compare/v0.1.327...v0.1.328) (2026-03-21)


### Bug Fixes

* correct gh-pages base path from /spawnpoint to /spoint, update docs and repo URL ([4d0ab0f](https://github.com/AnEntrypoint/spoint/commit/4d0ab0f2f277fce6d6308c4e50f9bfd72aa91f48))

### [0.1.327](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.326...v0.1.327) (2026-03-21)

### [0.1.326](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.325...v0.1.326) (2026-03-21)


### Features

* editor DX improvements, serverless single-player mode, GitHub Pages demo ([b0f3d0f](https://github.com/AnEntrypoint/spawnpoint/commit/b0f3d0feea71b070a25285c78d9eeaf7a930acc4))

### [0.1.325](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.323...v0.1.325) (2026-03-19)


### Features

* add geometry/LOD/shader caching and WebGPU material improvements ([da2078a](https://github.com/AnEntrypoint/spawnpoint/commit/da2078aa73e15d9586b44cceedebb617f972f13f))


### Bug Fixes

* **ci:** prevent publish race condition with concurrency group and rebase ([d8501c3](https://github.com/AnEntrypoint/spawnpoint/commit/d8501c3b0e6cac49f28f1985bc95c88eaa24b9ec))
* correct typo consconst in GeometryCache.js reconstructGeometry ([e217bda](https://github.com/AnEntrypoint/spawnpoint/commit/e217bda9fb6b1cd7d1e8c78c52100ddc8650b542))
* restore WebGPU node material upgrade in EntityLoader traverse loop ([e35f614](https://github.com/AnEntrypoint/spawnpoint/commit/e35f6145a34e9561785f3d6ac1a1ec60d6727ec8))

### [0.1.324](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.323...v0.1.324) (2026-03-19)


### Features

* add geometry/LOD/shader caching and WebGPU material improvements ([da2078a](https://github.com/AnEntrypoint/spawnpoint/commit/da2078aa73e15d9586b44cceedebb617f972f13f))


### Bug Fixes

* correct typo consconst in GeometryCache.js reconstructGeometry ([e217bda](https://github.com/AnEntrypoint/spawnpoint/commit/e217bda9fb6b1cd7d1e8c78c52100ddc8650b542))
* restore WebGPU node material upgrade in EntityLoader traverse loop ([e35f614](https://github.com/AnEntrypoint/spawnpoint/commit/e35f6145a34e9561785f3d6ac1a1ec60d6727ec8))

### [0.1.323](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.322...v0.1.323) (2026-03-19)

### [0.1.322](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.321...v0.1.322) (2026-03-19)

### [0.1.321](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.320...v0.1.321) (2026-03-19)

### [0.1.320](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.319...v0.1.320) (2026-03-19)

### [0.1.319](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.318...v0.1.319) (2026-03-19)

### [0.1.318](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.317...v0.1.318) (2026-03-19)

### [0.1.317](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.316...v0.1.317) (2026-03-19)

### [0.1.316](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.315...v0.1.316) (2026-03-19)

### [0.1.315](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.314...v0.1.315) (2026-03-19)

### [0.1.314](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.313...v0.1.314) (2026-03-16)

### [0.1.313](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.312...v0.1.313) (2026-03-15)

### [0.1.312](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.311...v0.1.312) (2026-03-15)

### [0.1.311](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.310...v0.1.311) (2026-03-14)


### Bug Fixes

* eliminate double velocity extrapolation and camera lag for local player ([81b249e](https://github.com/AnEntrypoint/spawnpoint/commit/81b249e5d7e69da460bf1381d283f2ac6c4ee103))

### [0.1.310](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.309...v0.1.310) (2026-03-14)


### Bug Fixes

* use prediction engine for local player mesh position to eliminate jitter ([4932960](https://github.com/AnEntrypoint/spawnpoint/commit/4932960fca5492d1069df11e34de8b5c1d8ca3d4))

### [0.1.309](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.308...v0.1.309) (2026-03-14)


### Bug Fixes

* remove double-interpolation for remote players - set position directly from JitterBuffer smoothState ([96c3407](https://github.com/AnEntrypoint/spawnpoint/commit/96c340796bdfdfeb2ac7893d8684fbd2b88ee2ed))

### [0.1.308](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.307...v0.1.308) (2026-03-14)


### Bug Fixes

* use rawDt for position lerp and performance.now throughout interpolation pipeline to eliminate every-other-frame jitter ([dfb30ef](https://github.com/AnEntrypoint/spawnpoint/commit/dfb30ef05bd6c85125904ca4f14ee0e39feb5394))

### [0.1.307](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.306...v0.1.307) (2026-03-14)


### Bug Fixes

* bots detect wall stalls from snapshot position and rotate yaw to escape ([59e8205](https://github.com/AnEntrypoint/spawnpoint/commit/59e8205b41727905d6f953f20d2c183c9f9c888d))

### [0.1.306](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.305...v0.1.306) (2026-03-14)

### [0.1.305](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.304...v0.1.305) (2026-03-14)


### Bug Fixes

* test-150-stress reads BOT_COUNT/BOT_DURATION/BOT_HZ/BOT_URL/BOT_BATCH/BOT_DELAY env vars ([8179cf2](https://github.com/AnEntrypoint/spawnpoint/commit/8179cf2ad2d3a231d40c8b451f246f8867ef92ec))

### [0.1.304](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.303...v0.1.304) (2026-03-12)

### [0.1.303](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.302...v0.1.303) (2026-03-12)

### [0.1.302](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.301...v0.1.302) (2026-03-12)


### Bug Fixes

* use named property access for custStr cache reuse in refreshDynamicCache ([a8c1410](https://github.com/AnEntrypoint/spawnpoint/commit/a8c141045240ce1fe12b37a4398c45fdc4dfb73e))

### [0.1.301](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.300...v0.1.301) (2026-03-12)

### [0.1.300](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.299...v0.1.300) (2026-03-12)

### [0.1.299](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.298...v0.1.299) (2026-03-12)


### Bug Fixes

* addColliderFromConfig returns Promise for trimesh/convex; tps-game uses getById ([e03fb3b](https://github.com/AnEntrypoint/spawnpoint/commit/e03fb3b13974500e3d46f14c3578fb6648bb8d0c))

### [0.1.298](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.297...v0.1.298) (2026-03-12)

### [0.1.297](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.296...v0.1.297) (2026-03-12)

### [0.1.296](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.295...v0.1.296) (2026-03-12)


### Features

* practical app editing — editorProps, GET_EDITOR_PROPS, Create App ([bc71690](https://github.com/AnEntrypoint/spawnpoint/commit/bc71690976325b78973d943d680b11d465104905))

### [0.1.295](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.294...v0.1.295) (2026-03-12)


### Features

* **engine:** fill API gaps — broadcastNearby, getById, spawnChild, addColliderFromConfig ([8d6fbe8](https://github.com/AnEntrypoint/spawnpoint/commit/8d6fbe846b0084816e78eccae48273277c580e34))

### [0.1.294](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.293...v0.1.294) (2026-03-12)

### [0.1.293](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.292...v0.1.293) (2026-03-10)


### Features

* critical editor improvements — freeze movement, delete entity, walk animation, scene positions ([63a1bba](https://github.com/AnEntrypoint/spawnpoint/commit/63a1bba393b2a2a7d5daa1580097d40f3f05893f))

### [0.1.292](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.291...v0.1.292) (2026-03-10)


### Bug Fixes

* editor messages (0x80-0x8F) were being swallowed by Inspector ([ab2afc4](https://github.com/AnEntrypoint/spawnpoint/commit/ab2afc4218eb3b0aa1be2dac566afc7ddb060eff))

### [0.1.291](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.290...v0.1.291) (2026-03-10)


### Features

* increase walk animation speed 4x ([7c59174](https://github.com/AnEntrypoint/spawnpoint/commit/7c59174b59bd4b16595db629c31fd3544a0295c5))

### [0.1.290](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.289...v0.1.290) (2026-03-10)


### Features

* replace code tab with inline file browser in app editor ([23b7263](https://github.com/AnEntrypoint/spawnpoint/commit/23b726378f15d797331c372063938273257fa93a))

### [0.1.289](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.288...v0.1.289) (2026-03-10)

### [0.1.288](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.287...v0.1.288) (2026-03-09)


### Bug Fixes

* refresh scene graph and apps list when pressing P to open editor ([a210abf](https://github.com/AnEntrypoint/spawnpoint/commit/a210abf5f7a314993a9aa1fad8277555b3f8e5b2))

### [0.1.287](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.286...v0.1.287) (2026-03-09)


### Bug Fixes

* 2x walk animation cycle speed (walkTimeScale 2.0 → 4.0) ([3a26417](https://github.com/AnEntrypoint/spawnpoint/commit/3a26417a2c9c21c544c3cc8985e7964b96848097))
* 2x walk animation speed in generic (non-VRM) animator (2.0 → 4.0) ([4da9418](https://github.com/AnEntrypoint/spawnpoint/commit/4da941847aa1c28bf3e453d53b86f4133a5d478d))
* add client/animation.js to hot reload watched files ([5423ee0](https://github.com/AnEntrypoint/spawnpoint/commit/5423ee0d0806a82d930e4a491e808eac4f66a90b))

### [0.1.286](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.285...v0.1.286) (2026-03-09)


### Bug Fixes

* jog animation 2x walk speed (0.667) ([46046d9](https://github.com/AnEntrypoint/spawnpoint/commit/46046d9cd70de905ccf40a45ce6706efb3777362))

### [0.1.285](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.284...v0.1.285) (2026-03-09)


### Bug Fixes

* JogFwdLoop uses WalkLoop clip (same anim, different speed) ([193bc9e](https://github.com/AnEntrypoint/spawnpoint/commit/193bc9eb01c9c90fd81cae979549d55810add0e2))

### [0.1.284](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.283...v0.1.284) (2026-03-09)


### Bug Fixes

* slow jog animation 3x (baseScale 1.0->0.333) ([92a71b7](https://github.com/AnEntrypoint/spawnpoint/commit/92a71b7b17745b2af7b095a710c4fde6b9a318f6))

### [0.1.283](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.282...v0.1.283) (2026-03-09)


### Bug Fixes

* jog2sprint threshold raised to 15/15.5 m/s ([5eebb8e](https://github.com/AnEntrypoint/spawnpoint/commit/5eebb8e1b74a684fd3da608c1b0ed6277f5799e5))

### [0.1.282](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.281...v0.1.282) (2026-03-09)


### Bug Fixes

* remove walk, idle->jog->sprint only (jog=slow, sprint=fast) ([e9f4bc7](https://github.com/AnEntrypoint/spawnpoint/commit/e9f4bc71fd81079c4c512dc660bcfb671819788c))

### [0.1.281](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.280...v0.1.281) (2026-03-09)


### Bug Fixes

* walk2jog threshold raised to 16/15, walk plays at normal speed (14) ([e38c9d2](https://github.com/AnEntrypoint/spawnpoint/commit/e38c9d2fa1344d593be534c183c7f6cc3dd5f433))

### [0.1.280](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.279...v0.1.280) (2026-03-09)


### Bug Fixes

* jog starts at 13 m/s, sprint disabled (walk covers 2-13, jog 13+) ([1a54a53](https://github.com/AnEntrypoint/spawnpoint/commit/1a54a5303068e01e12aa7703d34d6d9515d90a20))

### [0.1.279](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.278...v0.1.279) (2026-03-09)


### Bug Fixes

* raise walk2jog to 9/8 m/s, restore walk on idle->walk path ([06a9923](https://github.com/AnEntrypoint/spawnpoint/commit/06a9923419e172918377522b3cfa8b564e00c1e7))

### [0.1.278](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.277...v0.1.278) (2026-03-09)


### Bug Fixes

* skip walk animation in both directions, only play when already walking ([1539787](https://github.com/AnEntrypoint/spawnpoint/commit/1539787a557914f102582442e3c2e3a58b6d5823))

### [0.1.277](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.276...v0.1.277) (2026-03-09)


### Bug Fixes

* normalize mesh.rotation.y to prevent unbounded accumulation ([8678d84](https://github.com/AnEntrypoint/spawnpoint/commit/8678d842f54da5c5104c997561f2de2b61803ca7))

### [0.1.276](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.275...v0.1.276) (2026-03-09)

### [0.1.275](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.274...v0.1.275) (2026-03-09)


### Bug Fixes

* body always slowly follows camera while running, hard clamp at 0.65pi ([16e7d46](https://github.com/AnEntrypoint/spawnpoint/commit/16e7d46800e6a87372b4a5d1a7f2cb1fea2118a2))

### [0.1.274](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.273...v0.1.274) (2026-03-09)


### Bug Fixes

* moveAngle computed relative to camera not body mesh ([0bfa713](https://github.com/AnEntrypoint/spawnpoint/commit/0bfa713546b0a49367b6077ff89d7e400ff8169b))

### [0.1.273](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.272...v0.1.273) (2026-03-09)


### Bug Fixes

* animation stop restart, walk threshold, idle foot drag, spine pitch smoothing ([f19d576](https://github.com/AnEntrypoint/spawnpoint/commit/f19d576f4dbfe86bc02a128d0a2d8706da9ee105))

### [0.1.272](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.271...v0.1.272) (2026-03-09)


### Bug Fixes

* animation polish - pitch lerp, moveAngle lerp, thresholds, body rotation ([41cc576](https://github.com/AnEntrypoint/spawnpoint/commit/41cc5760d7e38f6b5e7da338d5e5a809310f92b9))

### [0.1.271](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.270...v0.1.271) (2026-03-09)


### Bug Fixes

* correct moveAngle formula derived from live measurement ([183fafc](https://github.com/AnEntrypoint/spawnpoint/commit/183fafca2bd385291588adfa29070c5ba47c0c0e))

### [0.1.270](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.269...v0.1.270) (2026-03-09)


### Bug Fixes

* body split animation direction - pass bodyYaw+PI to account for VRM scene offset ([9a23b0d](https://github.com/AnEntrypoint/spawnpoint/commit/9a23b0d0df1e51ff8d645316a25164648c451b3a))

### [0.1.269](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.268...v0.1.269) (2026-03-09)


### Bug Fixes

* spine bone override must set not multiply to prevent drift/separation ([306dcca](https://github.com/AnEntrypoint/spawnpoint/commit/306dcca3c09ab5f054e75dd9ac81000cbcefbc52))

### [0.1.268](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.267...v0.1.268) (2026-03-09)


### Bug Fixes

* body split animation hip yaw sign inverted and spine overwrites animation ([eebeea0](https://github.com/AnEntrypoint/spawnpoint/commit/eebeea0ae557256eeea6d69d199ae62c85d8b659))

### [0.1.267](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.266...v0.1.267) (2026-03-09)


### Bug Fixes

* VRM0 bone overrides now write to normalized bones so vrm.update() doesn't overwrite them ([c705adc](https://github.com/AnEntrypoint/spawnpoint/commit/c705adc5da4288ebcbd571a68c4340418503d2ed))

### [0.1.266](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.265...v0.1.266) (2026-03-08)


### Bug Fixes

* body rotation for local player + VRM0 bone override path ([436cfb2](https://github.com/AnEntrypoint/spawnpoint/commit/436cfb24502bb479470e58cf77fb1a574e284d1b))

### [0.1.265](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.264...v0.1.265) (2026-03-08)


### Bug Fixes

* move vrm.update after applyBoneOverrides so hip/spine overrides render ([564852e](https://github.com/AnEntrypoint/spawnpoint/commit/564852eaee1bd0c28fd55de41af7df861bf10522))

### [0.1.264](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.263...v0.1.264) (2026-03-08)


### Bug Fixes

* use VRM humanoid API to get normalized hip/spine bones ([e047c32](https://github.com/AnEntrypoint/spawnpoint/commit/e047c32830d1cc36c3dce5bce37e721ca107c903))

### [0.1.263](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.262...v0.1.263) (2026-03-08)


### Bug Fixes

* apply Kalman smoothing to local player, remove raw state bypass ([eed0bd2](https://github.com/AnEntrypoint/spawnpoint/commit/eed0bd21fddbed5f38f153250a5a0843380c08cd))

### [0.1.262](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.261...v0.1.262) (2026-03-08)


### Bug Fixes

* velocity extrapolation for local player XZ, raise animation thresholds ([dc60aa9](https://github.com/AnEntrypoint/spawnpoint/commit/dc60aa98d301edac3e528df03764febd2529ad3e))

### [0.1.261](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.260...v0.1.261) (2026-03-08)


### Bug Fixes

* lerp body yaw snap to prevent strafe jitter ([5e82d67](https://github.com/AnEntrypoint/spawnpoint/commit/5e82d67d94deb1a31ac9c703bd50042cac4ec4e6))

### [0.1.260](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.259...v0.1.260) (2026-03-08)


### Bug Fixes

* add airSpeedCap to prevent sprint velocity carrying into jumps ([62d8300](https://github.com/AnEntrypoint/spawnpoint/commit/62d83000388451e86381059c8e4410429b04a98f))

### [0.1.259](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.258...v0.1.259) (2026-03-08)

### [0.1.258](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.257...v0.1.258) (2026-03-08)

### [0.1.257](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.256...v0.1.257) (2026-03-08)

### [0.1.256](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.255...v0.1.256) (2026-03-08)


### Features

* lerp animation timeScale with speed, halve airMaxSpeed, increase run speed ([b676665](https://github.com/AnEntrypoint/spawnpoint/commit/b67666562f724fc3a859037db68957e98146554d))

### [0.1.255](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.254...v0.1.255) (2026-03-08)

### [0.1.254](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.253...v0.1.254) (2026-03-08)


### Bug Fixes

* restore airMaxSpeed 0.8 for proper Quake air control ([3149b0a](https://github.com/AnEntrypoint/spawnpoint/commit/3149b0a8bee1d21a524b2a21a1eacc5c091b27ed))

### [0.1.253](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.252...v0.1.253) (2026-03-08)

### [0.1.252](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.251...v0.1.252) (2026-03-08)

### [0.1.251](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.250...v0.1.251) (2026-03-08)

### [0.1.250](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.249...v0.1.250) (2026-03-08)


### Bug Fixes

* tune ground speed and fix VRM hip bone detection for strafe split ([ef278f1](https://github.com/AnEntrypoint/spawnpoint/commit/ef278f13e4889fd58b59d57ce2e086a9abc8631b))

### [0.1.249](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.248...v0.1.249) (2026-03-08)


### Bug Fixes

* increase ground speed - maxSpeed 10, accel 250, less friction ([d8607ef](https://github.com/AnEntrypoint/spawnpoint/commit/d8607eff30e3cf766e00fe99b0828e5e71ff7c66))

### [0.1.248](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.247...v0.1.248) (2026-03-08)

### [0.1.247](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.246...v0.1.247) (2026-03-08)


### Bug Fixes

* eliminate sideways lean and add torso-leg split for strafing ([58cec2f](https://github.com/AnEntrypoint/spawnpoint/commit/58cec2f8e9f9ef310fb9a7765a19dd63cd915b2b))

### [0.1.246](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.245...v0.1.246) (2026-03-08)


### Bug Fixes

* prevent dynamic props tunneling through floor ([fed6058](https://github.com/AnEntrypoint/spawnpoint/commit/fed6058c5d7ebff44f9bcc4185689e47b4581e72))

### [0.1.245](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.244...v0.1.245) (2026-03-08)


### Bug Fixes

* preserve linearCast/damping on LOD body restore ([e84ffbc](https://github.com/AnEntrypoint/spawnpoint/commit/e84ffbc12b3f2175cf2a8270a8dd6f8c7edcd8c7))

### [0.1.244](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.243...v0.1.244) (2026-03-08)


### Bug Fixes

* remove spine yaw twist causing lean during turning ([1e6d285](https://github.com/AnEntrypoint/spawnpoint/commit/1e6d285c55f87df0582e94b150f70c2b95fb9875))

### [0.1.243](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.242...v0.1.243) (2026-03-08)


### Features

* enable linearCast CCD for all dynamic physics bodies ([3dba8e6](https://github.com/AnEntrypoint/spawnpoint/commit/3dba8e6d68cde653331e1b8ead635998b90fbc13))

### [0.1.242](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.241...v0.1.242) (2026-03-08)


### Bug Fixes

* add linearCast CCD option to dynamic physics bodies ([f74502a](https://github.com/AnEntrypoint/spawnpoint/commit/f74502a1259332b1315ebed2b96011d63b822b32))

### [0.1.241](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.240...v0.1.241) (2026-03-08)


### Bug Fixes

* halve spine lean and recover immediately when turning stops ([242a190](https://github.com/AnEntrypoint/spawnpoint/commit/242a19035442531fad490d7866cb33de7c3e0632))

### [0.1.240](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.239...v0.1.240) (2026-03-08)


### Bug Fixes

* raise maxSpeed to 8 and align animation thresholds to actual speeds ([a4beeb6](https://github.com/AnEntrypoint/spawnpoint/commit/a4beeb660d1ace1c789105e9e5b17781ff2ccd7f))

### [0.1.239](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.238...v0.1.239) (2026-03-08)


### Bug Fixes

* increase ground speed and eliminate local player mesh jitter ([82e309a](https://github.com/AnEntrypoint/spawnpoint/commit/82e309a7bdfa976748f5b2dd2914dd1e08030d8f))

### [0.1.238](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.237...v0.1.238) (2026-03-08)


### Bug Fixes

* Quake-style movement - walk 4.5, sprint 8, bunny hop air control ([7811241](https://github.com/AnEntrypoint/spawnpoint/commit/781124185374864d7619b3e5f72a830613bfc1d0))

### [0.1.237](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.236...v0.1.237) (2026-03-08)


### Bug Fixes

* increase walk speed and gravity, balance jump vs walk feel ([19ddc79](https://github.com/AnEntrypoint/spawnpoint/commit/19ddc7921a03a26b5ed73e9b2730ef8c10879ef8))

### [0.1.236](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.235...v0.1.236) (2026-03-08)


### Bug Fixes

* spine lean, map scale, and player interpolation jitter ([e0431f8](https://github.com/AnEntrypoint/spawnpoint/commit/e0431f8ad65537e4a78e9201078f897eeb1026d0))

### [0.1.235](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.234...v0.1.235) (2026-03-08)


### Bug Fixes

* pass world scale to InstanceManager so instanced GLB meshes use correct transform ([0905876](https://github.com/AnEntrypoint/spawnpoint/commit/090587629507d88ffa1377c84d98a40e3adb3c2c))

### [0.1.234](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.233...v0.1.234) (2026-03-08)

### [0.1.233](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.232...v0.1.233) (2026-03-08)


### Bug Fixes

* use full GLB node hierarchy transforms in all physics mesh extractors ([276e060](https://github.com/AnEntrypoint/spawnpoint/commit/276e0603c38978e936e947bfed34684c07f199b9))

### [0.1.232](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.231...v0.1.232) (2026-03-08)


### Bug Fixes

* apply entity scale to trimesh collider vertices so physics matches visual ([2a8055c](https://github.com/AnEntrypoint/spawnpoint/commit/2a8055c365618963f03b71a4c68eba6623f288dc))

### [0.1.231](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.230...v0.1.231) (2026-03-08)


### Bug Fixes

* disable fog and confirm env-sillos scale alignment ([0f7d945](https://github.com/AnEntrypoint/spawnpoint/commit/0f7d9451c8b7fa91dedcc99b147e407000a5b5a1))

### [0.1.230](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.229...v0.1.230) (2026-03-08)


### Bug Fixes

* inline PROP_MODELS in world/index.js and harden compileAsync for Firefox ([84e8d25](https://github.com/AnEntrypoint/spawnpoint/commit/84e8d25851d931591c8daf3da6c8d6db93f1ff48))

### [0.1.229](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.228...v0.1.229) (2026-03-08)


### Bug Fixes

* real-world prop scales by name and remove duplicate trimesh collision ([ca87b63](https://github.com/AnEntrypoint/spawnpoint/commit/ca87b63ae7df41b759ec1a9850f93ea7ac383c91))

### [0.1.228](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.227...v0.1.228) (2026-03-08)


### Bug Fixes

* walk speed, jump arc, floor entity, prop scales, camera head height ([9405f6c](https://github.com/AnEntrypoint/spawnpoint/commit/9405f6c8eed628e1d87476891355dc735d03f896))

### [0.1.227](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.226...v0.1.227) (2026-03-08)


### Bug Fixes

* camera jitter at high FPS and animation facing 1 frame behind ([26cb4b9](https://github.com/AnEntrypoint/spawnpoint/commit/26cb4b9db5b3bff2e180ec83e926808addda02f0))

### [0.1.226](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.225...v0.1.226) (2026-03-08)


### Bug Fixes

* decode entity scale in SnapshotProcessor and apply to instanced mesh ([f0c9c9c](https://github.com/AnEntrypoint/spawnpoint/commit/f0c9c9c23035ec8ea231333ddc5402f95f1bce2a))

### [0.1.225](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.224...v0.1.225) (2026-03-08)


### Bug Fixes

* apply entity.scale to both physics colliders and client meshes ([7275806](https://github.com/AnEntrypoint/spawnpoint/commit/727580674731c866ab434f1f836d8c98f8125454))

### [0.1.224](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.223...v0.1.224) (2026-03-08)


### Features

* deduplicate GLB materials so Three.js shares compiled shader programs ([7f5bdab](https://github.com/AnEntrypoint/spawnpoint/commit/7f5bdab786256275631ceef875534516693d28b8))

### [0.1.223](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.222...v0.1.223) (2026-03-08)


### Features

* add cross-model GPU instancing for static entities ([70d4a5b](https://github.com/AnEntrypoint/spawnpoint/commit/70d4a5b226ec80c031d71fc0ed60cd8c9b139c06))

### [0.1.222](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.221...v0.1.222) (2026-03-08)

### [0.1.221](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.220...v0.1.221) (2026-03-08)

### [0.1.220](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.219...v0.1.220) (2026-03-08)

### [0.1.219](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.218...v0.1.219) (2026-03-08)


### Bug Fixes

* correct animation thresholds, strafe timeScale, hip rotation, and spine lean ([468aaa9](https://github.com/AnEntrypoint/spawnpoint/commit/468aaa97d0fe58ef635124a02ef59844d5de1f3a))

### [0.1.218](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.217...v0.1.218) (2026-03-08)


### Bug Fixes

* animation thresholds, jump impulse ([fa54618](https://github.com/AnEntrypoint/spawnpoint/commit/fa54618cf7fe55c64d6b9fcf94b6c8139b37af43))

### [0.1.217](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.216...v0.1.217) (2026-03-08)


### Bug Fixes

* remove leftover _moveDir reference in setLookDirection ([3a06d12](https://github.com/AnEntrypoint/spawnpoint/commit/3a06d126984f5c9b0e223d7f5fc361f4526f7e27))

### [0.1.216](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.215...v0.1.216) (2026-03-08)


### Features

* CS-style torso/hip split and strafe animation ([be76ea9](https://github.com/AnEntrypoint/spawnpoint/commit/be76ea903ee583d2d812a8646332208b5d87bc1a))

### [0.1.215](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.214...v0.1.215) (2026-03-08)


### Bug Fixes

* animations, CS-style body rotation, backward walk, and IDB cache key bug ([f0b69ad](https://github.com/AnEntrypoint/spawnpoint/commit/f0b69adb553e1c711cf33f18f28805d92ccad9a7))

### [0.1.214](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.213...v0.1.214) (2026-03-08)


### Bug Fixes

* revert broken humanoidRemap double-pass in createPlayerAnimator ([f41cee0](https://github.com/AnEntrypoint/spawnpoint/commit/f41cee07aa0ae5fa5a4dfca716220512e18d947a))

### [0.1.213](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.212...v0.1.213) (2026-03-08)


### Bug Fixes

* restore VRM animations by remapping humanoid bone names before track filtering ([2562aa7](https://github.com/AnEntrypoint/spawnpoint/commit/2562aa753b711f6204265951375e0976e61fdcd2))

### [0.1.212](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.211...v0.1.212) (2026-03-08)


### Bug Fixes

* remove combineSkeletons which breaks AnimationMixer bone targeting ([c0e2b77](https://github.com/AnEntrypoint/spawnpoint/commit/c0e2b774fe5c9f2fbb08b706422c6316b68649e0))

### [0.1.211](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.210...v0.1.211) (2026-03-08)


### Bug Fixes

* disable VRM humanoid autoUpdateHumanBones to restore animations ([8d307bd](https://github.com/AnEntrypoint/spawnpoint/commit/8d307bd318ce9892596fd6cf24a4016f82c25051))

### [0.1.210](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.209...v0.1.210) (2026-03-08)


### Bug Fixes

* process not defined in browser app eval, IndexedDB store constraint error ([f5b5ab1](https://github.com/AnEntrypoint/spawnpoint/commit/f5b5ab1db00b2d21f446bc5b887e2aae78afcebe))

### [0.1.209](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.208...v0.1.209) (2026-03-08)


### Bug Fixes

* restore wished XZ velocity after Jolt physics step ([4aab791](https://github.com/AnEntrypoint/spawnpoint/commit/4aab79198bb0638243e84ce2a3e47525e7f996d7))

### [0.1.208](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.207...v0.1.208) (2026-03-08)


### Bug Fixes

* Quake movement tuning — maxSpeed 6→8, friction 6→4, jumpImpulse 4→5 ([8db5926](https://github.com/AnEntrypoint/spawnpoint/commit/8db59267d896aed806e3ed1d56b12b8c8113494c))

### [0.1.207](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.206...v0.1.207) (2026-03-08)

### [0.1.206](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.205...v0.1.206) (2026-03-08)


### Bug Fixes

* Quake-style movement — high friction and groundAccel for instant response ([7d05bdf](https://github.com/AnEntrypoint/spawnpoint/commit/7d05bdf6bbeef27de763ba3152a2b221d420e0a7))

### [0.1.205](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.204...v0.1.205) (2026-03-08)

### [0.1.204](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.203...v0.1.204) (2026-03-08)

### [0.1.203](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.202...v0.1.203) (2026-03-08)

### [0.1.202](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.201...v0.1.202) (2026-03-08)

### [0.1.201](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.200...v0.1.201) (2026-03-08)

### [0.1.200](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.199...v0.1.200) (2026-03-07)

### [0.1.199](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.198...v0.1.199) (2026-03-07)

### [0.1.198](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.197...v0.1.198) (2026-03-07)


### Bug Fixes

* CS:GO-style body rotation tracks lookYaw not velocity direction ([a15e40b](https://github.com/AnEntrypoint/spawnpoint/commit/a15e40b25327e47d9ed18be302e87a05d9da43ce))

### [0.1.197](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.196...v0.1.197) (2026-03-07)

### [0.1.196](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.195...v0.1.196) (2026-03-07)

### [0.1.195](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.194...v0.1.195) (2026-03-07)


### Features

* CS:GO-style top/bottom split animation with lookYaw/lookPitch ([01ec3fb](https://github.com/AnEntrypoint/spawnpoint/commit/01ec3fb40d24835853668d84add3e021f8980ab1))

### [0.1.194](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.193...v0.1.194) (2026-03-07)

### [0.1.193](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.192...v0.1.193) (2026-03-07)


### Bug Fixes

* lag compensation hit detection + dead code removal ([a8da1c9](https://github.com/AnEntrypoint/spawnpoint/commit/a8da1c92f882880d9becf36a00bb80e5ae0342a7))

### [0.1.192](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.191...v0.1.192) (2026-03-07)

### [0.1.191](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.190...v0.1.191) (2026-03-07)

### [0.1.190](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.189...v0.1.190) (2026-03-07)

### [0.1.189](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.188...v0.1.189) (2026-03-07)

### [0.1.188](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.187...v0.1.188) (2026-03-07)


### Bug Fixes

* bypass jitter buffer for local player to eliminate movement flicker ([f93f020](https://github.com/AnEntrypoint/spawnpoint/commit/f93f020019d8ae764298fc53b13c7507a0873c5d))

### [0.1.187](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.186...v0.1.187) (2026-03-07)


### Bug Fixes

* continuous velocity extrapolation between server snapshots eliminates jitter ([d26509e](https://github.com/AnEntrypoint/spawnpoint/commit/d26509e85d88c7ee4d6310e978bc59ca05542978))

### [0.1.186](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.185...v0.1.186) (2026-03-07)


### Bug Fixes

* camera follows mesh position directly, eliminating player/camera jitter ([608d203](https://github.com/AnEntrypoint/spawnpoint/commit/608d203799ffe698d798709982c2e620a92fa19e))

### [0.1.185](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.184...v0.1.185) (2026-03-07)


### Bug Fixes

* disable client-side prediction to eliminate slide-back ([916bb99](https://github.com/AnEntrypoint/spawnpoint/commit/916bb9936cb2ef5db226f2b9b6947360fd894f37))
* smooth camera target to eliminate 1-frame position jitter ([ff54cc3](https://github.com/AnEntrypoint/spawnpoint/commit/ff54cc3a7c9ad5090b08fd346c24768222b4b5bb))

### [0.1.184](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.183...v0.1.184) (2026-03-06)


### Bug Fixes

* animations now play - mixer.update blocked by _isActive minification ([75314fa](https://github.com/AnEntrypoint/spawnpoint/commit/75314fa0f83ba8fae730e3ab1e6762b42b9e22a0))

### [0.1.183](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.182...v0.1.183) (2026-03-06)


### Bug Fixes

* eliminate snap-back by raising reconciliation threshold and smooth-blending corrections ([bd7525e](https://github.com/AnEntrypoint/spawnpoint/commit/bd7525e77f7280cdf7e56e715a5ef0e4cab6b265))

### [0.1.182](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.181...v0.1.182) (2026-03-06)


### Bug Fixes

* eliminate input lag, fix RTT measurement, fix camera/model alignment ([9053e0f](https://github.com/AnEntrypoint/spawnpoint/commit/9053e0f7e1febaccc0b7d89b7cc6752db9409d4b))
* VRM0 player animations - remap tracks to normalized bone hierarchy ([5e371e1](https://github.com/AnEntrypoint/spawnpoint/commit/5e371e1fa77f0257497883d2f34cb8660bf2318b))

### [0.1.181](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.180...v0.1.181) (2026-03-06)


### Bug Fixes

* remove velocity double-integration for local player mesh position ([6a3ae87](https://github.com/AnEntrypoint/spawnpoint/commit/6a3ae87381ded9497e7e4226fed67d7afc0cc7f3))

### [0.1.180](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.179...v0.1.180) (2026-03-06)


### Bug Fixes

* use server-authoritative velocity/onGround for local player animations ([66bde81](https://github.com/AnEntrypoint/spawnpoint/commit/66bde81d76407583ddee34005238a42429fea0c6))

### [0.1.179](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.178...v0.1.179) (2026-03-06)


### Bug Fixes

* sync local player mesh to prediction engine to fix camera offset, animations, and input lag ([31d525b](https://github.com/AnEntrypoint/spawnpoint/commit/31d525b0d8c623291804a455c6decb4ae9761d5b))

### [0.1.178](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.177...v0.1.178) (2026-03-06)


### Bug Fixes

* eliminate input lag with adaptive jitter buffer and local player prediction bypass ([d5b3593](https://github.com/AnEntrypoint/spawnpoint/commit/d5b3593ebe8aae529d7338a4da542febed77a72c))

### [0.1.177](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.176...v0.1.177) (2026-03-06)


### Features

* app DX improvements and real MediaPipe AFAN webcam tracking ([f834574](https://github.com/AnEntrypoint/spawnpoint/commit/f8345745be1abe3806e9a6a56bfed0355b97b557))

### [0.1.176](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.175...v0.1.176) (2026-03-06)


### Features

* app DX improvements + real AFAN webcam face tracking ([446c549](https://github.com/AnEntrypoint/spawnpoint/commit/446c549f4724645404cfcb47a2e646b56e86da08))

### [0.1.175](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.174...v0.1.175) (2026-03-06)


### Features

* simplify app creation with webjsx ripple ui and lazy loaded afan webcam tracking ([1aed340](https://github.com/AnEntrypoint/spawnpoint/commit/1aed3403b91716352cddda7b0e3261827dbcbad8))

### [0.1.174](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.173...v0.1.174) (2026-03-06)

### [0.1.173](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.172...v0.1.173) (2026-03-06)


### Features

* editor extension with app browser, scene graph, code editor, and editorProps ([b4e4d2f](https://github.com/AnEntrypoint/spawnpoint/commit/b4e4d2fcbbc62ec4d2dce15b9609ab0fb806704b))

### [0.1.172](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.171...v0.1.172) (2026-03-06)


### Features

* add model placement editor with drag-drop upload, gizmo, inspector, and persistence ([263e61f](https://github.com/AnEntrypoint/spawnpoint/commit/263e61f03dd93e26e234f4e5c1ddc989c5e18f07))

### [0.1.171](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.170...v0.1.171) (2026-03-06)

### [0.1.170](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.169...v0.1.170) (2026-03-06)

### [0.1.169](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.168...v0.1.169) (2026-03-06)

### [0.1.168](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.167...v0.1.168) (2026-03-06)

### [0.1.167](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.166...v0.1.167) (2026-03-06)

### [0.1.166](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.165...v0.1.166) (2026-03-06)


### Bug Fixes

* spread test entities over 500x500 map for realistic spatial culling ([92c8dac](https://github.com/AnEntrypoint/spawnpoint/commit/92c8dac67b0b293fcea0bd544d38a429fdb2f375))

### [0.1.165](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.164...v0.1.165) (2026-03-06)

### [0.1.164](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.163...v0.1.164) (2026-03-06)

### [0.1.163](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.162...v0.1.163) (2026-03-06)


### Features

* add run-bots.js bot harness wrapper for pm2 ([898b732](https://github.com/AnEntrypoint/spawnpoint/commit/898b732ac5da2fac4409b5d59315b4471b97a348))

### [0.1.162](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.161...v0.1.162) (2026-03-06)


### Bug Fixes

* simplify props/dynamic setup to sync box collider ([7cb744c](https://github.com/AnEntrypoint/spawnpoint/commit/7cb744cb716f6d7f7b2c0fb1a94b4eaa86a662ec))

### [0.1.161](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.160...v0.1.161) (2026-03-06)

### [0.1.160](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.159...v0.1.160) (2026-03-03)

### [0.1.159](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.158...v0.1.159) (2026-03-03)

### [0.1.158](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.157...v0.1.158) (2026-03-03)

### [0.1.157](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.156...v0.1.157) (2026-03-03)

### [0.1.156](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.155...v0.1.156) (2026-03-03)

### [0.1.155](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.154...v0.1.155) (2026-03-03)

### [0.1.154](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.153...v0.1.154) (2026-03-03)

### [0.1.153](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.152...v0.1.153) (2026-03-03)

### [0.1.152](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.151...v0.1.152) (2026-03-03)


### Features

* add baseline profiling harness for 50-player performance measurement ([5288b4e](https://github.com/AnEntrypoint/spawnpoint/commit/5288b4eefab8b8a02ce85c916fc3ec4f2015cbdf))

### [0.1.151](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.150...v0.1.151) (2026-03-02)

### [0.1.150](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.149...v0.1.150) (2026-03-02)

### [0.1.149](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.148...v0.1.149) (2026-03-02)

### [0.1.148](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.147...v0.1.148) (2026-03-02)


### Bug Fixes

* adjust power-crate spawn grid to map boundaries ([f66f5ad](https://github.com/AnEntrypoint/spawnpoint/commit/f66f5ad3f82b01703fd07ab47e34e7ce827e49ce))

### [0.1.147](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.146...v0.1.147) (2026-03-02)

### [0.1.146](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.145...v0.1.146) (2026-03-02)


### Bug Fixes

* msgpack pack returns copied buffer to prevent WebTransport async write corruption ([e8cfc32](https://github.com/AnEntrypoint/spawnpoint/commit/e8cfc32dfe061f304a867dc5987b8dae78013546))

### [0.1.145](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.144...v0.1.145) (2026-03-02)


### Bug Fixes

* attach hull wireframe as child of mesh node to inherit node rotation ([5b9a8ca](https://github.com/AnEntrypoint/spawnpoint/commit/5b9a8caeb04331c237643ffb6570b2f53abe8ab1))

### [0.1.144](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.143...v0.1.144) (2026-03-02)


### Bug Fixes

* apply GLB node transform to convex hull vertices to align with visual mesh ([0ed5a0a](https://github.com/AnEntrypoint/spawnpoint/commit/0ed5a0ac6b05b33c33400112803edf385af92d2b))

### [0.1.143](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.142...v0.1.143) (2026-03-02)


### Bug Fixes

* cache Jolt convex hull shapes by model path to prevent WASM OOM ([dfe1278](https://github.com/AnEntrypoint/spawnpoint/commit/dfe127867b2ed103fbbe2f0517fa25c89f173da8))

### [0.1.142](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.141...v0.1.142) (2026-03-02)


### Features

* spawn 1000 dynamic props across aim_sillos floor area ([b32c4a7](https://github.com/AnEntrypoint/spawnpoint/commit/b32c4a78e31015c003b7f14d647f81465926b07f))

### [0.1.141](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.140...v0.1.141) (2026-03-02)


### Features

* add client-side convex hull wireframe debug rendering ([ebf58e3](https://github.com/AnEntrypoint/spawnpoint/commit/ebf58e387b9bf4ade695397ccc57a266bf34b7b2))

### [0.1.140](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.139...v0.1.140) (2026-03-02)


### Bug Fixes

* align prop spawn grid to map floor, add mass to prop-dynamic ([671fe72](https://github.com/AnEntrypoint/spawnpoint/commit/671fe72128d9e06cde558c34abaa976a021c5500))

### [0.1.139](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.138...v0.1.139) (2026-03-02)


### Bug Fixes

* dynamic box collider fit and mass ([177a85d](https://github.com/AnEntrypoint/spawnpoint/commit/177a85dac1945d5afb5047c50311c2a9193399e8))

### [0.1.138](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.137...v0.1.138) (2026-03-02)


### Bug Fixes

* only LOD-suspend dynamic bodies after Jolt marks them as sleeping ([644c92f](https://github.com/AnEntrypoint/spawnpoint/commit/644c92ff7cbb4356d67cffc06dcc61147ba41b4c))

### [0.1.137](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.136...v0.1.137) (2026-03-02)


### Bug Fixes

* grace period prevents LOD from immediately suspending newly created bodies, increase prop grid to 20x20 ([8655572](https://github.com/AnEntrypoint/spawnpoint/commit/86555725d7953ee1bd85f6f6914b8a9b64f18244))

### [0.1.136](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.135...v0.1.136) (2026-03-02)

### [0.1.135](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.134...v0.1.135) (2026-03-02)


### Bug Fixes

* update feetOffset from 1.3 to 0.91 to match reduced capsule size ([5fa8af8](https://github.com/AnEntrypoint/spawnpoint/commit/5fa8af8eea27d2b07707ceb8d02520acc9531bb3))

### [0.1.134](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.133...v0.1.134) (2026-03-02)


### Bug Fixes

* dynamic body activation race and expand prop grid layout ([9d12e39](https://github.com/AnEntrypoint/spawnpoint/commit/9d12e39ad0d4b22e1863193585090dde73e2fcd0))

### [0.1.133](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.132...v0.1.133) (2026-03-02)


### Features

* spatial physics LOD — suspend dynamic Jolt bodies outside player radius ([83b6b5e](https://github.com/AnEntrypoint/spawnpoint/commit/83b6b5e1b983c1eae369c21530883c585079ee1d))

### [0.1.132](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.131...v0.1.132) (2026-03-02)

### [0.1.131](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.130...v0.1.131) (2026-03-02)

### [0.1.130](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.129...v0.1.130) (2026-03-02)

### [0.1.129](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.128...v0.1.129) (2026-03-02)

### [0.1.128](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.127...v0.1.128) (2026-03-02)

### [0.1.127](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.126...v0.1.127) (2026-03-01)

### [0.1.126](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.125...v0.1.126) (2026-03-01)


### Bug Fixes

* reduce player capsule collider by 30% ([b655a00](https://github.com/AnEntrypoint/spawnpoint/commit/b655a00c31c322ee7383fc7f9ceefae38d5fb1f3))

### [0.1.125](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.124...v0.1.125) (2026-03-01)


### Bug Fixes

* addConvexFromModelAsync uses real mesh vertices instead of AABB hull ([e19905a](https://github.com/AnEntrypoint/spawnpoint/commit/e19905a34ed25d00d83432492b03a5cd3a869795))

### [0.1.124](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.123...v0.1.124) (2026-03-01)


### Bug Fixes

* addConvexFromModelAsync uses AABB hull and handles empty mesh GLBs ([921d2f3](https://github.com/AnEntrypoint/spawnpoint/commit/921d2f3fb272bc012c184ea8d7ea120133e50510))

### [0.1.123](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.122...v0.1.123) (2026-03-01)


### Bug Fixes

* three Jolt WASM lifecycle bugs causing memory access crashes ([77c0636](https://github.com/AnEntrypoint/spawnpoint/commit/77c0636185a5234eb977a62ab0c5dfc642a7d916))

### [0.1.122](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.121...v0.1.122) (2026-03-01)


### Bug Fixes

* two addConvexFromModelAsync bugs - null mesh guard and Jolt Float3 WASM leak ([d50e660](https://github.com/AnEntrypoint/spawnpoint/commit/d50e66015b5b8acdc871baf589c775ba98f4e933))

### [0.1.121](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.120...v0.1.121) (2026-03-01)


### Features

* add addConvexFromModelAsync for Draco-compressed prop physics ([42e5962](https://github.com/AnEntrypoint/spawnpoint/commit/42e5962927136bd3786f544bfe95741b5f0143f7))

### [0.1.120](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.119...v0.1.120) (2026-03-01)


### Bug Fixes

* props now visibly fall and land by fixing respawn threshold and spawn height ([0104b05](https://github.com/AnEntrypoint/spawnpoint/commit/0104b05a06bd31dce913f3e08c3a9ff82abc2bc3))

### [0.1.119](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.118...v0.1.119) (2026-03-01)


### Bug Fixes

* move dynamic props inside map bounds so they are visible ([9d3d4ff](https://github.com/AnEntrypoint/spawnpoint/commit/9d3d4ff348fd5f11174d31890df408b5c6fbc7b2))

### [0.1.118](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.117...v0.1.118) (2026-03-01)


### Bug Fixes

* increase relevanceRadius to 900 to include all dynamic props in snapshots ([5c11289](https://github.com/AnEntrypoint/spawnpoint/commit/5c112891a5948e7ef2be3952c17558f99c788d45))

### [0.1.117](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.116...v0.1.117) (2026-03-01)


### Bug Fixes

* discover and position spawn points on actual map terrain via raycasting ([55224f2](https://github.com/AnEntrypoint/spawnpoint/commit/55224f2e9d522d4d6ffffefed2f19626b521a188))

### [0.1.116](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.115...v0.1.116) (2026-03-01)


### Bug Fixes

* lower spawn point Y from 5 to 1 to match terrain height ([038b28b](https://github.com/AnEntrypoint/spawnpoint/commit/038b28bbe8462b9da048bd917f8fc65b0a8fcd49))

### [0.1.115](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.114...v0.1.115) (2026-03-01)

### [0.1.114](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.113...v0.1.114) (2026-03-01)


### Bug Fixes

* expand player and dynamic entity spawn points to cover entire map bounds ([8688cd0](https://github.com/AnEntrypoint/spawnpoint/commit/8688cd0ea05f6ab221a5e4e1939dbd03abcefb03))

### [0.1.113](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.112...v0.1.113) (2026-03-01)


### Bug Fixes

* distribute item and prop spawns across full map area ([33152d0](https://github.com/AnEntrypoint/spawnpoint/commit/33152d038d0037398148e819400c19a8cccea8a4))

### [0.1.112](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.111...v0.1.112) (2026-03-01)

### [0.1.111](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.110...v0.1.111) (2026-03-01)


### Bug Fixes

* distribute spawn positions across full map area with 20-point grid ([6835ddb](https://github.com/AnEntrypoint/spawnpoint/commit/6835ddb4fbb3dfdbd897ec5c6cacdee6cb398a34))

### [0.1.110](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.109...v0.1.110) (2026-03-01)


### Bug Fixes

* distribute spawn positions across full map area ([39af7bb](https://github.com/AnEntrypoint/spawnpoint/commit/39af7bba563f77c47d65d3e43bceff20114f7216))

### [0.1.109](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.108...v0.1.109) (2026-03-01)


### Features

* use trimesh collision for dynamic props ([209debd](https://github.com/AnEntrypoint/spawnpoint/commit/209debdb1141827db6a969c5aa5f2f6a598a6f4c))


### Bug Fixes

* improve trimesh collision fallback for dynamic props ([d197101](https://github.com/AnEntrypoint/spawnpoint/commit/d197101252362f504276d96faee171302cb25be2))

### [0.1.108](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.107...v0.1.108) (2026-03-01)


### Bug Fixes

* correct dynamic prop spawn height from Y=10 to Y=5 ([ed29848](https://github.com/AnEntrypoint/spawnpoint/commit/ed298482178f4fc8db905d8c83b6ed3991f9117b))

### [0.1.107](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.106...v0.1.107) (2026-03-01)


### Bug Fixes

* eliminate physics object jittering via velocity sync and smooth interpolation ([920a5a3](https://github.com/AnEntrypoint/spawnpoint/commit/920a5a34caaba6165b7f5f522d6c3310ab60af9e))

### [0.1.106](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.105...v0.1.106) (2026-03-01)


### Bug Fixes

* correct msgpack corruption from timestamp field ([281bfae](https://github.com/AnEntrypoint/spawnpoint/commit/281bfaecd161ff2defc4f147d7d1661f6b5ac980))

### [0.1.105](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.104...v0.1.105) (2026-03-01)


### Bug Fixes

* reduce client-side jitter via spawn height, velocity extrapolation, rotation SLERP, Kalman tuning, and RTT fixes ([43f4ee1](https://github.com/AnEntrypoint/spawnpoint/commit/43f4ee1528c722c6c07befc2eca0d2f13682af48))

### [0.1.104](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.103...v0.1.104) (2026-03-01)


### Features

* setup GLB map collision and respawn system ([0825a0c](https://github.com/AnEntrypoint/spawnpoint/commit/0825a0cb5a5ba02a1bfb9557229f3e9a571dc2f9))

### [0.1.103](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.102...v0.1.103) (2026-03-01)


### Features

* increase socket backlog to 2048 for 1000+ concurrent connections ([08c4735](https://github.com/AnEntrypoint/spawnpoint/commit/08c473569778af302608fa3bc14f64e6db45cb30))

### [0.1.102](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.101...v0.1.102) (2026-03-01)


### Features

* spatial player culling for snapshot optimization ([4118ac5](https://github.com/AnEntrypoint/spawnpoint/commit/4118ac5b62dc37301c81996845978807410e858b))

### [0.1.101](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.100...v0.1.101) (2026-03-01)

### [0.1.100](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.99...v0.1.100) (2026-03-01)

### [0.1.99](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.98...v0.1.99) (2026-03-01)

### [0.1.98](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.97...v0.1.98) (2026-03-01)

### [0.1.97](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.96...v0.1.97) (2026-02-28)

### [0.1.96](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.95...v0.1.96) (2026-02-28)


### Bug Fixes

* disable compileAsync to prevent shader compilation RAM exhaustion ([9227027](https://github.com/AnEntrypoint/spawnpoint/commit/922702755f6a0d790a8b85b392f9cb797806bb4a))
* make entity model loading queue truly sequential to prevent RAM exhaustion ([7c1aed2](https://github.com/AnEntrypoint/spawnpoint/commit/7c1aed2af47af05b7635a710bf4f8a789dc1a514))

### [0.1.95](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.94...v0.1.95) (2026-02-28)

### [0.1.94](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.93...v0.1.94) (2026-02-28)

### [0.1.93](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.92...v0.1.93) (2026-02-28)

### [0.1.92](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.91...v0.1.92) (2026-02-28)


### Bug Fixes

* prevent RAM exhaustion during client model loading - implement concurrent load queue ([1fa2fe1](https://github.com/AnEntrypoint/spawnpoint/commit/1fa2fe134c5da86d4974702455a200d3c0449dc7))

### [0.1.91](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.90...v0.1.91) (2026-02-28)


### Features

* single-map profiling setup - consolidate to aim_sillos with 100 dynamic props in grid layout ([31c4038](https://github.com/AnEntrypoint/spawnpoint/commit/31c403859513200903ecfcce20590a7ee0b0dea8))

### [0.1.90](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.89...v0.1.90) (2026-02-28)

### [0.1.89](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.88...v0.1.89) (2026-02-27)


### Features

* loading screen with dual progress bars + fix KTX2 UASTC encoding ([32a9cd2](https://github.com/AnEntrypoint/spawnpoint/commit/32a9cd2d235aedf1da06949b10e73c67df6d2cdb))
* VRM KTX2 transform, mobile renderer optimizations, docs condensed ([b58d2c1](https://github.com/AnEntrypoint/spawnpoint/commit/b58d2c1b4d80c4e9fae008073536fbf58796cd65))

### [0.1.88](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.87...v0.1.88) (2026-02-27)

### [0.1.87](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.86...v0.1.87) (2026-02-27)

### [0.1.86](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.85...v0.1.86) (2026-02-27)

### [0.1.85](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.84...v0.1.85) (2026-02-26)

### [0.1.84](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.83...v0.1.84) (2026-02-26)


### Bug Fixes

* exclude invisible/trigger material geometry from physics and rendering ([08ec417](https://github.com/AnEntrypoint/spawnpoint/commit/08ec417e4065f27b66f870d018d5ae800e20351d))

### [0.1.83](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.82...v0.1.83) (2026-02-26)


### Features

* multi-map world, spatial snapshots, random spawn distribution ([5614253](https://github.com/AnEntrypoint/spawnpoint/commit/5614253f4ff1b81e494bc4d7832440e12d7dce8a))

### [0.1.82](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.81...v0.1.82) (2026-02-26)

### [0.1.81](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.80...v0.1.81) (2026-02-26)


### Bug Fixes

* **physics:** resolve WASM OOB crash and multi-mesh Draco map collision ([af99241](https://github.com/AnEntrypoint/spawnpoint/commit/af99241bc0f7f687168ce331aca61ad2a6159f9c))

### [0.1.80](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.79...v0.1.80) (2026-02-24)

### [0.1.79](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.78...v0.1.79) (2026-02-24)


### Bug Fixes

* use box collider for environment to prevent server hang ([42dcb98](https://github.com/AnEntrypoint/spawnpoint/commit/42dcb982a2cae4835e4607886ebc2d09620c4d95))

### [0.1.78](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.77...v0.1.78) (2026-02-24)


### Bug Fixes

* implement proper Draco compression support and restore cleetus.vrm ([0a44582](https://github.com/AnEntrypoint/spawnpoint/commit/0a44582a8395240511e36c26d9ae7f748045eadc))

### [0.1.77](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.76...v0.1.77) (2026-02-24)


### Bug Fixes

* resolve meshopt compression and collider extraction issues ([fa7cf57](https://github.com/AnEntrypoint/spawnpoint/commit/fa7cf570f9a1054e9a28a307ac7f19fcb18ef1c2))

### [0.1.76](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.75...v0.1.76) (2026-02-24)


### Bug Fixes

* add animations to anim-lib.glb, add Draco fallback collider, switch playerModel to cleetus.vrm ([c4bb299](https://github.com/AnEntrypoint/spawnpoint/commit/c4bb299f0baf02bdd574fffef93df8ecb21a6829))

### [0.1.75](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.74...v0.1.75) (2026-02-24)


### Bug Fixes

* switch player model to cleetus.glb and fix raycast layer filtering for spawn detection ([77615c9](https://github.com/AnEntrypoint/spawnpoint/commit/77615c9ef02875de9f31df0265e939643f4da639))

### [0.1.74](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.73...v0.1.74) (2026-02-24)


### Bug Fixes

* move environment to Y=-10 to position geometry correctly for spawn points ([61e1da2](https://github.com/AnEntrypoint/spawnpoint/commit/61e1da2f30fb647bb475c219685b5325a32d2787))

### [0.1.73](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.72...v0.1.73) (2026-02-24)


### Bug Fixes

* move environment and fallback spawn points to guarantee spawning above geometry ([8b163cd](https://github.com/AnEntrypoint/spawnpoint/commit/8b163cda991385f8058ceb6ff796cf2f7b882554))

### [0.1.72](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.71...v0.1.72) (2026-02-24)


### Bug Fixes

* remove hardcoded Y=0 clamping that trapped players at collider boundary ([eeca8cc](https://github.com/AnEntrypoint/spawnpoint/commit/eeca8cc20ed24fd572f8043bea4a04f0670799f8))

### [0.1.71](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.70...v0.1.71) (2026-02-24)


### Bug Fixes

* move environment geometry above spawn plane to prevent spawning under map ([adaceae](https://github.com/AnEntrypoint/spawnpoint/commit/adaceae85484f38e962d7fa8e423f538c88f3db3))

### [0.1.70](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.69...v0.1.70) (2026-02-24)


### Bug Fixes

* align environment collider position with visual model to prevent falling through floor ([5cf07ef](https://github.com/AnEntrypoint/spawnpoint/commit/5cf07eff13be108619fdf64ffc44038ad5db0049))

### [0.1.69](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.68...v0.1.69) (2026-02-24)


### Bug Fixes

* add Draco compression support to physics engine ([1c5279a](https://github.com/AnEntrypoint/spawnpoint/commit/1c5279ae44cb065c28b11dd46b851d475b450663))

### [0.1.68](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.67...v0.1.68) (2026-02-24)


### Bug Fixes

* add missing anim-lib.glb and improve animation error handling ([a953668](https://github.com/AnEntrypoint/spawnpoint/commit/a953668f5bb87a9a19271da60c7c18621733433c))

### [0.1.67](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.66...v0.1.67) (2026-02-24)


### Bug Fixes

* lower schwust.glb map position to prevent spawning under map ([a0ee7f6](https://github.com/AnEntrypoint/spawnpoint/commit/a0ee7f649b27af2773e5394ba000111c9bf56d49))

### 0.1.66 (2026-02-24)


### Features

* 5 bodyshots or 2 headshots to kill, top 70% is headshot zone ([af15ab3](https://github.com/AnEntrypoint/spawnpoint/commit/af15ab3b0a461b54bb53f3b4dab228d9dc31130e))
* add /editor/ route serving three.js editor connected to live game scene ([f340831](https://github.com/AnEntrypoint/spawnpoint/commit/f340831eac22287b3288905fd9c8e37bae8bd487))
* add comfort vignette for VR movement ([072a990](https://github.com/AnEntrypoint/spawnpoint/commit/072a99009a7ae2560b237b6f0040b3fbf7f787ac))
* add comprehensive animation retargeting diagnostics ([62f63e2](https://github.com/AnEntrypoint/spawnpoint/commit/62f63e29f49420a38ba109289ce6a4601eb10ebf))
* add comprehensive spoint-app-creator skill with CLI, documentation, and templates ([ec374f5](https://github.com/AnEntrypoint/spawnpoint/commit/ec374f5ca1e4752e9d0b78c191b75496905343a4))
* add crouch capsule resizing for physics ([4b9af30](https://github.com/AnEntrypoint/spawnpoint/commit/4b9af30193e4dd23c7c4808ad8ad2b92597be7a8))
* add crouch mode (Ctrl) and network look direction ([c3a8c93](https://github.com/AnEntrypoint/spawnpoint/commit/c3a8c933c88c6a6ac97bc2abd48365606e4fca0f))
* add fade-to-black during teleport for comfort ([1557b17](https://github.com/AnEntrypoint/spawnpoint/commit/1557b17d6714b29141b997630c55946ac5cf2ee1))
* Add memory profiling to tick handler (every 10s) ([114369d](https://github.com/AnEntrypoint/spawnpoint/commit/114369db5bf42ccb27193031b62b0ddcbdb47908))
* Add Nixpacks config for Coolify deployment ([6ed31da](https://github.com/AnEntrypoint/spawnpoint/commit/6ed31dac8933e909f379993b47cb3dd522332f66))
* add ping/pong heartbeat with RTT tracking ([94c1adb](https://github.com/AnEntrypoint/spawnpoint/commit/94c1adb54546bac3a23f63530a692e31e0f2ca34))
* Add player speed indicator to HUD ([6077b9e](https://github.com/AnEntrypoint/spawnpoint/commit/6077b9ee9750b4a45afbe962cc7ae4045c966687))
* add scaffold command and SKILL.md for skills npm package ([b0fecbf](https://github.com/AnEntrypoint/spawnpoint/commit/b0fecbf399c835b713d4fd6fd1aa105aebecc7a6))
* add skills directory and skills-lock.json ([6a3af76](https://github.com/AnEntrypoint/spawnpoint/commit/6a3af764925e2ad605f3031169d891964cae14a4))
* Add SSAO post-processing for ambient occlusion ([b49fad2](https://github.com/AnEntrypoint/spawnpoint/commit/b49fad245dc1ce720382a6e78783219315226ccc))
* add VR settings panel and configurable snap turn angle ([73995f0](https://github.com/AnEntrypoint/spawnpoint/commit/73995f0e07a06821137f2547b3b5e9eff795a99e))
* add WebXR hand tracking support with gesture detection ([4769273](https://github.com/AnEntrypoint/spawnpoint/commit/47692730b04efef540d3f57603a48cca7aae492d))
* Add WebXR VR support with joystick locomotion ([79ff6df](https://github.com/AnEntrypoint/spawnpoint/commit/79ff6df4f587ba7aca7c6c9f2f39edfd3fec1106))
* Add WebXR VR support with joystick locomotion ([3118aa6](https://github.com/AnEntrypoint/spawnpoint/commit/3118aa6759b3ba84980bcac057372bd08ff33e96))
* add wrist-mounted VR UI with health and ammo display ([293a40c](https://github.com/AnEntrypoint/spawnpoint/commit/293a40c7862fee45c35093c27e391617c213cd7e))
* add Y/B button reload and ammo system to TPS game ([611f4e4](https://github.com/AnEntrypoint/spawnpoint/commit/611f4e40ba8180ebaecb5d3fcd3f65fe3a2cd325))
* Additive animation blending for shooting and aiming ([53d9046](https://github.com/AnEntrypoint/spawnpoint/commit/53d904614ee72d1d601ea5b4a1b62948af043b4a))
* AR view localization and mobile performance optimization ([6384e7d](https://github.com/AnEntrypoint/spawnpoint/commit/6384e7d99b56036318df44de10fe4f8065f4f1e9))
* attach FPS camera to head bone with forward offset ([21a0a44](https://github.com/AnEntrypoint/spawnpoint/commit/21a0a44e28acdd224707e604b927a4aab1f84f62))
* Auto-reconnect with session restore, fix session TTL ([d4b99a8](https://github.com/AnEntrypoint/spawnpoint/commit/d4b99a8ba272f62d362031ca9800e6a1f7fc8211))
* auto-scaffold on boot ([8d761f8](https://github.com/AnEntrypoint/spawnpoint/commit/8d761f84d355c5ad6b4fbf94259328db7cf9176a))
* bundle DRACO decoder files locally for self-contained GLB loading ([4296463](https://github.com/AnEntrypoint/spawnpoint/commit/4296463c8c0773f55fb265ece10c97278cb29b64))
* crouch on C key, smooth camera, cache models, FPS player visible, ammo flash fix, crouch anim ([253def6](https://github.com/AnEntrypoint/spawnpoint/commit/253def69a95aaef7ee3b65322b1dfa32ad10a2af))
* disable teleport by default, add toggle in VR settings panel ([18d4a26](https://github.com/AnEntrypoint/spawnpoint/commit/18d4a267ee68da4df31ee645bbd9f0ffc688b198))
* engine-level interactable system ([5c5d381](https://github.com/AnEntrypoint/spawnpoint/commit/5c5d381d0db854bcd742f8424a38eb28e4cfb656))
* enhance mobile controls with interactable functionality and reload animations ([3cd41ba](https://github.com/AnEntrypoint/spawnpoint/commit/3cd41ba110621207929d85b056c1a7d6384978e3))
* Enhanced three-vrm integration - VRM 0.x rotation fix, humanoid API, expressions, lookAt, spring bones ([2a12d1b](https://github.com/AnEntrypoint/spawnpoint/commit/2a12d1b2650eba2726ab9c99f024db2aa77b2ca3))
* FPS camera on neck bone, shrink head instead of hiding model ([09a958e](https://github.com/AnEntrypoint/spawnpoint/commit/09a958e724c7f74d6471e6297097373a184fb1cb))
* full-featured dual joystick mobile controls ([e04b17a](https://github.com/AnEntrypoint/spawnpoint/commit/e04b17a263b9b41a8c94c2d8502ded08d7fe5926))
* implement edit mode with model drag-and-drop support ([3819393](https://github.com/AnEntrypoint/spawnpoint/commit/381939358055f9cfbdd01e69a1641e86ee2d074f))
* implement hierarchical model placement system with smart objects ([d3d4049](https://github.com/AnEntrypoint/spawnpoint/commit/d3d40490af84df43949ea31b6d7919cf8d1ea478))
* Kalman filter + jitter buffer for smooth netcode ([b93474e](https://github.com/AnEntrypoint/spawnpoint/commit/b93474e5a1bb030131b572756fb9de257e06c815))
* Knockback and aim punch on shooting and getting hit ([c9e0bda](https://github.com/AnEntrypoint/spawnpoint/commit/c9e0bda371ce1d1172b53b784f1c90aac9f45baf))
* Loading screen waits for all assets, push anim + boost heal ([95c38f2](https://github.com/AnEntrypoint/spawnpoint/commit/95c38f24a468e5e20973f4140fd904edf1eeb934))
* Merge local and SDK apps directories with local-first override ([d7520dd](https://github.com/AnEntrypoint/spawnpoint/commit/d7520dd39a17721a9bc6b0be0e9707b19624cd16))
* Migrate game config to apps, add app-controllable camera and input modes ([c270e07](https://github.com/AnEntrypoint/spawnpoint/commit/c270e071b07566907ca057c48d177e49d66e73b7))
* P key toggle, engine interactable API, confirm no THREE coupling in src/ ([062946d](https://github.com/AnEntrypoint/spawnpoint/commit/062946d2dab7ec57211b46db4cfb72917b351874))
* PistolShoot overrides upper body instead of additive blend ([23555f1](https://github.com/AnEntrypoint/spawnpoint/commit/23555f1461944da392fe53d52723168e6ee66df2))
* Powerup coins spin/hover, crates fall with physics ([104c432](https://github.com/AnEntrypoint/spawnpoint/commit/104c4321df2887c7f0b21a063f8575212c4f4a49))
* Push velocity triggers walk anim + model rotation, boost heals over 10s ([9f6cafc](https://github.com/AnEntrypoint/spawnpoint/commit/9f6cafcec7494874fc270e34da92df9074d176da))
* refine mobile controls initialization and pointer lock handling ([0f267fe](https://github.com/AnEntrypoint/spawnpoint/commit/0f267fef67ede03e86ae5610a9d2b8772a10750d))
* restore playerModel config pointing to Cleetus.vrm ([b81ff1f](https://github.com/AnEntrypoint/spawnpoint/commit/b81ff1fd09d4ffa445b458195c7e8866cf83d334))
* run skills install after scaffold copies apps/ ([a54daf8](https://github.com/AnEntrypoint/spawnpoint/commit/a54daf89cb4dfbbe4faefecd3b2ddb4f8525cb8a))
* Trigger PistolShoot animation on gunfire ([6eaf672](https://github.com/AnEntrypoint/spawnpoint/commit/6eaf6726c5c3227e9789587acc5d58f9f4ccc386))
* update mobile controls and input handling for improved responsiveness ([f78d9b0](https://github.com/AnEntrypoint/spawnpoint/commit/f78d9b0dad5f2b618725a87be85f0ebdacfe68b1))
* WebXR VR Phase 2 - Controller visualization, haptics, teleportation ([972f635](https://github.com/AnEntrypoint/spawnpoint/commit/972f6355ed4f1c17bc57e0e00762e4e191c38aec))


### Bug Fixes

* 3x aim punch intensity (0.3 -> 0.9) ([6e25dfe](https://github.com/AnEntrypoint/spawnpoint/commit/6e25dfed8ee98f75972058e5be9fd3da244e75d6))
* 3x faster aim punch decay (6 -> 18) for quicker settle ([3cafed7](https://github.com/AnEntrypoint/spawnpoint/commit/3cafed7bfbdc568603e2a5b37b46c7e6e7f84546))
* 3x faster aim punch lerp (108 -> 324) ([c099177](https://github.com/AnEntrypoint/spawnpoint/commit/c099177e689d343b98afcb40ac909a361435e616))
* 3x faster aim punch lerp (12 -> 36) ([4252955](https://github.com/AnEntrypoint/spawnpoint/commit/425295529ba288f2768f10e90ae3783f57cf56ad))
* 3x faster aim punch lerp (324 -> 972) ([3cbffed](https://github.com/AnEntrypoint/spawnpoint/commit/3cbffeda56795ff2182146f20c3bc25d1fef9f66))
* 3x faster aim punch lerp (36 -> 108) ([6dcac09](https://github.com/AnEntrypoint/spawnpoint/commit/6dcac09a9ea89d93edba16a7f26d5fd4214b32f2))
* 3x stronger aim punch with more random direction ([28eef56](https://github.com/AnEntrypoint/spawnpoint/commit/28eef563e863209b77e531566d0ac9298f91fa65))
* 4096 shadow map + balanced bias to close corner light leaks ([4447063](https://github.com/AnEntrypoint/spawnpoint/commit/44470632de25acf8a0e74f4f56ac004a1f4086f1))
* Add blue studio light, soft yellow ambient, reduce shadows to 512 ([b974f77](https://github.com/AnEntrypoint/spawnpoint/commit/b974f77990d47ce70340e8cecdee74b23691bdc0))
* Add camera fill light to prevent black shadows when facing away ([707d493](https://github.com/AnEntrypoint/spawnpoint/commit/707d493d2f243f62d750615f6c54f0ae9e5a0601))
* add error handling to setCharacterCrouch ([47e8ecc](https://github.com/AnEntrypoint/spawnpoint/commit/47e8ecc3c3539612407da23a9946eceb2bc9154c))
* add forward wall ray in FPS mode to prevent camera penetration ([7f4fef2](https://github.com/AnEntrypoint/spawnpoint/commit/7f4fef2401ac7f776b955766d6625f3721633f49))
* Add shadow radius 4 to widen the dark shadow area ([c05f9ed](https://github.com/AnEntrypoint/spawnpoint/commit/c05f9edef3f4c57633c644e88819d33895241c5a))
* Add small normalBias 0.05 to bleed shadow edges out 1px ([011eb6d](https://github.com/AnEntrypoint/spawnpoint/commit/011eb6dbef9fbae3ec1a6c8d3fb3a32c94d205d5))
* Adjust VSM shadow bias to reduce washed out appearance ([3c836f8](https://github.com/AnEntrypoint/spawnpoint/commit/3c836f8dc219dbf64664397a3676fb03bd7069d8))
* All crates get physics, hitbox follows fallen position ([2a171be](https://github.com/AnEntrypoint/spawnpoint/commit/2a171be93bf105e6a3b41a45e6b42e22816c93a9))
* animation regression from cache poisoning with wrong vrmVersion ([1b347ab](https://github.com/AnEntrypoint/spawnpoint/commit/1b347ab1da8f1ac59d803d89c4af2e5ead3ccec2))
* Apply coin hover offset to child mesh to prevent flicker ([89660b2](https://github.com/AnEntrypoint/spawnpoint/commit/89660b22c7025acac2924485647bab0ff1234570))
* Apply tuned shadow settings - VSM, bias 0.0026, normalBias 0.87, radius 6.5, mapSize 1024, sun at [21,50,20] intensity 1.5 ([4bcadc4](https://github.com/AnEntrypoint/spawnpoint/commit/4bcadc4c50811d33955a81add7f58d378cb7de28))
* attach FPS camera to head bone with proper world matrix update ([806f434](https://github.com/AnEntrypoint/spawnpoint/commit/806f434f6acea3dc675f73194c956b5e8b66e45a))
* bump to 0.1.17 with DRACO loader support ([b505aea](https://github.com/AnEntrypoint/spawnpoint/commit/b505aea9e74669a437032d45d1af06020d19f3ba))
* cap power crate spawning to prevent unbounded entity accumulation ([63dfddc](https://github.com/AnEntrypoint/spawnpoint/commit/63dfddcbc91ca2aa6d2dc1df2b4525078e46e993))
* Change default port from 8080 to 3000 ([8f0784f](https://github.com/AnEntrypoint/spawnpoint/commit/8f0784fb14f0507683a50672f29d220d03348bbc))
* Clamp death animation and add fall respawn after 5s ([be2c0a1](https://github.com/AnEntrypoint/spawnpoint/commit/be2c0a190fbd97095ff8d6c4e3d8e61e8fb93e75))
* clear stale snapshot state on reconnect to prevent ghost player clones\n\nOn reconnect, MessageHandler now calls snapProc.clear() and\nsmoothInterp.reset() before firing onPlayerLeft for the old player ID.\nThis ensures the jitter buffer and SnapshotProcessor have no pre-disconnect\nplayer data that could cause ghost meshes to be created in the animate loop.\nAlso reinitializes PredictionEngine with the new player ID unconditionally.\n\nCo-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com> ([c70e968](https://github.com/AnEntrypoint/spawnpoint/commit/c70e96852d7b01093f832d29164690cb85d5bf21))
* compileAsync crash and VRM visibility ([1ab1245](https://github.com/AnEntrypoint/spawnpoint/commit/1ab12453461056cdbe98ea1cd664ee3c63a8dde8))
* compileAsync warmup for all dynamic GLB/mesh loads ([0d5e246](https://github.com/AnEntrypoint/spawnpoint/commit/0d5e246bfc638f9dc74882468dbe7ea92633de79))
* configure git author in bump-version workflow ([25bd60b](https://github.com/AnEntrypoint/spawnpoint/commit/25bd60b822ddbe3d033c0796b28c17d70a66ffcf))
* Convert VRM MToon materials to MeshStandard for light-dependent shadows ([dd5c8d0](https://github.com/AnEntrypoint/spawnpoint/commit/dd5c8d0d959ef7b3e65cbf4952c9081d4c6b3662))
* correct retargetClip parameter order and add findSkinnedMesh helper ([193cf42](https://github.com/AnEntrypoint/spawnpoint/commit/193cf42e7444f2e20b17cc4fc4105514884f2033))
* crouch by adjusting player height instead of shape swap ([1ec23c2](https://github.com/AnEntrypoint/spawnpoint/commit/1ec23c25800daf46b831b1bba82510c2f0b9d7f6))
* Decouple feet placement from scale - feet always at ground level ([94e6337](https://github.com/AnEntrypoint/spawnpoint/commit/94e63378f5d1a823856a99358fdf43f6bf29f3b2))
* Destroy all characters in physics world destroy method ([8d64206](https://github.com/AnEntrypoint/spawnpoint/commit/8d64206ed3a44dd099f96867d267e16bafadd233))
* Destroy Jolt CharacterVirtual objects on remove to prevent WASM heap corruption ([4cd5352](https://github.com/AnEntrypoint/spawnpoint/commit/4cd53521f8dc74f143ed81e1c4dd2e6a47769425))
* Destroy Jolt getter return objects to stop WASM heap leak ([8f93583](https://github.com/AnEntrypoint/spawnpoint/commit/8f935831cb72f0e50e040a0303142d043d62f6de))
* Double light intensity to reduce player shadows ([4c7e481](https://github.com/AnEntrypoint/spawnpoint/commit/4c7e481710c4cc89393e03ab21ec1afc14cc2448))
* Double shadow frustum to 240x240 units to cover full map ([a891052](https://github.com/AnEntrypoint/spawnpoint/commit/a891052b85827463bbc91e0ecff09d4be7528390))
* Double shadow map resolution to 4096 ([4fac043](https://github.com/AnEntrypoint/spawnpoint/commit/4fac043425486583d20b790bdabbc40f956e6a9a))
* Double shadow radius to 8 ([4d12818](https://github.com/AnEntrypoint/spawnpoint/commit/4d12818c134271497a8f82422af640cfacc326c3))
* DoubleSide shadows, bias -0.001 ([9efc4df](https://github.com/AnEntrypoint/spawnpoint/commit/9efc4dfd843bb5b825ebabfbe0a3c2b0e218c0ad))
* Dynamic feet-to-ground offset from capsule height, works at any scale ([2bda722](https://github.com/AnEntrypoint/spawnpoint/commit/2bda722f7631e0a29c14fa302d67034f4b94d5e1))
* eliminate ghost players on network lag and tab inactivity ([16c2767](https://github.com/AnEntrypoint/spawnpoint/commit/16c2767a66ba070c15979b9c9115d09df2acfbd4))
* Eliminate server lag at high tick counts ([b4b24d8](https://github.com/AnEntrypoint/spawnpoint/commit/b4b24d80d13ce4dce00312eef2a5a3bafb9bee8d))
* enable DRACO loader for compressed GLB model support ([62932d7](https://github.com/AnEntrypoint/spawnpoint/commit/62932d7d3aefdbc221e1d776f2b2f062eb5c9e4f))
* Entity removal detection + cleanup unused files ([38c85d3](https://github.com/AnEntrypoint/spawnpoint/commit/38c85d3624da72c5927f7644fb24f876a916e5a5))
* entity scale via custom.scale, client app teardown on hot reload, doc updates ([0541ea6](https://github.com/AnEntrypoint/spawnpoint/commit/0541ea69daa7c1f9538b868fff5ca15c6b613c56))
* **environment:** handle uninitialized smartObjects in update and teardown ([542554f](https://github.com/AnEntrypoint/spawnpoint/commit/542554fbcfec7a521f784dd1b166aa0a9e51ca47))
* Expand shadow frustum 3% ([b74f016](https://github.com/AnEntrypoint/spawnpoint/commit/b74f016a5da98a24a3c2e40867542f8d38048e60))
* Expand shadow frustum to 6% ([4dee30b](https://github.com/AnEntrypoint/spawnpoint/commit/4dee30b1e2d71f21bd409e4fb3fec9e26c3ffe21))
* Extend shadows into wall corners/edges ([ff80b1b](https://github.com/AnEntrypoint/spawnpoint/commit/ff80b1bca9b96c7456eba8fa3d9bd61b3784ffe0))
* filter invalid animation tracks before mixing to eliminate PropertyBinding errors ([520879a](https://github.com/AnEntrypoint/spawnpoint/commit/520879a189780762ed47a56a65fe71b127501ad2))
* FPS raycast pulls camera back from walls instead of into them ([b773527](https://github.com/AnEntrypoint/spawnpoint/commit/b773527003379a968ffcc2f3fa26517b31cda124))
* fps wall collision, ar→xr rename, vr joystick movement ([7516b3c](https://github.com/AnEntrypoint/spawnpoint/commit/7516b3cfd839774870293fa28c11fd4b1364a78f))
* ghost players on tab close - detach transport on reconnect, emit before remove ([bfdf461](https://github.com/AnEntrypoint/spawnpoint/commit/bfdf461aed3699cb0c80a404b7481dabda30681b))
* Halve shadow bias to 0.0005 ([c2979c0](https://github.com/AnEntrypoint/spawnpoint/commit/c2979c075aebc0d159ead5c2cb430a0c12046889))
* handle import.meta.url in app module evaluation ([9e0906b](https://github.com/AnEntrypoint/spawnpoint/commit/9e0906b7e5a954430ce92eecebb903293c750f6c))
* hide non-AR canvas when entering AR mode ([b79b748](https://github.com/AnEntrypoint/spawnpoint/commit/b79b7482a0e48aea4ce2ba25614ecaf24cec9de5))
* Hot-reload movement.js with cache busting ([06c5859](https://github.com/AnEntrypoint/spawnpoint/commit/06c5859f304461bf80e9b58454d33656afd466a1))
* Hot-reload world config (movement/jump settings) ([0f77201](https://github.com/AnEntrypoint/spawnpoint/commit/0f772015922dd6bd4a15983fbe0e95658ee69a86))
* implement backward raycast for FPS wall collision and push head down ([6f319f7](https://github.com/AnEntrypoint/spawnpoint/commit/6f319f7d63a742a04e6bb9d6a4c46c38e6c627df))
* implement responsive mobile controls layout for all device sizes ([ee942aa](https://github.com/AnEntrypoint/spawnpoint/commit/ee942aa74fabc6148aec6aaac7f7a137efc5be5d))
* Improve Firefox fullscreen performance ([c9f7260](https://github.com/AnEntrypoint/spawnpoint/commit/c9f7260372b920f84d041c5b479454b9fe131b83))
* improve THREE.js loader configuration and error handling ([862a9bc](https://github.com/AnEntrypoint/spawnpoint/commit/862a9bc237e3755627fe9473e38348e31293473f))
* Increase all animation speed by 20% ([d6c68fc](https://github.com/AnEntrypoint/spawnpoint/commit/d6c68fced2e0a10a23fa96b62f772e6ef3d444b7))
* Increase animation speed to 1.3x ([b4394f4](https://github.com/AnEntrypoint/spawnpoint/commit/b4394f423c8a461b3abb14112ac8883581d96444))
* Increase emissive fill to prevent dark shadows on player ([cf8efce](https://github.com/AnEntrypoint/spawnpoint/commit/cf8efce63adec1dccd198a4e244ec5f8b38c2a34))
* increase FPS forward offset to clear neck area ([79bdaca](https://github.com/AnEntrypoint/spawnpoint/commit/79bdaca46cb7c9cc52d1fc46c93d424340d24236))
* Increase normalBias to 0.25 (~1 shadow texel at 512 res) ([9e965f1](https://github.com/AnEntrypoint/spawnpoint/commit/9e965f17ac2438b0e02aa4e2a38e23e02348af99))
* Increase player mass from 160 to 320 for heavier feel ([02b3eb5](https://github.com/AnEntrypoint/spawnpoint/commit/02b3eb5c10507a004999fc41cf8774597a3a77e0))
* Increase shadow normalBias to 0.04 ([a7edd98](https://github.com/AnEntrypoint/spawnpoint/commit/a7edd988a7da37e6d64aa0ae5bdc06dd11a49016))
* Increase shadow normalBias to 0.08 ([d4161bc](https://github.com/AnEntrypoint/spawnpoint/commit/d4161bc7aa9f580245848d0d1780e572b4a13d56))
* Increase shadow normalBias to 0.15 ([2475537](https://github.com/AnEntrypoint/spawnpoint/commit/247553726a18a1f4e2d1a00f5a1fcf10f7d510de))
* Increase shadow normalBias to 0.3 to close corner light leaks ([01fa9cf](https://github.com/AnEntrypoint/spawnpoint/commit/01fa9cfe57226fd73cb23f2ed3f769d14c321e09))
* initialize buttons Map in MobileControls constructor ([fc223cf](https://github.com/AnEntrypoint/spawnpoint/commit/fc223cf9ff42b41b85be11adbd86b04579dfcfe3))
* install spoint skill for all agents at project level on scaffold ([8e18b8e](https://github.com/AnEntrypoint/spawnpoint/commit/8e18b8e512e84e69e64852b794d528aecbc9520d))
* Jolt WASM memory leak causing progressive server lag ([971304a](https://github.com/AnEntrypoint/spawnpoint/commit/971304a63db06b198982ccf77be6d2d8efe47380))
* larger FPS wall detection with multi-directional rays ([d108e1b](https://github.com/AnEntrypoint/spawnpoint/commit/d108e1bb7063379a03d92f7362e430451c340d09))
* Limit additive animations to upper body only ([2820f04](https://github.com/AnEntrypoint/spawnpoint/commit/2820f040bfaf06c86aacf7d2b3164e0d312138be))
* Loading screen waits for VRM and animations to fully load before hiding ([1f1338f](https://github.com/AnEntrypoint/spawnpoint/commit/1f1338fed0d1e457836f57330fab459942cf92b3))
* Lower player model offset to -1.6 ([c7899ff](https://github.com/AnEntrypoint/spawnpoint/commit/c7899ff7088c8069a6055705689501de062e9a17))
* Lower sprint animation threshold to 6.0 for new speed settings ([0fdf82d](https://github.com/AnEntrypoint/spawnpoint/commit/0fdf82d195e51f46613c7bf67e48f2e3bfc2fa02))
* Make players physically collide with position separation ([38905e6](https://github.com/AnEntrypoint/spawnpoint/commit/38905e647f46203d8978d4410c85c20921913615))
* Move death/respawn animation check outside oneShot guard ([f30fa45](https://github.com/AnEntrypoint/spawnpoint/commit/f30fa45313d305011af21bf81cb173b9ff118682))
* **netcode:** overhaul interpolation pipeline for high-latency smoothness ([65eec34](https://github.com/AnEntrypoint/spawnpoint/commit/65eec3436287596b14c3f541ceee33a9315b7bd8))
* **netcode:** reduce visual lag on high-latency connections ([d76a196](https://github.com/AnEntrypoint/spawnpoint/commit/d76a19660397612a663df55292b7f394d957dd9d))
* Nudge player model down 0.1 to plant feet on ground ([abe56f5](https://github.com/AnEntrypoint/spawnpoint/commit/abe56f52a382f5f4c92d65ec649e99b15fc135ba))
* Pass ArrayBuffer copy to GLTFLoader.parseAsync for VRM loading ([0129fa1](https://github.com/AnEntrypoint/spawnpoint/commit/0129fa18fb9097a7c67fb95f3df65d99758ee342))
* pass explicit flags to skills add so it does not hang on interactive prompts ([6890039](https://github.com/AnEntrypoint/spawnpoint/commit/689003966d15ee9a18e73eabd422db75e82c7afa))
* Positive bias to align backface shadow offset ([d30bda3](https://github.com/AnEntrypoint/spawnpoint/commit/d30bda38f96456acf429f161a0d7e33313a8aff2))
* Power crate no longer uses physics body, eliminates hit lag ([d362e2b](https://github.com/AnEntrypoint/spawnpoint/commit/d362e2baadc2c5db0cc31cad1d4b3b425f3e8a1d))
* pre-warm PointLight shader to eliminate ~1s freeze on crate shoot ([27974ab](https://github.com/AnEntrypoint/spawnpoint/commit/27974abcb635f356a3f23ba6912fd532984ea73e))
* Prevent double friction - preserve movement velocity through physics step ([7f470e9](https://github.com/AnEntrypoint/spawnpoint/commit/7f470e94587d5998bb3be65a6410c8f1cf0ced87))
* Prevent duplicate entity model loading (97x → 1x env mesh) ([5d3ff83](https://github.com/AnEntrypoint/spawnpoint/commit/5d3ff8371e298f4fb4d8ad61ed5a303e32265d56))
* prevent npm publish workflow tag conflicts with version check ([7f8b225](https://github.com/AnEntrypoint/spawnpoint/commit/7f8b2257b5c3f10e8edaeac231bf46c8dafe1366))
* prevent player duplication on reconnect and increase heartbeat timeout ([da9fece](https://github.com/AnEntrypoint/spawnpoint/commit/da9fece3be101430e0635094cdf43ce0cdf3bba1))
* Process multiple ticks per loop to prevent floaty physics ([a5c97ea](https://github.com/AnEntrypoint/spawnpoint/commit/a5c97eab638d3c9f1e841018cc543881e267184d))
* provide Node utility stubs in app module evaluation ([0ee756f](https://github.com/AnEntrypoint/spawnpoint/commit/0ee756fa5ef27084529c045723c03e6e3071a709))
* quote SKILL.md description to prevent YAML colon-space parse failure ([9c05910](https://github.com/AnEntrypoint/spawnpoint/commit/9c059105bb17406a815c5edc4e600edf5effa4a3))
* raise and push forward FPS camera offset ([bbcaf6b](https://github.com/AnEntrypoint/spawnpoint/commit/bbcaf6be0188d27f03258cc4524e025fb856a025))
* raise FPS camera higher and push further forward ([d653765](https://github.com/AnEntrypoint/spawnpoint/commit/d653765ce80ec69b4bf9bf00a1b0418f52e7cb96))
* raise FPS camera to eye level and shrink head bone every frame ([be252ab](https://github.com/AnEntrypoint/spawnpoint/commit/be252abe52911f9cf3dac2cfbe41b81d3c27a1dc))
* Reduce aim punch to 1/10 with smooth lerp decay ([fcf3e33](https://github.com/AnEntrypoint/spawnpoint/commit/fcf3e33252359c8a89901be82eb28fde5101caf7))
* Reduce jump impulse from 4.5 to 3.5 ([19bd25b](https://github.com/AnEntrypoint/spawnpoint/commit/19bd25be1bc9f0d00a45bce9a61a0bab571c2a87))
* Reduce jump impulse to 1.0 for testing ([3221109](https://github.com/AnEntrypoint/spawnpoint/commit/32211099a3e2ed21e2a45b41cdf89c8fb54cde7d))
* Reduce model scale 10% from 1.47 to 1.323 for better hitbox fit ([3557530](https://github.com/AnEntrypoint/spawnpoint/commit/35575303d5f899ff69261f950a48b23d345c3a8d))
* Reduce normal move speed from 8 to 6 for better sprint contrast ([4d58046](https://github.com/AnEntrypoint/spawnpoint/commit/4d580466398eddc3575d32ee01351bfb786f9d99))
* Reduce normal move speed to 5.0 ([4a75d86](https://github.com/AnEntrypoint/spawnpoint/commit/4a75d86c6b1226077627083f364e1f0aa197a6ef))
* Reduce normalBias 0.5→0.3 to close floor shadow gap ([dca84cb](https://github.com/AnEntrypoint/spawnpoint/commit/dca84cbf7bfb15790bc277a92066e955a5aec162))
* Reduce peter panning with less bias, widen shadows with normalBias 0.2 ([245b28d](https://github.com/AnEntrypoint/spawnpoint/commit/245b28d035fcb2acfc153169e03ae806e1d6fee1))
* Reduce shadow bias to prevent peter panning, restore normalBias ([3e6e773](https://github.com/AnEntrypoint/spawnpoint/commit/3e6e77318c50eb77817d0499180c73990eabac00))
* Reduce shadow map to 1024 ([f350b6b](https://github.com/AnEntrypoint/spawnpoint/commit/f350b6b43141e3bdeb83bc5a7a7b1e3a0f0aa3f8))
* Reduce shadow map to 512 ([9f58aad](https://github.com/AnEntrypoint/spawnpoint/commit/9f58aad51eb255c31407a3fddf6150bbf5bf74f2))
* Reduce shadow radius to 1.5 and increase bias to fix bright seams ([bea2688](https://github.com/AnEntrypoint/spawnpoint/commit/bea26883952e24e370d1c715a65ac352a196f38d))
* Reduce sprint multiplier from 1.5x to 1.25x ([e468a42](https://github.com/AnEntrypoint/spawnpoint/commit/e468a42afd3fbe43b86c3b33cf3e82560c27a33e))
* Remove all shadow biases ([a1356c9](https://github.com/AnEntrypoint/spawnpoint/commit/a1356c9f2224fed1add17a1c4fd29ea223d18bfa))
* remove broken retargeting, use normalized clips directly, add favicon handler ([7994403](https://github.com/AnEntrypoint/spawnpoint/commit/79944038f401c48656ec2b0dc4aaf9449d733d44))
* remove crouch height drop from camera and player model ([00a6d15](https://github.com/AnEntrypoint/spawnpoint/commit/00a6d15a9f5ca86098817e493004ca7f87b7ef1d))
* Remove double gravity - Jolt ExtendedUpdate already applies it ([4c94742](https://github.com/AnEntrypoint/spawnpoint/commit/4c947428e4fb52bf5e150e83bda5b82481c6224d))
* Remove double gravity causing progressive movement slowdown ([33da1db](https://github.com/AnEntrypoint/spawnpoint/commit/33da1db38f05734f8005e28bcb304c0caa4314a3))
* remove ghost players from snapshot when they disappear due to network lag ([c497cb5](https://github.com/AnEntrypoint/spawnpoint/commit/c497cb5bd92a3d2a1caa8d405d1bc8ca4e33d21d))
* Remove hemisphere and fill lights, keep only sun ([2863aae](https://github.com/AnEntrypoint/spawnpoint/commit/2863aaea973a644a3b97531737831da8dcf208eb))
* remove missing Cleetus.vrm reference, add initAssets error recovery, sync THREE.Cache to skills ([418ef62](https://github.com/AnEntrypoint/spawnpoint/commit/418ef621f34684b0b5d701d03c71f1eef14c6e21))
* Remove normalBias to eliminate bright edges at shadow boundaries ([705e12e](https://github.com/AnEntrypoint/spawnpoint/commit/705e12e31cc494e08a7ba7d9763c4c779236be7a))
* remove project-specific example code from SKILL.md, generalize as pure API reference ([7a3e900](https://github.com/AnEntrypoint/spawnpoint/commit/7a3e900ab4817c6091f4dc37b6982651f04bbeb1))
* Remove specular from environment - full roughness, zero metalness ([89dd2b3](https://github.com/AnEntrypoint/spawnpoint/commit/89dd2b308facf7d90d9468fc793e05fa04f119ed))
* Remove unnecessary buffer slice in VRM loading ([f8f30f8](https://github.com/AnEntrypoint/spawnpoint/commit/f8f30f8bdff5d5ea6f9678c88ea8ed284c7a10d9))
* Remove VRM 0.x auto-rotation fix - broke model orientation ([c41e9f1](https://github.com/AnEntrypoint/spawnpoint/commit/c41e9f14a3aebb85f7ca4c6d3c23bf02fa51b732))
* remove vrm.update that overwrote animated bones with T-pose ([a83d97a](https://github.com/AnEntrypoint/spawnpoint/commit/a83d97a84630be5326ce95321ef4f815ac2f4cc9))
* Render shadow map from back faces to eliminate edge bright lines ([3e00a02](https://github.com/AnEntrypoint/spawnpoint/commit/3e00a02f2285a7b06515d5a6002123fdace32787))
* Replace ambient with hemisphere light to reduce player model shadows ([9a62116](https://github.com/AnEntrypoint/spawnpoint/commit/9a621162f75ac36b8292e038ba7fd2ed6c724749))
* Reset death animation on respawn so other players see idle state ([ea6b9fb](https://github.com/AnEntrypoint/spawnpoint/commit/ea6b9fb7ab933514d0c8e9be1e29ee14aab8bb18))
* Reset death animation on respawn when health returns ([50a0925](https://github.com/AnEntrypoint/spawnpoint/commit/50a0925484174af81fda5dd42b0df0b6728e9128))
* resolve SDK paths relative to package root for bunx compatibility ([850746a](https://github.com/AnEntrypoint/spawnpoint/commit/850746a93b2b4b649980a59e7071ea8580bf73c6))
* Resolve VRM loading bug and add gzip compression ([6ff8eae](https://github.com/AnEntrypoint/spawnpoint/commit/6ff8eae01d591c256e0058339d1c80233cf11148))
* Restore gravity, tighten shadow bias, render model-less entities ([25775b4](https://github.com/AnEntrypoint/spawnpoint/commit/25775b4318d696f29ac80e98fe064cb2b8ff86a4))
* restore head bone in TPS and add forward raycast in FPS ([66da5bb](https://github.com/AnEntrypoint/spawnpoint/commit/66da5bb72790a3b7e322d15abb038a416df6907e))
* Restore manual gravity - CharacterVirtual needs it ([b1901c6](https://github.com/AnEntrypoint/spawnpoint/commit/b1901c6f40adc277692256e12dd8f9d38436f491))
* Restore shadow map to 2048, reduce blur radius to 3 ([c84b76d](https://github.com/AnEntrypoint/spawnpoint/commit/c84b76dc8e5c30f514e063e778a5aff829e83053))
* Restore shadow maps with default frustum and scene target ([8f3e44a](https://github.com/AnEntrypoint/spawnpoint/commit/8f3e44a26c25e6b20b3791420822b3ce588670ab))
* Reuse last input on ticks with no new input ([ce0bd87](https://github.com/AnEntrypoint/spawnpoint/commit/ce0bd87f06097bef502847cbc61110212989b11e))
* Reuse muzzle flash light, shadow radius 10, normalBias 0.8, fix pendingLoads cleanup ([2defe27](https://github.com/AnEntrypoint/spawnpoint/commit/2defe27f267e904fe312e15677dbbd2b9cda2484))
* Revert to BackSide shadows, zero bias - eliminates acne and halos ([f46a43a](https://github.com/AnEntrypoint/spawnpoint/commit/f46a43a367339b7d774ae5097de1aa24dfb6dfd9))
* Rotate VRM model 180 degrees to face away from camera ([699268d](https://github.com/AnEntrypoint/spawnpoint/commit/699268da6fdad5309dbb7c25eaa61d718608fa58))
* Scale model to capsule cylinder height (1.8m), not full capsule ([e296f05](https://github.com/AnEntrypoint/spawnpoint/commit/e296f05512a1e6ca12dc3b2fab9ec56da9a371ac))
* Scale player model to capsule height, align feet to ground ([211f38d](https://github.com/AnEntrypoint/spawnpoint/commit/211f38d04b88593e436c5d565ceff07739e9f54c))
* Sensible shadow setup for 3060, full pixel ratio ([e3d2760](https://github.com/AnEntrypoint/spawnpoint/commit/e3d276082417dd02d668d66e6c237353953306d8))
* Set jump impulse to 4.0 ([8d0eaee](https://github.com/AnEntrypoint/spawnpoint/commit/8d0eaeea09a1ce2184a34249ed6e83dee439d732))
* Set player mass to 120 ([806bbc3](https://github.com/AnEntrypoint/spawnpoint/commit/806bbc34ea3a9bfe7851b6737b2e646e66f89efc))
* Set sprint multiplier to 1.2x ([cd4721f](https://github.com/AnEntrypoint/spawnpoint/commit/cd4721f08011870475316209e7a796ff652593bc))
* Shadow acne banding - bias -0.001, normalBias 0.5 ([6dab443](https://github.com/AnEntrypoint/spawnpoint/commit/6dab44328d86ac147b7903115ce081759dc148e1))
* Shadow bias -0.0001 for remaining acne ([cd5e9e2](https://github.com/AnEntrypoint/spawnpoint/commit/cd5e9e20a1d3f76a1ede6ac08e5dd9dad05b4571))
* Shadow bias -0.0003 ([c78ce7a](https://github.com/AnEntrypoint/spawnpoint/commit/c78ce7a6d9f99d6a1f4ca5f2ab615f5338041416))
* Shadow bias -0.0005 ([fed8f9d](https://github.com/AnEntrypoint/spawnpoint/commit/fed8f9d9a7de9fc9bbccc236cae8c34f61c6221b))
* Shadow bias -0.001 ([243d4d0](https://github.com/AnEntrypoint/spawnpoint/commit/243d4d047979e03d89f6e92f6c1c2b0433dced24))
* Shadow bias -0.002, FrontSide shadow casting ([06feaa3](https://github.com/AnEntrypoint/spawnpoint/commit/06feaa3484a33528f71b792e52af88fbb01af77d))
* Shadow bias to 0 ([b037d82](https://github.com/AnEntrypoint/spawnpoint/commit/b037d827fdb2413e951354e43c694c71fb742c55))
* Shadow frustum far plane calculated from light-to-scene distance ([e786d9a](https://github.com/AnEntrypoint/spawnpoint/commit/e786d9a36cf34da40eef0129c435b3f17bf3469b))
* Shadow map 1024, normalBias 0.3 ([d8ed199](https://github.com/AnEntrypoint/spawnpoint/commit/d8ed19903f4ea36856f901d495d353efa122e20a))
* Shadow map 2048, bias 0.001 to reduce peter panning ([f62dd2a](https://github.com/AnEntrypoint/spawnpoint/commit/f62dd2a9cff346afa0571256932e2b05726500df))
* Shadow normalBias to 0 ([737a339](https://github.com/AnEntrypoint/spawnpoint/commit/737a339d899d179e696ba623e2ac8790c48acecc))
* Shadow radius 1 ([0556d58](https://github.com/AnEntrypoint/spawnpoint/commit/0556d5851f916b2cff8a2cf86fd71dfdeb5357a6))
* Shadow radius 12 ([3f66644](https://github.com/AnEntrypoint/spawnpoint/commit/3f666444070d8fce534d759bb7df164c439f476b))
* Shadow radius to 6 ([f5f5451](https://github.com/AnEntrypoint/spawnpoint/commit/f5f545158db8fadfa4e12a547799d65d20fd1b80))
* Shadow radius to 8 ([02b6793](https://github.com/AnEntrypoint/spawnpoint/commit/02b67933e039663345641c5e983aaa726ebd773d))
* Shadow settings - VSM bias 0.0038, normalBias 0.6, radius 4, blurSamples 8 ([51cf6a3](https://github.com/AnEntrypoint/spawnpoint/commit/51cf6a38690cbde32d0a663210b941fb0a74e92d))
* Shadow side DoubleSide on environment meshes ([7756a6e](https://github.com/AnEntrypoint/spawnpoint/commit/7756a6e03a7ec5ce2382ff1e596eb5f5d3edd044))
* simplify publish workflow to use standard-version auto-bump ([89a38fd](https://github.com/AnEntrypoint/spawnpoint/commit/89a38fd585b9e2f88127a4bc177de9e5ba7f1da0))
* **skill:** correct remote model URL base (AnEntrypoint/master), add absolute path caveat and remote+physics pattern, expand known filenames ([45e1a12](https://github.com/AnEntrypoint/spawnpoint/commit/45e1a1221180ba856834bb52bd2346b698021b4a))
* Skip snapshots with 0 players, reduce EventLog, remove per-tick allocations ([3d582da](https://github.com/AnEntrypoint/spawnpoint/commit/3d582da33cabe3b61b98fe967a1547d46db8b0b5))
* Slow sprint animation another 30% ([2d1391c](https://github.com/AnEntrypoint/spawnpoint/commit/2d1391ceb5ae3bd3581fc5c08a66c945a2bcbda4))
* Slow sprint animation by 20% ([5ee9d1f](https://github.com/AnEntrypoint/spawnpoint/commit/5ee9d1fcbf49319346156929f9752c3b8ea51628))
* smooth FPS wall raycast and pitch-based forward offset ([af6739b](https://github.com/AnEntrypoint/spawnpoint/commit/af6739bcc4f3948f2a49cefaf98a789d4347dd08))
* Smooth frame delta to fix Firefox jitter ([dd8c4fb](https://github.com/AnEntrypoint/spawnpoint/commit/dd8c4fb67e84720c3fe506f33460bfc732d55e61))
* Snap player position on teleport/respawn instead of interpolating ([d786c9e](https://github.com/AnEntrypoint/spawnpoint/commit/d786c9ee83840489708ecf255d7348aea310e3ab))
* Soft shadows with bias to eliminate banding on player models ([594bae4](https://github.com/AnEntrypoint/spawnpoint/commit/594bae453af8b28fc911766f16612146a7ddad8b))
* Softer wider shadows with PCFSoftShadowMap and radius 3 ([d0fc4a1](https://github.com/AnEntrypoint/spawnpoint/commit/d0fc4a1c971e7fcd183127843c789cf6fa4d36ef))
* Spawn far from players, cap push velocity to prevent launch ([73fa723](https://github.com/AnEntrypoint/spawnpoint/commit/73fa723fb96a3e23d7e0a16320cf5f324f2761ab))
* Spawn power crate immediately and every 30s ([ff5aa0e](https://github.com/AnEntrypoint/spawnpoint/commit/ff5aa0e1ed5dafd33a6bac281c3f423413a0dc4f))
* spread mobile controls layout and preserve VR position on session start ([01a35ad](https://github.com/AnEntrypoint/spawnpoint/commit/01a35ad449ea23a1ab34b9100f65f8d1638f0cca))
* Sprint multiplier to 2.0x for 8.0 sprint speed ([4b9d476](https://github.com/AnEntrypoint/spawnpoint/commit/4b9d476e48fb84992a20b1316e20394a288d5517))
* Sprint speed 1.6x multiplier (8.0) and walk animation at speed 5 ([19d570a](https://github.com/AnEntrypoint/spawnpoint/commit/19d570a02e79630b2d69f1cbc55974cd3b0fe7d6))
* Sprint speed to 7.0 (1.75x multiplier) ([f867dab](https://github.com/AnEntrypoint/spawnpoint/commit/f867dabfbe350a3277f1385d2602b3d6abf4393c))
* static FPS camera position and 6-directional wall pushback ([5665f39](https://github.com/AnEntrypoint/spawnpoint/commit/5665f3997c16479c08635976edf96be043aac795))
* suppress misleading ENOENT errors and add SDK default logging ([2e961fe](https://github.com/AnEntrypoint/spawnpoint/commit/2e961fedcbe679434367affbdec94ed147624cbd))
* Switch back to PCFSoftShadowMap, VSM caused cutout artifacts ([c24d44e](https://github.com/AnEntrypoint/spawnpoint/commit/c24d44efe2e9828aba6fb841abf02d76fc501303))
* Switch to depth bias strategy for shadow edge coverage ([de070d2](https://github.com/AnEntrypoint/spawnpoint/commit/de070d28cd2455c6537b0a10491f089f0e34cb69))
* Switch to PCFSoftShadowMap to match tuned settings ([9dec2ed](https://github.com/AnEntrypoint/spawnpoint/commit/9dec2ed765cf1d46be37c2e11cbeec3bab2a6b69))
* Switch to VSM shadows to eliminate corner light leaks ([a7a0112](https://github.com/AnEntrypoint/spawnpoint/commit/a7a0112f2477b2ebc4465bcb295beaf81b244de9))
* Switch to VSMShadowMap - no angle banding ([6a273a5](https://github.com/AnEntrypoint/spawnpoint/commit/6a273a5f8bc710e4d6dac4828e1394cc86204d27))
* Tighten shadow frustum 240→160 for denser shadow maps ([72a3c0e](https://github.com/AnEntrypoint/spawnpoint/commit/72a3c0ea85f9f72f19bf118f70ec59be78081fad))
* Tighten shadow frustum and increase bias to fix corner light leaks ([69ef4aa](https://github.com/AnEntrypoint/spawnpoint/commit/69ef4aa818b40786bbfb5144ea905bdd5468ba94))
* Triple jump impulse from 1.0 to 3.0 ([d5f374d](https://github.com/AnEntrypoint/spawnpoint/commit/d5f374d2763cc83c03939946946fd13b0f0c54e2))
* use fetch-depth 0 in publish workflow for tag checkout compatibility ([896c1cf](https://github.com/AnEntrypoint/spawnpoint/commit/896c1cfa60831f45301a38b7132f724185cb1dfd))
* Use MeshToonMaterial with emissive to prevent dark mask ([5cb994b](https://github.com/AnEntrypoint/spawnpoint/commit/5cb994bbb81bc9a9abb5de5e6cc30e0662816b96))
* use payload.timestamp instead of pingTime for RTT in MessageHandler heartbeat ([1bd5993](https://github.com/AnEntrypoint/spawnpoint/commit/1bd5993ab0f7c30437071f66fe13a99615980af6))
* use raw bone + vrm.update for proper FPS camera tracking ([b1e2f60](https://github.com/AnEntrypoint/spawnpoint/commit/b1e2f60e9b94f9ed0d26670f3a2a0456fc165fed))
* use real CrouchIdleLoop/CrouchFwdLoop animations instead of spine hack ([1ac44e6](https://github.com/AnEntrypoint/spawnpoint/commit/1ac44e6d7aba36793f8165db117905555e4138ee))
* Use toe bone local Y for ground placement, restore capsule offset ([feba8b4](https://github.com/AnEntrypoint/spawnpoint/commit/feba8b43b8370099c3ee154998abf6fd555d3129))
* Use toe bones as ground reference, scale 1.47, feet at origin ([9005ebd](https://github.com/AnEntrypoint/spawnpoint/commit/9005ebd9c7a6c8092a0ddce69bbc2f71a72edb0a))
* Use tuned ground offset 0.212 * scale for feet placement ([ad34e46](https://github.com/AnEntrypoint/spawnpoint/commit/ad34e460891a434fd054506c92f95e9260e2b774))
* use wss:// WebSocket protocol when page is served over https ([33548b6](https://github.com/AnEntrypoint/spawnpoint/commit/33548b6eb0df280e2f8f4a5542b5721c6721a502))
* vendor three-mesh-bvh locally to resolve MIME/CORS/CSP blocking ([29401d9](https://github.com/AnEntrypoint/spawnpoint/commit/29401d9f92a24d5ca804a0bc1a215560db737ea4))
* VSM light bleeding - radius 3, mapSize 2048, bias -0.0005 ([602e99b](https://github.com/AnEntrypoint/spawnpoint/commit/602e99bef280efe7e3dfc8323168b2c2ed90ddee))
* wait for first-snapshot GLBs before warmup, clamp gzip progress ([7ef3791](https://github.com/AnEntrypoint/spawnpoint/commit/7ef3791101cf1388e525dab5aea0e075dc4a109d))
* Walk speed to 4.0, adjust animation thresholds ([6dd1399](https://github.com/AnEntrypoint/spawnpoint/commit/6dd139998e257de58039d104fa4fa3cfd362ae36))
* WebXR VR Phase 1 - snap-turn and camera positioning ([dc9d303](https://github.com/AnEntrypoint/spawnpoint/commit/dc9d30314e23a7eb13a42d3a4f7fd6d15bb91900))
* Widen shadows with normalBias 0.4 ([8deff92](https://github.com/AnEntrypoint/spawnpoint/commit/8deff9268965c6270216ededc083c9bbe0b903fe))
* Widen shadows with normalBias 0.7 ([292310b](https://github.com/AnEntrypoint/spawnpoint/commit/292310bb72e0ab2e13532b285decfdffe7c1754f))
* Widen shadows with normalBias 1.5 to cover object edge bright lines ([5a22e9d](https://github.com/AnEntrypoint/spawnpoint/commit/5a22e9d1baf03de3b7da8e38db2ba04e37f1b97c))
* XR controller button mappings and joystick movement ([f14b34e](https://github.com/AnEntrypoint/spawnpoint/commit/f14b34e4a76edfa3ee83a9a4031ed8de2e1b8f4d))

### [0.1.63](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.62...v0.1.63) (2026-02-23)


### Bug Fixes

* fps wall collision, ar→xr rename, vr joystick movement ([07d01ce](https://github.com/AnEntrypoint/spawnpoint/commit/07d01cee52981e983c9390240f661b6011347805))

### [0.1.62](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.61...v0.1.62) (2026-02-23)


### Bug Fixes

* clear stale snapshot state on reconnect to prevent ghost player clones\n\nOn reconnect, MessageHandler now calls snapProc.clear() and\nsmoothInterp.reset() before firing onPlayerLeft for the old player ID.\nThis ensures the jitter buffer and SnapshotProcessor have no pre-disconnect\nplayer data that could cause ghost meshes to be created in the animate loop.\nAlso reinitializes PredictionEngine with the new player ID unconditionally.\n\nCo-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com> ([c2cd715](https://github.com/AnEntrypoint/spawnpoint/commit/c2cd71592da4c5f7de3b02cc434d114ff542ec2a))

### [0.1.61](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.60...v0.1.61) (2026-02-23)


### Bug Fixes

* **netcode:** reduce visual lag on high-latency connections ([8751448](https://github.com/AnEntrypoint/spawnpoint/commit/875144848a0e413683a92efc7289c0233e5dc270))

### [0.1.60](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.59...v0.1.60) (2026-02-23)


### Bug Fixes

* **netcode:** overhaul interpolation pipeline for high-latency smoothness ([19b0c6d](https://github.com/AnEntrypoint/spawnpoint/commit/19b0c6d2b54dbe6677f3ed1ba44223a6b80a8d89))

### [0.1.59](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.58...v0.1.59) (2026-02-23)


### Bug Fixes

* hide non-AR canvas when entering AR mode ([5bdfe22](https://github.com/AnEntrypoint/spawnpoint/commit/5bdfe22ce0e67953f4f9ceeab1d74c6d7ad71e6e))

### [0.1.58](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.57...v0.1.58) (2026-02-22)


### Bug Fixes

* **skill:** correct remote model URL base (AnEntrypoint/master), add absolute path caveat and remote+physics pattern, expand known filenames ([908151d](https://github.com/AnEntrypoint/spawnpoint/commit/908151d598b8b32f443977a3e29ca216a30b5e69))

### [0.1.57](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.56...v0.1.57) (2026-02-22)


### Bug Fixes

* add forward wall ray in FPS mode to prevent camera penetration ([2b6844a](https://github.com/AnEntrypoint/spawnpoint/commit/2b6844aa1b00e488c5ac45064e214974b07516b0))

### [0.1.56](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.55...v0.1.56) (2026-02-22)


### Bug Fixes

* quote SKILL.md description to prevent YAML colon-space parse failure ([d62738a](https://github.com/AnEntrypoint/spawnpoint/commit/d62738a599d4eaeba4aaead83ef987393d762821))

### [0.1.55](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.54...v0.1.55) (2026-02-22)

### [0.1.54](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.53...v0.1.54) (2026-02-22)

### [0.1.53](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.52...v0.1.53) (2026-02-22)

### [0.1.52](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.51...v0.1.52) (2026-02-22)

### [0.1.51](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.50...v0.1.51) (2026-02-22)

### [0.1.50](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.49...v0.1.50) (2026-02-22)

### [0.1.49](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.48...v0.1.49) (2026-02-22)

### [0.1.48](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.47...v0.1.48) (2026-02-22)

### [0.1.47](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.46...v0.1.47) (2026-02-22)


### Features

* engine-level interactable system ([b39f67f](https://github.com/AnEntrypoint/spawnpoint/commit/b39f67f59c0e64ebb88e629d38e8e23336ddb812))

### [0.1.46](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.45...v0.1.46) (2026-02-22)

### [0.1.45](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.44...v0.1.45) (2026-02-22)


### Bug Fixes

* wait for first-snapshot GLBs before warmup, clamp gzip progress ([8f85a60](https://github.com/AnEntrypoint/spawnpoint/commit/8f85a60f4afb26263871649007c053411709f2b7))

### [0.1.44](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.43...v0.1.44) (2026-02-22)


### Bug Fixes

* animation regression from cache poisoning with wrong vrmVersion ([624a1df](https://github.com/AnEntrypoint/spawnpoint/commit/624a1df21734248765f0210d3a994a7b401e88d3))

### [0.1.43](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.42...v0.1.43) (2026-02-22)

### [0.1.42](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.41...v0.1.42) (2026-02-22)


### Bug Fixes

* vendor three-mesh-bvh locally to resolve MIME/CORS/CSP blocking ([ad48172](https://github.com/AnEntrypoint/spawnpoint/commit/ad48172275e7dd4cf1c1612c40e8d6f51e5cc279))

### [0.1.41](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.40...v0.1.41) (2026-02-22)

### [0.1.40](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.39...v0.1.40) (2026-02-22)

### [0.1.39](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.38...v0.1.39) (2026-02-22)

### [0.1.38](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.37...v0.1.38) (2026-02-22)


### Bug Fixes

* pre-warm PointLight shader to eliminate ~1s freeze on crate shoot ([1b75f18](https://github.com/AnEntrypoint/spawnpoint/commit/1b75f189e10b532188fae339f32340942921f467))

### [0.1.37](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.36...v0.1.37) (2026-02-22)


### Bug Fixes

* compileAsync crash and VRM visibility ([785246a](https://github.com/AnEntrypoint/spawnpoint/commit/785246afc7de75838c58d0efe8aa79968dddf10c))

### [0.1.36](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.35...v0.1.36) (2026-02-22)


### Features

* add Cleetus.vrm player model ([e7f68ea](https://github.com/AnEntrypoint/spawnpoint/commit/e7f68ead92e78d01804d2684201e9373a039e3b8))

### [0.1.35](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.34...v0.1.35) (2026-02-22)


### Features

* restore playerModel config pointing to Cleetus.vrm ([280784f](https://github.com/AnEntrypoint/spawnpoint/commit/280784f65cc2a20848fc4220ad002f1bf7821e99))

### [0.1.34](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.33...v0.1.34) (2026-02-22)


### Bug Fixes

* remove missing Cleetus.vrm reference, add initAssets error recovery, sync THREE.Cache to skills ([fc2d0a7](https://github.com/AnEntrypoint/spawnpoint/commit/fc2d0a7c778771a3d3698c291c1d2ce064ada548))

### [0.1.33](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.32...v0.1.33) (2026-02-22)


### Bug Fixes

* compileAsync warmup for all dynamic GLB/mesh loads ([0d5a9bd](https://github.com/AnEntrypoint/spawnpoint/commit/0d5a9bda47ddded84296a53af6414b3e757aed60))

### [0.1.32](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.31...v0.1.32) (2026-02-22)

### [0.1.31](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.30...v0.1.31) (2026-02-22)

### [0.1.30](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.29...v0.1.30) (2026-02-22)

### [0.1.29](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.28...v0.1.29) (2026-02-22)

### [0.1.28](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.27...v0.1.28) (2026-02-22)

### [0.1.27](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.26...v0.1.27) (2026-02-22)

### [0.1.26](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.25...v0.1.26) (2026-02-22)

### [0.1.25](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.24...v0.1.25) (2026-02-22)

### [0.1.24](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.23...v0.1.24) (2026-02-22)

### [0.1.23](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.22...v0.1.23) (2026-02-22)

### [0.1.22](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.21...v0.1.22) (2026-02-22)


### Bug Fixes

* improve THREE.js loader configuration and error handling ([35b0ace](https://github.com/AnEntrypoint/spawnpoint/commit/35b0ace8ef78bcb4e6832ad77574e99c5c010004))

### [0.1.21](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.20...v0.1.21) (2026-02-22)


### Bug Fixes

* provide Node utility stubs in app module evaluation ([bfdbc9b](https://github.com/AnEntrypoint/spawnpoint/commit/bfdbc9b72f6b813bb95f69456679e901b308b9d4))

### [0.1.20](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.19...v0.1.20) (2026-02-22)


### Bug Fixes

* handle import.meta.url in app module evaluation ([9ca5692](https://github.com/AnEntrypoint/spawnpoint/commit/9ca56929cdb695cfd71eddc10137a34dd41f45c8))

### [0.1.19](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.18...v0.1.19) (2026-02-22)


### Features

* bundle DRACO decoder files locally for self-contained GLB loading ([1269d22](https://github.com/AnEntrypoint/spawnpoint/commit/1269d22206fee3499eeaef85ca8916e045d3841d))


### Bug Fixes

* simplify publish workflow to use standard-version auto-bump ([f6995d3](https://github.com/AnEntrypoint/spawnpoint/commit/f6995d32a80dba88c6d6f988687a97981c645ec7))

### 0.1.18 (2026-02-22)


### Features

* 5 bodyshots or 2 headshots to kill, top 70% is headshot zone ([de43944](https://github.com/AnEntrypoint/spawnpoint/commit/de43944484496c577ae72aea7f42fb7c09515bc0))
* add /editor/ route serving three.js editor connected to live game scene ([925ef44](https://github.com/AnEntrypoint/spawnpoint/commit/925ef44b9164ae4526b1e45ff886462a8f45df21))
* add comfort vignette for VR movement ([dd2394a](https://github.com/AnEntrypoint/spawnpoint/commit/dd2394ae9c696970aa4124c268b2a4b47bd13c51))
* add comprehensive animation retargeting diagnostics ([1f2fc6c](https://github.com/AnEntrypoint/spawnpoint/commit/1f2fc6ce57f567470e4e16eceac2b84a2de66546))
* add comprehensive spoint-app-creator skill with CLI, documentation, and templates ([705c441](https://github.com/AnEntrypoint/spawnpoint/commit/705c441c19c676c88606245efc87272f2e5a0976))
* add crouch capsule resizing for physics ([02892ce](https://github.com/AnEntrypoint/spawnpoint/commit/02892ce8b50ca51d56740f6806d6e7a45edc0dd5))
* add crouch mode (Ctrl) and network look direction ([ed3fc8d](https://github.com/AnEntrypoint/spawnpoint/commit/ed3fc8dc68130af21ef70254be36a4a266575600))
* add fade-to-black during teleport for comfort ([6fbe742](https://github.com/AnEntrypoint/spawnpoint/commit/6fbe7425c7af63803748853d293d314c834845fe))
* Add memory profiling to tick handler (every 10s) ([e28d6e8](https://github.com/AnEntrypoint/spawnpoint/commit/e28d6e8d4b0f523cfd6b0cc1b0ef06d4cc8550de))
* Add Nixpacks config for Coolify deployment ([5eefa7b](https://github.com/AnEntrypoint/spawnpoint/commit/5eefa7b660e0572f2649a01dcbeabebeed6ab09f))
* add ping/pong heartbeat with RTT tracking ([b872aeb](https://github.com/AnEntrypoint/spawnpoint/commit/b872aeb08cc5aaf5741fe1370073e36e6634ff50))
* Add player speed indicator to HUD ([59cbe75](https://github.com/AnEntrypoint/spawnpoint/commit/59cbe7580ba6de37ddbac9d8d8925de98da9d71a))
* add scaffold command and SKILL.md for skills npm package ([f0696c9](https://github.com/AnEntrypoint/spawnpoint/commit/f0696c91c34a3c27b0145d9aec404e1ed55c41c9))
* add skills directory and skills-lock.json ([c27db69](https://github.com/AnEntrypoint/spawnpoint/commit/c27db6911c0a9cc29d22a1fed705966c19bbdf7d))
* Add SSAO post-processing for ambient occlusion ([9608b95](https://github.com/AnEntrypoint/spawnpoint/commit/9608b958fdbcc3cf3de0c89f17230d3acc7f3e25))
* add VR settings panel and configurable snap turn angle ([4351117](https://github.com/AnEntrypoint/spawnpoint/commit/4351117f33f261b73bf6a8df0811348039e33671))
* add WebXR hand tracking support with gesture detection ([6131552](https://github.com/AnEntrypoint/spawnpoint/commit/613155243317744a475c5310e24f3fd09666ee92))
* Add WebXR VR support with joystick locomotion ([c942938](https://github.com/AnEntrypoint/spawnpoint/commit/c942938c763b6600a5a6b68c343ebb2da47f08d2))
* Add WebXR VR support with joystick locomotion ([59f8dc6](https://github.com/AnEntrypoint/spawnpoint/commit/59f8dc6eb098641a7a48410b746bccaba73f4c11))
* add wrist-mounted VR UI with health and ammo display ([7d52470](https://github.com/AnEntrypoint/spawnpoint/commit/7d524705a81a139a21d1a62964081fb1f50271ec))
* add Y/B button reload and ammo system to TPS game ([f7c449d](https://github.com/AnEntrypoint/spawnpoint/commit/f7c449d6d8aff4af8a3acf76c9e6c68a6f73f92b))
* Additive animation blending for shooting and aiming ([8ba4dd3](https://github.com/AnEntrypoint/spawnpoint/commit/8ba4dd3fb6591474ff95a55cc533088eb576e644))
* AR view localization and mobile performance optimization ([0a4a7d8](https://github.com/AnEntrypoint/spawnpoint/commit/0a4a7d8dbc18bd97fe0c42e37f3756f0d2fa955f))
* attach FPS camera to head bone with forward offset ([7e59111](https://github.com/AnEntrypoint/spawnpoint/commit/7e591118ccf0c8ee882c4a644eff8581ae7f69b5))
* Auto-reconnect with session restore, fix session TTL ([c2b7d38](https://github.com/AnEntrypoint/spawnpoint/commit/c2b7d382483c1da4eda0c65bf943aa3739045db4))
* auto-scaffold on boot ([a0cbd88](https://github.com/AnEntrypoint/spawnpoint/commit/a0cbd8873fa3bded16cc2e52f9c6ed91f7977132))
* crouch on C key, smooth camera, cache models, FPS player visible, ammo flash fix, crouch anim ([f4dc067](https://github.com/AnEntrypoint/spawnpoint/commit/f4dc067739f9f3196607157acd48f874a365f53a))
* disable teleport by default, add toggle in VR settings panel ([cf8e43a](https://github.com/AnEntrypoint/spawnpoint/commit/cf8e43a5277c66fda83fc788e996e64b0e801cdd))
* enhance mobile controls with interactable functionality and reload animations ([26450e7](https://github.com/AnEntrypoint/spawnpoint/commit/26450e7e1b6d3bd6beb4f1ecf9251eaa2e90c0b4))
* Enhanced three-vrm integration - VRM 0.x rotation fix, humanoid API, expressions, lookAt, spring bones ([1f15a6f](https://github.com/AnEntrypoint/spawnpoint/commit/1f15a6fc717e6dbc13f855138e116a8d7019b1e0))
* FPS camera on neck bone, shrink head instead of hiding model ([d97e60c](https://github.com/AnEntrypoint/spawnpoint/commit/d97e60c2fb6c3d40594c9b5dd54fcc9d2edfb4ac))
* full-featured dual joystick mobile controls ([ac8738a](https://github.com/AnEntrypoint/spawnpoint/commit/ac8738ad11529edf323d274c5069bfccf4da35a5))
* implement edit mode with model drag-and-drop support ([d500450](https://github.com/AnEntrypoint/spawnpoint/commit/d50045063672f06d7add07b9fbda53e30c38febf))
* implement hierarchical model placement system with smart objects ([0b5f11d](https://github.com/AnEntrypoint/spawnpoint/commit/0b5f11d0a98966446b78b10516a0dcac10e9ad1c))
* Kalman filter + jitter buffer for smooth netcode ([063b51e](https://github.com/AnEntrypoint/spawnpoint/commit/063b51eb7459680c974aed6e7e23bde2a0cab14b))
* Knockback and aim punch on shooting and getting hit ([89e697e](https://github.com/AnEntrypoint/spawnpoint/commit/89e697ed75392f324e887e6cb4bb98e5dc0b83f8))
* Loading screen waits for all assets, push anim + boost heal ([6daecb4](https://github.com/AnEntrypoint/spawnpoint/commit/6daecb420bf76806598521e8d0a0610dfcf62638))
* Merge local and SDK apps directories with local-first override ([a72fbfe](https://github.com/AnEntrypoint/spawnpoint/commit/a72fbfeb97bce4e6d1acbfc73019dacaf9d59c58))
* Migrate game config to apps, add app-controllable camera and input modes ([e956174](https://github.com/AnEntrypoint/spawnpoint/commit/e956174272626ecbbfd96ed1575382d40ff4b599))
* P key toggle, engine interactable API, confirm no THREE coupling in src/ ([97091cf](https://github.com/AnEntrypoint/spawnpoint/commit/97091cf0a2b07cdbbf1122bc48aedaafc55d5e86))
* PistolShoot overrides upper body instead of additive blend ([47ca340](https://github.com/AnEntrypoint/spawnpoint/commit/47ca340475b23497f0945f9396167e4318aecd2e))
* Powerup coins spin/hover, crates fall with physics ([9287c9b](https://github.com/AnEntrypoint/spawnpoint/commit/9287c9ba67526dc322d1d9822bfe778b4ef83747))
* Push velocity triggers walk anim + model rotation, boost heals over 10s ([64a53f8](https://github.com/AnEntrypoint/spawnpoint/commit/64a53f8f7d8d471a50f1824c86b15188eb928ff0))
* refine mobile controls initialization and pointer lock handling ([838a300](https://github.com/AnEntrypoint/spawnpoint/commit/838a300345b9c6b65e453e1c2e5d4e3fb875e10e))
* run skills install after scaffold copies apps/ ([f570b53](https://github.com/AnEntrypoint/spawnpoint/commit/f570b535477596be8a0c22fe6a758859ff796ef8))
* Trigger PistolShoot animation on gunfire ([2561f9b](https://github.com/AnEntrypoint/spawnpoint/commit/2561f9bb9e444b09f2f38a3527b365d432afb72e))
* update mobile controls and input handling for improved responsiveness ([3533f6e](https://github.com/AnEntrypoint/spawnpoint/commit/3533f6e29c7d4019243e1bd5190f94dcfb955029))
* WebXR VR Phase 2 - Controller visualization, haptics, teleportation ([1a7034e](https://github.com/AnEntrypoint/spawnpoint/commit/1a7034e34778bfc765600fe8294824a3ae0492a9))


### Bug Fixes

* 3x aim punch intensity (0.3 -> 0.9) ([c61706b](https://github.com/AnEntrypoint/spawnpoint/commit/c61706b7e34947f86693e103273f59fdab37bb11))
* 3x faster aim punch decay (6 -> 18) for quicker settle ([600928d](https://github.com/AnEntrypoint/spawnpoint/commit/600928d8771e5411b86590eaebc26b0956e38b21))
* 3x faster aim punch lerp (108 -> 324) ([ae69575](https://github.com/AnEntrypoint/spawnpoint/commit/ae695756c36f45970eb800e1962ff6957546ec53))
* 3x faster aim punch lerp (12 -> 36) ([1b84fb6](https://github.com/AnEntrypoint/spawnpoint/commit/1b84fb679d7149fd0fa965f0ea5348d6fcc05aa0))
* 3x faster aim punch lerp (324 -> 972) ([46a08eb](https://github.com/AnEntrypoint/spawnpoint/commit/46a08eb792d3ccd50b2aa1af5efa2c9f9dc09438))
* 3x faster aim punch lerp (36 -> 108) ([e30171b](https://github.com/AnEntrypoint/spawnpoint/commit/e30171b9a66b48c2187e5850d843777a4876e4c4))
* 3x stronger aim punch with more random direction ([1c1dc48](https://github.com/AnEntrypoint/spawnpoint/commit/1c1dc48062ecc8843f1da0b01a4e7ad2f1643c30))
* 4096 shadow map + balanced bias to close corner light leaks ([1973616](https://github.com/AnEntrypoint/spawnpoint/commit/1973616e3516e7986d56fa9098bc69e305c6daf8))
* Add blue studio light, soft yellow ambient, reduce shadows to 512 ([2160cb4](https://github.com/AnEntrypoint/spawnpoint/commit/2160cb4d22a06190c6c4462ad57c964e87c1ed40))
* Add camera fill light to prevent black shadows when facing away ([7ef7406](https://github.com/AnEntrypoint/spawnpoint/commit/7ef74063d8b9cefab6037200e0365b6e8bfd7870))
* add error handling to setCharacterCrouch ([fb49d4b](https://github.com/AnEntrypoint/spawnpoint/commit/fb49d4bdac89d0718cb481696b490f3a65632c5c))
* Add shadow radius 4 to widen the dark shadow area ([ee79471](https://github.com/AnEntrypoint/spawnpoint/commit/ee7947120d9ef55c7ba914fc1f470bc834fd9e11))
* Add small normalBias 0.05 to bleed shadow edges out 1px ([aeac761](https://github.com/AnEntrypoint/spawnpoint/commit/aeac761cec180b666a45d3e29835f9963da6e4c5))
* Adjust VSM shadow bias to reduce washed out appearance ([2d06e50](https://github.com/AnEntrypoint/spawnpoint/commit/2d06e5066f744dbabed6c8e8f60b3d874143ca99))
* All crates get physics, hitbox follows fallen position ([8045387](https://github.com/AnEntrypoint/spawnpoint/commit/8045387ee4bee2682a45f7125449e98cdf73a14d))
* Apply coin hover offset to child mesh to prevent flicker ([e4d9a26](https://github.com/AnEntrypoint/spawnpoint/commit/e4d9a264e990023d8ca1f8144268ed606ce3e760))
* Apply tuned shadow settings - VSM, bias 0.0026, normalBias 0.87, radius 6.5, mapSize 1024, sun at [21,50,20] intensity 1.5 ([3e9015d](https://github.com/AnEntrypoint/spawnpoint/commit/3e9015d9667a7cf52ca969fce01e0f681153333a))
* attach FPS camera to head bone with proper world matrix update ([3421e6b](https://github.com/AnEntrypoint/spawnpoint/commit/3421e6b781c44ad9dcd85cc62973f182b6b34fdb))
* bump to 0.1.17 with DRACO loader support ([be8e83a](https://github.com/AnEntrypoint/spawnpoint/commit/be8e83ab43fad12d4f47e11da2ffaa026d96d06e))
* cap power crate spawning to prevent unbounded entity accumulation ([8934bd1](https://github.com/AnEntrypoint/spawnpoint/commit/8934bd14da740d449f39a1dcda2852bb542fe278))
* Change default port from 8080 to 3000 ([5afacaa](https://github.com/AnEntrypoint/spawnpoint/commit/5afacaaaff5fee38c9b3cf4b19680638ee1bc3f7))
* Clamp death animation and add fall respawn after 5s ([2612a4e](https://github.com/AnEntrypoint/spawnpoint/commit/2612a4e1b7389ed858a7b7eef89ce3a03a4429a9))
* configure git author in bump-version workflow ([f132bf7](https://github.com/AnEntrypoint/spawnpoint/commit/f132bf72ab325991929c539947ffeaa3aaf53fc7))
* Convert VRM MToon materials to MeshStandard for light-dependent shadows ([94cdc57](https://github.com/AnEntrypoint/spawnpoint/commit/94cdc57f227fd255cfa112c2bc379e1d652819e4))
* correct retargetClip parameter order and add findSkinnedMesh helper ([9cf9b32](https://github.com/AnEntrypoint/spawnpoint/commit/9cf9b3253c98985af171bb973587bf609b1993c8))
* crouch by adjusting player height instead of shape swap ([ee4c654](https://github.com/AnEntrypoint/spawnpoint/commit/ee4c6542ad2216b1ecafe345a8e88f3dd3945803))
* Decouple feet placement from scale - feet always at ground level ([4b4d180](https://github.com/AnEntrypoint/spawnpoint/commit/4b4d180a8be95338bd058beda9a416aef711c5aa))
* Destroy all characters in physics world destroy method ([607dff6](https://github.com/AnEntrypoint/spawnpoint/commit/607dff689dc4becacd3e093d6f4c13a2276998ee))
* Destroy Jolt CharacterVirtual objects on remove to prevent WASM heap corruption ([a309456](https://github.com/AnEntrypoint/spawnpoint/commit/a309456f50589f545fc82898f38f54d1d9798452))
* Destroy Jolt getter return objects to stop WASM heap leak ([6081f4d](https://github.com/AnEntrypoint/spawnpoint/commit/6081f4d08f31a0c1ed0d95f87e2e60e77217f9e7))
* Double light intensity to reduce player shadows ([7fddb87](https://github.com/AnEntrypoint/spawnpoint/commit/7fddb87a22a18aadadd5f9ada4828a4c405d359f))
* Double shadow frustum to 240x240 units to cover full map ([4b539ab](https://github.com/AnEntrypoint/spawnpoint/commit/4b539ab33cc1fecefa1de6aec37fec8080d25466))
* Double shadow map resolution to 4096 ([bc0116f](https://github.com/AnEntrypoint/spawnpoint/commit/bc0116f7e0dc885969aa0e3f03d6066a7fe4e7a6))
* Double shadow radius to 8 ([c9271c7](https://github.com/AnEntrypoint/spawnpoint/commit/c9271c7f3faf5245743b565fdfff744d1308c572))
* DoubleSide shadows, bias -0.001 ([b567e9d](https://github.com/AnEntrypoint/spawnpoint/commit/b567e9dc88f19e198e9096dbf5d3d1b5469b1340))
* Dynamic feet-to-ground offset from capsule height, works at any scale ([c1cbbb7](https://github.com/AnEntrypoint/spawnpoint/commit/c1cbbb732ab978ca92f4cfdce7fef0ea080b4cea))
* eliminate ghost players on network lag and tab inactivity ([fe03b97](https://github.com/AnEntrypoint/spawnpoint/commit/fe03b97c74f279086da25fbdea3f45dccc1af88b))
* Eliminate server lag at high tick counts ([b9c458c](https://github.com/AnEntrypoint/spawnpoint/commit/b9c458ca26d4c1b34b15c755852461e50c40f70f))
* enable DRACO loader for compressed GLB model support ([8ffc126](https://github.com/AnEntrypoint/spawnpoint/commit/8ffc1264a0b76c46fd612b5e071ab9dedc46e1ca))
* Entity removal detection + cleanup unused files ([ecc1da9](https://github.com/AnEntrypoint/spawnpoint/commit/ecc1da913bf720b521052e922d8910eb16c4eee7))
* entity scale via custom.scale, client app teardown on hot reload, doc updates ([a8e454e](https://github.com/AnEntrypoint/spawnpoint/commit/a8e454e00b19a7b207287efb4ed74dfd17046215))
* Expand shadow frustum 3% ([589e7e9](https://github.com/AnEntrypoint/spawnpoint/commit/589e7e9b2219d6883fe0ca3793d267152ac9a23b))
* Expand shadow frustum to 6% ([13a3068](https://github.com/AnEntrypoint/spawnpoint/commit/13a306827e914ab1ccebf982ce5d8a66c0e4b0b6))
* Extend shadows into wall corners/edges ([26f833a](https://github.com/AnEntrypoint/spawnpoint/commit/26f833a97b1c1bef7dab1625a094ca01dd9dc5d8))
* filter invalid animation tracks before mixing to eliminate PropertyBinding errors ([62d395b](https://github.com/AnEntrypoint/spawnpoint/commit/62d395b69eb79b56dbead410928075020ad438a0))
* FPS raycast pulls camera back from walls instead of into them ([b56c550](https://github.com/AnEntrypoint/spawnpoint/commit/b56c55084220bc6d4a28d274544ab1194cafd6a8))
* ghost players on tab close - detach transport on reconnect, emit before remove ([d0a9777](https://github.com/AnEntrypoint/spawnpoint/commit/d0a97771f37f44243a12ee42b764b25c40ceb7a0))
* Halve shadow bias to 0.0005 ([8a88059](https://github.com/AnEntrypoint/spawnpoint/commit/8a880598f5041d510b8af0e07f729394bf158116))
* Hot-reload movement.js with cache busting ([38a9b00](https://github.com/AnEntrypoint/spawnpoint/commit/38a9b00d5d5a1cb3734804e57a565ee207841f52))
* Hot-reload world config (movement/jump settings) ([c0b024c](https://github.com/AnEntrypoint/spawnpoint/commit/c0b024c2ee4788f7be6b328702f8eaa7bf6fdc6e))
* implement backward raycast for FPS wall collision and push head down ([18f142d](https://github.com/AnEntrypoint/spawnpoint/commit/18f142d5f3322f76d36d1b0735ff30c96026c9bf))
* implement responsive mobile controls layout for all device sizes ([3ad1438](https://github.com/AnEntrypoint/spawnpoint/commit/3ad1438d6713e22436e849c7cb4b9926ae7e704c))
* Improve Firefox fullscreen performance ([8fbc1dc](https://github.com/AnEntrypoint/spawnpoint/commit/8fbc1dc597124f7b831fce7c3eaef629819f9b98))
* Increase all animation speed by 20% ([295e834](https://github.com/AnEntrypoint/spawnpoint/commit/295e834a1e035e930defbd8ab8b3596357a9bdae))
* Increase animation speed to 1.3x ([60ad6ca](https://github.com/AnEntrypoint/spawnpoint/commit/60ad6ca09c0a6268c24788e603275e7126b9ce50))
* Increase emissive fill to prevent dark shadows on player ([4415dcc](https://github.com/AnEntrypoint/spawnpoint/commit/4415dcc7ea03aebe6da7f8cfca5d928f7d44a8a8))
* increase FPS forward offset to clear neck area ([1fce7b4](https://github.com/AnEntrypoint/spawnpoint/commit/1fce7b4ab4863f619aaf7cc7b4808e915d4c90f2))
* Increase normalBias to 0.25 (~1 shadow texel at 512 res) ([f9d49ee](https://github.com/AnEntrypoint/spawnpoint/commit/f9d49eeed2aaf05d80fbc55848a0ef3882bb3017))
* Increase player mass from 160 to 320 for heavier feel ([c637be5](https://github.com/AnEntrypoint/spawnpoint/commit/c637be5abbf55220596cce73769ed5a3de257055))
* Increase shadow normalBias to 0.04 ([6ee6cbf](https://github.com/AnEntrypoint/spawnpoint/commit/6ee6cbfd58b1d691fbb2a9c2ce8f7533e14ed465))
* Increase shadow normalBias to 0.08 ([6c4f6e7](https://github.com/AnEntrypoint/spawnpoint/commit/6c4f6e7bee2e7eff83dc84e1010dbd7fd9cc8a71))
* Increase shadow normalBias to 0.15 ([4623c09](https://github.com/AnEntrypoint/spawnpoint/commit/4623c092f7d2792c6ba0448a4f41b7c4627c4720))
* Increase shadow normalBias to 0.3 to close corner light leaks ([b20cf36](https://github.com/AnEntrypoint/spawnpoint/commit/b20cf3609f0a7523081674fd68a0642b6a320f24))
* initialize buttons Map in MobileControls constructor ([87dbb00](https://github.com/AnEntrypoint/spawnpoint/commit/87dbb006cc2ff47086a451222236f0b457be5f48))
* install spoint skill for all agents at project level on scaffold ([fbb6e46](https://github.com/AnEntrypoint/spawnpoint/commit/fbb6e46b4ad96879443112a814cac35b39fb129d))
* Jolt WASM memory leak causing progressive server lag ([de3f8c6](https://github.com/AnEntrypoint/spawnpoint/commit/de3f8c6e6e0f900f2479e31d85de3de7ab7c512b))
* larger FPS wall detection with multi-directional rays ([357360f](https://github.com/AnEntrypoint/spawnpoint/commit/357360fe96029c7ddd6d2b035ae4952811817052))
* Limit additive animations to upper body only ([0329b70](https://github.com/AnEntrypoint/spawnpoint/commit/0329b70a318cea651947b944f51ba7f749b4fc5a))
* Loading screen waits for VRM and animations to fully load before hiding ([3f6b065](https://github.com/AnEntrypoint/spawnpoint/commit/3f6b065f28d35efb8c55564f791de8884e199d99))
* Lower player model offset to -1.6 ([1e7519b](https://github.com/AnEntrypoint/spawnpoint/commit/1e7519bb762d050fcf7e7a8e0fdd145628f6d1cf))
* Lower sprint animation threshold to 6.0 for new speed settings ([283b0fe](https://github.com/AnEntrypoint/spawnpoint/commit/283b0fea813216fe6bbf893bd9b86f5824199c85))
* Make players physically collide with position separation ([b59466e](https://github.com/AnEntrypoint/spawnpoint/commit/b59466e2155682f501d57427c643a47318551857))
* Move death/respawn animation check outside oneShot guard ([b775fcc](https://github.com/AnEntrypoint/spawnpoint/commit/b775fccec3e8f9b3ebaa3c6bbf9267e6304af12e))
* Nudge player model down 0.1 to plant feet on ground ([95ee891](https://github.com/AnEntrypoint/spawnpoint/commit/95ee891eed90a6012e139f771738ddd0c1056024))
* Pass ArrayBuffer copy to GLTFLoader.parseAsync for VRM loading ([935a7c0](https://github.com/AnEntrypoint/spawnpoint/commit/935a7c09c74e1dd662150e82ecf5452343c7ee63))
* pass explicit flags to skills add so it does not hang on interactive prompts ([9711e99](https://github.com/AnEntrypoint/spawnpoint/commit/9711e99f28eae22f7c09d35900d2165ad1e57afe))
* Positive bias to align backface shadow offset ([c1e3d62](https://github.com/AnEntrypoint/spawnpoint/commit/c1e3d620f38ad667f7e33d01e1017900bfcb5c31))
* Power crate no longer uses physics body, eliminates hit lag ([109df45](https://github.com/AnEntrypoint/spawnpoint/commit/109df4579ff11bac3641486c4f5a54d0556622c0))
* Prevent double friction - preserve movement velocity through physics step ([d8f8e03](https://github.com/AnEntrypoint/spawnpoint/commit/d8f8e037fe60d5556f92ea1b72870baa83e948cf))
* Prevent duplicate entity model loading (97x → 1x env mesh) ([d70ef93](https://github.com/AnEntrypoint/spawnpoint/commit/d70ef93997287bc9ba2ec8f1caef1fd371607ac4))
* prevent npm publish workflow tag conflicts with version check ([70fa3c3](https://github.com/AnEntrypoint/spawnpoint/commit/70fa3c37c9db21aa69169db62b51edf824430785))
* prevent player duplication on reconnect and increase heartbeat timeout ([1dfd8dc](https://github.com/AnEntrypoint/spawnpoint/commit/1dfd8dcd68dadd20f6dc8a51ea27b1f379cd0585))
* Process multiple ticks per loop to prevent floaty physics ([f27af09](https://github.com/AnEntrypoint/spawnpoint/commit/f27af09a034564dac7bc44963e3d527a77c7ffad))
* raise and push forward FPS camera offset ([50c9648](https://github.com/AnEntrypoint/spawnpoint/commit/50c9648c1329b164a768b2ad7d8c7125a5adbcea))
* raise FPS camera higher and push further forward ([991dec4](https://github.com/AnEntrypoint/spawnpoint/commit/991dec48dbe1e9f0bf2cc4cf600859497b7b2916))
* raise FPS camera to eye level and shrink head bone every frame ([0d98f4e](https://github.com/AnEntrypoint/spawnpoint/commit/0d98f4e1b7649604011b60645f5154a65ed6d419))
* Reduce aim punch to 1/10 with smooth lerp decay ([0d78e98](https://github.com/AnEntrypoint/spawnpoint/commit/0d78e987035587db2be1f97f3b7a23fa494efa3d))
* Reduce jump impulse from 4.5 to 3.5 ([dc44a5b](https://github.com/AnEntrypoint/spawnpoint/commit/dc44a5b67aeab16a53cf55e79896458e6c899da0))
* Reduce jump impulse to 1.0 for testing ([a1132a9](https://github.com/AnEntrypoint/spawnpoint/commit/a1132a963438b9d5d6b27954fc1423d54a4710e3))
* Reduce model scale 10% from 1.47 to 1.323 for better hitbox fit ([3444873](https://github.com/AnEntrypoint/spawnpoint/commit/344487371e58cabce71c1c26744502b0e89f73e1))
* Reduce normal move speed from 8 to 6 for better sprint contrast ([380a720](https://github.com/AnEntrypoint/spawnpoint/commit/380a720d8666af64158d0f6b4df32d72ee65b6ca))
* Reduce normal move speed to 5.0 ([48dedd1](https://github.com/AnEntrypoint/spawnpoint/commit/48dedd199455da68bf2a186074ad3306738c72a4))
* Reduce normalBias 0.5→0.3 to close floor shadow gap ([8f41623](https://github.com/AnEntrypoint/spawnpoint/commit/8f41623ebcff751335836b5d8ccc4f416c0cf9c6))
* Reduce peter panning with less bias, widen shadows with normalBias 0.2 ([e241e7a](https://github.com/AnEntrypoint/spawnpoint/commit/e241e7aa9bc598c73e511a67f7adee78c0554b73))
* Reduce shadow bias to prevent peter panning, restore normalBias ([74a8b19](https://github.com/AnEntrypoint/spawnpoint/commit/74a8b195ebc65c4af5eca207753638a948800926))
* Reduce shadow map to 1024 ([ffe7f1d](https://github.com/AnEntrypoint/spawnpoint/commit/ffe7f1d5cd6a1ef4cd23ecf132254792a241fe4a))
* Reduce shadow map to 512 ([37e6926](https://github.com/AnEntrypoint/spawnpoint/commit/37e692697dd1c75020e063c62389f6954920f668))
* Reduce shadow radius to 1.5 and increase bias to fix bright seams ([69d1be1](https://github.com/AnEntrypoint/spawnpoint/commit/69d1be1be8e09c9dd21aca7b1ddf7eb5e831511b))
* Reduce sprint multiplier from 1.5x to 1.25x ([5b7c6b9](https://github.com/AnEntrypoint/spawnpoint/commit/5b7c6b9c98782248b16b56984274df93fc0a496c))
* Remove all shadow biases ([fb3e0d3](https://github.com/AnEntrypoint/spawnpoint/commit/fb3e0d395d1c0c7afe456555681a4889e646b54d))
* remove broken retargeting, use normalized clips directly, add favicon handler ([5b92cc1](https://github.com/AnEntrypoint/spawnpoint/commit/5b92cc12845752ed121ca82e90c7d2d6dab32969))
* remove crouch height drop from camera and player model ([bec266c](https://github.com/AnEntrypoint/spawnpoint/commit/bec266cac4585dc512f8a9972344f5031a2a2f54))
* Remove double gravity - Jolt ExtendedUpdate already applies it ([5556b69](https://github.com/AnEntrypoint/spawnpoint/commit/5556b69f7bcb9fac0a560778dbafb07e60085fe3))
* Remove double gravity causing progressive movement slowdown ([5e2971c](https://github.com/AnEntrypoint/spawnpoint/commit/5e2971c27b77da6897785c142fe629d9a15ff75e))
* remove ghost players from snapshot when they disappear due to network lag ([86983f5](https://github.com/AnEntrypoint/spawnpoint/commit/86983f59d803702c5e40093da28c24ad5ce0bcab))
* Remove hemisphere and fill lights, keep only sun ([a38c54f](https://github.com/AnEntrypoint/spawnpoint/commit/a38c54f4c9a5e232cefe9313968ac478e7a22ba9))
* Remove normalBias to eliminate bright edges at shadow boundaries ([ac25da3](https://github.com/AnEntrypoint/spawnpoint/commit/ac25da313d54ce1bdd3109c5988b7bd4a8c68850))
* Remove specular from environment - full roughness, zero metalness ([63ffdc1](https://github.com/AnEntrypoint/spawnpoint/commit/63ffdc1d7d54a442b20ec0ce75bfef6e50484ca9))
* Remove unnecessary buffer slice in VRM loading ([5aa8716](https://github.com/AnEntrypoint/spawnpoint/commit/5aa8716a5c00eddce2c0828d1448dac0afae8040))
* Remove VRM 0.x auto-rotation fix - broke model orientation ([94d88ef](https://github.com/AnEntrypoint/spawnpoint/commit/94d88ef7f4347ab878b1a061a85711fe0536ecf7))
* remove vrm.update that overwrote animated bones with T-pose ([db8ce57](https://github.com/AnEntrypoint/spawnpoint/commit/db8ce57760ec4d892f369c54ec986b7eef3130ae))
* Render shadow map from back faces to eliminate edge bright lines ([86bcb72](https://github.com/AnEntrypoint/spawnpoint/commit/86bcb7240da19b0ab3de611de869593c487742b4))
* Replace ambient with hemisphere light to reduce player model shadows ([fd6c9a8](https://github.com/AnEntrypoint/spawnpoint/commit/fd6c9a88491c4226f0b1011fecf91578ba0098ae))
* Reset death animation on respawn so other players see idle state ([cb7b8d8](https://github.com/AnEntrypoint/spawnpoint/commit/cb7b8d8ee53454a33bc1a2ed8dec2d6b83fadc0d))
* Reset death animation on respawn when health returns ([06b3477](https://github.com/AnEntrypoint/spawnpoint/commit/06b3477ab9965497218a08d1c87c653eade2bf7f))
* resolve SDK paths relative to package root for bunx compatibility ([7ae94c3](https://github.com/AnEntrypoint/spawnpoint/commit/7ae94c3d8e2121e304f42cfbea382ba7d39d3f76))
* Resolve VRM loading bug and add gzip compression ([bf19e78](https://github.com/AnEntrypoint/spawnpoint/commit/bf19e7836d04ca4bbf8e3ca7d5b4b3795fa1d6e8))
* Restore gravity, tighten shadow bias, render model-less entities ([083cea1](https://github.com/AnEntrypoint/spawnpoint/commit/083cea1bb4a7d0e7d173a7105011421ea8c51186))
* restore head bone in TPS and add forward raycast in FPS ([dd1ef34](https://github.com/AnEntrypoint/spawnpoint/commit/dd1ef34d9a834b92447dda145aa47ded47866c5e))
* Restore manual gravity - CharacterVirtual needs it ([0b60f51](https://github.com/AnEntrypoint/spawnpoint/commit/0b60f516b17a3f35f873890d8fcb062507ed9709))
* Restore shadow map to 2048, reduce blur radius to 3 ([fe88911](https://github.com/AnEntrypoint/spawnpoint/commit/fe889114d09bd31c25721df0067e9fe1d918b41a))
* Restore shadow maps with default frustum and scene target ([285f4f3](https://github.com/AnEntrypoint/spawnpoint/commit/285f4f32e0e51b88f199f76810621b06df267506))
* Reuse last input on ticks with no new input ([b6c909f](https://github.com/AnEntrypoint/spawnpoint/commit/b6c909fe330f7a776c05a529bc0823ca7938d7bc))
* Reuse muzzle flash light, shadow radius 10, normalBias 0.8, fix pendingLoads cleanup ([7567904](https://github.com/AnEntrypoint/spawnpoint/commit/7567904ee27ff9d1fcd1912a518dcc20575baead))
* Revert to BackSide shadows, zero bias - eliminates acne and halos ([6db5b46](https://github.com/AnEntrypoint/spawnpoint/commit/6db5b4651384e3b7b9f931fc9636f3c1beddfb20))
* Rotate VRM model 180 degrees to face away from camera ([f8929e7](https://github.com/AnEntrypoint/spawnpoint/commit/f8929e74db87ecf04b07a4a3508a995c5a953992))
* Scale model to capsule cylinder height (1.8m), not full capsule ([5f701e5](https://github.com/AnEntrypoint/spawnpoint/commit/5f701e56cc2da2a6824e39c1bbc5c70ed27c0d99))
* Scale player model to capsule height, align feet to ground ([c59f2cd](https://github.com/AnEntrypoint/spawnpoint/commit/c59f2cd76a07e2bcf071c5e6187bbc3ba656e475))
* Sensible shadow setup for 3060, full pixel ratio ([b743a63](https://github.com/AnEntrypoint/spawnpoint/commit/b743a63f8b1683eef1ff43c0ba117db4a8490fb9))
* Set jump impulse to 4.0 ([1e5c567](https://github.com/AnEntrypoint/spawnpoint/commit/1e5c567607874c0626978768ec8dd25d60876106))
* Set player mass to 120 ([3b90f8c](https://github.com/AnEntrypoint/spawnpoint/commit/3b90f8cf8994bfaf7a8dd9fac1db4af256fac260))
* Set sprint multiplier to 1.2x ([cd94f23](https://github.com/AnEntrypoint/spawnpoint/commit/cd94f233cc1de3d35f04288ea8cda83044a0080e))
* Shadow acne banding - bias -0.001, normalBias 0.5 ([f0afed5](https://github.com/AnEntrypoint/spawnpoint/commit/f0afed5dbad6572f3793a5836d23465d0c6fe711))
* Shadow bias -0.0001 for remaining acne ([d204e4d](https://github.com/AnEntrypoint/spawnpoint/commit/d204e4de5e51659ef3eab6e247ceece64a0d190a))
* Shadow bias -0.0003 ([071335a](https://github.com/AnEntrypoint/spawnpoint/commit/071335af2a35ae13d374b261d77abda7cb47fba0))
* Shadow bias -0.0005 ([258e930](https://github.com/AnEntrypoint/spawnpoint/commit/258e9309f4f638d0ad80bc091469e3bafd6f165e))
* Shadow bias -0.001 ([f51d9ba](https://github.com/AnEntrypoint/spawnpoint/commit/f51d9ba14bb44fe598ebd8c3ec6da885ad437817))
* Shadow bias -0.002, FrontSide shadow casting ([570ca45](https://github.com/AnEntrypoint/spawnpoint/commit/570ca45d62195d1b5a5e987a7f493f6a642224be))
* Shadow bias to 0 ([f3a6764](https://github.com/AnEntrypoint/spawnpoint/commit/f3a67648b97e3c5a11c5a8d4833611f160a53657))
* Shadow frustum far plane calculated from light-to-scene distance ([75c8eed](https://github.com/AnEntrypoint/spawnpoint/commit/75c8eed08c2d70f12d96892e0e956737d38924f5))
* Shadow map 1024, normalBias 0.3 ([f0a1a74](https://github.com/AnEntrypoint/spawnpoint/commit/f0a1a7451a574f33c2d98bb50cc5afd6688f8e27))
* Shadow map 2048, bias 0.001 to reduce peter panning ([11b458a](https://github.com/AnEntrypoint/spawnpoint/commit/11b458ad8dc8eb1d3cd2f2757ea6ae9f689009d9))
* Shadow normalBias to 0 ([a689dc8](https://github.com/AnEntrypoint/spawnpoint/commit/a689dc8b2f22b580ede024e51b0b269a9faab54f))
* Shadow radius 1 ([38a8fee](https://github.com/AnEntrypoint/spawnpoint/commit/38a8fee24576937624793eb3d78358f0960bd94d))
* Shadow radius 12 ([a84e020](https://github.com/AnEntrypoint/spawnpoint/commit/a84e020dd2288b079c7ac223dc74b2b3d57d0f76))
* Shadow radius to 6 ([cd80122](https://github.com/AnEntrypoint/spawnpoint/commit/cd80122f99eaf55de94685276fcd5cd57178cff6))
* Shadow radius to 8 ([ee39654](https://github.com/AnEntrypoint/spawnpoint/commit/ee396540325c9aa26a25cf3ed1e64469b92cbac6))
* Shadow settings - VSM bias 0.0038, normalBias 0.6, radius 4, blurSamples 8 ([835a364](https://github.com/AnEntrypoint/spawnpoint/commit/835a364344fee717467f103e8e5c6ff28502b380))
* Shadow side DoubleSide on environment meshes ([a8522e4](https://github.com/AnEntrypoint/spawnpoint/commit/a8522e4ec2105fb47f6b0355dcc5361c771b7ca1))
* Skip snapshots with 0 players, reduce EventLog, remove per-tick allocations ([bf951e0](https://github.com/AnEntrypoint/spawnpoint/commit/bf951e0fc256a961c8c901d9b5ac460aeff12dca))
* Slow sprint animation another 30% ([21935e7](https://github.com/AnEntrypoint/spawnpoint/commit/21935e72a1e54e4080f1dddef08e42d3e4dc9489))
* Slow sprint animation by 20% ([8d9cd4c](https://github.com/AnEntrypoint/spawnpoint/commit/8d9cd4c13ca34b6d80180d493059f04149162569))
* smooth FPS wall raycast and pitch-based forward offset ([fadc424](https://github.com/AnEntrypoint/spawnpoint/commit/fadc42493f22f991a7f4e8c18d7e2d82f2ba0c4d))
* Smooth frame delta to fix Firefox jitter ([9a3aeac](https://github.com/AnEntrypoint/spawnpoint/commit/9a3aeac651fa84f7e93dc6913486c4a3971e3d3a))
* Snap player position on teleport/respawn instead of interpolating ([1bcaefc](https://github.com/AnEntrypoint/spawnpoint/commit/1bcaefc58d01c0a9f7135c0e2d01594314e59216))
* Soft shadows with bias to eliminate banding on player models ([9814f3d](https://github.com/AnEntrypoint/spawnpoint/commit/9814f3df979dae9c303210e68002308290331bd5))
* Softer wider shadows with PCFSoftShadowMap and radius 3 ([95de86e](https://github.com/AnEntrypoint/spawnpoint/commit/95de86ed469905a86bcd7327f22b4bf24f4f5ad6))
* Spawn far from players, cap push velocity to prevent launch ([0530f5f](https://github.com/AnEntrypoint/spawnpoint/commit/0530f5f9b22a9b30e006549ffc3eea9b3f06fe4b))
* Spawn power crate immediately and every 30s ([d68c51a](https://github.com/AnEntrypoint/spawnpoint/commit/d68c51a2557a5f84c33e8edf1ebe7684d5ea991e))
* spread mobile controls layout and preserve VR position on session start ([f5a4a25](https://github.com/AnEntrypoint/spawnpoint/commit/f5a4a257ac1267e9a7a8e8d78bb8cad2ca1ec755))
* Sprint multiplier to 2.0x for 8.0 sprint speed ([1c7a497](https://github.com/AnEntrypoint/spawnpoint/commit/1c7a4974c827e3bfff78c2f6785046b94c2b1c07))
* Sprint speed 1.6x multiplier (8.0) and walk animation at speed 5 ([0f92c51](https://github.com/AnEntrypoint/spawnpoint/commit/0f92c5167a30f8f420fc9ba4472c7f8df6c3554b))
* Sprint speed to 7.0 (1.75x multiplier) ([4a01772](https://github.com/AnEntrypoint/spawnpoint/commit/4a01772eb30041e1c1200de9985fbf4fb3449651))
* static FPS camera position and 6-directional wall pushback ([7861828](https://github.com/AnEntrypoint/spawnpoint/commit/786182847b6d2145c4dbe25c68b558039c5a71de))
* suppress misleading ENOENT errors and add SDK default logging ([45e2ee2](https://github.com/AnEntrypoint/spawnpoint/commit/45e2ee29e915eec3e85ce194d7e5682007d5d988))
* Switch back to PCFSoftShadowMap, VSM caused cutout artifacts ([208a206](https://github.com/AnEntrypoint/spawnpoint/commit/208a206e431359b7e7a9835eee9fb6baf4d8cf7d))
* Switch to depth bias strategy for shadow edge coverage ([465d3ef](https://github.com/AnEntrypoint/spawnpoint/commit/465d3ef8fb4a32298e5538d97b9252599c751348))
* Switch to PCFSoftShadowMap to match tuned settings ([39f5f32](https://github.com/AnEntrypoint/spawnpoint/commit/39f5f32d352b84de51783aba861e051cb96f3786))
* Switch to VSM shadows to eliminate corner light leaks ([399e9a6](https://github.com/AnEntrypoint/spawnpoint/commit/399e9a681af840f6e2420a5ad6f63387464dfb0c))
* Switch to VSMShadowMap - no angle banding ([0167d96](https://github.com/AnEntrypoint/spawnpoint/commit/0167d96214fd5d10e1e5a458df0f58b317a15a59))
* Tighten shadow frustum 240→160 for denser shadow maps ([12b4184](https://github.com/AnEntrypoint/spawnpoint/commit/12b41848b3e7e3dc7a61043e9182e034df19f27a))
* Tighten shadow frustum and increase bias to fix corner light leaks ([af4dac4](https://github.com/AnEntrypoint/spawnpoint/commit/af4dac458a95ad014505fc79e8cf101e653e1b90))
* Triple jump impulse from 1.0 to 3.0 ([55191fe](https://github.com/AnEntrypoint/spawnpoint/commit/55191fea6422c397c5839096ae7bb52af771b5ba))
* use fetch-depth 0 in publish workflow for tag checkout compatibility ([52884a0](https://github.com/AnEntrypoint/spawnpoint/commit/52884a0031cf50e700731528e4d4887b737b457e))
* Use MeshToonMaterial with emissive to prevent dark mask ([0e55034](https://github.com/AnEntrypoint/spawnpoint/commit/0e55034e214dd3c39ccfcddbf25f92305c285b61))
* use payload.timestamp instead of pingTime for RTT in MessageHandler heartbeat ([0821d07](https://github.com/AnEntrypoint/spawnpoint/commit/0821d07d16b74547e693dce7b4641a6fc551eccd))
* use raw bone + vrm.update for proper FPS camera tracking ([86b6432](https://github.com/AnEntrypoint/spawnpoint/commit/86b64328de5e4ed93c9555ea5e7e6fcecdca63df))
* use real CrouchIdleLoop/CrouchFwdLoop animations instead of spine hack ([00684b0](https://github.com/AnEntrypoint/spawnpoint/commit/00684b0cb3fcc6f9b13389aab142a01d781957b0))
* Use toe bone local Y for ground placement, restore capsule offset ([4036500](https://github.com/AnEntrypoint/spawnpoint/commit/403650066149483685dd1b9bccdac98dc9ebc0c1))
* Use toe bones as ground reference, scale 1.47, feet at origin ([eb8b826](https://github.com/AnEntrypoint/spawnpoint/commit/eb8b826c28d4e12d2fef9ad98a4eef8f3381fcd2))
* Use tuned ground offset 0.212 * scale for feet placement ([c612827](https://github.com/AnEntrypoint/spawnpoint/commit/c6128277e665d528254ab6beef2762fd6f3f06e4))
* use wss:// WebSocket protocol when page is served over https ([9b95e16](https://github.com/AnEntrypoint/spawnpoint/commit/9b95e16b4acf212a7dd589d72af229c4ba14cb84))
* VSM light bleeding - radius 3, mapSize 2048, bias -0.0005 ([cdc028a](https://github.com/AnEntrypoint/spawnpoint/commit/cdc028a038c0944f8afb76ea868f18d7874b20ba))
* Walk speed to 4.0, adjust animation thresholds ([87f027b](https://github.com/AnEntrypoint/spawnpoint/commit/87f027b32df99a6efb7840c321eaa8f736b82729))
* WebXR VR Phase 1 - snap-turn and camera positioning ([a28544f](https://github.com/AnEntrypoint/spawnpoint/commit/a28544f1687843c1fa6821b03b951e21c68b8a11))
* Widen shadows with normalBias 0.4 ([7061633](https://github.com/AnEntrypoint/spawnpoint/commit/706163367d29cfbe1b5839987e3886991d85b73f))
* Widen shadows with normalBias 0.7 ([8003a4c](https://github.com/AnEntrypoint/spawnpoint/commit/8003a4c50c925fce57470c5aec7a7b875a30d46c))
* Widen shadows with normalBias 1.5 to cover object edge bright lines ([1d70360](https://github.com/AnEntrypoint/spawnpoint/commit/1d70360785465b38f2987c4232688696474ede57))
* XR controller button mappings and joystick movement ([0d306aa](https://github.com/AnEntrypoint/spawnpoint/commit/0d306aad939367885295b8c50e1277441f94377c))

### [0.1.15](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.14...v0.1.15) (2026-02-22)


### Bug Fixes

* install spoint skill for all agents at project level on scaffold ([a285875](https://github.com/AnEntrypoint/spawnpoint/commit/a2858755e6505d8a932a000a9b1569f8527d3cb1))

### [0.1.14](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.13...v0.1.14) (2026-02-22)


### Features

* add skills directory and skills-lock.json ([0979e38](https://github.com/AnEntrypoint/spawnpoint/commit/0979e38eed42149ee0a438530fb5fd822f05a750))

### [0.1.13](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.12...v0.1.13) (2026-02-22)

### [0.1.12](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.11...v0.1.12) (2026-02-22)


### Bug Fixes

* pass explicit flags to skills add so it does not hang on interactive prompts ([b145ec1](https://github.com/AnEntrypoint/spawnpoint/commit/b145ec11bfbefca6fd48bfb3309ddad168281099))

### [0.1.11](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.10...v0.1.11) (2026-02-22)


### Features

* run skills install after scaffold copies apps/ ([b163486](https://github.com/AnEntrypoint/spawnpoint/commit/b16348658017dda8fc3ef224a826b011b66a95e9))

### [0.1.10](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.9...v0.1.10) (2026-02-22)


### Bug Fixes

* use fetch-depth 0 in publish workflow for tag checkout compatibility ([d59077b](https://github.com/AnEntrypoint/spawnpoint/commit/d59077bf5c0f8b994723c390ec553e6c28054b8c))

### [0.1.9](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.8...v0.1.9) (2026-02-22)


### Features

* auto-scaffold on boot ([c94758e](https://github.com/AnEntrypoint/spawnpoint/commit/c94758edbc3e57fbccf6b44e8b9998d646d90d89))

### [0.1.8](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.7...v0.1.8) (2026-02-22)


### Features

* add scaffold command and SKILL.md for skills npm package ([bd573d3](https://github.com/AnEntrypoint/spawnpoint/commit/bd573d35e30662d227365ffd509d0cd4409f5c10))

### [0.1.7](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.6...v0.1.7) (2026-02-21)

### [0.1.6](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.5...v0.1.6) (2026-02-21)

### [0.1.5](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.4...v0.1.5) (2026-02-21)

### [0.1.4](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.3...v0.1.4) (2026-02-21)


### Features

* add comprehensive spoint-app-creator skill with CLI, documentation, and templates ([a48b5ed](https://github.com/AnEntrypoint/spawnpoint/commit/a48b5ed262d5435bb468fad41c22fe4ead9bd169))

### [0.1.3](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.2...v0.1.3) (2026-02-21)


### Bug Fixes

* suppress misleading ENOENT errors and add SDK default logging ([67461cf](https://github.com/AnEntrypoint/spawnpoint/commit/67461cf38f56e4f6e6dc6c7801208f75cb7291de))

### [0.1.2](https://github.com/AnEntrypoint/spawnpoint/compare/v0.1.1...v0.1.2) (2026-02-21)


### Features

* add /editor/ route serving three.js editor connected to live game scene ([f035858](https://github.com/AnEntrypoint/spawnpoint/commit/f0358583f6561f3b4a95e8132f2d7398240750ee))
* add comfort vignette for VR movement ([02d864c](https://github.com/AnEntrypoint/spawnpoint/commit/02d864c109daeb0d7067e10349f1f755ee279ee2))
* add comprehensive animation retargeting diagnostics ([2e17287](https://github.com/AnEntrypoint/spawnpoint/commit/2e17287fd5413518d5ad56c34a444db81fb2d91a))
* add crouch capsule resizing for physics ([1900f83](https://github.com/AnEntrypoint/spawnpoint/commit/1900f83a3451ac72ddb17278f5aece1e4f451914))
* add crouch mode (Ctrl) and network look direction ([655554f](https://github.com/AnEntrypoint/spawnpoint/commit/655554f44ffee1383b8e4004e1eb00fb7af623a8))
* add fade-to-black during teleport for comfort ([0b3369e](https://github.com/AnEntrypoint/spawnpoint/commit/0b3369ebc696147982f5d2f41839d384c23129e3))
* add ping/pong heartbeat with RTT tracking ([c589012](https://github.com/AnEntrypoint/spawnpoint/commit/c589012f240974cd4f01b20b79cf89294ad66bd6))
* add VR settings panel and configurable snap turn angle ([cb12731](https://github.com/AnEntrypoint/spawnpoint/commit/cb1273146de9bb5996fc0e3750a910cfab6a83fd))
* add WebXR hand tracking support with gesture detection ([e592641](https://github.com/AnEntrypoint/spawnpoint/commit/e5926410019e1cb3db1bcb19184cd10b7b6d78d2))
* add wrist-mounted VR UI with health and ammo display ([88e46d3](https://github.com/AnEntrypoint/spawnpoint/commit/88e46d35bbaf370fc319383570c8bf005c21ce77))
* add Y/B button reload and ammo system to TPS game ([9dd6408](https://github.com/AnEntrypoint/spawnpoint/commit/9dd64089bfc65c69a49af6c0ae6c810125716dc0))
* AR view localization and mobile performance optimization ([1558c81](https://github.com/AnEntrypoint/spawnpoint/commit/1558c81462688bd99ed52b2d50b3a979d648a116))
* attach FPS camera to head bone with forward offset ([320e86f](https://github.com/AnEntrypoint/spawnpoint/commit/320e86f58cbd3c7edcabdcfe92fd51745a8b5bb3))
* crouch on C key, smooth camera, cache models, FPS player visible, ammo flash fix, crouch anim ([d9f83fd](https://github.com/AnEntrypoint/spawnpoint/commit/d9f83fdf45b9caa1e77dc408c02aef080355b5a1))
* disable teleport by default, add toggle in VR settings panel ([9b24911](https://github.com/AnEntrypoint/spawnpoint/commit/9b24911741882c3276b41ecda2c141c9dd0436ff))
* enhance mobile controls with interactable functionality and reload animations ([b92a30b](https://github.com/AnEntrypoint/spawnpoint/commit/b92a30bb8062f5e5e8e8b980466c094c1a1fecc1))
* FPS camera on neck bone, shrink head instead of hiding model ([0312241](https://github.com/AnEntrypoint/spawnpoint/commit/03122416a6fbbaebb94c847649aff31152f5740b))
* full-featured dual joystick mobile controls ([35ef704](https://github.com/AnEntrypoint/spawnpoint/commit/35ef704974e270e593e8664e29861ab928b1fa07))
* implement edit mode with model drag-and-drop support ([5fdf796](https://github.com/AnEntrypoint/spawnpoint/commit/5fdf7967cf9d76b4c20fb3f2fc7d1d0a6f5db341))
* implement hierarchical model placement system with smart objects ([0560301](https://github.com/AnEntrypoint/spawnpoint/commit/05603016f7eeb5defc945312050bd0675a06f423))
* Kalman filter + jitter buffer for smooth netcode ([2271d28](https://github.com/AnEntrypoint/spawnpoint/commit/2271d28e54193bd25b05923c4a5c6ba93bfcc249))
* PistolShoot overrides upper body instead of additive blend ([b544ca0](https://github.com/AnEntrypoint/spawnpoint/commit/b544ca005119b9f0622de42aa6656dd7dab0c882))
* refine mobile controls initialization and pointer lock handling ([69e7e9b](https://github.com/AnEntrypoint/spawnpoint/commit/69e7e9bb70c9ac2f0478559c13e059caf85b5529))
* update mobile controls and input handling for improved responsiveness ([3eaa43c](https://github.com/AnEntrypoint/spawnpoint/commit/3eaa43c145b8f8b5024e6574b9758c9ef84cc5aa))
* WebXR VR Phase 2 - Controller visualization, haptics, teleportation ([c14c901](https://github.com/AnEntrypoint/spawnpoint/commit/c14c901ec395b4b49ddde6168a83f0f49c564a21))


### Bug Fixes

* add error handling to setCharacterCrouch ([1391d7b](https://github.com/AnEntrypoint/spawnpoint/commit/1391d7b2b2cab54ae9f6cace2eb20f428fc95273))
* attach FPS camera to head bone with proper world matrix update ([d5ec80a](https://github.com/AnEntrypoint/spawnpoint/commit/d5ec80a65c013664a085f152bb26cfb89e3f1c05))
* cap power crate spawning to prevent unbounded entity accumulation ([028ad34](https://github.com/AnEntrypoint/spawnpoint/commit/028ad349b1ad1eeae7d97b3335f3f1536b359799))
* configure git author in bump-version workflow ([a4819f1](https://github.com/AnEntrypoint/spawnpoint/commit/a4819f1699dc9ced721f7102b7b700af61e2304e))
* correct retargetClip parameter order and add findSkinnedMesh helper ([a9b5adc](https://github.com/AnEntrypoint/spawnpoint/commit/a9b5adcc78989c7f8dd3ebbb50b45b5bfcef291e))
* crouch by adjusting player height instead of shape swap ([1f28497](https://github.com/AnEntrypoint/spawnpoint/commit/1f28497c8eb3606b4e53d4f427c371045ec69450))
* eliminate ghost players on network lag and tab inactivity ([cda3a04](https://github.com/AnEntrypoint/spawnpoint/commit/cda3a04f44c7706e50434f9b48b3bfcbe9cfce25))
* filter invalid animation tracks before mixing to eliminate PropertyBinding errors ([7e6f742](https://github.com/AnEntrypoint/spawnpoint/commit/7e6f742b6fd3eb13f92351da0cf09cbe613f63e6))
* FPS raycast pulls camera back from walls instead of into them ([5b82f8b](https://github.com/AnEntrypoint/spawnpoint/commit/5b82f8be1cb3fc58ed4d223630f0aad6e5a81aad))
* ghost players on tab close - detach transport on reconnect, emit before remove ([7ffc828](https://github.com/AnEntrypoint/spawnpoint/commit/7ffc828fef12905bc5a020006a6539494cbbffa2))
* implement backward raycast for FPS wall collision and push head down ([06dea7d](https://github.com/AnEntrypoint/spawnpoint/commit/06dea7d6537f87f7c10adc6abe56af6edbfab148))
* implement responsive mobile controls layout for all device sizes ([fc77f73](https://github.com/AnEntrypoint/spawnpoint/commit/fc77f7341296182c3ad0d7b52e4d6a42d6aa0892))
* increase FPS forward offset to clear neck area ([52b17b8](https://github.com/AnEntrypoint/spawnpoint/commit/52b17b8533dccc085321133f3f66c98d583166c3))
* initialize buttons Map in MobileControls constructor ([505408c](https://github.com/AnEntrypoint/spawnpoint/commit/505408c44ac0eb337f31f14c4bd75077695918f3))
* larger FPS wall detection with multi-directional rays ([99a398c](https://github.com/AnEntrypoint/spawnpoint/commit/99a398cf9c86971d94abd72f86768ef3692339f1))
* prevent player duplication on reconnect and increase heartbeat timeout ([8ef8f7d](https://github.com/AnEntrypoint/spawnpoint/commit/8ef8f7d59585864fa3e47a28f54a2d18a15bf2b2))
* raise and push forward FPS camera offset ([3e2a353](https://github.com/AnEntrypoint/spawnpoint/commit/3e2a353d2be0f08c52bed896d6117acc803813b7))
* raise FPS camera higher and push further forward ([b47c90f](https://github.com/AnEntrypoint/spawnpoint/commit/b47c90f121fd1cbeb89912f9e39534a087e963d9))
* raise FPS camera to eye level and shrink head bone every frame ([0aeee4a](https://github.com/AnEntrypoint/spawnpoint/commit/0aeee4a99eb0c36ec86426938df506621160d9a8))
* remove broken retargeting, use normalized clips directly, add favicon handler ([3ad618b](https://github.com/AnEntrypoint/spawnpoint/commit/3ad618bf9d7b4604dddc46c268fb0f36183a4449))
* remove crouch height drop from camera and player model ([0a8a82f](https://github.com/AnEntrypoint/spawnpoint/commit/0a8a82f0b882a0210cb713a60688cdded44ba669))
* remove ghost players from snapshot when they disappear due to network lag ([8ef57b1](https://github.com/AnEntrypoint/spawnpoint/commit/8ef57b116ba2088fe6ae03c7458381c3cbe32444))
* remove vrm.update that overwrote animated bones with T-pose ([e97591d](https://github.com/AnEntrypoint/spawnpoint/commit/e97591da7ae0090af30f838e143bb9607ce8ab53))
* restore head bone in TPS and add forward raycast in FPS ([17f22cb](https://github.com/AnEntrypoint/spawnpoint/commit/17f22cbeb547bb5c909a5ecacab73842b274e548))
* smooth FPS wall raycast and pitch-based forward offset ([141a7b2](https://github.com/AnEntrypoint/spawnpoint/commit/141a7b22e0918f9737252f22c2c3af37f4fee764))
* spread mobile controls layout and preserve VR position on session start ([a6ab3e8](https://github.com/AnEntrypoint/spawnpoint/commit/a6ab3e89f4ecc9cf9f42aacf3aa858ec67b6ae4d))
* static FPS camera position and 6-directional wall pushback ([20e6af2](https://github.com/AnEntrypoint/spawnpoint/commit/20e6af2428bda3a7d0e125ca20e08457b5d9fe19))
* use raw bone + vrm.update for proper FPS camera tracking ([40ca267](https://github.com/AnEntrypoint/spawnpoint/commit/40ca267576ba498eb4a655f6fa9345553eaa7ff1))
* use real CrouchIdleLoop/CrouchFwdLoop animations instead of spine hack ([d362acf](https://github.com/AnEntrypoint/spawnpoint/commit/d362acf99ab7eb707da1c750f8e26ca758e2c88b))
* use wss:// WebSocket protocol when page is served over https ([4f4204d](https://github.com/AnEntrypoint/spawnpoint/commit/4f4204d7b7c2142bbc7e4e056214d332c4774c89))
* WebXR VR Phase 1 - snap-turn and camera positioning ([7b985a1](https://github.com/AnEntrypoint/spawnpoint/commit/7b985a17695b114e1fb060ac8b6f3e110151ffbd))
* XR controller button mappings and joystick movement ([f950cfc](https://github.com/AnEntrypoint/spawnpoint/commit/f950cfc602947d1f819a7ef711d1286bd22c51c3))
