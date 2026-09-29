import {
  float, vec2, vec3, vec4, int, select, texture, smoothstep, step, mix, clamp, max, abs, pow, dot, sign, length,
} from 'three/tsl'
import { TERRAIN_DEFAULTS as TD } from '../terrain-defaults.js'

const c3 = (a) => vec3(a[0], a[1], a[2])
const BC_SHORE = c3(TD.bcShore), BC_LOWLAND = c3(TD.bcLowland), BC_GRASS = c3(TD.bcGrass)
const BC_ROCK = c3(TD.bcRock), BC_SNOW = c3(TD.bcSnow)
const SLOPE_ROCK = TD.slopeRock
const LUMA = vec3(0.299, 0.587, 0.114)
const TEX_TILE_BASE_M = TD.texTile
const SPLAT_DESIGN_RADIUS_M = 6360000.0
const RIDGE_ALBEDO_OCTAVES = [[75.0, 1.0], [375.0, 0.6]]

const byLayer = (lay, v) => select(lay.lessThan(0.5), v[0], select(lay.lessThan(1.5), v[1], select(lay.lessThan(2.5), v[2], v[3])))

export function terrainAlbedoClimate({ snoise3, h, rockSlope, temp, nwp, pxWorld, reliefScale }) {
  const rockWiden = smoothstep(20.0, 500.0, pxWorld).mul(0.20)
  const depthT = clamp(h.negate().div(300.0), 0.0, 1.0)
  const bed0 = mix(BC_SHORE, vec3(0.12, 0.11, 0.09), smoothstep(0.0, 0.5, depthT))
  const bed = mix(bed0, vec3(0.06, 0.06, 0.07), smoothstep(0.5, 1.0, depthT))
  const seaFloor = mix(bed, BC_ROCK, smoothstep(SLOPE_ROCK[0], SLOPE_ROCK[1], rockSlope))
  const seaIce = float(1.0).sub(smoothstep(0.12, 0.22, temp))
  const seaOut = mix(seaFloor, vec3(0.82, 0.88, 0.94), seaIce.mul(0.9))

  const lo = TD.bandEdgesLo, hi = TD.bandEdgesHi, sn = TD.snowEdges
  const land0 = mix(mix(BC_SHORE, BC_LOWLAND, smoothstep(0.0, lo[0], h)), BC_GRASS, smoothstep(lo[0], lo[1], h))
  const bww = nwp.add(vec3(snoise3(nwp.mul(130.0))).mul(0.004))
  const bandWarp = snoise3(bww.mul(210.0)).add(snoise3(bww.mul(560.0)).mul(0.5)).add(snoise3(bww.mul(1450.0)).mul(0.25)).mul(TD.bandWarp)
  const land1 = mix(land0, BC_ROCK, smoothstep(bandWarp.add(hi[0]), bandWarp.add(hi[1]), h))
  const land2 = mix(land1, BC_SNOW, smoothstep(bandWarp.add(sn[0]), bandWarp.add(sn[1]), h))
  const land3 = mix(land2, BC_ROCK, smoothstep(SLOPE_ROCK[0], rockWiden.add(SLOPE_ROCK[1]), rockSlope).mul(step(0.0, h)))
  const mottled = land3.mul(snoise3(nwp.mul(120.0)).mul(TD.variationAmt).add(1.0))
  const beachM = float(1.0).sub(smoothstep(TD.beachTop * 0.3, TD.beachTop, h)).mul(float(1.0).sub(smoothstep(SLOPE_ROCK[0], SLOPE_ROCK[1], rockSlope)))
  const beached = mix(mottled, BC_SHORE, beachM)
  let ov = float(0.0), oa = 0.0
  RIDGE_ALBEDO_OCTAVES.forEach(([fq, am], o) => {
    const wl = reliefScale.mul(40000000.0 / fq)
    const nyq = float(1.0).sub(smoothstep(wl.mul(0.03), wl.mul(0.12), pxWorld))
    ov = ov.add(nyq.mul(am).mul(snoise3(nwp.mul(fq).add(o * 7.3))))
    oa += am
  })
  const landOut = beached.mul(ov.div(oa).mul(0.02).add(1.0))
  return select(h.lessThan(0.0), seaOut, landOut)
}

