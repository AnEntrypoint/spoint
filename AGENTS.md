# AGENTS.md

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

# AGENTS.md — Non-obvious Technical Caveats Index

Slugs only; full text lives in the recall store (`.gm/memories/`, query with `recall <slug or topic>`).
If recall is empty, check `git log -p -- AGENTS.md` for the pre-drain text. Add a caveat with
`memorize-fire` (`project/<area>-<slug>: ...`) and append its slug below. Keep this file < 30KB:
drain narrative into recall, never grow an audit log here.

## Main-only, no branches, lanmower-only

Work directly on `main`; merge any stray work branch into `main` and delete it (`gh-pages` is a deploy
artifact branch and stays). Commit only as `lanmower` (`657315+lanmower@users.noreply.github.com`);
never attribute an AI assistant in any commit, PR, or file. Rule applies inside every submodule too.

## Source has no comments

Names and structure carry meaning; rationale that code cannot carry lives in recall (slugs below),
the commit message, or this file. The 2026-09-14 sweep moved every source comment out of
client/ src/ apps/ scripts/ packages/{mapspinner,streaming-gltf,ecs}/src. Kept on purpose: `@ts-*`,
`eslint*`, `@vite-ignore`, `webpack*`, `/*! */`, `#__PURE__`, `sourceMappingURL` directives, and
comment-looking text inside string/template literals (embedded GLSL, `scripts/patch-deps.mjs`'s
`// [spoint patch]` idempotency markers, generated-file headers) -- that is runtime data.
Generated/minified files are exempt: `packages/mapspinner/src/height-gen.js` (from terrain.glsl via
`scripts/gen-height.mjs`, which strips GLSL comments itself), `*/basis/basis_transcoder.js`,
`packages/streaming-gltf/src/draco-loader.js`, `client/editor/sdk-typings.generated.d.ts`.

## AnEntrypoint dependencies and `vendor/*` submodules (`project/anentrypoint-consumption-and-submodules`)

AnEntrypoint publishes nothing to npm. Runtime sources, the only ones code may reference:

| Repo | Runtime consumption | Edit checkout |
|---|---|---|
| `AnEntrypoint/design` | pinned CDN URLs in the importmaps (+ stylesheet/modulepreload links) of `client/index.html`, `client/landing/index.html`, `client/editor/thebird-host.html`, `scripts/bundle-client.mjs`: bare `anentrypoint-design` -> `unpkg.com/anentrypoint-design@1.0.34/dist/247420.{js,css}`; `game-editor-kit` -> jsdelivr `gh/AnEntrypoint/design@<sha>/src/components/game-editor-kit/index.js`. Bump all four files together. | `vendor/design` |
| `AnEntrypoint/wireweave` | `package.json` optionalDependencies `github:AnEntrypoint/wireweave` (npm clones default branch; src/ only; importmaps remap to `/node_modules/wireweave/src/index.js`; Node uses bare `import('wireweave')`) | `vendor/wireweave` |
| `AnEntrypoint/gm` | global `npx gm-skill install` / `gm-plugkit`, not a spoint dependency | `vendor/gm` |

`vendor/*` are editing-only submodules: never import them from `client/`, `scripts/`, `src/`. Edit on
the submodule's own `main`, push to that repo's remote, then commit the new gitlink in spoint
(bookkeeping only); runtime picks the change up when the pinned kit version/SHA is bumped, on the next
`npm install` (wireweave), or on a fresh `gm-skill install`. The importmaps also remap
`https://esm.sh/three@r128` keys to the local three so the kit's ModelPreview never loads a second
three (`project/importmap-esmsh-three-dedupe`); COEP `require-corp` means every kit CDN must send CORP. The importmap must precede any module load/preload. No npm dependency on the
kit (a second copy would silently disagree with the importmap). `nostr-tools` is injected into
wireweave from `client/vendor/nostr-tools.mjs`. Pin a wireweave SHA if a build must be reproducible; no CI in this repo tests against wireweave@main
(the repo has no .github workflows). gmsniff and agentgui deliberately vendor the kit.
Add a fourth submodule only with a documented runtime mechanism.

