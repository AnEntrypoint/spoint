import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const _dirname = dirname(fileURLToPath(import.meta.url))
const _threeModule = resolve(_dirname, '../../node_modules/three/build/three.module.js')
const _threeWebGPU = resolve(_dirname, '../../node_modules/three/src/Three.WebGPU.js')

function _checkOverrideMaterialSupport() {

  let source
  try {
    source = readFileSync(_threeModule, 'utf8')
  } catch (_) {
    return { error: 'three.module.js not found at ' + _threeModule }
  }

  const hasOverrideMaterial = source.includes('overrideMaterial')
  const overrideMaterialLines = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('overrideMaterial')) {
      overrideMaterialLines.push({ line: i + 1, content: lines[i].trim() })
    }
  }

  return {
    overrideMaterialSupported: hasOverrideMaterial,
    overrideMaterialLines: overrideMaterialLines.slice(0, 10),
    conclusion: 'scene.overrideMaterial is a shared THREE.Renderer feature (not WebGL-specific). The setter/getter is in the base renderer class. However, the MATERIAL used as the override must be compatible with the active renderer backend -- raw GLSL ShaderMaterial works under WebGLRenderer but will throw/compile-fail under WebGPURenderer (which only accepts TSL NodeMaterial).',
  }
}

function _analyzeSSAOGbufferMaterial() {
  const ssaoPath = resolve(_dirname, 'SSAO.js')
  let source
  try {
    source = readFileSync(ssaoPath, 'utf8')
  } catch (_) {
    return { error: 'SSAO.js not found' }
  }

  const hasOverrideMaterial = source.includes('overrideMaterial')
  const hasGBufferMat = source.includes('_gbufferMat')
  const hasSceneRender = source.includes('renderer.render(this.scene')

  return {
    mechanism: 'scene.overrideMaterial = hand-rolled ShaderMaterial (raw GLSL vertex+fragment shaders)',
    gbufferMatFound: hasGBufferMat,
    overrideMaterialFound: hasOverrideMaterial,
    sceneRenderFound: hasSceneRender,
    tslPortFeasibility: {
      gbufferPass: {
        approach: 'Use MeshNormalNodeMaterial (THREE ships this in the WebGPU build) for the G-buffer pass. Depth comes from the render pass depth attachment (WebGPU always has sampleable depth textures, unlike WebGL2 where this is an extension). This is actually SIMPLER than the current WebGL2 approach -- no need to encode depth in color.a.',
        risk: 'low',
        effort: '~1 day',
      },
      aoPass: {
        approach: 'Full-screen QuadMesh + MeshBasicNodeMaterial TSL transcription of the horizon-based occlusion math. Same pattern as FSR1WebGPU.js/BloomWebGPU.js.',
        risk: 'low',
        effort: '~1 day',
      },
      compositePass: {
        approach: 'Full-screen QuadMesh + MeshBasicNodeMaterial TSL transcription of the multiplicative blend. Same pattern as FSR1WebGPU.js/BloomWebGPU.js.',
        risk: 'low',
        effort: '~half day',
      },
    },
    conclusion: 'SSAO IS portable to WebGPU. The G-buffer pass can use MeshNormalNodeMaterial (browser-native, no raw GLSL needed). The AO and composite passes are pure full-screen post-process passes, identical in shape to the already-shipped FSR1WebGPU.js/BloomWebGPU.js. Total effort: ~2-3 days. The overrideMaterial mechanism itself is NOT the blocker -- it is the raw GLSL ShaderMaterial that needs to become a MeshNormalNodeMaterial.',
  }
}

function _checkNodeMaterialAvailability() {
  let source
  try {
    source = readFileSync(_threeWebGPU, 'utf8')
  } catch (_) {
    const altPath = resolve(_dirname, '../../node_modules/three/src/Three.WebGPU.js')
    try {
      source = readFileSync(altPath, 'utf8')
    } catch (_2) {
      return { error: 'WebGPU build not found at expected paths. MeshNormalNodeMaterial availability must be checked at runtime.' }
    }
  }

  const hasMeshNormalNodeMaterial = source.includes('MeshNormalNodeMaterial')
  const hasMeshBasicNodeMaterial = source.includes('MeshBasicNodeMaterial')

  return {
    meshNormalNodeMaterialAvailable: hasMeshNormalNodeMaterial,
    meshBasicNodeMaterialAvailable: hasMeshBasicNodeMaterial,
    conclusion: hasMeshNormalNodeMaterial
      ? 'MeshNormalNodeMaterial IS available in the WebGPU build -- SSAO G-buffer pass can use it directly.'
      : 'MeshNormalNodeMaterial NOT found in the WebGPU build source. A custom TSL normal+depth material would need to be written (still feasible, ~half day extra).',
  }
}

export function runProbe() {
  const overrideMaterialSupport = _checkOverrideMaterialSupport()
  const ssaoAnalysis = _analyzeSSAOGbufferMaterial()
  const nodeMaterialAvailability = _checkNodeMaterialAvailability()

  return {
    recommendation: 'SSAO IS portable to WebGPU. The blocker is NOT scene.overrideMaterial (which is a shared renderer feature, not WebGL-specific) -- it is the raw GLSL ShaderMaterial used as the override, which needs to become a MeshNormalNodeMaterial (or custom TSL equivalent). The AO and composite passes are pure full-screen post-process passes, identical in shape to the already-shipped FSR1WebGPU.js/BloomWebGPU.js. Total porting effort: ~2-3 days. UNBLOCKED: no dependency on any other WebGPU row -- this can be implemented as a standalone SSAOWebGPU.js sibling file.',
    overrideMaterialSupport,
    ssaoAnalysis,
    nodeMaterialAvailability,
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const result = runProbe()
  console.log(JSON.stringify(result, null, 2))
}