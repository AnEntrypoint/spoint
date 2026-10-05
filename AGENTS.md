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

Work on `main`; merge stray branches in and delete them (`gh-pages` is a deploy artifact and stays).
Commit only as `lanmower` (`657315+lanmower@users.noreply.github.com`); never attribute an AI
assistant in a commit, PR, or file. Same inside every submodule.

Commit hygiene, learned five times on 2026-10-02: never `git add <paths>` followed by a bare
`git commit` -- that commits the whole index, so another writer's staged files land under your
message (`0292ad7b` did exactly that). Always `git_commit`/`git_finalize` **with an explicit
`paths` list**. Never commit a file that imports a file which is not in the same commit: the
session broke HEAD that way four times (`mapspinner/splat-weights`, `src/presets/*`,
`AppContext.js` -> `AppGameplay.js`, `src/stdlib-apps/*` without its import rewrites).
`.gm` pathspecs are honoured by the git verbs since 2026-10-02 -- see the caveat at the end of this file.

## Zero-comment sweep

Names and structure carry meaning; rationale that code cannot carry lives in recall (slugs below),
the commit message, or this file. Swept 2026-09-14: `client/` `src/` `apps/` `scripts/`
`packages/{mapspinner,streaming-gltf,ecs}/src`. Swept 2026-09-28: `packages/*/examples/**`,
`packages/*/scripts/**`, Rust. Kept on purpose, never re-flag:

- `@ts-*`, `eslint*`, `@vite-ignore`, `webpack*`, `/*! */`, `#__PURE__`, `sourceMappingURL`.
- comment-looking text inside string/template literals (embedded GLSL, `scripts/patch-deps.mjs`'s
  `// [spoint patch]` idempotency markers, generated headers) -- runtime data.
- Markdown (`src/game/INTEGRATION.md`, `src/behaviours/README.md`, any `*.md`): `//` in code examples is
  prose. Never edit a doc to satisfy the sweep.
- `types/*.d.ts` JSDoc: the published app-SDK contract (`ctx`, engine, math) that app authors read
  as editor IntelliSense, not commentary on code -- its rationale cannot move to recall without
  deleting the interface documentation.
- Rust `///` rustdoc on a `#[wasm_bindgen]` export, only where it states an ABI fact the
  signature cannot carry (in `packages/spoint-core/src/lib.rs`: `pack_quat`'s bit layout,
  `unpack_quat`'s return order, `mul_quat`'s component order). Every other Rust comment is gone -- `//` banners, the file header block, and every `///` restating its own signature.
- Vendored/generated, never edited: `client/vendor/` (upstream headers), `client/editor/wm/wm.css`
  (verbatim thebird `os/wm.css` paint-only WM visuals), `packages/mapspinner/src/height-gen.js`,
  `*/basis/basis_transcoder.js`, `packages/streaming-gltf/src/draco-loader.js`,
  `client/editor/sdk-typings.generated.d.ts`.

Known false positives, never re-flag: generator methods `*[Symbol.iterator]()` / `*entries()`, CSS
`*` universal and `#id` selectors, GLSL `#ifdef` and `*` block-comment continuations, glob literals
inside `console.log` strings, `//` inside `http://` URLs.

## AnEntrypoint dependencies and `vendor/*` submodules (`project/anentrypoint-consumption-and-submodules`)

AnEntrypoint publishes nothing to npm. Runtime sources, the only ones code may reference:

