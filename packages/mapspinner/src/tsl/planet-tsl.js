import * as THREE from 'three/webgpu'
import { Quadtree } from '../quadtree.js'
import { FACE_FRAME, worldToFaceLocal, quadOutsideFrustum, extractFrustumPlanes, pickFace, CULL_ELEV_FRAC } from '../planet-orchestrator-cull.js'
import { createAnchorField } from '../anchor-field.js'
import { M4 } from '../gl-render-mat4.js'
import { SHAPE_UNIFORM_DEFAULTS, TERRAIN_DEFAULTS as TD } from '../terrain-defaults.js'
import { buildGridGeometry, perspectiveZeroToOne } from '../patch-grid-geometry.js'
import { canDecodeImages, decodeSurfaceTextureSet } from '../surface-texture-decode.js'
import { resolvePoolParams, resolveWetness } from '../pool-params.js'
import { bakeHpfTexels } from './ops-js.js'
import { assertHashVersion, HASH_VERSION_FLOAT } from './height-spec.js'
import { createHeightProbeTSL } from './height-probe-tsl.js'
import { createSkyTSL } from './sky-tsl.js'
import { bakeAtmosphereLUTs } from '../atmosphere-lut-job.js'
import { runModuleWorkerJob } from '../worker-job.js'
import { createTerrainMaterialTSL, makeHpfTexture, makeSurfaceTextures } from './terrain-material-tsl.js'
import { createWaterTSL } from './water-tsl.js'

const GRID_SIZE = TD.gridMeshSize
const LOD_STEP = 3.6
const LOD_POP_ALTITUDE_MUL = 8.0
const HORIZON_SPHERE_DEPTH_BELOW_SEA = 150.0
const SUBMERGED_FAR_REACH = 60000.0
const INITIAL_QUAD_CAPACITY = 2048
const DEFAULT_FOVY = 0.785
const DEFAULT_SUN_DIR = [0, 0.6, 0.8]
const TERRAIN_DRAWS_AFTER_OPAQUE_OCCLUDERS = 10
const WATER_DRAWS_BEFORE_OTHER_TRANSPARENTS = -1
const SURFACE_DECODE_TIMEOUT_MS = 60000
const QUAD_CACHE_MIN_FORWARD_DOT = 0.99999

function nearFarForCam(R, camDist, alt, surfElev) {
  const altAboveTerrain = Math.max(0.001, alt - R * (surfElev || 0))
  const rHorizon = R - HORIZON_SPHERE_DEPTH_BELOW_SEA
  const horizon = camDist > rHorizon ? Math.sqrt(camDist * camDist - rHorizon * rHorizon) : SUBMERGED_FAR_REACH
  const near = altAboveTerrain < 2.0 ? 0.5 : Math.max(altAboveTerrain * 0.1, 0.5)
  const fBlend = Math.min(1.0, Math.max(0.0, (alt - 500000.0) / 4500000.0))
  const farGround = Math.max(horizon, alt * 8.0)
  return { near, far: farGround * (1.0 - fBlend) + camDist * fBlend }
}

function aimGroundPoint(camWorldPos, fwd, camDist, R) {
  const fl = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1
  const fx = fwd[0] / fl, fy = fwd[1] / fl, fz = fwd[2] / fl
  const b = camWorldPos[0] * fx + camWorldPos[1] * fy + camWorldPos[2] * fz
  const disc = b * b - (camDist * camDist - R * R)
  if (!(disc > 0)) return null
  const t = -b - Math.sqrt(disc)
  return t > 0 ? [camWorldPos[0] + t * fx, camWorldPos[1] + t * fy, camWorldPos[2] + t * fz] : null
}

function makePatchGeometry(capacity) {
  const grid = buildGridGeometry(GRID_SIZE)
  const geo = new THREE.InstancedBufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(grid.vertices, 3))
  geo.setIndex(new THREE.BufferAttribute(grid.indices, 1))
  const offsets = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
  const faces = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
  geo.setAttribute('iOffset', offsets)
  geo.setAttribute('iFace', faces)
  geo.instanceCount = 0
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity)
  return { geo, offsets, faces, capacity }
}

