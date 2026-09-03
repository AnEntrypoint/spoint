# mapspinner — agent working rules

## SDK Validation Policy

SDK changes must be validated against the test suite and verified in both the dev demo (planet.html) and external consumer examples. No changes ship without passing tests.

## WebGPU: history + a scoped, unimplemented experiment (2026-07-03)

mapspinner already tried a WebGPU compute-texture terrain pipeline once
(`terrain-phase1/2/3.js` + `normal_producer.wgsl`, CHANGELOG 2026-05-23) and
REMOVED it -- the current "GPU one-fractal" architecture (procedural
`composeHeight` per-vertex, no tile producer, no atlas) won. The THC height
pool above is the WebGL2 texture-cache alternative and was MEASURED
net-negative. Because `composeHeight` already runs GPU-side, WebGPU's usual
selling point (eliminating CPU<->GPU transfer for compute-heavy work) does not
apply here -- there is no CPU-side cost to eliminate.

The one WebGPU-specific mechanism NOT yet tried: a storage-buffer height
cache with zero-copy compute-to-vertex sharing (WebGPURenderer + TSL
`instancedArray`/`storageTexture`, compute pass writes directly into a buffer
the vertex stage reads with no texture-sample indirection) MIGHT avoid the
FS-cost-shift that sank the WebGL2 texture version -- a texture sampler still
has to interpolate/resolve address+filter state per fetch; a raw storage
buffer read does not. This is a real, different mechanism from the reverted
phase1/2/3 pipeline and from THC, not a re-litigation -- but it is UNMEASURED
and should not land without a real A/B number, matching this file's own
"no changes ship without passing tests" / "measure, do not eyeball" rule.

Scoped experiment for a session with real GPU profiling access:
1. Build a WebGPURenderer-only path (three/webgpu import, automatic WebGL2
   fallback for unsupported browsers per that build's documented behavior)
   with a compute pass writing height into a `storageTexture` sized like the
   existing THC pool (130-texel tiles, matching THC_BAKE_RES for an apples-
   to-apples comparison).
2. Vertex stage reads via `textureLoad` (sampler-less, matching the raw-buffer
   read this experiment is testing) instead of THC's filtered `texture()`
   sample.
3. Profile identically to the 2026-06-15 THC measurement (same deck scene,
   same `__diag.pxPerPoly()`/frame-timing methodology) and record VS-cost vs
   FS-cost split, not just aggregate FPS -- THC's regression was specifically
   a cost-SHIFT (VS cheaper, FS worse), so aggregate FPS alone would have
   hidden it.
4. Land only if the FS-cost-shift is smaller or absent; otherwise record the
   negative result here (same discipline as the THC entry above) so a future
   session does not re-attempt it blind.

DECISION (2026-07-03, feasibility check before attempting the experiment): NOT ATTEMPTED this
session -- infeasible in-scope, not just unmeasured. Checked `package.json`: mapspinner has ZERO
three.js/WebGPURenderer/TSL dependency of any kind; the only "WebGPU" references anywhere in src/
(`gl-render.js:4`, `shaders/atmosphere.glsl:5-9`) are comments about an EXTERNAL offline tool that
bakes the atmosphere scattering LUTs, unrelated to the runtime terrain render path. Confirmed
`navigator.gpu` IS available in the project's own headless Chrome (149, `--no-sandbox`, no extra
flag needed) -- so the browser-side capability isn't the blocker. The blocker is that "a scoped
experiment" as written requires standing up an entire SECOND rendering backend from scratch (add
three.js + TSL as new deps, hand-port composeHeight's ~2000-line 12-octave fractal/carve/anchor-field
stack from GLSL into TSL compute-node form, wire a parallel WebGPURenderer path alongside the raw-GL
one, build new VS/FS-cost-split profiling instrumentation since gpuTimer is WebGL2-EXT-specific) --
multi-day scope, not a single-session A/B. Not re-litigating anything (this is genuinely the
untried mechanism, not THC/phase1-3 again) -- just recording that "scoped" undersold the actual
lift. A future session attempting this should budget for the port, not expect an afternoon A/B.

## Architecture (GPU one-fractal)
- LIVE height path = **procedural `composeHeight` per-vertex in the VS** (`terrain.glsl`): every vertex
  evaluates fractalTerrainH + carves directly. There is NO baked height pool on the default path.
