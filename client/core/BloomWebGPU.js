// BloomWebGPU -- TSL node-graph port of Bloom.js's threshold-extract + separable-blur +
// additive-composite pass, used only when the live renderer is a real THREE.WebGPURenderer
// (renderer.isWebGPURenderer === true).
//
// WHY A SEPARATE FILE (not an in-place rewrite of Bloom.js): Bloom.js's raw-GLSL ShaderMaterial
// path is still the ONLY implementation that runs under WebGLRenderer (the 100% non-experimental
// case); WebGPURenderer does not compile raw GLSL at all (see docs/webgpu-shader-audit.md), so
// this is a second, TSL-native implementation of the exact same algorithm, not a replacement.
// Bloom.js's own factory (installBloom) is made renderer-polymorphic below exactly like FSR1.js's
// installFSR1 -- every caller (RenderGraph.nodes.js via buildBloomNodes, app.js) is unchanged,
// this is purely an additional backend. Precedent: client/core/FSR1WebGPU.js (first slice of
// webgpurenderer-tsl-port-lowrisk-fullscreen-passes-remaining-8), same file shape, same
// registerXWebGPU(mod) dynamic-import registration discipline.
//
// PORT NOTES:
//   - QuadMesh (three/webgpu export) replaces the hand-rolled `_quadScene`/`_quadCamera`/
//     `PlaneGeometry(2,2)` trio Bloom.js builds manually -- same primitive FSR1WebGPU.js uses.
//   - `THREE.WebGLRenderTarget` -> `THREE.RenderTarget` (generic backend-agnostic base class,
//     confirmed safe in the FSR1WebGPU.js port).
//   - Threshold/blur/composite math is IDENTICAL to Bloom.js's GLSL (same soft-knee luminance
//     bright-pass, same 9-tap separable box blur weights, same additive composite) -- transcribed
//     node-for-node into TSL's Fn() graph, not reapproximated.
//   - AdditiveBlending is a real THREE.Material blending mode (not a WebGL-only enum) -- carries
//     over unchanged onto MeshBasicNodeMaterial.
//   - No G-buffer / no scene.overrideMaterial coupling (unlike SSAO.js) -- this is a pure
//     canvas-read-back full-screen pass, exactly the audit's "TSL-portable, low risk" bucket.

import * as THREE from 'three'
import { MeshBasicNodeMaterial, QuadMesh } from 'three/webgpu'
import { Fn, texture, uv, uniform, vec2, vec3, vec4, float, clamp, max, mix, dot } from 'three/tsl'
import { RenderControls } from './RenderControls.js'

const LUMA = vec3(0.2126, 0.7152, 0.0722)

// Soft-knee luminance bright-pass -- identical math to Bloom.js's _thresholdFrag.
function buildThresholdNode(sceneTex, thresholdUniform, kneeUniform) {
  return Fn(() => {
    const c = texture(sceneTex, uv()).rgb.toVar()
    const lum = dot(c, LUMA)
    const soft = clamp(lum.sub(thresholdUniform).add(kneeUniform), 0.0, kneeUniform.mul(2.0)).toVar()
    soft.assign(soft.mul(soft).div(max(0.0001, kneeUniform.mul(4.0))))
    const contribution = max(soft, lum.sub(thresholdUniform))
    const scale = lum.greaterThan(0.0001).select(contribution.div(lum), float(0.0))
    return vec4(c.mul(clamp(scale, 0.0, 1.0)), 1.0)
  })()
}

// 9-tap separable box blur -- identical weights to Bloom.js's _blurFrag.
function buildBlurNode(sourceTex, directionUniform) {
  return Fn(() => {
    const uvCoord = uv()
    const sum = texture(sourceTex, uvCoord).rgb.mul(0.227).toVar()
    for (let i = 1; i <= 4; i++) {
      const w = 0.194 - i * 0.03
      const o = directionUniform.mul(float(i))
      sum.addAssign(texture(sourceTex, uvCoord.add(o)).rgb.mul(w))
      sum.addAssign(texture(sourceTex, uvCoord.sub(o)).rgb.mul(w))
    }
    return vec4(max(sum, 0.0), 1.0)
  })()
}

function buildCompositeNode(bloomTex, intensityUniform) {
  return Fn(() => vec4(texture(bloomTex, uv()).rgb.mul(intensityUniform), 1.0))()
}

