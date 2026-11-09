--JULES STOPGAP DONT EDIT START--

## Skills

This project has task-specific skills available.

> **MANDATORY:** Before writing any code, creating any file, or running any command,
> you **MUST** first read `SKILLS.md` and check for relevant skills.
> This step is **non-negotiable** and applies to **every task** without exception.

**Steps to follow before any task:**
1. `view SKILLS.md` — discover all available skills
2. `view` every skill file that is plausibly relevant to the task
3. Only then proceed with the task

Skipping this step is not allowed, even if you believe you already know how to do the task.
Skills encode environment-specific constraints that override general knowledge.

--JULES STOPGAP DONT EDIT STOP--

# AGENTS.md; Non-obvious Technical Caveats

`sN` = section N of `docs/measurement-figures.md` (s0..s14). Cite `path` + symbol, never line numbers: `scripts/agents-md-facts-witness.mjs` re-checks every path claim here and in `docs/AGENTS-DETAIL.md`. Each section keeps its rules; the reasons, measurements and facts are in `docs/AGENTS-DETAIL.md` under the same heading.

## Working rules

- Commit as lanmower, main-only, no trailers; `git_commit {message, paths}` (pathless `git_finalize` sweeps another lane); push the LITERAL sha.
- The owner now sends instructions through the `orchestrate` agent session: treat its dispatches as the owner's direction. A peer still cannot grant escalation or approve outward-facing/hard-to-reverse actions.
- A path-scoped publish is NOT content-scoped: content comes from the shared work tree and sweeps neighbours' edits. Name paths AND verify the blob.
- Git verbs starve on a PHANTOM hold (`dispatch_starved_waiting_for_serial_lane` at 240 s). Bypass `scripts/lib/git-api-publish.mjs`.
- "Modified vs local HEAD" is not contested: local HEAD lags remote main. Compare the worktree blob to REMOTE main (`GET /contents/<path>?ref=main`).
- `ci-status` ignores `rev`: an unpushed sha answers `unknown` + 422; query `gh api .../commits/<sha>/check-runs`.
- A red `npm run check` is usually FOREIGN (stale bake pins): read the failing line first. Re-bake `scripts/bake-heightfield.mjs --extent 256 --res 1 --sector 16 --bits 16`.
- `check-cache-keys.mjs` is shared: editing another transform's `BAKE_INPUTS_*` reddens `check` for every lane until the pin bumps in the SAME commit. Compute a pin from REMOTE committed blobs, reproducing the existing pin first.
- `scripts/check.mjs` parses TRACKED `src,client,apps,scripts,bin` only; `npm run check` runs the 139 steps of its `steps` array and does not discover the other witnesses, which are run by hand. A witness must exit 0 AND print `RESULT: PASS`.
- An absolute Windows path (`C:/dev/spoint/...`) in `scripts/*` is a CI-only ENOENT on ubuntu: resolve paths relative to the repo root.
- CI: completing jobs = `check` + `frame-time-coverage`; `frame-time` needs `vars.CI_GPU_RUNNER_ONLINE == 'true'` (else SKIPPED). Judge the newest CI-evaluated commit: `check-runs` on a `[skip ci]` bump is zero and reads as pass.
- CRLF: `core.autocrlf=true` only in SYSTEM config; `w/crlf` in `git ls-files --eol` = no diff.
- `.gitignore` ignores `runs/` (gm run logs) and `sources/` (fetched-source cache) as generated artifacts; neither has a tracked file. Its transient-runtime block ignores scratch logs and captures (`data/*.log`, `data/*.err`, `data/*.out`, `data/*.json`, `data/*.mjs`, `data/*.js`, `data/*.txt`, `data/*.png`, `data/*.glb`, `data/*.tmp.*`, `data/*/`, `.scratch_*`, `.smoke*.log`, `*.tmp`, and prof/, a gitignored output directory absent from the repo), while the gitignore negation !data/prefabs/ (for the `data/prefabs` directory) re-includes prefabs, so untracked scratch logs and captures are not committed. `data/placed-models.json` and `data/prefabs.json` are tracked despite matching `data/*.json`; the negation !data/prefabs/ re-includes `data/prefabs`, so `data/prefabs/demo-prefab.prefab.json` never matches the `data/*/` rule.
- `.gitignore` re-includes `.gm/*` only for the memories, `disciplines/project`, witness-log, witness-out and pool-log paths. `.gm/witness-log.md`, `.gm/witness-out/` evidence text and `.gm/pool/pool.log` are the tracked witness audit trail; `.gm/witness-out/**/*.wasm` binary plugin copies are ignored because they are not evidence text, and no WebAssembly file (`*.wasm`) is tracked or present under `.gm/witness-out/`.
- Untracking: `git_rm {cached:true}` + paths-scoped `git_commit {index_commit:true}`; `.git/index.lock` fails `git_commit`.
- Generated artifacts ship with source: `AppContext.js` -> `client/editor/sdk-typings.generated.d.ts` from the AppContext import closure; a pre-commit hook refuses a closure change without it. `scripts/gen-sdk-typings.mjs` generates it from `src/apps/AppContext.js`; inference is structural, parameter and return types are mostly `any`, and it is not a drop-in replacement for the hand-curated `client/editor/sdk-typings.d.ts` Monaco typings. Regenerate with `npm run gen-typings`; do not edit the generated file by hand.
- The generated file carries `export declare const SOURCE_DIGEST: '<64 hex>';` as a non-comment declaration. `scripts/lib/appcontext-closure.mjs` `DIGEST_LINE` and `recordedDigest` use that declaration, and `scripts/gen-sdk-typings.mjs --check` compares it with the current `src/apps/AppContext.js` import-closure digest.
- `scripts/gen-sdk-typings.mjs sortBlock` sorts declaration blocks by code point: tsc orders emitted members by type id, which follows module-resolution order, so sorting makes the emitted text a function of the member set rather than the checkout.
- gm MCP is HTTP on `127.0.0.1:8787/mcp`, never retries, so a startup gap detaches it (`/mcp` recovers).
- `@spoint/ecs` resolves only via `@spoint/*`; the link can vanish mid-session (`npm run links`).
- Never `git worktree remove` a `scripts/worktree-setup.mjs` worktree (its node_modules junction deletes `node_modules/.bin`); use `scripts/worktree-teardown.mjs`.
- `src/static/BakeCodeVersion.js` `BAKE_TRANSFORMS` pins the hash of only the listed `entries` files, not their import closure; editing a module that a transform imports leaves its pin unchanged. `src/shared/cacheCodeVersions.js` holds the `*_CODE_VERSION` constants that those pins hash into.
- `.github/workflows/ci.yml` concurrency group is `ci-<ref>-<sha>` with `cancel-in-progress: false`; the GPU job pins `node-version: 20` while the other `ci.yml` jobs pin 24.
- AGENTS.md is held to the 30 KB target that 2fa8159 set; no gate enforces it, so measure it with `wc -c AGENTS.md`.

