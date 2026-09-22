import { TERRAIN_COMPOSEHEIGHT_WGSL } from './terrain-composeheight-wgsl.js'
import { MapspinnerPipelineCache, TERRAIN_PATCH_VERTEX_BUFFERS } from './pipeline-cache.js'
import { M4 } from '../gl-render-mat4.js'
import { THC_BAKE_RES, createHeightBakePipeline, bakeHeightTileTexture } from './height-bake-compute.js'
import { ATMOSPHERE_CORE_WGSL, atmosphereLutBindingsWgsl, ATMOSPHERE_LUT_FUNCS_WGSL } from './sky-render.js'
import { canDecodeImages, decodeSurfaceTextureSet } from '../surface-texture-decode.js'

const COMPOSEHEIGHT_MARKER = '@group(0) @binding(0)'
const COMPOSEHEIGHT_FUNCTIONS_WGSL = TERRAIN_COMPOSEHEIGHT_WGSL.slice(0, TERRAIN_COMPOSEHEIGHT_WGSL.indexOf(COMPOSEHEIGHT_MARKER))

const TERRAIN_ALBEDO_WGSL = `
const BC_SHORE: vec3<f32> = vec3<f32>(0.82, 0.76, 0.52);
const BC_LOWLAND: vec3<f32> = vec3<f32>(0.18, 0.38, 0.10);
const BC_GRASS: vec3<f32> = vec3<f32>(0.30, 0.46, 0.12);
const BC_ROCK: vec3<f32> = vec3<f32>(0.48, 0.40, 0.30);
const BC_SNOW: vec3<f32> = vec3<f32>(0.94, 0.96, 1.00);
const BAND_EDGES_LO: vec2<f32> = vec2<f32>(8.0, 20.0);
const BAND_EDGES_HI: vec2<f32> = vec2<f32>(60.0, 100.0);
const SNOW_EDGES: vec2<f32> = vec2<f32>(120.0, 180.0);
const SLOPE_ROCK: vec2<f32> = vec2<f32>(0.25, 0.55);
const U_BAND_WARP: f32 = 20.0;
const U_BEACH_TOP_M: f32 = 15.0;
const U_VARIATION_AMT: f32 = 0.05;
const U_SKY_FILL: f32 = 0.3;
const U_HAZE_MUL: f32 = 0.4;
const U_TERMINATOR_GLOW: f32 = 0.6;
const U_NIGHT_FLOOR: f32 = 0.18;
const U_TERM_WIDTH: f32 = 0.45;
const U_NIGHT_LIGHTS: f32 = 0.8;
const U_EXPOSURE: f32 = 1.05;
const U_LOOK_SAT: f32 = 1.25;
const U_LOOK_CONTRAST: f32 = 1.0;

fn terrainAlbedo(h: f32, slope: f32, rockSlope: f32, nwp: vec3<f32>, pxW: f32) -> vec3<f32> {
  let rockWiden = smoothstep(20.0, 500.0, pxW) * 0.20;
  var c: vec3<f32>;
  if (h < 0.0) {
    let depthT = clamp(-h / 300.0, 0.0, 1.0);
    let bcSilt = vec3<f32>(0.12, 0.11, 0.09);
    let bcBasalt = vec3<f32>(0.06, 0.06, 0.07);
    var bedBase = mix(BC_SHORE, bcSilt, smoothstep(0.0, 0.5, depthT));
    bedBase = mix(bedBase, bcBasalt, smoothstep(0.5, 1.0, depthT));
    c = mix(bedBase, BC_ROCK, smoothstep(SLOPE_ROCK.x, SLOPE_ROCK.y, rockSlope));
  } else {
    c = mix(BC_SHORE, BC_LOWLAND, smoothstep(0.0, BAND_EDGES_LO.x, h));
    c = mix(c, BC_GRASS, smoothstep(BAND_EDGES_LO.x, BAND_EDGES_LO.y, h));
    let bww = nwp + vec3<f32>(snoise3(nwp * 130.0)) * 0.004;
    let bandWarp = (snoise3(bww * 210.0) * 1.0 + snoise3(bww * 560.0) * 0.5 + snoise3(bww * 1450.0) * 0.25) * U_BAND_WARP;
    c = mix(c, BC_ROCK, smoothstep(BAND_EDGES_HI.x + bandWarp, BAND_EDGES_HI.y + bandWarp, h));
    c = mix(c, BC_SNOW, smoothstep(SNOW_EDGES.x + bandWarp, SNOW_EDGES.y + bandWarp, h));
    c = mix(c, BC_ROCK, smoothstep(SLOPE_ROCK.x, SLOPE_ROCK.y + rockWiden, rockSlope) * step(0.0, h));
  }
  return c;
}

fn terrainAlbedoClimate(h: f32, slope: f32, rockSlope: f32, temp: f32, humid: f32, nwp: vec3<f32>, pxWorld: f32, reliefScale: f32) -> vec3<f32> {
  var c = terrainAlbedo(h, slope, rockSlope, nwp, pxWorld);
  if (h < 0.0) {
    let seaIce = 1.0 - smoothstep(0.12, 0.22, temp);
    return mix(c, vec3<f32>(0.82, 0.88, 0.94), seaIce * 0.9);
  }
  let mot = snoise3(nwp * 120.0);
  c = c * (1.0 + U_VARIATION_AMT * mot);
  let beachM = (1.0 - smoothstep(U_BEACH_TOP_M * 0.3, U_BEACH_TOP_M, h)) * (1.0 - smoothstep(SLOPE_ROCK.x, SLOPE_ROCK.y, rockSlope));
  c = mix(c, BC_SHORE, beachM);
  var ov = 0.0;
  var oa = 0.0;
  var fq = 75.0;
  var am = 1.0;
  for (var o = 0; o < 2; o = o + 1) {
    let wl = 40000000.0 * reliefScale / fq;
    let nyq = 1.0 - smoothstep(wl * 0.03, wl * 0.12, pxWorld);
    ov = ov + am * nyq * snoise3(nwp * fq + vec3<f32>(f32(o) * 7.3));
    oa = oa + am;
    fq = fq * 5.0;
    am = am * 0.6;
  }
  c = c * (1.0 + 0.02 * (ov / max(oa, 1e-3)));
  return c;
}
`

