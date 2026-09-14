import * as THREE from 'three'
import { RenderControls } from './RenderControls.js'

const _fullscreenVert = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

const _easuFrag = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tSource;
  uniform vec2 uSrcTexel;
  void main() {
    vec2 uv = vUv;
    vec3 center = texture2D(tSource, uv).rgb;
    vec3 n = texture2D(tSource, uv + vec2(0.0, -uSrcTexel.y)).rgb;
    vec3 s = texture2D(tSource, uv + vec2(0.0,  uSrcTexel.y)).rgb;
    vec3 e = texture2D(tSource, uv + vec2( uSrcTexel.x, 0.0)).rgb;
    vec3 w = texture2D(tSource, uv + vec2(-uSrcTexel.x, 0.0)).rgb;
    float lc = dot(center, vec3(0.2126, 0.7152, 0.0722));
    float ln = dot(n, vec3(0.2126, 0.7152, 0.0722));
    float ls = dot(s, vec3(0.2126, 0.7152, 0.0722));
    float le = dot(e, vec3(0.2126, 0.7152, 0.0722));
    float lw = dot(w, vec3(0.2126, 0.7152, 0.0722));
    float lmin = min(lc, min(min(ln, ls), min(le, lw)));
    float lmax = max(lc, max(max(ln, ls), max(le, lw)));
    float contrast = clamp((lmax - lmin) * 4.0, 0.0, 1.0);
    vec3 dirAvg = (n + s + e + w) * 0.25;
    vec3 sharp = center * (1.0 + contrast * 0.5) - dirAvg * (contrast * 0.5);
    gl_FragColor = vec4(mix(center, sharp, contrast), 1.0);
  }
`

const _rcasFrag = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tSource;
  uniform vec2 uTexel;
  uniform float uSharpness;
  void main() {
    vec2 uv = vUv;
    vec3 c  = texture2D(tSource, uv).rgb;
    vec3 n  = texture2D(tSource, uv + vec2(0.0, -uTexel.y)).rgb;
    vec3 s  = texture2D(tSource, uv + vec2(0.0,  uTexel.y)).rgb;
    vec3 e  = texture2D(tSource, uv + vec2( uTexel.x, 0.0)).rgb;
    vec3 w  = texture2D(tSource, uv + vec2(-uTexel.x, 0.0)).rgb;
    vec3 mn4 = min(min(n, s), min(e, w));
    vec3 mx4 = max(max(n, s), max(e, w));
    vec3 mn = min(mn4, c);
    vec3 mx = max(mx4, c);
    vec3 reciprocalMx = 1.0 / max(mx, vec3(0.0001));
    vec3 ampl = clamp(min(mn, vec3(2.0) - mx) * reciprocalMx, vec3(0.0), vec3(1.0));
    ampl = sqrt(ampl);
    vec3 w4 = ampl * mix(vec3(-0.125), vec3(-0.20), uSharpness);
    vec3 numerator = w4 * (n + s + e + w) + c;
    vec3 denominator = vec3(1.0) + 4.0 * w4;
    vec3 result = numerator / denominator;
    gl_FragColor = vec4(clamp(result, 0.0, 4.0), 1.0);
  }
`

