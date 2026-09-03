// ShadowCostProbe -- MEASUREMENT ONLY, first slice of the static-shadow-map-caching epic
// (see AGENTS.md tree-flicker-root-cause-2026-07-11 + .gm/prd.yml
// static-shadow-map-caching-in-shadowpipeline). Answers the real prerequisite question before any
// caching split is attempted: how much of a frame's shadow-pass cost is attributable to STATIC
// (non-moving) shadow casters vs DYNAMIC (player/dynamic-body) ones, on a real running scene.
//
// DOES NOT TOUCH ShadowPipeline.js. No texel-snap/heartbeat/cadence change of any kind -- this is a
// read-only observer bolted onto the existing renderer.shadowMap.render function and the existing
// per-frame renderer.info.render counters. Default OFF (RenderControls 'shadowCostProbeArm' knob);
// zero behavioral difference when off, and the always-on classification tagging (userData
// .isDynamicShadowCaster, stamped once per mesh at creation in EntityLoader.js/PlayerManager.js) costs
// nothing at render time either -- it's read only when the probe is armed.
//
// TWO MEASUREMENT MODES, both real (no synthetic/mock scene):
//   1. PASS-COST (always cheap, always safe to enable): wraps renderer.shadowMap.render once at
//      install time (a single non-invasive monkeypatch, call-through unchanged) and times the whole
//      shadow pass with performance.now() every frame it actually runs (WebGLShadowMap.render's own
//      internal enabled/autoUpdate/needsUpdate gate means this is a genuine no-op on frames where no
//      shadow re-render happens at all -- matches ShadowPipeline's own "reused unchanged between
//      texel steps" contract exactly, so the probe's own timing already reflects the real re-render
//      cadence rather than fighting it).
//   2. STATIC-VS-DYNAMIC SPLIT (opt-in, bounded, self-restoring): on a real texel-step re-render
//      (the SAME event ShadowPipeline already fires renderer.shadowMap.needsUpdate for -- this probe
//      hooks into that, never invents its own re-render), runs the shadow pass THREE times back to
//      back: once with dynamic casters' castShadow temporarily forced false (static-only cost), once
//      with static casters forced false (dynamic-only cost), once restored to normal (combined,
//      reported for reference, not applied). castShadow flips are the ONLY state touched, restored in a
//      try/finally the same frame, and the split only runs on a frame that was already going to
//      re-render (never forces an extra render), so it adds bounded, opt-in-only cost. Guarded by a
//      cheap in-flight lock so a slow frame can't stack overlapping split measurements. Each masked
//      pass renders EVERY cascade together (installShadowCostProbe is passed the ShadowPipeline handle,
//      not a bare `sun`, so mode 2 sees the real N-light array -- see
//      csm-shadowcostprobe-cascade-blind-measurement; a bare-`sun` caller still works but silently
//      measures cascade 0 only).
//
// window.__shadowCost.stats() -> the live report (now includes cascadeCount); window.__shadowCost
// .arm()/disarm() control mode 2.

let _installed = false
let _renderer = null
let _origShadowRender = null   // the REAL WebGLShadowMap.render, captured once at install time -- every
                                 // measurement pass (mode 1's timing wrapper AND mode 2's masked passes)
                                 // must call THIS, never renderer.shadowMap.render itself (which by
                                 // install time IS this probe's own wrapper) or a masked pass would
                                 // recurse back through the wrapper, double-counting samples and firing
                                 // a nested split attempt on every masked sub-pass.
let _lastPassMs = 0
let _passSamples = []      // ring-ish bounded array of whole-pass ms, mode 1
let _splitResult = null    // { staticMs, dynamicMs, combinedMs, staticObjects, dynamicObjects, ts }
let _splitArmed = false
let _splitInFlight = false
let _splitEveryN = 30      // only attempt a split on every Nth real texel-step re-render (bounded cost)
let _splitCounter = 0

const MAX_SAMPLES = 240

