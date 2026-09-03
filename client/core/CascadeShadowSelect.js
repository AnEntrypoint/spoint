import * as THREE from 'three'

// CascadeShadowSelect -- the ONE component that owns PER-FRAGMENT cascade selection for
// ShadowPipeline's cascaded shadow maps (csm-per-fragment-cascade-select-shader, follow-up to
// csm-2-3-cascade-shadow-maps-shadowpipeline's first slice).
//
// WHY IT EXISTS: with no custom shader, THREE's stock lights_fragment_begin loop multiplies EVERY
// shadow-casting directional light's shadow term into directLight.color, once per light
// (`directLight.color *= getShadow(directionalShadowMap[i], ...)`, unrolled once per cascade --
// see node_modules/three/src/renderers/shaders/ShaderChunk/lights_fragment_begin.glsl.js). A point
// covered by more than one cascade's frustum therefore gets shadowed by the PRODUCT of every
// covering cascade's term, not a single hard-edged "nearest cascade wins" pick -- textbook CSM
// compositing selects exactly one cascade per fragment (with a cross-fade band at the boundary to
// avoid a hard seam), never an implicit multiplicative stack.
//
// THE FIX: patch TWO THREE.ShaderChunk entries ONCE (same global-monkeypatch precedent as
// UnderwaterTint.js's fog-chunk patch -- there is no per-material hook that reaches every built-in +
// custom material, so the patch point is the shared chunks, documented here as the single owner):
//
//   1. `shadowmap_pars_fragment` -- appends the `spointCascadeWeight()` helper as a REAL TOP-LEVEL
//      GLSL FUNCTION (declared alongside THREE's own `getShadow()`, which lives in this exact chunk
//      for exactly this reason). THIS PLACEMENT IS LOAD-BEARING, not stylistic: every ShaderLib
//      template (`meshphysical.glsl.js` etc) includes `shadowmap_pars_fragment` BEFORE `void main()`,
//      but includes `lights_fragment_begin` FROM INSIDE `main()`'s own body. GLSL (like C) forbids
//      declaring one function inside another's body -- a first attempt at this file spliced
//      `spointCascadeWeight` directly into `lights_fragment_begin` and it compiled as a nested
//      function declaration, which is illegal GLSL. LIVE-CAUGHT via a real
//      WebGL2RenderingContext.prototype.compileShader monkeypatch against an actual booted server +
//      Playwright chromium: `ERROR: 0:1862: '{' : syntax error` at the nested function's opening
//      brace, confirmed via `gl.getError()===1282` (GL_INVALID_OPERATION) and every material
//      compiled from the patched chunk failing to link ("Fragment shader is not compiled"). Moving
//      the function to `shadowmap_pars_fragment` (true top-level scope) fixed it -- re-verified
//      zero shader-compile failures via the same live monkeypatch technique post-fix.
//   2. `lights_fragment_begin` -- ONLY the tiny in-body pieces that must be per-fragment/per-cascade
//      stay here: a ONE-TIME `spointCamDist` local (camera-space distance, from `geometryPosition`,
//      ALREADY an in-scope local a few lines above the directional-light loop -- zero new varyings
//      needed, unlike UnderwaterTint's fog_vertex addition) declared ABOVE the unrolled loop (see
//      that declaration's own comment for why it cannot live inside the loop body), and the
//      `getShadow(...)` call-site wrapped in `mix(1.0, getShadow(...), spointCascadeWeight(...))`.
//
// Weight is 1 inside the cascade's own depth band, ramps to 0 over a SPOINT_CASCADE_BLEND_M-wide
// band at each boundary (smoothstep cross-fade, standard CSM practice), and is exactly 0 once past
// the next cascade's near edge -- so at any fragment, at most two adjacent cascades contribute
// (during the blend band; a hard select everywhere else), never every covering cascade multiplied
// together. `directLight.color *= mix(1.0, getShadow(...), weight)` keeps the light fully lit
// (shadow inert, weight 0) for any cascade a fragment falls outside of, restoring the textbook
// "look up the ONE selected cascade" behavior THREE's stock loop does not provide.
//
// ROBUST PRECONDITION (mirrors UnderwaterTint's camera-based gate): cascadeCount<=1 is a COMPLETE
// NO-OP -- install() is simply never called by ShadowPipeline for a 1-cascade pipeline (the default
// on Low/Medium-tier devices and the only mode proven safe for the historically fragile close-tree-
// flicker subsystem, see AGENTS.md tree-flicker-root-cause-2026-07-11). This makes the entire
// per-fragment-select code path structurally unreachable, not merely inert, whenever cascades=1 --
// zero regression risk to the proven single-cascade behavior by construction, exactly the same
// discipline UnderwaterTint used for its own false-trigger regime.
//
// Split boundaries are each cascade's own `extent` (its ortho half-width around the shadow target,
// e.g. 60m/192m/614m at the default 3.2x geometric split) -- NOT an independently-tuned distance --
// so "in cascade i's frustum" and "camera-space distance inside cascade i's band" stay the same
// definition ShadowPipeline.js already uses to size the shadow camera itself. The shadow target
// (player position) sits within ~10m of the tps camera (see AGENTS.md sim-render-pacing note on the
// tps camera-to-player offset), negligible against 60m+ cascade extents, so render-camera distance
// is an accurate proxy for target-distance without needing a second set of uniforms/varyings.
//
// Debug surface: window.__cascadeShadowSelect = { installed, cascadeCount, splits }.