const SURFACE_SPLAT_WGSL = `
const TEX_TILE_BASE_M: f32 = 2400.0;
const SPLAT_DESIGN_RADIUS_M: f32 = 6360000.0;
const U_TEX_NRM_K: f32 = 0.4;
const U_TEX_MIX: f32 = 1.0;
const U_TEX_WARP: f32 = 1.0;
const U_X_SOFT: f32 = 0.26;
const U_X_FINGER: f32 = 0.2;
const U_ORD_PUSH: f32 = 0.0;
const U_TRI_SHARP: f32 = 3.0;
const U_NRM_FADE0: f32 = 100.0;
const U_NRM_FADE1: f32 = 1000.0;
const U_X_FADE0: f32 = 100.0;
const U_X_FADE1: f32 = 340.0;
const U_TEX_FAR0: f32 = 0.0;
const U_TEX_FAR1: f32 = 10000.0;
const U_OCT_FAR0: f32 = 1.5;
const U_OCT_FAR1: f32 = 15.0;
const U_BIOME_TINT: f32 = 0.62;
const U_TEX_BRIGHT: f32 = 1.12;
const U_TEX_SAT: f32 = 1.2;
const U_NRM_LOW: f32 = 0.4;
const U_BEACH_WIDTH: f32 = 1.0;
const TEX_LUMA: vec3<f32> = vec3<f32>(0.299, 0.587, 0.114);

struct SplatResult {
  albedo: vec3<f32>,
  texDn: vec3<f32>,
}

fn texCamFracOf(camAbs: vec3<f32>, texTileM: f32) -> vec3<f32> {
  let wrapM = texTileM * 8.0;
  return camAbs - floor(camAbs / wrapM) * wrapM;
}

fn matColorForLayer(lay: f32) -> vec3<f32> {
  if (lay < 0.5) { return BC_GRASS; }
  if (lay < 1.5) { return BC_ROCK; }
  if (lay < 2.5) { return BC_SHORE; }
  return BC_SNOW;
}

fn ordForLayer(lay: f32) -> f32 {
  if (lay < 0.5) { return 0.6; }
  if (lay < 1.5) { return 0.3; }
  if (lay < 2.5) { return 0.0; }
  return 1.0;
}

fn meanLFor(lay: f32) -> f32 {
  if (lay < 0.5) { return surfParams.meanL.x; }
  if (lay < 1.5) { return surfParams.meanL.y; }
  if (lay < 2.5) { return surfParams.meanL.z; }
  return surfParams.meanL.w;
}

fn surfTriTap(wt: vec3<f32>, bw: vec3<f32>, layer: i32) -> vec4<f32> {
  return textureSample(uSurfAlb, surfSampler, vec2<f32>(wt.y, wt.z), layer) * bw.x
       + textureSample(uSurfAlb, surfSampler, vec2<f32>(wt.x, wt.z), layer) * bw.y
       + textureSample(uSurfAlb, surfSampler, vec2<f32>(wt.x, wt.y), layer) * bw.z;
}

fn surfTriNrm(wt: vec3<f32>, bw: vec3<f32>, layer: i32, sn: vec3<f32>) -> vec3<f32> {
  let px = textureSample(uSurfNrm, surfSampler, vec2<f32>(wt.y, wt.z), layer).rg * 2.0 - 1.0;
  let py = textureSample(uSurfNrm, surfSampler, vec2<f32>(wt.x, wt.z), layer).rg * 2.0 - 1.0;
  let pz = textureSample(uSurfNrm, surfSampler, vec2<f32>(wt.x, wt.y), layer).rg * 2.0 - 1.0;
  return vec3<f32>(0.0, px.x, px.y) * (bw.x * sign(sn.x))
       + vec3<f32>(py.x, 0.0, py.y) * (bw.y * sign(sn.y))
       + vec3<f32>(pz.x, pz.y, 0.0) * (bw.z * sign(sn.z));
}

fn surfaceSplat(n: vec3<f32>, dir0: vec3<f32>, h: f32, slope: f32, rockSlope: f32, climate: vec2<f32>, biomeC: vec3<f32>, pxWorld: f32, camDist: f32, worldRel: vec3<f32>, texWarp: vec3<f32>, camWorldAbs: vec3<f32>, defRadius: f32, reliefScale: f32) -> SplatResult {
  var result: SplatResult;
  let texFarFade = 1.0 - smoothstep(U_TEX_FAR0 * reliefScale, U_TEX_FAR1 * reliefScale, pxWorld);
  if (surfParams.flags.x < 0.5) {
    result.albedo = biomeC;
    result.texDn = vec3<f32>(0.0);
    return result;
  }
  let temp = climate.x;
  let humid = climate.y;
  let dryHot = smoothstep(0.60, 0.85, 1.0 - humid) * smoothstep(0.42, 0.62, temp);
  let bandWarpN = snoise3(dir0 * 1100.0) + 0.5 * snoise3(dir0 * 2580.0);
  let bandWarp = bandWarpN * U_BAND_WARP * 0.25;
  let beach = (1.0 - smoothstep(max(0.0, bandWarp), U_BEACH_TOP_M * U_BEACH_WIDTH + max(0.0, bandWarp), h))
            * (1.0 - smoothstep(0.18, 0.55, slope));
  let sandRegion = clamp(max(dryHot, beach), 0.0, 1.0);
  let srLo = max(SLOPE_ROCK.x, 0.05);
  let srHi = max(SLOPE_ROCK.y, srLo + 0.25);
  let wRockSlope = smoothstep(mix(srLo, 0.50, sandRegion), mix(srHi, 0.70, sandRegion), rockSlope);
  let snowHi = smoothstep(SNOW_EDGES.x + bandWarp, SNOW_EDGES.y + bandWarp, h);
  let rockBand = smoothstep(SNOW_EDGES.x * 0.7 + bandWarp, SNOW_EDGES.x * 0.9 + bandWarp, h) * (1.0 - snowHi);
  let wRock = max(wRockSlope, rockBand);
  let wSnow = clamp(snowHi, 0.0, 1.0) * (1.0 - 0.6 * wRock);
  let wSand = sandRegion * (1.0 - wRock) * (1.0 - wSnow) * (1.0 - smoothstep(0.30, 0.70, slope));
  let wGrass = max(1.0 - wRock - wSnow - wSand, 0.0);
  var w4 = vec4<f32>(wGrass, wRock, wSand, wSnow);
  let uwM = 1.0 - smoothstep(U_BEACH_TOP_M * 0.3, U_BEACH_TOP_M, h);
  w4.z = w4.z + (w4.x + w4.w) * uwM;
  w4.x = w4.x * (1.0 - uwM);
  w4.w = w4.w * (1.0 - uwM);
  w4 = w4 / (w4.x + w4.y + w4.z + w4.w + 1e-4);

  var lA = 0.0; var wA = w4.x;
  var lB = 0.0; var wB = -1.0;
  if (w4.y > wA) { lB = lA; wB = wA; lA = 1.0; wA = w4.y; } else if (w4.y > wB) { lB = 1.0; wB = w4.y; }
  if (w4.z > wA) { lB = lA; wB = wA; lA = 2.0; wA = w4.z; } else if (w4.z > wB) { lB = 2.0; wB = w4.z; }
  if (w4.w > wA) { lB = lA; wB = wA; lA = 3.0; wA = w4.w; } else if (w4.w > wB) { lB = 3.0; wB = w4.w; }

  let texTileM = TEX_TILE_BASE_M * (defRadius / SPLAT_DESIGN_RADIUS_M);
  var wt = (worldRel + texCamFracOf(camWorldAbs, texTileM)) / texTileM;
  wt = wt + texWarp * U_TEX_WARP;
  var tw = pow(abs(n), vec3<f32>(U_TRI_SHARP));
  tw = tw / (tw.x + tw.y + tw.z + 1e-4);
  let bAB = clamp(wA / max(wA + wB, 1e-4), 0.0, 1.0);
  let wt4 = wt * 4.0;
  let octFarFade = smoothstep(U_OCT_FAR0 * reliefScale, U_OCT_FAR1 * reliefScale, pxWorld);
  let texFade = 1.0 - smoothstep(U_NRM_FADE0, U_NRM_FADE1, camDist);

  let layerA = i32(lA + 0.5);
  let albA = surfTriTap(wt4, tw, layerA);
  let cA = mix(albA.rgb, surfTriTap(wt, tw, layerA).rgb, octFarFade);
  let nA = surfTriNrm(wt4, tw, layerA, n) + surfTriNrm(wt, tw, layerA, n) * (1.7 * U_NRM_LOW);
  let dispA = albA.a;
  let mcA = matColorForLayer(lA);
  var texMatColor = mcA;
  var texNrm = nA;
  let mA = meanLFor(lA);
  let satA = max(mix(vec3<f32>(dot(cA, TEX_LUMA)), cA, U_TEX_SAT), vec3<f32>(0.0));
  let detailA = satA * (dot(mcA, TEX_LUMA) / max(mA, 0.02));
  var detail = detailA;
  var bSharp = 1.0;
  let crossFade = 1.0 - smoothstep(U_X_FADE0, U_X_FADE1, camDist);
  let ordA = ordForLayer(lA);

  let layerB = i32(lB + 0.5);
  let albB = surfTriTap(wt4, tw, layerB);
  let cB = mix(albB.rgb, surfTriTap(wt, tw, layerB).rgb, octFarFade);
  let nB = surfTriNrm(wt4, tw, layerB, n) + surfTriNrm(wt, tw, layerB, n) * (1.7 * U_NRM_LOW);
  let dispB = albB.a;
  let ordB = ordForLayer(lB);
  let mcB = matColorForLayer(lB);
  let finger = (dispA - dispB) * U_X_FINGER * crossFade;
  let s = (bAB - 0.5) * 2.0 + (ordA - ordB) * U_ORD_PUSH + finger;
  bSharp = smoothstep(-U_X_SOFT, U_X_SOFT, s);
  let mB = meanLFor(lB);
  let satB = max(mix(vec3<f32>(dot(cB, TEX_LUMA)), cB, U_TEX_SAT), vec3<f32>(0.0));
  let detailB = satB * (dot(mcB, TEX_LUMA) / max(mB, 0.02));
  detail = mix(detailB, detailA, bSharp);
  texMatColor = mix(mcB, mcA, bSharp);
  texNrm = mix(nB, nA, bSharp);

  let k = U_TEX_MIX * texFarFade;
  var albedoOut = clamp(mix(texMatColor, detail, k), vec3<f32>(0.0), vec3<f32>(1.0));
  let biomeTintHere = U_BIOME_TINT * (1.0 - 0.85 * clamp(w4.z, 0.0, 1.0));
  albedoOut = mix(albedoOut, biomeC, biomeTintHere);
  albedoOut = albedoOut * U_TEX_BRIGHT;
  albedoOut = mix(biomeC, albedoOut, texFarFade);
  result.albedo = albedoOut;
  let texNrmLenSq = dot(texNrm, texNrm);
  let safeTexNrm = select(vec3<f32>(0.0), normalize(texNrm), texNrmLenSq > 1e-12);
  result.texDn = safeTexNrm * (U_TEX_NRM_K * k) * texFade;
  return result;
}
`

