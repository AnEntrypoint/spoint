import * as THREE from 'three'

// WetnessTint -- the ONE component that owns the "darken + specular-sheen upward-facing THREE
// geometry while it's raining" effect (wetness-material-modifier-weather-driven).
//
// DISTINCT FROM ssr-material-wetness-mask-authoring (client/core/SSR.js's custom._wetness): that is
// an AUTHORED, per-entity, static puddle/wet-road flag consumed by the SSR reflection mask. THIS
// component is the AUTOMATIC, weather-driven, world-wide scalar -- every upward-facing surface reads
// wetter while it rains and dries out over a configurable period after, with zero per-entity
// authoring required. The two are complementary, not overlapping: SSR's wetness drives REFLECTIONS
// on flagged surfaces; this drives ALBEDO DARKENING + a SPECULAR SHEEN on every material, gated only
// by weather state. UNIONED (ssr-mask-weather-wetness-union, see AGENTS.md): SSR.js's compute() now
// also reads getWetness() below each frame and folds it into its reflection mask (max of band/
// authored/weather sources) so rain-soaked ground gets MORE reflective during a storm too, with zero
// per-entity authoring. getWetness() is the single source both consumers (this component's THREE-
// material sheen and SSR's reflection mask) read from -- SSR never writes it.
//
// PATTERN: exactly UnderwaterTint.js's technique (see AGENTS.md underwater-model-tint-shaderchunk)
// -- patch THREE.ShaderChunk's fog_pars_vertex/fog_vertex/fog_pars_fragment/fog_fragment chunks ONCE
// at scene creation (outside the `#ifdef USE_FOG` guard so it runs regardless of fog), covering every
// material family that already gets the underwater tint (GLTF/pool-Lambert/InstancedSlot/primitives/
// VRM-MToon) since there is no single material-agnostic hook otherwise. A brand-new varying
// (vWetUp, NOT three's own vNormal) is declared+computed independently in OUR OWN vertex-chunk
// addition, exactly like UnderwaterTint declares its own vSpointWorldY rather than reusing an
// existing varying -- avoids any redeclaration collision with normal_pars_vertex/fragment (which
// only conditionally declares vNormal under `#ifndef FLAT_SHADED` on some cheap materials) and stays
// robust regardless of shading model. Computed from objectNormal (unconditionally declared by
// beginnormal_vertex, three's own model-space normal attribute copy) transformed by modelMatrix
// (world space) -- cheap, always-available, no dependency on normalMatrix's view-space convention.
//
// WHY A SPLICED LITERAL, NOT A UNIFORM (real constraint found live this session): a genuinely new
// uniform name referenced only inside a patched ShaderChunk does NOT automatically become a real
// per-material uniform for THREE's built-in materials (MeshStandardMaterial etc). Those materials'
// ShaderLib.<name>.uniforms are built ONCE at three.js module-load time via UniformsUtils.mergeUniforms
// (a ureactive DEEP CLONE of UniformsLib.fog/lights/etc, verified by reading
// node_modules/three/src/renderers/shaders/UniformsUtils.js) -- mutating UniformsLib.fog afterward
// (the naive approach, tried and reverted this session) has ZERO effect on the already-frozen,
// already-cloned ShaderLib uniform objects every built-in material's WebGLProgram was linked against.
// UnderwaterTint.js sidesteps this the same way: SPOINT_SEA_Y is a GLSL literal spliced into the
// chunk TEXT (string replace), not a uniform, forcing a real recompile (mm.needsUpdate) whenever it
// changes. WetnessTint follows the identical pattern but THROTTLES the splice+recompile to coarse
// 0.05 steps (setWetness quantizes before touching the shader text) -- sea level changes once per
// world-load, but wetness changes continuously every frame while raining/drying, so an UNTHROTTLED
// literal-splice-plus-scene-wide-recompile-every-frame would be a real perf regression. 0.05 steps
// bound a full wet(1.0)->dry(0.0) cycle to ~20 total recompiles over its whole dry-out period
// (default 60s, see RenderControls wetnessDryOutSec), not one recompile per frame.
//
// WHY POST-LIGHTING FOR THE DARKEN, BUT REAL PER-LIGHT SPECULAR (wetness-real-specular-per-material-
// followup, 2026-07-21): multiplying the FINAL lit color (same seam UnderwaterTint uses) is still the
// one place that reaches every material's lighting model uniformly (Lambert/Standard/Phong/MToon all
// compute totally different BRDFs upstream) for the ALBEDO DARKEN term -- no per-material-type branch
// needed there. The SPECULAR SHEEN term, however, is now a REAL Blinn-Phong half-vector calculation
// against every actual scene DirectionalLight (not a flat brighten): `lights_fragment_begin` is the
// ShaderChunk shared VERBATIM by meshlambert/meshphong/meshphysical(Standard)/meshtoon.glsl.js (grepped
// in node_modules/three/src/renderers/shaders/ShaderLib/*.glsl.js -- all four `#include
// <lights_fragment_begin>`), so ONE more global ShaderChunk patch (same mechanism as fog_fragment
// already uses, not a heavier per-material onBeforeCompile fan-out) reaches every lit material family
// with real per-light data: inside three's own `#if NUM_DIR_LIGHTS > 0` unrolled loop,
// `directionalLight.direction`/`.color` (post-shadow, since the shadow multiply already landed on
// `directLight.color` before our splice point) and the chunk's own `geometryNormal`/`geometryViewDir`
// (both view-space, already computed earlier in the SAME chunk) are real in-scope light/geometry terms
// -- not a spliced sun-direction literal. The accumulator `spoint_wetSpec` is declared as a FILE-SCOPE
// global (not a fragment-local) inside the fog_pars_fragment splice below, specifically so it exists
// even on material families that lack `lights_fragment_begin` entirely: MeshBasicMaterial (used by
// Rocks.js's occlusion-proxy box + any other unlit mesh) includes `fog_fragment`/`fog_pars_fragment`
// but never `lights_fragment_begin` (verified via the same ShaderLib grep -- meshbasic.glsl.js has no
// lights_fragment_begin include), so the accumulator must default to a real, always-present 0.0 rather
// than relying on the lit-material patch to have declared it first. MToon (VRM, @pixiv/three-vrm-
// materials-mtoon) is its OWN hand-written ShaderMaterial with no ShaderLib/lights_fragment_begin
// participation at all (confirmed: its bundled shader source has zero `lights_fragment_begin`
// occurrences) -- it still gets the darken term (its shader source DOES literally contain
// `#include <fog_fragment>`/`#include <fog_pars_fragment>` text, grepped in the bundled module) but
// cannot receive the real per-light loop, so it falls back to `spoint_wetSpec`'s harmless 0.0 default,
// identical to today's (pre-this-change) MToon output rather than a regression.
//
// PRECONDITION GATING (the lesson UnderwaterTint's own header documents from the 2026-07-11 blue-tree
// bug): the effect is structurally incapable of firing when the spliced SPOINT_WETNESS literal is 0
// (the compiled-in default AND the value at world-load before any rain) -- a dry world/dry moment is
// byte-identical to pre-this-change output, not just visually negligible. The "upward-facing" gate
// (vWetUp) further restricts it to surfaces rain could plausibly hit (walls/undersides stay dry). The
// real-specular ACCUMULATION itself (inside lights_fragment_begin) runs unconditionally per light per
// fragment on lit materials -- cheap enough (one normalize + one pow + one dot) to leave ungated there
// -- but it only ever gets USED by the `if (SPOINT_WETNESS > 0.001)` kill-switch in fog_fragment, the
// one true gate that keeps a dry world byte-identical, matching the darken term's own gating.
//
// Debug surface: RenderControls knobs `wetness`/`wetnessDryOutSec`; window.__wetnessTint =
// { installed, wetness, setWetness }. window.__wetness mirrors the live (unquantized) scalar (also
// consumed by gl-render.js's terrain uWetness uniform -- terrain gets the smooth per-frame value
// since mapspinner's uniform-based path has no recompile cost; THREE materials get the quantized,
// recompile-throttled version via this component -- one authoritative scalar, two consumers with
// different update-cost profiles).