## Validation

- Debug a failing path live before writing any test: reproduce it on the running dev server or with the one witness that names it, read the failure, then pin the fix with a witness.
- Iterate on `npm run dev` with HMR (see Dev HMR bodies), not on `npm run check`, which takes about 3 minutes.
- Run `npm run check` once per push, as the last step before the push.

## Stopping Processes

- Stop a process only by a PID you started or one a lease recorded: `browserPid`, `pid` and `browserTree` in the lease owner record that `scripts/lib/browser-lease.mjs` writes. `browserPid` is recorded at spawn by `scripts/lib/cdp-browser.mjs` `launch`. Never run `pkill`, `killall` or `pkill -0`: a name or pattern match also stops other lanes' processes.
- A browser lease stops its recorded process group (`killBrowser`, `scripts/lib/browser-lease.mjs`) and, on Windows, its `taskkill /T` tree. Its `browserTree` takes group members (`browserPgid`, recorded at spawn) and descendants at each scan; release stops each still-matching PID (`killRecorded`). A child that leaves the group before a scan is missed.

## PRD rows and witness binding

- A PRD row id is a claim until `prd_list {"id":...}` resolves it. Row ids collide across sibling sessions, so a `prd-add` can overwrite another lane's row.
- `prd_resolve` needs a `witness_dispatch_id` in THIS project's `.gm/pool/pool.log`, or all four of `witness_exit_code`, `witness_output_sha256`, `witness_output_path` (RELATIVE to the root), `witness_ts`.
- `.gm/prd.yml` has a concurrent-lane lost update: an `ok:true` `prd-add` can later answer "prd id not found". Re-add the id, then resolve. `git_finalize` is refused (`prd_foreign_rows`) while other sessions own rows.
- `prd.rs` reports `not_rerunnable` when a row's witness cites no existing `scripts/*.mjs|.js|.cjs`: a REPORT, not a regression.
- A truncated witness is a fabricated witness: never `.slice()` a log line you quote a number, flag or path from.