function buildRenderWgsl(gridSize) {
  const duP = 1.0 / gridSize
  return COMPOSEHEIGHT_FUNCTIONS_WGSL + ATMOSPHERE_CORE_WGSL + atmosphereLutBindingsWgsl(2, 0) + ATMOSPHERE_LUT_FUNCS_WGSL + TERRAIN_ALBEDO_WGSL + `
@group(0) @binding(0) var<uniform> paramsU: vec4<u32>;
@group(0) @binding(1) var<uniform> scalarA: vec4<f32>;
@group(0) @binding(2) var<uniform> scalarB: vec4<f32>;
@group(0) @binding(3) var<uniform> basis: array<vec4<f32>, 3>;
@group(0) @binding(4) var surfSampler: sampler;
@group(0) @binding(5) var uSurfAlb: texture_2d_array<f32>;
@group(0) @binding(6) var<storage, read> hpfPool: array<f32>;
@group(0) @binding(7) var<storage, read> sculptTex: array<f32>;
@group(0) @binding(8) var uSurfNrm: texture_2d_array<f32>;
struct SurfParams {
  meanL: vec4<f32>,
  flags: vec4<f32>,
}
@group(0) @binding(9) var<uniform> surfParams: SurfParams;
` + SURFACE_SPLAT_WGSL + `

struct FrameUniforms {
  viewProjNoEye: mat4x4<f32>,
  camDir: vec3<f32>,
  camAlt: f32,
  sunDir: vec3<f32>,
}
@group(1) @binding(0) var<uniform> frame: FrameUniforms;

fn faceFrame(f: f32) -> mat3x3<f32> {
  let i = i32(f + 0.5);
  if (i == 0) { return mat3x3<f32>(0.0,0.0,-1.0,  0.0,1.0,0.0,   1.0,0.0,0.0); }
  if (i == 1) { return mat3x3<f32>(0.0,0.0,1.0,   0.0,1.0,0.0,  -1.0,0.0,0.0); }
  if (i == 2) { return mat3x3<f32>(1.0,0.0,0.0,   0.0,0.0,-1.0,  0.0,1.0,0.0); }
  if (i == 3) { return mat3x3<f32>(1.0,0.0,0.0,   0.0,0.0,1.0,   0.0,-1.0,0.0); }
  if (i == 4) { return mat3x3<f32>(1.0,0.0,0.0,   0.0,1.0,0.0,   0.0,0.0,1.0); }
  return mat3x3<f32>(-1.0,0.0,0.0,  0.0,1.0,0.0,   0.0,0.0,-1.0);
}

fn patchFaceWarp(p: vec2<f32>, defRadius: f32) -> vec2<f32> {
  return defRadius * tan((p / defRadius) * 0.7853981634);
}

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldRel: vec3<f32>,
  @location(1) height: f32,
  @location(2) nrm: vec3<f32>,
  @location(3) dir0: vec3<f32>,
  @location(4) climate: vec2<f32>,
  @location(5) texWarp: vec3<f32>,
}

@vertex
fn vs_main(
  @location(0) vertex: vec3<f32>,
  @location(1) iOffset: vec4<f32>,
  @location(2) iFace: f32,
  @location(3) iLayer: f32,
) -> VSOut {
  let defRadius = scalarB.z;
  let localToWorld = faceFrame(iFace);
  let absLocal = iOffset.xy + vertex.xy * iOffset.z;
  let faceLocal = patchFaceWarp(absLocal, defRadius);
  let dir0 = normalize(localToWorld * vec3<f32>(faceLocal, defRadius));
  let hpfRes = i32(paramsU.y);
  let sculptRes = i32(paramsU.z);
  let landBias = scalarA.x;
  let beachShelfM = scalarA.y;
  let sculptActive = scalarA.z;
  let sculptExtent = scalarA.w;
  let sculptCenter = vec2<f32>(scalarB.x, scalarB.y);
  let up = basis[0].xyz;
  let east = basis[1].xyz;
  let north = basis[2].xyz;
  let reliefScale = bitcast<f32>(paramsU.w);
  let h = composeHeight(dir0, landBias, beachShelfM, hpfRes, sculptActive, up, east, north, sculptCenter, sculptExtent, defRadius, sculptRes, reliefScale);

  let duP = ${duP};
  let offU = iOffset.z * duP;
  let flPU = patchFaceWarp(absLocal + vec2<f32>(offU, 0.0), defRadius);
  let dPU = normalize(localToWorld * vec3<f32>(flPU, defRadius));
  let hPU = composeHeight(dPU, landBias, beachShelfM, hpfRes, sculptActive, up, east, north, sculptCenter, sculptExtent, defRadius, sculptRes, reliefScale);
  let flMU = patchFaceWarp(absLocal + vec2<f32>(-offU, 0.0), defRadius);
  let dMU = normalize(localToWorld * vec3<f32>(flMU, defRadius));
  let hMU = composeHeight(dMU, landBias, beachShelfM, hpfRes, sculptActive, up, east, north, sculptCenter, sculptExtent, defRadius, sculptRes, reliefScale);
  let flPV = patchFaceWarp(absLocal + vec2<f32>(0.0, offU), defRadius);
  let dPV = normalize(localToWorld * vec3<f32>(flPV, defRadius));
  let hPV = composeHeight(dPV, landBias, beachShelfM, hpfRes, sculptActive, up, east, north, sculptCenter, sculptExtent, defRadius, sculptRes, reliefScale);
  let flMV = patchFaceWarp(absLocal + vec2<f32>(0.0, -offU), defRadius);
  let dMV = normalize(localToWorld * vec3<f32>(flMV, defRadius));
  let hMV = composeHeight(dMV, landBias, beachShelfM, hpfRes, sculptActive, up, east, north, sculptCenter, sculptExtent, defRadius, sculptRes, reliefScale);

  let wPU = dPU * (defRadius + hPU);
  let wMU = dMU * (defRadius + hMU);
  let wPV = dPV * (defRadius + hPV);
  let wMV = dMV * (defRadius + hMV);
  var nrm = normalize(cross(wPU - wMU, wPV - wMV));
  if (dot(nrm, dir0) < 0.0) { nrm = -nrm; }

  let skirt = select(0.0, max(iOffset.z * 0.06, 30.0 * select(1.0, reliefScale, reliefScale > 0.0)), vertex.z > 0.5);
  let vRel = (dir0 - frame.camDir) * defRadius + dir0 * (h - skirt) - frame.camDir * frame.camAlt;

  let climate = hpfClimateSample(dir0, hpfRes);

  let texWarpBase = dir0 * 450.0;
  let texWarp = vec3<f32>(snoise3(texWarpBase), snoise3(texWarpBase + vec3<f32>(7.3)), snoise3(texWarpBase + vec3<f32>(23.9))) * 1.2;

  var out: VSOut;
  out.pos = frame.viewProjNoEye * vec4<f32>(vRel, 1.0);
  out.worldRel = vRel;
  out.height = h;
  out.nrm = nrm;
  out.dir0 = dir0;
  out.climate = climate;
  out.texWarp = texWarp;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let defRadius = scalarB.z;
  let n = normalize(in.nrm);
  let dir0 = in.dir0;
  let camWorldAbs = frame.camDir * (defRadius + frame.camAlt);
  let vWorldAbs = in.worldRel + camWorldAbs;

  let slope = 1.0 - max(0.0, dot(n, dir0));
  let rockSlope = clamp(slope, 0.0, 1.0);
  let pxWorld = max(length(fwidth(in.worldRel)), 0.001);
  let reliefScale = bitcast<f32>(paramsU.w);
  var albedo = terrainAlbedoClimate(in.height, slope, rockSlope, in.climate.x, in.climate.y, dir0, pxWorld, reliefScale);

  let camDist = length(vWorldAbs - camWorldAbs);
  let splat = surfaceSplat(n, dir0, in.height, slope, rockSlope, in.climate, albedo, pxWorld, camDist, in.worldRel, in.texWarp, camWorldAbs, defRadius, reliefScale);
  albedo = splat.albedo;
  let nLit = normalize(n + splat.texDn);

  let pAtm = atmPos(vWorldAbs, defRadius);
  let camAtm = atmPos(camWorldAbs, defRadius);
  var skyIrr: vec3<f32>;
  let sunIrr = atm_sunSkyIrradiance(pAtm, nLit, frame.sunDir, &skyIrr);
  let skyL = dot(skyIrr, vec3<f32>(0.2126, 0.7152, 0.0722));
  let skyIrrBalanced = mix(vec3<f32>(skyL), skyIrr, 0.35) * U_SKY_FILL * vec3<f32>(0.85, 0.92, 1.10);
  let ambientFloor = albedo * 0.14 + vec3<f32>(0.020, 0.026, 0.038);
  let lit = albedo * (sunIrr * 1.25 + skyIrrBalanced) * (1.0 / ATM_PI) + ambientFloor;

  let nwSun = dot(dir0, frame.sunDir);
  var color = lit;
  let segKm = pAtm - camAtm;
  let dKm2 = dot(segKm, segKm);
  let dKm = select(0.0, sqrt(dKm2), dKm2 > 9.0);
  let apGate = smoothstep(3.0, 120.0, dKm);
  if (apGate > 0.002) {
    let vRay = segKm / max(dKm, 1e-4);
    var apTrans: vec3<f32>;
    let apInscat0 = atm_marchRadiance(camAtm, vRay, frame.sunDir, dKm, &apTrans);
    let skyHaze = U_SKY_FILL * vec3<f32>(0.40, 0.55, 0.78) * (1.0 - apTrans);
    let apInscat = max(apInscat0, skyHaze);
    let hazed0 = lit * apTrans + apInscat;
    let gz = 1.0 - abs(nwSun);
    var graze = smoothstep(0.55, 1.0, gz);
    graze = graze * graze;
    let termDay = smoothstep(-0.02, 0.18, nwSun);
    let hazed = hazed0 + U_TERMINATOR_GLOW * graze * termDay * vec3<f32>(1.0, 0.55, 0.34) * apGate;
    color = mix(lit, hazed, apGate * U_HAZE_MUL);
  }

  let dayShade = mix(U_NIGHT_FLOOR, 1.0, smoothstep(-U_TERM_WIDTH, U_TERM_WIDTH, nwSun));
  let nightFill = vec3<f32>(0.06, 0.075, 0.11) * U_NIGHT_LIGHTS;
  let color2 = color * dayShade + nightFill * (1.0 - dayShade);
  let c = color2 * U_EXPOSURE;
  var mapped = clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
  let lum = dot(mapped, vec3<f32>(0.2126, 0.7152, 0.0722));
  mapped = mix(vec3<f32>(lum), mapped, U_LOOK_SAT);
  mapped = clamp((mapped - 0.5) * U_LOOK_CONTRAST + 0.5, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(pow(mapped, vec3<f32>(1.0 / 2.2)), 1.0);
}
`
}

