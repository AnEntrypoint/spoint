import * as THREE from 'three'

const SUBMERGE_MARGIN_M = 2.0
const CAM_ABOVE_WATER_TINT_LIMIT_M = 3.0

let _installed = false
const _SEA_RE = /SPOINT_SEA_Y = -?[0-9.]+/
const _R_RE = /SPOINT_PLANET_R = -?[0-9.]+/

export function installUnderwaterTint() {
  if (_installed) return
  _installed = true
  THREE.ShaderChunk.fog_pars_vertex += '\nvarying float vSpointWorldY;\nvarying float vSpointDist2;'
  THREE.ShaderChunk.fog_vertex += '\nvSpointWorldY = dot(vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]), mvPosition.xyz) + cameraPosition.y;'
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
    'float spCamSeaY = SPOINT_SEA_Y - (cameraPosition.x * cameraPosition.x + cameraPosition.z * cameraPosition.z) / (2.0 * SPOINT_PLANET_R);',
    'if (cameraPosition.y < spCamSeaY + SPOINT_CAM_ABOVE_LIMIT) {',
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
