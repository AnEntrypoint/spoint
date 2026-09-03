// Bloom -- half-res threshold-extract + separable-blur + additive-composite bloom pass, gated
// behind RenderControls('bloom'). Scoped to bright small-area highlights (muzzle flashes, pickup/
// glow emissive materials, any other HDR-bright fragment already on screen) rather than a full
// scene-wide multi-mip bloom -- matches this row's ask (bloom-pass-rendergraph-node: "muzzle
// flashes/pickups") and keeps the pass cheap (one extra half-res target pair, same shape as
// SSAO.js's existing G-buffer/AO/composite three-pass structure).
//
// WHY READ-BACK-FROM-CANVAS, NOT A SEPARATE SCENE RENDER (unlike SSAO's G-buffer pass, which
// needs a THREE-only normal/depth buffer no other pass can supply): bloom only needs the ALREADY-
// COMPOSITED HDR scene color -- the same canvas scene-color has just written (mapspinner terrain +
// THREE objects, tonemapping not yet applied since the renderer applies its own tonemap/colorspace
// output encoding at texture-read time, not in the framebuffer). Copying the current canvas into a
// FULL-resolution FramebufferTexture via renderer.copyFramebufferToTexture (a raw pixel copy, no
// GPU-side scaling) then DOWNSCALING via the threshold pass's own bilinear texture sample into a
// half-res target keeps this a self-contained post-process step that (like SSAO) never touches the
// single-writer sceneDepth/terrainDepth resources DepthComposite.js documents -- purely additive,
// reads sceneColor, composites back onto the canvas after scene-color (and after SSAO's
// multiplicative darken, so bloom highlights are not dimmed by the AO term meant for ambient
// contact shadows).
//
// PASS SHAPE:
//   1. threshold pass: copy the canvas into a full-res FramebufferTexture, run a full-screen shader
//      (rendering into a HALF-res target, so the sample itself downscales) that zeroes anything
//      below uThreshold (luminance) and keeps (attenuated) the excess above it -- the classic
//      "soft knee" bright-pass filter.
//   2. blur pass: two-pass separable box blur (horizontal then vertical) over a small fixed kernel,
//      ping-ponged between two same-size half-res targets. A box blur (not gaussian) is deliberate:
//      cheap, and multiple iterations already approximate a gaussian visually at this scale/budget.
//   3. composite: full-screen additive-blend draw of the blurred bright-pass texture onto the
//      canvas (THREE.AdditiveBlending) -- scene-color's own draw is untouched, this only adds light.

import * as THREE from 'three'
import { RenderControls } from './RenderControls.js'

const _fullscreenVert = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