// isDynamicShadowCaster is stamped on the ENTITY ROOT (EntityLoader.js's _tagMesh / model.userData,
// PlayerManager.js's player group) as well as directly on leaf meshes where the loader has a mesh
// handle (EntityLoader's model.traverse loop). A shadow-casting child under a tagged root but without
// its own direct tag (e.g. a nested primitive under a pool-swapped LOD tier) inherits the nearest
// tagged ancestor's classification -- walk up, default to static (untagged == not known-dynamic,
// matching every environmental/vegetation/rock caster that never sets this flag at all).
function _isDynamicCaster(o) {
  let cur = o
  while (cur) {
    if (cur.userData && cur.userData.isDynamicShadowCaster !== undefined) return !!cur.userData.isDynamicShadowCaster
    cur = cur.parent
  }
  return false
}

function _classify(scene) {
  // Real scene walk (not a cached list -- entities stream in/out continuously). Cheap: this only
  // runs when a report is requested or a split is armed, never in the hot per-frame path.
  let staticObjs = [], dynamicObjs = []
  scene.traverse(o => {
    if (!o.isMesh && !o.isInstancedMesh) return
    if (!o.castShadow) return
    if (_isDynamicCaster(o)) dynamicObjs.push(o)
    else staticObjs.push(o)
  })
  return { staticObjs, dynamicObjs }
}

function _setCastShadow(list, value, restore) {
  for (const o of list) { restore.push([o, o.castShadow]); o.castShadow = value }
}

function _restoreCastShadow(restore) {
  for (const [o, v] of restore) o.castShadow = v
}

