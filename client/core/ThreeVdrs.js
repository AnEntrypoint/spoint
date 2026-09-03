// ThreeVdrs -- the genuine "render at N%, present at 100%" resolution decouple for THREE's OWN
// scene-color draw (trees/rocks/players/models), the sibling half of
// true-upscale-decoupled-render-resolution (which shipped the terrain-only slice via mapspinner's
// pre-existing VDRS FBO mechanism, see FrameMetrics.js createTerrainVdrsController). Gated behind
// RenderControls('threeVdrs').
//
// WHY THIS WAS SCOPED OUT OF THE TERRAIN SLICE, AND HOW THIS MODULE CLEARS THAT BLOCKER:
// DepthComposite.js's documented contract is that mapspinner's raw-GL terrain/water and THREE's
// scene share ONE depth buffer baked straight into the CANVAS -- terrain writes its depth into the
// canvas depth buffer BEFORE scene-color runs (terrain-depth-color node), then scene-color's
// renderer.render(scene, camera) depth-TESTS against it so a tree behind a hill is correctly
// occluded. A naive "render THREE into a smaller offscreen target, then upscale" breaks this: the
// offscreen target's OWN depth buffer starts empty, so THREE objects would draw with no terrain
// occlusion at all once composited back.
//
// The other naive direction (copy terrain's depth INTO the low-res target so THREE can depth-test
// against it) is a genuine dead end in this pipeline, confirmed via mapspinner's own prior
// investigation (gl-render.js's passPlanetDepthWriteback comment): a single-sample -> MSAA
// blitFramebuffer of DEPTH is GL_INVALID_OPERATION, and this project's canvas is commonly MSAA
// (antialias:true on non-mobile, SceneSetup.createRenderer) -- so a raw depth blit from the canvas
// into any non-MSAA offscreen target is not legal WebGL. Reaching into mapspinner internals for its
// _vdrsDepth texture (only populated when terrain's OWN vdrs mode is simultaneously active) would
// require a new cross-package export plus keeping mapspinner's and THREE's internal render
// resolutions coupled together -- exactly the "materially bigger architecture change" this row's own
// PRD detail flags as separate scope, and it would still leave the common case (terrain VDRS off,
// THREE VDRS on) with no depth source at all.
//
// THIS MODULE'S ACTUAL MECHANISM (the one that stays inside this row's bounded scope and needs zero
// mapspinner changes): render THREE's scene into its own low-res WebGLRenderTarget WITH A REAL
// DepthTexture attachment (same technique packages/streaming-gltf/src/hzb-tier.js's captureAndBuild
// already uses to get a three-managed raw GL depth texture handle) -- this gives THREE objects
// correct, real GPU depth-tested occlusion AGAINST EACH OTHER (a tree in front of a rock, a player
// behind a wall-model) at the reduced internal resolution, the dominant per-object-count cost this
// row is actually after. The low-res color is then EASU+RCAS upscaled (identical technique to
// FSR1.js, duplicated rather than shared since FSR1.js's own targets are sized to the CURRENT
// drawing-buffer resolution which is a different concern -- see that module's header) into a
// full-canvas-resolution offscreen target, and finally composited onto the canvas via a GLSL3
// fullscreen-quad draw that:
//   (a) real-GPU-depth-tests against whatever terrain already wrote into the canvas depth buffer
//       this frame (so terrain still correctly occludes the whole upscaled THREE result -- a tree
//       behind a hill still disappears, exactly as it does today), and
//   (b) writes gl_FragDepth from the (bilinearly-upsampled) low-res THREE depth, so the canvas depth
//       buffer ends this composite holding THREE's own (upscaled) depth for any later same-frame
//       consumer (SSAO/SSR read their OWN dedicated G-buffers, not the canvas depth -- see those
//       modules' headers -- so this is a compatible, not just incidentally-safe, choice).
// No re-encode of the depth CURVE is needed here (unlike mapspinner's cross-near/far writeback):
// the low-res target renders with the EXACT SAME camera object (identical near/far/projection) as
// the full-res composite, so the raw depth values are already on the same curve -- a straight
// (bilinearly filtered) sample is correct.
//
// HONEST SCOPE: this decouples THREE-vs-THREE occlusion at reduced internal resolution (the
// dominant cost when many trees/rocks/players are on screen) while still being correctly occluded
// BY terrain/water at full fidelity (the depth-test in step (a) above is a real per-pixel GPU test
// against terrain's full-res depth, not an approximation). What it does NOT yet do: make terrain's
// OWN resolution track this same scale automatically (that is createTerrainVdrsController's
// independent knob, vdrsAuto/vdrsScale) -- the two adaptive controllers are deliberately separate so
// either can be tuned/disabled without the other, same as the existing dprAuto/vdrsAuto split.

