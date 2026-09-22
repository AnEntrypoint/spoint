import * as THREE from 'three'
import { MeshBasicNodeMaterial, QuadMesh } from 'three/webgpu'
import {
  Fn, texture, uv, uniform, vec2, vec3, vec4, float, int,
  clamp, max, min, length, dot, normalize, reflect, smoothstep, pow, abs, sqrt,
  Loop, If, Break,
} from 'three/tsl'
import { RenderControls } from './RenderControls.js'
import { getWetness as _getWeatherWetness } from './WetnessTint.js'

const STEPS = 12

function buildSeaHelpers(seaUniform, seaShiftUniform) {
  const spointSeaEnabled = Fn(() => seaUniform.z.greaterThan(0.5))

  const spointSeaSurfaceY = Fn(([renderPos]) => {
    const a = renderPos.xz.add(seaShiftUniform.xz)
    const r2 = dot(a, a)
    const rho = seaUniform.y
    const drop = rho.greaterThan(0.0).select(
      r2.div(rho.add(sqrt(max(rho.mul(rho).sub(r2), 0.0)))),
      float(0.0),
    )
    return seaUniform.x.sub(seaShiftUniform.y).sub(drop)
  })

  return { spointSeaEnabled, spointSeaSurfaceY }
}

function buildSSRColorNode(u) {
  const { spointSeaEnabled, spointSeaSurfaceY } = buildSeaHelpers(u.seaUniform, u.seaShiftUniform)

  const reconstructViewPos = Fn(([uvIn, depth]) => {
    const ndc = uvIn.mul(2.0).sub(1.0)
    const viewDir = normalize(vec3(ndc.x.mul(u.fovFactorUniform).mul(u.aspectUniform), ndc.y.mul(u.fovFactorUniform), -1.0))
    const t = depth.div(max(0.0001, viewDir.z.negate()))
    return viewDir.mul(t)
  })

  const viewToScreen = Fn(([viewPos]) => {
    const clip = u.projectionMatrixUniform.mul(vec4(viewPos, 1.0)).toVar()
    const ndc = clip.xy.div(clip.w)
    const projected = vec3(ndc.mul(0.5).add(0.5), viewPos.z.negate())
    return clip.w.lessThanEqual(0.0).select(vec3(-1.0, -1.0, -1.0), projected)
  })

  return Fn(() => {
    const vUv = uv()
    const center = texture(u.gbufferTex, vUv)
    const centerDepth = center.a.toVar()
    const outColor = vec4(0.0, 0.0, 0.0, 0.0).toVar()

    If(centerDepth.greaterThan(0.0), () => {
      const centerNormal = normalize(center.rgb.mul(2.0).sub(1.0)).toVar()
      const centerPos = reconstructViewPos(vUv, centerDepth).toVar()

      const fragWorld = vec3(
        dot(u.normalViewToWorldUniform[0], centerPos),
        dot(u.normalViewToWorldUniform[1], centerPos),
        dot(u.normalViewToWorldUniform[2], centerPos),
      ).add(u.camWorldUniform).toVar()

      const bandDist = spointSeaEnabled().select(
        abs(fragWorld.y.sub(spointSeaSurfaceY(fragWorld))),
        u.bandHeightUniform,
      )
      const bandFade = float(1.0).sub(clamp(bandDist.div(u.bandHeightUniform), 0.0, 1.0))
      const matWetness = u.hasWetnessUniform.select(texture(u.wetnessTex, vUv).r, float(0.0))
      const wetMask = max(max(bandFade, matWetness), u.weatherWetnessUniform).toVar()

      If(wetMask.greaterThan(0.0), () => {
        const viewDir = normalize(centerPos).toVar()
        const ndotv = clamp(dot(centerNormal, viewDir.negate()), 0.0, 1.0)

        If(centerNormal.y.greaterThanEqual(0.3), () => {
          const fresnel = pow(float(1.0).sub(ndotv), 2.0)
          const reflectDir = reflect(viewDir, centerNormal).toVar()

          If(reflectDir.z.lessThan(0.0), () => {
            const rayPos = centerPos.toVar()
            const stepLen = u.maxDistanceUniform.div(float(STEPS))
            const result = vec4(0.0, 0.0, 0.0, 0.0).toVar()

            Loop({ start: int(1), end: int(STEPS), type: 'int', condition: '<=' }, ({ i }) => {
              rayPos.addAssign(reflectDir.mul(stepLen))
              const screenPos = viewToScreen(rayPos).toVar()

              If(
                screenPos.x.lessThan(0.0).or(screenPos.x.greaterThan(1.0))
                  .or(screenPos.y.lessThan(0.0)).or(screenPos.y.greaterThan(1.0)),
                () => { Break() },
              )

              const sampledDepth = texture(u.gbufferTex, screenPos.xy).a

              If(sampledDepth.greaterThan(0.0), () => {
                const rayDepth = screenPos.z
                const depthDiff = sampledDepth.sub(rayDepth)

                If(depthDiff.greaterThan(0.0).and(depthDiff.lessThan(stepLen.mul(2.0))), () => {
                  const edgeFade = smoothstep(0.0, 0.08, screenPos.xy).mul(smoothstep(0.0, 0.08, float(1.0).sub(screenPos.xy)))
                  const fade = edgeFade.x.mul(edgeFade.y).mul(float(1.0).sub(float(i).div(float(STEPS))))
                  result.assign(vec4(texture(u.sceneTex, screenPos.xy).rgb, fade))
                  Break()
                })
              })
            })

            outColor.assign(vec4(result.rgb, result.a.mul(fresnel).mul(wetMask).mul(u.intensityUniform)))
          })
        })
      })
    })

    return outColor
  })()
}

