import * as THREE from 'three'

const SUBMERGE_MARGIN_M = 2.0
const CAM_ABOVE_WATER_TINT_LIMIT_M = 3.0
const SEA_Y = 0, CURVATURE_PER_DIST2 = 1, ENABLED = 2

let _installed = false
const _seaUniform = { value: new Float32Array([-100000, 0, 0]) }

function _adoptSeaUniform(uniforms) {
  if (uniforms && !uniforms.spointSea) uniforms.spointSea = _seaUniform
}

function _adoptIntoSceneShaderMaterials(scene) {
  scene.traverse(o => {
    const m = o.material
    if (!m) return
    for (const mm of (Array.isArray(m) ? m : [m])) {
      if (!mm.isShaderMaterial || !mm.uniforms || mm.uniforms.spointSea) continue
      mm.uniforms.spointSea = _seaUniform
      mm.needsUpdate = true
    }
  })
}

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
    '\nuniform vec3 spointSea;' +
    '\n#define SPOINT_SEA_Y spointSea.x' +
    '\n#define SPOINT_SEA_CURVATURE_PER_DIST2 spointSea.y' +
    '\n#define SPOINT_SEA_ENABLED (spointSea.z > 0.5)' +
    '\nconst float SPOINT_SUBMERGE_MARGIN = ' + SUBMERGE_MARGIN_M.toFixed(1) + ';' +
    '\nconst float SPOINT_CAM_ABOVE_LIMIT = ' + CAM_ABOVE_WATER_TINT_LIMIT_M.toFixed(1) + ';'
  THREE.ShaderChunk.fog_fragment = [
    'float spCamSeaY = SPOINT_SEA_Y - (cameraPosition.x * cameraPosition.x + cameraPosition.z * cameraPosition.z) * SPOINT_SEA_CURVATURE_PER_DIST2;',
    'if (SPOINT_SEA_ENABLED && cameraPosition.y < spCamSeaY + SPOINT_CAM_ABOVE_LIMIT) {',
    '  float spSeaHere = SPOINT_SEA_Y - vSpointDist2 * SPOINT_SEA_CURVATURE_PER_DIST2;',
    '  if (vSpointWorldY < spSeaHere - SPOINT_SUBMERGE_MARGIN) {',
    '    float dSub = clamp((spSeaHere - SPOINT_SUBMERGE_MARGIN - vSpointWorldY) * 0.08, 0.0, 0.6);',
    '    gl_FragColor.rgb = mix(gl_FragColor.rgb * vec3(0.30, 0.55, 0.65), vec3(0.04, 0.34, 0.52), dSub);',
    '  }',
    '}'
  ].join('\n') + '\n' + THREE.ShaderChunk.fog_fragment
  _adoptSeaUniform(THREE.UniformsLib && THREE.UniformsLib.fog)
  if (THREE.ShaderLib) for (const name in THREE.ShaderLib) _adoptSeaUniform(THREE.ShaderLib[name] && THREE.ShaderLib[name].uniforms)
  if (typeof window !== 'undefined') {
    window.__underwaterTint = { installed: true, seaY: null, setSeaLevelY, uniform: _seaUniform }
  }
}

export function setSeaLevelY(seaY, scene, planetRadius) {
  installUnderwaterTint()
  if (Number.isFinite(planetRadius) && planetRadius > 0) _seaUniform.value[CURVATURE_PER_DIST2] = 1 / (2 * planetRadius)
  if (!Number.isFinite(seaY)) return
  _seaUniform.value[SEA_Y] = seaY
  _seaUniform.value[ENABLED] = 1
  if (scene) _adoptIntoSceneShaderMaterials(scene)
  if (typeof window !== 'undefined') {
    window.__seaLevelY = seaY
    if (window.__underwaterTint) window.__underwaterTint.seaY = seaY
  }
}
