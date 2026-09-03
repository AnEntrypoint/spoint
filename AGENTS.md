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

## Main-only, no branches

Always work directly on `main` in this repo. Never create or leave work on a
feature branch. If a non-main work branch is ever found, merge its content into
`main` then delete the branch (`gh-pages` is the sole exception -- it is a
deploy artifact branch, not a work branch, and stays). If a default branch is
ever named `master`, rename it to `main`. Commit only as `lanmower`
(`657315+lanmower@users.noreply.github.com`), never attribute an AI assistant
in any commit, PR, or file.

## AnEntrypoint submodules (`vendor/*`) -- editing checkouts, not runtime sources

`vendor/design`, `vendor/wireweave`, and `vendor/gm` are real git submodules
(`.gitmodules`) pointing at `AnEntrypoint/design`, `AnEntrypoint/wireweave`, and
`AnEntrypoint/gm` (the source repo behind both the `gm-plugkit` and `gm-skill` npm
packages -- there is no separate `gm-tools` repo). They exist so those repos can be
edited locally, side by side with spoint, in one `git clone --recurse-submodules` or
`git submodule update --init --recursive`. **They are editing checkouts only** --
nothing under `client/`, `scripts/`, or `src/` may import from or reference a
`vendor/*` path at runtime or build time. Each repo's existing live-tracking
consumption mechanism is unchanged and remains the sole runtime source:

| Repo | Runtime consumption | Where documented | Edit target |
|---|---|---|---|
| `AnEntrypoint/design` | jsdelivr GitHub CDN `@main` (`https://cdn.jsdelivr.net/gh/AnEntrypoint/design@main/...`) in importmaps | "Design kit (`anentrypoint-design`) consumption" below | `vendor/design` |
| `AnEntrypoint/wireweave` | `github:AnEntrypoint/wireweave` in `package.json` optionalDependencies, cloned by `npm install` into `node_modules/wireweave` | "wireweave is a GitHub-sourced dependency" below | `vendor/wireweave` |
| `AnEntrypoint/gm` | `npx gm-skill install` / `npx gm-plugkit@latest spool`, installed globally to `~/.claude/skills/gm/` and `~/.gm-tools/` -- not a spoint dependency at all | this file's `## ORCHESTRATOR` block | `vendor/gm` |

**Editing workflow, identical across all three submodules:**

1. `cd vendor/<repo>` -- each submodule checks out that repo's own `main` at whatever
   commit was last pinned by `git submodule update`; work directly on `main` inside the
   submodule, same as spoint itself (no feature branches -- see "Main-only, no branches"
   above; this rule applies inside every submodule too).
2. Commit only as `lanmower` (`657315+lanmower@users.noreply.github.com`) -- the global
   git identity applies inside a submodule checkout exactly as it does in spoint's own
   tree; never attribute an AI assistant in any submodule commit either.
3. `git push` from inside `vendor/<repo>` pushes to that repo's own GitHub remote
   (`AnEntrypoint/design`, `AnEntrypoint/wireweave`, `AnEntrypoint/gm` respectively),
   never to spoint's own remote -- a submodule's remote is independent of spoint's.
4. Back in spoint's own tree, `git add vendor/<repo>` and commit records the new pinned
   submodule SHA (a normal spoint commit) so the pin tracks what was pushed -- this
   pin is bookkeeping only and does not gate runtime consumption, since design/wireweave
   both resolve `@main`/`github:` independently of any submodule SHA.
5. spoint's own runtime picks up the pushed change through that repo's existing
   mechanism from the table above (CDN `@main` re-resolve, next `npm install` re-clone,
   or a fresh global `npx gm-skill install`) -- **not** by reading `vendor/<repo>`.
   Pushing inside a submodule and stopping there does not update spoint's build or the
   `gm` skill installed globally; the corresponding pickup step must also run.

Do not add a fourth submodule speculatively -- add one only when a repo under
`AnEntrypoint/*` needs local editing and its runtime consumption mechanism is
independently documented (append a row to the table above and a matching
"how spoint runs against it" section, following the wireweave/design precedent).

## Threshold-tuning is never a substitute for root-causing (project/degenerate-triangle-threshold-is-not-a-tunable-guess)

