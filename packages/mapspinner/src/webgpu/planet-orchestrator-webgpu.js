import { Quadtree } from '../quadtree.js'
import { FACE_FRAME, worldToFaceLocal, quadOutsideFrustum, extractFrustumPlanes, pickFace, CULL_ELEV_FRAC } from '../planet-orchestrator-cull.js'
import { createAnchorField } from '../anchor-field.js'
import { bakeTransmittanceLUT } from '../atmosphere-transmittance-lut.js'
import { bakeScatteringLUT } from '../atmosphere-scattering-lut.js'
import { M4 } from '../gl-render-mat4.js'
import { MapspinnerPipelineCache, supportsPipelineCache } from './pipeline-cache.js'
import { PatchGridRenderer, perspectiveZeroToOne } from './patch-grid-render.js'
import { SkyRenderer, computeCamRotCols, skyFadeFromAlt } from './sky-render.js'
import { createTransmittanceLutTexture, createScatteringLutTexture, createAtmosphereLutSampler, supportsAtmosphereLutWebGPU } from './atmosphere-lut-compute.js'
import { WaterRenderer, WaterOcclusionProbe, createSceneCopyTexture, captureSceneCopy } from './water-render.js'
import { BilinearUpscale, Fsr1Upscale, DepthWriteback } from './vdrs-composite.js'

const LOD_LEAN = 0.35
const LOD_POP_ALTITUDE_MUL = 8.0
const HORIZON_SPHERE_DEPTH_BELOW_SEA = 150.0
const SUBMERGED_FAR_REACH = 60000.0
const SCULPT_RES = 256

function bakeHpfPoolData(hpf, hpfRes) {
  const bakeMaxLevel = Math.round(Math.log2(hpfRes))
  const out = new Float32Array(6 * hpfRes * hpfRes * 4)
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < hpfRes; y++) {
      const fv = y / (hpfRes - 1)
      for (let x = 0; x < hpfRes; x++) {
        const fu = x / (hpfRes - 1)
        const s = hpf.sampleUV(face, fu, fv, bakeMaxLevel)
        out[(face * hpfRes * hpfRes + y * hpfRes + x) * 4] = s.seaBias
      }
    }
  }
  return out
}

function nearFarForCam(R, camDist, alt, surfElev) {
  const altAboveTerrain = Math.max(0.001, alt - R * (surfElev || 0))
  const RHORIZON = R - HORIZON_SPHERE_DEPTH_BELOW_SEA
  const horizon = (camDist > RHORIZON) ? Math.sqrt(camDist * camDist - RHORIZON * RHORIZON) : SUBMERGED_FAR_REACH
  const near = altAboveTerrain < 2.0 ? 0.5 : Math.max(altAboveTerrain * 0.1, 0.5)
  const fBlend = Math.min(1.0, Math.max(0.0, (alt - 500000.0) / 4500000.0))
  const farGround = Math.max(horizon, alt * 8.0)
  const far = farGround * (1.0 - fBlend) + camDist * fBlend
  return { near, far }
}

function resolveThreeOwnedDepthTarget(renderer) {
  if (renderer.needsFrameBufferTarget && typeof renderer._getFrameBufferTarget === 'function' && renderer._textures) {
    const fbTarget = renderer._getFrameBufferTarget()
    if (fbTarget) {
      renderer._textures.updateRenderTarget(fbTarget, 0)
      const rtData = renderer._textures.get(fbTarget)
      const depthTexObj = rtData && rtData.depthTexture
      if (depthTexObj) {
        const backendDepthData = renderer.backend.get(depthTexObj)
        const gpuDepthTex = backendDepthData && backendDepthData.texture
        if (gpuDepthTex) return { texture: gpuDepthTex, depthFormat: gpuDepthTex.format, sampleCount: gpuDepthTex.sampleCount || 1 }
      }
    }
  }
  if (renderer.backend.textureUtils && typeof renderer.backend.textureUtils.getDepthBuffer === 'function') {
    const sharedDepthTexture = renderer.backend.textureUtils.getDepthBuffer(true, false)
    return { texture: sharedDepthTexture, depthFormat: sharedDepthTexture.format, sampleCount: 1 }
  }
  return null
}

