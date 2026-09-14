import * as THREE from 'three'
import { RenderControls } from './RenderControls.js'

const _fullscreenVert = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

const _thresholdFrag = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tScene;
  uniform float uThreshold;
  uniform float uKnee;
  void main() {
    vec3 c = texture2D(tScene, vUv).rgb;
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float soft = clamp(lum - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / max(0.0001, 4.0 * uKnee);
    float contribution = max(soft, lum - uThreshold);
    float scale = lum > 0.0001 ? contribution / lum : 0.0;
    gl_FragColor = vec4(c * clamp(scale, 0.0, 1.0), 1.0);
  }
`

const _blurFrag = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tSource;
  uniform vec2 uDirection;
  void main() {
    vec3 sum = texture2D(tSource, vUv).rgb * 0.227;
    for (int i = 1; i <= 4; i++) {
      float w = 0.194 - float(i) * 0.03;
      vec2 o = uDirection * float(i);
      sum += texture2D(tSource, vUv + o).rgb * w;
      sum += texture2D(tSource, vUv - o).rgb * w;
    }
    gl_FragColor = vec4(max(sum, 0.0), 1.0);
  }
`

const _compositeFrag = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tBloom;
  uniform float uIntensity;
  void main() {
    gl_FragColor = vec4(texture2D(tBloom, vUv).rgb * uIntensity, 1.0);
  }
`

const _sizeScratch = new THREE.Vector2()

export class Bloom {
  constructor(renderer) {
    this.renderer = renderer
    this._w = 0
    this._h = 0
    this._built = false

    this._quadScene = new THREE.Scene()
    this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this._quadGeo = new THREE.PlaneGeometry(2, 2)

    this._thresholdMat = new THREE.ShaderMaterial({
      vertexShader: _fullscreenVert,
      fragmentShader: _thresholdFrag,
      uniforms: {
        tScene: { value: null },
        uThreshold: { value: RenderControls.get('bloomThreshold') },
        uKnee: { value: 0.15 },
      },
      depthTest: false,
      depthWrite: false,
    })
    this._blurMat = new THREE.ShaderMaterial({
      vertexShader: _fullscreenVert,
      fragmentShader: _blurFrag,
      uniforms: { tSource: { value: null }, uDirection: { value: new THREE.Vector2(0, 0) } },
      depthTest: false,
      depthWrite: false,
    })
    this._compositeMat = new THREE.ShaderMaterial({
      vertexShader: _fullscreenVert,
      fragmentShader: _compositeFrag,
      uniforms: { tBloom: { value: null }, uIntensity: { value: RenderControls.get('bloomIntensity') } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })

    this._quad = new THREE.Mesh(this._quadGeo, this._thresholdMat)
    this._quad.frustumCulled = false
    this._quadScene.add(this._quad)
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
    this._brightTarget = new THREE.WebGLRenderTarget(w, h, opts)
    this._pingTarget = new THREE.WebGLRenderTarget(w, h, opts)
    this._sceneCopyTex = new THREE.FramebufferTexture(fullW, fullH)
    this._built = true
  }

  _disposeTargets() {
    if (this._brightTarget) this._brightTarget.dispose()
    if (this._pingTarget) this._pingTarget.dispose()
    if (this._sceneCopyTex) this._sceneCopyTex.dispose()
  }

  compute() {
    const size = _sizeScratch
    this.renderer.getSize(size)
    if (size.x <= 0 || size.y <= 0) return
    this._ensureTargets(size.x, size.y)

    const prevTarget = this.renderer.getRenderTarget()
    const prevAutoClear = this.renderer.autoClear

    const readBufferIsCanvas = prevTarget === null
    if (!readBufferIsCanvas) {
      this.renderer.setRenderTarget(prevTarget)
      this.renderer.autoClear = prevAutoClear
      return
    }
    try {
      this.renderer.copyFramebufferToTexture(this._sceneCopyTex)
    } catch (_) {
      return
    }

    this._thresholdMat.uniforms.tScene.value = this._sceneCopyTex
    this._thresholdMat.uniforms.uThreshold.value = RenderControls.get('bloomThreshold')
    this._quad.material = this._thresholdMat
    this.renderer.setRenderTarget(this._brightTarget)
    this.renderer.autoClear = true
    this.renderer.render(this._quadScene, this._quadCamera)

    const passes = Math.max(1, RenderControls.get('bloomBlurPasses') || 1)
    this._quad.material = this._blurMat
    let src = this._brightTarget, dst = this._pingTarget
    for (let i = 0; i < passes; i++) {
      this._blurMat.uniforms.tSource.value = src.texture
      this._blurMat.uniforms.uDirection.value.set(1 / this._w, 0)
      this.renderer.setRenderTarget(dst)
      this.renderer.autoClear = true
      this.renderer.render(this._quadScene, this._quadCamera)
      const tmp1 = src; src = dst; dst = tmp1

      this._blurMat.uniforms.tSource.value = src.texture
      this._blurMat.uniforms.uDirection.value.set(0, 1 / this._h)
      this.renderer.setRenderTarget(dst)
      this.renderer.autoClear = true
      this.renderer.render(this._quadScene, this._quadCamera)
      const tmp2 = src; src = dst; dst = tmp2
    }
    this.bloomTexture = src.texture

    this.renderer.setRenderTarget(prevTarget)
    this.renderer.autoClear = prevAutoClear
  }

  composite() {
    if (!this.bloomTexture) return
    this._compositeMat.uniforms.tBloom.value = this.bloomTexture
    this._compositeMat.uniforms.uIntensity.value = RenderControls.get('bloomIntensity')
    this._quad.material = this._compositeMat
    const prevAutoClear = this.renderer.autoClear
    this.renderer.autoClear = false
    this.renderer.render(this._quadScene, this._quadCamera)
    this.renderer.autoClear = prevAutoClear
  }

  dispose() {
    this._disposeTargets()
    this._thresholdMat.dispose()
    this._blurMat.dispose()
    this._compositeMat.dispose()
    this._quadGeo.dispose()
  }
}

export function buildBloomNodes() {
  return [
    {
      id: 'bloom-compute',
      reads: ['sceneColor'],
      writes: ['bloomComputed'],
      shouldRun: ctx => RenderControls.get('bloom') === true && !!ctx.bloom,
      run(ctx) {
        ctx.bloom.compute()
        ctx.res.bloomComputed = ctx.frameId
      },
    },
    {
      id: 'bloom-composite',
      reads: ['bloomComputed', 'ssaoComposited'],
      writes: ['bloomComposited'],
      targets: { bloomComposited: 'canvas' },
      shouldRun: ctx => RenderControls.get('bloom') === true && !!ctx.bloom && ctx.res.bloomComputed === ctx.frameId,
      run(ctx) {
        ctx.bloom.composite()
        ctx.res.bloomComposited = ctx.frameId
      },
    },
  ]
}

export function installBloom(ctx, renderer) {
  if (!ctx.bloom) {
    if (renderer && renderer.isWebGPURenderer) {
      const { BloomWebGPU } = _requireBloomWebGPU()
      ctx.bloom = new BloomWebGPU(renderer)
    } else {
      ctx.bloom = new Bloom(renderer)
    }
  }
  if (typeof window !== 'undefined') window.__bloomDebug = ctx.bloom
  return ctx.bloom
}

let _BloomWebGPUModule = null
function _requireBloomWebGPU() {
  if (!_BloomWebGPUModule) throw new Error('BloomWebGPU not registered -- call registerBloomWebGPU() once at boot before installBloom runs under a WebGPURenderer')
  return _BloomWebGPUModule
}
export function registerBloomWebGPU(mod) {
  _BloomWebGPUModule = mod
}