const _compositeFrag = `
  precision highp float;
  in vec2 vUv;
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  out vec4 fragColor;
  void main() {
    fragColor = vec4(texture(tColor, vUv).rgb, 1.0);
    gl_FragDepth = texture(tDepth, vUv).r;
  }
`
const _compositeVert = `
  out vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

export class ThreeVdrs {
  constructor(renderer, scene, camera) {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    this._built = false
    this._hasContent = false

    this._quadScene = new THREE.Scene()
    this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this._quadGeo = new THREE.PlaneGeometry(2, 2)

    this._easuMat = new THREE.ShaderMaterial({
      vertexShader: _fullscreenVert,
      fragmentShader: _easuFrag,
      uniforms: { tSource: { value: null }, uSrcTexel: { value: new THREE.Vector2(0, 0) } },
      depthTest: false,
      depthWrite: false,
    })
    this._rcasMat = new THREE.ShaderMaterial({
      vertexShader: _fullscreenVert,
      fragmentShader: _rcasFrag,
      uniforms: { tSource: { value: null }, uTexel: { value: new THREE.Vector2(0, 0) }, uSharpness: { value: RenderControls.get('threeVdrsSharpness') } },
      depthTest: false,
      depthWrite: false,
    })
    this._compositeMat = new THREE.ShaderMaterial({
      vertexShader: _compositeVert,
      fragmentShader: _compositeFrag,
      glslVersion: THREE.GLSL3,
      uniforms: { tColor: { value: null }, tDepth: { value: null } },
      depthTest: true,
      depthWrite: true,
    })
    this._quad = new THREE.Mesh(this._quadGeo, this._easuMat)
    this._quad.frustumCulled = false
    this._quadScene.add(this._quad)
  }

  _ensureLowResTarget(lowW, lowH) {
    if (this._lowTarget && this._lowW === lowW && this._lowH === lowH) return
    if (this._lowTarget) this._lowTarget.dispose()
    this._lowW = lowW; this._lowH = lowH
    this._lowTarget = new THREE.WebGLRenderTarget(lowW, lowH, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      depthTexture: new THREE.DepthTexture(lowW, lowH, THREE.UnsignedIntType),
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    })
  }

  _ensureUpscaleTargets(fullW, fullH) {
    if (this._built && this._fullW === fullW && this._fullH === fullH) return
    this._disposeUpscaleTargets()
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
    this._easuTarget = new THREE.WebGLRenderTarget(fullW, fullH, opts)
    this._rcasTarget = new THREE.WebGLRenderTarget(fullW, fullH, opts)
    this._built = true
  }

  _disposeUpscaleTargets() {
    if (this._easuTarget) this._easuTarget.dispose()
    if (this._rcasTarget) this._rcasTarget.dispose()
  }

  _disposeLowResTarget() {
    if (this._lowTarget) this._lowTarget.dispose()
  }

  compute(scale) {
    const size = new THREE.Vector2()
    this.renderer.getSize(size)
    const pr = this.renderer.getPixelRatio ? this.renderer.getPixelRatio() : 1
    const fullW = Math.max(4, Math.round(size.x * pr))
    const fullH = Math.max(4, Math.round(size.y * pr))
    if (fullW <= 0 || fullH <= 0) { this._hasContent = false; return }
    const s = Math.min(1.0, Math.max(0.3, scale || 1.0))
    const lowW = Math.max(4, Math.round(fullW * s))
    const lowH = Math.max(4, Math.round(fullH * s))
    this._ensureLowResTarget(lowW, lowH)
    this._ensureUpscaleTargets(fullW, fullH)

    const prevTarget = this.renderer.getRenderTarget()
    const prevAutoClear = this.renderer.autoClear

    this.renderer.setRenderTarget(this._lowTarget)
    this.renderer.autoClear = true
    this.renderer.clear(true, true, false)
    this.renderer.render(this.scene, this.camera)

    this._easuMat.uniforms.tSource.value = this._lowTarget.texture
    this._easuMat.uniforms.uSrcTexel.value.set(1 / lowW, 1 / lowH)
    this._quad.material = this._easuMat
    this.renderer.setRenderTarget(this._easuTarget)
    this.renderer.autoClear = true
    this.renderer.render(this._quadScene, this._quadCamera)

    this._rcasMat.uniforms.tSource.value = this._easuTarget.texture
    this._rcasMat.uniforms.uTexel.value.set(1 / fullW, 1 / fullH)
    this._rcasMat.uniforms.uSharpness.value = RenderControls.get('threeVdrsSharpness')
    this._quad.material = this._rcasMat
    this.renderer.setRenderTarget(this._rcasTarget)
    this.renderer.autoClear = true
    this.renderer.render(this._quadScene, this._quadCamera)

    this.outputColorTexture = this._rcasTarget.texture
    this.outputDepthTexture = this._lowTarget.depthTexture
    this.renderer.setRenderTarget(prevTarget)
    this.renderer.autoClear = prevAutoClear
    this._hasContent = true
  }

  composite(hasTerrain) {
    if (!this._hasContent) return
    this._compositeMat.uniforms.tColor.value = this.outputColorTexture
    this._compositeMat.uniforms.tDepth.value = this.outputDepthTexture
    this._quad.material = this._compositeMat
    const prevAutoClear = this.renderer.autoClear
    if (hasTerrain) this.renderer.autoClear = false
    this.renderer.render(this._quadScene, this._quadCamera)
    if (hasTerrain) this.renderer.autoClear = true
    else this.renderer.autoClear = prevAutoClear
  }

  dispose() {
    this._disposeUpscaleTargets()
    this._disposeLowResTarget()
    this._easuMat.dispose()
    this._rcasMat.dispose()
    this._compositeMat.dispose()
    this._quadGeo.dispose()
  }
}

export function createThreeVdrsController() {
  let scale = 1, appliedOn = false, appliedScale = -1, acc = 0, n = 0
  const TARGET = 6.94
  const WIN = 45
  const MIN = 0.5, MAX = 1.0, STEP = 0.1
  function tick(ms) {
    if (typeof window === 'undefined' || !window.__threeVdrsAuto || window.__threeVdrsOff) return
    acc += ms; n++
    if (n < WIN) return
    const avg = acc / n; acc = 0; n = 0
    if (avg > TARGET * 1.15 && scale > MIN) scale = Math.max(MIN, scale - STEP)
    else if (avg < TARGET * 0.80 && scale < MAX) scale = Math.min(MAX, scale + STEP)
    const on = scale < 0.999
    if (on !== appliedOn) { window.__threeVdrs = on; appliedOn = on }
    const wantScale = +scale.toFixed(3)
    if (on && wantScale !== appliedScale) { window.__threeVdrsScale = wantScale; appliedScale = wantScale }
    window.__threeVdrsState = { scale: +scale.toFixed(2), on, avgMs: +avg.toFixed(2) }
  }
  return { tick }
}

export function installThreeVdrs(ctx, renderer, scene, camera) {
  if (!ctx.threeVdrs) ctx.threeVdrs = new ThreeVdrs(renderer, scene, camera)
  if (typeof window !== 'undefined') window.__threeVdrsDebug = ctx.threeVdrs
  return ctx.threeVdrs
}