- THC height pool (OPTIONAL, **default-OFF** behind `window.__thc`): **R32F**, **130-texel tiles**,
  **512 layers** (`THC_BAKE_RES`/`THC_POOL_LAYERS`, `gl-render.js`). An O(1) baked-tile fetch that
  replaces composeHeight when enabled. MEASURED NET-NEGATIVE at the deck (cuts VS but pushes the cost to
  FS, full-frame flat-to-worse — 2026-06-15) so it stays off; keep it as a lever, do not default it on.
  (Any AGENTS history claiming "R16F/1024 live" was aspirational doc-drift, corrected 2026-06-15.)
- Shader precision: **global default `highp float`** (`gl-render.js` hdr = `precision highp float`). The
  earlier mediump-default experiment was REVERTED — any world-scale noise UV (freq up to ~9000) evaluated
  in fp16 scrambled the lattice at close range, and chasing per-site highp islands kept missing sites.
  highp-default kills the whole class in one line; the explicit highp islands left in the shader are now
  redundant-but-harmless. int + sampler2DArray stay highp. fp16 on a planet-scale value collapses geometry.
- Reduced octaves: `fractalTerrainH` 14→12, `vtxDisplace` 9→6, single-octave rock detail; tanh ceiling
  `tanh(x/8000)` gives pointed peaks (CLI `shapeReport allGatesPass`). Distance-gated cheap FS far path.
  Tightened LOD (`planet-orchestrator` splitFactor + near-radius). Dead atlas apparatus deleted.
- The two new FS/VS uniforms `uHeightPoolTexSize` (=tile res) and `uFloatLinearOK` (=half-float-linear
  probe) MUST be set on the main render program (`gl-render.js`) or the height-pool UV math goes to
  `vec2(0)` → NaN displacement.

WITNESS HEADLESS WITHOUT A FRAMED SCREENSHOT: don't judge "flat render" from a close-zoom shot whose
camera you can't aim. Use the DATA diagnostics — `__diag.pxPerPoly()` (on-screen quads/tris rasterized),
`__diag.assertElevLinear()`, `__diag.landWitness()`, and `window.__terrainConfig`/`__tcEvictRate`. Start
`node server.js` (port 8080) yourself if it's down, then drive a fresh headless session to it.

---

## The terrain pipeline in one page (read this before touching terrain)

Earth-scale terrain SDK, WebGL2, served at `http://localhost:8080/` (entry `planet.html`, `server.js`).
GPU one-fractal: no tile producer, no atlas. A finer
LOD is a denser sample of the SAME field. The procedural fractalTerrainH fractal is the ONLY render
path. (The baked-atlas apparatus was REMOVED in prior work — only historical comments remain across
src/; any AGENTS history describing an opt-in atlas / `__toggleAtlas` / `atlas-bake.mjs` is stale
doc-drift, corrected 2026-06-15. Recall "tv8-reliable-visual-witness-method-2026-06-03".)