// Runs one extra shadowMap.render() call with a temporary castShadow mask applied, timed, restored.
// Uses the renderer's OWN shadow map render entry point (not a re-implementation), so it exercises
// the exact real WebGLShadowMap pass (frustum cull, depth material, per-object onBeforeShadow/
// onAfterShadow) -- a genuine live measurement, not an estimate.
// `lights` is the FULL cascade light array (index 0 is `sun`, 1..N-1 are the shadow-only cascade
// lights from ShadowPipeline.lights) -- passing only `sun` would silently exclude cascades 1/2 from
// the timed pass, exactly the csm-shadowcostprobe-cascade-blind-measurement bug this fixes.
//
// COMPANION GPU-WORK PROXY (draw calls + triangles, via renderer.info.render) -- ROOT-CAUSED AND
// FIXED (shadowcostprobe-info-blind-to-shadow-pass-draws). performance.now() around a WebGL call only
// measures CPU-side command-RECORDING time, not GPU raster time, so a masked pass reading near-0ms is
// ambiguous ("genuinely cheap" vs "many draws, just fast to submit") -- the fix diffs
// renderer.info.render.{calls,triangles} (real, already used elsewhere in this codebase:
// client/core/FrameMetrics.js, client/app.js debug stats, RenderGraph.js profiling) immediately around
// each masked pass as an independent, timing-noise-free workload-size number.
// A prior session found the split reporting a flat 0/0/0 combinedCalls/combinedTriangles/combinedMs
// even on the fully-unmasked reference pass and concluded renderer.info was architecturally blind to
// shadow-pass draws in this codebase. LIVE RE-INVESTIGATION DISPROVED that: monkeypatching
// gl.drawElements/gl.drawElementsInstanced directly showed real per-frame ORDINARY shadow passes DO
// draw (952 real gl.drawElements calls captured over one live pan) and renderer.info.render.calls/
// triangles DO update correctly for them (23/200 sampled sm.render invocations showed real non-zero
// deltas, matching ShadowPipeline's own texel-step re-render cadence -- the rest are legitimately
// no-op frames). The actual bug was one level up, specific to THIS probe's masked sub-passes: three's
// WebGLShadowMap.render gates its ENTIRE pass on a SCOPE-level `scope.needsUpdate` flag --
// `if (scope.autoUpdate === false && scope.needsUpdate === false) return` (node_modules/three
// WebGLShadowMap.render, `scope` === renderer.shadowMap) -- which is DISTINCT from any per-light
// `light.shadow.needsUpdate` this function sets. ShadowPipeline.js runs with
// renderer.shadowMap.autoUpdate=false by design (texel-step-only cadence), and three resets
// `scope.needsUpdate` to false unconditionally at the end of every completed real pass -- so a masked
// pass that only set per-light flags (the pre-fix code) silently hit that early-return and drew
// NOTHING, on every one of its 3 sub-passes, explaining the exact reported 0/0/0/~0ms. Fix: also set
// `renderer.shadowMap.needsUpdate = true` immediately before each masked call in _timedMaskedPass
// (restored to false after, matching what a completed real pass already leaves it at). Live-confirmed
// via direct instrumentation of the fixed code path: masked passes now report real non-zero
// calls/triangles matching the scene's actual static/dynamic shadow-caster split.
//
// FRAME-COUNTER BUMP (kept -- a real, separate, confirmed-live bug, independent of the info-blind
// issue above): @three.ez/instanced-mesh's InstancedMesh2.onBeforeShadow (src/core/InstancedMesh2.js)
// gates its own per-object frustum-cull-and-visible-count update behind frustumCullingAlreadyPerformed
// (frame, camera, shadowCamera) (src/core/feature/FrustumCulling.js), which short-circuits to
// "already done, reuse count" whenever BOTH renderer.info.render.frame AND the shadowCamera object
// reference are unchanged since its last call -- true for every one of this probe's 3 back-to-back
// masked passes (same real frame, same lights[i].shadow.camera instances), so only the FIRST masked
// pass would actually recompute visible-instance count; the other two would silently reuse a stale
// cached count from whatever mask was active when that first cull ran. Bumping render.frame before
// each masked pass forces a real re-cull every time -- the same "already bound, skip rebind"-style
// third-party internal-cache-going-stale-across-repeated-calls class of bug the AGENTS.md debugging
// playbook and cluster-onbeforerender-custom-draw-bind-timing caveat both warn about (never trust a
// library's own "already done this frame" cache when calling its render entry point more than once
// per real frame). This is real and correct even though it does not by itself fix the info-blind
// issue above (that gap is upstream of InstancedMesh2's cull decision, in whether a draw call reaches
// info.update() at all).
function _timedMaskedPass(renderer, scene, camera, lights, mask) {
  const restore = []
  if (mask) _setCastShadow(mask, false, restore)
  for (const l of lights) l.shadow.needsUpdate = true
  // renderer.shadowMap.needsUpdate (the SCOPE-level flag, distinct from any per-light
  // light.shadow.needsUpdate set above) is what node_modules/three's WebGLShadowMap.render itself
  // gates the ENTIRE pass on: `if (scope.autoUpdate === false && scope.needsUpdate === false) return`
  // (three.module.js, WebGLShadowMap.render). ShadowPipeline.js runs with renderer.shadowMap.autoUpdate
  // = false by design (texel-step-only cadence, see ShadowPipeline.js header), and this scope-level
  // flag gets reset to false unconditionally at the end of every completed real pass -- so calling
  // _origShadowRender here with only the per-light flags set silently no-ops on this renderer-level
  // gate every time (root cause of shadowcostprobe-info-blind-to-shadow-pass-draws: a masked pass that
  // never actually draws anything obviously reports 0 calls/0 triangles/~0ms -- not a renderer.info
  // blindness at all, live-confirmed via direct gl.drawElements/drawElementsInstanced instrumentation
  // showing normal per-frame shadow passes DO update renderer.info.render correctly). Fix: also force
  // the scope-level flag true immediately before the call.
  renderer.shadowMap.needsUpdate = true
  const ir = renderer.info.render
  const calls0 = ir.calls, tris0 = ir.triangles
  ir.frame++   // force InstancedMesh2's onBeforeShadow to re-cull instead of reusing a stale count
               // cached by an earlier masked pass this same real frame (see header above)
  const t0 = performance.now()
  // Calls the captured REAL render function directly -- never renderer.shadowMap.render (this
  // probe's own wrapper), which would recurse and pollute mode-1 samples with masked-pass timings.
  try { _origShadowRender(lights, scene, camera) } catch (e) { if (typeof window !== 'undefined') window.__shadowCostProbeLastError = e && (e.stack || e.message || String(e)) }
  const ms = performance.now() - t0
  const calls = ir.calls - calls0, triangles = ir.triangles - tris0
  _restoreCastShadow(restore)
  // WebGLShadowMap.render already resets renderer.shadowMap.needsUpdate=false unconditionally at the
  // end of a pass that actually ran (three.module.js ~line 9418), so no explicit restore is needed on
  // the success path; only guard the early-return/throw case (lights.length===0, or the caught
  // exception above) where that reset never executes, which would otherwise leave a stray
  // needsUpdate=true lying around to falsely trigger an extra real re-render on the next ordinary frame.
  renderer.shadowMap.needsUpdate = false
  return { ms, calls, triangles }
}