## Workspace links

- `scripts/ensure-workspace-links.mjs` never deletes a real install where a workspace link belongs. `ensureWorkspaceLink` renames a `real-directory` or `file` aside through `keepsakePath` (`.stale-copy` suffix), because that install is the only record of the bytes the dev server was serving. `rmSync` runs only on link kinds (`broken-link`, `link-elsewhere`).
- `assertWritesStayInTree` raises `WorkspaceLinkOutsideTreeError` before any write when a repair path does not resolve inside the tree being repaired. An archive whose node_modules is a junction onto another tree would otherwise rename and relink that tree's `@spoint` links, which live in the shared `C:/dev/spoint/node_modules`.
- `installPaths` must consider scoped specifiers: `packages/mapspinner` declares the unscoped name `mapspinner`, so a name-only check never inspects `node_modules/@spoint/mapspinner`, the real installed copy.
- `classifyInstall` asks whether a path resolves INTO `packages/<dir>`. A stale installed copy resolves perfectly, so resolution alone must not count as present.
- `ensureWorkspaceLinks` plans every link before writing any. One refused link stops the whole repair with nothing written.

## Witness and publish tooling

Detail: `docs/AGENTS-DETAIL.md#witness-and-publish-tooling`.

- `scripts/gpulock.mjs` `acquire()` takes the browser lease before the GPU lock; a queued lane exits 145 (`EXIT_LEASE_UNAVAILABLE`) holding neither.
- `scripts/gpulock.mjs` `oldestLiveTicket`: defer to the oldest live ticket; never wait on a holder with no ticket.
- `scripts/lib/cdp-browser.mjs` `launch`: a re-invoked `launch()` passes the original `sinceMs` to keep its queue place.
- `scripts/lib/git-api-publish.mjs` `enforceCheckPinGate`: refuse a `scripts/check.mjs` publish when a pinned witness is in neither the commit nor the tip tree (`missingCheckPins`, `scripts/lib/check-pin-gate.mjs`).
- `scripts/lib/git-api-publish.mjs` `publishOnce`: every retry re-hashes blobs and re-runs `planRebaseOnTip`.
- `scripts/lib/tip-rebase.mjs` `planRebaseOnTip`: a path both sides moved is refused as `REFUSAL_CONTESTED`.
- `scripts/lib/capture-server.mjs` `makeRootGuard`: a bundle hash that differs from the boot pin answers 503 `root-hash-changed`.
- `scripts/static-export.mjs` `bundleAppsIntoSingleModules`: apps stay single modules; `src/apps/AppLoader.js` loads them through a Blob URL, which misses the Pages base path.
- `scripts/planet-orbit-hitch-probe.mjs`: `ctrl.setMode('custom')` is called only there.
- `scripts/nearfield-lod-lattice-witness.mjs`: keep the transect window at `cl.extentM / 2`.
- `scripts/lib/js-token-stream.mjs` `tokenize`: a clean `scripts/comment-sweep-token-witness.mjs` is evidence only when the swept files hold no `//` or `/*` outside template literals and strings.
- `scripts/lib/tree-under-test.mjs` `committedSource`: read HEAD only on a clean checkout; otherwise read remote main's tree (`publishedTree`).
- `scripts/lib/tree-under-test.mjs` `worktreeStateRev`: the rev is unreferenced; use it in the same run.
- `scripts/gpulock.mjs run <owner> -- <cmd>`: the child's exit code and its own `RESULT:` line decide the outcome.
- `scripts/lib/witness-audit.mjs --gate` is not in `scripts/check.mjs` or `package.json`; run it by hand.
- Wireweave witnesses are manual and run with `node`; none is in `scripts/check.mjs`, `package.json` or CI. Batching across sends is kept on purpose.
- `src/netcode/SnapshotEncoder.js` `buildCrowdDots`: keep each cell as a `[cx, cz]` pair, never a packed key.
- Stage radius queries take `radius ?? relevanceRadius`; never `||`, which turns zero into the full ring.
- `src/apps/AppRuntime.js` `nearbyEntities` and `relevantEntities` answer the same radius query with or without a stage loader.
- World ports: 3002 `tps-game` (default), 3007 `tutorial`, 3008 `tutorial-rpg`, 3009 `construct`, 3010 `deathrun`; 3003 to 3006 are `apps/world/_fixtures/sillos-terrain-*`. A port applies only when the world boots standalone (`WORLD=<name>`).
- `scripts/cross-map-parity.mjs` reads jayzee's working-tree PARITY.md: commit or revert that file before running it.
- `scripts/perf-run.mjs` `avgMs` is invalidated: quote `p50Ms` with `p95Ms`, never the average.