## All GUI lives in AnEntrypoint/design (`project/gui-kit-architecture-2026-08-21`)

Every UI component (screens, dialogs, panels, editor kit incl. asset browser/model preview/undo
history, damage numbers) is built in `AnEntrypoint/design` (`src/components/game-editor-kit/` for
editor/gameplay panels) and reaches spoint only via the pinned CDN importmap entries. spoint keeps backend only
(e.g. `src/editor/ThumbnailGenerator.js`, `src/editor/ThumbnailWorker.js`,
`src/sdk/ModelBrowserHandler.js`, `src/effects/DamageEffects.js`, `apps/hit-feedback` event wiring).
Reject any change adding UI-rendering `*.js`/`*.html`/`*.css` under `client/` without the design-repo
work; design change first, spoint integration next commit; verify on the live URL with `?v=<ts>`.

## Root-cause, never tune thresholds (`project/degenerate-triangle-threshold-is-not-a-tunable-guess`, `project/degenerate-triangle-third-copy-and-immutable-cache`)

A bug that survives a numeric-threshold change was not fixed: re-diagnose the mechanism. Exhaust
structural fixes first; derive any remaining threshold from a measured discontinuity in real data
(aim_sillos.glb `EPS_AREA=1e-4` sits in a verified gap of the triangle-area histogram). When a fix
correct at its own layer fails end-to-end, search the whole pipeline for another copy of the same check
(the degenerate-triangle check lived in `src/physics/ShapeBuilder.js`,
`packages/streaming-gltf/tools/bake-cluster.mjs`, and `packages/streaming-gltf/src/cluster-lod-mesh.js`).
Any re-bakeable (non content-hashed) URL needs a real ETag; `immutable` without one serves stale
pre-fix bytes. Verify rendering defects on live GPU-bound data (`window.__scene`), not bake re-parses.

## Server-only endpoints are dead on the static gh-pages host

`/client-error` (`client/core/ErrorTelemetry.js`) and `/upload-model` (`client/editor/editor.js`) are
server routes (`src/sdk/ServerAPI.js`) absent on gh-pages; both no-op behind `.catch` there (accepted
2026-08-03; to change it, probe server presence once and feature-gate both call sites).

## Debugging playbook (`project/debugging-playbook-live-gl-instrumentation-2026-07-10`)

Live GL-error/rendering-defect method: console-text disambiguation of same-code GL errors, draw-call
stack capture, live GL state over JS-cache trust, pixel-sample toggle elimination for flicker, classify
discrete-vs-noise before chasing. Underwater/waterline and grazing-altitude water cull:
`project/ground-depth-cut-is-underwater-ceiling-waterline-crossing` (tools: `window.__tpOverride`,
`window.__passProbe`; out-of-band `renderer.render` captures fake a black void).

## Recall topic catalog

Terrain (`project/terrain-*`): super-chunk-tiling, edge-snap-skirt, stitching-live-neighbour-lod, cross-factor-edge-fast-res-fallback, cross-factor-stitch-invalidation, restitch-priority-inversion, gpu-displacement-arch, uv-double-scale-bug, strict-1-tile-raf, camera-footprint-eviction, streaming-priorities-eviction, worker-count-cap, pendingevict-zfight, buffergeo-upload-stall, edge-normal-fbm-opt, sampler-lru-cache, shortest-queue-dispatch, stale-result-drop, evicted-geo-cache, adaptive-lod, baked-normals-cross-lod, sample-at-scratch-buffers, config-world-to-client-flow, client-html-singleplayer-survivor-redirect, cpu-gpu-height-parity-integer-hash, mapspinner-single-source-of-truth, terrain-occlusion-postrender-queries, terrain-is-a-proper-app, misc-caveats.

