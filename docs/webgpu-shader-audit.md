# WebGPU renderer: TSL-vs-raw-GLSL shader-compatibility audit

Status: audit-only pass, first slice of `webgpurenderer-shader-compatibility-audit-tsl-glsl`.
No source behavior changed by this pass -- `?webgpu=1` stays exactly as risky as it was
(experimental, off by default, documented in `RenderControls.js`'s `?webgpu=1` catalog entry).
This document is the "which shaders are TSL-portable vs need a WGSL rewrite vs can defer to a
WebGL2 fallback island" triage the PRD row asked for, produced by reading every real call site
listed in the row's own detail plus everything the same codesearch pattern (`onBeforeCompile`,
`ShaderChunk`, `new THREE.ShaderMaterial`, `WebGLRenderTarget`, `renderer.getContext()`, raw
`gl.*` calls) turned up across `client/core`, `packages/mapspinner`, `packages/streaming-gltf`.

## Why this matters (recap)

`THREE.WebGPURenderer` does not compile raw GLSL. `onBeforeCompile`/`ShaderChunk` string-surgery
-- the mechanism nearly every custom-shader effect in this codebase uses -- has no meaning for a
WebGPU material; those materials need a TSL (`three/tsl`) node graph or a hand-written WGSL
module talking to `renderer.backend` directly. A `WebGLRenderTarget` is also WebGL-specific (the
generic type is `THREE.RenderTarget`, which both backends accept -- `WebGLRenderTarget` extends
it but the reverse isn't given). `renderer.getContext()` returns a real `WebGL2RenderingContext`
only under `WebGLRenderer`; under `WebGPURenderer` there is no GL context to hand back, so any
caller that does raw `gl.createShader`/`gl.drawArrays`/etc. against it throws or silently no-ops
depending on what `getContext()` actually returns for that backend (unverified at audit time --
see Open question at the end).

## Method

Real codesearch across the three named surfaces, cross-referenced against each file's own header
comment (most of these components already document *why* they patch ShaderChunk / hand-roll GLSL,
which is exactly the information needed to judge portability). No renderer was booted under
`?webgpu=1` for this pass -- see "What this audit did NOT do" -- so every verdict below is a
static-source classification, not yet a live pass/fail witness against a real WebGPU device.

## Findings: raw-GLSL-patch surface (client/core)

17 files patch `THREE.ShaderChunk` globally, or hand-roll a `ShaderMaterial`/`onBeforeCompile`
customization, and would need a TSL/WGSL equivalent (or an explicit "no-op under WebGPU" fallback)
before `?webgpu=1` renders these effects correctly:

| File | Mechanism | What it does | Triage |
|---|---|---|---|
| `UnderwaterTint.js` | Global `ShaderChunk.fog_*` patch (string append) | Tints submerged fragments blue | **Needs TSL rewrite.** Global chunk patch has no WebGPU-material equivalent; the effect (camera-gated per-fragment world-Y tint) is a small, well-isolated TSL `Fn()` -- straightforward port, no architecture change needed. |
| `WetnessTint.js` | Global `ShaderChunk.fog_*` + `lights_fragment_begin` patch | Rain/weather wetness darkening + specular boost | **Needs TSL rewrite.** Same shape as UnderwaterTint; touches `lights_fragment_begin` too (see CascadeShadowSelect note below about function-declaration-site ordering -- a TSL port sidesteps that whole class of hazard since TSL never does raw string splicing). |
| `CascadeShadowSelect.js` | Global `ShaderChunk.shadowmap_pars_fragment` + `lights_fragment_begin` patch | Per-fragment CSM cascade selection | **Needs TSL rewrite, non-trivial.** This file's own header documents two real GLSL-string-surgery footguns it hit and fixed (nested-function-declaration illegal-GLSL, and `UNROLLED_LOOP_INDEX` vs loop-variable `i` scope). A TSL port removes the whole footgun class (TSL is a real node graph, not string concat) but needs TSL's own light-loop/shadow-node API, which is a materially different mental model -- budget real implementation time, not a mechanical find-replace. |
| `Grass.js` | Hand-written `ShaderMaterial` (Lambert-ish, wind-animated, InstancedMesh2) | Grass blade rendering | **Needs WGSL/TSL rewrite.** Hand-written vertex+fragment GLSL strings from scratch (not a ShaderChunk patch) -- straightforward to port to TSL's `Fn()` node graph since it's a self-contained material, but every custom uniform (wind time, per-instance data via InstancedMesh2) needs its TSL-node equivalent verified against InstancedMesh2's WebGPU compatibility (see InstancedMesh2 note below -- this is the one likely to be the actual blocker, not the shader math itself). |
| `SSAO.js` | 3 hand-written `ShaderMaterial`s (gbuffer/AO/composite) + `WebGLRenderTarget` | Half-res SSAO post-process | **Needs TSL rewrite + RenderTarget swap.** Full-screen passes are TSL's easiest case (no per-instance complexity); `WebGLRenderTarget` -> generic `RenderTarget` is a one-line type swap once the materials are ported (RenderTarget is already the WebGPU-safe base class). |
| `Bloom.js` | Full-screen shader passes, canvas read-back | Half-res bloom | **Needs TSL rewrite.** Same full-screen-pass shape as SSAO; explicitly reads back the *already-composited canvas* (mapspinner terrain + THREE together) as its input, which is a WebGL-canvas-specific read pattern (see mapspinner section) -- this is the one bloom-specific wrinkle, not the blur/threshold math itself. |
| `SSR.js` | Raymarch `ShaderMaterial`, reads 2 G-buffers (depth/normal + wetness) | Screen-space reflections | **Needs TSL rewrite, medium effort.** Raymarching is expressible in TSL (loops/branches are supported), but this is the most math-heavy of the full-screen passes -- more surface for a subtle port bug than Bloom/SSAO. |
| `FSR1.js` | Full-screen upscale shader | Spatial upscale pass | **Needs TSL rewrite.** Same full-screen-pass shape as SSAO/Bloom. |
| `ThreeVdrs.js` | `WebGLRenderTarget`-based variable-resolution decouple | THREE-scene VDRS (render small, present full) | **RenderTarget swap tractable; the DEEPER coupling is the shared-canvas-depth contract** (see next section) -- this file's own header says the reason it exists at all is to avoid breaking that depth-sharing invariant, which is itself WebGL-canvas-specific. |
| `PlayerVAT.js` | `onBeforeCompile` (MeshLambertMaterial, vertex-displace from a VAT DataTexture) | Vertex-animation-texture player LOD tier | **Needs TSL rewrite.** Texel-fetch + position-displace in `onBeforeCompile` is exactly TSL's `positionLocal.assign(...)` node pattern -- one of the more mechanical ports on this list. |
| `PlayerLOD.js` | `onBeforeCompile` (GPU skinning chunk) | Distance-tiered player LOD | **Needs TSL rewrite**, coupled to whatever skinning approach TSL's own `SkinningNode` expects -- verify against THREE's stock TSL skinning material before assuming a 1:1 port of the hand-rolled chunk. |
| `Rocks.js` | `onBeforeCompile` | Rock material customization (referenced by grep; not read in full this pass) | **Needs TSL rewrite** -- not deep-audited this pass, flagged for the follow-up implementation row. |
| `Vegetation.js` | `onBeforeCompile` (wind displacement, shared with tree trunk/branch) | Tree/vegetation wind animation | **Needs TSL rewrite. HIGH RISK -- this is the exact subsystem the tree-flicker investigation (AGENTS.md `tree-flicker-root-cause-2026-07-11`) spent 5+ sessions root-causing.** Any WebGPU port of this material must be validated against that investigation's proven metric (motion-big-change pixel-delta, never the banned center-stripe metric) before shipping -- a naive TSL re-implementation could silently reintroduce a fixed, hard-won bug. |
| `SceneSetup.js` | `ShaderChunk` touch point (setup/coordination, not itself a custom material) | Scene bootstrap | Coordinator only -- no direct port needed, but is the file that will need the `?webgpu=1` branch's material-selection logic once real TSL materials exist. |
| `ShadowPipeline.js` | Coordinates `sun.shadow.camera` (ortho), texel-snap math (pure JS/THREE.Vector3, no shader) | Shadow-map follow + texel-snap + cascade management | **No shader code itself** -- this file's own header (recapped in AGENTS.md) documents it as the single owner of shadow-camera JS-side math, which is renderer-agnostic (`THREE.DirectionalLight.shadow` is a real cross-backend THREE concept). The risk here is NOT this file's own code; it's whether `WebGPURenderer`'s shadow-map implementation honors `shadow.autoUpdate`/`shadow.needsUpdate` with the same per-light semantics `WebGLShadowMap.js` gives (this file's own comments cite exact `WebGLShadowMap.js` line numbers as the mechanism it depends on) -- **needs a live capability check against `WebGPURenderer`'s shadow-map implementation**, not a shader port. |
| `RenderGraph.js` | No shader/GL code (confirmed via codesearch: zero `gl.*`/`getContext`/`ShaderChunk`/`onBeforeCompile` hits) | Frame orchestrator (per-node `renderer.render()` calls, timing, watchdogs) | **No port needed for the orchestrator itself.** `renderer.render(scene, camera)` is the one call every node makes and it's the same call signature on both backends. The real open question is whether `WebGPURenderer`'s command submission is genuinely synchronous-enough from the CALLER's perspective for this graph's per-node `duration_ms` timing/watchdog logic to stay meaningful (WebGPU's `render()` still submits synchronously from JS's point of view -- the GPU-side work is what's async -- so this is very likely fine, but not yet live-verified here). |

## Findings: `renderer.getContext()` / raw-GL direct callers

- **`TerrainBackdrop.js:30`** -- `const gl = renderer.getContext()`, passed straight into
  `createTerrainOcclusion(gl, ...)` (client) and into mapspinner's `initMapspinnerPlanet` (via the
  dynamic `mapspinner/planet-orchestrator` import). This is the single load-bearing call site that
  makes the ENTIRE planet/terrain/water backdrop WebGL2-only today.
- **`client/core/TerrainOcclusion.js`** -- writes raw `#version 300 es` GLSL source via
  `gl.createShader`/`gl.shaderSource`/`gl.compileShader` (occlusion box-query shader) directly
  against the context `TerrainBackdrop.js` handed it. **Correctly fail-open already** (verified by
  reading the actual call chain, not just grepping for the guard's existence): line 19 computes
  `isWebGL2 = gl instanceof WebGL2RenderingContext` at construction, `supported()` exposes it, and
  `runQueries()` (line 109-111) checks `if (!isWebGL2 || !viewProjRel) return` as its FIRST
  statement, before `_ensureBoxGeometry()` (the function that actually calls `gl.createShader`) is
  ever reached -- so under `?webgpu=1`, where `renderer.getContext()` would not return a real
  `WebGL2RenderingContext`, this module correctly no-ops instead of throwing. Same pattern as
  `occlusion-query-tier.js` below, just implemented independently (host-side, no THREE dependency,
  per this file's own header comment). Initial read of this file mistakenly flagged it as an
  unguarded gap; corrected after tracing the actual call order.
- **`packages/mapspinner/src/gl-render.js`** -- 389 raw `gl.*` call-site occurrences (draw, bind,
  create, compile, link, uniform, tex, framebuffer). This is the terrain/water/sky compositor;
  it is a from-scratch raw-WebGL2 renderer, not a THREE material at all. **Porting this to WebGPU
  is not a shader-node-graph swap -- it is a full second rendering backend for mapspinner**, out of
  scope for anything smaller than its own dedicated epic.
- **`packages/mapspinner/src/planet-orchestrator.js`** -- 12 more raw `gl.*` calls, the frame
  driver that calls into `gl-render.js`.
- **`packages/mapspinner/src/patch-baker.js` / `index.js`** -- also flagged by the same grep
  pattern; not deep-read this pass (heightfield/patch generation, likely CPU-side or one-time GPU
  bake rather than per-frame, but unverified -- follow-up row should confirm before assuming safe).

## Findings: `packages/streaming-gltf` (cluster-LOD / impostor pipeline)

- **`cluster-lod-mesh.js`** -- **already renderer-agnostic, no port needed.** Per this package's
  own `AGENTS.md` (`cluster-onbeforerender-custom-draw-bind-timing`), it deliberately does NOT do
  a raw multi-draw call; it sets `geometry.groups` and lets THREE's *normal* pipeline issue the
  `drawElements` calls per group. That pipeline is the same code path under both backends -- this
  is real, already-shipped precedent that a THREE-idiomatic (not raw-GL) implementation survives a
  backend swap for free.
- **`occlusion-query-tier.js`** -- WebGL2-only (`gl.createQuery`/`beginQuery`/`endQuery` with
  `ANY_SAMPLES_PASSED_CONSERVATIVE`, this file's own header says so explicitly: "no compute
  shaders"). **Confirmed correctly fail-open** by tracing the real call chain, not just the guard's
  existence: constructor sets `this.isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' &&
  this.gl instanceof WebGL2RenderingContext` from `this.gl = renderer.getContext()`, and
  `runQueries(camera, candidates)` -- the ONLY public entry point that reaches
  `_ensureBoxGeometry()`/any raw `gl.*` call -- checks `if (!this.isWebGL2 || !candidates.length)
  return;` as its first statement, before touching `this.gl` at all. Same verified-safe shape as
  `TerrainOcclusion.js` above; both occlusion-query implementations independently arrived at
  "check the flag first, inside the one function that owns every GL call" rather than scattering
  the check per call site, which is why tracing the single entry point was sufficient to confirm
  full coverage without needing a live device for this specific claim.
- **`webgpu-hiz-tier.js`** -- **already a real, shipped, WebGPU-native (raw WGSL) implementation.**
  This is direct, valuable precedent for the audit's own question ("TSL-portable vs needs a
  from-scratch WGSL rewrite"): its own header explains why it chose raw WGSL over TSL --
  `renderer.backend.device.createShaderModule`/`createComputePipeline` for a compute pass with no
  per-material variance, where "TSL's node-graph machinery buys nothing ... and would obscure the
  exact buffer-layout contract." `supported()` returns `false` (safe no-op) on any renderer that
  isn't a real initialized `WebGPURenderer`, mirrored by `hzb-tier.js`'s WebGL2 fail-open contract
  -- this pairing (`hzb-tier.js` for WebGL2, `webgpu-hiz-tier.js` for WebGPU, same algorithm, two
  backend-native implementations, not one shared abstraction) is a **precedent worth reusing**: not
  every effect needs a single TSL-portable implementation: compute-shape, per-material-invariant
  passes (culling, HZB reduction) are a legitimate case for a backend-forked raw implementation
  instead of a TSL node graph.
- **`octahedral-impostor-ez.js`** -- `new ShaderMaterial({..., glslVersion: GLSL3, ...})` (impostor
  atlas bake) + a SEPARATE `onBeforeCompile` patch (2nd hit, line ~750) applied to *externally
  supplied* materials (the wrapped model's own material, not one this file owns) -- **needs TSL
  rewrite for the atlas-bake material**, and the `onBeforeCompile`-wraps-an-arbitrary-material
  pattern needs a design decision (does TSL support wrapping an arbitrary caller material the same
  way, or does this need restructuring around TSL's own node-composition model?) -- flagged as
  needing real design work, not a mechanical find-replace, in the follow-up implementation row.
- **`material-pool.js` / `model-pool.js` / `batched-far-tier.js` / `texture-array-atlas.js`** --
  flagged by the same grep pattern (`onBeforeCompile`/`ShaderMaterial` hits); not deep-read this
  pass, follow-up row should audit each.

## What this audit did NOT do (explicitly out of scope for this slice)

- **No live `?webgpu=1` browser witness.** Every verdict above is a static-source read. A real
  next step is booting the flag against a real WebGPU device and confirming each fail-open guard
  (or lack of one) behaves as predicted -- particularly `TerrainOcclusion.js`'s missing guard
  (predicted throw) and `occlusion-query-tier.js`'s `isWebGL2` flag (predicted correct false, but
  downstream enforcement unverified).
- **No actual TSL/WGSL porting.** This is a triage document, exactly as the PRD row's own detail
  text asked for ("audit-only pass first ... before any actual porting starts").
- **`patch-baker.js`/`index.js`/mapspinner's other `gl.*` hits** were flagged by grep but not
  individually read line-by-line -- the verdict "probably fine if one-time/CPU-side" is a guess,
  not a finding, and should not be treated as cleared.
- **`material-pool.js`/`model-pool.js`/`batched-far-tier.js`/`texture-array-atlas.js`** in
  streaming-gltf were flagged but not individually read.

## Recommended per-shader disposition (summary table)

| Disposition | Files |
|---|---|
| **TSL-portable, low risk** (full-screen post-process, no per-instance complexity) | SSAO, Bloom, FSR1, UnderwaterTint |
| **TSL-portable, medium risk** (per-fragment math correctness matters, or touches a historically fragile subsystem) | WetnessTint, SSR, PlayerVAT, PlayerLOD |
| **TSL-portable, HIGH risk (regression-prone, needs the tree-flicker proven metric before shipping)** | Vegetation.js wind shader, CascadeShadowSelect.js |
| **Renderer-agnostic already, no port needed** | RenderGraph.js, ShadowPipeline.js (JS-side math only), cluster-lod-mesh.js |
| **Correctly WebGL2-only with a verified, load-bearing fail-open guard** (checked BEFORE any raw-GL call) | TerrainOcclusion.js |
| **Correctly WebGL2-only with an existing but not fully call-chain-verified fail-open guard** | occlusion-query-tier.js (flag computed correctly; downstream per-call-site enforcement not traced this pass) |
| **Legitimate raw-backend-native precedent (not everything needs TSL)** | webgpu-hiz-tier.js (WGSL) paired with hzb-tier.js (WebGL2) |
| **Full second-backend-implementation scope, not a shader port** | packages/mapspinner/src/gl-render.js + planet-orchestrator.js (401 combined raw-GL call sites) -- this is the load-bearing blocker for the ENTIRE terrain/water/sky backdrop rendering anything at all under `?webgpu=1`; TerrainBackdrop.js:30's `renderer.getContext()` call is the exact chokepoint. |
| **`WebGLRenderTarget` -> `RenderTarget` mechanical swap** (once the paired material is ported) | SSAO, ThreeVdrs, VegImpostorTier, Vegetation, Bloom, FSR1, SSR |

## Bottom line

`?webgpu=1` cannot render the planet/terrain/water backdrop at all today -- not a shader-quality
issue but a hard architectural one: `TerrainBackdrop.js`'s single `renderer.getContext()` call
feeds a 400+-call-site raw-WebGL2 renderer (`packages/mapspinner`) that has no WebGPU counterpart
and would need its own from-scratch WGSL/compute port, an effort on the scale of `gl-render.js`
itself, not a shader triage. Every `client/core` post-process/material effect is portable to TSL
with varying effort (full-screen passes are the cheapest; `Vegetation.js`'s wind shader and
`CascadeShadowSelect.js` carry real regression risk given their fix histories). Both raw-WebGL2
occlusion-query implementations (`TerrainOcclusion.js` and streaming-gltf's `occlusion-query-tier.js`)
were traced end to end and confirmed already correctly fail-open under a non-WebGL2 context --
no correctness gap found there, better news than this audit initially (mis-)read on a first pass
of `TerrainOcclusion.js`. The real, unresolved gap is architectural, not a missing guard:
`TerrainBackdrop.js`'s `renderer.getContext()` call feeds mapspinner's from-scratch raw-WebGL2
renderer, which has no WebGPU counterpart at all and would need its own dedicated port effort.

See `.gm/prd.yml` for the decomposed follow-up rows this audit filed.