THE SPOOL `browser` VERB IS A FULL BROWSER, NOT HEADLESS (user correction 2026-06-11): it drives a
locally-profiled Chromium with the REAL GPU + real ANGLE backend (witnessed: ANGLE AMD D3D11 -- the
user's exact stack). The 9222 headless chrome that scripts/verify.mjs targets runs a DIFFERENT
backend, so a look defect can pass every verify.mjs witness and still be broken on the user's
screen; any look/material/normal judgment MUST be confirmed on the spool browser verb (or the
user's warm tab via /cmd). Never write a note calling the spool browser tool headless.

LIVE WITNESS VIA SERVER: the cold shader compile (~110s on source change, ~150s on d3d11/FXC)
makes fresh sessions slow, so witness the warm tab through the server when possible. `server.js`
hosts `POST /diag` (per-frame
render state, ringed) read via `GET /diag/tail`, and a `POST /cmd {js}` command channel the page polls
and runs live (result to `/diag`, kind:`cmd-result`). Drive `window.__toggleAtlas`, `window.__diag`
probes, and `window.__diag.reloadShaders()` hot-reload through `/cmd` — no page reload. Recall
"tv8-diag-sink-rehosted-2026-06-07".

Data flow, each stage names its one file:
1. QUADTREE picks which cube-sphere patches to draw per camera altitude — `src/quadtree.js`
   (cube-sphere quadtree in JS), driven per frame by
   `src/planet-orchestrator.js`.
2. MESH per patch is a GRID+2 grid (`src/gl-render.js`) whose outer ring is a SKIRT (terrain.glsl
   drops `vertex.z>0.5` verts radially below the surface) hiding LOD T-junction cracks. The outer
   ring is LOAD-BEARING — do not "just not draw it".
3. HEIGHT assembled per-vertex in the VS (`src/shaders/terrain.glsl`): `h = cbias + bShape +
   vDisp(land) + lake/river/canyon carves`. `bShape = fractalTerrainH(worldDir,reliefMul,ridgeMul)` =
   THE shape (one continuous 14-oct world-dir fBm, LOD-invariant by construction). `cbias` = anchor
   continental swell (`src/anchor-field.js`); `vDisp` = LOD-invariant micro-relief; carves via
   `inciseRidgeField`. Collision = a GPU `_PROBE_` variant of the SAME shader (1px readback,
   `gl-render.sampleGroundM`), no CPU mirror. — full design: recall "TV8 GPU-TERRAIN ARCHITECTURE
   DECISION" in rs-learn.
4. DEFORM: direct per-vertex sphere projection — `vWorld = dir0 * (R + h)`
   corner-blend deform; round at any tessellation, no flat patches at high GRID).
5. FS shades from height+slope+climate (`terrainAlbedoClimate`) + per-vertex seamless normal +
   ocean/lake/river. No FS detail TEXTURE (a tiled image would moire + UV-scroll); closeup MACRO
   relief comes from the mesh subdividing into a denser sample of the one VS fractal. The FS DOES
   carry a procedural cliff DETAIL-NORMAL (biplanar + 2-scale RNM rock bump, world-anchored so it
   never reseeds on camera move) on steep faces only, plus object-space slope/gorge AO and inline
   analytic single-scatter AERIAL PERSPECTIVE (distance-gated space->ground depth cue). Unified
   FS shading model: recall "tv8-fs-shading-bundle-shipped-2026-06-05" + "tv8-shading-unification-decision-2026-06-05".
   CLOSE-UP ROCK ENGAGEMENT (2026-06-05b, workflow w5gywvug1): all rock/cliff/strata/detail-normal
   gates now key off `rockSlope` = clamp(1-dot(ngGeo,uz), slope, 1) where ngGeo = the RAW geometric
   normal cross(dFdx,dFdy) hoisted BEFORE the lit-normal compression (the macro `slope` caps ~0.6 on
   vertical faces -> rock gates never fired at the deck = lit clay). The biplanar bump is promoted to a
   material+AO signal (microSlope/microCurv from existing taps), all pxWorld/nearFade-faded so orbit is
   identical. ZERO VS octaves added (VS is 96%-bound; the VS derivative-fBm was rejected). recall
   "tv8-closeup-rock-engagement-2026-06-05". The deck VISUAL is the user's-eye gate (driven browser
   can't render the deck: low-alt tile-fetch returns black).

DETAIL-ON-APPROACH: relief must grow (or hold), never drop, as you descend — guaranteed by
construction (finer LOD = denser sample of the one field). The lit-luma metric is near-blind to
relief at nadir; judge closeup BY EYE (screenshot) at an oblique pose.

RUNTIME FPS is VERTEX-SHADER-bound (96% VS+raster at the deck, FS is a dead lever): measure with the
headed-browser `window.__diag.gpuTimer` (EXT_disjoint_timer_query_webgl2 + a `uFsCheap` FS short-circuit).
Levers shipped: `broadShapeFD` reduced-octave FD, GRID 24->16, and the low-alt `altSplitMul` PEAK 2.0->1.4
(removes a sub-pixel over-tessellation tail; 1.68x at 6km). BEFORE trusting gpuTimer, read `__pageErr` and
confirm `dbg.quads()>0` — a frozen `__altM`+0-quads+overlay-up is a CRASHED render loop, not a slow one.
Full numbers, the live `__splitFactor` sweep method, the crash class, and gotchas in recall
"tv8-fps-splitfactor-peak-cut-2026-06-04b". Workflow `.claude/workflows/fps-perf.js`.

## Headless shader verification (USE scripts/verify.mjs)

The render/lint/watch CLI toolchain and src/lab (terrain-lab mirrors, glslang lint) were DELETED
2026-06-12 (user: "get rid of the lab and glslang"). The single headless verification surface is
`node scripts/verify.mjs [probeName|expr]` (raw CDP against the live planet.html -- see the
PERMANENT VERIFY POLICY at the top): shader compile errors surface as orch 'error'/ready-timeout
on the real two-stage compile, and the in-page `__diag` probes assert behavior. The lab's LOD
knot solver pattern (node bisection over the real quadtree) lives in recall
"tv8-separate-water-surface-2026-06-11" if a re-solve is ever needed -- rebuild it inline, do not
resurrect the lab mirror (byte-sync drift was a recurring failure class). NO node-WebGL2 binding
exists on win32 (headless-gl/@kmamal are WebGL1).

## CLI testing lab (scripts/lab.mjs) -- 2026-06-18, NOT the deleted byte-sync mirror

The CLI lab is BACK as `scripts/lab.mjs`, but it is NOT the old src/lab terrain-lab mirror (that
byte-sync-drift class stays dead). It composes the REAL surfaces, no parallel reimplementation:
- HEIGHT GRAPH = CPU via src/height-cpu.js (transpiled from terrain.glsl by gen-height.mjs), pure
  node, no GPU: `node scripts/lab.mjs heightmap [--res N] [--center lat,lon] [--span deg]
  [--radius m] [--hillshade] [--out f.png]` -> grayscale PNG (no-dep, node zlib) + min/max/relief/
  landFrac stats. `npm run lab:heightmap`.
- GLSL build/validate = headless Chromium with --use-angle=swiftshader (GPU-free software WebGL2,
  self-launches chrome + the dev server, tears both down): `glsl-check` asserts terrain.glsl COMPILES
  + reports the GL backend; `parity [--n N] [--tol m]` sweeps CPU heightAt vs the GPU _PROBE_
  sampleGroundM (the standing parity gate for shader height edits); `build` = gen-height + glsl-check.
BACKEND CHOICE (user 'pick the best option' 2026-06-18): SwiftShader = portable, CI-able,
deterministic = the default. It CANNOT witness the ANGLE/FXC mis-translation class (a different GLSL
translator) -- for the FXC witness run chrome with --use-angle=d3d11 on a Windows runner (CHROME +
PAGE_URL env overrides). The GPU-free core (heightmap + src/lab.test.js) runs ANYWHERE; the headless
half needs a chrome (auto-detected) + degrades cleanly when absent. Surfaced the coastal scale-
variance finding (scale-coastal-absolute-width: uBeachShelfM absolute width breaks exact 1/100 scale).

## The efficient terrain-debug loop (USE THIS, never restart-and-eyeball)

Debug LIVE in the browser through `window.__diag` / `window.__dbg`, NOT by restarting the server
and guessing from screenshots. One `page.evaluate` dispatch reads the actual runtime state.

1. Serve: `PORT=8081 node server.js`. Drive the page with the spool `browser` verb (Playwriter
   script in `.gm/exec-spool/in/browser/N.txt`; raw JS, `page` global). Reuse ONE persistent
   session — do NOT re-navigate per probe (~10 navs crashes chrome).
2. Gate: a shader compile fail leaves `window.__diag` undefined / `window.__pageErr` set and the
   page LOOKS like a slow load. Check `hasDiag` + `pageErr` in one dispatch before measuring.
3. Park: `await __diag.parkOblique(altKm, aimFrac)` / `parkAt(rung)` — deterministic, reproducible
   viewpoints (eyeballed positions made comparisons noisy).
4. Measure: numeric probes return a metric + pass/coverage: `_read()` (pixel buffer), relief/
   albedo SD, `limbScan`, `seamProbe`, `speckleProbe`, the `__lastGLQuads` leaf set + quad counts,
   `glError`. Keep probes light — many frames + several parkOblique in one dispatch can exceed the
   ~14s browser timeout; split into multiple dispatches.
   **LIVE-TAB CAMERA CONTENTION (load-bearing):** the witness browser is CDP-attached to the USER's
   live tab whose rAF loop overwrites `__planet.cam.pos`, so scripted poses are reverted — `__lastGLQuads`/
   center-pixel/`page.screenshot()` read the user's contested camera, NOT yours. Pose-independent (reliable):
   `reloadShaders`, `pageErr`-null-after-load (compile witness), `seamProbe`, `sampleGroundM`/`hpf.sampleDir`
   scans, split-math trace. **LOD/SHAPE validation = the HEADLESS LAB** (`cd src/lab && node terrain-lab.mjs`;
   mirror is STALE-prone, sync on shader massif/peak/ceiling edits). If the `browser` verb returns "could
   not allocate free port" mid-session (resource accumulation), the fix is a FULL plugkit node-tree
   kill+reboot (kill every `*plugkit*`/`*supervisor*`/`*relay*` node proc — spare server.js + the user's
   Chrome/other projects — then `bun x gm-plugkit@latest spool &`); killing only the relay/duplicates does
   NOT recover it. — recall "TV8 witness contention lod traces correct" + "TV8 wasm renamed to src and
   spooler restart recovery 2026-06-02".
5. Tune live, NO rebuild: `window.__gen` shader globals; `window.__displayMode` debug views —
   recall "TV8 live-debug display modes" in rs-learn for the full mode list.
6. Re-measure. Repeat. The whole loop is browser-side; the server stays up.

SDK-SIDE DEFAULTS = SINGLE SOURCE OF TRUTH (`src/terrain-defaults.js`, 2026-06-18): EVERY terrain
look/shape/lod/biome/ocean default lives in `TERRAIN_DEFAULTS` (+ `SHAPE_UNIFORM_DEFAULTS` for the
CPU mirror). gl-render's `g()/_g()/o3()/C()` fallbacks, planet-orchestrator's `splitFactor` default
(+ the altitude ramp now OPT-IN via `opts.altSplitRamp`), and height-cpu's `HEIGHT_UNIFORM_DEFAULTS`
all READ from it -- so a BARE SDK consumer renders the calibrated "blessed" look with no setup. The
demo (`planet.html` / `tweak-panel.js` / `terrain-gen-controls.js`) is a PURE CONSUMER: it no longer
force-sets any `window.__` global on boot (the old `applyBaked()` force-set + `__gen.apply()` boot
call + `__splitFactor=0.28` pin are gone) and just provides LIVE overlays that write a global ONLY
when a control moves. Edit a default in `terrain-defaults.js`, never per-call-site. When you change a
SHAPE default re-bake the `height-cpu.test.js` golden (`npm test`) -- the CPU + GPU read the same TD.
(RESOLVED: the old "gen-controls OVERRIDES gl-render defaults at boot" trap no longer exists -- panels
do not apply at boot. JS-cache trap still applies: force fresh via CDP `Network.setCacheDisabled`
before `page.goto` and verify with `gl.getUniform(orch.render.prog, name)`.)

CLIENT-EDIT WITNESS: any edit to `terrain.glsl` / `*.js` / `planet.html` must be witnessed in the
SAME turn via a `browser` dispatch asserting the invariant (compile clean + glError 0 + the metric
the edit targets). Port-exhausted browser → contention-free headless fallbacks (lab for LOD/shape;
NODE MODULE PROFILE for JS hot loops, how bakeHpf 4027ms→1137ms was found) — recall "TV8 node module
profile bakehpf bottleneck 2026-06-02" + "TV8 patches view loadtime distribution 2026-06-02c".

## RECURRING CLASS: "rocks everywhere + normals gone + height-keyed shading" -- THE SOLUTION (user order 2026-06-12)

PRIMARY ROOT = ANGLE D3D11/FXC MIS-TRANSLATION OF THE UNROLLED FRACTAL (default Chrome on Windows
= d3d11 backend = FXC). Proven by backend split on the SAME AMD GPU: vulkan renders correctly,
d3d11 renders the triad (blotchy rocks on flat ground + relief normals gone + shading reads as
height); the GPU/driver is innocent. FXC fully unrolls constant-bound loops and reorders math
across the unrolled 12-octave fractalTerrainH body. THE FIX (THE SOLUTION, do not regress it):
fractalTerrainH's octave loop is RUNTIME-BOUNDED -- `uniform int uOctMax` (set 12 by
gl-render setComposeHeightUniforms; shader guards <=0 -> 12) so FXC CANNOT unroll. Side proof the
de-unroll engages: d3d11 cold shaderCompileMs 152379 -> 63259. If this triad ever returns on
default Chrome/AMD: check the loop is still runtime-bounded FIRST. Never reintroduce a constant
12 bound; if a new VS fractal loop is added, give it the same runtime bound.

