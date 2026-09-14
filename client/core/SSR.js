import * as THREE from 'three'
import { RenderControls } from './RenderControls.js'
import { getWetness as _getWeatherWetness } from './WetnessTint.js'
import { SEA_SURFACE_GLSL, adoptSeaUniforms } from './UnderwaterTint.js'

const _fullscreenVert = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`

const _wetnessGbufferVert = `
  void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`
const _wetnessGbufferFrag = `
  uniform float uWetness;
  void main() { gl_FragColor = vec4(uWetness, 0.0, 0.0, 1.0); }
`

const _defaultOnBeforeRender = new THREE.Object3D().onBeforeRender
const _sizeScratch = new THREE.Vector2()
const _prevClearColor = new THREE.Color()

const _ssrFrag = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tGBuffer;
  uniform sampler2D tScene;
  uniform sampler2D tWetness;
  uniform bool uHasWetness;
  uniform float uWeatherWetness;
  uniform vec2 uResolution;
  uniform mat4 uProjectionMatrix;
  uniform float uFovFactor;
  uniform float uAspect;
  uniform float uIntensity;
  uniform float uMaxDistance;
  uniform vec3 uCamWorld;
  uniform float uBandHeight;
  uniform mat3 uNormalViewToWorld;
  ${SEA_SURFACE_GLSL}

  const int STEPS = 12;

  vec3 reconstructViewPos(vec2 uv, float depth) {
    vec2 ndc = uv * 2.0 - 1.0;
    vec3 viewDir = normalize(vec3(ndc.x * uFovFactor * uAspect, ndc.y * uFovFactor, -1.0));
    float t = depth / max(0.0001, -viewDir.z);
    return viewDir * t;
  }

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

    vec3 fragWorld = vec3(dot(uNormalViewToWorld[0], centerPos), dot(uNormalViewToWorld[1], centerPos), dot(uNormalViewToWorld[2], centerPos)) + uCamWorld;
    float bandDist = spointSeaEnabled() ? abs(fragWorld.y - spointSeaSurfaceY(fragWorld)) : uBandHeight;
    float bandFade = 1.0 - clamp(bandDist / uBandHeight, 0.0, 1.0);
    float matWetness = uHasWetness ? texture2D(tWetness, vUv).r : 0.0;
    float wetMask = max(max(bandFade, matWetness), uWeatherWetness);
    if (wetMask <= 0.0) { gl_FragColor = vec4(0.0); return; }

    vec3 viewDir = normalize(centerPos);
    float ndotv = clamp(dot(centerNormal, -viewDir), 0.0, 1.0);
    if (centerNormal.y < 0.3) { gl_FragColor = vec4(0.0); return; }
    float fresnel = pow(1.0 - ndotv, 2.0);

    vec3 reflectDir = reflect(viewDir, centerNormal);
    if (reflectDir.z >= 0.0) { gl_FragColor = vec4(0.0); return; }

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

const _compositeFrag = `
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
        uCamWorld: { value: new THREE.Vector3() },
        uBandHeight: { value: RenderControls.get('ssrBandHeight') },
        uNormalViewToWorld: { value: new THREE.Matrix3() },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    adoptSeaUniforms(this._ssrMat.uniforms)
    this._quad = new THREE.Mesh(this._quadGeo, this._ssrMat)
    this._quad.frustumCulled = false
    this._quadScene.add(this._quad)

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
    this._wetnessTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    })
    this._sceneCopyTex = new THREE.FramebufferTexture(fullW, fullH)
    this._ssrMat.uniforms.uResolution.value.set(w, h)
    this._built = true
  }

  _disposeTargets() {
    if (this._ssrTarget) this._ssrTarget.dispose()
    if (this._wetnessTarget) this._wetnessTarget.dispose()
    if (this._sceneCopyTex) this._sceneCopyTex.dispose()
  }

  _renderWetnessGBuffer() {
    if (!this._wetnessTarget) return false
    const mat = this._wetnessMat
    const pushWetness = function (renderer, scene, camera, geometry, material) {
      mat.uniforms.uWetness.value = this.userData.wetness || 0
    }
    const touched = []
    this.scene.traverse(o => {
      if (!o.isMesh || !o.visible) return
      if (o.onBeforeRender !== _defaultOnBeforeRender) return
      touched.push([o, o.onBeforeRender])
      o.onBeforeRender = pushWetness
    })
    const prevTarget = this.renderer.getRenderTarget()
    const prevOverride = this.scene.overrideMaterial
    const prevAutoClear = this.renderer.autoClear
    const prevClearColor = _prevClearColor
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

  setSharedGBuffer(gbufferTexture) {
    this._sharedGBuffer = gbufferTexture || null
  }

  compute() {
    const gbuffer = this._sharedGBuffer
    if (!gbuffer) return
    const size = _sizeScratch
    this.renderer.getSize(size)
    if (size.x <= 0 || size.y <= 0) return
    this._ensureTargets(size.x, size.y)

    const prevTarget = this.renderer.getRenderTarget()
    const prevAutoClear = this.renderer.autoClear
    if (prevTarget !== null) return

    try {
      this.renderer.copyFramebufferToTexture(this._sceneCopyTex)
    } catch (_) {
      return
    }

    const hasWetness = this._renderWetnessGBuffer()

    const fov = this.camera.fov ? THREE.MathUtils.degToRad(this.camera.fov) : Math.PI / 3
    const u = this._ssrMat.uniforms
    u.tGBuffer.value = gbuffer
    u.tScene.value = this._sceneCopyTex
    u.tWetness.value = hasWetness ? this._wetnessTarget.texture : null
    u.uHasWetness.value = hasWetness
    u.uWeatherWetness.value = THREE.MathUtils.clamp(_getWeatherWetness() || 0, 0, 1)
    u.uProjectionMatrix.value.copy(this.camera.projectionMatrix)
    u.uFovFactor.value = Math.tan(fov / 2)
    u.uAspect.value = size.x / size.y
    u.uIntensity.value = RenderControls.get('ssrIntensity')
    u.uMaxDistance.value = RenderControls.get('ssrMaxDistance')
    u.uBandHeight.value = RenderControls.get('ssrBandHeight')
    this.camera.getWorldPosition(u.uCamWorld.value)
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

export function buildSSRNodes() {
  return [
    {
      id: 'ssr-compute',
      reads: ['sceneColor', 'ssaoComputed'],
      writes: ['ssrComputed'],
      shouldRun: ctx => RenderControls.get('ssr') === true && !!ctx.ssr && RenderControls.get('ssao') === true,
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

export function installSSR(ctx, renderer, scene, camera) {
  if (!ctx.ssr) ctx.ssr = new SSR(renderer, scene, camera)
  if (typeof window !== 'undefined') window.__ssrDebug = ctx.ssr
  return ctx.ssr
}
