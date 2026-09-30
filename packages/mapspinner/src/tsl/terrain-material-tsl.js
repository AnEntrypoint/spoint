import * as THREE from 'three/webgpu'
import {
  Fn, Loop, If, float, int, vec2, vec3, vec4, uniform, uniformArray, attribute, varyingProperty, texture, select,
  normalize, cross, dot, max, mix, smoothstep, clamp, length, fwidth, sqrt, tan, cameraViewMatrix, property,
} from 'three/tsl'
import { FACE_FRAME } from '../planet-orchestrator-cull.js'
import { TERRAIN_DEFAULTS as TD } from '../terrain-defaults.js'
import { defineHeightSpec } from './height-spec.js'
import { createTslOps } from './ops-tsl.js'
import { terrainAlbedoClimate, surfaceSplat } from './surface-splat-tsl.js'

const FD_TAPS = 5
const QUARTER_PI = 0.7853981634
const DRY_ROUGHNESS = 0.92
const WET_DARKEN = 0.65
const SKIRT_MIN_M = 30.0
const SKIRT_PATCH_FRAC = 0.06
const TEX_WARP_FREQ = 450.0
const TEX_WARP_AMP = 1.2

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2])

function makeLayerTexture(data, size, layers, colorSpace, mipmapped) {
  const t = new THREE.DataArrayTexture(data, size, size, layers)
  t.format = THREE.RGBAFormat
  t.type = THREE.UnsignedByteType
  t.colorSpace = colorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.magFilter = THREE.LinearFilter
  t.minFilter = mipmapped ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter
  t.generateMipmaps = mipmapped
  t.anisotropy = mipmapped ? 8 : 1
  t.needsUpdate = true
  return t
}

export function makeHpfTexture(hpfData, hpfRes) {
  const t = new THREE.DataTexture(hpfData, hpfRes, hpfRes * 6)
  t.format = THREE.RGBAFormat
  t.type = THREE.FloatType
  t.magFilter = t.minFilter = THREE.NearestFilter
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
}

export function makeSurfaceTextures({ albAll, nrmAll, matCount, sz }) {
  return {
    alb: makeLayerTexture(albAll, sz, matCount, THREE.SRGBColorSpace, true),
    nrm: makeLayerTexture(nrmAll, sz, matCount, THREE.NoColorSpace, true),
  }
}