SECONDARY (real but transient/exotic) modes with the same look, check in this order via /diag tail:
(a) `swgl`/`ctxLostAt` non-null = software-WebGL after a GPU-process crash -> restart the BROWSER;
(b) `bakePending` non-zero = unbaked/zero-HPF window (keep whole-planet bake <1s, ee7d72e).
Rock gates themselves are SLOPE-ONLY by design (terrain.glsl macro ~1093-1100, splat ~1574;
height-band rock REMOVED 2026-06-03) -- rock on flat ground means broken INPUTS, never the gates.

## FXC (ANGLE d3d11 / default Chrome on Windows) -- THE SOLUTION RECORD (user order, 2026-06-12)

The recurring "rocks everywhere + normals gone + dark daylit ground, AMD/default-Chrome only" class
is FXC SHADER MIS-TRANSLATION, never the GPU/driver (vulkan on the same AMD silicon renders
correctly). Two proven mechanisms + their fixes (commits f062365 + d56a202):
1. CONSTANT-BOUND LOOPS get fully unrolled + cross-iteration reordered -> `uniform int uOctMax`
   runtime-bounds the fractalTerrainH octave loop (side effect: cold compile 152s -> 63s).
2. PER-CALLSITE INLINING: composeHeight inlined at separate call sites gets optimized DIFFERENTLY
   per copy -- the lit-normal FD taps then disagree by tens of metres on FLAT ground (fake slope ->
   rock material + slope-AO dark + dead normals, in patches). Fix: ALL FD taps evaluate through ONE
   runtime-bounded loop (fdIters keyed on uNrmStepM) = a single instance, errors cancel exactly.