When a bug reproduces after a fix that only changed a numeric threshold/epsilon, the fix did not work --
re-diagnose the actual mechanism, do not raise or lower the number again and hope. A number picked to make
a specific symptom disappear (loosen until the count you're looking at hits zero) is curve-fitting to one
observation, not a fix; the same class of defect resurfaces the moment the input shifts even slightly (a
re-export, a different asset, a slightly different camera angle). Live case: `apps/maps/aim_sillos.glb`'s
degenerate-triangle defect was "fixed" at `EPS_AREA=1e-6` in commit cd110b88 (a real, measured, justified
value at the time -- 756/10117 zero-area pre-fix, 0/9361 post-fix on THAT scan). A later live report ("we
can see extra triangles fanning out") proved 26 real defects still shipped, because the physics loader
(`src/physics/GLBLoader.js`/`src/physics/ShapeBuilder.js`, a separate code path reading the raw source GLB
directly) was never given the same fix, and even where the fix existed the constant was too tight for this
asset's actual defect scale. The instinct to "just raise the number until my current repro looks clean" was
explicitly rejected mid-investigation (see `.wfgy/lessons.md` 2026-08-13 entries) in favor of: (1) live-test
every plausible STRUCTURAL fix first -- spatial vertex welding at multiple cell sizes, meshoptimizer's own
`simplifyPrune`/`simplify` (real, tested, upstream tools, not homegrown) -- and accept the live, witnessed
result even when it disproves the hypothesis (none of these collapsed the real slivers; they measure
different invariants than raw area); (2) only after structural fixes are exhausted, derive any remaining
numeric threshold from a REAL measured discontinuity in the actual data (sort every triangle's real area,
find a genuine gap with zero triangles inside it), never from "what number makes today's count zero." The
mesh's own area histogram had a clean ~50% gap between the largest real defect (7.26e-5 m^2) and the
smallest legitimate triangle (1.12e-4 m^2) -- `1e-4` sits inside that verified gap, which is why it is
defensible, not a guess. A researched external reference (nanite-webgpu's meshoptimizer-based pipeline,
NullGraph's custom meshlet builder) was evaluated and found to NOT already solve this better -- confirmed
by reading their actual source, not assumed from README claims -- before writing new code, per this
project's own "researched-before-reinvented" discipline elsewhere in this file.

**Follow-up (2026-08-13e, see `.wfgy/lessons.md`): the SAME fix, correctly derived and correctly applied at
two layers, still didn't hold end-to-end.** The real cause was a THIRD, independent copy of the same
degenerate-triangle check (`packages/streaming-gltf/src/cluster-lod-mesh.js`'s client-side runtime combine
step) that nobody had grepped for -- plus a `Cache-Control: immutable` bug in `src/sdk/StaticHandler.js`
with no ETag on the re-bakeable asset route, which meant every browser-based verification attempt against
an already-visited tab could keep showing stale pre-fix geometry regardless of how correct the server-side
fix was. When a fix that is provably correct at its own layer still fails end-to-end, the default next
hypothesis is "grep the whole pipeline for another copy of this same check" -- not "my threshold is still
wrong" (more tuning) and not blind despair. Equally: audit every `Cache-Control` on a URL whose bytes can
legitimately change over time (a re-bakeable cache artifact, not a content-hashed/fingerprinted path) for a
missing or absent ETag -- `immutable`/a long `max-age` with no real conditional-GET on such a path silently
defeats every future fix to whatever it serves, and will manufacture exactly this "I fixed it but it's still
broken" symptom on a totally unrelated future bug. The only trustworthy verification surface for a live
rendering defect is the actual runtime data (live `window.__scene` traversal of real GPU-bound
`geometry.index`/`geometry.attributes.position`, or console output from the code path itself) -- a
file-level re-parse of the bake output, however careful, was reading data from BEFORE the buggy step ran
and reported clean every time.

## wireweave is a GitHub-sourced dependency, not npm-registry, editable via `vendor/wireweave` submodule

AnEntrypoint no longer publishes any package to the npm registry. At runtime `wireweave`
is installed directly from GitHub (`package.json`'s `optionalDependencies`:
`"wireweave": "github:AnEntrypoint/wireweave"`), which `npm install` resolves
by cloning the repo at its default branch tip -- there is no npm-registry
tarball involved, only npm-the-tool used as the local install/cache mechanism.
The repo ships `src/` only, so both importmaps remap the
bare specifier to `/node_modules/wireweave/src/index.js` (`client/index.html`,
`client/editor/thebird-host.html`) and Node-side callers use a bare
`import('wireweave')`. **This runtime resolution path is unchanged** -- `vendor/wireweave`
(see "AnEntrypoint submodules" below) is a separate, editing-only checkout and is never
imported from or referenced by any runtime path.

`nostr-tools` is a peer dependency wireweave never imports -- it is injected
(`new NostrAuth({ nostrTools })`), so the browser gets it from the vendored
`client/vendor/nostr-tools.mjs` via `/vendor/nostr-tools.mjs`, independent of
wireweave's own delivery.

To change wireweave itself, edit inside `vendor/wireweave` (see "AnEntrypoint submodules"
below) and push to `AnEntrypoint/wireweave`'s `main`; spoint's runtime picks up the change
on the next `npm install` (github: deps re-clone on install, not content-hash-cached the way a
registry tarball would be -- pin a commit SHA instead of the bare `github:` shorthand if
a build ever needs to be reproducible against a specific wireweave revision). The daily
`cross-repo-ci.yml` integration job still tests spoint against wireweave@main by checking
that repo out to `.wireweave-head`, since the repo carries no `test.js` at its own root for
spoint's harness to reuse directly.

## How to use this file

Slugs only; full text lives in rs-learn. Query with `exec:recall <slug>`. If recall is empty, check `git log -p -- AGENTS.md` for prior detail.

## Server-only endpoints are dead on the static gh-pages host

`/client-error` (client/core/ErrorTelemetry.js sendBeacon/POST) and `/upload-model`
(client/editor/editor.js) are same-origin server API routes (src/sdk/ServerAPI.js) that do not
exist on the static gh-pages deploy -- error telemetry and the editor's model upload silently
no-op there behind their `.catch` guards. Accepted as documented limitation (2026-08-03); if it
ever needs to change, probe server presence once and feature-gate both call sites.

## Design kit (`anentrypoint-design`) consumption

spoint is a **browser-delivered** consumer: it has no npm dependency on the kit and never
resolves it through `node_modules`. Every `import { components as C, h, applyDiff } from
'anentrypoint-design'` in `client/` is a bare specifier remapped by an importmap to
`https://cdn.jsdelivr.net/gh/AnEntrypoint/design@main/dist/247420.js` -- jsdelivr's GitHub
mode, serving the built `dist/247420.js`/`dist/247420.css` committed directly in the
`AnEntrypoint/design` repo (there is no npm publish for this package; the repo name is
`design`, distinct from the `anentrypoint-design` bare specifier string used in code).

Every kit URL in this repo must track the `main` branch. The four places that carry one:

- `client/index.html` (stylesheet link, importmap entry, `installStyles` import)
- `client/landing/index.html` (stylesheet link, importmap entry)
- `client/editor/thebird-host.html` (stylesheet link, importmap entry)
- `scripts/bundle-client.mjs` (importmap emitted into the bundled client)

The importmap MUST precede any module load/preload or the browser rejects it and every bare
specifier fails to remap -- `client/index.html` already states this; it applies to the kit
specifier exactly as it does to `three`.

To change kit rendering, edit inside `vendor/design` (see "AnEntrypoint submodules" below) and
push its committed `dist/247420.js`/`dist/247420.css` to `AnEntrypoint/design`'s `main`; there is
no re-vendor step in spoint's runtime path. Do NOT add an npm dependency on the kit and do NOT
have any runtime `client/`/`scripts/` code import from `vendor/design` directly -- either one
reintroduces a second version that can silently disagree with the importmap. `vendor/design` is
an editing checkout only; the importmap's jsdelivr CDN URL remains the sole runtime source. jsdelivr's
GitHub CDN caches per-commit/tag but `@main` re-resolves to the branch tip on its own refresh cycle
(not instant, but no npm publish step is in the loop at all).

Fleet-wide strategy: AnEntrypoint no longer publishes to npm at all, for this kit or any other
composed dependency -- every consumer (Node-resolved or browser-delivered) tracks GitHub
directly. Node-resolved consumers (freddie, casey) take a `github:AnEntrypoint/<repo>`
`package.json` dependency (npm-the-tool installs from the git repo, no registry tarball
involved); browser-delivered consumers (spoint, zellous, thebird) load jsdelivr's GitHub CDN
`@main`. Two consumers are deliberately excluded and stay excluded: **gmsniff** (vendors a
subset, zero external-origin runtime fetches, must run air-gapped and must never become a
supply-chain surface for the agent host it observes) and **agentgui** (vendors the built kit
locally for offline operation and a UI that does not shift when upstream publishes). Neither is
drift.

Accepted tradeoff: a push to the design repo's `main` can change spoint's UI with no commit in
spoint.

## ALL GUI COMPONENTS LIVE IN ANENTRYPOINT/DESIGN (CRITICAL RULE)

**MANDATORY ARCHITECTURAL RULE**: All GUI/UI components for spoint must live in the `AnEntrypoint/design`
repository, NOT in spoint source. This is a single-source-of-truth requirement that applies to every
UI component, screen, dialog, panel, and game editor kit.

**Enforcement**:
- spoint ONLY imports UI components from design kit via CDN (`https://cdn.jsdelivr.net/gh/AnEntrypoint/design@main/...`)
- spoint does NOT create new UI components in `client/ui/`, `client/editor/`, or anywhere else
- Any new GUI for spoint (asset browser, batch operations UI, live preview, undo history UI, game editor kit)
  must be built in AnEntrypoint/design repo and published there
- Code review: **REJECT** any PR that adds UI components to spoint without corresponding work in design repo
- CI/CD: **FAIL** deploy if new `*.html`, `*.css`, `*.jsx`, `*.tsx` files appear in spoint client/ that should
  be in design kit (exclude existing server-side .html only)

**Game Editor Kit specifically**: Lives in AnEntrypoint/design as a separate component export alongside the
main component kit. Contains: asset browser, model preview, upload UI, batch operations UI, persistent undo
history UI, damage feedback components, live preview system. All reusable across other editors and projects.

**Submodule strategy** (optional for local dev):
- Consider git submodule at `../design` (sibling to spoint) for local development convenience
- But shipping always uses CDN main (@main) via importmap for live-update benefit
- Submodule is for developer convenience, not deployment
- If added: update `.gitmodules` and document in GETTING_STARTED.md

**When new GUI is needed**:
1. Determine if it's editor-specific (game editor kit) or player-facing (core kit)
2. Create component in AnEntrypoint/design repo with full tests and docs
3. Push to design repo main branch
4. spoint auto-picks up via CDN @main (zero spoint-side changes needed)
5. Verify rendering in spoint by checking live URL

See `/memory/gui-kit-architecture-rule.md` for detailed rationale and enforcement details.

## Backend vs. UI Ownership (Model Browser Example)

The Model Browser system illustrates the architectural boundary. **UI components belong in AnEntrypoint/design; backend infrastructure stays in spoint.**

**Backend (spoint source):**
- `src/editor/ThumbnailGenerator.js` — Node-side batch generation orchestrator
- `src/editor/ThumbnailWorker.js` — Worker thread for offline thumbnail rendering
- `src/sdk/ModelBrowserHandler.js` — HTTP API handler for browser requests

**UI (AnEntrypoint/design repo):**
- Game editor kit exports ModelBrowser panel (grid/list views, search, sorting)
- Game editor kit exports ModelPreview component (3D orbit viewer)
- Game editor kit exports ModelBrowserIntegration (wires panel + preview together)
- All three imported to spoint via CDN importmap from design repo @main

**Enforcement rules:**
1. Never add new UI rendering code to spoint client/ — it belongs in design kit
2. Server-side generation/API handlers stay in spoint — they are backend infrastructure, not UI
3. Code review: reject any `.js`/`.jsx`/`.tsx` in `client/editor/`, `client/ui/` without corresponding work in design repo
4. Integration layers in spoint import pre-built components from design CDN only (e.g., `import { ModelBrowser } from 'anentrypoint-design'`)

When a new editor component or panel is needed: design repo change first, then spoint integration in the next commit.

## Debugging playbook (`project/debugging-playbook-live-gl-instrumentation-2026-07-10`)

Live GL-error/rendering-defect root-causing method (browser-verb DOM-eval crash workaround, console-text
disambiguation of same-error-code GL bugs, draw-call stack-trace capture, live-GL-state-over-JS-cache-trust,
pixel-sample toggle-elimination for flicker, classify-discrete-vs-noise before chasing, per-instance-not-
uniform z-fight caveat -- not every flicker has a client-side fix). Full detail in rs-learn.

## Recall topic catalog

Terrain (`project/terrain-*`): super-chunk-tiling, edge-snap-skirt, stitching-live-neighbour-lod, cross-factor-edge-fast-res-fallback, cross-factor-stitch-invalidation, restitch-priority-inversion, gpu-displacement-arch, uv-double-scale-bug, strict-1-tile-raf, camera-footprint-eviction, streaming-priorities-eviction, worker-count-cap, pendingevict-zfight, buffergeo-upload-stall, edge-normal-fbm-opt, sampler-lru-cache, shortest-queue-dispatch, stale-result-drop, evicted-geo-cache, adaptive-lod, baked-normals-cross-lod, sample-at-scratch-buffers, config-world-to-client-flow, client-html-singleplayer-survivor-redirect, cpu-gpu-height-parity-integer-hash, mapspinner-single-source-of-truth, terrain-occlusion-postrender-queries, terrain-is-a-proper-app, misc-caveats. Full detail in rs-learn (recall "Terrain (`project/terrain-*`)").

Vegetation (`project/veg-*`): frustum-culling-bounding-sphere, lod-bands-bitmask, lod-rebuild-cache, debug-overwrite-trap, atomic-lod-swap, collapse-variant-buckets, billboard-cylindrical-impostor, billboard-bake-async-image-poll, billboard-renderdistance-gate, placement-lod-invariant, y-scale-zero-pancake, lodband-stale-recompute, eztree-branch-polycount, stale-result-double-build, canvas-destination-in, terrainfield-anchor-kind-preserve, eztree-material-name-split, eztree-no-node, server-world-env, placement-args-passthrough, bake-billboard-temp-parent, capsule-uniform-scale, cull-on-approach-union-box-and-toggle-isolation.

Physics (`project/physics-*`): jolt-arrayfloat-getpointer, jolt-browser-multithread-coi-confirmed-null-function-was-caller-error, jolt-wasm-cross-platform-bit-exact, jolt-lockstep-multiprocess-fixed-dt-bit-exact, lockstep-tick-driver-fixed-dt-bypass-dilation, lockstep-game-loop-orchestrator-integration, jolt-getangularvelocity-shared-buffer-double-destroy, jolt-getpositionrotation-shared-buffer-double-destroy, terrain-radius-cap, collider-res-128-to-64, terrain-tick-decouple, tick-dilation-freeze, streaming-decouple-validated, player-divisor-dt-bug, no-fallthrough-kill-plane-real-character, collider-streamer-fresh-territory-tick-stall, rollback-wireweave-input-transport-orchestrator. Full detail in rs-learn (recall "Physics (`project/physics-*`)").

Rocks (`project/rocks-*`): integrated-veg-pipeline, second-pass-grid, convex-hull-colliders, sync-bake-required, normal-alignment-size.

Movement/Animation (`project/movement-*`, `project/animation-*`): coyote-buffer, soft-land, anim-locostate-thresholds-vs-sprintspeed, anim-sendloco-cooldown-actor-desync.

Testing (`project/test-*`): vegetation-physics-async-yield.

Rendering: `project/instanced-mesh-shared-geo-trap`, `project/sun-shadow-player-follow`, `project/sim-render-pacing-vsync-input-stamp`, `project/placement-scheduler-raf-decouple`. Full detail in rs-learn (recall "Rendering").

Model display (`project/modelpool-*`): scene-attach-proxy-root, transform-direct-not-opts, useglobalmaterialpool-off-per-texture, bake-webp-source-normalize, bake-empty-prim-guard, vrm-multidriver-player-routing, doubleside-interior-faces-is-custom-flag, draco-wasm-removed-purejs-clientwide, cluster-lod-double-transform, placement-y-tuned-for-broken-scale, cluster-onbeforerender-custom-draw-bind-timing. Full detail in rs-learn (recall "Model display (`project/modelpool-*`)").

App/SP/GLB/RTC/Misc: `project/window-app-two-stage-init`, `project/window-tune-hot-reload`, `project/singleplayer-and-app-api-caveats`, `project/glb-loading-caveats`, `project/wireweave-rtc-caveats`, `project/misc-rendering-ci-browser-caveats`, `project/multiplayer-host-world-resolution`, `project/multiplayer-gitignore-worker-dep-404`, `project/statichandler-symlink-nodemodules-404`, `project/one-server-two-client-modes-same-origin`, `project/multiplayer-host-bridge-peeropen-catchup`, `project/wireweave-dc-close-recovery`, `project/loading-fallback-races-slow-worker`, `project/startup-coldboot-bottleneck-fixes`, `project/startup-rehunt-anim-lib-earlykick`, `project/env-app-removed-fold-into-placed-model`, `project/modelpool-legacy-visibility-cull-vs-pool-lod`, `project/resolveasset-worker-fetch-needs-origin-slash`, `project/edge-cf-workers-feasibility-workerentry-already-proves-core`, `project/lockstep-e2e-real-webrtc-node-datachannel-dead-end-roamhq-wrtc-works`, `project/workerentry-visibilitychange-save-now`, `project/rollback-wireweave-transport-namespace-must-match`, `project/webgpurenderer-live-runtime-construction-works-shadowcostprobe-crashes`, `project/room-orchestrator-router-is-lookup-not-proxy`, `project/room-orchestrator-load-aware-placement-tickmetrics`, `project/browser-verb-chrome-pileup-direct-launch-workaround`, `project/p2p-mesh-split-brain-three-layer-fix`. Full detail in rs-learn (recall "App/SP/GLB/RTC/Misc").

Workspaces/RenderGraph (2026-07-07b): `project/workspaces-merged-packages`, `project/ghpages-deploy-symlink-cp-collision`, `project/render-graph-live-orchestrator`. Full detail in rs-learn (recall "Workspaces/RenderGraph (2026-07-07b)").

Game FSM: `project/game-fsm-xstate5` — `ctx.defineGameFSM(spec)` in `apps/_lib/game-fsm.js`; declarative spec -> xstate5 machine; `fsm.tick(dt)` from `update(ctx,dt)`; dual-import server+client. Full detail in rs-learn.

Physics rig/multi-body (`project/ragdoll-brawl-arena-no-joint-api`): `project/ragdoll-brawl-arena-no-joint-api`, `project/vehicles-jolt-constraint-available-not-just-twobody`. Full detail in rs-learn (recall "Physics rig/multi-body (`project/ragdoll-brawl-arena-no-joint-api`)").

Vehicles (`project/vehicles-jolt-constraint-available-not-just-twobody`): `project/vehicles-jolt-constraint-available-not-just-twobody`. Full detail in rs-learn (recall "Vehicles (`project/vehicles-jolt-constraint-available-not-just-twobody`)").

Client state FSM: `project/client-machine-xstate5-parallel` — `client/core/ClientMachine.js`; parallel regions mode/gizmo/select; state-scoped guards (no extra code); loading state forgiving. Full detail in rs-learn.

Loading FSM: `project/loading-machine-fallback-timeout` — 5-flag conjunction + no timeout = deployed-no-world-until-refresh; use xstate `after:` fallback (10s gated, 45s hard stop). Full detail in rs-learn.

Editor hierarchies: `project/editor-hierarchies` — server-side parent/children; REPARENT/DUPLICATE/SET_LABEL (0x94-0x96); SceneHierarchy drag-reparent tree. Full detail in rs-learn.

Editor input/a11y: `project/editor-pointer-input`, `project/kit-modal-aria`, `project/kit-emptystate-text-prop`, `project/browser-verb-direct-cdp`, `project/editor-docked-panel-chrome`, `project/editor-crossscreen-polish`, `project/editor-uncovered-polish`, `project/editor-apps-imperative-filebrowser`, `project/editor-floating-docks`, `project/upload-glb-server-prep`. Kit CSS from unpkg CDN cache lags publish — own a local always-served override copy. Full detail in rs-learn.

Editor core: `project/editor-black-rootcause-is-app-bg`, `project/editor-flycam-never-activated-rootcause`, `project/editor-create-primitive-spawn`, `project/editor-interactions-pick-hookflow-shoot-fixes`, `project/editor-player-look-pitch-frozen`, `project/editor-destructive-run-2026-06-08`, `project/editor-bodytype-switch-lod-rebuild`, `project/editor-add-menu-props-and-primitives`, `project/snapshot-removed-array-truthy-shortcircuit`, `project/editor-viewport-multiselect-and-nudge`, `project/hierarchy-sibling-drop-and-virtualization`, `project/thebird-wm-editor-chrome`, `project/wm-ui-kit-mechanical-swap`. Full detail in rs-learn (recall "Editor core").

Editor camera / Sillos scale: `project/editor-freelook-editmode-apply-and-rmb-source`, `project/sillos-rescale-geometry-baked-and-prewarm-await` (git_checkout does FULL checkout not path-scoped restore; prewarmProgressive must await). Full detail in rs-learn.

Quality tooling: `project/dna-quality-run-2026-06-08`, `project/netcode-feel-run-2026-06-08`, `project/dna-netcode-rerun-2026-06-09` (shipping mechanism != wiring its trigger; re-run doctrine after shipping), `project/dna-quality-rerun-2026-06-09b` (process.env in browser worker crashes it; browser verb ~14s sync cap), `project/fun-max-run-2026-06-11`, `project/fun-over-latency-workflow-2026-06-12`. Full detail in rs-learn.

Terrain/Rendering arc (2026-06-26): `project/gpu-patch-whole-planet-collider`, `project/sector-bounded-quant-binary-hf`, `project/sun-coherence-single-source`, `project/msaa-depth-write-shader-pass`, `project/water-depth-share-not-terrain-only`, `project/cull-cluster`, `project/grass-fluffygrass`, `project/morton-only-where-access-fits`, `project/mapspinner-dep-file-edit-marker-gated-bridge`, `project/ghpages-deploy-silent-freeze`, `project/auto-declaudeify-history-rewrite`, `project/instancedmesh2-count-accessor-trap`, `project/underwater-model-tint-shaderchunk`, `project/foliage-a2c-aniso-after-bake`. Full detail in rs-learn (recall "Terrain/Rendering arc (2026-06-26)").

Landing/SDK: `project/anentrypoint-design-applydiff-mount-required`, `project/landing-themetoggle-crumb-slot`, `project/kit-appshell-doc-route-flex`. Full detail in rs-learn.

Perf (GPU-headroom): `project/perf-vsync-headroom-not-bound`, `project/perf-fxc-cse-double-eval-phantom`, `project/perf-gpu-timer-bracket-real-render` (EXT_disjoint_timer/CPU-profile methodology + at the time, npm-tarball-md5 sibling-shipped check -- DEPRECATED as current mechanism, see workspaces-merged-packages: siblings archived, no tarball/md5 sync check needed, packages/* edited in-repo directly). Full detail in rs-learn.

Perf (CPU-bound total-optimize, 2026-07-02): `project/perf-cpu-bound-frame-fixes-144fps` -- elimination-A/B method for confirming a CPU-bound frame + the fix classes that won. Full detail in rs-learn.

Perf (144fps opportunity catalog, 2026-07-02b): `project/perf-144fps-catalog-vsync-vs-cpu-bugs` -- a vsync-bound verdict at one refresh rate doesn't transfer to a tighter one; see `.gm/perf-144fps-opportunities.md` for the audited catalog. Full detail in rs-learn.

Perf (unattributed CPU-profile bucket, 2026-07-06): `project/perf-unattributed-program-bucket-gpu-driver` -- gm-method for root-causing a CDP profile's unattributed `(program)` self-time bucket (GC-pressure/driver-call-volume/sync-GPU-stall/deopt elimination order, decisive via profile+trace prefix cross-reference). Full detail in rs-learn.

Perf (grass GPU-offload premise check, 2026-07-08): `project/grass-tf-premise-mutual-exclusion`, `project/grass-commitchunk-batched-addinstances`. Full detail in rs-learn (recall "Perf (grass GPU-offload premise check, 2026-07-08)").

Deploy pipeline (sillos-scramble disproven, 2026-07-10b): `project/sillos-scramble-hypothesis-disproven`. Full detail in rs-learn (recall "Deploy pipeline (sillos-scramble disproven, 2026-07-10b)").

Deploy pipeline (gh-pages path-patch seds + deploy guard, 2026-08-03): `project/ghpages-deploy-sed-node-modules-overreach`. Full detail in rs-learn (recall "Deploy pipeline (gh-pages path-patch seds + deploy guard, 2026-08-03)").

Slugs referenced only in drained detail (full text in rs-learn): `project/singleplayer-worker-boot-stall-on-cold-backgrounded-tab`, `project/editor-engine-prep-fieldtypes-placeable-apps-2026-07-12c`, `project/engine-prep-16-primitives-2026-07-12d`, `project/engine-prep-fanout-2026-07-12d`, `project/lockstep-tick-driver-fixed-dt-bypass-dilation`, `project/lockstep-game-loop-orchestrator-integration`, `project/rollback-wireweave-input-transport-orchestrator`, `project/engine-prep-app-maker-primitives-2026-07-12b`.

## Adding new caveats

Memorize via `exec:memorize` with `project/<area>-<slug>`, then append slug above.

## Audit log

Full narrative detail in rs-learn (`git log -p -- AGENTS.md` for pre-drain text). One line per session:

- 2026-06-30b: perf re-run, vsync-limited verdict re-confirmed, no source churn.
- 2026-07-01: editor Add menu; `snapshot-removed-array-truthy-shortcircuit` fix.
- 2026-07-02: Prop-submenu race fix; thebird wm chrome migration.
- 2026-07-02b: wm/ui.js mechanical kit swap; Apps toolbar never-rendered bug fixed.
- 2026-07-02c: foliage mip/alpha + underwater model tint.
- 2026-07-02d: 144fps opportunity catalog + 41-row backlog closure.
- 2026-07-02e: 144Hz re-measurement; `packQuat`/dequantize round-trip tests.
- 2026-07-02f: fps-drop investigation (not code-caused); readPixels PBO+fenceSync fix.
- 2026-07-02g: texSubImage2D/getBufferSubData stalls fixed; lazy-closure recursion bug fixed.
- 2026-07-02h: clean-measurement close-out, 144fps target evidence-exhausted.
- 2026-07-03: 18-agent remaining-work sweep, 9 findings landed incl. `EDITOR_TOKEN` auth gate.
- 2026-07-03/04: cross-repo math/packing/quant sweep, 25+13 commits landed.
- 2026-07-04: singleplayer terrain outage (Worker `process.env` crash) + LoadingManager counter fix.
- 2026-07-04b: ruthless-optimize sweep, 5+auth/perf findings; low-rank-factorization survey (mostly declined with evidence).
- 2026-07-04c: planet-disappeared regression, `terrain-occlusion-postrender-queries` fix.
- 2026-07-04d: terrain self-occlusion oscillation fix (elevation envelope + hysteresis).
- 2026-07-04e: stale occlusion verdicts under camera motion, eyeAtIssue expiry fix.
- 2026-07-04f: elevation-needle spikes, FXC floor/fract snoise3 fix.
- 2026-07-05: scale-relative occlusion expiry + veg/rock empty-AABB query fix; harness-degradation-honesty lesson.
- 2026-07-05b: codebase-wide comment strip + dead-code cleanup (8-way parallel workflow, ~135 files, 9 dead scripts deleted, 67 stale memories pruned).
- 2026-07-06: unattributed 44.6% CDP `(program)` bucket root-caused to ANGLE/D3D11 driver-level GPU command submission (trace-prefix gpu-category dominance + zero offcpu_us) -- inherent, no JS-side fix; GC/driver-volume/sync-stall/deopt all ruled out live.
- 2026-07-06b: 144fps push, multi-wave gameplay-bug batch (occlusion/shadow/flicker/impostor/animation/shadow-bridge fixes) + a since-superseded blue-tint/far-trees decline (see 2026-07-07d and project/underwater-model-tint-shaderchunk) + the browser-verb-only discipline note (28 leaking standalone playwright-core scripts deleted). Full detail in rs-learn.
- 2026-07-07b: MERGED ../mapspinner + ../streaming-gltf into packages/ as npm workspaces (parity-bracketed: screenshots + p50 25.9->23.2ms, version deltas… — full detail in rs-learn (recall "2026-07-07b spoint audit").
- 2026-07-07: built apps/ragdoll-brawl-arena (8-player physics-ragdoll knockback FFA prototype), apps/ragdoll-part (per-body-part sub-app),… — full detail in rs-learn (recall "2026-07-07 spoint audit").
- 2026-07-07c: merge-cleanup pass on the 2026-07-07b workspace merge (patch-deps confirmed trimmed, 6 slugs marked DEPRECATED, path audit clean, worktree npm-install bug found+fixed, siblings archived+pushed). Full detail: `project/merge-cleanup-2026-07-07c` in rs-learn.
- 2026-07-08: grass GPU-offload investigation -- falsified the transform-feedback premise via real-module Node measurement (960ms/chunk is fractal-fallback-only, mutually… — full detail in rs-learn (recall "2026-07-08 spoint audit").
- 2026-07-07d: game-stress-test engine-extraction + RenderGraph inspector epic (appName invariant, otb-ball-sync root cause, nan-camera fall-through-kill-plane fix, gh-pages cp-rL deploy fix, engine primitives); supersedes the 2026-07-06b blue-tint/far-trees decline with a real root-caused fix (`project/underwater-model-tint-shaderchunk`). Full detail in rs-learn.
- 2026-07-10: terrain/water not rendering root-caused THREE TWICE (a sampler-unit-collision on TEXTURE8 fixed first, then the REAL cause -- a TEXTURE1/3/5 dirty-cache desync where mapspinner's own… — full detail in rs-learn (recall "2026-07-10 spoint audit").
- 2026-07-11: RE-OPENED the 2026-07-10 tree-flicker "fix" -- user live-witnessed trunks/branches STILL flickering at close range after the shipped `polygonOffsetUnits -8->-32` change — full detail in rs-learn (recall "2026-07-11 spoint audit").

- 2026-07-11b: tree-flicker deep-dive with a WORKING browser verb (fresh server localhost:8090, 4x MSAA, ANGLE AMD Direct3D11) — full detail in rs-learn (recall "2026-07-11b spoint audit").

- 2026-07-11c: CLOSE-TREE-FLICKER SOLVED (supersedes 2026-07-11/11b "root cause UNFOUND / shadow-parameter-artifact") — full detail in rs-learn (recall "2026-07-11c spoint audit").

- 2026-07-11d: 2026-07-11c "SOLVED" was WRONG -- the "refresh shadow every frame the camera moves" fix (shipped b5ccf592) was live-DISPROVEN by the user's eyes, as were a follow-up every-frame-refresh and… — full detail in rs-learn (recall "2026-07-11d spoint audit").

- 2026-07-12: BOTH BUGS FIXED via componentization (user directive: componentize + graph every render/opt seam so the counter-intuitive coupling that hid these bugs is gone) — full detail in rs-learn (recall "2026-07-12 spoint audit").

- 2026-07-12b: 50-game engine-prep continuation (commit 595496c2) -- landed the 5 remaining app-maker primitives the fan-out found uncovered, each live-witnessed (exec_js… — full detail in rs-learn (recall "2026-07-12b spoint audit").

- 2026-07-12c: EDITOR-focused engine-prep (commit 66059fa3) -- adversarial editor fan-out wf_bd8204de-f20 (10 genre probes -> 49 confirmed reachable gaps; synthesize agent died on a session-limit,… — full detail in rs-learn (recall "2026-07-12c spoint audit").
- 2026-07-12d: MAX-EFFORT re-run + "finish all remaining work" -- fresh 50-game+editor adversarial fan-out (wf_d1fe3864: 55 probes -> 213 verdicts -> 180 confirmed net-new gaps; synthesize STALLED on 15… — full detail in rs-learn (recall "2026-07-12d spoint audit").
- 2026-07-19: tickhandler-475ms-single-tick-stall-investigation REPRODUCED and FIXED. Built a real reproduction harness (real spawned server.js child process + real Node WebSocket client speaking the… — full detail in rs-learn (recall "2026-07-19 spoint audit").
- 2026-07-21: sim-render-pacing-alignment-input-loop-raf-sync SHIPPED (follow-up to the 2026-07-19-era vsync-miss-detection row, commit 7019c632). client/app.js… — full detail in rs-learn (recall "2026-07-21 spoint audit").
- 2026-07-21b: content-hash-asset-cache-revalidation first slice SHIPPED for the GLB/VRM transform path — full detail in rs-learn (recall "2026-07-21b spoint audit").
- 2026-07-22: vehicles-jolt-wheeled-constraints-app first slice SHIPPED (4-wheel driveable car, real Jolt WheeledVehicleController) — full detail in rs-learn (recall "2026-07-22 spoint audit").
- 2026-07-22b: destructibles-debris-lifetime-lod SHIPPED (physics-simulated -> kinematic/frozen -> static -> despawn state machine for apps/_lib/destructible.js's debris pieces) — full detail in rs-learn (recall "2026-07-22b spoint audit").
- 2026-07-22e: physics-browser-multithread-reprobe-post-coep RESOLVED (closes the sibling row split off physics-coop-coep-headers-sharedarraybuffer-enable, which had shipped the header half but hit a… — full detail in rs-learn (recall "2026-07-22e spoint audit").
- 2026-07-22d: deterministic-simulation-cross-platform-probe SHIPPED (closes the sibling row split off 2026-07-22c) — full detail in rs-learn (recall "2026-07-22d spoint audit").
- 2026-07-22c: deterministic-simulation-jolt-fixed-point-rollback FIRST SLICE SHIPPED: a real Jolt determinism probe, the data needed to decide whether fixed-point math is actually required before… — full detail in rs-learn (recall "2026-07-22c spoint audit").
- 2026-07-22d: physics-coop-coep-headers-sharedarraybuffer-enable SHIPPED the header half. src/sdk/StaticHandler.js's createStaticHandler now sends Cross-Origin-Opener-Policy: same-origin +… — full detail in rs-learn (recall "2026-07-22d spoint audit").
- 2026-07-22d: edge-serverless-deployment-of-spoint-server-cloudflare-workers-f feasibility probe SHIPPED (no source changes -- the probe itself is the deliverable) — full detail in rs-learn (recall "2026-07-22d spoint audit").
- 2026-07-22f: soft-body-fluid-simulation-pbd-or-sph-via-wasm-for-destructible feasibility probe RESOLVED (no source changes -- the probe is the deliverable, matching this row's own guidance to gate the… — full detail in rs-learn (recall "2026-07-22f spoint audit").
- 2026-07-22g: deterministic-fixed-point-lockstep-architecture-for-rts-fighting feasibility probe SHIPPED (no source changes -- the probe is the deliverable, matching this row's own guidance to gate the… — full detail in rs-learn (recall "2026-07-22g spoint audit").
- 2026-07-22h: lockstep-tick-driver-bypass-dilation SHIPPED (closes the sibling row split off deterministic-fixed-point-lockstep-architecture-for-rts-fighting) — full detail in rs-learn (recall "2026-07-22h spoint audit").
- 2026-07-22i: lockstep-input-transport-tick-driver-integration SHIPPED (both dependency rows -- lockstep-tick-driver-bypass-dilation, lockstep-input-packet-transport-wireweave -- confirmed resolved first) — full detail in rs-learn (recall "2026-07-22i spoint audit").
- 2026-07-22i: lockstep-input-transport-real-network-e2e-witness RESOLVED (no source changes -- pure verification row). node-datachannel (the row's own doc-comment-named candidate) confirmed a real dead… — full detail in rs-learn (recall "2026-07-22i spoint audit").
- 2026-07-22j: rollback-population-inflight-async-commitment-at-suppression-start SHIPPED (bounded follow-up to rollback-entity-population-rewind's defer-until-final-pass design) — full detail in rs-learn (recall "2026-07-22j spoint audit").
- 2026-07-23: server-scale-worldpersistence-workerentry-graceful-shutdown-save SHIPPED (bounded follow-up to server-scale-worldpersistence-singleplayer-workerentry, closing that row's own decomposed gap) — full detail in rs-learn (recall "2026-07-23 spoint audit").
- 2026-07-23: offscreencanvas-mapspinner-internal-config-reads-remaining-sweep next slice SHIPPED under strategy (b) (window.__<key> itself IS the wire format) -- registered 5 more mapspinner… — full detail in rs-learn (recall "2026-07-23 spoint audit").
- 2026-07-23: rollback-wireweave-p2p-wiring-input-ingestion SHIPPED (closes the real dangling-reference gap rollback-misprediction-detector's own row named as its blocking dependency but was never… — full detail in rs-learn (recall "2026-07-23 spoint audit").
- 2026-07-23: webgpurenderer-live-browser-runtime-verification RESOLVED via a fresh worktree spool registration (prior session's attempt hit a transient infra failure, retried cleanly here) — full detail in rs-learn (recall "2026-07-23 spoint audit").
- 2026-07-23: webgpu-veg-placement-decouple-from-raf-for-backgrounded-tab SHIPPED, closing the root-cause blocker behind 3 prior sessions' webgpu-compute-cull-vegetation-live-correctness attempts — full detail in rs-learn (recall "2026-07-23 spoint audit").
- 2026-07-23: server-scale-multiprocess-room-orchestrator-deploy-recipe FIRST SLICE SHIPPED (single-VM/single-Machine scope, built on the already-shipped src/sdk/RoomDirectory.js multi-room-per-process… — full detail in rs-learn (recall "2026-07-23 spoint audit").
- 2026-07-23: webgpurenderer-shadowcostprobe-backend-guard SHIPPED (closes the sibling row filed by the same day's webgpurenderer-live-browser-runtime-verification session) — full detail in rs-learn (recall "2026-07-23 spoint audit").
- 2026-07-23: server-scale-room-orchestrator-load-aware-placement SHIPPED (closes the sibling row split off server-scale-multiprocess-room-orchestrator-deploy-recipe's shipped first slice).… — full detail in rs-learn (recall "2026-07-23 spoint audit").
- 2026-07-23: webgpurenderer-tsl-port-lowrisk-fullscreen-passes-remaining-8 NEXT SLICE SHIPPED (Bloom, following the FSR1WebGPU.js precedent) — full detail in rs-learn (recall "2026-07-23 spoint audit").
- 2026-07-25: graphics-glitch enumeration sweep + gm daemon status-taxonomy audit — full detail in rs-learn (recall "2026-07-25 spoint audit").
- 2026-08-03: gh-pages demo 404 sweep — the deployed demo was fully dead (ProcgenPanel's static /src/procgen imports never shipped, killing the whole app.js module graph) plus root-absolute demo.html/manifest/editor-asset refs 404ing from the domain root; shipped src/procgen in dist, base-prefixed the remaining refs, added a fail-fast deploy guard for unserved /src imports, and fixed the src-rewriting seds' overreach into dist/node_modules the guard immediately caught. Same-day confirming pass extended the sweep: @spoint/ecs + wireweave + deathrun_kosova.glb shipped, minimaps now baked in CI (gitignored artifacts), thebird-host.html repaired (importmap base-prefix sed, /editor/ mount convention, stale aliases + stale editPanel.overlay glue), the progressive bake generalized to every shipped map GLB, and bake-cluster hardened against spec-legal undefined textures. Full detail in rs-learn (recall "project/ghpages-deploy-sed-node-modules-overreach" and "project/ghpages-confirming-pass-thebird-and-bake-2026-08-03").
- 2026-08-13d: tps-game live bug sweep -- boot hang root-caused to a real MeshoptDecompressor.js shared-bufferView index-slicing bug (846470 garbage triangles inflated from a real 9361, hanging Jolt's collider cook indefinitely, correcting a prior session's wrong "resource contention" close), player-spawns-underground root-caused to worldDef spawn points never being ground-raycast-validated (fixed via groundSnapSpawnPoint in src/sdk/ServerHandlers.js), and aim_sillos.glb's degenerate-triangle defect (visually confirmed via a user screenshot of fanning sliver triangles) root-caused to EPS_AREA=1e-6 being genuinely too tight for this asset -- live-tested spatial vertex welding and meshoptimizer's simplifyPrune/simplify as real structural fixes (neither worked), then derived EPS_AREA=1e-4 from a real measured gap in the mesh's own triangle-area histogram (not a guessed round number), applied to both src/physics/ShapeBuilder.js (physics loader, previously unfixed by the original cd110b88 render-path-only fix) and packages/streaming-gltf/tools/bake-cluster.mjs (render path, threshold raised). Evaluated flarelink-in/NullGraph and Scthe/nanite-webgpu for adoptable meshlet/degenerate-triangle-handling code per explicit user request -- read actual source (not README claims) and found neither offers anything better: NullGraph's GLBParser doesn't even support EXT_meshopt_compression (would regress this exact asset), its MeshletBuilder does no vertex welding; nanite-webgpu's meshoptimizer-based pipeline was live-tested against this exact bug and doesn't solve it either. Full detail in rs-learn (recall "project/degenerate-triangle-threshold-is-not-a-tunable-guess").

- 2026-08-21b: "ground depth map height changes with camera, occluding from the ground up" root-caused LIVE (after writeback re-encode math, bias sign, geomorphLod pre-init A/B, and shadow pipeline were all exonerated with measurements): it is mapspinner's `_uw` underwater branch (gl-render.js:2452) -- below the water sphere the two-sided underside writes color+depth and drawSky loses, a 1 m boolean snap the TPS pitch=0 cam crosses routinely; effective local-Y waterline also drops by sagitta d^2/(2R) (~4 m at map edge), so flat `offsetY-anchorHeight` sea-level consumers were wrong -- fixed curvature-aware in client/core/UnderwaterTint.js, src/netcode/PhysicsIntegration.js _submersionFrac, apps/_lib/buoyancy.js. Enabling tooling now in-tree: window.__tpOverride teleport (app.js) + window.__passProbe frame-stage captures (gl-render.js). Method lessons: out-of-band renderer.render captures wipe the raw-GL backdrop and MANUFACTURE a black-void artifact that masquerades as this exact bug; init-time-only knobs (geomorphLod) need a pre-boot default flip, post-init toggles are silent no-ops. Follow-up (same day): a 33-site above-water sweep surfaced a SECOND, above-water regime -- at grazing altitude (eye within ~2 m of the water sphere, camAlt -0.9..-1.85) the camera-relative VS projection FLIPS the water surface's projected winding, so the hardcoded cullFace(FRONT) culled the entire visible ocean -> hard black horizon band (sky's sub-horizon radiance is black by design); proven via uWaterDbg mode 10 (unconditional-magenta first-FS-statement: zero fragments in band) + __cullMode='none' A/B (band fills with water); fixed regime-aware in gl-render.js water pass (`_waterCullFront = !_uw && !(Math.abs(camAlt)<5.0)`), live-verified across dy scans + regression poses. Full detail in rs-learn (recall "project/ground-depth-cut-is-underwater-ceiling-waterline-crossing").

@.gm/next-step.md

## ALL GUI COMPONENTS LIVE IN ANENTRYPOINT/DESIGN (CRITICAL RULE, 2026-08-21)

**MANDATORY ARCHITECTURAL RULE**: All GUI/UI components for spoint must live in the `AnEntrypoint/design` repository, NOT in spoint source. This is a single-source-of-truth requirement that applies to every UI component, screen, dialog, panel, editor toolkit, and game feedback system.

**Enforcement**:
- spoint ONLY imports UI components from design kit via CDN (`https://cdn.jsdelivr.net/gh/AnEntrypoint/design@main/...`)
- spoint does NOT create new UI components in `client/`, `client/editor/`, or anywhere else
- Any new GUI for spoint (asset browser, batch operations panels, damage feedback UI, game editor kit)
  must be built in AnEntrypoint/design repo and published there
- Code review: **REJECT** any PR that adds UI-only components to spoint client/ without corresponding work in design repo
- CI/CD: **FAIL** deploy if new `*.html`, `*.css` styling, or UI-rendering `*.js` files appear in spoint client/ that duplicate work belonging in design kit (exclude server-side .html routing only)

**Game Editor Kit specifically**: Lives in AnEntrypoint/design under `src/components/game-editor-kit/` as a separate component export alongside the main component kit. Contains: damage feedback UI (floating damage numbers), asset browser, model preview, batch operation UX, persistent undo history UI, any other gameplay-specific editor panels. All reusable across other editors and projects.

**How components reach spoint**:
1. Develop component in AnEntrypoint/design repo with full configuration/tests
2. Export from design/src/components/game-editor-kit/index.js
3. Push to design repo main branch
4. spoint auto-picks up via CDN @main (zero spoint-side changes needed for rendering logic updates)
5. Importmap in spoint/client/index.html and other client entry points maps bare specifiers to CDN URLs
6. Verify rendering in spoint by checking live URL with cache-buster (`?v=<ts>`)

**Example**: DamageNumbers UI component for hit feedback (commit b393ef2b in design):
- Location: `design/src/components/game-editor-kit/DamageNumbers.js`
- Core logic backend: `spoint/src/effects/DamageEffects.js` (screen shake, sound, impulse only — NO UI code)
- Event system: `spoint/apps/hit-feedback/index.js` (wires damage bus events)
- Frontend rendering: Design kit's DamageNumbers (imported via window.DamageNumbers or importmap)
- Lifecycle: Backend triggers event → app emits via bus → client-side listener calls DamageNumbers.addNumber() → DOM rendered/animated via CDN component

**Recall memo**: `project/gui-kit-architecture-2026-08-21`
