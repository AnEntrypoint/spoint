import * as THREE from 'three'
import { RenderControls } from './RenderControls.js'

const _gbufferVert = `
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
const _gbufferFrag = `
  varying vec3 vViewNormal;
  varying float vViewDepth;
  void main() {
    // rgb = view-space normal (encoded 0..1), a = linear view-space depth (raw metres, decoded by
    // the AO pass -- cheap and exact, no need for depth-buffer curve reconstruction since we own
    // this G-buffer's encoding end to end).
    gl_FragColor = vec4(normalize(vViewNormal) * 0.5 + 0.5, vViewDepth);
  }
`

const _aoFrag = `
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

const _fullscreenVert = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

const _compositeFrag = `
  varying vec2 vUv;
  uniform sampler2D tAO;
  void main() {
    float ao = texture2D(tAO, vUv).r;
    gl_FragColor = vec4(vec3(ao), 1.0);
  }
`

function _makeGBufferMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: _gbufferVert,
    fragmentShader: _gbufferFrag,
    side: THREE.DoubleSide,
  })
}

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

    this.renderer.setRenderTarget(this._gbufferTarget)
    this.renderer.autoClear = true
    this.renderer.setClearColor(0x000000, 0)
    this.scene.overrideMaterial = this._gbufferMat
    this.renderer.render(this.scene, this.camera)
    this.scene.overrideMaterial = prevOverride

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

    this.renderer.setRenderTarget(prevTarget)
    this.renderer.autoClear = prevAutoClear
    this.renderer.setClearColor(prevClearColor, prevClearAlpha)
    this.aoTexture = this._aoTarget.texture
  }

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

let _SSAOWebGPUModule = null
function _requireSSAOWebGPU() {
  if (!_SSAOWebGPUModule) throw new Error('SSAOWebGPU not registered -- call registerSSAOWebGPU() once at boot before installSSAO runs under a WebGPURenderer')
  return _SSAOWebGPUModule
}
export function registerSSAOWebGPU(mod) {
  _SSAOWebGPUModule = mod
}