function buildWetnessColorNode(wetnessUniform) {
  return Fn(() => vec4(wetnessUniform, 0.0, 0.0, 1.0))()
}

function buildCompositeNode(ssrTex) {
  return Fn(() => texture(ssrTex, uv()))()
}

export class SSRWebGPU {
  constructor(renderer, scene, camera) {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    this._w = 0
    this._h = 0
    this._built = false

    this._gbufferTex = uniform(null)
    this._sceneTex = uniform(null)
    this._wetnessTex = uniform(null)
    this._hasWetnessUniform = uniform(false)
    this._weatherWetnessUniform = uniform(0)
    this._projectionMatrixUniform = uniform(new THREE.Matrix4())
    this._fovFactorUniform = uniform(1)
    this._aspectUniform = uniform(1)
    this._intensityUniform = uniform(RenderControls.get('ssrIntensity'))
    this._maxDistanceUniform = uniform(RenderControls.get('ssrMaxDistance'))
    this._camWorldUniform = uniform(new THREE.Vector3())
    this._bandHeightUniform = uniform(RenderControls.get('ssrBandHeight'))
    this._normalViewToWorldUniform = uniform(new THREE.Matrix3())
    this._seaUniform = uniform(new THREE.Vector4(-100000, 0, 0, 0))
    this._seaShiftUniform = uniform(new THREE.Vector3())

    this._ssrMat = new MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false })
    this._ssrMat.colorNode = buildSSRColorNode({
      gbufferTex: this._gbufferTex,
      sceneTex: this._sceneTex,
      wetnessTex: this._wetnessTex,
      hasWetnessUniform: this._hasWetnessUniform,
      weatherWetnessUniform: this._weatherWetnessUniform,
      projectionMatrixUniform: this._projectionMatrixUniform,
      fovFactorUniform: this._fovFactorUniform,
      aspectUniform: this._aspectUniform,
      intensityUniform: this._intensityUniform,
      maxDistanceUniform: this._maxDistanceUniform,
      camWorldUniform: this._camWorldUniform,
      bandHeightUniform: this._bandHeightUniform,
      normalViewToWorldUniform: this._normalViewToWorldUniform,
      seaUniform: this._seaUniform,
      seaShiftUniform: this._seaShiftUniform,
    })

    this._wetnessUniform = uniform(0)
    this._wetnessMat = new MeshBasicNodeMaterial({ side: THREE.DoubleSide })
    this._wetnessMat.colorNode = buildWetnessColorNode(this._wetnessUniform)

    this._compositeMat = new MeshBasicNodeMaterial({
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.NormalBlending,
    })

    this._quad = new QuadMesh(this._ssrMat)
  }

  _ensureTargets(fullW, fullH) {
    const w = Math.max(4, Math.floor(fullW * 0.5))
    const h = Math.max(4, Math.floor(fullH * 0.5))
    const fullResChanged = fullW !== this._fullW || fullH !== this._fullH
    if (this._built && w === this._w && h === this._h && !fullResChanged) return
    this._disposeTargets()
    this._w = w; this._h = h
    this._fullW = fullW; this._fullH = fullH
    this._ssrTarget = new THREE.RenderTarget(w, h, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    })
    this._wetnessTarget = new THREE.RenderTarget(w, h, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    })
    this._sceneCopyTex = new THREE.FramebufferTexture(fullW, fullH)
    this._built = true
  }

  _disposeTargets() {
    if (this._ssrTarget) this._ssrTarget.dispose()
    if (this._wetnessTarget) this._wetnessTarget.dispose()
    if (this._sceneCopyTex) this._sceneCopyTex.dispose()
  }

  _renderWetnessGBuffer() {
    if (!this._wetnessTarget) return false
    const wetnessUniform = this._wetnessUniform
    const pushWetness = function (renderer, scene, camera, geometry, material) {
      wetnessUniform.value = this.userData.wetness || 0
    }
    const defaultOnBeforeRender = THREE.Object3D.prototype.onBeforeRender
    const touched = []
    this.scene.traverse(o => {
      if (!o.isMesh || !o.visible) return
      if (o.onBeforeRender !== defaultOnBeforeRender) return
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

  setSharedGBuffer(gbufferTexture) {
    this._sharedGBuffer = gbufferTexture || null
  }

  compute() {
    const gbuffer = this._sharedGBuffer
    if (!gbuffer) return
    const size = new THREE.Vector2()
    this.renderer.getSize(size)
    if (size.x <= 0 || size.y <= 0) return
    this._ensureTargets(size.x, size.y)

    const prevTarget = this.renderer.getRenderTarget()
    if (prevTarget !== null) return

    try {
      this.renderer.copyFramebufferToTexture(this._sceneCopyTex)
    } catch (_) {
      return
    }

    const hasWetness = this._renderWetnessGBuffer()

    const fov = this.camera.fov ? THREE.MathUtils.degToRad(this.camera.fov) : Math.PI / 3
    this._gbufferTex.value = gbuffer
    this._sceneTex.value = this._sceneCopyTex
    this._wetnessTex.value = hasWetness ? this._wetnessTarget.texture : null
    this._hasWetnessUniform.value = hasWetness
    this._weatherWetnessUniform.value = THREE.MathUtils.clamp(_getWeatherWetness() || 0, 0, 1)
    this._projectionMatrixUniform.value.copy(this.camera.projectionMatrix)
    this._fovFactorUniform.value = Math.tan(fov / 2)
    this._aspectUniform.value = size.x / size.y
    this._intensityUniform.value = RenderControls.get('ssrIntensity')
    this._maxDistanceUniform.value = RenderControls.get('ssrMaxDistance')
    this._bandHeightUniform.value = RenderControls.get('ssrBandHeight')
    this.camera.getWorldPosition(this._camWorldUniform.value)
    const vm = this.camera.matrixWorldInverse.elements
    this._normalViewToWorldUniform.value.set(
      vm[0], vm[1], vm[2],
      vm[4], vm[5], vm[6],
      vm[8], vm[9], vm[10],
    ).transpose()

    const underwaterTint = typeof window !== 'undefined' ? window.__underwaterTint : null
    if (underwaterTint && underwaterTint.uniform && underwaterTint.uniform.value) {
      const sv = underwaterTint.uniform.value
      this._seaUniform.value.set(sv[0], sv[1], sv[2], sv[3])
    }
    if (underwaterTint && underwaterTint.shiftUniform && underwaterTint.shiftUniform.value) {
      const sv = underwaterTint.shiftUniform.value
      this._seaShiftUniform.value.set(sv[0], sv[1], sv[2])
    }

    this._quad.material = this._ssrMat
    this.renderer.setRenderTarget(this._ssrTarget)
    this.renderer.autoClear = true
    this._quad.render(this.renderer)

    this.renderer.setRenderTarget(prevTarget)
    this.reflectionTexture = this._ssrTarget.texture
  }

  composite() {
    if (!this.reflectionTexture) return
    if (!this._compositeMat.colorNode || this._compositeMat.userData.__ssrTex !== this.reflectionTexture) {
      this._compositeMat.colorNode = buildCompositeNode(this.reflectionTexture)
      this._compositeMat.needsUpdate = true
      this._compositeMat.userData.__ssrTex = this.reflectionTexture
    }
    this._quad.material = this._compositeMat
    const prevAutoClear = this.renderer.autoClear
    this.renderer.autoClear = false
    this._quad.render(this.renderer)
    this.renderer.autoClear = prevAutoClear
  }

  dispose() {
    this._disposeTargets()
    this._ssrMat.dispose()
    this._wetnessMat.dispose()
    this._compositeMat.dispose()
  }
}