RULES: never reintroduce a constant bound on a VS fractal loop; never difference composeHeight (or
any big field fn) across separate call sites -- route every tap through the single-instance loop.
DIAGNOSIS ORDER for the symptom triad: (1) loop-bound/call-site regression, (2) HUD/diag `SWGL!`/
`CTXLOST!` (software fallback after a GPU crash -- restart the BROWSER), (3) `bake:` pending
(zero-HPF window). COMPILE COST CORRECTED (2026-06-12, user caught it): the earlier ">40min cold
compile" reading was machine-HIBERNATION wall-clock contamination; a clean-profile awake measure
(shader disk cache disabled, real AMD d3d11) shows shaderCompileMs 31455 -- the single-instance-loop
shape compiles ~31s cold, 5x FASTER than the original 152s unrolled shape, cached ~250ms after.
No cheapening needed. Timing rule: never trust wall-clock perf numbers across a sleep/hibernate;
re-measure awake with the in-page shaderCompileMs.
Memory keys: tv8-fxc-percallsite-divergence-TRUE-ROOT-2026-06-12, tv8-fxc-unroll-amd-root-SOLUTION-2026-06-12.

## DEBUGGING PLAYBOOK (2026-06-12, distilled from the day the FXC hunt cost)

- BACKEND SPLIT FIRST for any "looks wrong on X's machine" report: `node scripts/backend-ab.mjs`
  launches d3d11 + vulkan side-by-side at the same pose and prints a divergence verdict.
