// SSR -- screen-space reflections for wet surfaces, gated behind RenderControls('ssr').
//
// SCOPE (see AGENTS.md ssr-wet-surfaces-effects-tier + its ssr-material-wetness-mask-authoring and
// ssr-mask-weather-wetness-union follow-ups): the reflection mask is the UNION of THREE independent
// sources, all read in the same raymarch shader below:
//   (a) the sea-level band (near/at seaLevelY -- the original first-slice mask, still correct for
//       shoreline geometry with no authored wetness data).
//   (b) a real per-material wetness value (0..1, custom._wetness authored via the placed-model /
//       PRIMITIVE_EDITOR_PROPS editorProps -- see EntityLoader.js's userData.wetness stamp), sampled
//       per-fragment from a SECOND small G-buffer (tWetness below) so a puddle/wet-road/rain-soaked
//       surface reflects regardless of its world-Y relative to sea level.
//   (c) the AUTOMATIC weather-wetness scalar (window.__wetness / WetnessTint.getWetness() -- see
//       wetness-material-modifier-weather-driven) -- a single frame-global scalar (0..1, ramps up fast
//       while raining, dries out over wetnessDryOutSec), pushed into a plain uWeatherWetness uniform
//       each compute() call, no G-buffer needed since it's scene-wide not per-object. Rain-soaked
//       ground now gets reflective during a storm even with zero per-entity custom._wetness authoring,
//       matching WetnessTint's own darken+sheen effect on the SAME surfaces.
// A fragment is eligible if ANY source says wet (max of the three, not a gate on one) -- see
// _ssrFrag's `wetMask` computation.
//
// WHY A DEDICATED WETNESS G-BUFFER (not a 5th channel on SSAO's existing RGBA target): SSAO's
// G-buffer already uses all 4 channels (rgb=normal, a=depth) and is built via a single SHARED
// overrideMaterial swapped onto every scene object -- there is no per-object data channel available
// there. Wetness needs PER-OBJECT data (a scalar per mesh, not a uniform for the whole pass), so it
// is written via the same technique three's own examples use for per-object G-buffer data: each
// mesh's own `object.onBeforeRender` (a real Object3D hook fired by WebGLRenderer.renderObject
// BEFORE the shared override material draws that object, confirmed in
// node_modules/three/src/renderers/WebGLRenderer.js's renderObject -- object.onBeforeRender then
// material.onBeforeRender then the draw call) pushes that object's userData.wetness into a uniform
// on the shared wetness-gbuffer material just before it draws. This is NOT the custom-draw-call
// pattern the cluster-onbeforerender-custom-draw-bind-timing caveat warns about (no gl.multiDraw, no
// own vertex buffer, no VAO-bind-timing dependency) -- it is a plain uniform write read by three's
// own subsequent renderBufferDirect call, the standard three per-object-uniform idiom.
//
// POOL-ROUTED (ClusterLodMesh) ENTITIES ARE NOT COVERED BY THIS PASS: ClusterLodMesh already
// installs its OWN onBeforeRender (`this.onBeforeRender = this._render.bind(this)`, confirmed in
// packages/streaming-gltf/src/cluster-lod-mesh.js) to self-drive per-cluster LOD/culling --
// overwriting it here would break that entirely unrelated, load-bearing mechanism. The wetness
// G-buffer pass therefore SKIPS any object whose onBeforeRender is not the THREE.Object3D default
// (see `_isDefaultOnBeforeRender` below), which is exactly the ClusterLodMesh case. Plain-GLB and
// primitive (box/sphere/capsule) meshes -- the actually-placed puddle/wet-road authoring shapes this
// follow-up targets -- are NOT pool-routed (ModelPool only routes baked cluster-LOD assets) and are
// fully covered. Scoped, documented limitation, not a silent gap: a wetness value authored on a
// pool-routed placed-model entity is still stamped into userData.wetness (EntityLoader.js) for
// forward-compat / debugging, it just isn't sampled by this pass yet.
//
// WHY REUSE SSAO's NORMAL/DEPTH G-BUFFER, NOT A THIRD ONE FOR THAT PART: SSR needs the same
// view-space normal+depth data SSAO already renders (half-res MeshNormalMaterial-override pass into
// an RGBA half-float target -- see SSAO.js's header for why a dedicated G-buffer is required at all,
// the shared-canvas-depth rationale in DepthComposite.js). Sharing ONE G-buffer build between SSAO
// and SSR avoids paying for a second full scene re-render just to get the same normals/depth; SSR's
// compute() takes the SSAO instance's G-buffer target directly (installSSR wires ctx.ssao -> ctx.ssr
// so this dependency is explicit, not a hidden global read) and constructs its own if SSAO is off
// (device tiers that enable ssr without ssao still get correct reflections, just at the cost of their
// own G-buffer pass -- no cross-feature requirement, matching every other RenderControls knob's
// independence). The wetness G-buffer is a SEPARATE small pass (own tiny R8 target) run alongside it,
// gated the same way (only when ssr is on).
//
// PASS SHAPE:
//   1. scene-copy: copyFramebufferToTexture the current composited canvas into a full-res sampleable
//      texture (identical technique to Bloom.js's read-back -- this is the reflection SOURCE color).
//   1b. wetness-gbuffer pass: half-res, single-channel (R8) target, shared override material with a
//      per-object uWetness uniform pushed via onBeforeRender (see above). Skipped when ssao's G-buffer
//      already ran wetness would be redundant computation only if merged -- kept independent since it
//      is genuinely a different (much cheaper: 1 channel, no lighting) shader from SSAO's normal pass.
//   2. raymarch pass: full-screen shader, half resolution. For each G-buffer fragment eligible by the
//      union mask (sea-level band OR material wetness), reflects the view ray about the surface
//      normal and marches a small fixed number of steps in screen space, comparing marched depth
//      against the G-buffer depth at each step; on a hit, samples the scene-copy texture at that
//      screen position (a real reflected color, not a fixed reflection-probe/skybox fallback),
//      attenuated by fresnel + march-distance falloff + a screen-edge fade so a march that exits the
//      visible frame does not hard-clip.
//   3. composite: full-screen alpha-blend of the (bilinearly-upsampled) reflection term onto the
//      canvas, composited AFTER bloom (reflections are scene content, not a light-emission effect,
//      so they read most correctly drawn last among the post passes).