| Repo | Runtime consumption | Edit checkout |
|---|---|---|
| `AnEntrypoint/design` | pinned CDN URLs in the importmaps (+ stylesheet/modulepreload links) of `client/index.html`, `client/landing/index.html`, `client/editor/thebird-host.html`, `scripts/bundle-client.mjs`: bare `anentrypoint-design` -> `unpkg.com/anentrypoint-design@1.0.34/dist/247420.{js,css}`; `game-editor-kit` -> jsdelivr `gh/AnEntrypoint/design@<sha>/src/components/game-editor-kit/index.js`. Bump all four files together. | `vendor/design` |
| `AnEntrypoint/wireweave` | `package.json` optionalDependencies `github:AnEntrypoint/wireweave` (npm clones default branch; src/ only; importmaps remap to `/node_modules/wireweave/src/index.js`; Node uses bare `import('wireweave')`) | `vendor/wireweave` |
| `AnEntrypoint/gm` | global `npx gm-skill install` / `gm-plugkit`, not a spoint dependency | `vendor/gm` |

`vendor/*` are editing-only submodules: never import them from `client/`, `scripts/`, `src/`. Edit on
the submodule's own `main`, push there, then commit the new gitlink here (bookkeeping only); runtime
picks it up when the pinned version/SHA is bumped, on the next `npm install` (wireweave), or on a
fresh `gm-skill install`. The importmaps also remap `https://esm.sh/three@r128` to the local three so
the kit's ModelPreview never loads a second three (`project/importmap-esmsh-three-dedupe`); COEP
`require-corp` means every kit CDN must send CORP, and the importmap must precede any module
load/preload. No npm dependency on the kit (a second copy would disagree with the importmap).
`nostr-tools` is injected into wireweave from `client/vendor/nostr-tools.mjs`. Pin a wireweave SHA for
a reproducible build; no CI here tests wireweave@main (no .github workflows). gmsniff and agentgui
deliberately vendor the kit. A fourth submodule needs a documented runtime mechanism.

## All GUI lives in AnEntrypoint/design (`project/gui-kit-architecture-2026-08-21`)

Every UI component (screens, dialogs, panels, editor kit incl. asset browser/model preview/undo
history, damage numbers) is built in `AnEntrypoint/design` (`src/components/game-editor-kit/`) and
reaches spoint only via the pinned CDN importmap entries; spoint keeps backend only (e.g.
`src/effects/DamageEffects.js`, `apps/hit-feedback`). The kit's `ModelBrowser`/`ModelBrowserIntegration`
panel already exists there; spoint has no `ThumbnailGenerator`/`ThumbnailWorker`/`ModelBrowserHandler`
for it yet -- build one there, not under `client/`. Reject any UI-rendering `*.js`/`*.html`/`*.css`
under `client/` without the design-repo work: design first, spoint integration next commit, verify on
the live URL with `?v=<ts>`.

## Root-cause, never tune thresholds (`project/degenerate-triangle-threshold-is-not-a-tunable-guess`, `project/degenerate-triangle-third-copy-and-immutable-cache`)

A bug that survives a numeric-threshold change was not fixed -- re-diagnose the mechanism. Exhaust
structural fixes, then derive any threshold from a measured discontinuity in real data
(aim_sillos.glb `EPS_AREA=1e-4` sits in a verified gap of the area histogram). When a fix correct at
its own layer fails end-to-end, hunt another copy of the same check (the degenerate-triangle one lived
in `src/physics/ShapeBuilder.js`, `packages/streaming-gltf/tools/bake-cluster.mjs` and
`packages/streaming-gltf/src/cluster-lod-mesh.js`). A re-bakeable URL needs a real ETag; `immutable`
without one serves stale pre-fix bytes. Verify rendering on live GPU data (`window.__scene`).

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

Area slug catalogs live in recall, not here: `project/legacy-area-slug-catalog-part1-terrain-veg-physics-models`,
`project/legacy-area-slug-catalog-part2-app-deploy-editor-perf` (older names; most bodies were in the retired
rs-learn store, so for those the name plus `git log` on the named file is all that survives),
`project/code-rationale-slug-index-part1-render-assets-mapspinner`,
`project/code-rationale-slug-index-part2-netcode-server-apps-scripts` (every per-file rationale slug moved out
of source comments, each with a memo). `recall <area or file name>` surfaces the catalog and the memo together.

