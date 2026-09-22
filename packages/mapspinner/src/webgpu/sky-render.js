import { MapspinnerPipelineCache } from './pipeline-cache.js'

export const ATMOSPHERE_CORE_WGSL = `
const ATM_PI: f32 = 3.14159265358979;
const ATM_BOTTOM: f32 = 6360.0;
const ATM_TOP: f32 = 6500.0;
const ATM_RAYLEIGH_H: f32 = 18.0;
const ATM_MIE_H: f32 = 4.0;
const ATM_MIE_G: f32 = 0.8;
const ATM_RAYLEIGH: vec3<f32> = vec3<f32>(0.005802, 0.013558, 0.0331);
const ATM_MIE: vec3<f32> = vec3<f32>(0.003996, 0.003996, 0.003996);
const ATM_MIE_EXT: vec3<f32> = vec3<f32>(0.0044400002, 0.0044400002, 0.0044400002);
const ATM_SOLAR_IRRADIANCE: vec3<f32> = vec3<f32>(1.474, 1.8504, 1.91198);
const ATM_SUN_ANGULAR_RADIUS: f32 = 0.004675;
const ATM_BOTTOM2: f32 = ATM_BOTTOM * ATM_BOTTOM;
const ATM_TOP2: f32 = ATM_TOP * ATM_TOP;
const ATM_MIE_G2: f32 = ATM_MIE_G * ATM_MIE_G;
const ATM_MIE_2G: f32 = 2.0 * ATM_MIE_G;
const ATM_MIE_K: f32 = (3.0 / (8.0 * ATM_PI)) * (1.0 - ATM_MIE_G2) / (2.0 + ATM_MIE_G2);
const ATM_RAYLEIGH_PHASE_K: f32 = 3.0 / (16.0 * ATM_PI);
const ATM_INV_RAYLEIGH_H: f32 = 1.0 / ATM_RAYLEIGH_H;
const ATM_INV_MIE_H: f32 = 1.0 / ATM_MIE_H;
const ATM_RHO_MAX: f32 = 6403.774997918573;
const ATM_SCAT_LAYERS: f32 = 24.0;
const ATM_SCAT_K: f32 = 1.4;
const ATM_HORIZON_BLEND_MU: f32 = 0.006;

fn atmPos(worldMeters: vec3<f32>, R_m: f32) -> vec3<f32> {
  return worldMeters * (ATM_BOTTOM / R_m);
}

fn atm_rayleighPhase(nu: f32) -> f32 { return ATM_RAYLEIGH_PHASE_K * (1.0 + nu * nu); }
fn atm_miePhase(nu: f32) -> f32 {
  let base = max(1.0 + ATM_MIE_G2 - ATM_MIE_2G * nu, 1e-4);
  return ATM_MIE_K * (1.0 + nu * nu) / (base * sqrt(base));
}

fn atm_distToTop(r: f32, mu: f32) -> f32 {
  let disc = r * r * (mu * mu - 1.0) + ATM_TOP2;
  if (disc < 0.0) { return -1.0; }
  return max(-r * mu + sqrt(disc), 0.0);
}
fn atm_distToGround_continuous(r: f32, mu: f32) -> f32 {
  let disc = max(r * r * (mu * mu - 1.0) + ATM_BOTTOM2, 0.0);
  return -r * mu - sqrt(disc);
}
fn atm_densities(r: f32, dR: ptr<function, f32>, dM: ptr<function, f32>) {
  let alt = r - ATM_BOTTOM;
  *dR = exp(-alt * ATM_INV_RAYLEIGH_H);
  *dM = exp(-alt * ATM_INV_MIE_H);
}
`

export function atmosphereLutBindingsWgsl(group, base) {
  return `
@group(${group}) @binding(${base}) var transmittanceLUT: texture_2d<f32>;
@group(${group}) @binding(${base + 1}) var scatteringLUT: texture_2d_array<f32>;
@group(${group}) @binding(${base + 2}) var lutSampler: sampler;
`
}

