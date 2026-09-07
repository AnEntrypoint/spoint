// SSAO -- half-res GTAO-style screen-space ambient occlusion, gated behind RenderControls('ssao').
//
// WHY A DEDICATED G-BUFFER, NOT THE SHARED CANVAS DEPTH: DepthComposite.js documents the contract
// that mapspinner's raw-GL terrain/water/sky and the THREE scene share ONE depth buffer baked
// straight into the CANVAS (no offscreen scene depth texture exists anywhere in this pipeline --
// there is no EffectComposer/RenderTarget-based post-process stage in this repo at all, confirmed
// via codesearch of client/core/*.js and client/app.js). A real screen-space AO pass needs a
// SAMPLABLE depth+normal texture (readPixels-per-fragment against the canvas is not viable), so
// this module renders its OWN small, independent half-res G-buffer pass (MeshNormalMaterial
// override on the THREE scene only -- mapspinner's raw-GL terrain is NOT captured here, matching
// three's own stock GTAOPass/SSAOPass scope, which also only sees the THREE scene) into a
// dedicated WebGLRenderTarget. This second render is additional GPU cost gated fully behind the
// 'ssao' RenderControls flag (device-tier default off on low-tier) and is a NEW, ADDITIVE resource
// -- it never touches the 'sceneDepth'/'terrainDepth' single-writer resources DepthComposite.js
// documents, so the existing depth-composite contract is untouched by this feature.
//
// PASS SHAPE:
//   1. gbuffer pass: render scene with a shared MeshNormalMaterial override, half resolution,
//      into a target with an attached DepthTexture (so both view-space normal.rgb+depth.a end up
//      in one RGBA half-float texture, and true hardware depth is separately samplable).
//   2. ao pass: full-screen shader samples the depth+normal G-buffer, does a lightweight
//      horizon-based (GTAO-style) occlusion estimate over a small kernel of screen-space offsets,
//      writes a single-channel AO term to a second half-res target.
//   3. composite: full-screen multiplicative blend of the (bilinearly-upsampled) AO term onto the
//      canvas -- additive blending mode set to MultiplyBlending against the existing canvas
//      contents, so scene-color's own draw is untouched and this is purely a post-multiply darken.
//
// All three passes are driven from RenderGraph nodes (see RenderGraph.nodes.js ssaoNodes below);
// this module only owns the GPU resources (targets/materials/quad) and the render calls.

import * as THREE from 'three'
import { RenderControls } from './RenderControls.js'

// instancedmesh2-instanceindex-undeclared-identifier-vegetation-shader: this G-buffer vertex shader is
// applied scene-wide via scene.overrideMaterial (see runGbufferPass below), which reaches every
// InstancedMesh2 in the scene -- including grass/vegetation meshes that called initUniformsPerInstance
// (Grass.js/Vegetation.js). InstancedMesh2's per-instance uniform injection needs the instanceIndex
// vertex attribute in scope; THREE's own ShaderLib templates get it for free via
// '#include <batching_pars_vertex>', but this hand-written override shader had neither that nor
// '#include <instanced_pars_vertex>' -- same real live GL compile failure class as Grass.js's own
// material (ERROR 0:86 'instanceIndex' : undeclared identifier), caught live via the same
// WebGLRenderingContext.prototype.compileShader monkeypatch against a real booted server + grass
// streamed in during real gameplay (PORT=8250). Fixed the same way: include the chunk that declares
// instanceIndex + getInstancedMatrix(), and apply the per-instance transform (this shader previously
// read `position`/`normal` completely untransformed by any instance matrix -- for a NATIVE
// THREE.InstancedMesh that's simply a separate pre-existing bug this fix also closes, since a
// compiling-but-mispositioned G-buffer sample is not a real fix; for InstancedMesh2's indirect mode the
// raw instanceMatrix attribute is a dummy zero-length buffer, the real per-instance matrix lives in
// matricesTexture via getInstancedMatrix()).
const _gbufferVert = /* glsl */`
  varying vec3 vViewNormal;
  varying float vViewDepth;
  #include <instanced_pars_vertex>
  void main() {
    #ifdef USE_INSTANCING_INDIRECT
      mat4 instanceMatrix = getInstancedMatrix();
    #endif
    #if defined USE_INSTANCING || defined USE_INSTANCING_INDIRECT
      vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      vViewNormal = normalize(normalMatrix * mat3(instanceMatrix) * normal);
    #else
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      vViewNormal = normalize(normalMatrix * normal);
    #endif
    vViewDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
  }
`
const _gbufferFrag = /* glsl */`
  varying vec3 vViewNormal;
  varying float vViewDepth;
  void main() {
    // rgb = view-space normal (encoded 0..1), a = linear view-space depth (raw metres, decoded by
    // the AO pass -- cheap and exact, no need for depth-buffer curve reconstruction since we own
    // this G-buffer's encoding end to end).
    gl_FragColor = vec4(normalize(vViewNormal) * 0.5 + 0.5, vViewDepth);
  }
`