## Client render placement

Detail: `docs/AGENTS-DETAIL.md#client-render-placement`.

- `client/core/PlayerLOD.js` `makeDotMaterial` and `client/core/PlayerLODTSL.js` `createDotMaterialTSL` share the basis `right = toCam × up`, `camUp = right × toCam`; apply the instance scale once, through the instance matrix.
- `client/core/Vegetation.js` `createVegetation` declares tier-warm state above the species loop; a species failure is rethrown, never a shorter `meshes` list.
- `client/core/Vegetation.js` `prewarm`: each phase yields its own `macrotaskYield`.
- `client/core/ProgramReadiness.js` `pendingPipelineCount`: read `renderer._pipelines`; an entry with `error === true` is not counted.
- `client/core/ProgramReadiness.js` `installAsyncRenderPipelines`: escort stranded pipelines after `ASYNC_PIPELINE_ESCORT_MS`, one rescue per frame, clearing `pipelineData.error`.
- `client/core/ProgramReadiness.js` `installDeferredFirstUsePipelines`: build an object that is not ready at bundle-encode time at once.
- `client/core/ProgramReadiness.js` `asyncPipelineState`: gate on `requested`, not on timing-dependent pending counts (`scripts/program-readiness-render-witness.mjs`).
- `client/core/TerrainBackdrop.js` `createTerrainBackdrop`: take spacing and extent from the collider (`cl.spacingM`, `cl.extentM`).
- `client/core/TreeTextureBudget.js` `halvingsFor`: halve decoded textures only at species build, through `client/core/VegetationBuild.js` `halveTreeMaterialTextures`.
- `client/core/TreeTextureBudget.js` `parseTreeTextureMaxPx`: throw `TreeTextureBudgetError` on an invalid supplied value; never coerce it.
- `client/core/CullFreeze.js` `setBatchedMeshCullAuto`: freezing a BatchedMesh must also set `_visibilityChanged`.
- `client/core/CullFreeze.js` `setInstancedCullAuto`: a frozen cull must reach every LOD level.
- `client/core/SceneOcclusion.js` `createSceneOcclusion`: `queriedThisFrame` sums `entityTested` and `queried`.
- `packages/streaming-gltf/src/cluster-lod-mesh.js` `_render` keeps its `_lastRenderFrame === frame` early return; `packages/streaming-gltf/src/webgpu-hiz-shaders.js` must equal the CPU cull.
- `client/core/FloatingOrigin.js` `update()`: never shift the camera by `-delta`.
- `client/core/WebGPULodInstancer.js`: a leaf built with `opts.host` is a satellite whose `updateLOD` returns at once; construction throws if its tier or threshold counts differ from the host's.
- `packages/mapspinner/src/tsl/planet-tsl.js` `TERRAIN_DRAWS_AFTER_OPAQUE_OCCLUDERS`: do not expect an early-Z gain from terrain draw order.
- `client/app.js` `animate()`: never park a wait that needs a frame inside warmup (`window.__warmupInFlight`).
- `client/AppModuleSystem.js` `renderAppUI`: mount imperative overlays outside the HUD container, because `applyDiff` removes children it does not list.
- `client/core/SceneSetup.js` `probeAndCreateWebGPURenderer`: `?legacygl=1` is the only route to the GLSL renderer.
- `client/core/ShadowPipeline.js` `forceUpdate`: sets `needsUpdate` on every cascade.
- `packages/streaming-gltf/src/model-pool.js`: drains run only while their budget is above zero; never set `opts.impostorCellBudget: 0`.