function buildSampleWgsl(gridSize) {
  const duP = 1.0 / gridSize
  return `
@group(0) @binding(0) var<uniform> scalarB: vec4<f32>;
@group(0) @binding(1) var poolSampler: sampler;
@group(0) @binding(2) var heightPool: texture_2d_array<f32>;

struct FrameUniforms {
  viewProjNoEye: mat4x4<f32>,
  camDir: vec3<f32>,
  camAlt: f32,
}
@group(1) @binding(0) var<uniform> frame: FrameUniforms;

fn faceFrame(f: f32) -> mat3x3<f32> {
  let i = i32(f + 0.5);
  if (i == 0) { return mat3x3<f32>(0.0,0.0,-1.0,  0.0,1.0,0.0,   1.0,0.0,0.0); }
  if (i == 1) { return mat3x3<f32>(0.0,0.0,1.0,   0.0,1.0,0.0,  -1.0,0.0,0.0); }
  if (i == 2) { return mat3x3<f32>(1.0,0.0,0.0,   0.0,0.0,-1.0,  0.0,1.0,0.0); }
  if (i == 3) { return mat3x3<f32>(1.0,0.0,0.0,   0.0,0.0,1.0,   0.0,-1.0,0.0); }
  if (i == 4) { return mat3x3<f32>(1.0,0.0,0.0,   0.0,1.0,0.0,   0.0,0.0,1.0); }
  return mat3x3<f32>(-1.0,0.0,0.0,  0.0,1.0,0.0,   0.0,0.0,-1.0);
}

fn patchFaceWarp(p: vec2<f32>, defRadius: f32) -> vec2<f32> {
  return defRadius * tan((p / defRadius) * 0.7853981634);
}

fn thcSample(uv: vec2<f32>, layer: i32, poolRes: f32) -> f32 {
  let t = clamp(uv, vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0)) * (poolRes - 1.0);
  let sampleUV = (t + vec2<f32>(0.5, 0.5)) / poolRes;
  return textureSampleLevel(heightPool, poolSampler, sampleUV, layer, 0.0).r;
}

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldRel: vec3<f32>,
  @location(1) height: f32,
  @location(2) nrm: vec3<f32>,
}

@vertex
fn vs_main(
  @location(0) vertex: vec3<f32>,
  @location(1) iOffset: vec4<f32>,
  @location(2) iFace: f32,
  @location(3) iLayer: f32,
) -> VSOut {
  let defRadius = scalarB.z;
  let poolRes = scalarB.w;
  let layer = i32(iLayer);
  let localToWorld = faceFrame(iFace);
  let absLocal = iOffset.xy + vertex.xy * iOffset.z;
  let faceLocal = patchFaceWarp(absLocal, defRadius);
  let dir0 = normalize(localToWorld * vec3<f32>(faceLocal, defRadius));
  let vxy = clamp(vertex.xy, vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0));
  let duP = ${duP};
  let h = thcSample(vxy, layer, poolRes);
  let hPU = thcSample(vxy + vec2<f32>(duP, 0.0), layer, poolRes);
  let hMU = thcSample(vxy + vec2<f32>(-duP, 0.0), layer, poolRes);
  let hPV = thcSample(vxy + vec2<f32>(0.0, duP), layer, poolRes);
  let hMV = thcSample(vxy + vec2<f32>(0.0, -duP), layer, poolRes);
  let dPU = normalize(localToWorld * vec3<f32>(patchFaceWarp(absLocal + vec2<f32>(duP, 0.0) * iOffset.z, defRadius), defRadius));
  let dMU = normalize(localToWorld * vec3<f32>(patchFaceWarp(absLocal + vec2<f32>(-duP, 0.0) * iOffset.z, defRadius), defRadius));
  let dPV = normalize(localToWorld * vec3<f32>(patchFaceWarp(absLocal + vec2<f32>(0.0, duP) * iOffset.z, defRadius), defRadius));
  let dMV = normalize(localToWorld * vec3<f32>(patchFaceWarp(absLocal + vec2<f32>(0.0, -duP) * iOffset.z, defRadius), defRadius));
  var nrm = normalize(cross(dPU * (defRadius + hPU) - dMU * (defRadius + hMU),
                             dPV * (defRadius + hPV) - dMV * (defRadius + hMV)));
  if (dot(nrm, dir0) < 0.0) { nrm = -nrm; }
  let skirt = select(0.0, max(iOffset.z * 0.06, 30.0), vertex.z > 0.5);
  let vRel = (dir0 - frame.camDir) * defRadius + dir0 * (h - skirt) - frame.camDir * frame.camAlt;
  var out: VSOut;
  out.pos = frame.viewProjNoEye * vec4<f32>(vRel, 1.0);
  out.worldRel = vRel;
  out.height = h;
  out.nrm = nrm;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let n = normalize(in.nrm);
  let sun = normalize(vec3<f32>(0.4, 0.8, 0.3));
  let ndotl = clamp(dot(n, sun), 0.0, 1.0);
  let lowColor = vec3<f32>(0.15, 0.35, 0.12);
  let highColor = vec3<f32>(0.55, 0.5, 0.45);
  let t = clamp(in.height / 3000.0, 0.0, 1.0);
  let base = mix(lowColor, highColor, t);
  let lit = base * (0.25 + 0.75 * ndotl);
  return vec4<f32>(lit, 1.0);
}
`
}