import * as THREE from 'three'
import { RenderControls } from './RenderControls.js'

const _fullscreenVert = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

// Same simplified EASU (5-tap directional-gradient-weighted resample) as FSR1.js -- duplicated, not
// imported, since this module's source/target resolutions are genuinely different (low-res THREE
// render -> full canvas res) from FSR1.js's within-drawing-buffer case; see this module's header.
const _easuFrag = /* glsl */`
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

const _rcasFrag = /* glsl */`
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

// Composite: samples the (already EASU+RCAS upscaled, full-canvas-res) THREE color AND the raw
// low-res depth texture (bilinear-sampled at the SAME uv -- correct since both were rendered with
// the identical camera/projection as the canvas composite, see module header), draws real color +
// writes gl_FragDepth so downstream same-frame consumers see THREE's own depth in the canvas depth
// buffer. GLSL3 (out variable + texture()) since gl_FragDepth needs a real fragment-shader output
// declaration in WebGL2 core (no EXT_frag_depth extension needed) -- same technique mapspinner's own
// dwProg re-encode shader and packages/streaming-gltf/src/octahedral-impostor-ez.js already use in
// this codebase.
const _compositeFrag = /* glsl */`
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
const _compositeVert = /* glsl */`
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
    // depthTest:true/depthWrite:true + no `transparent` -- this draw MUST real-GPU-depth-test
    // against terrain's already-written canvas depth (correct terrain occlusion, see module header
    // point (a)) and MUST write depth (point (b)). THREE's material system needs an explicit
    // `depthFunc`-compatible default (THREE default LessEqualDepth matches terrain-depth-color's own
    // convention, unchanged).
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

  // Renders the THREE scene at a reduced internal resolution (scale in (0,1], clamped [0.3,1.0] to
  // match mapspinner's own vdrsScale clamp discipline) into its own real depth-buffered target, then
  // EASU+RCAS-upscales the color into a full-canvas-resolution target. Does not composite (mirrors
  // FSR1/Bloom/SSAO's compute()/composite() split).
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

    // 1. Low-res scene render: real depth buffer, real THREE-vs-THREE occlusion, at the reduced
    //    resolution. Clears BOTH color and depth (this target has no prior-frame content that
    //    matters -- unlike the canvas, terrain never writes into this offscreen target).
    this.renderer.setRenderTarget(this._lowTarget)
    this.renderer.autoClear = true
    this.renderer.clear(true, true, false)
    this.renderer.render(this.scene, this.camera)

    // 2. EASU pass: upscale the low-res color into a full-canvas-res target.
    this._easuMat.uniforms.tSource.value = this._lowTarget.texture
    this._easuMat.uniforms.uSrcTexel.value.set(1 / lowW, 1 / lowH)
    this._quad.material = this._easuMat
    this.renderer.setRenderTarget(this._easuTarget)
    this.renderer.autoClear = true
    this.renderer.render(this._quadScene, this._quadCamera)

    // 3. RCAS pass: sharpen the EASU output, still at full-canvas-res.
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

  // Draws the upscaled+sharpened THREE color onto the canvas, real-depth-tested against whatever is
  // already in the canvas depth buffer (terrain, written by terrain-depth-color BEFORE this runs --
  // see module header point (a)), and writes THREE's own upscaled depth back (point (b)). autoClear
  // gating mirrors scene-color's own existing `if (hasTerrain) ...` shape so a world with no terrain
  // backdrop still composites correctly.
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

// Adaptive controller mirroring createTerrainVdrsController's exact hysteresis shape (FrameMetrics.js)
// -- kept here rather than in FrameMetrics.js since it is a pure ThreeVdrs-scoped scale decision with
// no other module needing it, and colocating it next to the mechanism it drives keeps the two
// adaptive controllers (terrain's and THREE's) trivially independent-toggleable per this module's
// header note. Default OFF (window.__threeVdrsAuto), same opt-in discipline as dprAuto/vdrsAuto.
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

// Lazy installer: constructs GPU resources on first call and stashes the instance on
// ctx.threeVdrs. Debug handle is window.__threeVdrsDebug, never window.__threeVdrs -- RenderControls
// mirrors the boolean flag onto that exact global name (same discipline as fsr1/ssao/bloom/etc).
export function installThreeVdrs(ctx, renderer, scene, camera) {
  if (!ctx.threeVdrs) ctx.threeVdrs = new ThreeVdrs(renderer, scene, camera)
  if (typeof window !== 'undefined') window.__threeVdrsDebug = ctx.threeVdrs
  return ctx.threeVdrs
}