let _installed = false
let _lastSplicedStep = -1 // quantized 0..20 step last baked into the shader text; -1 = never spliced
const QUANT_STEP = 0.05
const _WET_RE = /SPOINT_WETNESS = [0-9.]+/

export function installWetnessTint() {
  if (_installed) return
  _installed = true
  THREE.ShaderChunk.fog_pars_vertex += '\nvarying float vWetUp;'
  // objectNormal: three's own model-space normal copy (beginnormal_vertex), unconditionally declared
  // regardless of FLAT_SHADED/material type -- transformed to world space via modelMatrix (cheap,
  // no normalMatrix view-space ambiguity). dot with world-up -> 1 = ceiling-facing (gets wet), -1 =
  // floor-facing (stays dry), matching how real rain only wets upward surfaces.
  THREE.ShaderChunk.fog_vertex += '\nvWetUp = dot(normalize(mat3(modelMatrix) * objectNormal), vec3(0.0, 1.0, 0.0));'
  THREE.ShaderChunk.fog_pars_fragment +=
    '\nvarying float vWetUp;' +
    '\nconst float SPOINT_WETNESS = 0.0;' + // spliced literal, see header -- 0.0 = fully inert by default
    // FILE-SCOPE global (not a `main()`-local): written by the lights_fragment_begin patch below on
    // lit material families, left at its explicit 0.0 default on unlit families (MeshBasicMaterial)
    // and MToon (neither includes lights_fragment_begin) -- see header for the full family-coverage
    // rationale. Explicit initializer, not relying on GLSL ES's (implementation-varying) global
    // zero-init.
    '\nfloat spoint_wetSpec = 0.0;' +
    // FILE-SCOPE scratch (spoint-wethalf-redefinition-multilight fix, see below): a per-light temporary
    // reused by every directional-light iteration, declared exactly ONCE here rather than inside the
    // unrolled loop body -- see the lights_fragment_begin splice for why a loop-body declaration is
    // unsound. Explicit initializer for the same GLSL-ES zero-init-portability reason as spoint_wetSpec.
    '\nvec3 spoint_wetHalf = vec3(0.0);'
  // REAL PER-LIGHT SPECULAR (wetness-real-specular-per-material-followup): appended AFTER the closing
  // brace of three's own directional-light loop body is wrong (need per-iteration access to `directLight`/
  // `directionalLight`, both loop-scoped `#pragma unroll_loop_start` temporaries) -- so this splices
  // INSIDE the loop, immediately after three's own `RE_Direct(...)` call for that light (the exact
  // point where `directLight.color` already carries the post-shadow multiply from three's own code a
  // few lines earlier in the SAME unrolled iteration, so a shadowed light correctly contributes zero
  // wet-sheen too, not just zero diffuse). `geometryNormal`/`geometryViewDir` are both declared once,
  // unconditionally, at the very top of this same chunk (verified in
  // node_modules/three/src/renderers/shaders/ShaderChunk/lights_fragment_begin.glsl.js) -- both
  // view-space, matching `directLight.direction`'s own view-space convention, so the half-vector dot
  // is computed in one consistent space with zero extra transform. Runs once per real scene
  // DirectionalLight (NUM_DIR_LIGHTS, currently 2: `studio` + `sun` from SceneSetup.setupLights --
  // `studio.castShadow=false` so it never carries a shadow factor, `sun` does), not per-fragment
  // "the sun" assumption -- a future 3rd directional light is picked up automatically since this runs
  // inside three's own loop, not a separate one keyed to a fixed light count.
  // MATCHED VIA REGEX, NOT AN EXACT LITERAL (real bug found + fixed live this session): the built
  // /node_modules/three/build/three.module.js bundle the client actually imports (per client/
  // index.html's importmap) does NOT preserve the same blank-line spacing as the node_modules/three/
  // src/ ShaderChunk source files -- `three.module.js`'s bundler strips the blank line between
  // `#pragma unroll_loop_end` and the following `#endif`/`#if` (single `\n`, not the source's `\n\n`).
  // A first version of this patch used an exact-literal .replace() copied from reading src/ and
  // SILENTLY NO-OP'D against the real served bundle (`.replace()` with a non-matching string returns
  // the input unchanged, no error) -- caught live via a real page.evaluate() dump of
  // `THREE.ShaderChunk.lights_fragment_begin` from the RUNNING page (not a static source read), which
  // is exactly the "query LIVE state, don't trust a static assumption" discipline from the AGENTS.md
  // debugging playbook. Anchored on the directional-loop's own unique tail (`#if ( NUM_RECT_AREA_LIGHTS`
  // immediately follows ONLY the directional loop's `#endif`, not the point/spot loops' identical
  // `RE_Direct(...)` call text) with `\s*` tolerating either spacing convention.
  //
  // FIX (wetness-shader-spoint-wethalf-redefinition, root-caused live this session): the splice point
  // below sits INSIDE `#pragma unroll_loop_start`/`#pragma unroll_loop_end` -- three's real unrollLoops()
  // (node_modules/three/src/renderers/shaders/WebGLProgram.js) textually duplicates everything between
  // those pragmas once per active light (NUM_DIR_LIGHTS), rewriting only `[ i ]`/`UNROLLED_LOOP_INDEX`
  // tokens, NOT arbitrary loop-scoped GLSL declarations. A `vec3 spoint_wetHalf = ...;` DECLARATION at
  // this splice point is therefore emitted once per light in the SAME enclosing scope -- compiles fine
  // at NUM_DIR_LIGHTS===1 (single copy) and fails `'spoint_wetHalf' : redefinition` the moment a scene
  // has >=2 active directional lights (SceneSetup.setupLights ships exactly two, `studio`+`sun`, so this
  // fired on every real multi-light scene). Fixed the same way `spoint_wetSpec` (the accumulator one line
  // below) already avoided the bug: `spoint_wetHalf` is now declared ONCE, file-scope, in the
  // fog_pars_fragment splice above -- this per-light splice only ASSIGNS to it (no `vec3` type prefix),
  // which unrollLoops duplicates as N harmless re-assignments to the same already-declared variable,
  // identical in spirit to how three's own `directionalLight`/`directLight` loop temporaries are declared
  // once above the `#pragma unroll_loop_start` and reused every iteration.
  THREE.ShaderChunk.lights_fragment_begin = THREE.ShaderChunk.lights_fragment_begin.replace(
    /RE_Direct\( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight \);(\s*\}\s*#pragma unroll_loop_end\s*#endif\s*#if \( NUM_RECT_AREA_LIGHTS > 0 \) && defined\( RE_Direct_RectArea \))/,
    'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );\n' +
    '\t\tspoint_wetHalf = normalize( directLight.direction + geometryViewDir );\n' +
    '\t\tspoint_wetSpec += pow( max( dot( geometryNormal, spoint_wetHalf ), 0.0 ), 28.0 ) * dot( directLight.color, vec3( 0.3333 ) );' +
    '$1'
  )
  THREE.ShaderChunk.fog_fragment = [
    'if (SPOINT_WETNESS > 0.001) {',
    '  float wetUpFacing = clamp(vWetUp, 0.0, 1.0);',
    // ease the darken/sheen in over the first ~20% of vertical facing so near-vertical walls (rain
    // grazes them, real-world walls do get somewhat wet, but far less than a flat roof/ground) get a
    // reduced effect rather than a hard cutoff.
    '  float wetAmt = SPOINT_WETNESS * smoothstep(0.0, 0.2, wetUpFacing);',
    '  gl_FragColor.rgb *= mix(1.0, 0.68, wetAmt);',
    // REAL specular sheen: spoint_wetSpec is the sum of every real DirectionalLight's Blinn-Phong
    // half-vector term (accumulated above in lights_fragment_begin), 0.0 on material families that
    // never ran that accumulation (unlit MeshBasicMaterial, MToon) -- this line is then a harmless
    // no-op add-of-zero on those, same output as the old flat-brighten fallback would have been at
    // its own zero-light-data limit, not a regression. Scaled by wetAmt*wetUpFacing exactly like the
    // old flat term (same "ease in on grazing surfaces, gated fully off when dry" envelope), plus a
    // 1.4 tuning multiplier so a single directional light's peak specular (pow(...,28) tops out at a
    // NARROW highlight, unlike the old ALWAYS-ON flat brighten) still reads as a visible sheen rather
    // than a near-invisible pinpoint -- tuned against the same real sun+studio DirectionalLight rig
    // this ships against (SceneSetup.setupLights), not an arbitrary constant.
    '  gl_FragColor.rgb += spoint_wetSpec * wetAmt * wetUpFacing * 1.4 * vec3(1.0, 1.0, 0.95);',
    '}'
  ].join('\n') + '\n' + THREE.ShaderChunk.fog_fragment
  if (typeof window !== 'undefined') {
    window.__wetnessTint = { installed: true, wetness: 0, setWetness }
  }
}