const _SPLITS_RE = /SPOINT_CASCADE_SPLITS\[3\] = float\[3\]\([^)]*\)/

// Metres of cross-fade at each cascade boundary. Wide enough to hide the seam, narrow enough that
// the "at most two cascades" invariant stays local (never spans a whole cascade's own extent).
const BLEND_M = 4.0

let _installed = false
let _cascadeCount = 1

// One-time chunk patch. No-op if cascadeCount<=1 (see header) or already installed (idempotent,
// matching UnderwaterTint's own _installed guard -- a second cascade-pipeline construction in the
// same session, e.g. a hot-reload, must not double-append the patch).
export function installCascadeShadowSelect(cascadeCount, splitExtents) {
  if (!Number.isFinite(cascadeCount) || cascadeCount <= 1) return
  _cascadeCount = Math.max(1, Math.min(3, Math.round(cascadeCount)))
  if (_installed) { setCascadeSplits(splitExtents); return }

  // --- Patch 1: shadowmap_pars_fragment (top-level, pre-main() -- real function declaration site) ---
  const parsChunk = THREE.ShaderChunk.shadowmap_pars_fragment
  // Anchor right after the `directionalLightShadows` uniform declaration -- still inside the SAME
  // `#ifdef USE_SHADOWMAP` / `#if NUM_DIR_LIGHT_SHADOWS > 0` guard pair that already wraps it, so no
  // redundant re-guard is needed here.
  const parsMarker = 'uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];'
  const anchor = parsChunk.indexOf(parsMarker)
  if (anchor === -1) return   // stock chunk shape changed underneath us -- fail safe, no-op

  const parsHeader =
    '\nconst float SPOINT_CASCADE_SPLITS[3] = float[3](0.0, 0.0, 0.0);' +
    '\nconst float SPOINT_CASCADE_BLEND_M = ' + BLEND_M.toFixed(1) + ';' +
    '\n// Per-fragment cascade-select weight for unrolled loop index `idx` (0-based cascade index).' +
    '\n// 1.0 inside the cascade band, smoothstep-fades to 0.0 over SPOINT_CASCADE_BLEND_M at each' +
    '\n// boundary so at most two adjacent cascades ever contribute (never every covering cascade).' +
    '\n// TOP-LEVEL function declaration -- see this file header for why it cannot live inside' +
    '\n// lights_fragment_begin (which is textually inside main()).' +
    '\nfloat spointCascadeWeight( int idx, float camDist ) {' +
    '\n  float farEdge = SPOINT_CASCADE_SPLITS[ min( idx, 2 ) ];' +
    '\n  float w = 1.0;' +
    '\n  if ( farEdge > 0.0 ) w *= 1.0 - smoothstep( farEdge - SPOINT_CASCADE_BLEND_M, farEdge, camDist );' +
    '\n  if ( idx > 0 ) {' +
    '\n    float nearEdge = SPOINT_CASCADE_SPLITS[ idx - 1 ];' +
    '\n    w *= smoothstep( nearEdge - SPOINT_CASCADE_BLEND_M, nearEdge, camDist );' +
    '\n  }' +
    '\n  return w;' +
    '\n}\n'

  const patchedPars = parsChunk.slice(0, anchor + parsMarker.length) + parsHeader + parsChunk.slice(anchor + parsMarker.length)

  // --- Patch 2: lights_fragment_begin (in-body -- camDist local + call-site wrapper only) ---
  const chunk = THREE.ShaderChunk.lights_fragment_begin
  // Splice the ONE per-fragment camDist local right before the directional-light `#pragma
  // unroll_loop_start`, INSIDE the `#if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0` guard
  // that already declares `directionalLightShadow` there. THIS DECLARATION SITE IS LOAD-BEARING:
  // THREE's own unrollLoops() (node_modules/three/src/renderers/webgl/WebGLProgram.js) does a PLAIN
  // STRING CONCATENATION of the loop body per unrolled index -- it does NOT wrap each copy in its own
  // braces -- so a local declared INSIDE the loop body (`for(...){ ... }`) would be emitted N times
  // in the SAME top-level scope once unrolled (a real GLSL "redefinition" compile error for any
  // cascadeCount>=2, i.e. every case this file is not already a no-op for). Declaring it once, ABOVE
  // the loop, avoids that entirely; `geometryPosition` (used to derive it) is declared earlier in
  // this same chunk, still in scope at this point.
  const marker = 'DirectionalLightShadow directionalLightShadow;'
  const idx = chunk.indexOf(marker)
  if (idx === -1) return   // stock chunk shape changed underneath us -- fail safe, no-op rather than a broken patch

  const patched = chunk.slice(0, idx) + marker +
    '\nfloat spointCamDist = length( geometryPosition );\n' +
    chunk.slice(idx + marker.length)

  // Wrap the per-cascade getShadow(...) call with the selection weight: `directLight.color *=
  // mix(1.0, getShadow(...), receiveShadow-gated-weight)` -- weight 0 leaves the light fully lit
  // (this cascade inert for the fragment) instead of contributing its shadow term at all, replacing
  // the stock unconditional multiply. This line stays INSIDE the unrolled loop body (it legitimately
  // needs the cascade index per iteration), only the function/const declarations were the
  // nested-function-declaration hazard (fixed by patch 1 above).
  //
  // USES `UNROLLED_LOOP_INDEX`, NOT the loop variable `i`, TO SELECT THE CASCADE. THREE's real
  // unrollLoops() (WebGLProgram.js loopReplacer) only rewrites two things per unrolled copy: text
  // matching `[ i ]` (array-subscript bracket syntax, e.g. `directionalShadowMap[ i ]` ->
  // `directionalShadowMap[ 0 ]`) and the literal macro token `UNROLLED_LOOP_INDEX` (a plain textual
  // substitution, no brackets required -- the existing stock chunk already uses it exactly this way
  // in bare `#if (UNROLLED_LOOP_INDEX < ...)` conditions elsewhere in this same file). A bare `i` used
  // as an ordinary function-call ARGUMENT (not inside `[...]`) is NOT one of those two patterns, so it
  // would survive unrolling untouched -- referencing the now-out-of-scope `for`-loop variable `i` in
  // the fully unrolled, brace-less output -> a real GLSL "undeclared identifier" compile failure.
  // LIVE-CAUGHT this exact bug too, same monkeypatch technique, before this fix.
  const getShadowRe = /directLight\.color \*= \( directLight\.visible && receiveShadow \) \? getShadow\( directionalShadowMap\[ i \], directionalLightShadow\.shadowMapSize, directionalLightShadow\.shadowIntensity, directionalLightShadow\.shadowBias, directionalLightShadow\.shadowRadius, vDirectionalShadowCoord\[ i \] \) : 1\.0;/
  const finalChunk = patched.replace(getShadowRe,
    'directLight.color *= ( directLight.visible && receiveShadow ) ? mix( 1.0, getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ), spointCascadeWeight( UNROLLED_LOOP_INDEX, spointCamDist ) ) : 1.0;'
  )
  if (finalChunk === patched) return   // getShadow call shape changed underneath us -- fail safe, no-op

  THREE.ShaderChunk.shadowmap_pars_fragment = patchedPars
  THREE.ShaderChunk.lights_fragment_begin = finalChunk
  _installed = true
  setCascadeSplits(splitExtents)
  if (typeof window !== 'undefined') {
    window.__cascadeShadowSelect = { installed: true, cascadeCount: _cascadeCount, splits: splitExtents ? splitExtents.slice() : null, setCascadeSplits }
  }
}

