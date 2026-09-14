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
wireweave from `client/vendor/nostr-tools.mjs`. Pin a wireweave SHA if a build must be reproducible;
`cross-repo-ci.yml` tests against wireweave@main daily. gmsniff and agentgui deliberately vendor the kit.
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

Rendering: `project/instanced-mesh-shared-geo-trap`, `project/sun-shadow-player-follow`, `project/sim-render-pacing-vsync-input-stamp`, `project/placement-scheduler-raf-decouple`, `project/render-graph-live-orchestrator`.

Model display (`project/modelpool-*`): scene-attach-proxy-root, transform-direct-not-opts, useglobalmaterialpool-off-per-texture, bake-webp-source-normalize, bake-empty-prim-guard, vrm-multidriver-player-routing, doubleside-interior-faces-is-custom-flag, draco-wasm-removed-purejs-clientwide, cluster-lod-double-transform, placement-y-tuned-for-broken-scale, cluster-onbeforerender-custom-draw-bind-timing, legacy-visibility-cull-vs-pool-lod.

App/SP/GLB/RTC/Misc: `project/window-app-two-stage-init`, `project/window-tune-hot-reload`, `project/singleplayer-and-app-api-caveats`, `project/glb-loading-caveats`, `project/wireweave-rtc-caveats`, `project/misc-rendering-ci-browser-caveats`, `project/multiplayer-host-world-resolution`, `project/multiplayer-gitignore-worker-dep-404`, `project/statichandler-symlink-nodemodules-404`, `project/one-server-two-client-modes-same-origin`, `project/multiplayer-host-bridge-peeropen-catchup`, `project/wireweave-dc-close-recovery`, `project/loading-fallback-races-slow-worker`, `project/startup-coldboot-bottleneck-fixes`, `project/startup-rehunt-anim-lib-earlykick`, `project/env-app-removed-fold-into-placed-model`, `project/resolveasset-worker-fetch-needs-origin-slash`, `project/edge-cf-workers-feasibility-workerentry-already-proves-core`, `project/lockstep-e2e-real-webrtc-node-datachannel-dead-end-roamhq-wrtc-works`, `project/workerentry-visibilitychange-save-now`, `project/rollback-wireweave-transport-namespace-must-match`, `project/webgpurenderer-live-runtime-construction-works-shadowcostprobe-crashes`, `project/room-orchestrator-router-is-lookup-not-proxy`, `project/room-orchestrator-load-aware-placement-tickmetrics`, `project/browser-verb-chrome-pileup-direct-launch-workaround`, `project/p2p-mesh-split-brain-three-layer-fix`, `project/singleplayer-worker-boot-stall-on-cold-backgrounded-tab`, `project/tps-game-bug-sweep-2026-08-13d`.

Workspaces/deploy: `project/workspaces-merged-packages` (mapspinner + streaming-gltf are in-repo npm workspaces under packages/, edited directly), `project/merge-cleanup-2026-07-07c`, `project/ghpages-deploy-symlink-cp-collision`, `project/ghpages-deploy-silent-freeze`, `project/ghpages-deploy-sed-node-modules-overreach`, `project/ghpages-confirming-pass-thebird-and-bake-2026-08-03`, `project/sillos-scramble-hypothesis-disproven`, `project/auto-declaudeify-history-rewrite`.

Game/editor: `project/game-fsm-xstate5` (`ctx.defineGameFSM(spec)` in `apps/_lib/game-fsm.js`, `fsm.tick(dt)` from `update`), `project/client-machine-xstate5-parallel` (`client/core/ClientMachine.js`), `project/loading-machine-fallback-timeout` (xstate `after:` fallback 10s gated / 45s hard stop), `project/editor-hierarchies` (REPARENT/DUPLICATE/SET_LABEL 0x94-0x96), `project/engine-prep-app-maker-primitives-2026-07-12b`, `project/editor-engine-prep-fieldtypes-placeable-apps-2026-07-12c`, `project/engine-prep-16-primitives-2026-07-12d`, `project/engine-prep-fanout-2026-07-12d`.

Editor input/a11y: `project/editor-pointer-input`, `project/kit-modal-aria`, `project/kit-emptystate-text-prop`, `project/browser-verb-direct-cdp`, `project/editor-docked-panel-chrome`, `project/editor-crossscreen-polish`, `project/editor-uncovered-polish`, `project/editor-apps-imperative-filebrowser`, `project/editor-floating-docks`, `project/upload-glb-server-prep`.

Editor core: `project/editor-black-rootcause-is-app-bg`, `project/editor-flycam-never-activated-rootcause`, `project/editor-create-primitive-spawn`, `project/editor-interactions-pick-hookflow-shoot-fixes`, `project/editor-player-look-pitch-frozen`, `project/editor-destructive-run-2026-06-08`, `project/editor-bodytype-switch-lod-rebuild`, `project/editor-add-menu-props-and-primitives`, `project/snapshot-removed-array-truthy-shortcircuit`, `project/editor-viewport-multiselect-and-nudge`, `project/hierarchy-sibling-drop-and-virtualization`, `project/thebird-wm-editor-chrome`, `project/wm-ui-kit-mechanical-swap`, `project/editor-freelook-editmode-apply-and-rmb-source`, `project/sillos-rescale-geometry-baked-and-prewarm-await`.

Landing/SDK: `project/anentrypoint-design-applydiff-mount-required`, `project/landing-themetoggle-crumb-slot`, `project/kit-appshell-doc-route-flex`.

Quality/perf method: `project/dna-quality-run-2026-06-08`, `project/netcode-feel-run-2026-06-08`, `project/dna-netcode-rerun-2026-06-09`, `project/dna-quality-rerun-2026-06-09b`, `project/fun-max-run-2026-06-11`, `project/fun-over-latency-workflow-2026-06-12`, `project/perf-vsync-headroom-not-bound`, `project/perf-fxc-cse-double-eval-phantom`, `project/perf-gpu-timer-bracket-real-render`, `project/perf-cpu-bound-frame-fixes-144fps`, `project/perf-144fps-catalog-vsync-vs-cpu-bugs` (`.gm/perf-144fps-opportunities.md`), `project/perf-unattributed-program-bucket-gpu-driver`, `project/grass-tf-premise-mutual-exclusion`, `project/grass-commitchunk-batched-addinstances`.

Terrain/render arc: `project/gpu-patch-whole-planet-collider`, `project/sector-bounded-quant-binary-hf`, `project/sun-coherence-single-source`, `project/msaa-depth-write-shader-pass`, `project/water-depth-share-not-terrain-only`, `project/cull-cluster`, `project/grass-fluffygrass`, `project/morton-only-where-access-fits`, `project/mapspinner-dep-file-edit-marker-gated-bridge`, `project/instancedmesh2-count-accessor-trap`, `project/underwater-model-tint-shaderchunk`, `project/foliage-a2c-aniso-after-bake`.

## Audit log

Per-session narrative is not kept here (drained 2026-09-14; pre-drain text in `git log -p -- AGENTS.md`).
Durable lessons from those sessions are the slugs above.

@.gm/next-step.md