## Repo boundaries

Detail: `docs/AGENTS-DETAIL.md#repo-boundaries`.

- `scripts/lib/witness-server.mjs` moves `BAKE_INPUTS_HEIGHTFIELD_BAKE`: re-bake `apps/world/tps-game.hf` in the same commit. A script that launches `server.js` without `SPOINT_HOST` needs `SPOINT_HOST=127.0.0.1` or the token.
- `src/sdk/ServerBoot.js` refuses a non-loopback bind without `SPOINT_AGENT_TOKEN` (`agentBindRefusal`, `src/sdk/AgentAuthoringAPI.js`).
- Module workers import three from `/node_modules/three/build/three.module.js`, never the bare `three` specifier (`src/animation/*.js`).
- `apps/*` never imports `client/*`; expose utilities on `engineCtx`.
- Keep Node-only dynamic import specifiers opaque (IIFE, as in `src/sdk/EditorHandlers.js`); `edge/cf-do/spoint-do.js` imports `jolt-edge-init.js` before `WorkerEntry.js`.
- Never flatten the msgpackr specifier in `src/protocol/msgpack.js` `_ensurePackr` to a literal.
- Untrusted apps run only through `src/sdk/SESCompartmentEvaluator.js`, which fails closed with `SandboxUnavailableError`.
- `design` ships as pinned CDN URLs in `client/{index,landing/index,editor/thebird-host}.html` and `scripts/bundle-client.mjs`; `vendor/*` is editing-only.

## Browsers

Detail: `docs/AGENTS-DETAIL.md#browsers`.

- Browsing is headful CDP only: `scripts/lib/cdp-browser.mjs` `launch` refuses a `headless` option.
- Confirm key input through `window.__app.sentInput`; keyboard sets `input.backward`, never `input.back`.
- Headless scripts exit through `scripts/lib/quiesce.mjs` `exitAfterQuiesce`.
- `src/sdk/StaticHandler.js` sends COEP `require-corp`: a cross-origin subresource needs a CORP header or a CORS grant.

## Debugging discipline

Detail: `docs/AGENTS-DETAIL.md#debugging-discipline`.

- Fix at its own layer end to end; a bug that survives a threshold change is not fixed.
- Silent-no-op class: codesearch the reader and the enable bit first (`?noveg`, `__vdrsScale`, `?legacygl=1`, `window.__fsCheap`).
- Silent-default class: parse the whole record at ONE boundary and refuse there (`ColliderStreamer.js`, `src/stage/stageShapes.js`); never `v ?? DEFAULT` on invalid input.
- Test `NO_GROUND_HEIGHT` only with `isNoGroundHeight`, never with `=== 0`; convert it to NaN before a height consumer. `guardedGroundHeight` takes two arguments.
- A non-finite height is no data, never no crossing (`client/core/RelocationSearch.js`); a search with only no-data samples throws `RelocationSearchNoDataError`.
- Refusals carry a code (`reasonCode`), not prose.
- Put a "report once" latch on the returned closure (`PlanetFrame.guardedGroundHeight`), not at module level.
- Witnesses mint integer ids, never strings; the sender is stamped by `stampSender`.
- A bare CLI flag parses to the string `'true'`; guard `Number()` against it.
- A witness that needs the server to act passes `--params=multiplayer`; one `expect()` per measurement.
- Read the driver's console string for a `gl.getError()` code; use `page.evaluate()` for `window` and `document`.
- A dying witness child must surface its stderr (`scripts/lib/witness-server.mjs`).
- `scripts/perf-run.mjs` `--knob=<key>=<value>` takes registry keys verbatim (`maxLevel`, not `__maxLevel`); one bad key fails the run.
- Foliage toggles: `?veg=none`, `?nograss` and `?norocks` skip their layers; `?noveg` is read nowhere.

