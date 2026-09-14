import * as THREE from 'three'
import { MeshBasicNodeMaterial, QuadMesh } from 'three/webgpu'
import { Fn, texture, uv, uniform, vec2, vec3, vec4, float, clamp, min, max, mix, dot } from 'three/tsl'
import { RenderControls } from './RenderControls.js'

const LUMA = vec3(0.2126, 0.7152, 0.0722)

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