Vegetation (`project/veg-*`): frustum-culling-bounding-sphere, lod-bands-bitmask, lod-rebuild-cache, debug-overwrite-trap, atomic-lod-swap, collapse-variant-buckets, billboard-cylindrical-impostor, billboard-bake-async-image-poll, billboard-renderdistance-gate, placement-lod-invariant, y-scale-zero-pancake, lodband-stale-recompute, eztree-branch-polycount, stale-result-double-build, canvas-destination-in, terrainfield-anchor-kind-preserve, eztree-material-name-split, eztree-no-node, server-world-env, placement-args-passthrough, bake-billboard-temp-parent, capsule-uniform-scale, cull-on-approach-union-box-and-toggle-isolation.

Physics (`project/physics-*`): jolt-arrayfloat-getpointer, jolt-browser-multithread-coi-confirmed-null-function-was-caller-error, jolt-wasm-cross-platform-bit-exact, jolt-lockstep-multiprocess-fixed-dt-bit-exact, lockstep-tick-driver-fixed-dt-bypass-dilation, lockstep-game-loop-orchestrator-integration, jolt-getangularvelocity-shared-buffer-double-destroy, jolt-getpositionrotation-shared-buffer-double-destroy, terrain-radius-cap, collider-res-128-to-64, terrain-tick-decouple, tick-dilation-freeze, streaming-decouple-validated, player-divisor-dt-bug, no-fallthrough-kill-plane-real-character, collider-streamer-fresh-territory-tick-stall, rollback-wireweave-input-transport-orchestrator; `project/ragdoll-brawl-arena-no-joint-api`, `project/vehicles-jolt-constraint-available-not-just-twobody`.

Rocks (`project/rocks-*`): integrated-veg-pipeline, second-pass-grid, convex-hull-colliders, sync-bake-required, normal-alignment-size.

Movement/Animation: `project/movement-coyote-buffer`, `-soft-land`, `project/animation-anim-locostate-thresholds-vs-sprintspeed`, `-anim-sendloco-cooldown-actor-desync`. Testing: `project/test-vegetation-physics-async-yield`.

Rendering: `project/instanced-mesh-shared-geo-trap`, `project/sun-shadow-player-follow`, `project/sim-render-pacing-vsync-input-stamp`, `project/placement-scheduler-raf-decouple`, `project/render-graph-live-orchestrator`, `project/fog-band-and-night-ambient-silhouette`.

Model display (`project/modelpool-*`): scene-attach-proxy-root, transform-direct-not-opts, useglobalmaterialpool-off-per-texture, bake-webp-source-normalize, bake-empty-prim-guard, vrm-multidriver-player-routing, doubleside-interior-faces-is-custom-flag, draco-wasm-removed-purejs-clientwide, cluster-lod-double-transform, placement-y-tuned-for-broken-scale, cluster-onbeforerender-custom-draw-bind-timing, legacy-visibility-cull-vs-pool-lod.

App/SP/GLB/RTC/Misc: `project/window-app-two-stage-init`, `project/window-tune-hot-reload`, `project/singleplayer-and-app-api-caveats`, `project/glb-loading-caveats`, `project/wireweave-rtc-caveats`, `project/misc-rendering-ci-browser-caveats`, `project/multiplayer-host-world-resolution`, `project/multiplayer-gitignore-worker-dep-404`, `project/statichandler-symlink-nodemodules-404`, `project/one-server-two-client-modes-same-origin`, `project/multiplayer-host-bridge-peeropen-catchup`, `project/wireweave-dc-close-recovery`, `project/loading-fallback-races-slow-worker`, `project/startup-coldboot-bottleneck-fixes`, `project/startup-rehunt-anim-lib-earlykick`, `project/env-app-removed-fold-into-placed-model`, `project/resolveasset-worker-fetch-needs-origin-slash`, `project/edge-cf-workers-feasibility-workerentry-already-proves-core`, `project/lockstep-e2e-real-webrtc-node-datachannel-dead-end-roamhq-wrtc-works`, `project/workerentry-visibilitychange-save-now`, `project/rollback-wireweave-transport-namespace-must-match`, `project/webgpurenderer-live-runtime-construction-works-shadowcostprobe-crashes`, `project/room-orchestrator-router-is-lookup-not-proxy`, `project/room-orchestrator-load-aware-placement-tickmetrics`, `project/browser-verb-chrome-pileup-direct-launch-workaround`, `project/p2p-mesh-split-brain-three-layer-fix`, `project/singleplayer-worker-boot-stall-on-cold-backgrounded-tab`, `project/singleplayer-world-json-stale-copy-removed`, `project/tps-game-bug-sweep-2026-08-13d`.