export function buildGridGeometry(gridSize) {
  const g2 = gridSize + 2
  const n2 = g2 + 1
  const du = 1.0 / gridSize
  const vlist = []
  for (let y = 0; y < n2; y++) for (let x = 0; x < n2; x++) {
    const isRing = (x === 0 || x === n2 - 1 || y === 0 || y === n2 - 1)
    const px = Math.min(Math.max((x - 1) * du, 0.0), 1.0)
    const py = Math.min(Math.max((y - 1) * du, 0.0), 1.0)
    vlist.push(px, py, isRing ? 1.0 : 0.0)
  }
  const idx = []
  for (let y = 0; y < g2; y++) for (let x = 0; x < g2; x++) {
    const a = y * n2 + x, b = a + 1, c = a + n2, d = c + 1
    let h = (x | (y << 16)) | 0
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b | 0)
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b | 0)
    h = h ^ (h >>> 16)
    if ((h >>> 17) & 1) idx.push(a, c, d, a, d, b)
    else idx.push(a, c, b, b, c, d)
  }
  return { vertices: new Float32Array(vlist), indices: new Uint32Array(idx) }
}

export function buildInstanceData(quads) {
  const n = quads.length
  const FLOATS = 6
  const out = new Float32Array(n * FLOATS)
  for (let i = 0; i < n; i++) {
    const q = quads[i].quad
    out[i * FLOATS + 0] = q.ox
    out[i * FLOATS + 1] = q.oy
    out[i * FLOATS + 2] = q.l
    out[i * FLOATS + 3] = q.level
    out[i * FLOATS + 4] = quads[i].face
    out[i * FLOATS + 5] = 0.0
  }
  return out
}

