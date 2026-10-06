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

Slugs only; full text lives in the recall store (`.gm/memories/`; `recall <slug or topic>`; when the
recall embedder is down, `grep` the slug under `.gm/memories/` — the md corpus is the same store).
Add a caveat with `memorize-fire` (`project/<area>-<slug>: ...`) and append its slug. Keep this file
under 30 KB: drain narrative into recall, never grow an audit log here.

## Working rules

- `project/working-rule-every-opportunity-is-executed-or-filed-2026-10-05`: a restructuring or
  optimization opportunity noticed while working is either executed in the same pass (small,
  in-lane, with its before/after witness) or filed with `prd-add` (id, title, body,
  acceptance_criteria) before the turn ends. A report that mentions one with no row id and no commit
  sha is incomplete. Spawned agents carry this rule and list what they executed and filed. An
  unmeasured speedup claim is still never executed.
- Main-only, no branches (`gh-pages` is a deploy artifact). Commit only as `lanmower`
  (`657315+lanmower@users.noreply.github.com`), never as an AI assistant, same in every submodule.
- Always `git_commit`/`git_finalize` **with an explicit `paths` list**; never `git add` + bare
  `git commit`, which commits the whole index (`0292ad7b` did exactly that). Never commit a file
  that imports a file absent from the same commit — that broke HEAD four times
  (`mapspinner/splat-weights`, `src/presets/*`, `AppContext.js` -> `AppGameplay.js`,
  `src/stdlib-apps/*`). Read `committed`/`requested_paths`/`excluded` off the response. `.gm`
  pathspecs are honoured (fixed 2026-10-02 in `AnEntrypoint/rs-plugkit` `6f98e47`/`30786b6`);
  a pathspec matching nothing returns `pathspec_matches_nothing` and stages nothing.
- Generated artifacts travel in the same commit as the source they are generated from. A commit
  touching `src/apps/AppContext.js` must also carry `npm run gen-typings`'s
  `client/editor/sdk-typings.generated.d.ts`, which is emitted from a detached worktree of HEAD and
  so is gen(committed source); a commit changing height code must re-bake the `apps/world/*.hf` the
  `check-cache-keys` gate names, and that gate prints the exact command to run. Both gates fail CI
  on the very commit that changed the source, which is three red pushes on 2026-10-06 (`4b8fc9cf`,
  `a318f025`, `61608226`) and each left main unusable for every lane until repaired.
- `gm-spool-dispatch-filenames-are-session-prefixed`: a spool dispatch file must be named
  `in/<verb>/<session-id>-<random8>.txt`; a plain numeric name is swept out without executing.
- `core.autocrlf=true` makes checkouts write CRLF while the index stays LF, so a working-tree hash
  can differ from the index; `w/crlf` in `git ls-files --eol` is not a diff.
- `@spoint/ecs` is the repo's only `@spoint/*` specifier — `mapspinner` and `streaming-gltf` are
  their own workspace names and are imported bare, so `@spoint/mapspinner` does not exist and is
  imported nowhere. `node_modules/@spoint/ecs` is an npm-managed workspace link that has vanished
  mid-session with no `npm install` running, after which every harness dies with `Cannot find
  package '@spoint/ecs'` — an error that points at the import statement and so reads as a real
  defect in whatever was just changed. `postinstall` and `npm run check` both restore it through
  `scripts/ensure-workspace-links.mjs`; `npm run links` does it alone. Never fix it with
  `npm install`, which rewrites `node_modules` under every concurrent lane. A harness that
  resolved a workspace package from the wrong path executed different bytes, so a measurement
  taken while a link was missing is not a property of the code under test.
- `project/gpu-lock-run-spawns-node-never-a-shell`: `gpulock.mjs run <owner> bash ...` exits 127
  here (spawn is shell:false); pass the node binary and a .mjs script, and confirm with `status`.

## Zero-comment sweep