function resolveThreeOwnedColorTarget(renderer, fallbackColorFormat) {
  if (renderer.needsFrameBufferTarget && typeof renderer._getFrameBufferTarget === 'function') {
    const fbTarget = renderer._getFrameBufferTarget()
    if (fbTarget && fbTarget.texture) {
      const backendTexData = renderer.backend.get(fbTarget.texture)
      const gpuTex = backendTexData && (backendTexData.msaaTexture || backendTexData.texture)
      if (gpuTex) return { texture: gpuTex, colorFormat: gpuTex.format, sampleCount: gpuTex.sampleCount || 1 }
    }
  }
  const backendUtils = renderer.backend.utils
  const canvasSamples = (backendUtils && typeof backendUtils.getSampleCount === 'function') ? backendUtils.getSampleCount(renderer.currentSamples || 0) : 1
  if (canvasSamples > 1) {
    return { texture: renderer.backend.textureUtils.getColorBuffer(), colorFormat: fallbackColorFormat, sampleCount: canvasSamples }
  }
  return { texture: renderer.backend.context.getCurrentTexture(), colorFormat: fallbackColorFormat, sampleCount: 1 }
}

export function supportsPlanetWebGPU(renderer) {
  return supportsPipelineCache(renderer) && supportsAtmosphereLutWebGPU(renderer.backend.device) && !!(renderer.backend.context)
}