Netcode (docs/netcode.md), prefix `project/`: `netcode-authoritative-path-defects`, `netcode-input-pipeline-exact-prediction-invariants`, `snapshot-timeline-remote-interpolation`, `tick-scheduler-and-snapshot-wire-v3`, `lag-compensation-view-tick-rewind`, `netcode-rollback-profile-exact-resim`, `netcode-lockstep-profile-agreed-drop-and-pacing`, `prediction-wall-plane-hints-position-only`, `jolt-value-getters-are-static-temps-never-destroy`, `local-player-step-trail-render-interpolation-and-jank-sources-2026-09-30`.

Test relocation (`window.__spoint`, MSG.TELEPORT): `project/test-relocation-api-teleport-bookmarks-whensettled`.

Game/editor entry points: `ctx.defineGameFSM(spec)` in `src/behaviours/game-fsm.js` (`fsm.tick(dt)` from `update`);
`client/core/ClientMachine.js` (xstate5 parallel); loading machine fallback is xstate `after:` 10s gated / 45s
hard stop; editor hierarchy messages REPARENT/DUPLICATE/SET_LABEL are 0x94-0x96; mapspinner and streaming-gltf
are in-repo npm workspaces under `packages/`, edited directly. Engine behaviour primitives live in `src/behaviours/`
(`apps/_lib/*` are one-release re-export shims); static compression cache is `.spoint-cache/static/`; static-export
fixes and outDir rule (`project/engine-apps-boundary-b0-b1-2026-09-30`). Default world is `apps/world/index.js`
`defaultWorld`; worlds are validated (`src/shared/worldResolve.js`), defaulted (`src/shared/worldDefaults.js`) and
preset-expanded (`presets: ['tps']`, `src/presets/`) in every runtime; default avatar `client/assets/default-avatar.vrm`
(CC0); TURN only via `SPOINT_ICE_SERVERS` (`project/engine-apps-boundary-b2-b4-world-registry-resolve-presets-2026-09-30`).
Gameplay lives in `src/behaviours/` too: `ctx.defineCombat(spec)` owns the shooter loop
(spawns, health, ammo/reload, fall-kill, respawn, powerups, scoreboard, lag-compensated hits over
`src/netcode/Hitscan.js` as `ctx.combat`), so `apps/tps-game` is a tuning object plus its assets
(`project/engine-apps-boundary-b5-b8-combat-behaviour-presets-2026-10-02`).

## Code rationale index (moved out of source comments, 2026-09-14)

Full text: `recall <slug>` (bodies tracked in `.gm/memories/`). Read the memo before changing the named code.

