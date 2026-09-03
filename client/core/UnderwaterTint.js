import * as THREE from 'three'

// UnderwaterTint -- the ONE component that owns the "tint submerged THREE geometry blue" effect.
//
// WHY IT EXISTS (the non-obvious bit, stated once so it is never confusing again): mapspinner paints the
// water surface in its OWN raw-GL composite BEFORE the THREE scene draws on top with autoClear=false. So a
// THREE object below the water line depth-wins and would draw with its normal (dry) colour over the water.
// To make submerged geometry read as underwater we tint its fragments blue in-shader. There is no per-
// material hook that reaches every built-in + custom material, so we patch THREE.ShaderChunk's fog chunks
// ONCE at scene creation (outside the `#ifdef USE_FOG` guard so it runs regardless of fog). This is a
// deliberate global shader patch, documented here as the single owner.
//
// THE BUG THIS COMPONENT FIXES (blue trees, confirmed live 2026-07-11): the previous version keyed the
// tint purely on a per-fragment reconstructed world-Y (dot(viewMatrix row1, mvPosition) + cameraPosition.y)
// with only a 2 m deadband. That reconstruction is a difference of two large, view-dependent quantities;
// its fp32 error grows at high camera pitch and far from the origin, and on tall/grazing billboard/impostor
// geometry it exceeded the 2 m deadband -- so above-water trees got a false blue tint when you looked up
// (blueFrac 0 level -> 0.243 pitched up, gone with the tint off). Fix = make the tint's PRECONDITION robust
// instead of trusting a noisy scalar: the tint can only ever apply when the CAMERA is at/near/below the
// water surface (uSpointCamBelow), which is the only situation the effect is even for; well above water --
// every normal-gameplay frame, i.e. the entire false-trigger regime -- the tint is skipped outright so no
// reconstruction error can produce a false blue. A wide submerge margin remains for the per-fragment test.
//
// Debug surface: RenderControls knob `seaLevelY`; window.__underwaterTint = { setSeaLevelY, seaY, installed }.

// Metres below sea level a fragment must reconstruct before it tints -- wide enough that reconstruction
// noise on above-water geometry can never reach it (real submersion is never a near-miss).
const SUBMERGE_MARGIN_M = 2.0
// Metres above sea level the CAMERA may be and still allow the tint at all. The effect is for viewing
// water/submerged geometry from at or near the surface; a camera far above the water never needs it, and
// gating on this makes the whole false-trigger regime (looking up from dry land) impossible by construction.
const CAM_ABOVE_WATER_TINT_LIMIT_M = 3.0

let _installed = false
const _SEA_RE = /SPOINT_SEA_Y = -?[0-9.]+/
const _R_RE = /SPOINT_PLANET_R = -?[0-9.]+/