Names and structure carry meaning; rationale that code cannot carry lives in recall, the commit
message, or this file. Swept 2026-09-14 (`client/` `src/` `apps/` `scripts/`
`packages/{mapspinner,streaming-gltf,ecs}/src`) and 2026-09-28 (`packages/*/examples/**`,
`packages/*/scripts/**`, Rust). Kept on purpose — never re-flag: `@ts-*` / `eslint*` /
`@vite-ignore` / `webpack*` / `/*! */` / `#__PURE__` / `sourceMappingURL`; comment-looking text
inside string literals (embedded GLSL, `scripts/patch-deps.mjs`'s `// [spoint patch]` markers,
generated headers); any `*.md`; `types/*.d.ts` JSDoc (the published app-SDK contract app authors
read as IntelliSense); Rust `///` on a `#[wasm_bindgen]` export that states an ABI fact
(`pack_quat` bit layout, `unpack_quat` return order, `mul_quat` component order in
`packages/spoint-core/src/lib.rs`). Vendored/generated, never edited: `client/vendor/`,
`client/editor/wm/wm.css`, `packages/mapspinner/src/height-gen.js`, `*/basis/basis_transcoder.js`,
`packages/streaming-gltf/src/draco-loader.js`, `client/editor/sdk-typings.generated.d.ts`.
False positives: `*[Symbol.iterator]()` / `*entries()`, CSS `*` and `#id`, GLSL `#ifdef` and `*`
block continuations, glob literals in `console.log`, `//` inside `http://`.

## Repo boundaries

- `project/anentrypoint-consumption-and-submodules`: AnEntrypoint publishes nothing to npm.
  `design` is consumed as pinned CDN URLs in the importmaps of `client/index.html`,
  `client/landing/index.html`, `client/editor/thebird-host.html`, `scripts/bundle-client.mjs`
  (bare `anentrypoint-design` -> unpkg `1.0.34/dist/247420.{js,css}`; `game-editor-kit` -> jsdelivr
  `gh/AnEntrypoint/design@<sha>`) — bump all four together. `wireweave` is an
  optionalDependency `github:AnEntrypoint/wireweave`, remapped to
  `/node_modules/wireweave/src/index.js`. `gm` is a global `npx gm-skill install`, not a spoint
  dependency. `vendor/*` are editing-only submodules: never imported from `client/`, `scripts/`,
  `src/`; edit on their own `main`, push there, then commit the gitlink. The importmaps also remap
  `https://esm.sh/three@r128` to the local three (`project/importmap-esmsh-three-dedupe`); COEP
  `require-corp` means every kit CDN must send CORP and the importmap must precede any module
  load/preload. `nostr-tools` is injected from `client/vendor/nostr-tools.mjs`. No npm dependency on
  the kit. Pin a wireweave SHA (no CI here tests its `main`). A fourth submodule needs a documented
  runtime mechanism.
- `project/gui-kit-architecture-2026-08-21`: every UI component is built in `AnEntrypoint/design`
  (`src/components/game-editor-kit/`) and reaches spoint only through the pinned importmap; spoint
  keeps backend only (`src/effects/DamageEffects.js`, `apps/hit-feedback`). Reject any
  UI-rendering `*.js`/`*.html`/`*.css` under `client/` without the design-repo work: design first,
  spoint integration next commit, verify on the live URL with `?v=<ts>`.
- `/client-error` (`client/core/ErrorTelemetry.js`) and `/upload-model` (`client/editor/editor.js`)
  are server routes (`src/sdk/ServerAPI.js`) absent on the static gh-pages host; both no-op behind
  `.catch` (accepted 2026-08-03).

## Debugging discipline

