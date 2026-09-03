// SSAOWebGPU -- TSL node-graph port of SSAO.js's half-res G-buffer + horizon-based AO + composite
// pass, used only when the live renderer is a real THREE.WebGPURenderer (renderer.isWebGPURenderer
// === true).
//
// WHY A SEPARATE FILE (not an in-place rewrite of SSAO.js): SSAO.js's raw-GLSL ShaderMaterial path
// is still the ONLY implementation that runs under WebGLRenderer (the 100% non-experimental case);
// WebGPURenderer does not compile raw GLSL at all (see docs/webgpu-shader-audit.md), so this is a
// second, TSL-native implementation of the exact same algorithm, not a replacement. SSAO.js's own
// factory (installSSAO) is made renderer-polymorphic below exactly like FSR1.js's installFSR1 /
// Bloom.js's installBloom -- every caller (RenderGraph.nodes.js via buildSSAONodes, app.js) is
// unchanged, this is purely an additional backend. Precedent: client/core/FSR1WebGPU.js and
// client/core/BloomWebGPU.js, same file shape, same registerXWebGPU(mod) dynamic-import
// registration discipline.
//
// PORT NOTES:
//   - QuadMesh (three/webgpu export) replaces the hand-rolled `_quadScene`/`_quadCamera`/
//     `PlaneGeometry(2,2)` trio SSAO.js builds manually -- same primitive Bloom/FSR1WebGPU use.
//   - The G-buffer pass is the one piece SSAO.js's siblings don't need: `scene.overrideMaterial`
//     is honored by WebGPURenderer exactly like WebGLRenderer (a real THREE.Scene property, not a
//     WebGL-only mechanism), so the override strategy carries over unchanged -- only the override
//     material itself needs to be a TSL node material (MeshBasicNodeMaterial with a positionNode/
//     normalNode-driven colorNode) instead of a hand-rolled ShaderMaterial. Encoding is IDENTICAL
//     to SSAO.js's GLSL: rgb = view-space normal packed 0..1, a = linear view-space depth.
//   - `THREE.WebGLRenderTarget` -> `THREE.RenderTarget` (generic backend-agnostic base class,
//     confirmed safe in the FSR1WebGPU.js/BloomWebGPU.js ports).
//   - AO horizon-search math (4 directions x 3 steps) and MultiplyBlending composite are IDENTICAL
//     to SSAO.js's GLSL -- transcribed node-for-node into TSL's Fn() graph, not reapproximated.
//   - InstancedMesh2 per-instance transform: TSL's modelViewMatrix/normalMatrix built-ins already
//     resolve the instanced transform for a NodeMaterial the same way THREE's own instanced_vertex
//     chunk does for ShaderLib materials (confirmed via cross-reference against
//     BloomWebGPU.js/FSR1WebGPU.js's own "no per-instance complexity" full-screen-only scope note --
//     this file is the one exception that DOES touch per-instance scene geometry via overrideMaterial,
//     so it is flagged medium-risk relative to Bloom/FSR1's pure-post-process shape, though the math
//     itself needs no InstancedMesh2-specific handling since positionView/normalView are TSL's
//     already-instance-aware built-ins).

import * as THREE from 'three'
import { MeshBasicNodeMaterial, QuadMesh } from 'three/webgpu'
import {
  Fn, texture, uv, uniform, vec2, vec3, vec4, float, int,
  clamp, max, min, length, dot, normalize, positionView, normalView,
  varying, Loop, If,
} from 'three/tsl'
import { RenderControls } from './RenderControls.js'

// G-buffer encode: rgb = view-space normal packed 0..1, a = linear view-space depth (-positionView.z,
// matching SSAO.js's vViewDepth = -mvPosition.z).
function buildGBufferColorNode() {
  return Fn(() => {
    const n = normalize(normalView).mul(0.5).add(0.5)
    const d = positionView.z.negate()
    return vec4(n, d)
  })()
}

// Horizon-based AO -- same 4-direction/3-step kernel as SSAO.js's _aoFrag, transcribed to TSL.
function buildAoNode(gbufferTex, resolutionUniform, radiusUniform, intensityUniform, fovFactorUniform) {
  const reconstructViewPos = Fn(([uvIn, depth]) => {
    const ndc = uvIn.mul(2.0).sub(1.0)
    const aspect = resolutionUniform.x.div(resolutionUniform.y)
    const viewDir = normalize(vec3(ndc.x.mul(fovFactorUniform).mul(aspect), ndc.y.mul(fovFactorUniform), -1.0))
    const t = depth.div(max(0.0001, viewDir.z.negate()))
    return viewDir.mul(t)
  })

  return Fn(() => {
    const vUv = uv()
    const center = texture(gbufferTex, vUv)
    const centerDepth = center.a.toVar()
    const outColor = vec4(1.0, 1.0, 1.0, 1.0).toVar()

    If(centerDepth.greaterThan(0.0), () => {
      const centerNormal = normalize(center.rgb.mul(2.0).sub(1.0)).toVar()
      const centerPos = reconstructViewPos(vUv, centerDepth).toVar()

      const pixelRadius = clamp(
        max(2.0, radiusUniform.mul(resolutionUniform.y).div(max(1.0, centerDepth.mul(fovFactorUniform).mul(2.0)))),
        0.0, resolutionUniform.y.mul(0.25),
      ).toVar()

      const occlusion = float(0.0).toVar()
      const dirs = [vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0)]
      for (let d = 0; d < 4; d++) {
        const horizonCos = float(0.0).toVar()
        Loop({ start: int(1), end: int(4), type: 'int', condition: '<' }, ({ i }) => {
          const frac = float(i).div(3.0)
          const offsetUv = vUv.add(dirs[d].mul(pixelRadius.mul(frac).div(resolutionUniform))).toVar()
          If(offsetUv.x.greaterThanEqual(0.0).and(offsetUv.x.lessThanEqual(1.0)).and(offsetUv.y.greaterThanEqual(0.0)).and(offsetUv.y.lessThanEqual(1.0)), () => {
            const sampleG = texture(gbufferTex, offsetUv)
            If(sampleG.a.greaterThan(0.0), () => {
              const samplePos = reconstructViewPos(offsetUv, sampleG.a)
              const toSample = samplePos.sub(centerPos)
              const dist = length(toSample)
              If(dist.greaterThan(0.0001).and(dist.lessThanEqual(radiusUniform)), () => {
                const sampleCos = dot(centerNormal, toSample).div(dist)
                const falloff = clamp(float(1.0).sub(dist.div(radiusUniform)), 0.0, 1.0)
                horizonCos.assign(max(horizonCos, sampleCos.mul(falloff)))
              })
            })
          })
        })
        occlusion.addAssign(clamp(horizonCos, 0.0, 1.0))
      }
      const occ = occlusion.div(4.0)
      const ao = float(1.0).sub(clamp(occ.mul(intensityUniform), 0.0, 1.0))
      outColor.assign(vec4(ao, ao, ao, 1.0))
    })

    return outColor
  })()
}