export function buildInstanceDataThc(quads) {
  const n = quads.length
  const FLOATS = 6
  const out = new Float32Array(n * FLOATS)
  for (let i = 0; i < n; i++) {
    const q = quads[i].quad
    out[i * FLOATS + 0] = q.ox
    out[i * FLOATS + 1] = q.oy
    out[i * FLOATS + 2] = q.l
    out[i * FLOATS + 3] = q.level
    out[i * FLOATS + 4] = quads[i].face
    out[i * FLOATS + 5] = i
  }
  return out
}

export function perspectiveZeroToOne(fovy, aspect, near, far, out) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far)
  const o = out || new Float32Array(16)
  o[0] = f / aspect; o[1] = 0; o[2] = 0; o[3] = 0
  o[4] = 0; o[5] = f; o[6] = 0; o[7] = 0
  o[8] = 0; o[9] = 0; o[10] = far * nf; o[11] = -1
  o[12] = 0; o[13] = 0; o[14] = far * near * nf; o[15] = 0
  return o
}

export function computeViewProjNoEye(cam, aspect, near, far) {
  const proj = perspectiveZeroToOne(cam.fovy || 0.785, aspect, near, far)
  const eye = cam.eye
  const ctr = [cam.center[0] - eye[0], cam.center[1] - eye[1], cam.center[2] - eye[2]]
  const viewRel = M4.lookAt([0, 0, 0], ctr, cam.up || [0, 1, 0])
  return M4.mul(proj, viewRel)
}

function createBufferWithData(device, data, usage) {
  const buf = device.createBuffer({ size: Math.max(data.byteLength, 4), usage, mappedAtCreation: true })
  new data.constructor(buf.getMappedRange()).set(data)
  buf.unmap()
  return buf
}

export function createComposeHeightParams(device, opts = {}) {
  const defRadius = opts.defRadius
  if (!Number.isFinite(defRadius) || defRadius <= 0) throw new TypeError('createComposeHeightParams: opts.defRadius must be a positive finite number')
  const hpfRes = opts.hpfRes || 1
  const sculptRes = opts.sculptRes || 1
  const reliefScale = opts.reliefScale != null ? opts.reliefScale : defRadius / 63600000.0
  const paramsBuf = new ArrayBuffer(16)
  new Uint32Array(paramsBuf).set([0, hpfRes, sculptRes, 0])
  new Float32Array(paramsBuf)[3] = reliefScale
  const paramsU = createBufferWithData(device, new Uint32Array(paramsBuf), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC)
  const scalarA = createBufferWithData(device, new Float32Array([
    opts.landBias || 0, opts.beachShelfM || 150, opts.sculptActive || 0, opts.sculptExtent || 0,
  ]), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC)
  const sculptCenter = opts.sculptCenter || [0, 0]
  const scalarB = createBufferWithData(device, new Float32Array([sculptCenter[0], sculptCenter[1], defRadius, opts.poolRes || 0]), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC)
  const up = opts.sculptUp || [0, 1, 0]
  const east = opts.sculptEast || [1, 0, 0]
  const north = opts.sculptNorth || [0, 0, 1]
  const basis = createBufferWithData(device, new Float32Array([
    up[0], up[1], up[2], 0,
    east[0], east[1], east[2], 0,
    north[0], north[1], north[2], 0,
  ]), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC)
  const hpfFloats = 6 * hpfRes * hpfRes * 4
  const hpfPool = createBufferWithData(device, opts.hpfPoolData || new Float32Array(Math.max(hpfFloats, 4)), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC)
  const sculptFloats = sculptRes * sculptRes
  const sculptTex = createBufferWithData(device, opts.sculptTexData || new Float32Array(Math.max(sculptFloats, 4)), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC)
  return { paramsU, scalarA, scalarB, basis, hpfPool, sculptTex }
}

