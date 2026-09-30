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
import { createTerrainMaterialTSL, makeHpfTexture, makeSurfaceTextures } from './terrain-material-tsl.js'

const GRID_SIZE = 16
const LOD_LEAN = 0.35
const LOD_STEP = 3.6
const LOD_POP_ALTITUDE_MUL = 8.0
const HORIZON_SPHERE_DEPTH_BELOW_SEA = 150.0
const SUBMERGED_FAR_REACH = 60000.0
const INITIAL_QUAD_CAPACITY = 2048
const DEFAULT_FOVY = 0.785
const DEFAULT_SUN_DIR = [0, 0.6, 0.8]

function nearFarForCam(R, camDist, alt, surfElev) {
  const altAboveTerrain = Math.max(0.001, alt - R * (surfElev || 0))
  const rHorizon = R - HORIZON_SPHERE_DEPTH_BELOW_SEA
  const horizon = camDist > rHorizon ? Math.sqrt(camDist * camDist - rHorizon * rHorizon) : SUBMERGED_FAR_REACH
  const near = altAboveTerrain < 2.0 ? 0.5 : Math.max(altAboveTerrain * 0.1, 0.5)
  const fBlend = Math.min(1.0, Math.max(0.0, (alt - 500000.0) / 4500000.0))
  const farGround = Math.max(horizon, alt * 8.0)
  return { near, far: farGround * (1.0 - fBlend) + camDist * fBlend }
}

function makePatchGeometry(capacity) {
  const grid = buildGridGeometry(GRID_SIZE)
  const geo = new THREE.InstancedBufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(grid.vertices, 3))
  geo.setIndex(new THREE.BufferAttribute(grid.indices, 1))
  const offsets = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
  const faces = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
  offsets.setUsage(THREE.DynamicDrawUsage)
  faces.setUsage(THREE.DynamicDrawUsage)
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
  const splitFactor = opts.splitFactor ?? 0.6
  const hpfRes = opts.hpfTexRes || 128
  const hashVersion = assertHashVersion(opts.hashVersion ?? HASH_VERSION_FLOAT)
  const carves = opts.carves || []

  const hpfData = bakeHpfTexels(createAnchorField({ seed: opts.hpfSeed || 1337 }), hpfRes)
  const hpfTexture = makeHpfTexture(hpfData, hpfRes)
  const { material, uniforms: u } = createTerrainMaterialTSL({
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
  mesh.renderOrder = -10
  scene.add(mesh)
  const sky = opts.sky === false ? null : createSkyTSL({ radius: R })
  if (sky) scene.backgroundNode = sky.node

  const surfaceState = { ready: false, error: null }
  if (opts.loadSurfaceTextures !== false && canDecodeImages()) {
    decodeSurfaceTextureSet(opts.surfaceTexturesBaseUrl).then((set) => {
      const tex = makeSurfaceTextures(set)
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
    const sf = splitFactor * LOD_LEAN
    qt.computeSplitDist(sf * LOD_STEP, viewportH, fovy)
    qt.setConfig(R, maxLevel, sf * LOD_POP_ALTITUDE_MUL)
    extractFrustumPlanes(viewProjNoEye, cull.planes)
    cull.ex = camWorldPos[0]; cull.ey = camWorldPos[1]; cull.ez = camWorldPos[2]
    let n = 0
    for (let face = 0; face < 6; face++) {
      const F = FACE_FRAME[face]
      cull.ux = F.u[0]; cull.uy = F.u[1]; cull.uz = F.u[2]
      cull.vx = F.v[0]; cull.vy = F.v[1]; cull.vz = F.v[2]
      cull.cx = F.c[0]; cull.cy = F.c[1]; cull.cz = F.c[2]
      const lc = worldToFaceLocal(face, camWorldPos, R)
      const leaves = qt.updateQuadtree(lc[0], lc[1], lc[2], lc[0], lc[1], undefined, undefined, camDist - R, cull)
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
    return { quadCount: n, camDist, near: nf.near, far: nf.far }
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
  function frame(camWorldPos, camTarget, fovy, displayMode, sunDir, time, up, surfElev, shadowInfo, view) {
    const canvas = renderer.domElement
    const w = canvas.width || 1, h = canvas.height || 1
    const fy = fovy || DEFAULT_FOVY
    const res = writeQuads(camWorldPos, camTarget, fy, up || [0, 1, 0], w / Math.max(1, h), h, surfElev)
    const camDist = res.camDist
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
    lastFar = res.far
    return { quadCount: res.quadCount, glError: 0, face: pickFace(camWorldPos), cached: false, near: res.near, far: res.far, surfaceReady: surfaceState.ready, surfaceError: surfaceState.error }
  }

  function dispose() {
    scene.remove(mesh)
    if (sky) { if (scene.backgroundNode === sky.node) scene.backgroundNode = null; sky.dispose() }
    patch.geo.dispose()
    material.dispose()
    hpfTexture.dispose()
  }

  const probeHeights = createHeightProbeTSL(renderer, {
    hpfTexture, hashVersion, carves,
    params: { landBias: u.landBias, beachShelfM: u.beachShelfM, reliefScale: u.reliefScale, hpfRes: u.hpfRes },
  })

  return {
    frame, dispose, R, mesh, material, uniforms: u, isTSL: true, hashVersion, probeHeights,
    sceneFar: () => lastFar,
    clearCache() {},
    setSculptOverride() {},
    clearSculptOverride() {},
  }
}
