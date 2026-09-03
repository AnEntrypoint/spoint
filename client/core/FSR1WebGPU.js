// FSR1WebGPU -- TSL node-graph port of FSR1.js's EASU+RCAS spatial-upscale/sharpen pass, used only
// when the live renderer is a real THREE.WebGPURenderer (renderer.isWebGPURenderer === true).
//
// WHY A SEPARATE FILE (not an in-place rewrite of FSR1.js): FSR1.js's raw-GLSL ShaderMaterial path
// is still the ONLY implementation that runs under WebGLRenderer (the 100% non-experimental case);
// WebGPURenderer does not compile raw GLSL at all (see docs/webgpu-shader-audit.md), so this is a
// second, TSL-native implementation of the exact same algorithm, not a replacement. FSR1.js's own
// factory (installFSR1) picks whichever of the two matches the live renderer's actual class, so
// every caller (RenderGraph.nodes.js, app.js) is unchanged -- this is purely an additional backend.
//
// PORT NOTES (webgpurenderer-tsl-port-lowrisk-fullscreen-passes, first slice):
//   - QuadMesh (three/webgpu export) is THREE's own shipped fullscreen-pass primitive -- it owns its
//     own baked orthographic camera + 2x2 NDC-quad geometry, replacing the hand-rolled
//     `_quadScene`/`_quadCamera`/`PlaneGeometry(2,2)` trio FSR1.js builds manually. `quad.render(
//     renderer)` internally does `renderer.render(quad, quad.camera)` -- same call FSR1.js makes,
//     just via the primitive instead of re-deriving it.
//   - `THREE.WebGLRenderTarget` -> `THREE.RenderTarget` (the generic, backend-agnostic base class;
//     WebGLRenderTarget merely extends it -- confirmed via `Object.getPrototypeOf(WebGLRenderTarget)
//     === RenderTarget` at audit time). HalfFloatType/RGBAFormat/filter options carry over unchanged.
//   - `renderer.copyFramebufferToTexture` exists on WebGPURenderer too (three.webgpu.js Renderer
//     class + backend-level WebGPUBackend/WebGLBackend implementations, confirmed via source read),
//     so the "copy current canvas into a sampleable texture" step needs zero API change -- only the
//     two shader passes (EASU, RCAS) and the composite pass need a TSL rewrite.
//   - EASU/RCAS math is IDENTICAL to FSR1.js's GLSL (same simplified 5-tap directional-gradient
//     resample + real AMD RCAS anti-ringing formula) -- transcribed node-for-node into TSL's Fn()
//     graph, not reapproximated, so this is a mechanical port of proven-correct math, not a redesign.
//   - No history buffer / no per-instance complexity / no InstancedMesh2 coupling (this is exactly
//     the audit's "TSL-portable, low risk, full-screen post-process" bucket) -- confirmed by reading
//     FSR1.js in full before porting: it is a pure 2-pass fullscreen shader chain with plain sampler2D
//     inputs, nothing WebGPU-specific to design around beyond the mechanical API swaps above.

import * as THREE from 'three'
// MeshBasicNodeMaterial/QuadMesh only exist on the WebGPU build's export surface (confirmed via a
// live `'MeshBasicNodeMaterial' in THREE` false-vs-true probe against 'three' vs 'three/webgpu') --
// this file is only ever imported when a real WebGPURenderer is already live (see FSR1.js's
// isWebGPURenderer-gated registerFSR1WebGPU/installFSR1), so importing the WebGPU build here is not
// an extra cost the WebGL-only 100% of sessions pay (dynamic-imported at that same gated call site).
import { MeshBasicNodeMaterial, QuadMesh } from 'three/webgpu'
import { Fn, texture, uv, uniform, vec2, vec3, vec4, float, clamp, min, max, mix, dot } from 'three/tsl'
import { RenderControls } from './RenderControls.js'

const LUMA = vec3(0.2126, 0.7152, 0.0722)

// EASU: local 3x3-cross min/max luminance contrast drives a blend between a plain center sample
// (flat regions) and a directional-neighbor-weighted sharpen (edges) -- same simplified technique
// FSR1.js's GLSL uses (WebGL2 GLSL ES 3.00 has no textureGather, so the real AMD 32-tap gather is
// approximated the same way in both implementations).
function buildEasuNode(sourceTex, srcTexel) {
  return Fn(() => {
    const uvCoord = uv()
    const center = texture(sourceTex, uvCoord).rgb.toVar()
    const n = texture(sourceTex, uvCoord.add(vec2(0.0, srcTexel.y.negate()))).rgb.toVar()
    const s = texture(sourceTex, uvCoord.add(vec2(0.0, srcTexel.y))).rgb.toVar()
    const e = texture(sourceTex, uvCoord.add(vec2(srcTexel.x, 0.0))).rgb.toVar()
    const w = texture(sourceTex, uvCoord.add(vec2(srcTexel.x.negate(), 0.0))).rgb.toVar()
    const lc = dot(center, LUMA)
    const ln = dot(n, LUMA)
    const ls = dot(s, LUMA)
    const le = dot(e, LUMA)
    const lw = dot(w, LUMA)
    const lmin = min(lc, min(min(ln, ls), min(le, lw)))
    const lmax = max(lc, max(max(ln, ls), max(le, lw)))
    const contrast = clamp(lmax.sub(lmin).mul(4.0), 0.0, 1.0)
    const dirAvg = n.add(s).add(e).add(w).mul(0.25)
    const sharp = center.mul(float(1.0).add(contrast.mul(0.5))).sub(dirAvg.mul(contrast.mul(0.5)))
    return vec4(mix(center, sharp, contrast), 1.0)
  })()
}