export function createFrameUniformBuffer(device) {
  return device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
}

export function writeFrameUniforms(device, buffer, { viewProjNoEye, camDir, camAlt, sunDir }) {
  const data = new Float32Array(24)
  data.set(viewProjNoEye, 0)
  data[16] = camDir[0]; data[17] = camDir[1]; data[18] = camDir[2]
  data[19] = camAlt
  const sd = sunDir || [0, 0.6, 0.8]
  data[20] = sd[0]; data[21] = sd[1]; data[22] = sd[2]
  device.queue.writeBuffer(buffer, 0, data)
}

export function createDepthTexture(device, width, height, format = 'depth24plus') {
  return device.createTexture({
    size: { width, height, depthOrArrayLayers: 1 },
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  })
}

const SURF_MAT_COUNT = 4

function createDummySurfaceTextureArrays(device) {
  const albTexture = device.createTexture({
    label: 'patch-grid-render-surf-alb-dummy',
    size: { width: 1, height: 1, depthOrArrayLayers: SURF_MAT_COUNT },
    format: 'rgba8unorm-srgb',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  const nrmTexture = device.createTexture({
    label: 'patch-grid-render-surf-nrm-dummy',
    size: { width: 1, height: 1, depthOrArrayLayers: SURF_MAT_COUNT },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  for (let m = 0; m < SURF_MAT_COUNT; m++) {
    device.queue.writeTexture(
      { texture: albTexture, origin: { x: 0, y: 0, z: m } },
      new Uint8Array([128, 128, 128, 128]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    )
    device.queue.writeTexture(
      { texture: nrmTexture, origin: { x: 0, y: 0, z: m } },
      new Uint8Array([128, 128, 255, 255]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    )
  }
  return { albTexture, nrmTexture }
}

function downsample2x(src, srcOffset, w, h) {
  const w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1)
  const out = new Uint8Array(w2 * h2 * 4)
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1)
      const y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1)
      const o00 = srcOffset + (y0 * w + x0) * 4, o10 = srcOffset + (y0 * w + x1) * 4
      const o01 = srcOffset + (y1 * w + x0) * 4, o11 = srcOffset + (y1 * w + x1) * 4
      const oo = (y * w2 + x) * 4
      for (let c = 0; c < 4; c++) out[oo + c] = (src[o00 + c] + src[o10 + c] + src[o01 + c] + src[o11 + c] + 2) >> 2
    }
  }
  return out
}

async function writeSurfaceTextureArrayMips(device, texture, data, matCount, sz) {
  const mipCount = Math.log2(sz) + 1
  for (let m = 0; m < matCount; m++) {
    let levelData = data
    let levelOffset = m * sz * sz * 4
    let levelSz = sz
    for (let level = 0; level < mipCount; level++) {
      device.queue.writeTexture(
        { texture, origin: { x: 0, y: 0, z: m }, mipLevel: level },
        levelData,
        { offset: levelOffset, bytesPerRow: levelSz * 4, rowsPerImage: levelSz },
        { width: levelSz, height: levelSz, depthOrArrayLayers: 1 },
      )
      if (level < mipCount - 1) {
        levelData = downsample2x(levelData, levelOffset, levelSz, levelSz)
        levelOffset = 0
        levelSz = Math.max(1, levelSz >> 1)
      }
    }
    await new Promise((res) => setTimeout(res, 0))
  }
}

async function createSurfaceTextureArraysWebGPU(device, { albAll, nrmAll, matCount, sz }) {
  const mipCount = Math.log2(sz) + 1
  const albTexture = device.createTexture({
    label: 'patch-grid-render-surf-alb',
    size: { width: sz, height: sz, depthOrArrayLayers: matCount },
    format: 'rgba8unorm-srgb',
    mipLevelCount: mipCount,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  const nrmTexture = device.createTexture({
    label: 'patch-grid-render-surf-nrm',
    size: { width: sz, height: sz, depthOrArrayLayers: matCount },
    format: 'rgba8unorm',
    mipLevelCount: mipCount,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  await writeSurfaceTextureArrayMips(device, albTexture, albAll, matCount, sz)
  await writeSurfaceTextureArrayMips(device, nrmTexture, nrmAll, matCount, sz)
  return { albTexture, nrmTexture }
}

export class PatchGridRenderer {
  constructor(device, opts = {}) {
    this.device = device
    this.gridSize = opts.gridSize || 16
    this.stateKey = opts.stateKey || 'terrain-opaque-cull-none'
    this.colorFormat = opts.colorFormat || 'bgra8unorm'
    this.depthFormat = opts.depthFormat || 'depth24plus'
    this.pipelineCache = opts.pipelineCache || new MapspinnerPipelineCache(device)
    this.mode = opts.mode === 'sample' ? 'sample' : 'compute'
    this.poolRes = opts.poolRes || THC_BAKE_RES
    this.poolLayers = Math.max(1, opts.poolLayers || 1)

    const geo = buildGridGeometry(this.gridSize)
    this.indexCount = geo.indices.length
    this.gridVertexBuffer = createBufferWithData(device, geo.vertices, GPUBufferUsage.VERTEX)
    this.gridIndexBuffer = createBufferWithData(device, geo.indices, GPUBufferUsage.INDEX)

    const composeHeightOpts = opts.composeHeight || { defRadius: opts.defRadius || 6360000 }
    if (this.mode === 'sample' && composeHeightOpts.poolRes == null) composeHeightOpts.poolRes = this.poolRes
    this.composeHeightParams = createComposeHeightParams(device, composeHeightOpts)
    this.frameUniformBuffer = createFrameUniformBuffer(device)

    const p = this.composeHeightParams
    if (this.mode === 'sample') {
      this.heightPool = device.createTexture({
        label: 'patch-grid-render-thc-pool',
        size: { width: this.poolRes, height: this.poolRes, depthOrArrayLayers: this.poolLayers },
        format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      this.poolSampler = device.createSampler({
        label: 'patch-grid-render-thc-sampler',
        magFilter: 'linear', minFilter: 'linear',
        addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
      })
      this.pipeline = this.pipelineCache.getPipeline(this.stateKey, {
        vertexCode: buildSampleWgsl(this.gridSize),
        fragmentCode: buildSampleWgsl(this.gridSize),
        colorFormat: this.colorFormat,
        depthFormat: this.depthFormat,
        vertexBuffers: TERRAIN_PATCH_VERTEX_BUFFERS,
        label: 'patch-grid-render-thc-sample',
      })
      this.bindGroup0 = device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: p.scalarB } },
          { binding: 1, resource: this.poolSampler },
          { binding: 2, resource: this.heightPool.createView({ dimension: '2d-array' }) },
        ],
      })
    } else {
      if (!opts.transmittanceLutTexture || !opts.scatteringLutTexture || !opts.atmosphereSampler) {
        throw new TypeError('PatchGridRenderer compute mode requires opts.transmittanceLutTexture, opts.scatteringLutTexture, opts.atmosphereSampler')
      }
      const renderWgsl = buildRenderWgsl(this.gridSize)
      this.pipeline = this.pipelineCache.getPipeline(this.stateKey, {
        vertexCode: renderWgsl,
        fragmentCode: renderWgsl,
        colorFormat: this.colorFormat,
        depthFormat: this.depthFormat,
        vertexBuffers: TERRAIN_PATCH_VERTEX_BUFFERS,
        label: 'patch-grid-render',
      })
      this.surfSampler = device.createSampler({
        label: 'patch-grid-render-surf-sampler',
        magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
        addressModeU: 'repeat', addressModeV: 'repeat',
        maxAnisotropy: 8,
      })
      this.surfParamsBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(this.surfParamsBuffer, 0, new Float32Array([0.2, 0.2, 0.2, 0.5, 0, 0, 0, 0]))
      const dummySurf = createDummySurfaceTextureArrays(device)
      this._surfAlbTexture = dummySurf.albTexture
      this._surfNrmTexture = dummySurf.nrmTexture
      this._surfTexReady = false
      this._rebuildBindGroup0()
      this.bindGroup2 = device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(2),
        entries: [
          { binding: 0, resource: opts.transmittanceLutTexture.createView() },
          { binding: 1, resource: opts.scatteringLutTexture.createView({ dimension: '2d-array' }) },
          { binding: 2, resource: opts.atmosphereSampler },
        ],
      })
      if (opts.loadSurfaceTextures !== false && canDecodeImages()) {
        this._loadSurfaceTexturesAsync(opts.surfaceTexturesBaseUrl)
      }
    }
    this.bindGroup1 = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(1),
      entries: [{ binding: 0, resource: { buffer: this.frameUniformBuffer } }],
    })

    this.instanceBuffer = null
    this.instanceCapacity = 0
    this._quadsRef = null
  }

  updateFrame(frameUniforms) {
    writeFrameUniforms(this.device, this.frameUniformBuffer, frameUniforms)
  }

  _rebuildBindGroup0() {
    const p = this.composeHeightParams
    this.bindGroup0 = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: p.paramsU } },
        { binding: 1, resource: { buffer: p.scalarA } },
        { binding: 2, resource: { buffer: p.scalarB } },
        { binding: 3, resource: { buffer: p.basis } },
        { binding: 4, resource: this.surfSampler },
        { binding: 5, resource: this._surfAlbTexture.createView({ dimension: '2d-array' }) },
        { binding: 6, resource: { buffer: p.hpfPool } },
        { binding: 7, resource: { buffer: p.sculptTex } },
        { binding: 8, resource: this._surfNrmTexture.createView({ dimension: '2d-array' }) },
        { binding: 9, resource: { buffer: this.surfParamsBuffer } },
      ],
    })
  }

  async _loadSurfaceTexturesAsync(baseUrl) {
    const { albAll, nrmAll, meanL, matCount, sz } = await decodeSurfaceTextureSet(baseUrl)
    const { albTexture, nrmTexture } = await createSurfaceTextureArraysWebGPU(this.device, { albAll, nrmAll, matCount, sz })
    const oldAlb = this._surfAlbTexture, oldNrm = this._surfNrmTexture
    this._surfAlbTexture = albTexture
    this._surfNrmTexture = nrmTexture
    this._surfTexReady = true
    this.device.queue.writeBuffer(this.surfParamsBuffer, 0, new Float32Array([meanL[0], meanL[1], meanL[2], meanL[3], 1, 0, 0, 0]))
    this._rebuildBindGroup0()
    oldAlb.destroy()
    oldNrm.destroy()
  }

  bakeLayer(layerIndex, faceFrame, bakeOffset, bakeOpts, bakePipeline) {
    if (this.mode !== 'sample') throw new Error('PatchGridRenderer.bakeLayer requires mode: "sample"')
    if (layerIndex < 0 || layerIndex >= this.poolLayers) throw new RangeError(`PatchGridRenderer.bakeLayer: layerIndex ${layerIndex} out of range [0,${this.poolLayers})`)
    const pipeline = bakePipeline || (this._bakePipeline || (this._bakePipeline = createHeightBakePipeline(this.device)))
    const tile = bakeHeightTileTexture(this.device, faceFrame, bakeOffset, { ...bakeOpts, res: this.poolRes }, pipeline)
    const encoder = this.device.createCommandEncoder({ label: 'patch-grid-render-thc-layer-copy' })
    encoder.copyTextureToTexture(
      { texture: tile },
      { texture: this.heightPool, origin: { x: 0, y: 0, z: layerIndex } },
      { width: this.poolRes, height: this.poolRes, depthOrArrayLayers: 1 },
    )
    this.device.queue.submit([encoder.finish()])
    tile.destroy()
  }

  _ensureInstanceBuffer(quads) {
    const data = this.mode === 'sample' ? buildInstanceDataThc(quads) : buildInstanceData(quads)
    if (!this.instanceBuffer || this.instanceCapacity < data.byteLength) {
      if (this.instanceBuffer) this.instanceBuffer.destroy()
      this.instanceBuffer = this.device.createBuffer({
        size: Math.max(data.byteLength, 24),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
      this.instanceCapacity = this.instanceBuffer.size
    }
    this.device.queue.writeBuffer(this.instanceBuffer, 0, data)
    this._quadsRef = quads
    this._instanceCount = quads.length
  }

  render(passEncoder, quads) {
    if (quads.length === 0) return
    this._ensureInstanceBuffer(quads)
    passEncoder.setPipeline(this.pipeline)
    passEncoder.setBindGroup(0, this.bindGroup0)
    passEncoder.setBindGroup(1, this.bindGroup1)
    if (this.bindGroup2) passEncoder.setBindGroup(2, this.bindGroup2)
    passEncoder.setVertexBuffer(0, this.gridVertexBuffer)
    passEncoder.setVertexBuffer(1, this.instanceBuffer)
    passEncoder.setIndexBuffer(this.gridIndexBuffer, 'uint32')
    passEncoder.drawIndexed(this.indexCount, this._instanceCount)
  }
}

export { buildRenderWgsl, createBufferWithData, buildSampleWgsl }