export function installUnderwaterTint() {
  if (_installed) return
  _installed = true
  THREE.ShaderChunk.fog_pars_vertex += '\nvarying float vSpointWorldY;\nvarying float vSpointDist2;'
  // per-vertex world-Y reconstruction (rigid viewMatrix -> no mat4 inverse needed). Noisy at pitch/far, so
  // it is only ONE of the two conditions below, never trusted alone.
  THREE.ShaderChunk.fog_vertex += '\nvSpointWorldY = dot(vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]), mvPosition.xyz) + cameraPosition.y;'
  // CURVATURE-CORRECTED WATERLINE (ground-depth-cut fix, 2026-08-21): the ocean surface is a SPHERE of
  // radius SPOINT_PLANET_R around the planet centre while local scene Y is measured from the tangent plane
  // at the anchor, so the effective sea-level Y DROPS with horizontal distance d from the anchor by the
  // sagitta d^2/(2R) (same term PlanetFrame.groundHeightLocal's `drop` folds into terrain heights -- the
  // two must agree or the tint disagrees with the rendered shoreline). At the tps-game world's radius this
  // reaches ~4 m at the map edge -- larger than SUBMERGE_MARGIN_M itself, so the old flat test both missed
  // genuinely-submerged fragments far out and would have tinted dry dips near the anchor threshold.
  // Reconstruct per-fragment world X/Z the same rigid way as world Y (viewMatrix columns = transposed
  // rotation) and carry the squared anchor distance so the fragment gate can apply the sagitta itself.
  THREE.ShaderChunk.fog_vertex += '\nvec3 spWorldX = vec3(dot(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), mvPosition.xyz) + cameraPosition.x, 0.0, dot(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]), mvPosition.xyz) + cameraPosition.z);'
  THREE.ShaderChunk.fog_vertex += '\nvSpointDist2 = spWorldX.x * spWorldX.x + spWorldX.z * spWorldX.z;'
  THREE.ShaderChunk.fog_pars_fragment +=
    '\nvarying float vSpointWorldY;' +
    '\nvarying float vSpointDist2;' +
    '\nconst float SPOINT_SEA_Y = -100000.0;' +
    '\nconst float SPOINT_PLANET_R = -1.0;' +
    '\nconst float SPOINT_SUBMERGE_MARGIN = ' + SUBMERGE_MARGIN_M.toFixed(1) + ';' +
    '\nconst float SPOINT_CAM_ABOVE_LIMIT = ' + CAM_ABOVE_WATER_TINT_LIMIT_M.toFixed(1) + ';'
  THREE.ShaderChunk.fog_fragment = [
    // GATE 1 (robust, camera-based): only ever tint when the camera itself is at/near/below the water,
    // tested against the curvature-corrected waterline AT THE CAMERA'S OWN horizontal distance
    // (cameraPosition.* are exact uniforms, so this cannot false-trigger); it removes the entire
    // look-up-from-dry-land regime that produced the blue-tree bug.
    'float spCamSeaY = SPOINT_SEA_Y - (cameraPosition.x * cameraPosition.x + cameraPosition.z * cameraPosition.z) / (2.0 * SPOINT_PLANET_R);',
    'if (cameraPosition.y < spCamSeaY + SPOINT_CAM_ABOVE_LIMIT) {',
    // GATE 2 (per-fragment): the fragment is genuinely below the curved waterline by a wide margin.
    '  float spSeaHere = SPOINT_SEA_Y - vSpointDist2 / (2.0 * SPOINT_PLANET_R);',
    '  if (vSpointWorldY < spSeaHere - SPOINT_SUBMERGE_MARGIN) {',
    '    float dSub = clamp((spSeaHere - SPOINT_SUBMERGE_MARGIN - vSpointWorldY) * 0.08, 0.0, 0.6);',
    '    gl_FragColor.rgb = mix(gl_FragColor.rgb * vec3(0.30, 0.55, 0.65), vec3(0.04, 0.34, 0.52), dSub);',
    '  }',
    '}'
  ].join('\n') + '\n' + THREE.ShaderChunk.fog_fragment
  if (typeof window !== 'undefined') {
    window.__underwaterTint = { installed: true, seaY: null, setSeaLevelY }
  }
}

// Splices the real sea level + planet radius into the patched chunk and recompiles every already-built
// material (lazy tiers pick it up at first compile). Called at terrain-ready with the world's actual
// sea-level Y and frame radius (the sagitta correction is a no-op flat test when planetRadius is absent).
export function setSeaLevelY(seaY, scene, planetRadius) {
  installUnderwaterTint()
  if (Number.isFinite(planetRadius) && planetRadius > 0) {
    THREE.ShaderChunk.fog_pars_fragment = THREE.ShaderChunk.fog_pars_fragment.replace(_R_RE, 'SPOINT_PLANET_R = ' + planetRadius.toFixed(2))
  }
  if (!Number.isFinite(seaY)) return
  THREE.ShaderChunk.fog_pars_fragment = THREE.ShaderChunk.fog_pars_fragment.replace(_SEA_RE, 'SPOINT_SEA_Y = ' + seaY.toFixed(4))
  if (scene) scene.traverse(o => { const m = o.material; if (!m) return; for (const mm of (Array.isArray(m) ? m : [m])) mm.needsUpdate = true })
  if (typeof window !== 'undefined') {
    window.__seaLevelY = seaY
    if (window.__underwaterTint) window.__underwaterTint.seaY = seaY
  }
}