## XR teleport arc

Detail: `docs/AGENTS-DETAIL.md#xr-teleport-arc`.

- `client/xr/XRWidgets.js` `computeParabolicArc` reads the previous render's matrices: keep the XR update before `renderGraph.run` (`scripts/xr-arc-frame-order-witness.mjs`).
- `client/xr/XRWidgets.js` `initTeleport` builds the BVH for each ground mesh at or above `ARC_BOUNDS_TREE_MIN_TRIANGLES`; that build stalls XR setup by its own cost.
- Controller and reticle objects leave the ground probe only through `userData.xrPointer` (`addPointerObject`, `client/xr/XRSystem.js`); that is not verified in a headset.
- `scripts/e2e-ci.mjs` does not enter an XR session; the arc is not exercised live.

## Entry points

Detail: `docs/AGENTS-DETAIL.md#entry-points`.

- Client `ctx.state` is the entity `custom` block: `ctx.state.<key> ?? literal` takes the literal forever. Read position from `engine.client.getLocalState().position`, because `engine.cam` has no `position`.
- Wireweave attach helpers re-check at call time, since host migration reassigns `client` in `app.js`; `boot()` signals are process-global, stopped with `RoomDirectory.stopAll`.
- Witness a remote server's `netcode.profile` on `?connect=...&multiplayer=1`.
- Spawn release is gated by `holdSpawnUntilGrounded` (`src/sdk/Relocation.js`) and capped at `SPAWN_HOLD_MAX_MS` (20 s).
- `client/BrowserServer.js` keeps `_lastTodSync` and `_deliveredWorldFingerprints` at module level, so a fresh BrowserServer in the same page inherits them.
- The singleplayer world name comes from `init({ worldName })` (`src/sdk/WorkerEntry.js`); `src/sdk/WorldPersistence.js` discards a snapshot on a name mismatch.
- Respawn clearance is one sampler: `src/apps/AppGameplay.js` `footprintBlockers`, used by `pickSpawnPoint` and `apps/tps-game/respawn-clearance.js`; its intrusion limit is `MAX_FOOTPRINT_INTRUSION_M` (0.15 m).
- `client/app.js` `_buildWorldScenery` returns the in-flight `_sceneryBuildPromise`; `Promise.race` does not cancel the losing promise.
- Keep both path-containment checks in `src/sdk/StaticHandler.js` (`containedRealFile`, `src/static/containedFile.js`) when changing static serving.
- Derive world-entity facts from `_modelUrls` and `_entityApps`, not `entities`, which `sendWorldDefAndModules` (`src/sdk/ServerHandlers.js`) strips.
- A hot reload rebuilds `_updateList` and `_collisionEntities` through `_rebuildUpdateList` and `_rebuildCollisionList` (`src/apps/HotReloadQueue.js`).
- Do not simplify `timingSafeTokenEqual` (`src/sdk/authCompare.js`); its same-length self-compare keeps the token length from leaking.

## Fire

Detail: `docs/AGENTS-DETAIL.md#fire`.

- `src/shared/fire/fireKernel.js` `burnCell`: the kernel is integer-only, with no float, Math.random or Date.now.
- A per-tile array in `snapshot()`/`restore()` joins `TILE_ARRAYS` and bumps VERSION.
- `rewindTo` verifies against `counters`, never `delta`.
- A fire record that promises work with no sampler is refused at construction (`src/behaviours/fireTerrain.js`).

## Planet-wide multiplayer

Detail: `docs/AGENTS-DETAIL.md#planet-wide-multiplayer`.

- The Jolt heap is fixed at `JOLT_WASM_HEAP_BYTES` (`src/shared/clusterConfig.js`); overflow raises `Aborted(OOM)`.
- Size `maxContactConstraints` and `maxBodies` for the population: contacts drop silently, and overflow bodies share body id 0.
- Collider rings are per connected player, never the centroid; evict farthest-first (`classifyRings`, `ColliderStreamer.js`).
- Clusters stay disabled in every shipped world; the world-def parser refuses a mismatch in either direction.
- `packCellKey` (`src/terrain/CubeSphereCells.js`) throws `RangeError` past a safe integer; never reintroduce `| 0`.
- `resolveClusterConfig` (`src/shared/clusterConfig.js`) refuses a link shorter than the relevance ring reach.