- `project/degenerate-triangle-threshold-is-not-a-tunable-guess`,
  `project/degenerate-triangle-third-copy-and-immutable-cache`: a bug that survives a threshold
  change was not fixed — re-diagnose the mechanism. Exhaust structural fixes, then derive a
  threshold from a measured discontinuity (`EPS_AREA=1e-4` sits in a verified histogram gap of
  aim_sillos.glb). A fix correct at its own layer that fails end-to-end means another copy of the
  same check exists (three did: `src/physics/ShapeBuilder.js`,
  `packages/streaming-gltf/tools/bake-cluster.mjs`,
  `packages/streaming-gltf/src/cluster-lod-mesh.js`). A re-bakeable URL needs a real ETag;
  `immutable` without one serves stale pre-fix bytes. Verify rendering on live GPU data
  (`window.__scene`).
- `project/node-process-exit-races-uv-async-send-2026-10-06`: `src\win\async.c, line 76` is
  libuv 1.51.0's `uv_async_send` assert — a send to an already-closing `uv_async_t`, not a double
  close; spoint owns none of the three `uv_async` handles a process has. Fires at `process.exit()`
  with handles mid-close, so headless scripts must await `process._getActiveHandles()` reaching 0.
- `project/debugging-playbook-live-gl-instrumentation-2026-07-10`: console-text disambiguation of
  same-code GL errors, draw-call stack capture, live GL state over JS-cache trust, pixel-sample
  toggle elimination for flicker, discrete-vs-noise classification before chasing.
  Underwater/waterline and grazing-altitude water cull:
  `project/ground-depth-cut-is-underwater-ceiling-waterline-crossing` (`window.__tpOverride`,
  `window.__passProbe`; an out-of-band `renderer.render` fakes a black void).
- `project/page-boot-witness-needs-multiplayer-not-singleplayer`: a page witness that needs the
  server to act on a client message must pass `--params=multiplayer`; under `?singleplayer` the node
  server sees `players:0` throughout and the message is acked `ok:false`.
- `witness-page-boot-fails-on-aborted-requests`: `page-boot-witness` fails an arm on any failed
  request including `net::ERR_ABORTED` cancellations, so no arm passes without
  `--allow-failed-requests`.

## Entry points

- `ctx.defineGameFSM(spec)` `src/behaviours/game-fsm.js` (`fsm.tick(dt)` from `update`);
  `client/core/ClientMachine.js` is xstate5 parallel and its loading fallback is `after:` 10 s
  gated / 45 s hard stop; editor hierarchy messages REPARENT/DUPLICATE/SET_LABEL are 0x94-0x96;
  mapspinner and streaming-gltf are in-repo npm workspaces under `packages/`, edited directly.
- Engine behaviour primitives live in `src/behaviours/` (`apps/_lib/*` are one-release re-export
  shims). `ctx.defineCombat(spec)` owns the shooter loop as `ctx.combat`
  (`project/engine-apps-boundary-b5-b8-combat-behaviour-presets-2026-10-02`); `ctx.defineFire(spec)`
  owns fire (below).
- Default world is `apps/world/index.js` `defaultWorld`; worlds are validated
  (`src/shared/worldResolve.js`), defaulted (`src/shared/worldDefaults.js`) and preset-expanded
  (`presets: ['tps']`, `src/presets/`) in every runtime; default avatar
  `client/assets/default-avatar.vrm` (CC0); TURN only via `SPOINT_ICE_SERVERS`. Static compression
  cache is `.spoint-cache/static/`. See `project/engine-apps-boundary-b0-b1-2026-09-30` and
  `project/engine-apps-boundary-b2-b4-world-registry-resolve-presets-2026-09-30`.
- Test relocation: `window.__spoint` + `MSG.TELEPORT`
  (`project/test-relocation-api-teleport-bookmarks-whensettled`).

## Fire (`ctx.defineFire`, `src/behaviours/fire.js`)