export const ATMOSPHERE_LUT_FUNCS_WGSL = `
fn atm_lutUV(r: f32, mu: f32) -> vec2<f32> {
  let rho = sqrt(max(r * r - ATM_BOTTOM2, 0.0));
  let u = clamp(rho / ATM_RHO_MAX, 0.0, 1.0);
  let dMin = ATM_TOP - r;
  let dMax = rho + ATM_RHO_MAX;
  let d = atm_distToTop(r, mu);
  var v: f32 = 0.0;
  if (dMax > dMin) { v = clamp((d - dMin) / (dMax - dMin), 0.0, 1.0); }
  return vec2<f32>(u, v);
}
fn atm_transmittanceLUTSample(r: f32, mu: f32) -> vec3<f32> {
  let uv = atm_lutUV(r, mu);
  return textureSampleLevel(transmittanceLUT, lutSampler, uv, 0.0).rgb;
}
fn atm_transmittanceToSun(p: vec3<f32>, sun: vec3<f32>) -> vec3<f32> {
  let r = length(p);
  let mu = dot(p, sun) / r;
  let muHoriz = -sqrt(max(0.0, 1.0 - ATM_BOTTOM2 / (r * r)));
  let soft = smoothstep(muHoriz - 0.035, muHoriz + 0.005, mu);
  if (soft <= 0.0) { return vec3<f32>(0.0); }
  return atm_transmittanceLUTSample(r, mu) * soft;
}

fn atm_scatMuSToLayerF(muS: f32) -> f32 {
  let th = tanh(ATM_SCAT_K);
  let t = atanh(clamp(muS * th, -0.999999, 0.999999)) / ATM_SCAT_K;
  let w = clamp((t + 1.0) * 0.5, 0.0, 1.0);
  return clamp(w * ATM_SCAT_LAYERS - 0.5, 0.0, ATM_SCAT_LAYERS - 1.0);
}
fn atm_scatteringLUTSample(r: f32, mu: f32, muS: f32) -> vec4<f32> {
  let uv = atm_lutUV(r, mu);
  let lf = atm_scatMuSToLayerF(muS);
  let l0 = floor(lf);
  let l1 = min(l0 + 1.0, ATM_SCAT_LAYERS - 1.0);
  let lt = lf - l0;
  let s0 = textureSampleLevel(scatteringLUT, lutSampler, uv, i32(l0), 0.0);
  let s1 = textureSampleLevel(scatteringLUT, lutSampler, uv, i32(l1), 0.0);
  return mix(s0, s1, lt);
}

fn atm_marchRadiance(camera: vec3<f32>, viewRay: vec3<f32>, sun: vec3<f32>, dEnd: f32, transmittance: ptr<function, vec3<f32>>) -> vec3<f32> {
  let r = length(camera);
  let mu = dot(camera, viewRay) / r;
  let muS = dot(camera, sun) / r;
  let nu = dot(viewRay, sun);
  let dTop = atm_distToTop(r, mu);
  if (dTop > 0.0) {
    let fullScat = atm_scatteringLUTSample(r, mu, muS);
    var inscatR = fullScat.rgb;
    var inscatM = fullScat.a;
    let tFull = atm_transmittanceLUTSample(r, mu);
    if (dEnd < dTop - 1e-4) {
      let pEnd = camera + viewRay * dEnd;
      let rEnd = length(pEnd);
      let muEnd = dot(pEnd, viewRay) / rEnd;
      let muSEnd = dot(pEnd, sun) / rEnd;
      let tailScat = atm_scatteringLUTSample(rEnd, muEnd, muSEnd);
      let tToEnd = atm_transmittanceLUTSample(r, mu) / max(atm_transmittanceLUTSample(rEnd, muEnd), vec3<f32>(1e-6));
      inscatR = max(inscatR - tToEnd * tailScat.rgb, vec3<f32>(0.0));
      inscatM = max(inscatM - dot(tToEnd, vec3<f32>(1.0 / 3.0)) * tailScat.a, 0.0);
      *transmittance = tToEnd;
    } else {
      *transmittance = tFull;
    }
    return ATM_SOLAR_IRRADIANCE * (
      inscatR * ATM_RAYLEIGH * atm_rayleighPhase(nu) +
      inscatM * ATM_MIE * atm_miePhase(nu));
  }
  *transmittance = vec3<f32>(1.0);
  return vec3<f32>(0.0);
}

fn atm_skyRadiance(cameraIn: vec3<f32>, viewRay: vec3<f32>, sun: vec3<f32>, transmittance: ptr<function, vec3<f32>>) -> vec3<f32> {
  var camera = cameraIn;
  var r = length(camera);
  var mu = dot(camera, viewRay) / r;
  if (r > ATM_TOP) {
    let dt = atm_distToTop(r, mu);
    if (dt < 0.0) { *transmittance = vec3<f32>(1.0); return vec3<f32>(0.0); }
    camera = camera + viewRay * dt;
    r = length(camera);
    mu = dot(camera, viewRay) / r;
  }
  let dTop = atm_distToTop(r, mu);
  if (dTop <= 0.0) { *transmittance = vec3<f32>(1.0); return vec3<f32>(0.0); }
  let muTangent = -sqrt(max(0.0, 1.0 - ATM_BOTTOM2 / (r * r)));
  let wSky = smoothstep(muTangent - ATM_HORIZON_BLEND_MU, muTangent + ATM_HORIZON_BLEND_MU, mu);
  var transSky: vec3<f32>;
  let radSky = atm_marchRadiance(camera, viewRay, sun, dTop, &transSky);
  if (wSky >= 1.0) { *transmittance = transSky; return radSky; }
  let dGround = max(atm_distToGround_continuous(r, mu), 1e-3);
  var transGround: vec3<f32>;
  let radGround = atm_marchRadiance(camera, viewRay, sun, dGround, &transGround);
  if (wSky <= 0.0) { *transmittance = vec3<f32>(0.0); return radGround; }
  *transmittance = mix(vec3<f32>(0.0), transSky, wSky);
  return mix(radGround, radSky, wSky);
}

fn atm_sunSkyIrradiance(point: vec3<f32>, normal: vec3<f32>, sun: vec3<f32>, skyIrradiance: ptr<function, vec3<f32>>) -> vec3<f32> {
  let r = length(point);
  let up = point / r;
  let muS = dot(up, sun);
  let tSun = atm_transmittanceToSun(up * (ATM_BOTTOM + 0.5), sun);
  let direct = ATM_SOLAR_IRRADIANCE * tSun * clamp(dot(normal, sun), 0.0, 1.0);
  let day = smoothstep(-0.10, 0.25, muS);
  let rayTint = ATM_RAYLEIGH / ATM_RAYLEIGH.x;
  let skyTint = mix(vec3<f32>(1.0), rayTint, 0.4);
  *skyIrradiance = ATM_SOLAR_IRRADIANCE * 0.075 * day * skyTint * (0.5 * (1.0 + dot(normal, up)));
  return direct;
}
`