Workspaces/deploy: `project/workspaces-merged-packages` (mapspinner + streaming-gltf are in-repo npm workspaces under packages/, edited directly), `project/merge-cleanup-2026-07-07c`, `project/ghpages-deploy-symlink-cp-collision`, `project/ghpages-deploy-silent-freeze`, `project/ghpages-deploy-sed-node-modules-overreach`, `project/ghpages-confirming-pass-thebird-and-bake-2026-08-03`, `project/sillos-scramble-hypothesis-disproven`, `project/auto-declaudeify-history-rewrite`.

Game/editor: `project/game-fsm-xstate5` (`ctx.defineGameFSM(spec)` in `apps/_lib/game-fsm.js`, `fsm.tick(dt)` from `update`), `project/client-machine-xstate5-parallel` (`client/core/ClientMachine.js`), `project/loading-machine-fallback-timeout` (xstate `after:` fallback 10s gated / 45s hard stop), `project/editor-hierarchies` (REPARENT/DUPLICATE/SET_LABEL 0x94-0x96), `project/engine-prep-app-maker-primitives-2026-07-12b`, `project/editor-engine-prep-fieldtypes-placeable-apps-2026-07-12c`, `project/engine-prep-16-primitives-2026-07-12d`, `project/engine-prep-fanout-2026-07-12d`.

Editor input/a11y: `project/editor-pointer-input`, `project/kit-modal-aria`, `project/kit-emptystate-text-prop`, `project/browser-verb-direct-cdp`, `project/editor-docked-panel-chrome`, `project/editor-crossscreen-polish`, `project/editor-uncovered-polish`, `project/editor-apps-imperative-filebrowser`, `project/editor-floating-docks`, `project/upload-glb-server-prep`.

Editor core: `project/editor-black-rootcause-is-app-bg`, `project/editor-flycam-never-activated-rootcause`, `project/editor-create-primitive-spawn`, `project/editor-interactions-pick-hookflow-shoot-fixes`, `project/editor-player-look-pitch-frozen`, `project/editor-destructive-run-2026-06-08`, `project/editor-bodytype-switch-lod-rebuild`, `project/editor-add-menu-props-and-primitives`, `project/snapshot-removed-array-truthy-shortcircuit`, `project/editor-viewport-multiselect-and-nudge`, `project/hierarchy-sibling-drop-and-virtualization`, `project/thebird-wm-editor-chrome`, `project/wm-ui-kit-mechanical-swap`, `project/editor-freelook-editmode-apply-and-rmb-source`, `project/sillos-rescale-geometry-baked-and-prewarm-await`.

Landing/SDK: `project/anentrypoint-design-applydiff-mount-required`, `project/landing-themetoggle-crumb-slot`, `project/kit-appshell-doc-route-flex`.