// Splices the real per-cascade split boundaries (each cascade's own `extent`, see header) into the
// already-patched shadowmap_pars_fragment chunk (where SPOINT_CASCADE_SPLITS now lives, see patch 1
// above) and recompiles every already-built material so the live values take effect. `extents` =
// [cascade0.extent, cascade1.extent, cascade2.extent] (unused trailing slots -> 0, which
// spointCascadeWeight treats as "no far edge", i.e. the last real cascade always covers to infinity).
export function setCascadeSplits(extents, scene) {
  if (!_installed || !Array.isArray(extents)) return
  const e = [extents[0] || 0, extents[1] || 0, extents[2] || 0]
  const literal = 'SPOINT_CASCADE_SPLITS[3] = float[3](' + e.map(v => v.toFixed(2)).join(', ') + ')'
  THREE.ShaderChunk.shadowmap_pars_fragment = THREE.ShaderChunk.shadowmap_pars_fragment.replace(_SPLITS_RE, literal)
  if (scene) scene.traverse(o => { const m = o.material; if (!m) return; for (const mm of (Array.isArray(m) ? m : [m])) mm.needsUpdate = true })
  if (typeof window !== 'undefined' && window.__cascadeShadowSelect) window.__cascadeShadowSelect.splits = e.slice()
}

export function isCascadeShadowSelectInstalled() { return _installed }