export function createTerrainMaterialTSL({ defRadius, reliefScale, landBias, beachShelfM, hpfRes, hpfTexture, gridSize, hashVersion, carves = [] }) {
  const placeholder = makeSurfaceTextures({ albAll: new Uint8Array(16).fill(128), nrmAll: new Uint8Array([128, 128, 255, 255, 128, 128, 255, 255, 128, 128, 255, 255, 128, 128, 255, 255]), matCount: 4, sz: 1 })
  const u = {
    defRadius: uniform(defRadius),
    reliefScale: uniform(reliefScale),
    landBias: uniform(landBias),
    beachShelfM: uniform(beachShelfM),
    hpfRes: uniform(hpfRes),
    gridInv: uniform(1 / gridSize),
    loopBoundDelta: uniform(0, 'int'),
    fdTaps: uniform(FD_TAPS, 'int'),
    camDir: uniform(new THREE.Vector3(0, 1, 0)),
    camAlt: uniform(0),
    camRender: uniform(new THREE.Vector3()),
    east: uniform(new THREE.Vector3(1, 0, 0)),
    up: uniform(new THREE.Vector3(0, 1, 0)),
    north: uniform(new THREE.Vector3(0, 0, 1)),
    texCamFrac: uniform(new THREE.Vector3()),
    meanL: uniform(new THREE.Vector4(0.2, 0.2, 0.2, 0.5)),
    surfReady: uniform(0),
    poolLo: uniform(new THREE.Vector4(...TD.poolDispLo)),
    poolHi: uniform(new THREE.Vector4(...TD.poolDispHi)),
    poolSpec: uniform(new THREE.Vector4(TD.poolSpecExpRough, TD.poolSpecExpSharp, TD.poolSlope0, TD.poolSlope1)),
    poolCover: uniform(TD.poolCover),
    wetness: uniform(0),
    surfAlb: texture(placeholder.alb),
    surfNrm: texture(placeholder.nrm),
  }
  const faceU = uniformArray(FACE_FRAME.map((f) => v3(f.u)), 'vec3')
  const faceV = uniformArray(FACE_FRAME.map((f) => v3(f.v)), 'vec3')
  const faceC = uniformArray(FACE_FRAME.map((f) => v3(f.c)), 'vec3')

  const makeHeightSpec = () => defineHeightSpec(createTslOps({
    params: { landBias: u.landBias, beachShelfM: u.beachShelfM, reliefScale: u.reliefScale, hpfRes: u.hpfRes },
    hpfTexture, loopBoundDelta: u.loopBoundDelta, carves,
  }), { hashVersion, carveCount: carves.length })
  const spec = makeHeightSpec()

  const vH = varyingProperty('float', 'vTerrH')
  const vN = varyingProperty('vec3', 'vTerrN')
  const vDir = varyingProperty('vec3', 'vTerrDir')
  const vRelP = varyingProperty('vec3', 'vTerrRel')
  const vClim = varyingProperty('vec2', 'vTerrClim')
  const vWarp = varyingProperty('vec3', 'vTerrWarp')

  const toLocal = (p) => vec3(dot(p, u.east), dot(p, u.up), dot(p, u.north))

  const positionNode = Fn(() => {
    const grid = attribute('position', 'vec3')
    const off = attribute('iOffset', 'vec4')
    const face = int(attribute('iFace', 'float').add(0.5))
    const fu = faceU.element(face), fv = faceV.element(face), fc = faceC.element(face)
    const R = u.defRadius
    const absLocal = off.xy.add(grid.xy.mul(off.z)).toVar()
    const step = off.z.mul(u.gridInv)
    const h0 = float(0).toVar(), d0 = vec3(0).toVar()
    const wPU = vec3(0).toVar(), wMU = vec3(0).toVar(), wPV = vec3(0).toVar(), wMV = vec3(0).toVar()
    Loop({ start: int(0), end: u.fdTaps.add(u.loopBoundDelta), type: 'int', condition: '<' }, ({ i }) => {
      const ox = select(i.equal(1), float(1), select(i.equal(2), float(-1), float(0)))
      const oy = select(i.equal(3), float(1), select(i.equal(4), float(-1), float(0)))
      const fl = tan(absLocal.add(vec2(ox, oy).mul(step)).div(R).mul(QUARTER_PI)).mul(R)
      const d = normalize(fu.mul(fl.x).add(fv.mul(fl.y)).add(fc.mul(R))).toVar()
      const hh = spec.composeHeight(d).toVar()
      const w = d.mul(R.add(hh))
      If(i.equal(0), () => { h0.assign(hh); d0.assign(d) })
      If(i.equal(1), () => { wPU.assign(w) })
      If(i.equal(2), () => { wMU.assign(w) })
      If(i.equal(3), () => { wPV.assign(w) })
      If(i.equal(4), () => { wMV.assign(w) })
    })
    const n0 = normalize(cross(wPU.sub(wMU), wPV.sub(wMV)))
    const n = select(dot(n0, d0).lessThan(0.0), n0.negate(), n0)
    const reliefOr1 = select(u.reliefScale.greaterThan(0.0), u.reliefScale, float(1.0))
    const skirt = select(grid.z.greaterThan(0.5), max(off.z.mul(SKIRT_PATCH_FRAC), reliefOr1.mul(SKIRT_MIN_M)), float(0.0))
    const vRel = d0.sub(u.camDir).mul(R).add(d0.mul(h0.sub(skirt))).sub(u.camDir.mul(u.camAlt)).toVar()
    const warpBase = d0.mul(TEX_WARP_FREQ)
    vH.assign(h0)
    vN.assign(n)
    vDir.assign(d0)
    vRelP.assign(vRel)
    vClim.assign(spec.hpfSample(d0).zw)
    vWarp.assign(vec3(spec.snoise3(warpBase), spec.snoise3(warpBase.add(7.3)), spec.snoise3(warpBase.add(23.9))).mul(TEX_WARP_AMP))
    return u.camRender.add(toLocal(vRel))
  })()

  const n = normalize(vN)
  const dir0 = normalize(vDir)
  const slope = float(1.0).sub(max(0.0, dot(n, dir0)))
  const rockSlope = clamp(slope, 0.0, 1.0)
  const pxWorld = max(length(fwidth(vRelP)), 0.001)
  const wet = select(vH.greaterThan(0.0), u.wetness, float(0.0))
  const texDnP = property('vec3', 'terrTexDn')
  const poolP = property('float', 'terrPool')
  const colorNode = Fn(() => {
    const biomeC = terrainAlbedoClimate({ snoise3: spec.snoise3, h: vH, rockSlope, temp: vClim.x, nwp: dir0, pxWorld, reliefScale: u.reliefScale })
    const splat = surfaceSplat({ snoise3: spec.snoise3, u, n, dir0, h: vH, slope, rockSlope, humid: vClim.y, temp: vClim.x, biomeC, pxWorld, camDist: length(vRelP), worldRel: vRelP, texWarp: vWarp })
    texDnP.assign(splat.texDn)
    poolP.assign(splat.pool.mul(float(1.0).sub(smoothstep(u.poolSpec.z, u.poolSpec.w, slope))).mul(wet))
    return vec4(splat.albedo.mul(mix(1.0, WET_DARKEN, wet)), 1.0)
  })()
  const poolRoughness = sqrt(sqrt(float(2.0).div(mix(u.poolSpec.x, u.poolSpec.y, poolP).add(2.0))))
  const nLit = normalize(n.add(texDnP))

  const material = new THREE.MeshStandardNodeMaterial()
  material.name = 'mapspinner-terrain-tsl'
  material.positionNode = positionNode
  material.colorNode = colorNode
  material.roughnessNode = mix(DRY_ROUGHNESS, poolRoughness, poolP)
  material.normalNode = normalize(cameraViewMatrix.mul(vec4(toLocal(nLit), 0.0)).xyz)
  material.metalness = 0.0
  material.side = THREE.DoubleSide
  return { material, uniforms: u, spec, makeHeightSpec, faceU, faceV, faceC }
}