const _thresholdFrag = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tScene;
  uniform float uThreshold;
  uniform float uKnee;
  void main() {
    vec3 c = texture2D(tScene, vUv).rgb;
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    // Soft-knee bright-pass: smoothly ramps in around uThreshold instead of a hard cutoff (avoids a
    // harsh edge around bright objects like the pickup emissive spheres / tracer streaks).
    float soft = clamp(lum - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / max(0.0001, 4.0 * uKnee);
    float contribution = max(soft, lum - uThreshold);
    float scale = lum > 0.0001 ? contribution / lum : 0.0;
    gl_FragColor = vec4(c * clamp(scale, 0.0, 1.0), 1.0);
  }
`

const _blurFrag = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tSource;
  uniform vec2 uDirection; // (1/width, 0) or (0, 1/height), pre-scaled by caller
  void main() {
    // 9-tap box blur, symmetric around the center texel -- cheap and, run twice (H then V) across
    // a couple of composited frames, visually reads as a soft glow at the half-res scale this runs
    // at without needing a real gaussian-weighted kernel.
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

const _compositeFrag = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tBloom;
  uniform float uIntensity;
  void main() {
    gl_FragColor = vec4(texture2D(tBloom, vUv).rgb * uIntensity, 1.0);
  }
`

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
    // FramebufferTexture is the real THREE API for "copy the currently-bound framebuffer's pixels
    // into a sampleable texture" (renderer.copyFramebufferToTexture(texture) below) -- sized at
    // FULL canvas resolution since copyTexSubImage2D is a raw pixel copy with no scaling; the
    // threshold pass (a fullscreen shader sampling this texture into the half-res _brightTarget)
    // is what does the actual downscale, via ordinary bilinear texture sampling.
    this._sceneCopyTex = new THREE.FramebufferTexture(fullW, fullH)
    this._built = true
  }

  _disposeTargets() {
    if (this._brightTarget) this._brightTarget.dispose()
    if (this._pingTarget) this._pingTarget.dispose()
    if (this._sceneCopyTex) this._sceneCopyTex.dispose()
  }

  // Extracts the bright-pass + blurs it. Does not composite -- mirrors SSAO's split so the
  // RenderGraph node boundary matches one node per declared resource (see RenderGraph.js NODE
  // CONTRACT: 'bloomComputed' vs 'bloomComposited').
  compute() {
    const size = new THREE.Vector2()
    this.renderer.getSize(size)
    if (size.x <= 0 || size.y <= 0) return
    this._ensureTargets(size.x, size.y)

    const prevTarget = this.renderer.getRenderTarget()
    const prevAutoClear = this.renderer.autoClear

    // 1. Copy the current canvas (already-composited HDR-ish scene color, pre-tonemap-output-
    //    encoding) into a full-res sampleable texture. copyFramebufferToTexture reads whatever is
    //    currently the bound READ framebuffer -- the canvas itself, since prevTarget is null when
    //    called right after scene-color/ssao-composite (both restore renderer.setRenderTarget(null)
    //    before returning). If some other node left a target bound, skip this frame's bloom rather
    //    than copying the wrong buffer.
    if (prevTarget !== null) {
      this.renderer.setRenderTarget(prevTarget)
      this.renderer.autoClear = prevAutoClear
      return
    }
    try {
      this.renderer.copyFramebufferToTexture(this._sceneCopyTex)
    } catch (_) {
      // Some backends refuse the copy (e.g. a multisampled default framebuffer, which cannot be
      // read directly via copyTexSubImage2D); fail soft (no bloom this frame) rather than throwing
      // and killing the rest of the RenderGraph frame.
      return
    }

    // 2. Threshold (bright-pass) into _brightTarget.
    this._thresholdMat.uniforms.tScene.value = this._sceneCopyTex
    this._thresholdMat.uniforms.uThreshold.value = RenderControls.get('bloomThreshold')
    this._quad.material = this._thresholdMat
    this.renderer.setRenderTarget(this._brightTarget)
    this.renderer.autoClear = true
    this.renderer.render(this._quadScene, this._quadCamera)

    // 3. Separable blur: horizontal (_brightTarget -> _pingTarget), vertical (_pingTarget ->
    //    _brightTarget), repeated uPasses times (default 1 full H+V pass -- cheap, gated small).
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

  // Additive-composites the blurred bright-pass onto whatever is currently bound as the render
  // target (the canvas, when called from the RenderGraph composite node after scene-color/SSAO).
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

// RenderGraph nodes for the bloom tier -- declared-resource, gated behind RenderControls('bloom'),
// composited AFTER scene-color (and after SSAO's darken pass, so the additive glow is not dimmed by
// ambient occlusion meant for contact shadows -- see buildBloomNodes' reads below, which order this
// after 'ssaoComposited' when SSAO also ran). ctx.bloom is a lazily-built Bloom instance (see
// installBloom below) so a session that never enables the flag pays zero construction cost.
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

// Lazy installer: constructs the Bloom GPU resources on first call and stashes the instance on
// ctx.bloom. Callers wire this once at boot (mirrors installSSAO).
//
// NAMING TRAP AVOIDED (same discipline as SSAO.js): the debug instance handle is exposed as
// window.__bloomDebug, NEVER window.__bloom -- RenderControls.js's 'bloom' knob mirrors onto
// window.__bloom (get/set read/write that exact global name).
//
// RENDERER-POLYMORPHIC (webgpurenderer-tsl-port-lowrisk-fullscreen-passes-remaining-8, mirrors
// FSR1.js's installFSR1 exactly): this raw-GLSL ShaderMaterial implementation only works under
// WebGLRenderer. When renderer.isWebGPURenderer is true, install the TSL-native sibling
// (BloomWebGPU.js, same threshold/blur/composite math, ported node-for-node) instead -- every
// caller (RenderGraph nodes above, app.js) is unaffected since both classes share the identical
// compute()/composite()/dispose() public surface.
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

// Synchronous require of the TSL sibling module -- same discipline as FSR1.js's
// _requireFSR1WebGPU/registerFSR1WebGPU pair (installBloom stays synchronous, matching every
// other install* call site in app.js).
let _BloomWebGPUModule = null
function _requireBloomWebGPU() {
  if (!_BloomWebGPUModule) throw new Error('BloomWebGPU not registered -- call registerBloomWebGPU() once at boot before installBloom runs under a WebGPURenderer')
  return _BloomWebGPUModule
}
export function registerBloomWebGPU(mod) {
  _BloomWebGPUModule = mod
}