function _maybeRunSplit(renderer, scene, camera, lights) {
  if (!_splitArmed || _splitInFlight) return
  _splitCounter++
  if (_splitCounter < _splitEveryN) return
  _splitCounter = 0
  _splitInFlight = true
  try {
    const { staticObjs, dynamicObjs } = _classify(scene)
    if (staticObjs.length === 0 && dynamicObjs.length === 0) return
    // static-only (dynamic masked off), dynamic-only (static masked off), combined (real, unmasked --
    // reported for reference, not applied as the default render). Each pass renders ALL cascades
    // together (mirrors the exact array WebGLShadowMap.render receives from THREE's real per-frame
    // lights list), so the split reflects the true combined cost across every cascade, not cascade 0 alone.
    const staticOnly = _timedMaskedPass(renderer, scene, camera, lights, dynamicObjs)
    const dynamicOnly = _timedMaskedPass(renderer, scene, camera, lights, staticObjs)
    const combined = _timedMaskedPass(renderer, scene, camera, lights, null)
    // Force one real re-render on the very next natural pass so the scene doesn't stay one frame
    // stale off the back of this probe's own masked passes (ShadowPipeline itself decides WHEN to
    // re-render next -- this only guarantees the map reflects reality again promptly).
    for (const l of lights) l.shadow.needsUpdate = true
    _splitResult = {
      staticMs: +staticOnly.ms.toFixed(3),
      dynamicMs: +dynamicOnly.ms.toFixed(3),
      combinedMs: +combined.ms.toFixed(3),
      staticObjects: staticObjs.length,
      dynamicObjects: dynamicObjs.length,
      staticShareOfCombined: combined.ms > 0 ? +((staticOnly.ms / combined.ms) * 100).toFixed(1) : null,
      dynamicShareOfCombined: combined.ms > 0 ? +((dynamicOnly.ms / combined.ms) * 100).toFixed(1) : null,
      // GPU-work proxy (see _timedMaskedPass header): real draw-call/triangle counts submitted during
      // each masked pass, independent of the CPU-timing-only ms figures above -- distinguishes "static
      // geometry is genuinely cheap to re-render" from "static geometry is many triangles but fast to
      // SUBMIT" (the latter still costs real GPU raster time a caching split would save, even if ms
      // reads near-zero on this measurement).
      staticCalls: staticOnly.calls, staticTriangles: staticOnly.triangles,
      dynamicCalls: dynamicOnly.calls, dynamicTriangles: dynamicOnly.triangles,
      combinedCalls: combined.calls, combinedTriangles: combined.triangles,
      cascadeCount: lights.length,
      ts: Date.now(),
    }
  } finally {
    _splitInFlight = false
  }
}

// Resolves the fourth install arg into the REAL, LIVE array of every cascade light (index 0 is
// `sun`), re-read on every call rather than cached at install time -- cascade count is fixed at boot
// today, but this keeps the probe correct even if that ever changes. Accepts either:
//   - a ShadowPipeline handle (has a `.lights` getter -- the array WebGLShadowMap.render itself
//     iterates every cascade with) -- the normal, cascade-aware path.
//   - a bare THREE.Light (legacy call shape / no-pipeline callers) -- wrapped as a 1-element array so
//     a caller that hasn't been updated to pass the pipeline still gets correct (if cascade-blind)
//     behavior instead of a crash.
function _resolveLights(pipelineOrSun) {
  if (!pipelineOrSun) return []
  if (Array.isArray(pipelineOrSun.lights)) return pipelineOrSun.lights
  return [pipelineOrSun]
}