Quality/perf method: `project/dna-quality-run-2026-06-08`, `project/netcode-feel-run-2026-06-08`, `project/dna-netcode-rerun-2026-06-09`, `project/dna-quality-rerun-2026-06-09b`, `project/fun-max-run-2026-06-11`, `project/fun-over-latency-workflow-2026-06-12`, `project/perf-vsync-headroom-not-bound`, `project/perf-fxc-cse-double-eval-phantom`, `project/perf-gpu-timer-bracket-real-render`, `project/perf-cpu-bound-frame-fixes-144fps`, `project/perf-144fps-catalog-vsync-vs-cpu-bugs` (`.gm/perf-144fps-opportunities.md`), `project/perf-unattributed-program-bucket-gpu-driver`, `project/grass-tf-premise-mutual-exclusion`, `project/grass-commitchunk-batched-addinstances`.

Terrain/render arc: `project/gpu-patch-whole-planet-collider`, `project/sector-bounded-quant-binary-hf`, `project/sun-coherence-single-source`, `project/msaa-depth-write-shader-pass`, `project/water-depth-share-not-terrain-only`, `project/cull-cluster`, `project/grass-fluffygrass`, `project/morton-only-where-access-fits`, `project/mapspinner-dep-file-edit-marker-gated-bridge`, `project/instancedmesh2-count-accessor-trap`, `project/underwater-model-tint-shaderchunk`, `project/foliage-a2c-aniso-after-bake`.

## Code rationale index (moved out of source comments, 2026-09-14)

Full text: `recall <slug>` (bodies tracked in `.gm/memories/`). Read the memo before changing the named code.