export const ATMOSPHERE_WGSL = ATMOSPHERE_CORE_WGSL + atmosphereLutBindingsWgsl(0, 1) + ATMOSPHERE_LUT_FUNCS_WGSL

const SKY_UNIFORMS_WGSL = `
struct SkyUniforms {
  camRotCols: array<vec4<f32>, 3>,
  projDiag: vec4<f32>,
  skyCamWorld: vec4<f32>,
  skySunDir: vec4<f32>,
  params: vec4<f32>,
}
@group(0) @binding(0) var<uniform> skyU: SkyUniforms;
`

const SKY_MAIN_WGSL = `
struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) ndc: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VSOut {
  var p: vec2<f32>;
  p.x = select(-1.0, 3.0, vid == 1u);
  p.y = select(-1.0, 3.0, vid == 2u);
  var out: VSOut;
  out.pos = vec4<f32>(p, 1.0, 1.0);
  out.ndc = p;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let projDiag = skyU.projDiag.xy;
  let dirView = normalize(vec3<f32>(in.ndc.x / projDiag.x, in.ndc.y / projDiag.y, -1.0));
  let c0 = skyU.camRotCols[0].xyz;
  let c1 = skyU.camRotCols[1].xyz;
  let c2 = skyU.camRotCols[2].xyz;
  let viewRay = normalize(c0 * dirView.x + c1 * dirView.y + c2 * dirView.z);
  let skyCamWorld = skyU.skyCamWorld.xyz;
  let skySunDir = skyU.skySunDir.xyz;
  let skyR = skyU.params.x;
  let uSkyFade = skyU.params.y;
  let uSkyDbg = skyU.params.z;

  let camAtm = atmPos(skyCamWorld, skyR);
  var t: vec3<f32>;
  var radiance = atm_skyRadiance(camAtm, viewRay, skySunDir, &t);

  let rc = length(camAtm);
  let muc = dot(camAtm, viewRay) / rc;
  let b = rc * sqrt(max(1.0 - muc * muc, 0.0));
  var halo = 0.0;
  if (muc < 0.0) {
    let t0 = (b - ATM_BOTTOM) / (ATM_TOP - ATM_BOTTOM);
    halo = smoothstep(0.0, 0.06, t0) * (1.0 - smoothstep(0.25, 1.6, t0));
  }
  let limbDir = normalize(camAtm + viewRay * (-rc * muc));
  let lit = 0.25 + 0.75 * smoothstep(-0.5, 0.6, dot(limbDir, skySunDir));
  let haloColor = vec3<f32>(0.32, 0.55, 1.0);
  radiance = radiance + haloColor * (halo * lit) * 0.03;

  let cosVS = dot(viewRay, skySunDir);
  if (cosVS > cos(ATM_SUN_ANGULAR_RADIUS)) {
    radiance = radiance + t * ATM_SOLAR_IRRADIANCE * 6.0;
  }
  let sunElevDot = clamp(dot(skySunDir, normalize(skyCamWorld)), 0.0, 1.0);
  let skyExposure = mix(48.0, 14.0, sunElevDot);
  let c = radiance * vec3<f32>(0.82, 0.95, 1.22) * skyExposure;
  var mapped = clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
  let skyLum = dot(mapped, vec3<f32>(0.2126, 0.7152, 0.0722));
  mapped = clamp(mix(vec3<f32>(skyLum), mapped, 1.3), vec3<f32>(0.0), vec3<f32>(1.0));

  if (uSkyDbg > 0.5) {
    var dbg = radiance;
    if (uSkyDbg < 1.5) { dbg = radiance; }
    else if (uSkyDbg < 2.5) { dbg = c; }
    else if (uSkyDbg < 3.5) { dbg = mapped; }
    return vec4<f32>(dbg, 1.0);
  }
  return vec4<f32>(pow(mapped, vec3<f32>(1.0 / 2.2)) * uSkyFade, 1.0);
}
`