function triTap(tex, wt, bw, layer) {
  return texture(tex, vec2(wt.y, wt.z)).depth(layer).mul(bw.x)
    .add(texture(tex, vec2(wt.x, wt.z)).depth(layer).mul(bw.y))
    .add(texture(tex, vec2(wt.x, wt.y)).depth(layer).mul(bw.z))
}

function triNrm(tex, wt, bw, layer, n) {
  const px = texture(tex, vec2(wt.y, wt.z)).depth(layer).rg.mul(2.0).sub(1.0)
  const py = texture(tex, vec2(wt.x, wt.z)).depth(layer).rg.mul(2.0).sub(1.0)
  const pz = texture(tex, vec2(wt.x, wt.y)).depth(layer).rg.mul(2.0).sub(1.0)
  return vec3(0.0, px.x, px.y).mul(bw.x.mul(sign(n.x)))
    .add(vec3(py.x, 0.0, py.y).mul(bw.y.mul(sign(n.y))))
    .add(vec3(pz.x, pz.y, 0.0).mul(bw.z.mul(sign(n.z))))
}

export function surfaceSplat({ snoise3, u, n, dir0, h, slope, rockSlope, humid, temp, biomeC, pxWorld, camDist, worldRel, texWarp }) {
  const R = u.defRadius, rs = u.reliefScale
  const texFarFade = float(1.0).sub(smoothstep(rs.mul(TD.texFar0), rs.mul(TD.texFar1), pxWorld))
  const dryHot = smoothstep(0.60, 0.85, float(1.0).sub(humid)).mul(smoothstep(0.42, 0.62, temp))
  const bandWarp = snoise3(dir0.mul(1100.0)).add(snoise3(dir0.mul(2580.0)).mul(0.5)).mul(TD.bandWarp * 0.25)
  const bwPos = max(bandWarp, 0.0)
  const beach = float(1.0).sub(smoothstep(bwPos, bwPos.add(TD.beachTop * TD.beachWidth), h)).mul(float(1.0).sub(smoothstep(0.18, 0.55, slope)))
  const sandRegion = clamp(max(dryHot, beach), 0.0, 1.0)
  const srLo = Math.max(SLOPE_ROCK[0], 0.05), srHi = Math.max(SLOPE_ROCK[1], srLo + 0.25)
  const wRockSlope = smoothstep(mix(srLo, 0.50, sandRegion), mix(srHi, 0.70, sandRegion), rockSlope)
  const sn = TD.snowEdges
  const snowHi = smoothstep(bandWarp.add(sn[0]), bandWarp.add(sn[1]), h)
  const rockBand = smoothstep(bandWarp.add(sn[0] * 0.7), bandWarp.add(sn[0] * 0.9), h).mul(float(1.0).sub(snowHi))
  const wRock = max(wRockSlope, rockBand)
  const wSnow = clamp(snowHi, 0.0, 1.0).mul(wRock.mul(-0.6).add(1.0))
  const wSand = sandRegion.mul(float(1.0).sub(wRock)).mul(float(1.0).sub(wSnow)).mul(float(1.0).sub(smoothstep(0.30, 0.70, slope)))
  const wGrass = max(float(1.0).sub(wRock).sub(wSnow).sub(wSand), 0.0)
  const uwM = float(1.0).sub(smoothstep(TD.beachTop * 0.3, TD.beachTop, h))
  const wz = wSand.add(wGrass.add(wSnow).mul(uwM))
  const wx = wGrass.mul(float(1.0).sub(uwM)), ww = wSnow.mul(float(1.0).sub(uwM))
  const wSum = wx.add(wRock).add(wz).add(ww).add(1e-4)
  const w4 = vec4(wx, wRock, wz, ww).div(wSum)

  const top2 = [[1.0, w4.y], [2.0, w4.z], [3.0, w4.w]].reduce(([lA, wA, lB, wB], [lay, wl]) => {
    const beatsA = wl.greaterThan(wA), beatsB = wl.greaterThan(wB)
    return [
      select(beatsA, float(lay), lA), select(beatsA, wl, wA),
      select(beatsA, lA, select(beatsB, float(lay), lB)), select(beatsA, wA, select(beatsB, wl, wB)),
    ]
  }, [float(0.0), w4.x, float(0.0), float(-1.0)])
  const [lA, wA, lB, wB] = top2

  const texTileM = R.div(SPLAT_DESIGN_RADIUS_M).mul(TEX_TILE_BASE_M)
  const wt = worldRel.add(u.texCamFrac).div(texTileM).add(texWarp.mul(TD.texWarp))
  const tw0 = pow(abs(n), vec3(TD.triSharp))
  const tw = tw0.div(tw0.x.add(tw0.y).add(tw0.z).add(1e-4))
  const bAB = clamp(wA.div(max(wA.add(wB), 1e-4)), 0.0, 1.0)
  const wt4 = wt.mul(4.0)
  const octFarFade = smoothstep(rs.mul(TD.octFar0), rs.mul(TD.octFar1), pxWorld)
  const texFade = float(1.0).sub(smoothstep(TD.nrmFade0, TD.nrmFade1, camDist))
  const crossFade = float(1.0).sub(smoothstep(TD.xFade0, TD.xFade1, camDist))

  const layerSample = (l) => {
    const li = int(l.add(0.5))
    const albNear = triTap(u.surfAlb, wt4, tw, li)
    const col = mix(albNear.rgb, triTap(u.surfAlb, wt, tw, li).rgb, octFarFade)
    const nrm = triNrm(u.surfNrm, wt4, tw, li, n).add(triNrm(u.surfNrm, wt, tw, li, n).mul(1.7 * TD.nrmLow))
    const matColor = byLayer(l, [BC_GRASS, BC_ROCK, BC_SHORE, BC_SNOW])
    const ord = byLayer(l, [float(0.6), float(0.3), float(0.0), float(1.0)])
    const meanL = byLayer(l, [u.meanL.x, u.meanL.y, u.meanL.z, u.meanL.w])
    const sat = max(mix(vec3(dot(col, LUMA)), col, TD.texSat), vec3(0.0))
    const detail = sat.mul(dot(matColor, LUMA).div(max(meanL, 0.02)))
    const disp = albNear.a
    const pool = float(1.0).sub(smoothstep(byLayer(l, [u.poolLo.x, u.poolLo.y, u.poolLo.z, u.poolLo.w]), byLayer(l, [u.poolHi.x, u.poolHi.y, u.poolHi.z, u.poolHi.w]), disp))
    return { nrm, matColor, ord, detail, disp, pool }
  }
  const A = layerSample(lA), B = layerSample(lB)
  const finger = A.disp.sub(B.disp).mul(TD.xFinger).mul(crossFade)
  const bSharp = smoothstep(-TD.xSoft, TD.xSoft, bAB.sub(0.5).mul(2.0).add(A.ord.sub(B.ord).mul(TD.ordPush)).add(finger))
  const detail = mix(B.detail, A.detail, bSharp)
  const matColor = mix(B.matColor, A.matColor, bSharp)
  const texNrm = mix(B.nrm, A.nrm, bSharp)
  const poolTex = mix(B.pool, A.pool, bSharp)

  const k = texFarFade.mul(TD.texMix).mul(u.surfReady)
  const pool = mix(u.poolCover, poolTex, k)
  const albedo0 = clamp(mix(matColor, detail, k), vec3(0.0), vec3(1.0))
  const tinted = mix(albedo0, biomeC, float(TD.biomeTint).mul(clamp(w4.z, 0.0, 1.0).mul(-0.85).add(1.0)))
  const albedo = mix(biomeC, tinted.mul(TD.texBright), texFarFade)
  const safeNrm = select(dot(texNrm, texNrm).greaterThan(1e-12), texNrm.div(length(texNrm).max(1e-6)), vec3(0.0))
  const texDn = safeNrm.mul(k.mul(TD.texNrmK)).mul(texFade)
  return { albedo: select(u.surfReady.greaterThan(0.5), albedo, biomeC), texDn, pool }
}