function buildCompositeNode(aoTex) {
  return Fn(() => {
    const ao = texture(aoTex, uv()).r
    return vec4(ao, ao, ao, 1.0)
  })()
}

export class SSAOWebGPU {
  constructor(renderer, scene, camera) {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    this._w = 0
    this._h = 0
    this._built = false

    this._gbufferMat = new MeshBasicNodeMaterial({ side: THREE.DoubleSide })
    this._gbufferMat.colorNode = buildGBufferColorNode()

    this._resolutionUniform = uniform(new THREE.Vector2(1, 1))
    this._radiusUniform = uniform(RenderControls.get('ssaoRadius'))
    this._intensityUniform = uniform(RenderControls.get('ssaoIntensity'))
    this._fovFactorUniform = uniform(1)

    this._aoMat = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false })
    this._compositeMat = new MeshBasicNodeMaterial({
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.MultiplyBlending, premultipliedAlpha: true,
    })

    this._quad = new QuadMesh(this._aoMat)
  }

  _ensureTargets(fullW, fullH) {
    const w = Math.max(4, Math.floor(fullW * 0.5))
    const h = Math.max(4, Math.floor(fullH * 0.5))
    if (this._built && w === this._w && h === this._h) return
    this._disposeTargets()
    this._w = w; this._h = h
    this._gbufferTarget = new THREE.RenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    })
    this._aoTarget = new THREE.RenderTarget(w, h, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    })
    this._resolutionUniform.value.set(w, h)
    this._aoMat.colorNode = buildAoNode(
      this._gbufferTarget.texture, this._resolutionUniform, this._radiusUniform,
      this._intensityUniform, this._fovFactorUniform,
    )
    this._aoMat.needsUpdate = true
    this._compositeMat.colorNode = buildCompositeNode(this._aoTarget.texture)
    this._compositeMat.needsUpdate = true
    this._built = true
  }

  _disposeTargets() {
    if (this._gbufferTarget) this._gbufferTarget.dispose()
    if (this._aoTarget) this._aoTarget.dispose()
  }

  computeAO() {
    const size = new THREE.Vector2()
    this.renderer.getSize(size)
    if (size.x <= 0 || size.y <= 0) return
    this._ensureTargets(size.x, size.y)

    const prevTarget = this.renderer.getRenderTarget()
    const prevOverride = this.scene.overrideMaterial
    const prevAutoClear = this.renderer.autoClear
    const prevClearColor = new THREE.Color()
    this.renderer.getClearColor(prevClearColor)
    const prevClearAlpha = this.renderer.getClearAlpha()

    this.renderer.setRenderTarget(this._gbufferTarget)
    this.renderer.autoClear = true
    this.renderer.setClearColor(0x000000, 0)
    this.scene.overrideMaterial = this._gbufferMat
    this.renderer.render(this.scene, this.camera)
    this.scene.overrideMaterial = prevOverride

    const fov = this.camera.fov ? THREE.MathUtils.degToRad(this.camera.fov) : Math.PI / 3
    this._radiusUniform.value = RenderControls.get('ssaoRadius')
    this._intensityUniform.value = RenderControls.get('ssaoIntensity')
    this._fovFactorUniform.value = Math.tan(fov / 2)

    this._quad.material = this._aoMat
    this.renderer.setRenderTarget(this._aoTarget)
    this.renderer.autoClear = true
    this._quad.render(this.renderer)

    this.renderer.setRenderTarget(prevTarget)
    this.renderer.autoClear = prevAutoClear
    this.renderer.setClearColor(prevClearColor, prevClearAlpha)
    this.aoTexture = this._aoTarget.texture
  }

  composite() {
    if (!this.aoTexture) return
    this._quad.material = this._compositeMat
    const prevAutoClear = this.renderer.autoClear
    this.renderer.autoClear = false
    this._quad.render(this.renderer)
    this.renderer.autoClear = prevAutoClear
  }

  dispose() {
    this._disposeTargets()
    this._gbufferMat.dispose()
    this._aoMat.dispose()
    this._compositeMat.dispose()
  }
}
