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
  uniform vec2 uSrcTexel;   // 1/sourceWidth, 1/sourceHeight
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
    // Local contrast in [0,1] drives the edge blend weight -- FSR1's "adapt to edges" behavior:
    // flat regions (lmax≈lmin) stay a plain bilinear-equivalent center sample; edges pull in the
    // directional neighbor average for a crisper resample instead of a soft blur.
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
  uniform float uSharpness; // 0..1, 0 = pass-through
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
    // RCAS peak-sharpen weight: ratio of available headroom to local contrast, so a pixel already
    // at the local extremum (mn==mx, flat/already-clipped) gets zero sharpen -- the anti-ringing
    // clamp the real AMD shader also has.
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

const _sizeScratch = new THREE.Vector2()

export class FSR1 {
  constructor(renderer) {
    this.renderer = renderer
    this._built = false
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
      uniforms: { tSource: { value: null }, uTexel: { value: new THREE.Vector2(0, 0) }, uSharpness: { value: RenderControls.get('fsr1Sharpness') } },
      depthTest: false,
      depthWrite: false,
    })
    this._compositeMat = new THREE.ShaderMaterial({
      vertexShader: _fullscreenVert,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tSource;
        void main() { gl_FragColor = vec4(texture2D(tSource, vUv).rgb, 1.0); }
      `,
      uniforms: { tSource: { value: null } },
      depthTest: false,
      depthWrite: false,
    })
    this._quad = new THREE.Mesh(this._quadGeo, this._easuMat)
    this._quad.frustumCulled = false
    this._quadScene.add(this._quad)
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
    this._easuTarget = new THREE.WebGLRenderTarget(w, h, opts)
    this._rcasTarget = new THREE.WebGLRenderTarget(w, h, opts)
    this._sceneCopyTex = new THREE.FramebufferTexture(w, h)
    this._built = true
  }

  _disposeTargets() {
    if (this._easuTarget) this._easuTarget.dispose()
    if (this._rcasTarget) this._rcasTarget.dispose()
    if (this._sceneCopyTex) this._sceneCopyTex.dispose()
  }

  compute() {
    const size = _sizeScratch
    this.renderer.getSize(size)
    const pr = this.renderer.getPixelRatio ? this.renderer.getPixelRatio() : 1
    const w = Math.max(4, Math.round(size.x * pr))
    const h = Math.max(4, Math.round(size.y * pr))
    if (w <= 0 || h <= 0) return
    this._ensureTargets(w, h)

    const prevTarget = this.renderer.getRenderTarget()
    const prevAutoClear = this.renderer.autoClear
    if (prevTarget !== null) { this.renderer.setRenderTarget(prevTarget); this.renderer.autoClear = prevAutoClear; return }

    try {
      this.renderer.copyFramebufferToTexture(this._sceneCopyTex)
    } catch (_) {
      return
    }

    this._easuMat.uniforms.tSource.value = this._sceneCopyTex
    this._easuMat.uniforms.uSrcTexel.value.set(1 / w, 1 / h)
    this._quad.material = this._easuMat
    this.renderer.setRenderTarget(this._easuTarget)
    this.renderer.autoClear = true
    this.renderer.render(this._quadScene, this._quadCamera)

    this._rcasMat.uniforms.tSource.value = this._easuTarget.texture
    this._rcasMat.uniforms.uTexel.value.set(1 / w, 1 / h)
    this._rcasMat.uniforms.uSharpness.value = RenderControls.get('fsr1Sharpness')
    this._quad.material = this._rcasMat
    this.renderer.setRenderTarget(this._rcasTarget)
    this.renderer.autoClear = true
    this.renderer.render(this._quadScene, this._quadCamera)

    this.outputTexture = this._rcasTarget.texture
    this.renderer.setRenderTarget(prevTarget)
    this.renderer.autoClear = prevAutoClear
  }

  composite() {
    if (!this.outputTexture) return
    this._compositeMat.uniforms.tSource.value = this.outputTexture
    this._quad.material = this._compositeMat
    const prevAutoClear = this.renderer.autoClear
    this.renderer.autoClear = true
    this.renderer.render(this._quadScene, this._quadCamera)
    this.renderer.autoClear = prevAutoClear
  }

  dispose() {
    this._disposeTargets()
    this._easuMat.dispose()
    this._rcasMat.dispose()
    this._compositeMat.dispose()
    this._quadGeo.dispose()
  }
}

export function buildFSR1Nodes() {
  return [
    {
      id: 'fsr1-compute',
      reads: ['sceneColor', 'bloomComposited', 'ssrComposited'],
      writes: ['fsr1Computed'],
      shouldRun: ctx => RenderControls.get('fsr1') === true && !!ctx.fsr1 && _dprIsDownscaled(),
      run(ctx) {
        ctx.fsr1.compute()
        ctx.res.fsr1Computed = ctx.frameId
      },
    },
    {
      id: 'fsr1-composite',
      reads: ['fsr1Computed'],
      writes: ['fsr1Composited'],
      targets: { fsr1Composited: 'canvas' },
      shouldRun: ctx => RenderControls.get('fsr1') === true && !!ctx.fsr1 && ctx.res.fsr1Computed === ctx.frameId,
      run(ctx) {
        ctx.fsr1.composite()
        ctx.res.fsr1Composited = ctx.frameId
      },
    },
  ]
}

function _dprIsDownscaled() {
  if (typeof window === 'undefined' || !window.__dpr) return false
  return window.__dpr.scale < 0.999
}

export function installFSR1(ctx, renderer) {
  if (!ctx.fsr1) {
    if (renderer && renderer.isWebGPURenderer) {
      const { FSR1WebGPU } = _requireFSR1WebGPU()
      ctx.fsr1 = new FSR1WebGPU(renderer)
    } else {
      ctx.fsr1 = new FSR1(renderer)
    }
  }
  if (typeof window !== 'undefined') window.__fsr1Debug = ctx.fsr1
  return ctx.fsr1
}

let _FSR1WebGPUModule = null
function _requireFSR1WebGPU() {
  if (!_FSR1WebGPUModule) throw new Error('FSR1WebGPU not registered -- call registerFSR1WebGPU() once at boot before installFSR1 runs under a WebGPURenderer')
  return _FSR1WebGPUModule
}
export function registerFSR1WebGPU(mod) {
  _FSR1WebGPUModule = mod
}