export async function initMapspinnerPlanetWebGPU(renderer, opts = {}) {
  if (opts.radius != null && (!Number.isFinite(opts.radius) || opts.radius <= 0)) {
    throw new TypeError(`mapspinner webgpu: opts.radius must be a positive finite number, got ${opts.radius}`)
  }
  if (!supportsPlanetWebGPU(renderer)) throw new Error('mapspinner webgpu planet: renderer has no usable WebGPU device/context')
  const device = renderer.backend.device
  const R = opts.radius || 6360000
  const maxLevel = opts.maxLevel ?? 11
  const splitFactor = opts.splitFactor ?? 0.6
  const hpfRes = opts.hpfTexRes || 64

  const hpf = createAnchorField({ seed: opts.hpfSeed || 1337 })
  const hpfPoolData = bakeHpfPoolData(hpf, hpfRes)
  const sculptTexData = new Float32Array(SCULPT_RES * SCULPT_RES)

  const colorFormat = (typeof navigator !== 'undefined' && navigator.gpu && navigator.gpu.getPreferredCanvasFormat)
    ? navigator.gpu.getPreferredCanvasFormat() : 'bgra8unorm'
  const pipelineCache = new MapspinnerPipelineCache(device)
  const patchGrid = new PatchGridRenderer(device, {
    pipelineCache, colorFormat, defRadius: R,
    composeHeight: { defRadius: R, hpfRes, sculptRes: SCULPT_RES, hpfPoolData, sculptTexData },
  })

  const transLut = bakeTransmittanceLUT()
  const scatLut = bakeScatteringLUT()
  const transTex = createTransmittanceLutTexture(device, transLut)
  const scatTex = createScatteringLutTexture(device, scatLut)
  const lutSampler = createAtmosphereLutSampler(device)
  const sky = new SkyRenderer(device, { pipelineCache, colorFormat, transmittanceLutTexture: transTex, scatteringLutTexture: scatTex, sampler: lutSampler })
  const occlusionProbe = new WaterOcclusionProbe(device)
  const bilinearUpscale = new BilinearUpscale(device, { pipelineCache, colorFormat })
  const fsr1Upscale = new Fsr1Upscale(device, { pipelineCache, colorFormat })
  const depthWriteback = new DepthWriteback(device, { pipelineCache, depthFormat: 'depth24plus' })
  let water = null

  const qt = new Quadtree(R)
  let depthTex = null, dw = 0, dh = 0
  function ensureDepth(w, h) {
    if (depthTex && dw === w && dh === h) return
    if (depthTex) depthTex.destroy()
    dw = w; dh = h
    depthTex = device.createTexture({ label: 'mapspinner-webgpu-planet-depth', size: { width: w, height: h, depthOrArrayLayers: 1 }, format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
  }

  let mainColorTex = null, sceneCopyTex = null, ow = 0, oh = 0
  function ensureOffscreen(w, h) {
    if (mainColorTex && ow === w && oh === h) return
    if (mainColorTex) mainColorTex.destroy()
    if (sceneCopyTex) sceneCopyTex.destroy()
    ow = w; oh = h
    mainColorTex = device.createTexture({
      label: 'mapspinner-webgpu-planet-offscreen-color', size: { width: w, height: h, depthOrArrayLayers: 1 }, format: colorFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    })
    sceneCopyTex = createSceneCopyTexture(device, w, h, colorFormat)
  }

  const cullScratch = { planes: new Float64Array(24), ex: 0, ey: 0, ez: 0, ux: 0, uy: 0, uz: 0, vx: 0, vy: 0, vz: 0, cx: 0, cy: 0, cz: 0, R, maxElev: R * CULL_ELEV_FRAC }
  const quadsPool = []

  function collectQuads(camWorldPos, camTarget, fovy, camUp, aspect, surfElev) {
    const camDist = Math.hypot(camWorldPos[0], camWorldPos[1], camWorldPos[2])
    const fwd = [camTarget[0] - camWorldPos[0], camTarget[1] - camWorldPos[1], camTarget[2] - camWorldPos[2]]
    const { near, far } = nearFarForCam(R, camDist, camDist - R, surfElev)
    const proj = perspectiveZeroToOne(fovy || 0.785, aspect, near, far)
    const viewRel = M4.lookAt([0, 0, 0], fwd, camUp)
    const viewProjNoEye = M4.mul(proj, viewRel)

    const LOD_STEP = 3.6
    let sf = splitFactor * LOD_LEAN
    qt.computeSplitDist(sf * LOD_STEP, dh, fovy || 0.785)
    qt.setConfig(R, maxLevel, sf * LOD_POP_ALTITUDE_MUL)

    extractFrustumPlanes(viewProjNoEye, cullScratch.planes)
    cullScratch.ex = camWorldPos[0]; cullScratch.ey = camWorldPos[1]; cullScratch.ez = camWorldPos[2]

    const quads = quadsPool
    let n = 0
    for (let face = 0; face < 6; face++) {
      const F = FACE_FRAME[face]
      cullScratch.ux = F.u[0]; cullScratch.uy = F.u[1]; cullScratch.uz = F.u[2]
      cullScratch.vx = F.v[0]; cullScratch.vy = F.v[1]; cullScratch.vz = F.v[2]
      cullScratch.cx = F.c[0]; cullScratch.cy = F.c[1]; cullScratch.cz = F.c[2]
      const localCam = worldToFaceLocal(face, camWorldPos, R)
      const leaves = qt.updateQuadtree(localCam[0], localCam[1], localCam[2], localCam[0], localCam[1], undefined, undefined, camDist - R, cullScratch)
      for (let i = 0; i < leaves.length; i++) {
        const q = leaves[i]
        if ((q.level | 0) >= 2 && quadOutsideFrustum(face, q.ox, q.oy, q.l, R, viewProjNoEye, camWorldPos)) continue
        let o = quads[n]
        if (!o) o = quads[n] = { quad: { level: 0, tx: 0, ty: 0, ox: 0, oy: 0, l: 0 }, face: 0 }
        o.quad.level = q.level; o.quad.tx = q.tx; o.quad.ty = q.ty; o.quad.ox = q.ox; o.quad.oy = q.oy; o.quad.l = q.l
        o.face = face
        n++
      }
    }
    quads.length = n
    const camDirX = camWorldPos[0] / camDist, camDirY = camWorldPos[1] / camDist, camDirZ = camWorldPos[2] / camDist
    return { quads, viewProjNoEye, viewRel, camDirX, camDirY, camDirZ, camAlt: camDist - R, near, far }
  }

  function frame(camWorldPos, camTarget, fovy, displayMode, sunDir, time, up, surfElev, shadowInfo) {
    void displayMode; void shadowInfo
    if (!renderer.backend || !renderer.backend.context) return { quadCount: 0, glError: 0, cached: false }
    const w = renderer.domElement.width || 1, h = renderer.domElement.height || 1
    ensureDepth(w, h)
    ensureOffscreen(w, h)
    const aspect = w / Math.max(1, h)
    const camUp = up || [0, 1, 0]
    const { quads, viewProjNoEye, viewRel, camDirX, camDirY, camDirZ, camAlt, near, far } = collectQuads(camWorldPos, camTarget, fovy, camUp, aspect, surfElev)
    if (quads.length === 0) return { quadCount: 0, glError: 0, cached: false }

    patchGrid.updateFrame({ viewProjNoEye, camDir: [camDirX, camDirY, camDirZ], camAlt })
    const sun = sunDir || [0, 0.6, 0.8]
    sky.updateUniforms({
      camRotCols: computeCamRotCols(viewRel),
      projDiag: [(1 / Math.tan((fovy || 0.785) / 2)) / aspect, 1 / Math.tan((fovy || 0.785) / 2)],
      skyCamWorld: [camWorldPos[0] / 1000, camWorldPos[1] / 1000, camWorldPos[2] / 1000],
      skySunDir: sun,
      skyR: R / 1000,
      skyFade: skyFadeFromAlt(camAlt),
    })

    if (!water) {
      water = new WaterRenderer(device, {
        pipelineCache, colorFormat, defRadius: R, oceanAmp: 1.0, oceanChoppy: 0.5,
        sceneTexture: sceneCopyTex, frameUniformBuffer: patchGrid.frameUniformBuffer, width: w, height: h,
      })
    } else if (water.sceneTexture !== sceneCopyTex) {
      water.setSceneTexture(sceneCopyTex)
    }
    water.updateOceanParams({ defRadius: R, oceanTime: time || 0, oceanAmp: 1.0, oceanChoppy: 0.5 })
    water.updateResolution(w, h)

    const vdrsOn = (typeof window !== 'undefined' && window.__vdrs === true)
    const vrs = vdrsOn ? Math.min(1.0, Math.max(0.3, +window.__vdrsScale || 1.0)) : 1.0
    const vw = Math.max(1, Math.round(w * vrs)), vh = Math.max(1, Math.round(h * vrs))

    const encoder = device.createCommandEncoder({ label: 'mapspinner-webgpu-planet-frame' })

    const pass1 = encoder.beginRenderPass({
      colorAttachments: [{ view: mainColorTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      depthStencilAttachment: { view: depthTex.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1.0 },
      occlusionQuerySet: occlusionProbe.querySet,
    })
    pass1.setViewport(0, 0, vw, vh, 0, 1)
    patchGrid.render(pass1, quads)
    sky.render(pass1, true)
    water.renderVisProbe(pass1, quads, occlusionProbe)
    pass1.end()

    const probeIdx = occlusionProbe.resolve(encoder)
    captureSceneCopy(encoder, mainColorTex, sceneCopyTex, w, h)

    const pass2 = encoder.beginRenderPass({
      colorAttachments: [{ view: mainColorTex.createView(), loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depthTex.createView(), depthLoadOp: 'load', depthStoreOp: 'store' },
    })
    pass2.setViewport(0, 0, vw, vh, 0, 1)
    water.render(pass2, quads)
    pass2.end()

    const target = resolveThreeOwnedColorTarget(renderer, colorFormat)
    if (vdrsOn) {
      const useFsr1 = (typeof window !== 'undefined' && window.__vdrsUpscaleFsr1 === true)
      if (useFsr1) {
        const sharpness = (typeof window !== 'undefined' && typeof window.__vdrsUpscaleFsr1Sharpness === 'number') ? window.__vdrsUpscaleFsr1Sharpness : 0.5
        fsr1Upscale.render(encoder, { srcTexture: mainColorTex, srcFullW: w, srcFullH: h, renderScaleX: vrs, renderScaleY: vrs, dstView: target.texture.createView(), dstW: w, dstH: h, sharpness, sampleCount: target.sampleCount, colorFormat: target.colorFormat })
      } else {
        const blitPass = encoder.beginRenderPass({ colorAttachments: [{ view: target.texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
        bilinearUpscale.render(blitPass, { srcTexture: mainColorTex, renderScaleX: vrs, renderScaleY: vrs, sampleCount: target.sampleCount, colorFormat: target.colorFormat })
        blitPass.end()
      }
    } else {
      const blitPass = encoder.beginRenderPass({ colorAttachments: [{ view: target.texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
      bilinearUpscale.render(blitPass, { srcTexture: mainColorTex, renderScaleX: 1.0, renderScaleY: 1.0, sampleCount: target.sampleCount, colorFormat: target.colorFormat })
      blitPass.end()
    }

    const hostNearFar = (typeof window !== 'undefined') ? window.__hostNearFar : null
    if (hostNearFar) {
      const depthTarget = resolveThreeOwnedDepthTarget(renderer)
      if (depthTarget) {
        const depthPass = encoder.beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: { view: depthTarget.texture.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1.0 },
        })
        depthWriteback.render(depthPass, {
          srcDepthTexture: depthTex, uvScaleX: vrs, uvScaleY: vrs, depthEps: 2e-6,
          srcNear: near, srcFar: far, dstNear: hostNearFar.near, dstFar: hostNearFar.far,
          depthFormat: depthTarget.depthFormat, sampleCount: depthTarget.sampleCount,
        })
        depthPass.end()
      }
    }

    device.queue.submit([encoder.finish()])
    if (probeIdx >= 0) occlusionProbe.read(probeIdx)
    return { quadCount: quads.length, glError: 0, face: pickFace(camWorldPos), residentCount: 0, fallbackCount: 0, maxFallbackLevel: -1, frontFallback: 0, cached: false, vdrsOn, vrs }
  }

  function setSculptOverride(center, extent, frameBasis, heights) {
    if (!center || !Number.isFinite(center[0]) || !Number.isFinite(center[1]) || !Number.isFinite(extent) || extent <= 0 || !frameBasis) {
      device.queue.writeBuffer(patchGrid.composeHeightParams.scalarA, 8, new Float32Array([0, 0]))
      return
    }
    device.queue.writeBuffer(patchGrid.composeHeightParams.scalarA, 8, new Float32Array([1, extent]))
    device.queue.writeBuffer(patchGrid.composeHeightParams.scalarB, 0, new Float32Array([center[0], center[1]]))
    device.queue.writeBuffer(patchGrid.composeHeightParams.basis, 0, new Float32Array([
      frameBasis.up[0], frameBasis.up[1], frameBasis.up[2], 0,
      frameBasis.east[0], frameBasis.east[1], frameBasis.east[2], 0,
      frameBasis.north[0], frameBasis.north[1], frameBasis.north[2], 0,
    ]))
    if (heights) {
      sculptTexData.set(heights)
      device.queue.writeBuffer(patchGrid.composeHeightParams.sculptTex, 0, sculptTexData)
    }
  }
  function clearSculptOverride() { setSculptOverride(null) }
  function clearCache() {}

  return { frame, clearCache, setSculptOverride, clearSculptOverride, R, patchGrid, sky, get water() { return water }, mainColorTex: () => mainColorTex, sceneCopyTex: () => sceneCopyTex, occlusionProbe: () => occlusionProbe }
}
