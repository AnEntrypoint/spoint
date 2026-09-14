import * as THREE from 'three'

const SUBMERGE_MARGIN_M = 2.0
const CAM_ABOVE_WATER_TINT_LIMIT_M = 3.0
const SEA_Y = 0, SEA_RADIUS = 1, ENABLED = 2

let _installed = false
const _seaUniform = { value: new Float32Array([-100000, 0, 0, 0]) }
const _seaShiftUniform = { value: new Float32Array([0, 0, 0]) }

export const SEA_SURFACE_GLSL = [
  'uniform vec4 spointSea;',
  'uniform vec3 spointSeaShift;',
  'bool spointSeaEnabled() { return spointSea.z > 0.5; }',
  'float spointSeaSurfaceY(vec3 renderPos) {',
  '  vec2 a = renderPos.xz + spointSeaShift.xz;',
  '  float r2 = dot(a, a);',
  '  float rho = spointSea.y;',
  '  float drop = rho > 0.0 ? r2 / (rho + sqrt(max(rho * rho - r2, 0.0))) : 0.0;',
  '  return spointSea.x - spointSeaShift.y - drop;',
  '}'
].join('\n')

export function adoptSeaUniforms(uniforms) {
  if (!uniforms) return
  if (!uniforms.spointSea) uniforms.spointSea = _seaUniform
  if (!uniforms.spointSeaShift) uniforms.spointSeaShift = _seaShiftUniform
}

function _adoptIntoSceneShaderMaterials(scene) {
  scene.traverse(o => {
    const m = o.material
    if (!m) return
    for (const mm of (Array.isArray(m) ? m : [m])) {
      if (!mm.isShaderMaterial || !mm.uniforms || (mm.uniforms.spointSea && mm.uniforms.spointSeaShift)) continue
      adoptSeaUniforms(mm.uniforms)
      mm.needsUpdate = true
    }
  })
}

function _syncFloatingOriginShift() {
  const fo = typeof window !== 'undefined' && window.__floatingOrigin
  const s = fo && typeof fo.getShift === 'function' ? fo.getShift() : null
  if (!s) return
  const v = _seaShiftUniform.value
  v[0] = s.x; v[1] = s.y; v[2] = s.z
}

function _chainSceneShiftSync(scene) {
  if (!scene || scene.__spointSeaShiftSync) return
  scene.__spointSeaShiftSync = true
  const prev = scene.onBeforeRender
  scene.onBeforeRender = function (...args) {
    _syncFloatingOriginShift()
    return prev.apply(this, args)
  }
}

export function installUnderwaterTint() {
  if (_installed) return
  _installed = true
  THREE.ShaderChunk.fog_pars_vertex += '\n' + SEA_SURFACE_GLSL + '\nvarying float vSpointWorldY;\nvarying float vSpointSeaY;'
  THREE.ShaderChunk.fog_vertex += '\nvec3 spWorld = vec3(dot(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), mvPosition.xyz), dot(vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]), mvPosition.xyz), dot(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]), mvPosition.xyz)) + cameraPosition;'
  THREE.ShaderChunk.fog_vertex += '\nvSpointWorldY = spWorld.y;\nvSpointSeaY = spointSeaSurfaceY(spWorld);'
  THREE.ShaderChunk.fog_pars_fragment +=
    '\n' + SEA_SURFACE_GLSL +
    '\nvarying float vSpointWorldY;' +
    '\nvarying float vSpointSeaY;' +
    '\nconst float SPOINT_SUBMERGE_MARGIN = ' + SUBMERGE_MARGIN_M.toFixed(1) + ';' +
    '\nconst float SPOINT_CAM_ABOVE_LIMIT = ' + CAM_ABOVE_WATER_TINT_LIMIT_M.toFixed(1) + ';'
  THREE.ShaderChunk.fog_fragment = [
    'if (spointSeaEnabled() && cameraPosition.y < spointSeaSurfaceY(cameraPosition) + SPOINT_CAM_ABOVE_LIMIT) {',
    '  if (vSpointWorldY < vSpointSeaY - SPOINT_SUBMERGE_MARGIN) {',
    '    float dSub = clamp((vSpointSeaY - SPOINT_SUBMERGE_MARGIN - vSpointWorldY) * 0.08, 0.0, 0.6);',
    '    gl_FragColor.rgb = mix(gl_FragColor.rgb * vec3(0.30, 0.55, 0.65), vec3(0.04, 0.34, 0.52), dSub);',
    '  }',
    '}'
  ].join('\n') + '\n' + THREE.ShaderChunk.fog_fragment
  adoptSeaUniforms(THREE.UniformsLib && THREE.UniformsLib.fog)
  if (THREE.ShaderLib) for (const name in THREE.ShaderLib) adoptSeaUniforms(THREE.ShaderLib[name] && THREE.ShaderLib[name].uniforms)
  if (typeof window !== 'undefined') {
    window.__underwaterTint = { installed: true, seaY: null, setSeaLevelY, uniform: _seaUniform, shiftUniform: _seaShiftUniform }
  }
}

export function setSeaLevelY(seaY, scene, planetRadius) {
  installUnderwaterTint()
  if (Number.isFinite(planetRadius) && planetRadius > 0) _seaUniform.value[SEA_RADIUS] = planetRadius
  if (!Number.isFinite(seaY)) return
  _seaUniform.value[SEA_Y] = seaY
  _seaUniform.value[ENABLED] = 1
  _syncFloatingOriginShift()
  if (scene) { _adoptIntoSceneShaderMaterials(scene); _chainSceneShiftSync(scene) }
  if (typeof window !== 'undefined') {
    window.__seaLevelY = seaY
    if (window.__underwaterTint) window.__underwaterTint.seaY = seaY
  }
}