// Installs the mode-1 whole-pass timer by wrapping renderer.shadowMap.render exactly once. Call-
// through is unconditional and unchanged; this never alters what gets rendered or when -- only
// observes. Safe to call multiple times (idempotent).
// `sunOrShadowPipeline`: pass the ShadowPipeline handle (createShadowPipeline's return value) so mode
// 2's split covers every cascade -- passing a bare `sun` light still works but silently limits the
// split measurement to cascade 0 (see csm-shadowcostprobe-cascade-blind-measurement).
export function installShadowCostProbe(renderer, scene, camera, sunOrShadowPipeline) {
  // `renderer.shadowMap` is truthy on WebGPURenderer too (shared THREE Renderer surface), but its
  // `.render` method is WebGL-shadow-map-specific and undefined on the WebGPU backend -- guard the
  // actual method we're about to wrap, not just the container object, so this probe stays a no-op
  // on an unsupported backend instead of throwing (see webgpurenderer-shadowcostprobe-backend-guard).
  if (_installed || !renderer || !renderer.shadowMap || typeof renderer.shadowMap.render !== 'function') return
  _installed = true
  _renderer = renderer
  const sm = renderer.shadowMap
  _origShadowRender = sm.render.bind(sm)
  sm.render = function (lights, s, c) {
    const wasNeedsUpdate = sm.needsUpdate
    const t0 = performance.now()
    _origShadowRender(lights, s, c)
    // Only record a sample for a call that actually did work (mirrors WebGLShadowMap's own
    // enabled/autoUpdate/needsUpdate early-return -- a skipped call is not a real shadow-pass cost).
    if (sm.enabled && wasNeedsUpdate) {
      const ms = performance.now() - t0
      _lastPassMs = ms
      _passSamples.push(ms)
      if (_passSamples.length > MAX_SAMPLES) _passSamples.shift()
    }
    // Static/dynamic split mode -- only attempted right after a real re-render (the same event
    // ShadowPipeline already gates on), never invents an extra one on a stable frame.
    if (sm.enabled && wasNeedsUpdate) {
      try { _maybeRunSplit(renderer, s, c, _resolveLights(sunOrShadowPipeline)) } catch (_) {}
    }
  }
  if (typeof window !== 'undefined') {
    window.__shadowCost = {
      stats() {
        const n = _passSamples.length
        let avg = null, p95 = null, max = null
        if (n > 0) {
          const sorted = _passSamples.slice().sort((a, b) => a - b)
          avg = +(sorted.reduce((a, b) => a + b, 0) / n).toFixed(3)
          p95 = +sorted[Math.min(n - 1, Math.floor(0.95 * n))].toFixed(3)
          max = +sorted[n - 1].toFixed(3)
        }
        const { staticObjs, dynamicObjs } = scene ? _classify(scene) : { staticObjs: [], dynamicObjs: [] }
        return {
          lastPassMs: +_lastPassMs.toFixed(3),
          avgPassMs: avg, p95PassMs: p95, maxPassMs: max, samples: n,
          liveStaticCasters: staticObjs.length, liveDynamicCasters: dynamicObjs.length,
          cascadeCount: _resolveLights(sunOrShadowPipeline).length,
          split: _splitResult,
          armed: _splitArmed,
        }
      },
      arm(everyN) { _splitArmed = true; _splitCounter = 0; if (Number.isFinite(everyN) && everyN > 0) _splitEveryN = everyN },
      disarm() { _splitArmed = false; _splitResult = null },
      reset() { _passSamples = []; _lastPassMs = 0 },
      isArmed() { return _splitArmed },
    }
  }
  return window.__shadowCost
}