// RCAS: real AMD peak-sharpen formula (local min/max headroom ratio -> anti-ringing-clamped sharpen
// weight), identical math to FSR1.js's GLSL RCAS pass. w4 (the sharpen weight) is a per-channel
// vec3, so the denominator (1 + 4*w4) must also stay a vec3 -- matching the GLSL exactly.
function buildRcasNode(sourceTex, texel, sharpness) {
  return Fn(() => {
    const uvCoord = uv()
    const c = texture(sourceTex, uvCoord).rgb.toVar()
    const n = texture(sourceTex, uvCoord.add(vec2(0.0, texel.y.negate()))).rgb.toVar()
    const s = texture(sourceTex, uvCoord.add(vec2(0.0, texel.y))).rgb.toVar()
    const e = texture(sourceTex, uvCoord.add(vec2(texel.x, 0.0))).rgb.toVar()
    const w = texture(sourceTex, uvCoord.add(vec2(texel.x.negate(), 0.0))).rgb.toVar()
    const mn4 = min(min(n, s), min(e, w))
    const mx4 = max(max(n, s), max(e, w))
    const mn = min(mn4, c)
    const mx = max(mx4, c)
    const reciprocalMx = float(1.0).div(max(mx, vec3(0.0001)))
    const ampl = clamp(min(mn, vec3(2.0).sub(mx)).mul(reciprocalMx), vec3(0.0), vec3(1.0)).sqrt()
    const w4 = ampl.mul(mix(vec3(-0.125), vec3(-0.20), sharpness))
    const numerator = w4.mul(n.add(s).add(e).add(w)).add(c)
    const denominatorVec = vec3(1.0).add(w4.mul(4.0))
    const result = numerator.div(denominatorVec)
    return vec4(clamp(result, 0.0, 4.0), 1.0)
  })()
}

export class FSR1WebGPU {
  constructor(renderer) {
    this.renderer = renderer
    this._built = false

    this._srcTexelUniform = uniform(new THREE.Vector2(0, 0))
    this._rcasTexelUniform = uniform(new THREE.Vector2(0, 0))
    this._sharpnessUniform = uniform(RenderControls.get('fsr1Sharpness'))

    this._easuMat = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false })
    this._rcasMat = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false })
    this._compositeMat = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false })

    this._quad = new QuadMesh(this._easuMat)
  }

  _ensureTargets(w, h) {
    if (this._built && w === this._w && h === this._h) return
    this._disposeTargets()
    this._w = w; this._h = h
    const opts = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    }
    this._easuTarget = new THREE.RenderTarget(w, h, opts)
    this._rcasTarget = new THREE.RenderTarget(w, h, opts)
    this._sceneCopyTex = new THREE.FramebufferTexture(w, h)

    this._srcTexelUniform.value.set(1 / w, 1 / h)
    this._rcasTexelUniform.value.set(1 / w, 1 / h)
    this._easuMat.colorNode = buildEasuNode(this._sceneCopyTex, this._srcTexelUniform)
    this._easuMat.needsUpdate = true
    this._rcasMat.colorNode = buildRcasNode(this._easuTarget.texture, this._rcasTexelUniform, this._sharpnessUniform)
    this._rcasMat.needsUpdate = true
    this._compositeMat.colorNode = Fn(() => vec4(texture(this._rcasTarget.texture, uv()).rgb, 1.0))()
    this._compositeMat.needsUpdate = true

    this._built = true
  }

  _disposeTargets() {
    if (this._easuTarget) this._easuTarget.dispose()
    if (this._rcasTarget) this._rcasTarget.dispose()
    if (this._sceneCopyTex) this._sceneCopyTex.dispose()
  }

  compute() {
    const size = new THREE.Vector2()
    this.renderer.getSize(size)
    const pr = this.renderer.getPixelRatio ? this.renderer.getPixelRatio() : 1
    const w = Math.max(4, Math.round(size.x * pr))
    const h = Math.max(4, Math.round(size.y * pr))
    if (w <= 0 || h <= 0) return
    this._ensureTargets(w, h)

    const prevTarget = this.renderer.getRenderTarget()
    if (prevTarget !== null) { this.renderer.setRenderTarget(prevTarget); return }

    try {
      this.renderer.copyFramebufferToTexture(this._sceneCopyTex)
    } catch (_) {
      // Same fail-soft discipline as FSR1.js: skip this frame's upscale rather than throwing
      // mid-RenderGraph if the backend refuses the copy.
      return
    }

    this._sharpnessUniform.value = RenderControls.get('fsr1Sharpness')

    this._quad.material = this._easuMat
    this.renderer.setRenderTarget(this._easuTarget)
    this._quad.render(this.renderer)

    this._quad.material = this._rcasMat
    this.renderer.setRenderTarget(this._rcasTarget)
    this._quad.render(this.renderer)

    this.outputTexture = this._rcasTarget.texture
    this.renderer.setRenderTarget(prevTarget)
  }

  composite() {
    if (!this.outputTexture) return
    this._quad.material = this._compositeMat
    this._quad.render(this.renderer)
  }

  dispose() {
    this._disposeTargets()
    this._easuMat.dispose()
    this._rcasMat.dispose()
    this._compositeMat.dispose()
  }
}