## Chart re-anchor

Detail: `docs/AGENTS-DETAIL.md#chart-re-anchor`.

- Re-anchor is a change of basis, not rotation: position, velocity and forward stay invariant (`src/sdk/chartState/`).
- `CHART_REANCHOR_ANGLE_DEG` must exceed the worst angle of `createChartAnchorLattice`, or the anchor thrashes.
- `chartEpoch` keys re-anchor in `ChartReanchorService.js`, `ChartReanchorTerrain.js`, `FieldLattice.js`, `ColliderStreamer.js` and the `groundHeightLocal` memo gate.

## Physics and Jolt

Detail: `docs/AGENTS-DETAIL.md#physics-and-jolt`.

- `physics.setBodyMotionType` returns a NEW body id or `false`; use `IsActive()` as the discriminator and recreate a static-created body.
- Create the new body BEFORE destroying the old, on `LAYER_DYNAMIC`; refuse a body holding a constraint, vehicle chassis or trimesh/mesh/heightfield shape.
- Replace a pooled body whose `bodyMeta.type` differs from the requested motion type; copy `getBodyPosition` before the next call.
- Use `GetSampleCount()` (per-side N) and `GetMinHeightValue()`; `get_mMinHeightValue` is not a Jolt method.
- Trimesh and convex build failures propagate as `ColliderBuildError` and refuse boot (`assertTrimeshBuildsClean`, `src/apps/AppRuntime.js`); never degrade to a box.
- `AppRuntimePhysics.js` skips `e._vehicleId != null` in both `_tickPhysicsLOD` and `_enforceBodyBudget`.
- `VehiclePhysics.js`: never `J.destroy` `v.constraint` or `v.tester` after `RemoveConstraint`, nor `get_mTracks()` copies after `set_mTracks`.
- EDITOR_UPDATE calls `syncEntityCollider` AFTER `changeBodyType`; `runtime.applyImpulseToEntity` answers `false` for a force no body received.
- `src/physics/World.js` `removeBody` parks a pooled dynamic body; `deactivateBody` is the explicit API.

## Terrain and colliders

Detail: `docs/AGENTS-DETAIL.md#terrain-and-colliders`.

- `src/terrain/PlanetFrame.js` `installOwned`: refuse any receiver other than the frame that owns the ground sources.
- Start every vertex solve from `renderYOnSphere(r2, 0)` (`HeightfieldStreamer.js`); never seed from previous samples.
- Baked heightfields fail loud (`TerrainPhysics.js`): an absent artifact falls back, but unreadable or stale ones throw `[baked-heightfield]`.
- No terrain is fatal: `ServerAPI.loadWorld` rethrows `[terrain] world "<id>" has no terrain`. `ctx.terrainHeightAt` is not `elevationAtLocal`.
- Verify a placement change with byte-identical sha256 dumps of `placementsForChunk`.
- Wrap the anchor field with `createModelExclusionField` in `client/core/Rocks.js`, `client/core/Vegetation.js` and `client/core/Grass.js`; `ModelExclusionField.js` includes `_interior` models.
- Test the near-quad reach in chart metres, never in face units (`TerrainMeshSurface.js sync`); keep `DEFAULT_MAX_QUADS` at 512.
- `terrain.glsl` `snoise3`, `vnoise2`, `seaHash` and `hpfSample` take the in-cell fraction as `P-floor(P)` from one `floor`.
- `gl-render.js` `sampleGroundM` returns the previous call's height; `sampleGroundMSync` poisons the next async read.
- Gate vegetation density on painted snow; the slope caps differ (`SLOPE_MAX` 0.6 in `VegPlacement`, 0.9 in `GrassPlacement`).
- Every `discard` in `packages/mapspinner/src/shaders/terrain.glsl` sits inside `#ifdef _WATERPASS_`; a discard elsewhere costs early-Z for every draw.
- `src/shared/terrainConfig.js` `terrainCarvesOf`: carves apply only on the non-legacy height backend.

