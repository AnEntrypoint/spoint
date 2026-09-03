// FSR1 -- AMD FidelityFX Super Resolution 1.0-style spatial upscale + sharpen, gated behind
// RenderControls('fsr1'). Companion to createDprController (client/core/FrameMetrics.js): that
// controller already lowers renderer.setPixelRatio under sustained frame-time pressure, which
// shrinks the WebGL drawing buffer while the canvas CSS size stays pinned at window.innerWidth/
// innerHeight -- the browser compositor then does a dumb GPU bilinear stretch from the small
// drawing buffer up to the full CSS size. That stretch is the "jarring blur/pixelation" a DPR
// drop causes today. This module replaces that dumb stretch with a real two-pass FSR1 upscale
// (EASU: edge-adaptive spatial upsample, then RCAS: robust contrast-adaptive sharpen), run as a
// RenderGraph post-composite node, same shape as Bloom.js/SSAO.js (copy-canvas -> offscreen
// shader pass(es) -> composite back).
//
// WHY FSR1, NOT TAA: TAA needs per-frame jitter + motion vectors + history reprojection --
// meaningfully more integration surface (a jittered projection matrix every frame, a velocity
// buffer, a history-reject heuristic for disocclusion) than this render pipeline has budget for
// right now (shadow/occlusion/culling nodes already spend the per-frame budget -- see this row's
// PRD detail). FSR1 is a single-frame spatial technique: no history buffer, no motion vectors, no
// jitter -- it only needs the low-res color it already has, so it composes cleanly with the
// existing DPR controller with zero coupling to anything else in RenderGraph.nodes.js.
//
// WHY READ-BACK-FROM-CANVAS (same rationale as Bloom.js): the DPR controller shrinks the ACTUAL
// WebGL drawing buffer (renderer.setPixelRatio), not a separate render target, so "the low-res
// frame" IS whatever is currently in the canvas's own framebuffer right after scene-color runs.
// copyFramebufferToTexture reads it into a sampleable texture at the CURRENT (low) drawing-buffer
// resolution; EASU then upscales that texture into a full-CSS-resolution offscreen target, RCAS
// sharpens it in a second pass, and the composite pass draws the result back over the canvas
// filling the whole (currently-small) drawing buffer -- which the renderer will itself have to
// stretch to CSS size same as before UNLESS the canvas is temporarily bumped to full resolution
// for this composite. Since WebGLRenderer's drawing-buffer size is derived from
// pixelRatio*CSS-size, this module does NOT fight that: it renders EASU+RCAS's OUTPUT at the
// current drawing-buffer resolution (upscaling from the even-smaller pre-DPR-drop source that
// scene-color just rendered would require a genuinely separate low-res render target, which the
// current single-canvas-draw architecture used by terrain+THREE does not have -- see
// DepthComposite.js's documented single-canvas-draw contract). What this DOES fix: today's DPR
// drop composites via the browser's own bilinear canvas->CSS stretch (a SECOND, uncontrolled
// resize hop after the drawing buffer already rendered at low internal res); this pass instead
// upscales+sharpens the ALREADY-DPR-SCALED framebuffer content in a way that recovers perceived
// edge sharpness within the same drawing-buffer resolution, which is the FSR1-documented use case
// (soften-then-sharpen beats naive-bilinear at the same output pixel count). A true "render at
// N% then present at 100%" full source-resolution decouple is the identified follow-up (see the
// sibling PRD row filed at the bottom of this module's PRD entry) since it needs the DPR
// controller and the canvas resize path to both change what "full resolution" means for
// setSize/pixelRatio, a materially bigger architecture change than this first slice.
//
// PASS SHAPE:
//   1. copy: copyFramebufferToTexture the current canvas into a sampleable source texture (same
//      technique as Bloom.js).
//   2. EASU: full-screen shader implementing FSR1's edge-adaptive spatial upsample (simplified --
//      the real AMD reference is a fixed-function 32-tap gather; this is a 5-tap directional-
//      gradient-weighted resample, the same practical simplification widely used in shipped WebGL
//      FSR1 ports, since WebGL2 GLSL ES 3.00 has no textureGather) into a full-drawing-buffer-
//      resolution offscreen target.
//   3. RCAS: full-screen contrast-adaptive sharpen pass over the EASU output (real AMD RCAS
//      formula: min/max neighborhood contrast -> per-pixel sharpen weight, unsharp-mask style).
//   4. composite: draw the RCAS output back onto the canvas.

import * as THREE from 'three'
import { RenderControls } from './RenderControls.js'

const _fullscreenVert = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