export const SKY_WGSL = ATMOSPHERE_WGSL + SKY_UNIFORMS_WGSL + SKY_MAIN_WGSL
const SKY_UNIFORM_BUFFER_SIZE = 112

export function computeCamRotCols(viewRel) {
  return [
    [viewRel[0], viewRel[4], viewRel[8]],
    [viewRel[1], viewRel[5], viewRel[9]],
    [viewRel[2], viewRel[6], viewRel[10]],
  ]
}

export function skyFadeFromAlt(camAlt) {
  return Math.max(0.0, 1.0 - camAlt / 100000.0)
}

export function createSkyUniformBuffer(device) {
  return device.createBuffer({ size: SKY_UNIFORM_BUFFER_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
}

export function writeSkyUniforms(device, buffer, opts) {
  const { camRotCols, projDiag, skyCamWorld, skySunDir, skyR, skyFade } = opts
  const skyDbg = opts.skyDbg || 0
  const data = new Float32Array(SKY_UNIFORM_BUFFER_SIZE / 4)
  data[0] = camRotCols[0][0]; data[1] = camRotCols[0][1]; data[2] = camRotCols[0][2]; data[3] = 0
  data[4] = camRotCols[1][0]; data[5] = camRotCols[1][1]; data[6] = camRotCols[1][2]; data[7] = 0
  data[8] = camRotCols[2][0]; data[9] = camRotCols[2][1]; data[10] = camRotCols[2][2]; data[11] = 0
  data[12] = projDiag[0]; data[13] = projDiag[1]; data[14] = 0; data[15] = 0
  data[16] = skyCamWorld[0]; data[17] = skyCamWorld[1]; data[18] = skyCamWorld[2]; data[19] = 0
  data[20] = skySunDir[0]; data[21] = skySunDir[1]; data[22] = skySunDir[2]; data[23] = 0
  data[24] = skyR; data[25] = skyFade; data[26] = skyDbg; data[27] = 0
  device.queue.writeBuffer(buffer, 0, data)
}

export class SkyRenderer {
  constructor(device, opts = {}) {
    if (!opts.transmittanceLutTexture || !opts.scatteringLutTexture || !opts.sampler) {
      throw new TypeError('SkyRenderer requires opts.transmittanceLutTexture, opts.scatteringLutTexture, opts.sampler')
    }
    this.device = device
    this.pipelineCache = opts.pipelineCache || new MapspinnerPipelineCache(device)
    this.colorFormat = opts.colorFormat || 'bgra8unorm'
    this.depthFormat = opts.depthFormat || 'depth24plus'
    this.uniformBuffer = createSkyUniformBuffer(device)

    this.pipelineDepthTested = this.pipelineCache.getPipeline('sky-depth-tested', {
      vertexCode: SKY_WGSL, fragmentCode: SKY_WGSL,
      colorFormat: this.colorFormat, depthFormat: this.depthFormat,
      vertexBuffers: [], label: 'sky-render-depth-tested',
    })
    this.pipelineNoDepth = this.pipelineCache.getPipeline('sky-no-depth', {
      vertexCode: SKY_WGSL, fragmentCode: SKY_WGSL,
      colorFormat: this.colorFormat,
      vertexBuffers: [], label: 'sky-render-no-depth',
    })

    const scatView = opts.scatteringLutTexture.createView({ dimension: '2d-array' })
    const transView = opts.transmittanceLutTexture.createView()
    const makeBindGroup = (pipeline) => device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: transView },
        { binding: 2, resource: scatView },
        { binding: 3, resource: opts.sampler },
      ],
    })
    this.bindGroupDepthTested = makeBindGroup(this.pipelineDepthTested)
    this.bindGroupNoDepth = makeBindGroup(this.pipelineNoDepth)
  }

  updateUniforms(opts) {
    writeSkyUniforms(this.device, this.uniformBuffer, opts)
  }

  render(passEncoder, depthTested) {
    const pipeline = depthTested ? this.pipelineDepthTested : this.pipelineNoDepth
    const bindGroup = depthTested ? this.bindGroupDepthTested : this.bindGroupNoDepth
    passEncoder.setPipeline(pipeline)
    passEncoder.setBindGroup(0, bindGroup)
    passEncoder.draw(3, 1, 0, 0)
  }
}