- USER-FLOWN EVIDENCE: open a CDP-driven window (`.gm/drive.mjs` pattern), let the USER fly it to
  the defect, then dissect THAT frame -- their eyes pick the evidence, probes name the term.
- ONE-CALL CARRIER FINDER: `__diag.bisect()` A/Bs splat/texNormals/warp/litNormal/slopeRock at the
  current pose and returns per-toggle pixel-diff fractions; `__diag.groundTruth()` gives probe
  h+slope under the camera. WIREFRAME checkbox = the geometry-truth tiebreaker (flat mesh under a
  "rocky" render = the shading path is the liar).
- CLOSE EVERY OTHER PLANET WINDOW before judging look/fps on the iGPU: leaked pages render at full
  rAF, crush the GPU, steal /cmd commands, and pollute every measurement (witnessed repeatedly).
- HUD tail now shows `vendor/backend`, `SWGL!`, `CTXLOST!`, `bake:N`, and `DBGVIEW <state>` when a
  debug displayMode is requested but its program is still compiling or failed -- a debug view can
  no longer silently fall back to the lit render.
- BACKGROUNDED TABS throttle rAF to ~1/min: the compile poll now falls back to setTimeout when
  `document.hidden`, but remember the mechanism -- a hidden tab that seems "stuck at init" may just
  be starved, foreground it.