Load-bearing caveats:
- three: editing a `ShaderChunk` + `needsUpdate` never recompiles (`three-shaderchunk-edit-needsupdate-noop`); InstancedMesh2 custom/override shaders need `instanced_pars_vertex` + `getInstancedMatrix()` and `addShadowLOD` children get a bare ShaderMaterial (`overridematerial-instancedmesh2-instanceindex`, `instancedmesh2-addshadowlod-default-material`); a BatchedMesh with an array material never draws (`batchedmesh-array-material-never-draws`); shadow pass is also gated by `renderer.shadowMap.needsUpdate` (`shadowcostprobe-three-shadowmap-scope-gate`).
- Model pool: one KTX2Loader per GL context (`modelpool-shared-ktx2loader-singleton`); never share one BufferGeometry across N meshes (`modelpool-per-instance-geometry-shell`); VRAM monitor only lowers the LOD ceiling (`modelpool-vram-one-way-ratchet`); ClusterLodMesh needs its array material, seed group and once-per-frame guard (`streaming-gltf-clusterlodmesh-array-material-seed-group`).
- Spaces: FloatingOrigin rebase sets camera to 0 (`floating-origin-camera-set-not-translate`); editor/snapshot positions are render-space, wire is authoritative (`editor-render-vs-authoritative-positions`, `floating-origin-snapshot-targets-to-render`); THREE near/far must equal `window.__hostNearFar` (`hostnearfar-shared-depth-contract`).
- mapspinner: pin every sampler unit and rebind each frame, THREE shares the context (`mapspinner-sampler-units-never-empty`, `mapspinner-shared-gl-context-state-hazards`); FXC: single-floor noise, `uNoUnroll` bound = `FXC_UNROLL_DEFEAT_LOOP_BOUND` (`mapspinner-snoise3-single-floor-fxc`, `mapspinner-unounroll-loop-bound`); mirrored tables change together: face frame (6 copies), HPF inset triple, ATM/scattering LUT constants (`mapspinner-face-frame-tables-agree`, `mapspinner-hpf-inset-matched-triple`, `mapspinner-atm-lut-constants-mirror-glsl`, `mapspinner-scattering-lut-glsl-layer-mirror`); `sampleGroundM` is one call stale (`mapspinner-samplegroundm-one-call-stale`); discards only under `_WATERPASS_` (`mapspinner-waterpass-discard-isolation`).
- Runtimes: module Workers have no importmap; SDK server code also runs in the singleplayer Worker (guard `process`, no static `node:*`); apps never import client/* (`worker-module-no-importmap-bare-specifier`, `sdk-dual-runtime-process-guard`, `apps-cannot-import-client-modules`); build Node-only `import()` specifiers inside an IIFE (`esbuild-import-specifier-iife-not-concat`); BrowserServer flushes on setTimeout, never rAF (`browserserver-snapshot-flush-settimeout-not-raf`).
- Apps: moving apps need kinematic/dynamic bodyType (`moving-app-entity-needs-dynamic-bodytype`); siblings may not be set up during `setup()` (`app-setup-sibling-entities-not-ready`); client payloads never reach inventory mutators (`inventory-client-payload-trust-boundary`); schemas are positional on the wire (`component-schema-positional-wire`); epoch/config columns are f64 (`componentpool-f64-for-epoch-and-config`); `setBodyPosition` wakes bodies, park with `setBodyActive(false)` (`destructible-pool-park-deactivate-and-hide`); `ctx.physics.addForce` is an impulse (`app-physics-addforce-is-impulse`).
- Physics (Jolt): destroy ShapeResult after addBody only; never destroy getter/vehicle-owned objects (`physics-jolt-shaperesult-destroy-after-addbody`, `physics-jolt-getter-return-destroy-hazards`, `physics-jolt-vehicle-ownership-and-wake`); vehicle chassis exempt from physics LOD/budget sweeps (`physics-lod-vehicle-chassis-exempt`).
- Netcode/wire: `WIRE_STRUCTURES[1]` = TickHandler `_packPayload` keys in order (`msgpack-wire-structures-snapshot-key-list`); entity bin buffers freshly allocated per re-encode (`snapshot-entity-bin-fresh-buffer`); `knownIds` reset only on keyframes (`tickhandler-knownids-reset-only-on-keyframe`); determinism comes from dt (`netcode-dt-determinism-source`); lockstep checksum folds raw f64 in id order (`lockstep-checksum-canonical-float64-order`); P2P control frames are prefixed strings (`p2p-wireweave-ctrl-frame-prefixes`); new BaseClient callbacks must join its allowlist (`baseclient-callback-allowlist`); input sanitizing is load-bearing (`inputguard-sanitize-yaw-and-input-bucket`); client-side prediction is collision-blind so resimulate() drifts into held-against geometry until gated by a wedge flag (`predictionengine-collision-blind-wedge-drift-fix`).
- Server/security: auth matrix with `EDITOR_TOKEN` unset (`server-http-auth-matrix`); untrusted app eval is SES-only and fails closed with `SandboxUnavailableError` (`ses-evaluator-fails-closed-no-proxy-tier`); static path containment + COOP/COEP (`statichandler-path-containment`, `statichandler-coop-coep-require-corp`).
- Terrain/assets: colliders ring each player, never the centroid (`terrain-collider-streamer-per-player-rings`); placement is client/server hash parity (`terrain-placement-parity-salt-and-prejitter-cell`); glTF repack uses EXT_meshopt byte ranges (`glbktx2-meshopt-bufferview-ext-range`); rocks share seed 1337/stride 7919 with RockShapes (`rocks-visual-physics-seed-parity`).
- Editor/UI/tooling: kit `applyDiff` crash classes, HUD overlays mount on `document.body` (`kit-applydiff-child-crash-classes`, `hud-overlay-mount-outside-uiroot`); harnesses use `?multiplayer` + `SPOINT_NO_WATCH=1` (`e2e-harness-multiplayer-param-and-no-watch`); bundle stays unhashed `dist/client/app.js` with streaming-gltf external (`bundle-client-outfile-and-externals`).

spoint-core Rust twins of JS math (byte-identical pairs) and other rationale moved out of source 2026-09-28:
`project/spoint-core-rust-js-twins-byte-identical`.

Perf/spawn 2026-09-30 (prefix `project/`): InstancedMesh2 LOD children cull and hidden empty levels plus the
three/bvh.js count-0 and far-band patches (`veg-instancedmesh2-lod-children-cull-and-empty-levels-2026-09-30`);
WebGPU DynamicDrawUsage re-uploads every render (`webgpu-dynamicdrawusage-reuploads-every-render`), vec3 padding full copy
(`webgpu-vec3-attribute-padding-full-copy`), TSL perf parity causes and fixes (`tsl-webgpu-perf-parity-2026-09-30`), impostor atlas
viewport/orientation/normals on WebGPURenderer (`webgpurenderer-impostor-atlas-orientation-and-normals`);
spawn hold until static trimeshes land, floor probe from +2 m (`spawn-hold-until-static-colliders-and-floor-probe-2026-09-30`);
vegetation A/B numbers and remaining GPU-backpressure long tasks (`veg-variation-perf-ab-and-remaining-costs-2026-09-30`);
spawn surface standing/lifted/dropped rule and the spawn-4 floor gap (`spawn-surface-standing-lifted-dropped-2026-09-30`);
stuck occlusion queries recycled instead of freezing every verdict (`occlusion-query-tier-stuck-query-recycle-2026-09-30`);
stronger tint palette, companion genus, interior-hides-foliage screenshot trap (`veg-variation-strengthened-metrics-and-witness-method-2026-09-30`);
dev HMR (`src/sdk/DevHmr.js` + `client/dev/HmrRuntime.js`, `__spointHmr.accept/acceptSelf/dispose/data/only`, bundle->ESM switch, SP worker app/tick swap, `localhost` 200 ms connect trap) (`dev-hmr-system-2026-09-30`), default-on HMR, [::1] bridge, dev supervisor restarts + gap replay, node apps/ mtime loader hook, feature accept hooks via `_hmrFactories` (`dev-hmr-batch2-2026-09-30`), NODE_ENV=production in deploy configs, GLB cache by source hash, veg species templates, per-page version floor, TSL material-only swap (`dev-hmr-batch3-2026-09-30`); local prediction collides with a mirrored static tile world (`prediction-collision-mirror-static-tiles-2026-09-30`), streaming heights bake in a worker (`patch-bake-worker-readback-off-main-thread`), local player drawn between the last two tick positions (`local-player-step-trail-render-interpolation-and-jank-sources-2026-09-30`).

Session 2026-10-02 (prefix `project/`): `grass-placement-painted-splat-weights`, `tsl-sculpt-override-r32f-2026-10-02`, `tsl-default-renderer-and-hashversion2-flip-2026-10-02`, `tsl-aerial-perspective-vs-legacy-measurement-2026-10-02`, `impostor-atlas-capture-tsl-2026-10-02`, `tsl-import-names-check-against-installed-exports-2026-10-02`, `terrain-legacy-gl-pipeline-cannot-do-v2-2026-10-02` (the last one consolidates the one-sided spec term and the two lost fast collider paths), `perf-run-draws-counter-and-gate-buckets` (perf harness draw-call metric and GPU contamination buckets), `terrain-boot-coarse-then-refine-and-demand-sized-pools-2026-10-02` (the boot heightfield is built at N/2 and refined off the boot path, and collider pools are sized from classified demand rather than a fixed sweep; carries the measured coarse-field ground error and the reason N/2 rather than N/4).

Two caveats from 2026-10-02 that are not yet in recall and will otherwise be rediscovered:

- **Flat chart plus global gravity has an intrinsic tilt term.** With one tangent chart at `anchorDir` and gravity fixed at `[0,-18,0]`, the surface tilts away from the chart's up axis by roughly theta at angle theta from the anchor, so at theta=15 deg even constant-elevation ground reads as a 15 deg slope. Circumnavigation walkability therefore splits: of 43 non-walkable crossings, 26 are genuine cliffs (up to 74.23 deg terrain) and must stay non-walkable, while 17 are this curvature term (median excess 9.26 deg, max 17.31 deg, with a -9.09 deg floor where the terrain's own slope cancels part of the term -- a negative value is the signature, since a stale-cache read cannot be negative). Fix the 17 by shrinking the chart, never by raising `MAX_SLOPE_DEG`, which is pinned to `DEFAULT_MAX_SLOPE_ANGLE_RAD = 0.7854` in `src/physics/CharacterManager.js`. Shrinking means cell-keyed re-selection at `CHART_ANCHORS_PER_FACE = 32`: with the threshold trigger (28 deg) density changes nothing, and the shipped engine runs no re-anchor yet. `streamer.chartReanchor` (`src/terrain/ChartReanchorService.js`, `tcfg.chartReanchor.enabled`, default off) decides and rotates the frame but throws until state migrators exist; see `project/planet-chart-cell-keyed-vs-threshold-reanchor-and-runtime-slice-2026-10-05` and the `chart-reanchor-*` PRD rows.
- **gm git verbs and `.gm` paths -- fixed 2026-10-02 in `AnEntrypoint/rs-plugkit` (`6f98e47`, `30786b6`, `crates/plugkit-core/src/wasm_dispatch/verbs.rs`).** An explicit `.gm`/`.agentplug` pathspec is now honoured, each response lists what was actually excluded (`excluded`, `excluded_but_dirty`) instead of a static label, and a pathspec that matches nothing returns `ok:false` + `error_code: pathspec_matches_nothing` and stages nothing rather than committing the index. Witnessed in a scratch repo: `git_commit {paths:[".gm/state.md"]}` commits only that file and leaves an unrelated staged file staged; an untracked `.gm/new-untracked.md` commits when explicitly requested; `git_commit {paths:["nonexistent-path.js"]}` refuses. Before the fix the named paths were dropped and `git_finalize` committed whatever else was staged, which is how `1ed9d4ae` came to carry one agent's message over another's 67-file `apps/` -> `src/stdlib-apps/` move. Read `committed` and `requested_paths` off the response rather than trusting the call.

Session 2026-10-05 (prefix `project/`): `chart-reanchor-server-state-migrators-2026-10-05` (every server-side chart-local holder with file and mechanism, the grounded-velocity tilt clamp and why world velocity is not carried exactly for a grounded character, the fault policy that stops the tick loop on a half-migrated frame, the base-chart persistence rule, the measured continuity numbers, and what the wire row must carry). A new holder of chart-local state must either be re-expressed in `src/sdk/chartState/` or expose `onChartReanchor` (apps: `server.onChartReanchor(ctx, {transfer})`; behaviours made through `ctx.defineCombat/Checkpoint/ShrinkingZone/Destructible` register themselves via `AppContext._chartAware`).

## Audit log

Per-session narrative is drained (2026-09-14; pre-drain text in `git log -p -- AGENTS.md`); the
durable lessons are the slugs above.

@.gm/next-step.md