Load-bearing caveats:
- three: editing a `ShaderChunk` + `needsUpdate` never recompiles (`three-shaderchunk-edit-needsupdate-noop`); InstancedMesh2 custom/override shaders need `instanced_pars_vertex` + `getInstancedMatrix()` and `addShadowLOD` children get a bare ShaderMaterial (`overridematerial-instancedmesh2-instanceindex`, `instancedmesh2-addshadowlod-default-material`); a BatchedMesh with an array material never draws (`batchedmesh-array-material-never-draws`); shadow pass is also gated by `renderer.shadowMap.needsUpdate` (`shadowcostprobe-three-shadowmap-scope-gate`).
- Model pool: one KTX2Loader per GL context (`modelpool-shared-ktx2loader-singleton`); never share one BufferGeometry across N meshes (`modelpool-per-instance-geometry-shell`); VRAM monitor only lowers the LOD ceiling (`modelpool-vram-one-way-ratchet`); ClusterLodMesh needs its array material, seed group and once-per-frame guard (`streaming-gltf-clusterlodmesh-array-material-seed-group`).
- Spaces: FloatingOrigin rebase sets camera to 0 (`floating-origin-camera-set-not-translate`); editor/snapshot positions are render-space, wire is authoritative (`editor-render-vs-authoritative-positions`, `floating-origin-snapshot-targets-to-render`); THREE near/far must equal `window.__hostNearFar` (`depth-composite-hostnearfar-contract`).
- mapspinner: pin every sampler unit and rebind each frame, THREE shares the context (`mapspinner-sampler-units-never-empty`, `mapspinner-shared-gl-context-state-hazards`); FXC: single-floor noise, `uNoUnroll` bound = `FXC_UNROLL_DEFEAT_LOOP_BOUND` (`mapspinner-snoise3-single-floor-fxc`, `mapspinner-unounroll-loop-bound`); mirrored tables change together: face frame (6 copies), HPF inset triple, ATM/scattering LUT constants (`mapspinner-face-frame-tables-agree`, `mapspinner-hpf-inset-matched-triple`, `mapspinner-atm-lut-constants-mirror-glsl`, `mapspinner-scattering-lut-glsl-layer-mirror`); `sampleGroundM` is one call stale (`mapspinner-samplegroundm-one-call-stale`); discards only under `_WATERPASS_` (`mapspinner-waterpass-discard-isolation`).
- Runtimes: module Workers have no importmap; SDK server code also runs in the singleplayer Worker (guard `process`, no static `node:*`); apps never import client/* (`worker-module-no-importmap-bare-specifier`, `sdk-dual-runtime-process-guard`, `apps-cannot-import-client-modules`); build Node-only `import()` specifiers inside an IIFE (`esbuild-import-specifier-iife-not-concat`); BrowserServer flushes on setTimeout, never rAF (`browserserver-snapshot-flush-settimeout-not-raf`).
- Apps: moving apps need kinematic/dynamic bodyType (`moving-app-entity-needs-dynamic-bodytype`); siblings may not be set up during `setup()` (`app-setup-sibling-entities-not-ready`); client payloads never reach inventory mutators (`inventory-client-payload-trust-boundary`); schemas are positional on the wire (`component-schema-positional-wire`); epoch/config columns are f64 (`componentpool-f64-for-epoch-and-config`); `setBodyPosition` wakes bodies, park with `setBodyActive(false)` (`destructible-pool-park-deactivate-and-hide`); `ctx.physics.addForce` is an impulse (`app-physics-addforce-is-impulse`).
- Physics (Jolt): destroy ShapeResult after addBody only; never destroy getter/vehicle-owned objects (`physics-jolt-shaperesult-destroy-after-addbody`, `physics-jolt-getter-return-destroy-hazards`, `physics-jolt-vehicle-ownership-and-wake`); vehicle chassis exempt from physics LOD/budget sweeps (`physics-lod-vehicle-chassis-exempt`).
- Netcode/wire: `WIRE_STRUCTURES[1]` = TickHandler `_packPayload` keys in order (`msgpack-wire-structures-snapshot-key-list`); entity bin buffers freshly allocated per re-encode (`snapshot-entity-bin-fresh-buffer`); `knownIds` reset only on keyframes (`tickhandler-knownids-reset-only-on-keyframe`); determinism comes from dt (`netcode-dt-determinism-source`); lockstep checksum folds raw f64 in id order (`lockstep-checksum-canonical-float64-order`); P2P control frames are prefixed strings (`p2p-wireweave-ctrl-frame-prefixes`); new BaseClient callbacks must join its allowlist (`baseclient-callback-allowlist`); input sanitizing is load-bearing (`inputguard-sanitize-yaw-and-input-bucket`).
- Server/security: auth matrix with `EDITOR_TOKEN` unset (`server-http-auth-matrix`); untrusted app eval is SES-only and fails closed with `SandboxUnavailableError` (`ses-evaluator-fails-closed-no-proxy-tier`); static path containment + COOP/COEP (`statichandler-path-containment`, `statichandler-coop-coep-require-corp`).
- Terrain/assets: colliders ring each player, never the centroid (`terrain-collider-streamer-per-player-rings`); placement is client/server hash parity (`terrain-placement-parity-salt-and-prejitter-cell`); glTF repack uses EXT_meshopt byte ranges (`glbktx2-meshopt-bufferview-ext-range`); rocks share seed 1337/stride 7919 with RockShapes (`rocks-visual-physics-seed-parity`).
- Editor/UI/tooling: kit `applyDiff` crash classes, HUD overlays mount on `document.body` (`kit-applydiff-child-crash-classes`, `hud-overlay-mount-outside-uiroot`); harnesses use `?multiplayer` + `SPOINT_NO_WATCH=1` (`e2e-harness-multiplayer-param-and-no-watch`); bundle stays unhashed `dist/client/app.js` with streaming-gltf external (`bundle-client-outfile-and-externals`).

More slugs (prefix `project/`): client/core `csm-shaderchunk-patch-placement csm-unrolled-loop-index-not-i vrm-expression-v0-names-remapped-at-load occlusion-proxy-needs-geometry-child collider-debug-mirrors-terrainphysics-grid fluidsurface-winding-and-exact-rim-probe postpass-debug-global-and-msaa-copy shadowpipeline-per-light-needsupdate-dead-cascade0 ssr-wetness-skips-custom-onbeforerender terrainbackdrop-height-parity-invariants rendercontrols-knob-global-debug-handle-collision vat-bake-bind-pose-traps progressive-ktx2-partial-container-rewrites rocks-batchedmesh-perf-quirks scenery-shader-warm-real-render ssao-default-off-half-res-upsample-smear ios-gyro-permission-user-gesture instancedmesh2-lod-geometry-identity veg-instancedmesh2-cull-invariants veg-impostor-mesh-handoff-crossfade veg-impostor-zero-area-lod-bbox-bvh wetness-lights-fragment-begin-splice`; streaming-gltf `modelpool-webgpu-occlusion-tier-dynamic-import modelpool-lod-mesh-local-space modelpool-cluster-mesh-parent-and-drawrange modelpool-frame-drains-never-zero modelpool-slot-matrix-write-at-acquire modelpool-worker-float32-normalized-false modelpool-texture-slot-no-map-catchall modelpool-instanced-slot-dirty-run-uploads streaming-gltf-clusterlodmesh-once-per-frame-render streaming-gltf-clusterlodmesh-aabb-cull-cache streaming-gltf-interleaved-attribute-array-hazard streaming-gltf-fan-triangle-cluster-diagonal streaming-gltf-ktx2-mip-cap-mirrors-progressive-ktx2 occlusion-query-tier-flush-and-sticky-verdict occlusion-query-box-polygon-offset texture-array-atlas-map-required-and-no-2d-atlas octa-impostor-atlas-linear-albedo octa-impostor-params-fragment-scope webgpu-hiz-cull-mirrors-cpu-tiers grass-material-instancedmesh2-raw-shader`; mapspinner `mapspinner-webgl2-clientwaitsync-zero-timeout mapspinner-fbo-attachment-sampler-feedback-loop mapspinner-glsl-rt-fround-parity mapspinner-rgba32f-not-rgb32f-renderable mapspinner-depth-share-shader-pass-not-blit mapspinner-vdrs-depth-preclear-frame1 mapspinner-atmosphere-lut-param-mirror mapspinner-atmosphere-direct-sun-elevation-independent mapspinner-patchbaker-thc-globals-last-init-wins mapspinner-face-frame-and-offface-clamp mapspinner-cull-near-straddle-keep-mirror mapspinner-geomorph-per-vertex-default-off mapspinner-geomorph-crackfree-rules mapspinner-webgl2-array-upload-unpack-flags mapspinner-hpfsample-manual-quintic-taps mapspinner-hpf-inset-bake-pair mapspinner-water-visprobe-overreport mapspinner-splat-uv-camera-relative mapspinner-sculpt-override-domain mapspinner-anchor-field-worlddir-seam mapspinner-anchor-bands-infill-neutral mapspinner-hpf-aqt-overlay-guards mapspinner-scattering-lut-bake-guards mapspinner-sky-exposure-elevation-scaled-blue-bias`; client/editor/hud `editor-gizmo-axis-line-drag editor-applydiff-owns-container-children procgen-wfc-socket-keys-uppercase editor-duplicated-normalizers-sync editor-wm-css-absolute-href kit-contextmenu-editor-addmenu-quirks voice-wireweave-voicesession-audible-join importmap-esmsh-three-dedupe anim-sendloco-cooldown-before-actor-send browserserver-page-lineage-rebuild-state app-hud-applydiff-dedicated-container hostmigration-retire-joinclient-not-disconnect entity-primitive-shared-cache-invariants rollback-transport-stale-ticks-still-delivered snapshot-relay-getclient-thunk-and-fortarget service-worker-full-url-keys-network-first-nav vrm-update-single-driver-normalized-bones ghpages-head-probe-503-retry`; apps `audio-media-element-source-once component-pool-plain-arrays-epoch-f64 destructible-impact-scan-and-fractured-model sph-seed-lattice-must-fit-boundary game-fsm-xstate-specifier-bundler-opaque health-reentrant-callback-fresh-read shrinking-zone-ring-needs-placeableapps softbody-rapier-fixed-body-needs-collider app-moving-entity-bodytype-and-setposition checkpoint-oncheckpoint-one-shot-per-index destructible-debris-shapekey-folds-mass app-client-enginectx-shape app-teardown-releases-native-physics shrinking-zone-ring-unit-radius-mirror sph-particle-mass-derived-from-rest-density`; src/apps+client `apploader-hotreload-watch-debounce appruntime-pending-setup-event-queue appruntime-broadcastmessage-key-snapshot appruntime-vehicle-before-chassis-teardown appruntime-resim-deferral-flush-order appstate-map-set-tagged-snapshot snapshot-slot-release-window-vs-jitterbuffer interact-cooldown-tick-indexed hotreload-migrate-contract prediction-copystate-excludes-move-timers`; netcode `connectionmanager-split-reliable-unreliable-outbox inspector-debug-swallow-excludes-defined-msg lockstep-gameloop-seed-and-poll-stall-while-waiting lockstep-consensus-majority-sustained-ejection eventlog-ingestremote-cross-shard-contract physics-integration-config-nullish-per-field rollback-resim-hidden-state snapgroup-cursor-wraps-current-band rewind-slop-covers-history-window snapshot-sleeping-prop-throttle-escapes rollback-gameloop-registration-order msgpack-pack-throws-before-ready-timer-guard`; server `statichandler-early-hints-quirks static-cache-validators-and-compression server-reload-deps-mirror-tickhandler-args server-worldconfig-live-accessor server-loadworld-ordering room-directory-shared-process-state editor-update-collider-sync-order editor-place-app-seeds-config-not-custom auth-compare-length-mismatch-decoy minimap-descriptor-duplicated-boot-and-reseed tickhandler-rollback-sim-state-maps entity-direct-field-patch-invalidation worldpersistence-save-yield-and-timers`; physics/terrain/static `physics-body-pool-dynamic-park-revive procgen-mulberry32-warmup-and-wfc-plain-array sph-wasm-instance-is-a-simulation sph-solver-stiffness-and-mass-consistency terrain-collider-streamer-add-budget-per-add terrain-planetframe-basis-and-fresh-dir terrain-cubespherecells-face-frame-copy transport-open-event-not-microtask-poll glbktx2-ktx-cli-invocation gltf-transform-io-extension-registration idbadapter-open-timeout-cold-tab progressivebake-sanitize-sourceless-textures`; client/app.js + render graph `app-animate-skips-during-shader-warmup rendergraph-order-only-read-marker app-clear-editing-input-fresh-object player-mesh-visibility-flag-owners app-foliage-requires-planet p2p-host-claim-relay-window texture-recovery-after-long-hidden scenery-build-timeout-30s devtools-install-before-client-tdz editor-optimistic-custom-writeback host-camera-near-altitude-independent foliage-placement-authoritative-focus foliage-lod-sync-cadence-split shader-warmup-abort-no-interleaved-render skeleton-bone-texture-ping-pong tps-game-baked-heightfield-rebake tps-game-sillos-y-offset tps-game-ice-servers-demo-turn`; scripts `scripts-tsc-7x-no-js-api fracture-scale-eps-and-cap-winding patch-deps-instanced-mesh-pinned-patches cdp-browser-pageerror-only cdp-browser-ci-portability static-export-single-pass-base-prefix bundle-worker-node-only-deps-external scripts-ws-coalesced-frame-mirror worktree-setup-common-dir-and-ignore-scripts worktree-remove-follows-node-modules-junction`.

## Audit log

Per-session narrative is not kept here (drained 2026-09-14; pre-drain text in `git log -p -- AGENTS.md`).
Durable lessons from those sessions are the slugs above.

@.gm/next-step.md