## Grass distance-density

Detail: `docs/AGENTS-DETAIL.md#grass-distance-density`.

- `GRASS_DENSITY` and `grassBladeEdgeM` (`src/terrain/GrassPlacement.js`) are the single source of the law; edit `client/core/Grass.js`, `GrassTSL.js` and `GrassMaterial.js` together, or the fade desynchronises silently.
- The CPU holds each blade from `LEAD_M`, which must exceed `LOD_REVISIT_STEP_M`, or a blade pops.
- `wind.uGrassRing` carries `EDGE_CAP_M`, not the ring radius.
- Judge a ring change on `updateMsPerQuietFrame`, not on the instance count.

## Grass wind field

Detail: `docs/AGENTS-DETAIL.md#grass-wind-field`.

- `client/core/GrassWindField.js` evaluates the gust once per lattice cell; both shader paths read it with one bilinear fetch.
- Rewrite every cell at the frame's time: with 8 bands the wind jerked (jerk ratio 231; 1 band gives 6.4). `scripts/grass-wind-field-seam-witness.mjs` is in the `npm run check` gate.
- `client/core/GrassMaterial.js` vertex stage: `gw` is the only wind term that varies within a blade, so it is evaluated per vertex.

## Netcode and wire

Detail: `docs/AGENTS-DETAIL.md#netcode-and-wire`.

- `src/client/BaseClient.js` `sendInput` stops feeding `predEngine.addInput` at `MAX_PREDICTION_LEAD_STEPS` (16).
- `src/client/PredictionEngine.js` `_reconcile` takes an ack only for a sent input whose own entry is in the history and whose successors are all held (`_firstHeldSequence`).
- `_rebaseAndReplay` replays each entry with the ground normal it was predicted with (`e.normal`), not the ack's normal.
- Prediction suppresses only the blocked direction (`wedgeNormal`, `characterStep.js`).
- `src/protocol/msgpack.js` `WIRE_STRUCTURES[1]` lists the 10 keys of `TickHandler.js _packPayload`, in order; keep them in step.
- MSG ids in `src/protocol/MessageTypes.js` must be unique; `nameMap` throws on a duplicate.
- `src/protocol/msgpack.js` `_ensurePackr`: `pack()` throws until `ensurePacked()` resolves.
- `src/protocol/InputCodec.js` `quantizeInput` truncates `expr`; keep the truncation (`scripts/expr-truncation-witness.mjs`).
- `PhysicsNetworkClient.connect()` rejects with `TransportConnectError`; retry belongs in the caller (`_doReconnect`).
- Probes connect with `?probe=1`; never leave an unresolvable RECONNECT open (`rejectSession` flushes and closes).
- `src/netcode/LockstepGameLoop.js` refuses an `inputDelayTicks` above `INPUT_RETAIN_TICKS` (240).
- Headless witnesses that construct `PhysicsNetworkClient` assign `globalThis.WebSocket` from `ws` first (`scripts/chart-reanchor-wire-harness.mjs`).
- `src/netcode/RollbackGameLoop.js`: keep `maxRollbackTicks + inputDelayTicks` below the state ring window.

## Patched dependencies

Detail: `docs/AGENTS-DETAIL.md#patched-dependencies`.

- `scripts/patch-deps.mjs` `patch`: `src.includes(marker)` is the only idempotency test; each payload carries its own marker (`scripts/patch-deps-marker-witness.mjs`).
- A payload without its marker is injected again on every postinstall.
- The three.webgpu.js `popErrorScope()` patch covers three sites; its markers are pinned by `scripts/patch-deps-marker-witness.mjs`.

## Hot swap

Detail: `docs/AGENTS-DETAIL.md#hot-swap`.

- A module accepts its own edits with `globalThis.__spointHmr?.acceptSelf?.(import.meta.url, swap)`; an ancestor acceptor cannot help, because existing importers never read a re-import.

## Dev HMR bodies

Detail: `docs/AGENTS-DETAIL.md#dev-hmr-bodies`.

- A `?hmr=` body depends only on the file, the version floor and the active versions of its direct imports; `Cache-Control: no-cache` makes a reload answer 304.