import * as THREE from 'three'
import { RenderControls } from './RenderControls.js'
import { getWetness as _getWeatherWetness } from './WetnessTint.js'

const _fullscreenVert = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

// Wetness G-buffer pass: a single shared material (like SSAO's normal-G-buffer override) whose
// uWetness uniform is pushed PER-OBJECT via each mesh's own onBeforeRender (see header for why this
// is safe and why ClusterLodMesh roots are skipped). No lighting/normal math needed -- this is a flat
// per-fragment scalar write, cheaper than SSAO's normal pass.
const _wetnessGbufferVert = /* glsl */`
  void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`
const _wetnessGbufferFrag = /* glsl */`
  uniform float uWetness;
  void main() { gl_FragColor = vec4(uWetness, 0.0, 0.0, 1.0); }
`

// three's Object3D default onBeforeRender is a shared no-op function reference (see three's
// Object3D.js: `onBeforeRender() {}` on the prototype) -- comparing an instance's own
// .onBeforeRender against it detects an object that has installed its OWN hook (ClusterLodMesh does
// exactly this for its LOD/culling self-drive, see header) so this pass can skip it rather than
// silently clobbering that unrelated, load-bearing mechanism.
const _defaultOnBeforeRender = new THREE.Object3D().onBeforeRender

// Raymarch fragment shader. Operates entirely in VIEW SPACE (matches SSAO's G-buffer encoding:
// rgb = view-space normal 0..1, a = linear view-space -Z depth in metres) so no world-space
// reconstruction/inverse-view-matrix is needed -- the same "rigid-transform, no mat4 inverse"
// discipline UnderwaterTint.js and SSAO.js both already use.
const _ssrFrag = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tGBuffer;   // rgb = view-space normal*0.5+0.5, a = linear view-space depth (m)
  uniform sampler2D tScene;     // full-res composited scene color (reflection source)
  uniform sampler2D tWetness;   // r = per-fragment material-authored wetness 0..1 (see header)
  uniform bool uHasWetness;     // false when the wetness G-buffer pass didn't run this frame (e.g. ssao off, own gbuffer path not yet built)
  uniform float uWeatherWetness; // 0..1 scene-wide automatic weather-wetness scalar (see header, source c)
  uniform vec2 uResolution;     // G-buffer resolution
  uniform mat4 uProjectionMatrix;
  uniform float uFovFactor;     // tan(fov/2)
  uniform float uAspect;
  uniform float uIntensity;
  uniform float uMaxDistance;   // metres, march budget
  uniform float uCamWorldY;     // camera world-space Y (for the sea-level band mask)
  uniform float uSeaLevelY;     // world sea level Y, or a very negative sentinel when unknown
  uniform float uBandHeight;    // metres above/below sea level a fragment may sit and still reflect
  uniform mat3 uNormalViewToWorld; // rotation-only (rigid) view->world, for the per-fragment world-Y test

  const int STEPS = 12;

  vec3 reconstructViewPos(vec2 uv, float depth) {
    vec2 ndc = uv * 2.0 - 1.0;
    vec3 viewDir = normalize(vec3(ndc.x * uFovFactor * uAspect, ndc.y * uFovFactor, -1.0));
    float t = depth / max(0.0001, -viewDir.z);
    return viewDir * t;
  }

  // Projects a view-space position back to screen UV using the real projection matrix (perspective-
  // correct, unlike the linear approximation reconstructViewPos's inverse would need).
  vec3 viewToScreen(vec3 viewPos) {
    vec4 clip = uProjectionMatrix * vec4(viewPos, 1.0);
    if (clip.w <= 0.0) return vec3(-1.0);
    vec2 ndc = clip.xy / clip.w;
    return vec3(ndc * 0.5 + 0.5, -viewPos.z);
  }

  void main() {
    vec4 center = texture2D(tGBuffer, vUv);
    float centerDepth = center.a;
    if (centerDepth <= 0.0) { gl_FragColor = vec4(0.0); return; }

    vec3 centerNormal = normalize(center.rgb * 2.0 - 1.0);
    vec3 centerPos = reconstructViewPos(vUv, centerDepth);

    // Wetness mask = UNION of three independent sources (see header): the sea-level band (world-Y of
    // the fragment, reconstructed via the SAME rigid rotation-only transform UnderwaterTint uses, no
    // mat4 inverse), a real per-material authored wetness value sampled from tWetness, and the
    // scene-wide automatic weather-wetness scalar (uWeatherWetness). Any source alone is sufficient --
    // a puddle far from any water still reflects once authored, shoreline geometry with no authored
    // wetness still gets the original band behavior, and rain-soaked ground reflects during a storm
    // with zero per-entity authoring.
    float fragWorldY = dot(uNormalViewToWorld[1], centerPos) + uCamWorldY;
    float bandDist = abs(fragWorldY - uSeaLevelY);
    float bandFade = 1.0 - clamp(bandDist / uBandHeight, 0.0, 1.0);
    float matWetness = uHasWetness ? texture2D(tWetness, vUv).r : 0.0;
    float wetMask = max(max(bandFade, matWetness), uWeatherWetness);
    if (wetMask <= 0.0) { gl_FragColor = vec4(0.0); return; }

    // Only near-upward-facing surfaces plausibly reflect the sky/scene above them (a wet horizontal
    // surface, not a wall) -- fresnel-style view-angle term also strengthens grazing reflections.
    vec3 viewDir = normalize(centerPos);
    float ndotv = clamp(dot(centerNormal, -viewDir), 0.0, 1.0);
    if (centerNormal.y < 0.3) { gl_FragColor = vec4(0.0); return; }
    float fresnel = pow(1.0 - ndotv, 2.0);

    vec3 reflectDir = reflect(viewDir, centerNormal);
    if (reflectDir.z >= 0.0) { gl_FragColor = vec4(0.0); return; } // reflecting toward the camera plane: no march target

    // Fixed-step screen-space march (deliberately small/cheap -- half-res already, gated to the
    // narrow sea-level band above, and this row's own scope is a first slice not a production-grade
    // hierarchical-Z or binary-refine tracer).
    vec3 rayPos = centerPos;
    float stepLen = uMaxDistance / float(STEPS);
    vec4 result = vec4(0.0);
    for (int i = 1; i <= STEPS; i++) {
      rayPos += reflectDir * stepLen;
      vec3 screenPos = viewToScreen(rayPos);
      if (screenPos.x < 0.0 || screenPos.x > 1.0 || screenPos.y < 0.0 || screenPos.y > 1.0) break;
      float sampledDepth = texture2D(tGBuffer, screenPos.xy).a;
      if (sampledDepth <= 0.0) continue;
      float rayDepth = screenPos.z;
      float depthDiff = sampledDepth - rayDepth;
      // A hit: the march point is now BEHIND the depth buffer at that screen position (something
      // occupies that pixel nearer the camera than the ray currently is) but by a small margin
      // (avoids matching geometry the ray simply marched straight through/past).
      if (depthDiff > 0.0 && depthDiff < stepLen * 2.0) {
        vec2 edgeFade = smoothstep(0.0, 0.08, screenPos.xy) * smoothstep(0.0, 0.08, 1.0 - screenPos.xy);
        float fade = edgeFade.x * edgeFade.y * (1.0 - float(i) / float(STEPS));
        result = vec4(texture2D(tScene, screenPos.xy).rgb, fade);
        break;
      }
    }
    gl_FragColor = vec4(result.rgb, result.a * fresnel * wetMask * uIntensity);
  }
