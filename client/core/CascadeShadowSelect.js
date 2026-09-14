import * as THREE from 'three'

const _SPLITS_RE = /SPOINT_CASCADE_SPLITS\[3\] = float\[3\]\([^)]*\)/

const BLEND_M = 4.0

let _installed = false
let _cascadeCount = 1

export function installCascadeShadowSelect(cascadeCount, splitExtents) {
  if (!Number.isFinite(cascadeCount) || cascadeCount <= 1) return
  _cascadeCount = Math.max(1, Math.min(3, Math.round(cascadeCount)))
  if (_installed) { setCascadeSplits(splitExtents); return }

  const parsChunk = THREE.ShaderChunk.shadowmap_pars_fragment
  const parsMarker = 'uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];'
  const anchor = parsChunk.indexOf(parsMarker)
  if (anchor === -1) return

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

  const chunk = THREE.ShaderChunk.lights_fragment_begin
  const marker = 'DirectionalLightShadow directionalLightShadow;'
  const idx = chunk.indexOf(marker)
  if (idx === -1) return

  const patched = chunk.slice(0, idx) + marker +
    '\nfloat spointCamDist = length( geometryPosition );\n' +
    chunk.slice(idx + marker.length)

  const getShadowRe = /directLight\.color \*= \( directLight\.visible && receiveShadow \) \? getShadow\( directionalShadowMap\[ i \], directionalLightShadow\.shadowMapSize, directionalLightShadow\.shadowIntensity, directionalLightShadow\.shadowBias, directionalLightShadow\.shadowRadius, vDirectionalShadowCoord\[ i \] \) : 1\.0;/
  const finalChunk = patched.replace(getShadowRe,
    'directLight.color *= ( directLight.visible && receiveShadow ) ? mix( 1.0, getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ), spointCascadeWeight( UNROLLED_LOOP_INDEX, spointCamDist ) ) : 1.0;'
  )
  if (finalChunk === patched) return

  THREE.ShaderChunk.shadowmap_pars_fragment = patchedPars
  THREE.ShaderChunk.lights_fragment_begin = finalChunk
  _installed = true
  setCascadeSplits(splitExtents)
  if (typeof window !== 'undefined') {
    window.__cascadeShadowSelect = { installed: true, cascadeCount: _cascadeCount, splits: splitExtents ? splitExtents.slice() : null, setCascadeSplits }
  }
}

export function setCascadeSplits(extents, scene) {
  if (!_installed || !Array.isArray(extents)) return
  const e = [extents[0] || 0, extents[1] || 0, extents[2] || 0]
  const literal = 'SPOINT_CASCADE_SPLITS[3] = float[3](' + e.map(v => v.toFixed(2)).join(', ') + ')'
  THREE.ShaderChunk.shadowmap_pars_fragment = THREE.ShaderChunk.shadowmap_pars_fragment.replace(_SPLITS_RE, literal)
  if (scene) scene.traverse(o => { const m = o.material; if (!m) return; for (const mm of (Array.isArray(m) ? m : [m])) mm.needsUpdate = true })
  if (typeof window !== 'undefined' && window.__cascadeShadowSelect) window.__cascadeShadowSelect.splits = e.slice()
}

export function isCascadeShadowSelectInstalled() { return _installed }