`project/fire-system-design-2026-10-05` is the design record (PRD row `fire-system-big-deal`,
children `fire-s1..s6`); `project/fire-system-s2-s3-landed-2026-10-05` is its addendum and
**corrects two statements in it — read both**. Landed S1 `ed278b8b`, S2 `966b09a7`, S3 `02a819b5`
(plus `fd4f05a4`, `da264a92`), headless and **default off**: nothing runs until an app calls
`ctx.defineFire`. Deterministic by construction: an integer-only, order-independent kernel
(`src/shared/fire/fireKernel.js`) whose per-cell decisions come from `hash(seed, step, face, I, J)`
— no float, no `Math.random`, no `Date.now` (never copy `destructible.js`'s use of either). Cells
are 2x2 veg placement cells (8 m) on the placement cube-face lattice, keyed `(face,I,J)`, so burn
state is chart independent; a trunk's cell is exact integer arithmetic from its `trunkId`. Step
boundaries are absolute ticks, so peers that start ticking at different times still apply an event
at the same step. Only ignition/extinguish/weather events cross the wire
(`src/shared/fire/fireWire.js`), and `spec.role: 'mirror'` cannot originate events. Gameplay consumers:
`ctx.navCostAt(x, z)` returns 8 over a burning cell and 2 over a charred one (steering divides speed
by it, `src/behaviours/steering.js`), and players get `fire_burn` / `fire_burn_end` / `fire_death`
payloads from `src/behaviours/fireGameplay.js`. tps-game wires all of it behind
`config.fire.enabled`, shipped **false** (`apps/world/tps-game.js`); `apps/tps-game/server-app.js`
builds the fire only when that flag is `true`, and its combat bridge passes `fire.rayBlocked` as
`shotBlocked` and ignites on `onWorldHit`.

Wind and weather: `src/sdk/ServerWeather.js` carries an authoritative `[x,y,z]` integer wind clamped
to +-16 on the WEATHER_SYNC payload — an **additive** field, so `WIRE_PROTOCOL_VERSION` stays 5 and
an old payload without `wind` leaves the fire's `spec.wind` untouched. Time-varying wind comes from
`src/shared/fire/fireWind.js`, a pure `hash(seed, step)` integer field with no float and no per-peer
state, so peers that start ticking at different ticks read the same vector at the same step; a wind
that must be authoritative arrives as a `FIRE_EVENT.WIND` event at an absolute step boundary.
Rain/moisture/wind are emitted only on change (moisture with hysteresis) and `fire.weather` exposes
the current rain byte, moisture and wind. Firebreaks (`src/behaviours/fireTerrain.js`) give cleared
circles, terrain kinds, submerged and rock cells fuel class 0, so they can never ignite.

Witnesses: `scripts/fire-witness.mjs` (kernel, wire, rollback, late join + sliced keyframe),
`scripts/fire-peer-rollback-witness.mjs` (rollback/lockstep desync counts),
`scripts/fire-weather-witness.mjs` (wind field, rain halt, additive WEATHER_SYNC),
`scripts/fire-combat-witness.mjs` (incendiary, extinguish, explosion, firebreaks, tps-game flag).

Open rows: `fire-s1d`/`fire-s1e` (kernel perf: incremental hash + dirty-tile snapshots, per-tile
reclaim and placement fuel), `fire-s2b` (smoke occlusion, browser),
`fire-s2c-veg-sway-wind-vector-client` (vegetation sway is still the scalar `window.__vegWind`, no
direction), `fire-s3a` (client mirror + GPU), `fire-s4a-d`, `fire-s5a-d`, `fire-s6`.

## Planet-wide multiplayer (`src/shared/clusterAssignment.js`, `src/sharding/`)

`project/planet-wide-multiplayer-architecture-2026-10-05`: dynamic **proximity clusters**, one
existing server world per cluster, each cluster its own flat chart (ChartReanchorService follows the
cluster centroid), several small worlds per worker process — never one process per player. The Jolt
wasm heap is **fixed at 134217728 B (128 MiB)** and never grows: exceeding it raises
`Aborted(OOM)` inside `new J.JoltInterface` (`src/physics/World.js:60`), killing every world in the
process — it does not degrade. Measured 2026-10-06
(`project/cluster-world-heap-budget-measured-2026-10-06`), replacing the old "about 21 MiB" prose
that was never measured: a cluster server world costs a **constant 19.301 MiB marginal at every N**
(20238432 B with a connected grounded player, 20236288 B empty — the first world costs the same as
the sixth, so average and marginal agree, and the only one-time cost is the 1157976 B resident
present before any world). So **6 is the most server worlds that fit at all** (11.09 MiB, 8.7%,
left) and the 7th aborts. `CLUSTER_HEAP_WORLD_CEILING` is derived in `src/shared/clusterConfig.js`
from `JOLT_WASM_HEAP_BYTES`, `JOLT_WORLD_MARGINAL_BYTES` and `CLUSTER_HEAP_RESERVE_FRACTION = 0.1`
and comes out at **5** — one below the raw maximum, on purpose: a process that also runs client
collision mirrors spends **10.756 MiB of the same heap each**, and 6 server worlds plus the 2
mirrors the cluster harness co-locates measures 137.4 MiB and OOMs by 9.4 MiB (witnessed), while 5
plus the same 2 mirrors measures 118.1 MiB and fits. A world per player is unviable either way.
That cost is ~98% **reservation, not content**: `10645288 + 33*mMaxBodies + 88*mMaxBodyPairs +
336*mMaxContactConstraints` bytes, validated within 0.03% at the defaults 10240/65536/10240 and at
`MIRROR_JOLT_LIMITS`. Content is negligible beside it — a static body is 266 B, a dynamic body
392 B, a character 416 B, a 65x65 heightfield 16 KB, a connected grounded player 2144 B. So the
density lever is **`joltLimits`, not world count** (row
`cluster-world-jolt-limits-right-sized`): `src/sdk/server.js:37` passes none, so every world
reserves for 10240 bodies and 65536 body pairs. Assignment is pure and deterministic (positions only, order independent, hysteretic,
antipodal-safe), run at 2-4 Hz rather than per tick: it is O(n^2) at 0.16 ms for 16 players and
8.9 ms for 1024. Load is not the reason to partition — chart validity is: two players 100 km apart
on one shared chart read 51.83 deg of slope. `resolveClusterConfig` refuses a link below the
relevance ring or the longest weapon range, and a radius past `WALKABLE_CHART_LIMIT_DEG`. A
chart-local point at or beyond the planet radius throws `ChartRangeError` instead of returning flat
ground. Entry points: `src/sharding/ClusterManager.js`, `ClusterWorldHost.js`, `ClusterHandoff.js`
(`exportPlayerHandoff`/`admitPlayerHandoff` over `createChartTransfer` + `createReexpressPass`).
Entity partition across cluster worlds is the large unsolved piece. Landed default-off and unwired
as of 2026-10-05 (`terrain.clusters.enabled !== true` returns null).

## Chart re-anchor

- `project/chart-reanchor-server-state-migrators-2026-10-05`,
  `project/chart-reanchor-terrain-holders-2026-10-05`: every server-side chart-local holder with
  file and mechanism, the grounded-velocity tilt clamp, the fault policy that stops the tick loop on
  a half-migrated frame, the base-chart persistence rule. A new holder of chart-local state must
  either be re-expressed in `src/sdk/chartState/` or expose `onChartReanchor` (apps:
  `server.onChartReanchor(ctx, {transfer})`; behaviours made through
  `ctx.defineCombat/Checkpoint/ShrinkingZone/Destructible` register through
  `AppContext._chartAware`).
- `project/chart-reanchor-wire-epoch-client-consumers-2026-10-05`: CHART_REANCHOR 0xc6, epoch on
  snapshots/inputs/events/teleports, the client consumer, harness
  `scripts/chart-reanchor-wire-harness.mjs`.
  `project/msgpack-usefloat32-lossy-doubles-audit`: `src/protocol/msgpack.js` encodes with a Packr
  at `useFloat32: NEVER` (float64 0xcb, bit-exact) and decodes with a **separate Unpackr at
  `DECIMAL_ROUND`** — deliberately asymmetric. msgpackr applies 0xca decimal rounding only when
  `useFloat32 > 2` (`node_modules/msgpackr/unpack.js:344`), so a decoder at NEVER returns the raw
  widened float32 and silently disagrees with a pre-change peer that emitted 0xca (`0.1` ->
  `0.10000000149011612`, `8.79` -> `8.789999961853027`, `123.456` -> `123.45600128173828`);
  DECIMAL_ROUND reproduces old->old bit-for-bit (2509/2509 in-scope values). new->old needs nothing
  — 0xcb reads exactly on either decoder — so no `WIRE_PROTOCOL_VERSION` bump and no
  `SPOINTREPLAY_VERSION` bump, because old replay files now decode exactly as recorded. Real
  snapshots are byte-identical under both settings (0 B; `Buffer.compare === 0` at 24p/200e and
  8p/50e): positions travel as i32 centimetres and every other leaf is an int, a string or bytes, so
  size cost appears only where a raw JS-number double actually crosses — +4 B per float, +80% at
  2000 raw doubles. `useFloat32: 4` (DECIMAL_FIT) round-trips bit-exact on every corpus measured
  (0/100000 2-dp, 0/20000 3-dp, 0/20000 toFixed(2), 0/20000 uniform random) but is still not
  lossless in general: `8.790000000000001` -> `8.79`, 1 ulp, because its "is this an integer" guard
  is evaluated in double arithmetic. Only NEVER is exact by construction.
- Jolt recycles the tree nodes of removed bodies only in `physics.step`, so re-adding thousands of
  bodies with no step between aborts the wasm.
- `project/planet-chart-cell-keyed-vs-threshold-reanchor-and-runtime-slice-2026-10-05`: a flat chart
  plus global gravity has an intrinsic tilt term — with one tangent chart at `anchorDir` and gravity
  fixed at `[0,-18,0]` the surface tilts away from the chart's up axis by roughly theta at angle
  theta from the anchor, so at 15 deg even constant-elevation ground reads as a 15 deg slope. Of 43
  non-walkable circumnavigation crossings, 26 are genuine cliffs (up to 74.23 deg terrain), 17 are
  this term (median excess 9.26 deg, max 17.31, floor -9.09 where the terrain's own slope cancels
  part of it — a negative value is the signature, a stale-cache read cannot be negative). Fixed by
  shrinking the chart: `CHART_ANCHORS_PER_FACE = 32` (`src/shared/chartAnchor.js`, shipped
  `b6af3ff0`), cell-keyed, worst cell angle 2.26 deg. Never raise `MAX_SLOPE_DEG`, pinned to
  `DEFAULT_MAX_SLOPE_ANGLE_RAD = 0.7854` in `src/physics/CharacterManager.js`.
  `project/terrain-fine-field-height-error-is-the-chart-tilt-term`: that same term bounds every
  field-interpolated ground answer. Measured on tps-game (radius 63600 m, 256 m field, 2.0157 m
  spacing) against the exact solver at interior points — max error 0.2452 m at the anchor, 0.2619 m
  at 1 km, 0.3708 m at 10 km and 4.0304 m at 60 km, against a `spacing * tan(distance / radius)`
  prediction of 0 / 0.0317 / 0.3196 / 2.7798 m over a ~0.21 m solver floor. Halving the spacing
  shrinks it by 0.47-0.65, not 0.25, so it is first order in spacing, not interpolation error, and
  re-anchoring the chart on the same ground collapses 4.0304 m to 0.2084 m. Bound to assume: about
  0.35 m max (0.16 m p95) anywhere inside a cell-keyed chart, growing as
  `0.21 m + spacing * tan(distance / radius)` once the anchor is further away.
  `streamer.chartReanchor` (`src/terrain/ChartReanchorService.js`, `tcfg.chartReanchor.enabled`,
  default off) rotates the frame and runs every registered migrator; it throws only when stepped
  with no migrator registered.

## Code rationale index

Full text in recall (`recall <slug>`); read the memo before changing the named code.

- three: `three-shaderchunk-edit-needsupdate-noop`, `overridematerial-instancedmesh2-instanceindex`,
  `instancedmesh2-addshadowlod-default-material`, `batchedmesh-array-material-never-draws`,
  `shadowcostprobe-three-shadowmap-scope-gate`.
- Model pool: `modelpool-shared-ktx2loader-singleton`, `modelpool-per-instance-geometry-shell`,
  `modelpool-vram-one-way-ratchet`, `streaming-gltf-clusterlodmesh-array-material-seed-group`.
- Spaces: `floating-origin-camera-set-not-translate`, `editor-render-vs-authoritative-positions`,
  `floating-origin-snapshot-targets-to-render`, `hostnearfar-shared-depth-contract`.
- mapspinner: `mapspinner-sampler-units-never-empty`, `mapspinner-shared-gl-context-state-hazards`,
  `mapspinner-snoise3-single-floor-fxc`, `mapspinner-unounroll-loop-bound`,
  `mapspinner-face-frame-tables-agree`, `mapspinner-hpf-inset-matched-triple`,
  `mapspinner-atm-lut-constants-mirror-glsl`, `mapspinner-scattering-lut-glsl-layer-mirror`,
  `mapspinner-samplegroundm-one-call-stale`, `mapspinner-waterpass-discard-isolation`,
  `tsl-parity-pxworld-camdist-fp32-asymmetry`.
- Runtimes: `worker-module-no-importmap-bare-specifier`, `sdk-dual-runtime-process-guard`,
  `apps-cannot-import-client-modules`, `esbuild-import-specifier-iife-not-concat`,
  `browserserver-snapshot-flush-settimeout-not-raf`.
- Apps: `app-motion-streams-all-bodytypes` (supersedes the old "moving apps must declare
  kinematic/dynamic"), `app-setup-sibling-entities-not-ready`,
  `inventory-client-payload-trust-boundary`, `component-schema-positional-wire`,
  `componentpool-f64-for-epoch-and-config`, `destructible-pool-park-deactivate-and-hide`,
  `app-physics-addforce-is-impulse`.
- Physics (Jolt): `physics-jolt-shaperesult-destroy-after-addbody`,
  `physics-jolt-getter-return-destroy-hazards`, `physics-jolt-vehicle-ownership-and-wake`,
  `physics-lod-vehicle-chassis-exempt`.
- Netcode/wire: `msgpack-wire-structures-snapshot-key-list`, `snapshot-entity-bin-fresh-buffer`,
  `tickhandler-knownids-reset-only-on-keyframe`, `netcode-dt-determinism-source`,
  `lockstep-checksum-canonical-float64-order`, `p2p-wireweave-ctrl-frame-prefixes`,
  `baseclient-callback-allowlist`, `inputguard-sanitize-yaw-and-input-bucket`,
  `predictionengine-collision-blind-wedge-drift-fix`.
- Server/security: `server-http-auth-matrix`, `ses-evaluator-fails-closed-no-proxy-tier`,
  `statichandler-path-containment`, `statichandler-coop-coep-require-corp`.
- Terrain/assets: `terrain-collider-streamer-per-player-rings`,
  `terrain-placement-parity-salt-and-prejitter-cell`, `glbktx2-meshopt-bufferview-ext-range`,
  `rocks-visual-physics-seed-parity`,
  `project/terrain-heightfield-collider-quantizes-over-min-max` (a Jolt field quantizes over its
  own min/max: error about range/30000, and a 10 um nudge of an extreme cell moves the surface up
  to range/5000 anywhere, which is why the sampler snaps to 1 mm and why `+ 0` after `Math.round`
  is load-bearing),
  `project/terrain-raycast-comparison-must-pin-resident-field-set`,
  `project/terrain-fine-field-height-error-is-the-chart-tilt-term`,
  `project/terrain-collider-initial-ring-is-placement-bound` (2.242 ms per ring chunk is 96% of the ring, so the 2.5 ms compute budget admits ~1 chunk/pass: budgeted boot 35.5 s vs 2.95 s; batch per cluster, 94.7 ms each),
  `project/terrain-collider-deferred-rebuild-exceeds-body-cap` (983 live against cap 768: the cap bounds one pass, not the resident set).
- Editor/UI/tooling: `kit-applydiff-child-crash-classes`, `hud-overlay-mount-outside-uiroot`,
  `e2e-harness-multiplayer-param-and-no-watch`, `bundle-client-outfile-and-externals`.

## Topic catalogs in recall

- `project/legacy-area-slug-catalog-part1-terrain-veg-physics-models`,
  `project/legacy-area-slug-catalog-part2-app-deploy-editor-perf` (older names; most bodies were in
  the retired rs-learn store, so the name plus `git log` on the named file is all that survives).
- `project/code-rationale-slug-index-part1-render-assets-mapspinner`,
  `project/code-rationale-slug-index-part2-netcode-server-apps-scripts` — every per-file rationale
  slug moved out of source comments.
- `project/spoint-core-rust-js-twins-byte-identical`.
- Netcode (docs/netcode.md): `netcode-authoritative-path-defects`,
  `netcode-input-pipeline-exact-prediction-invariants`, `snapshot-timeline-remote-interpolation`,
  `tick-scheduler-and-snapshot-wire-v3`, `lag-compensation-view-tick-rewind`,
  `netcode-rollback-profile-exact-resim`, `netcode-lockstep-profile-agreed-drop-and-pacing`,
  `prediction-wall-plane-hints-position-only`, `jolt-value-getters-are-static-temps-never-destroy`, `netcode-lockstep-drop-tail-margin-is-inputdelayticks`, `netcode-rollback-measurements-depth-not-rate`.
- Perf/spawn 2026-09-30: `veg-instancedmesh2-lod-children-cull-and-empty-levels-2026-09-30`,
  `webgpu-dynamicdrawusage-reuploads-every-render`, `webgpu-vec3-attribute-padding-full-copy`,
  `tsl-webgpu-perf-parity-2026-09-30`, `webgpurenderer-impostor-atlas-orientation-and-normals`,
  `spawn-hold-until-static-colliders-and-floor-probe-2026-09-30`,
  `veg-variation-perf-ab-and-remaining-costs-2026-09-30`,
  `spawn-surface-standing-lifted-dropped-2026-09-30`,
  `occlusion-query-tier-stuck-query-recycle-2026-09-30`,
  `veg-variation-strengthened-metrics-and-witness-method-2026-09-30`, `dev-hmr-system-2026-09-30`,
  `dev-hmr-batch2-2026-09-30`, `dev-hmr-batch3-2026-09-30`,
  `prediction-collision-mirror-static-tiles-2026-09-30`, `patch-bake-worker-readback-off-main-thread`,
  `local-player-step-trail-render-interpolation-and-jank-sources-2026-09-30`.
- 2026-10-02: `grass-placement-painted-splat-weights`, `tsl-sculpt-override-r32f-2026-10-02`,
  `tsl-default-renderer-and-hashversion2-flip-2026-10-02`,
  `tsl-aerial-perspective-vs-legacy-measurement-2026-10-02`, `impostor-atlas-capture-tsl-2026-10-02`,
  `tsl-import-names-check-against-installed-exports-2026-10-02`,
  `terrain-legacy-gl-pipeline-cannot-do-v2-2026-10-02`, `perf-run-draws-counter-and-gate-buckets`,
  `terrain-boot-coarse-then-refine-and-demand-sized-pools-2026-10-02`.

Per-session narrative is drained; the durable lessons are the slugs above.

@.gm/next-step.md