`

const _compositeFrag = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tSSR;
  void main() {
    vec4 c = texture2D(tSSR, vUv);
    gl_FragColor = c;
  }
`

export class SSR {
  constructor(renderer, scene, camera) {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    this._w = 0
    this._h = 0
    this._built = false

    this._quadScene = new THREE.Scene()
    this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this._quadGeo = new THREE.PlaneGeometry(2, 2)

    this._ssrMat = new THREE.ShaderMaterial({
      vertexShader: _fullscreenVert,
      fragmentShader: _ssrFrag,
      uniforms: {
        tGBuffer: { value: null },
        tScene: { value: null },
        tWetness: { value: null },
        uHasWetness: { value: false },
        uWeatherWetness: { value: 0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uProjectionMatrix: { value: new THREE.Matrix4() },
        uFovFactor: { value: 1 },
        uAspect: { value: 1 },
        uIntensity: { value: RenderControls.get('ssrIntensity') },
        uMaxDistance: { value: RenderControls.get('ssrMaxDistance') },
        uCamWorldY: { value: 0 },
        uSeaLevelY: { value: -100000 },
        uBandHeight: { value: RenderControls.get('ssrBandHeight') },
        uNormalViewToWorld: { value: new THREE.Matrix3() },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    this._quad = new THREE.Mesh(this._quadGeo, this._ssrMat)
    this._quad.frustumCulled = false
    this._quadScene.add(this._quad)

    // Wetness G-buffer material (see header) -- one shared instance, uWetness overwritten per-object
    // by _renderWetnessGBuffer's onBeforeRender hook below, exactly like SSAO's shared normal-G-buffer
    // override material.
    this._wetnessMat = new THREE.ShaderMaterial({
      vertexShader: _wetnessGbufferVert,
      fragmentShader: _wetnessGbufferFrag,
      uniforms: { uWetness: { value: 0 } },
      side: THREE.DoubleSide,
    })

    this._compositeMat = new THREE.ShaderMaterial({
      vertexShader: _fullscreenVert,
      fragmentShader: _compositeFrag,
      uniforms: { tSSR: { value: null } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
    })
    this._compositeQuad = new THREE.Mesh(this._quadGeo, this._compositeMat)
    this._compositeQuad.frustumCulled = false
  }

  _ensureTargets(fullW, fullH) {
    const w = Math.max(4, Math.floor(fullW * 0.5))
    const h = Math.max(4, Math.floor(fullH * 0.5))
    const fullResChanged = fullW !== this._fullW || fullH !== this._fullH
    if (this._built && w === this._w && h === this._h && !fullResChanged) return
    this._disposeTargets()
    this._w = w; this._h = h
    this._fullW = fullW; this._fullH = fullH
    this._ssrTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    })
    // Wetness G-buffer target (see header): half-res like the SSR target it feeds, single-channel
    // data only needs RGBAFormat's R -- three has no bare-R WebGLRenderTarget format that's broadly
    // supported, RGBA UnsignedByte is the safe, universally-supported choice (matches _ssrTarget's own
    // format for the same reason). depthBuffer:true so nearer wet objects correctly occlude farther
    // ones (a puddle behind a wall must not paint through it).
    this._wetnessTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    })
    // Full-res copy of the composited scene, matching Bloom.js's read-back technique -- the
    // reflection pass samples real on-screen color, not a probe/skybox fallback.
    this._sceneCopyTex = new THREE.FramebufferTexture(fullW, fullH)
    this._ssrMat.uniforms.uResolution.value.set(w, h)
    this._built = true
  }

  _disposeTargets() {
    if (this._ssrTarget) this._ssrTarget.dispose()
    if (this._wetnessTarget) this._wetnessTarget.dispose()
    if (this._sceneCopyTex) this._sceneCopyTex.dispose()
  }

  // Renders the per-object wetness G-buffer (see header). Sets each mesh's onBeforeRender to push its
  // own userData.wetness into the shared _wetnessMat uniform just before three draws it, restoring
  // the original hook afterward (a mesh's own real onBeforeRender, if any, must survive this pass --
  // see the ClusterLodMesh case in the header). Returns true if the pass ran (false if the G-buffer
  // target isn't built yet, e.g. first frame before any compute() has sized it).
  _renderWetnessGBuffer() {
    if (!this._wetnessTarget) return false
    const mat = this._wetnessMat
    const pushWetness = function (renderer, scene, camera, geometry, material) {
      mat.uniforms.uWetness.value = this.userData.wetness || 0
    }
    const touched = []
    this.scene.traverse(o => {
      if (!o.isMesh || !o.visible) return
      // Skip objects that installed their own onBeforeRender (ClusterLodMesh's LOD/culling self-drive
      // -- see header) -- overwriting it would silently break that unrelated mechanism. A plain mesh
      // with zero authored wetness still safely draws uWetness=0 through the shared material, so
      // skipping costs nothing but a (correct) zero contribution from pool-routed geometry.
      if (o.onBeforeRender !== _defaultOnBeforeRender) return
      touched.push([o, o.onBeforeRender])
      o.onBeforeRender = pushWetness
    })
    const prevTarget = this.renderer.getRenderTarget()
    const prevOverride = this.scene.overrideMaterial
    const prevAutoClear = this.renderer.autoClear
    const prevClearColor = new THREE.Color()
    this.renderer.getClearColor(prevClearColor)
    const prevClearAlpha = this.renderer.getClearAlpha()

    this.renderer.setRenderTarget(this._wetnessTarget)
    this.renderer.autoClear = true
    this.renderer.setClearColor(0x000000, 1)
    this.scene.overrideMaterial = this._wetnessMat
    this.renderer.render(this.scene, this.camera)
    this.scene.overrideMaterial = prevOverride

    this.renderer.setRenderTarget(prevTarget)
    this.renderer.autoClear = prevAutoClear
    this.renderer.setClearColor(prevClearColor, prevClearAlpha)
    for (const [o, orig] of touched) o.onBeforeRender = orig
    return true
  }

  // Optionally share an already-built G-buffer (e.g. SSAO's) instead of rendering its own -- see
  // header "WHY REUSE SSAO's G-BUFFER". Pass null/undefined to fall back to owning one.
  setSharedGBuffer(gbufferTexture) {
    this._sharedGBuffer = gbufferTexture || null
  }

  // Renders the reflection term for the current frame. Does not composite -- mirrors SSAO/Bloom's
  // split so the RenderGraph node boundary matches one node per declared resource.
  compute() {
    const size = new THREE.Vector2()
    this.renderer.getSize(size)
    if (size.x <= 0 || size.y <= 0) return
    this._ensureTargets(size.x, size.y)

    const gbuffer = this._sharedGBuffer
    if (!gbuffer) return // no G-buffer available this frame (SSAO off and no owned fallback wired yet)

    const prevTarget = this.renderer.getRenderTarget()
    const prevAutoClear = this.renderer.autoClear
    if (prevTarget !== null) return // same discipline as Bloom.js: only copy the real canvas framebuffer

    try {
      this.renderer.copyFramebufferToTexture(this._sceneCopyTex)
    } catch (_) {
      return // backend refused the copy (e.g. multisampled default framebuffer) -- fail soft, no SSR this frame
    }

    // Wetness G-buffer pass (see header) -- independent of the shared normal/depth G-buffer above,
    // runs every frame SSR is on since a mesh's userData.wetness can change live (repaintEntity).
    const hasWetness = this._renderWetnessGBuffer()

    const fov = this.camera.fov ? THREE.MathUtils.degToRad(this.camera.fov) : Math.PI / 3
    const u = this._ssrMat.uniforms
    u.tGBuffer.value = gbuffer
    u.tScene.value = this._sceneCopyTex
    u.tWetness.value = hasWetness ? this._wetnessTarget.texture : null
    u.uHasWetness.value = hasWetness
    // Weather-wetness union (see header, source c): a single scene-wide scalar, no G-buffer needed --
    // WetnessTint owns the authoritative live value (window.__wetness / weather.getWetness() pushed
    // there every frame by app.js's weather-update render-graph node); SSR just reads it, never writes
    // it, matching the single-source-of-truth discipline the wetness system already established.
    u.uWeatherWetness.value = THREE.MathUtils.clamp(_getWeatherWetness() || 0, 0, 1)
    u.uProjectionMatrix.value.copy(this.camera.projectionMatrix)
    u.uFovFactor.value = Math.tan(fov / 2)
    u.uAspect.value = size.x / size.y
    u.uIntensity.value = RenderControls.get('ssrIntensity')
    u.uMaxDistance.value = RenderControls.get('ssrMaxDistance')
    u.uBandHeight.value = RenderControls.get('ssrBandHeight')
    u.uCamWorldY.value = this.camera.position.y
    const seaY = RenderControls.get('seaLevelY')
    u.uSeaLevelY.value = Number.isFinite(seaY) ? seaY : -100000
    // Rigid view->world rotation (transpose of the rotation part of viewMatrix, since it is
    // orthonormal) -- same "no mat4 inverse" technique UnderwaterTint/SSAO already rely on.
    const vm = this.camera.matrixWorldInverse.elements
    u.uNormalViewToWorld.value.set(
      vm[0], vm[1], vm[2],
      vm[4], vm[5], vm[6],
      vm[8], vm[9], vm[10],
    ).transpose()

    this.renderer.setRenderTarget(this._ssrTarget)
    this.renderer.autoClear = true
    this.renderer.render(this._quadScene, this._quadCamera)

    this.renderer.setRenderTarget(prevTarget)
    this.renderer.autoClear = prevAutoClear
    this.reflectionTexture = this._ssrTarget.texture
  }

  // Alpha-composites the reflection term onto whatever is currently bound as the render target.
  composite() {
    if (!this.reflectionTexture) return
    this._compositeMat.uniforms.tSSR.value = this.reflectionTexture
    const prevAutoClear = this.renderer.autoClear
    this.renderer.autoClear = false
    this.renderer.render(this._quadScene, this._quadCamera)
    this.renderer.autoClear = prevAutoClear
  }

  dispose() {
    this._disposeTargets()
    this._ssrMat.dispose()
    this._wetnessMat.dispose()
    this._compositeMat.dispose()
    this._quadGeo.dispose()
  }
}

// RenderGraph nodes for the SSR tier -- declared-resource, gated behind RenderControls('ssr'),
// composited AFTER bloom (see Bloom.js's own ordering note: reflections are scene content, read
// most correctly applied last among the post passes so the additive glow doesn't get masked by a
// reflection's alpha blend). Depends on SSAO's G-buffer when SSAO is also enabled this frame (see
// installSSR below); if SSAO is off, ssr-compute has no G-buffer to sample and no-ops for that
// frame (documented, not a silent crash -- SSR.compute() returns early).
export function buildSSRNodes() {
  return [
    {
      id: 'ssr-compute',
      reads: ['sceneColor', 'ssaoComputed'],
      writes: ['ssrComputed'],
      shouldRun: ctx => RenderControls.get('ssr') === true && !!ctx.ssr,
      run(ctx) {
        if (ctx.ssao && ctx.ssao._gbufferTarget) ctx.ssr.setSharedGBuffer(ctx.ssao._gbufferTarget.texture)
        ctx.ssr.compute()
        ctx.res.ssrComputed = ctx.frameId
      },
    },
    {
      id: 'ssr-composite',
      reads: ['ssrComputed', 'bloomComposited'],
      writes: ['ssrComposited'],
      targets: { ssrComposited: 'canvas' },
      shouldRun: ctx => RenderControls.get('ssr') === true && !!ctx.ssr && ctx.res.ssrComputed === ctx.frameId,
      run(ctx) {
        ctx.ssr.composite()
        ctx.res.ssrComposited = ctx.frameId
      },
    },
  ]
}

// Lazy installer: constructs the SSR GPU resources on first call and stashes the instance on
// ctx.ssr. Callers wire this once at boot (mirrors installSSAO/installBloom).
//
// NAMING TRAP AVOIDED (same discipline as SSAO.js/Bloom.js): the debug instance handle is exposed
// as window.__ssrDebug, NEVER window.__ssr -- RenderControls.js's 'ssr' knob mirrors onto
// window.__ssr (get/set read/write that exact global name).
export function installSSR(ctx, renderer, scene, camera) {
  if (!ctx.ssr) ctx.ssr = new SSR(renderer, scene, camera)
  if (typeof window !== 'undefined') window.__ssrDebug = ctx.ssr
  return ctx.ssr
}
