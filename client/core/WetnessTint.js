import * as THREE from 'three'

let _installed = false
const _wetUniform = { value: new Float32Array(1) }

export function installWetnessTint() {
  if (_installed) return
  _installed = true
  THREE.ShaderChunk.beginnormal_vertex += '\n#ifndef SPOINT_HAS_OBJECT_NORMAL\n#define SPOINT_HAS_OBJECT_NORMAL\n#endif'
  THREE.ShaderChunk.fog_pars_vertex += '\nvarying float vWetUp;'
  THREE.ShaderChunk.fog_vertex +=
    '\n#ifdef SPOINT_HAS_OBJECT_NORMAL' +
    '\nvWetUp = dot(normalize(mat3(modelMatrix) * objectNormal), vec3(0.0, 1.0, 0.0));' +
    '\n#else' +
    '\nvWetUp = 0.0;' +
    '\n#endif'
  THREE.ShaderChunk.fog_pars_fragment +=
    '\nvarying float vWetUp;' +
    '\nuniform float spointWetness[1];' +
    '\n#define SPOINT_WETNESS spointWetness[0]' +
    '\nfloat spoint_wetSpec = 0.0;' +
    '\nvec3 spoint_wetHalf = vec3(0.0);'
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
    '  float wetAmt = SPOINT_WETNESS * smoothstep(0.0, 0.2, wetUpFacing);',
    '  gl_FragColor.rgb *= mix(1.0, 0.68, wetAmt);',
    '  gl_FragColor.rgb += spoint_wetSpec * wetAmt * wetUpFacing * 1.4 * vec3(1.0, 1.0, 0.95);',
    '}'
  ].join('\n') + '\n' + THREE.ShaderChunk.fog_fragment
  if (THREE.UniformsLib && THREE.UniformsLib.fog && !THREE.UniformsLib.fog.spointWetness) THREE.UniformsLib.fog.spointWetness = _wetUniform
  if (THREE.ShaderLib) {
    for (const name in THREE.ShaderLib) {
      const lib = THREE.ShaderLib[name]
      if (lib && lib.uniforms && !lib.uniforms.spointWetness) lib.uniforms.spointWetness = _wetUniform
    }
  }
  if (typeof window !== 'undefined') {
    window.__wetnessTint = { installed: true, wetness: 0, setWetness, uniform: _wetUniform }
  }
}

let _liveWetness = 0

export function setWetness(w, scene) {
  installWetnessTint()
  const v = THREE.MathUtils.clamp(Number.isFinite(w) ? w : 0, 0, 1)
  _liveWetness = v
  _wetUniform.value[0] = v
  if (typeof window !== 'undefined') {
    window.__wetness = v
    if (window.__wetnessTint) window.__wetnessTint.wetness = v
  }
}

export function getWetness() { return _liveWetness }