// Compact GTAO-style horizon-based AO: for each of a small fixed set of screen-space directions,
// walk a few steps outward sampling the G-buffer depth, reconstruct the sampled point's view-space
// position, and accumulate occlusion from how far behind the local tangent-plane horizon it sits.
// This is deliberately small (4 directions x 3 steps = 12 taps) since it runs at half resolution
// already gated off by default on low-tier devices -- the "half-res GTAO" scope this row asked for,
// not a full high-sample-count reference implementation.
const _aoFrag = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tGBuffer;
  uniform vec2 uResolution;
  uniform float uRadius;
  uniform float uIntensity;
  uniform mat4 uProjectionMatrix;
  uniform float uFovFactor; // tan(fov/2), for reconstructing view-space XY from uv+depth

  vec3 reconstructViewPos(vec2 uv, float depth) {
    vec2 ndc = uv * 2.0 - 1.0;
    float aspect = uResolution.x / uResolution.y;
    vec3 viewDir = normalize(vec3(ndc.x * uFovFactor * aspect, ndc.y * uFovFactor, -1.0));
    // viewDir.z is negative-forward; scale so that the -z component equals -depth (linear depth
    // stored is already the forward distance along -Z, not along the ray) using the ray's own
    // -z-normalized parametrization.
    float t = depth / max(0.0001, -viewDir.z);
    return viewDir * t;
  }

  void main() {
    vec4 center = texture2D(tGBuffer, vUv);
    float centerDepth = center.a;
    if (centerDepth <= 0.0) { gl_FragColor = vec4(1.0); return; } // background / no geometry: no AO
    vec3 centerNormal = normalize(center.rgb * 2.0 - 1.0);
    vec3 centerPos = reconstructViewPos(vUv, centerDepth);

    float occlusion = 0.0;
    const int DIRS = 4;
    const int STEPS = 3;
    vec2 dirs[DIRS];
    dirs[0] = vec2(1.0, 0.0); dirs[1] = vec2(-1.0, 0.0); dirs[2] = vec2(0.0, 1.0); dirs[3] = vec2(0.0, -1.0);
    float pixelRadius = max(2.0, uRadius * uResolution.y / max(1.0, centerDepth * uFovFactor * 2.0));
    pixelRadius = min(pixelRadius, uResolution.y * 0.25); // clamp so distant/close geometry can't blow the kernel out

    for (int d = 0; d < DIRS; d++) {
      float horizonCos = 0.0; // cosine of the highest elevation angle found along this direction so far
      for (int s = 1; s <= STEPS; s++) {
        float frac = float(s) / float(STEPS);
        vec2 offsetUv = vUv + dirs[d] * (pixelRadius * frac / uResolution);
        if (offsetUv.x < 0.0 || offsetUv.x > 1.0 || offsetUv.y < 0.0 || offsetUv.y > 1.0) continue;
        vec4 sampleG = texture2D(tGBuffer, offsetUv);
        if (sampleG.a <= 0.0) continue;
        vec3 samplePos = reconstructViewPos(offsetUv, sampleG.a);
        vec3 toSample = samplePos - centerPos;
        float dist = length(toSample);
        if (dist < 0.0001 || dist > uRadius) continue;
        float sampleCos = dot(centerNormal, toSample) / dist;
        // Falloff so samples near the radius edge contribute less (avoids a hard cutoff ring).
        float falloff = clamp(1.0 - (dist / uRadius), 0.0, 1.0);
        horizonCos = max(horizonCos, sampleCos * falloff);
      }
      occlusion += clamp(horizonCos, 0.0, 1.0);
    }
    occlusion = occlusion / float(DIRS);
    float ao = 1.0 - clamp(occlusion * uIntensity, 0.0, 1.0);
    gl_FragColor = vec4(vec3(ao), 1.0);
  }
`

const _fullscreenVert = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

const _compositeFrag = /* glsl */`
  varying vec2 vUv;
  uniform sampler2D tAO;
  void main() {
    float ao = texture2D(tAO, vUv).r;
    gl_FragColor = vec4(vec3(ao), 1.0);
  }