## Hard-won invariants

ONE FRACTAL PER CARVE (user hard rule): every carve = ONE world-dir field fn called in BOTH the VS
geometry carve AND any FS mask at `normalize(worldPos)`; never a divergent FS inline loop — recall
"TV8 one fractal per carve invariant 2026-06-02".

FP32 PRECISION + GRAZING-AA + per-pixel-moire + SHARED-PREAMBLE (snoise3/carves/fractalTerrainH must be
outside `#ifdef _VERTEX_` so the FS + `_PROBE_` program link) — recall "TV8 glsl fp32 grazing moire
invariants 2026-06-02".

LOD must INCREASE detail monotonically on descent + the LOD CENTER tracks the camera (worldToFaceLocal
applies the atan inverse of faceWarp; witness with `window.__diag.lodCenterProbe()` -> tracksCamera
<0.5deg). Far-LOD falloff coarsens only beyond the horizon; cull ON by default (screen-AABB). Debug
displayModes 0-12 (6 elevation, 10 canyon, 11 cliffs, 12 patches/LOD) — recall "TV8 lod monotone
descent cull debugviews 2026-06-02".

CLIFFS/CANYONS/STRATA/CLIFF-LIGHTING (terrain.glsl mesa cliffTerraceM coherent-rim redesign + FS
strata + RNB normal + slope-AO; levers `__canyonDepth __cliffAmt __strataM __cliffStrata __aoAmt
__macroNrm __biomeBandBias`; realism WIP, user visual is the gate) — recall "TV8 cliffs canyons
strata levers 2026-06-02".

LIGHTING / "FLAT GREEN" ROOT (recurring complaint): the "terrain reads flat green / normals not
affecting lit" was NOT the normal pipeline (A/B fsNormal proven, normalDiff 36-38 on gentle AND steep
land). It was the DEFAULT SUN sitting high (near-overhead) -> minimal slope self-shading on gentle
rolling terrain (correct for noon, but reads flat). FIX (planet.html cam.sunLatBase 0.6->0.35, commit
333f3ba): a lower default sun = longer shadows -> even gentle hills self-shade -> default view reads
3D. When judging relief, use an OBLIQUE sun + frame ACTUAL LAND (a sea-level dir at 45deg oblique from
+5km frames mostly ocean — verify the screenshot is land, not water). fsNormal default stays 0 (gated
to steep faces, no-op on gentle land; gentle relief is carried by pvNormal, default on).

VERTICAL ROCKFACE MATERIAL (user hard rule; distinct dark cool-grey cliffRock gated on verticality,
slope gates calibrated to the 0.3-0.6 SMOOTHED-normal band not ~1.0, witness by image, warm-cast caveat) —
recall "tv8-vertical-rockface-material-calibration".

ROCK DETAIL-NORMAL = JUMP-FREE (biplanar pow-softmax weight, never a dominant-plane pick or fwidth fade
= both JUMP on move; keep FS snoise3 taps down; cold-compile fix is CACHE PERSISTENCE not source-trim,
181s one-time/machine) — recall "tv8-rock-detail-normal-triplanar-jumpfree" + "tv8-closeup-rock-engagement-2026-06-05".
Workflow `/startup-perf`.

## HPF adaptive quadtree (anchor-field.js)

Per-band adaptive quadtrees (additive detail-hat overlay) + the BAKED-vs-FULL-BAND elevAmp gotcha —
recall "TV8 hpf adaptive quadtree anchor field 2026-06-02".

@.gm/next-step.md