export async function initMapspinnerPlanetTSL(renderer, scene, opts = {}) {
  if (!renderer || !renderer.isWebGPURenderer) throw new Error('mapspinner tsl planet: requires a three WebGPURenderer (WebGPU or WebGL2 backend)')
  const R = opts.radius || 6360000
  if (!Number.isFinite(R) || R <= 0) throw new TypeError(`mapspinner tsl planet: opts.radius must be a positive finite number, got ${opts.radius}`)
  const reliefScale = opts.reliefScale != null ? opts.reliefScale : R / 63600000.0
  const maxLevel = opts.maxLevel ?? 11
  const splitFactor = opts.splitFactor ?? TD.splitFactor
  const hpfRes = opts.hpfTexRes || 128
  const hashVersion = assertHashVersion(opts.hashVersion ?? HASH_VERSION_FLOAT)
  const carves = opts.carves || []
  const hpfSeed = opts.hpfSeed || 1337
  const lutJob = opts.sky === false ? null : bakeAtmosphereLUTs()
  const hpfJob = runModuleWorkerJob(new URL('./hpf-bake-worker.js', import.meta.url), { seed: hpfSeed, res: hpfRes }, (d) => d.data)
  const hpfData = (hpfJob && await hpfJob) || bakeHpfTexels(createAnchorField({ seed: hpfSeed }), hpfRes)
  const hpfTexture = makeHpfTexture(hpfData, hpfRes)
  const { material, uniforms: u, makeHeightSpec, faceU, faceV, faceC } = createTerrainMaterialTSL({
    defRadius: R, reliefScale, hpfRes, hpfTexture, gridSize: GRID_SIZE, hashVersion, carves,
    landBias: opts.landBias != null ? opts.landBias : SHAPE_UNIFORM_DEFAULTS.uLandBias,
    beachShelfM: opts.beachShelfM != null ? opts.beachShelfM : SHAPE_UNIFORM_DEFAULTS.uBeachShelfM,
  })

  let patch = makePatchGeometry(INITIAL_QUAD_CAPACITY)
  const mesh = new THREE.Mesh(patch.geo, material)
  mesh.name = 'mapspinner-terrain-tsl'
  mesh.frustumCulled = false
  mesh.matrixAutoUpdate = false
  mesh.receiveShadow = true
  mesh.castShadow = false
  mesh.renderOrder = TERRAIN_DRAWS_AFTER_OPAQUE_OCCLUDERS
  scene.add(mesh)
  const water = opts.water === false ? null : createWaterTSL({ spec: makeHeightSpec(), terrainUniforms: u, faceU, faceV, faceC })
  if (water) { water.mesh.renderOrder = WATER_DRAWS_BEFORE_OTHER_TRANSPARENTS; scene.add(water.mesh) }
  const sky =lutJob ? createSkyTSL({ radius: R, luts: await lutJob }) : null
  if (sky) scene.backgroundNode = sky.node

  const surfaceState = { ready: false, error: null, disposed: false }
  if (opts.loadSurfaceTextures !== false && canDecodeImages()) {
    const decodeJob = runModuleWorkerJob(new URL('../surface-texture-worker.js', import.meta.url), { baseUrl: opts.surfaceTexturesBaseUrl }, (d) => (d.albAll && d.nrmAll ? d : null), SURFACE_DECODE_TIMEOUT_MS)
    Promise.resolve(decodeJob).then((set) => set || decodeSurfaceTextureSet(opts.surfaceTexturesBaseUrl)).then((set) => {
      if (surfaceState.disposed) return
      const tex = makeSurfaceTextures(set)
      u.surfAlb.value.dispose()
      u.surfNrm.value.dispose()
      u.surfAlb.value = tex.alb
      u.surfNrm.value = tex.nrm
      u.meanL.value.set(set.meanL[0], set.meanL[1], set.meanL[2], set.meanL[3])
      u.surfReady.value = 1
      surfaceState.ready = true
    }).catch((e) => { surfaceState.error = String(e && e.message || e) })
  }

  const qt = new Quadtree(R)
  const cull = { planes: new Float64Array(24), ex: 0, ey: 0, ez: 0, ux: 0, uy: 0, uz: 0, vx: 0, vy: 0, vz: 0, cx: 0, cy: 0, cz: 0, R, maxElev: R * CULL_ELEV_FRAC }

  function writeQuads(camWorldPos, camTarget, fovy, camUp, aspect, viewportH, surfElev) {
    const camDist = Math.hypot(camWorldPos[0], camWorldPos[1], camWorldPos[2])
    const fwd = [camTarget[0] - camWorldPos[0], camTarget[1] - camWorldPos[1], camTarget[2] - camWorldPos[2]]
    const nf = nearFarForCam(R, camDist, camDist - R, surfElev)
    const viewProjNoEye = M4.mul(perspectiveZeroToOne(fovy, aspect, nf.near, nf.far), M4.lookAt([0, 0, 0], fwd, camUp))
    qt.computeSplitDist(splitFactor * LOD_STEP, viewportH, fovy)
    qt.setConfig(R, maxLevel, splitFactor * LOD_POP_ALTITUDE_MUL)
    extractFrustumPlanes(viewProjNoEye, cull.planes)
    cull.ex = camWorldPos[0]; cull.ey = camWorldPos[1]; cull.ez = camWorldPos[2]
    const aim = aimGroundPoint(camWorldPos, fwd, camDist, R)
    let n = 0
    for (let face = 0; face < 6; face++) {
      const F = FACE_FRAME[face]
      cull.ux = F.u[0]; cull.uy = F.u[1]; cull.uz = F.u[2]
      cull.vx = F.v[0]; cull.vy = F.v[1]; cull.vz = F.v[2]
      cull.cx = F.c[0]; cull.cy = F.c[1]; cull.cz = F.c[2]
      const lc = worldToFaceLocal(face, camWorldPos, R)
      const al = aim ? worldToFaceLocal(face, aim, R) : null
      const leaves = qt.updateQuadtree(lc[0], lc[1], lc[2], lc[0], lc[1], al ? al[0] : undefined, al ? al[1] : undefined, camDist - R, cull)
      for (let i = 0; i < leaves.length; i++) {
        const q = leaves[i]
        if ((q.level | 0) >= 2 && quadOutsideFrustum(face, q.ox, q.oy, q.l, R, viewProjNoEye, camWorldPos)) continue
        if (n >= patch.capacity) growCapacity(patch.capacity * 2, n)
        const o = patch.offsets.array
        o[n * 4] = q.ox; o[n * 4 + 1] = q.oy; o[n * 4 + 2] = q.l; o[n * 4 + 3] = q.level
        patch.faces.array[n] = face
        n++
      }
    }
    patch.geo.instanceCount = n
    patch.offsets.clearUpdateRanges(); patch.offsets.addUpdateRange(0, n * 4); patch.offsets.needsUpdate = true
    patch.faces.clearUpdateRanges(); patch.faces.addUpdateRange(0, n); patch.faces.needsUpdate = true
    const waterQuadCount = water ? water.setQuads(patch.offsets.array, patch.faces.array, n) : 0
    return { quadCount: n, waterQuadCount, camDist, near: nf.near, far: nf.far }
  }

  function growCapacity(capacity, keep) {
    const next = makePatchGeometry(capacity)
    next.offsets.array.set(patch.offsets.array.subarray(0, keep * 4))
    next.faces.array.set(patch.faces.array.subarray(0, keep))
    patch.geo.dispose()
    patch = next
    mesh.geometry = patch.geo
  }

  const texTileM = TD.texTile * (R / 6360000.0)
  const texWrapM = texTileM * 8.0
  const wrap = (v) => v - Math.floor(v / texWrapM) * texWrapM

  let lastFar = 0
  const quadCache = { res: null, hit: false, pos: [0, 0, 0], fwd: [0, 0, 0], fovy: 0, w: 0, h: 0 }
  function quadsFor(camWorldPos, camTarget, fy, up, w, h, surfElev) {
    const c = quadCache
    const camDist = Math.hypot(camWorldPos[0], camWorldPos[1], camWorldPos[2])
    const moveTol = Math.min(250.0, Math.max(1.0, (camDist - R) * 0.00005))
    const fl = Math.hypot(camTarget[0] - camWorldPos[0], camTarget[1] - camWorldPos[1], camTarget[2] - camWorldPos[2]) || 1
    const fx = (camTarget[0] - camWorldPos[0]) / fl, fyv = (camTarget[1] - camWorldPos[1]) / fl, fz = (camTarget[2] - camWorldPos[2]) / fl
    const unchanged = c.res && c.fovy === fy && c.w === w && c.h === h
      && Math.hypot(camWorldPos[0] - c.pos[0], camWorldPos[1] - c.pos[1], camWorldPos[2] - c.pos[2]) <= moveTol
      && fx * c.fwd[0] + fyv * c.fwd[1] + fz * c.fwd[2] >= QUAD_CACHE_MIN_FORWARD_DOT
    c.hit = !!unchanged
    if (unchanged) return c.res
    c.res = writeQuads(camWorldPos, camTarget, fy, up, w / Math.max(1, h), h, surfElev)
    c.pos[0] = camWorldPos[0]; c.pos[1] = camWorldPos[1]; c.pos[2] = camWorldPos[2]
    c.fwd[0] = fx; c.fwd[1] = fyv; c.fwd[2] = fz
    c.fovy = fy; c.w = w; c.h = h
    return c.res
  }
  function frame(camWorldPos, camTarget, fovy, displayMode, sunDir, time, up, surfElev, shadowInfo, view) {
    const canvas = renderer.domElement
    const w = canvas.width || 1, h = canvas.height || 1
    const fy = fovy || DEFAULT_FOVY
    const res = quadsFor(camWorldPos, camTarget, fy, up || [0, 1, 0], w, h, surfElev)
    const camDist = Math.hypot(camWorldPos[0], camWorldPos[1], camWorldPos[2])
    const nf = nearFarForCam(R, camDist, camDist - R, surfElev)
    u.camDir.value.set(camWorldPos[0] / camDist, camWorldPos[1] / camDist, camWorldPos[2] / camDist)
    u.camAlt.value = camDist - R
    u.texCamFrac.value.set(wrap(camWorldPos[0]), wrap(camWorldPos[1]), wrap(camWorldPos[2]))
    if (view) {
      u.camRender.value.copy(view.cameraRenderPosition)
      u.east.value.set(view.east[0], view.east[1], view.east[2])
      u.up.value.set(view.up[0], view.up[1], view.up[2])
      u.north.value.set(view.north[0], view.north[1], view.north[2])
      if (sky) sky.update({ camWorldPos, sunDir: sunDir || DEFAULT_SUN_DIR, view })
    }
    const pool = resolvePoolParams()
    u.poolLo.value.set(pool.lo[0], pool.lo[1], pool.lo[2], pool.lo[3])
    u.poolHi.value.set(pool.hi[0], pool.hi[1], pool.hi[2], pool.hi[3])
    u.poolSpec.value.set(pool.spec[0], pool.spec[1], pool.spec[2], pool.spec[3])
    u.poolCover.value = pool.cover
    u.wetness.value = resolveWetness()
    if (water) water.update({ camWorldPos, camDist, R, sunDir: sunDir || DEFAULT_SUN_DIR, time, ocean: typeof window !== 'undefined' ? window.__cam : null })
    lastFar = nf.far
    return { quadCount: res.quadCount, waterQuadCount: res.waterQuadCount, glError: 0, face: pickFace(camWorldPos), cached: quadCache.hit, near: nf.near, far: nf.far, surfaceReady: surfaceState.ready, surfaceError: surfaceState.error }
  }

  function dispose() {
    scene.remove(mesh)
    if (water) { scene.remove(water.mesh); water.dispose() }
    if (sky) { if (scene.backgroundNode === sky.node) scene.backgroundNode = null; sky.dispose() }
    surfaceState.disposed = true
    patch.geo.dispose()
    material.dispose()
    u.surfAlb.value.dispose()
    u.surfNrm.value.dispose()
    hpfTexture.dispose()
  }

  const probeHeights = createHeightProbeTSL(renderer, {
    hpfTexture, hashVersion, carves,
    params: { landBias: u.landBias, beachShelfM: u.beachShelfM, reliefScale: u.reliefScale, hpfRes: u.hpfRes },
  })

  return {
    frame, dispose, R, mesh, material, water, uniforms: u, isTSL: true, hashVersion, probeHeights,
    sceneFar: () => lastFar,
    clearCache() { quadCache.res = null },
    setSculptOverride() {},
    clearSculptOverride() {},
  }
}