// Simplified EASU: samples a 3x3 neighborhood around the upscaled target texel, computes local
// min/max luminance to detect an edge, and blends between a bilinear sample (smooth regions) and
// a sharper directional-weighted sample (edges) -- FSR1's core idea (adapt the resample kernel to
// local contrast) without the fixed-function gather hardware the real AMD shader assumes.
const _easuFrag = /* glsl */`
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

// Real AMD RCAS formula (simplified to standard GLSL, no fixed-function min3/max3 intrinsics):
// per-pixel local min/max, contrast-adaptive sharpen weight clamped so flat regions never ring.
const _rcasFrag = /* glsl */`
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
      fragmentShader: /* glsl */`
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
    // Sized at the CURRENT (possibly DPR-shrunk) drawing-buffer resolution -- see module header:
    // this pass upscales+sharpens WITHIN that resolution (recovers perceived edge sharpness vs a
    // naive bilinear stretch), it does not yet decouple internal render resolution from output
    // resolution (that needs the DPR controller + canvas resize path to change together, filed as
    // a sibling follow-up row).
    this._sceneCopyTex = new THREE.FramebufferTexture(w, h)
    this._built = true
  }

  _disposeTargets() {
    if (this._easuTarget) this._easuTarget.dispose()
    if (this._rcasTarget) this._rcasTarget.dispose()
    if (this._sceneCopyTex) this._sceneCopyTex.dispose()
  }

  // Runs EASU then RCAS into offscreen targets. Does not composite (mirrors Bloom/SSAO's
  // compute/composite split so the RenderGraph node boundary matches one node per resource).
  compute() {
    const size = new THREE.Vector2()
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
      // Same fail-soft discipline as Bloom.js: some backends refuse the copy (e.g. multisampled
      // default framebuffer) -- skip this frame's upscale rather than throwing mid-RenderGraph.
      return
    }

    // EASU pass: source texel size is 1/drawing-buffer-resolution (see class header -- source and
    // target share the same resolution in this first slice, so EASU's edge-adaptive resample acts
    // as an in-place quality-preserving resharpen rather than a genuine resolution increase).
    this._easuMat.uniforms.tSource.value = this._sceneCopyTex
    this._easuMat.uniforms.uSrcTexel.value.set(1 / w, 1 / h)
    this._quad.material = this._easuMat
    this.renderer.setRenderTarget(this._easuTarget)
    this.renderer.autoClear = true
    this.renderer.render(this._quadScene, this._quadCamera)

    // RCAS pass: sharpen the EASU output.
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

  // Draws the sharpened result back over the canvas, replacing whatever scene-color/bloom/ssao
  // left there.
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

// RenderGraph nodes for the FSR1 tier -- gated behind RenderControls('fsr1') AND only actually
// active while the DPR controller has genuinely dropped below 1.0 (window.__dpr.scale < 1 --
// mirrored by createDprController every WIN-frame window in FrameMetrics.js): at native
// resolution there is no upscale to soften/sharpen, so this pass would just be a redundant extra
// copy+shader pass for zero visual benefit. Composited LAST (after bloom/ssr, which is why it
// reads their resources as order-only markers) since it must operate on the truly-final frame.
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

// window.__dpr is written by createDprController (FrameMetrics.js) once per WIN-frame evaluation
// window; scale===1 (or the mirror not existing yet, e.g. dprAuto never turned on) means nothing
// is currently downscaled, so fsr1-compute self-skips via shouldRun above rather than the caller
// needing to know about the DPR controller's internal state.
function _dprIsDownscaled() {
  if (typeof window === 'undefined' || !window.__dpr) return false
  return window.__dpr.scale < 0.999
}

// Lazy installer: constructs the FSR1 GPU resources on first call and stashes the instance on
// ctx.fsr1 (mirrors installBloom/installSSAO). Debug handle is window.__fsr1Debug, never
// window.__fsr1 -- RenderControls.js's 'fsr1' knob owns that exact global name (get/set).
//
// RENDERER-POLYMORPHIC (webgpurenderer-tsl-port-lowrisk-fullscreen-passes): this raw-GLSL
// ShaderMaterial implementation only works under WebGLRenderer -- WebGPURenderer does not compile
// raw GLSL at all (see docs/webgpu-shader-audit.md). renderer.isWebGPURenderer is set true in
// WebGPURenderer's own constructor (three.webgpu.js), a real, stable, already-shipped discriminator
// -- not a duck-type guess. When it's set, install the TSL-native sibling implementation
// (FSR1WebGPU.js, same EASU+RCAS math, ported node-for-node) instead; every caller (RenderGraph
// nodes below, app.js) is unaffected since both classes share the identical compute()/composite()/
// dispose() public surface.
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

// Synchronous require of the TSL sibling module. installFSR1 itself stays synchronous (matching
// every other install* call site in app.js, all called back-to-back with zero awaits) -- FSR1WebGPU
// only imports 'three'/'three/tsl'/RenderControls.js, none of which are heavyweight enough to
// justify a dynamic-import split the way probeAndCreateWebGPURenderer's own 'three/webgpu' import
// is (that one is the ~2x-larger full WebGPU renderer build; TSL node helpers are not).
let _FSR1WebGPUModule = null
function _requireFSR1WebGPU() {
  if (!_FSR1WebGPUModule) throw new Error('FSR1WebGPU not registered -- call registerFSR1WebGPU() once at boot before installFSR1 runs under a WebGPURenderer')
  return _FSR1WebGPUModule
}
export function registerFSR1WebGPU(mod) {
  _FSR1WebGPUModule = mod
}