// Live scalar, updated every frame by the weather-wetness render-graph node -- cheap (a plain number
// write), independent of the throttled shader-recompile path below.
let _liveWetness = 0

// Splices the quantized wetness literal into the patched chunk and recompiles every already-built
// material ONLY when the quantized step actually changed (see header for why: an untotalized
// per-frame recompile across the whole scene would be a real perf regression). Called every frame by
// the weather-wetness render-graph node -- cheap no-op on every frame that doesn't cross a 0.05 step.
export function setWetness(w, scene) {
  installWetnessTint()
  const v = THREE.MathUtils.clamp(Number.isFinite(w) ? w : 0, 0, 1)
  _liveWetness = v
  if (typeof window !== 'undefined') {
    window.__wetness = v
    if (window.__wetnessTint) window.__wetnessTint.wetness = v
  }
  const step = Math.round(v / QUANT_STEP)
  if (step === _lastSplicedStep) return
  _lastSplicedStep = step
  const quantized = step * QUANT_STEP
  THREE.ShaderChunk.fog_pars_fragment = THREE.ShaderChunk.fog_pars_fragment.replace(_WET_RE, 'SPOINT_WETNESS = ' + quantized.toFixed(2))
  if (scene) scene.traverse(o => { const m = o.material; if (!m) return; for (const mm of (Array.isArray(m) ? m : [m])) mm.needsUpdate = true })
}

export function getWetness() { return _liveWetness }