`

// A single shared MeshNormalMaterial-equivalent override used to render the G-buffer -- one
// ShaderMaterial swapped in for every scene material via onBeforeRender-style overrideMaterial,
// exactly how three's own RenderPass/GTAOPass do it.
function _makeGBufferMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: _gbufferVert,
    fragmentShader: _gbufferFrag,
    side: THREE.DoubleSide,
  })
}

// Per-frame scratch (compute() restores the previous clear colour every frame; was one Color alloc per call).
const _prevClearColor = new THREE.Color()

export class SSAO {
  constructor(renderer, scene, camera) {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    this._w = 0
    this._h = 0
    this._built = false
    this._gbufferMat = _makeGBufferMaterial()

    this._quadScene = new THREE.Scene()
    this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this._quadGeo = new THREE.PlaneGeometry(2, 2)

    this._aoMat = new THREE.ShaderMaterial({
      vertexShader: _fullscreenVert,
      fragmentShader: _aoFrag,
      uniforms: {
        tGBuffer: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uRadius: { value: RenderControls.get('ssaoRadius') },
        uIntensity: { value: RenderControls.get('ssaoIntensity') },
        uProjectionMatrix: { value: new THREE.Matrix4() },
        uFovFactor: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    })
    this._aoQuad = new THREE.Mesh(this._quadGeo, this._aoMat)
    this._aoQuad.frustumCulled = false

    this._compositeMat = new THREE.ShaderMaterial({
      vertexShader: _fullscreenVert,
      fragmentShader: _compositeFrag,
      uniforms: { tAO: { value: null } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.MultiplyBlending,
      premultipliedAlpha: true,
    })
    this._compositeQuad = new THREE.Mesh(this._quadGeo, this._compositeMat)
    this._compositeQuad.frustumCulled = false
  }

  _ensureTargets(fullW, fullH) {
    const w = Math.max(4, Math.floor(fullW * 0.5))
    const h = Math.max(4, Math.floor(fullH * 0.5))
    if (this._built && w === this._w && h === this._h) return
    this._disposeTargets()
    this._w = w; this._h = h
    this._gbufferTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    })
    this._aoTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    })
    this._aoMat.uniforms.uResolution.value.set(w, h)
    this._built = true
  }

  _disposeTargets() {
    if (this._gbufferTarget) this._gbufferTarget.dispose()
    if (this._aoTarget) this._aoTarget.dispose()
  }

  // Renders the G-buffer + AO term for the current frame. Does not composite -- callers read
  // this.aoTexture and composite explicitly (kept split so the RenderGraph node boundary matches
  // one node per declared resource, per the NODE CONTRACT in RenderGraph.js).
  computeAO() {
    if (!this._scratchSize) this._scratchSize = new THREE.Vector2()
    this.renderer.getSize(this._scratchSize)
    this._ensureTargets(this._scratchSize.x, this._scratchSize.y)

    const prevTarget = this.renderer.getRenderTarget()
    const prevOverride = this.scene.overrideMaterial
    const prevAutoClear = this.renderer.autoClear
    const prevClearColor = _prevClearColor
    this.renderer.getClearColor(prevClearColor)
    const prevClearAlpha = this.renderer.getClearAlpha()

    // 1. G-buffer pass: view-space normal + linear depth, half-res, THREE scene only.
    this.renderer.setRenderTarget(this._gbufferTarget)
    this.renderer.autoClear = true
    this.renderer.setClearColor(0x000000, 0)
    this.scene.overrideMaterial = this._gbufferMat
    this.renderer.render(this.scene, this.camera)
    this.scene.overrideMaterial = prevOverride

    // 2. AO pass: full-screen shader over the G-buffer.
    const fov = this.camera.fov ? THREE.MathUtils.degToRad(this.camera.fov) : Math.PI / 3
    this._aoMat.uniforms.tGBuffer.value = this._gbufferTarget.texture
    this._aoMat.uniforms.uRadius.value = RenderControls.get('ssaoRadius')
    this._aoMat.uniforms.uIntensity.value = RenderControls.get('ssaoIntensity')
    this._aoMat.uniforms.uFovFactor.value = Math.tan(fov / 2)
    this.renderer.setRenderTarget(this._aoTarget)
    this.renderer.autoClear = true
    if (this._aoQuad.parent !== this._quadScene) this._quadScene.add(this._aoQuad)
    if (this._compositeQuad.parent) this._quadScene.remove(this._compositeQuad)
    this.renderer.render(this._quadScene, this._quadCamera)

    // Restore state for the composite pass / rest of the frame.
    this.renderer.setRenderTarget(prevTarget)
    this.renderer.autoClear = prevAutoClear
    this.renderer.setClearColor(prevClearColor, prevClearAlpha)
    this.aoTexture = this._aoTarget.texture
  }

  // Composites the already-computed AO term onto whatever is currently bound as the render target
  // (the canvas, when called from the RenderGraph composite node after scene-color).
  composite() {
    if (!this.aoTexture) return
    this._compositeMat.uniforms.tAO.value = this.aoTexture
    if (this._compositeQuad.parent !== this._quadScene) this._quadScene.add(this._compositeQuad)
    if (this._aoQuad.parent) this._quadScene.remove(this._aoQuad)
    const prevAutoClear = this.renderer.autoClear
    this.renderer.autoClear = false
    this.renderer.render(this._quadScene, this._quadCamera)
    this.renderer.autoClear = prevAutoClear
  }

  dispose() {
    this._disposeTargets()
    this._gbufferMat.dispose()
    this._aoMat.dispose()
    this._compositeMat.dispose()
    this._quadGeo.dispose()
  }
}

// RenderGraph nodes for the SSAO tier -- declared-resource, gated behind RenderControls('ssao'),
// composited AFTER scene-color so the AO term darkens the already-drawn frame (both the THREE
// scene and, since it reads the canvas as the composite destination via multiply-blend, the
// mapspinner terrain color already present from terrain-depth-color). ctx.ssao is a lazily-built
// SSAO instance (see installSSAO below) so a caller that never enables the flag pays zero
// construction cost until the first frame the flag is actually on.
export function buildSSAONodes() {
  return [
    {
      id: 'ssao-compute',
      reads: ['sceneColor'],
      writes: ['ssaoComputed'],
      shouldRun: ctx => RenderControls.get('ssao') === true && !!ctx.ssao,
      run(ctx) {
        ctx.ssao.computeAO()
        ctx.res.ssaoComputed = ctx.frameId
      },
    },
    {
      id: 'ssao-composite',
      reads: ['ssaoComputed'],
      writes: ['ssaoComposited'],
      targets: { ssaoComposited: 'canvas' },
      shouldRun: ctx => RenderControls.get('ssao') === true && !!ctx.ssao && ctx.res.ssaoComputed === ctx.frameId,
      run(ctx) {
        ctx.ssao.composite()
        ctx.res.ssaoComposited = ctx.frameId
      },
    },
  ]
}

// Lazy installer: constructs the SSAO GPU resources on first call and stashes the instance on
// ctx.ssao. Callers wire this once at boot (mirrors how other per-frame handles like ctx.vegetation
// are populated asynchronously after the render loop starts -- see RenderGraph.nodes.js header).
//
// NAMING TRAP AVOIDED: the debug instance handle is exposed as window.__ssaoDebug, NEVER
// window.__ssao -- RenderControls.js's 'ssao' knob mirrors onto window.__ssao (get/set read/write
// that exact global name, see RenderControls.js's CONTRACT comment). A live bug was caught here
// during verification: installSSAO originally also wrote the instance object to window.__ssao,
// which permanently shadowed the boolean flag (RenderControls.get('ssao') returned the truthy
// instance object instead of true/false, and RenderControls.set('ssao', false) would have
// overwritten the debug handle with the literal value false, destroying it). Every other per-system
// debug handle in this codebase (window.__sceneOcclusion, window.__shadowPipeline, etc.) already
// avoids this by not sharing a name with any RenderControls knob -- __ssaoDebug follows the same
// discipline.
// RENDERER-POLYMORPHIC (webgpurenderer-tsl-port-lowrisk-fullscreen-passes-remaining-8, mirrors
// Bloom.js's installBloom / FSR1.js's installFSR1 exactly): this raw-GLSL ShaderMaterial
// implementation only works under WebGLRenderer. When renderer.isWebGPURenderer is true, install
// the TSL-native sibling (SSAOWebGPU.js, same G-buffer + horizon-AO + composite math, ported
// node-for-node) instead -- every caller (RenderGraph nodes above, app.js) is unaffected since both
// classes share the identical computeAO()/composite()/dispose() public surface.
export function installSSAO(ctx, renderer, scene, camera) {
  if (!ctx.ssao) {
    if (renderer && renderer.isWebGPURenderer) {
      const { SSAOWebGPU } = _requireSSAOWebGPU()
      ctx.ssao = new SSAOWebGPU(renderer, scene, camera)
    } else {
      ctx.ssao = new SSAO(renderer, scene, camera)
    }
  }
  if (typeof window !== 'undefined') window.__ssaoDebug = ctx.ssao
  return ctx.ssao
}

// Synchronous require of the TSL sibling module -- same discipline as FSR1.js's
// _requireFSR1WebGPU/registerFSR1WebGPU pair (installSSAO stays synchronous, matching every other
// install* call site in app.js).
let _SSAOWebGPUModule = null
function _requireSSAOWebGPU() {
  if (!_SSAOWebGPUModule) throw new Error('SSAOWebGPU not registered -- call registerSSAOWebGPU() once at boot before installSSAO runs under a WebGPURenderer')
  return _SSAOWebGPUModule
}
export function registerSSAOWebGPU(mod) {
  _SSAOWebGPUModule = mod
}