export class BloomWebGPU {
  constructor(renderer) {
    this.renderer = renderer
    this._w = 0
    this._h = 0
    this._built = false

    this._thresholdUniform = uniform(RenderControls.get('bloomThreshold'))
    this._kneeUniform = uniform(0.15)
    this._hDirUniform = uniform(new THREE.Vector2(0, 0))
    this._vDirUniform = uniform(new THREE.Vector2(0, 0))
    this._intensityUniform = uniform(RenderControls.get('bloomIntensity'))

    this._thresholdMat = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false })
    this._blurMatH = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false })
    this._blurMatV = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false })
    this._compositeMat = new MeshBasicNodeMaterial({
      depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
    })

    this._quad = new QuadMesh(this._thresholdMat)
  }

  _ensureTargets(fullW, fullH) {
    const scale = RenderControls.get('bloomResolutionScale') || 0.5
    const w = Math.max(4, Math.floor(fullW * scale))
    const h = Math.max(4, Math.floor(fullH * scale))
    const fullResChanged = fullW !== this._fullW || fullH !== this._fullH
    if (this._built && w === this._w && h === this._h && !fullResChanged) return
    this._disposeTargets()
    this._w = w; this._h = h
    this._fullW = fullW; this._fullH = fullH
    const opts = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    }
    this._brightTarget = new THREE.RenderTarget(w, h, opts)
    this._pingTarget = new THREE.RenderTarget(w, h, opts)
    this._sceneCopyTex = new THREE.FramebufferTexture(fullW, fullH)

    this._hDirUniform.value.set(1 / w, 0)
    this._vDirUniform.value.set(0, 1 / h)

    this._thresholdMat.colorNode = buildThresholdNode(this._sceneCopyTex, this._thresholdUniform, this._kneeUniform)
    this._thresholdMat.needsUpdate = true
    this._blurMatH.colorNode = buildBlurNode(this._brightTarget.texture, this._hDirUniform)
    this._blurMatH.needsUpdate = true
    this._blurMatV.colorNode = buildBlurNode(this._pingTarget.texture, this._vDirUniform)
    this._blurMatV.needsUpdate = true
    // Bidirectional blur nodes: buildBlurNode above is rebuilt against whichever target is
    // currently the SOURCE of a given ping-pong iteration -- since compute() below always reads
    // _brightTarget->_pingTarget for H and _pingTarget->_brightTarget for V (never swapping which
    // target plays which role, unlike Bloom.js's generic src/dst swap loop), a single fixed pair of
    // H/V materials is sufficient; see compute() for the fixed 1-pass ping-pong this simplification
    // assumes (RenderControls('bloomBlurPasses') > 1 loops the SAME two materials/targets, which is
    // still correct since each iteration's source texture is read fresh via the same texture node).
    this._built = true
  }

  _disposeTargets() {
    if (this._brightTarget) this._brightTarget.dispose()
    if (this._pingTarget) this._pingTarget.dispose()
    if (this._sceneCopyTex) this._sceneCopyTex.dispose()
  }

  compute() {
    const size = new THREE.Vector2()
    this.renderer.getSize(size)
    if (size.x <= 0 || size.y <= 0) return
    this._ensureTargets(size.x, size.y)

    const prevTarget = this.renderer.getRenderTarget()
    if (prevTarget !== null) { this.renderer.setRenderTarget(prevTarget); return }

    try {
      this.renderer.copyFramebufferToTexture(this._sceneCopyTex)
    } catch (_) {
      // Same fail-soft discipline as Bloom.js/FSR1WebGPU.js: skip this frame's bloom rather than
      // throwing mid-RenderGraph if the backend refuses the copy.
      return
    }

    this._thresholdUniform.value = RenderControls.get('bloomThreshold')

    this._quad.material = this._thresholdMat
    this.renderer.setRenderTarget(this._brightTarget)
    this._quad.render(this.renderer)

    const passes = Math.max(1, RenderControls.get('bloomBlurPasses') || 1)
    for (let i = 0; i < passes; i++) {
      this._quad.material = this._blurMatH
      this.renderer.setRenderTarget(this._pingTarget)
      this._quad.render(this.renderer)

      this._quad.material = this._blurMatV
      this.renderer.setRenderTarget(this._brightTarget)
      this._quad.render(this.renderer)
    }
    this.bloomTexture = this._brightTarget.texture

    this.renderer.setRenderTarget(prevTarget)
  }

  composite() {
    if (!this.bloomTexture) return
    if (!this._compositeMat.colorNode) {
      this._compositeMat.colorNode = buildCompositeNode(this.bloomTexture, this._intensityUniform)
      this._compositeMat.needsUpdate = true
    }
    this._intensityUniform.value = RenderControls.get('bloomIntensity')
    this._quad.material = this._compositeMat
    this._quad.render(this.renderer)
  }

  dispose() {
    this._disposeTargets()
    this._thresholdMat.dispose()
    this._blurMatH.dispose()
    this._blurMatV.dispose()
    this._compositeMat.dispose()
  }
}
