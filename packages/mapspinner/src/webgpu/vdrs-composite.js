import { MapspinnerPipelineCache } from './pipeline-cache.js'

const FULLSCREEN_VS_WGSL = `
struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}
@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VSOut {
  var p: vec2<f32>;
  p.x = select(-1.0, 3.0, vid == 1u);
  p.y = select(-1.0, 3.0, vid == 2u);
  var out: VSOut;
  out.pos = vec4<f32>(p, 0.0, 1.0);
  out.uv = p * 0.5 + vec2<f32>(0.5, 0.5);
  return out;
}
`

const BILINEAR_UPSCALE_FS_WGSL = `
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
struct UpscaleParams { uvScale: vec4<f32> }
@group(0) @binding(2) var<uniform> up: UpscaleParams;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  return textureSampleLevel(srcTex, srcSampler, in.uv * up.uvScale.xy, 0.0);
}
`

const EASU_FS_WGSL = `
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
struct EasuParams { uvScale: vec4<f32>, srcTexel: vec4<f32> }
@group(0) @binding(2) var<uniform> ep: EasuParams;
const EASU_LUMA = vec3<f32>(0.2126, 0.7152, 0.0722);

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let uv = in.uv * ep.uvScale.xy;
  let texel = ep.srcTexel.xy * ep.uvScale.xy;
  let center = textureSampleLevel(srcTex, srcSampler, uv, 0.0).rgb;
  let n = textureSampleLevel(srcTex, srcSampler, uv + vec2<f32>(0.0, -texel.y), 0.0).rgb;
  let s = textureSampleLevel(srcTex, srcSampler, uv + vec2<f32>(0.0, texel.y), 0.0).rgb;
  let e = textureSampleLevel(srcTex, srcSampler, uv + vec2<f32>(texel.x, 0.0), 0.0).rgb;
  let w = textureSampleLevel(srcTex, srcSampler, uv + vec2<f32>(-texel.x, 0.0), 0.0).rgb;
  let lc = dot(center, EASU_LUMA);
  let ln = dot(n, EASU_LUMA);
  let ls = dot(s, EASU_LUMA);
  let le = dot(e, EASU_LUMA);
  let lw = dot(w, EASU_LUMA);
  let lmin = min(lc, min(min(ln, ls), min(le, lw)));
  let lmax = max(lc, max(max(ln, ls), max(le, lw)));
  let contrast = clamp((lmax - lmin) * 4.0, 0.0, 1.0);
  let dirAvg = (n + s + e + w) * 0.25;
  let sharp = center * (1.0 + contrast * 0.5) - dirAvg * (contrast * 0.5);
  return vec4<f32>(mix(center, sharp, contrast), 1.0);
}
`

const RCAS_FS_WGSL = `
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
struct RcasParams { texel: vec4<f32>, sharpness: vec4<f32> }
@group(0) @binding(2) var<uniform> rp: RcasParams;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let uv = in.uv;
  let texel = rp.texel.xy;
  let sharpness = rp.sharpness.x;
  let c = textureSampleLevel(srcTex, srcSampler, uv, 0.0).rgb;
  let n = textureSampleLevel(srcTex, srcSampler, uv + vec2<f32>(0.0, -texel.y), 0.0).rgb;
  let s = textureSampleLevel(srcTex, srcSampler, uv + vec2<f32>(0.0, texel.y), 0.0).rgb;
  let e = textureSampleLevel(srcTex, srcSampler, uv + vec2<f32>(texel.x, 0.0), 0.0).rgb;
  let w = textureSampleLevel(srcTex, srcSampler, uv + vec2<f32>(-texel.x, 0.0), 0.0).rgb;
  let mn4 = min(min(n, s), min(e, w));
  let mx4 = max(max(n, s), max(e, w));
  let mn = min(mn4, c);
  let mx = max(mx4, c);
  let reciprocalMx = 1.0 / max(mx, vec3<f32>(0.0001));
  var ampl = clamp(min(mn, vec3<f32>(2.0) - mx) * reciprocalMx, vec3<f32>(0.0), vec3<f32>(1.0));
  ampl = sqrt(ampl);
  let w4 = ampl * mix(vec3<f32>(-0.125), vec3<f32>(-0.20), sharpness);
  let numerator = w4 * (n + s + e + w) + c;
  let denominator = vec3<f32>(1.0) + 4.0 * w4;
  let result = numerator / denominator;
  return vec4<f32>(clamp(result, vec3<f32>(0.0), vec3<f32>(4.0)), 1.0);
}
`

const DEPTH_CONVERT_WGSL = `
fn wgpuZeroToOneEyeDepth(zNdc: f32, near: f32, far: f32) -> f32 {
  let nf = 1.0 / (near - far);
  let m10 = far * nf;
  let m14 = far * near * nf;
  return m14 / (zNdc + m10);
}
fn wgpuZeroToOneNdcDepth(eyeDepth: f32, near: f32, far: f32) -> f32 {
  let nf = 1.0 / (near - far);
  let m10 = far * nf;
  let m14 = far * near * nf;
  return m14 / eyeDepth - m10;
}
fn depthWritebackNdc(zNdcSrc: f32, uDepthEps: f32, uSrcNear: f32, uSrcFar: f32, uDstNear: f32, uDstFar: f32) -> f32 {
  let zEye = wgpuZeroToOneEyeDepth(zNdcSrc, uSrcNear, uSrcFar);
  let projB = (uDstFar * uDstNear) / (uDstFar - uDstNear);
  var biasM = 0.0;
  if (projB > 0.0) { biasM = uDepthEps * zEye * zEye / projB; }
  let zEyeBiased = zEye + biasM;
  return clamp(wgpuZeroToOneNdcDepth(zEyeBiased, uDstNear, uDstFar), 0.0, 1.0);
}
`

const DEPTH_WRITEBACK_FS_WGSL = DEPTH_CONVERT_WGSL + `
@group(0) @binding(0) var depthTex: texture_depth_2d;
@group(0) @binding(1) var depthSampler: sampler;
struct DwParams { bias: vec4<f32>, uvScale: vec4<f32>, srcNearFar: vec4<f32>, dstNearFar: vec4<f32> }
@group(0) @binding(2) var<uniform> dw: DwParams;

struct DwOut { @builtin(frag_depth) depth: f32 }

@fragment
fn fs_main(in: VSOut) -> DwOut {
  let zNdcSrc = textureSampleLevel(depthTex, depthSampler, in.uv * dw.uvScale.xy, 0);
  var out: DwOut;
  out.depth = depthWritebackNdc(zNdcSrc, dw.bias.x, dw.srcNearFar.x, dw.srcNearFar.y, dw.dstNearFar.x, dw.dstNearFar.y);
  return out;
}
`

const UPSCALE_DEPTH_WRITEBACK_FS_WGSL = DEPTH_CONVERT_WGSL + `
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var colorSampler: sampler;
@group(0) @binding(2) var depthTex: texture_depth_2d;
@group(0) @binding(3) var depthSampler: sampler;
struct UdwParams { bias: vec4<f32>, uvScale: vec4<f32>, srcNearFar: vec4<f32>, dstNearFar: vec4<f32> }
@group(0) @binding(4) var<uniform> udw: UdwParams;

struct UdwOut {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
}

@fragment
fn fs_main(in: VSOut) -> UdwOut {
  let uv = in.uv * udw.uvScale.xy;
  let zNdcSrc = textureSampleLevel(depthTex, depthSampler, uv, 0);
  var out: UdwOut;
  out.color = textureSampleLevel(colorTex, colorSampler, uv, 0.0);
  out.depth = depthWritebackNdc(zNdcSrc, udw.bias.x, udw.srcNearFar.x, udw.srcNearFar.y, udw.dstNearFar.x, udw.dstNearFar.y);
  return out;
}
`

export const BILINEAR_UPSCALE_WGSL = FULLSCREEN_VS_WGSL + BILINEAR_UPSCALE_FS_WGSL
export const EASU_WGSL = FULLSCREEN_VS_WGSL + EASU_FS_WGSL
export const RCAS_WGSL = FULLSCREEN_VS_WGSL + RCAS_FS_WGSL
export const DEPTH_WRITEBACK_WGSL = FULLSCREEN_VS_WGSL + DEPTH_WRITEBACK_FS_WGSL
export const UPSCALE_DEPTH_WRITEBACK_WGSL = FULLSCREEN_VS_WGSL + UPSCALE_DEPTH_WRITEBACK_FS_WGSL

export function createLinearSampler(device) {
  return device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' })
}
export function createDepthSampler(device) {
  return device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' })
}

export function createVdrsColorTexture(device, width, height, format = 'rgba16float') {
  return device.createTexture({
    label: 'vdrs-color', size: { width, height, depthOrArrayLayers: 1 }, format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  })
}
export function createVdrsDepthTexture(device, width, height, format = 'depth32float') {
  return device.createTexture({
    label: 'vdrs-depth', size: { width, height, depthOrArrayLayers: 1 }, format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  })
}

export class BilinearUpscale {
  constructor(device, opts = {}) {
    this.device = device
    this.pipelineCache = opts.pipelineCache || new MapspinnerPipelineCache(device)
    this.colorFormat = opts.colorFormat || 'bgra8unorm'
    this.sampler = opts.sampler || createLinearSampler(device)
    this.pipeline = this.pipelineCache.getPipeline('fullscreen-blit', {
      vertexCode: BILINEAR_UPSCALE_WGSL, fragmentCode: BILINEAR_UPSCALE_WGSL,
      colorFormat: this.colorFormat, vertexBuffers: [], label: 'vdrs-bilinear-upscale',
    })
    this.uniformBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this._bindGroupTex = null
    this.bindGroup = null
  }

  render(passEncoder, { srcTexture, renderScaleX, renderScaleY }) {
    this.device.queue.writeBuffer(this.uniformBuffer, 0, new Float32Array([renderScaleX, renderScaleY, 0, 0]))
    if (this._bindGroupTex !== srcTexture) {
      this.bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: srcTexture.createView() },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: this.uniformBuffer } },
        ],
      })
      this._bindGroupTex = srcTexture
    }
    passEncoder.setPipeline(this.pipeline)
    passEncoder.setBindGroup(0, this.bindGroup)
    passEncoder.draw(3, 1, 0, 0)
  }
}

export class Fsr1Upscale {
  constructor(device, opts = {}) {
    this.device = device
    this.pipelineCache = opts.pipelineCache || new MapspinnerPipelineCache(device)
    this.colorFormat = opts.colorFormat || 'bgra8unorm'
    this.sampler = opts.sampler || createLinearSampler(device)
    this.easuPipeline = this.pipelineCache.getPipeline('fullscreen-blit', {
      vertexCode: EASU_WGSL, fragmentCode: EASU_WGSL,
      colorFormat: 'rgba16float', vertexBuffers: [], label: 'vdrs-fsr1-easu',
    })
    this.rcasPipeline = this.pipelineCache.getPipeline('fullscreen-blit', {
      vertexCode: RCAS_WGSL, fragmentCode: RCAS_WGSL,
      colorFormat: this.colorFormat, vertexBuffers: [], label: 'vdrs-fsr1-rcas',
    })
    this.easuUniformBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.rcasUniformBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this._intermediate = null
    this._iw = 0; this._ih = 0
    this._easuBindGroupTex = null
    this._rcasBindGroup = null
  }

  _ensureIntermediate(w, h) {
    if (this._intermediate && this._iw === w && this._ih === h) return
    if (this._intermediate) this._intermediate.destroy()
    this._intermediate = createVdrsColorTexture(this.device, w, h, 'rgba16float')
    this._iw = w; this._ih = h
    this._rcasBindGroup = null
  }

  render(commandEncoder, { srcTexture, srcFullW, srcFullH, renderScaleX, renderScaleY, dstView, dstW, dstH, sharpness }) {
    this._ensureIntermediate(dstW, dstH)
    this.device.queue.writeBuffer(this.easuUniformBuffer, 0, new Float32Array([
      renderScaleX, renderScaleY, 0, 0,
      1 / srcFullW, 1 / srcFullH, 0, 0,
    ]))
    if (this._easuBindGroupTex !== srcTexture) {
      this._easuBindGroup = this.device.createBindGroup({
        layout: this.easuPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: srcTexture.createView() },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: this.easuUniformBuffer } },
        ],
      })
      this._easuBindGroupTex = srcTexture
    }
    const easuPass = commandEncoder.beginRenderPass({
      colorAttachments: [{ view: this._intermediate.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    })
    easuPass.setPipeline(this.easuPipeline)
    easuPass.setBindGroup(0, this._easuBindGroup)
    easuPass.draw(3, 1, 0, 0)
    easuPass.end()

    this.device.queue.writeBuffer(this.rcasUniformBuffer, 0, new Float32Array([
      1 / dstW, 1 / dstH, 0, 0,
      sharpness != null ? sharpness : 0.5, 0, 0, 0,
    ]))
    if (!this._rcasBindGroup) {
      this._rcasBindGroup = this.device.createBindGroup({
        layout: this.rcasPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this._intermediate.createView() },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: this.rcasUniformBuffer } },
        ],
      })
    }
    const rcasPass = commandEncoder.beginRenderPass({
      colorAttachments: [{ view: dstView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    })
    rcasPass.setPipeline(this.rcasPipeline)
    rcasPass.setBindGroup(0, this._rcasBindGroup)
    rcasPass.draw(3, 1, 0, 0)
    rcasPass.end()
  }
}

export class DepthWriteback {
  constructor(device, opts = {}) {
    this.device = device
    this.pipelineCache = opts.pipelineCache || new MapspinnerPipelineCache(device)
    this.depthFormat = opts.depthFormat || 'depth32float'
    this.sampler = opts.sampler || createDepthSampler(device)
    this.uniformBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this._bindGroupTex = null
    this._pipelineDepthFormat = null
    this.pipeline = null
  }

  _pipelineFor(depthFormat) {
    if (this.pipeline && this._pipelineDepthFormat === depthFormat) return this.pipeline
    this.pipeline = this.pipelineCache.getPipeline('depth-writeback-colormask-off', {
      vertexCode: DEPTH_WRITEBACK_WGSL, fragmentCode: DEPTH_WRITEBACK_WGSL,
      depthFormat, depthOnly: true,
      vertexBuffers: [], label: 'vdrs-depth-writeback',
    })
    this._pipelineDepthFormat = depthFormat
    this._bindGroupTex = null
    return this.pipeline
  }

  render(passEncoder, { srcDepthTexture, uvScaleX, uvScaleY, depthEps, srcNear, srcFar, dstNear, dstFar, depthFormat }) {
    const pipeline = this._pipelineFor(depthFormat || this.depthFormat)
    const data = new Float32Array(16)
    data[0] = depthEps != null ? depthEps : 2e-6
    data[4] = uvScaleX; data[5] = uvScaleY
    data[8] = srcNear; data[9] = srcFar
    data[12] = dstNear; data[13] = dstFar
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data)
    if (this._bindGroupTex !== srcDepthTexture) {
      this.bindGroup = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: srcDepthTexture.createView() },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: this.uniformBuffer } },
        ],
      })
      this._bindGroupTex = srcDepthTexture
    }
    passEncoder.setPipeline(pipeline)
    passEncoder.setBindGroup(0, this.bindGroup)
    passEncoder.draw(3, 1, 0, 0)
  }
}

export class UpscaleDepthWriteback {
  constructor(device, opts = {}) {
    this.device = device
    this.pipelineCache = opts.pipelineCache || new MapspinnerPipelineCache(device)
    this.colorFormat = opts.colorFormat || 'bgra8unorm'
    this.depthFormat = opts.depthFormat || 'depth32float'
    this.colorSampler = opts.colorSampler || createLinearSampler(device)
    this.depthSampler = opts.depthSampler || createDepthSampler(device)
    this.pipeline = this.pipelineCache.getPipeline('depth-writeback-colormask-on', {
      vertexCode: UPSCALE_DEPTH_WRITEBACK_WGSL, fragmentCode: UPSCALE_DEPTH_WRITEBACK_WGSL,
      colorFormat: this.colorFormat, depthFormat: this.depthFormat,
      vertexBuffers: [], label: 'vdrs-upscale-depth-writeback',
    })
    this.uniformBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  }

  render(passEncoder, { srcColorTexture, srcDepthTexture, uvScaleX, uvScaleY, depthEps, srcNear, srcFar, dstNear, dstFar }) {
    const data = new Float32Array(16)
    data[0] = depthEps != null ? depthEps : 2e-6
    data[4] = uvScaleX; data[5] = uvScaleY
    data[8] = srcNear; data[9] = srcFar
    data[12] = dstNear; data[13] = dstFar
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data)
    if (this._bindGroupTex0 !== srcColorTexture || this._bindGroupTex1 !== srcDepthTexture) {
      this.bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: srcColorTexture.createView() },
          { binding: 1, resource: this.colorSampler },
          { binding: 2, resource: srcDepthTexture.createView() },
          { binding: 3, resource: this.depthSampler },
          { binding: 4, resource: { buffer: this.uniformBuffer } },
        ],
      })
      this._bindGroupTex0 = srcColorTexture
      this._bindGroupTex1 = srcDepthTexture
    }
    passEncoder.setPipeline(this.pipeline)
    passEncoder.setBindGroup(0, this.bindGroup)
    passEncoder.draw(3, 1, 0, 0)
  }
}

export async function readBackDepthF32(device, texture, width, height) {
  const unpaddedBytesPerRow = width * 4
  const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256
  const bufferSize = bytesPerRow * height
  const readBuf = device.createBuffer({ label: 'vdrs-depth-readback', size: bufferSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const encoder = device.createCommandEncoder({ label: 'vdrs-depth-readback-encoder' })
  encoder.copyTextureToBuffer({ texture }, { buffer: readBuf, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: 1 })
  device.queue.submit([encoder.finish()])
  await readBuf.mapAsync(GPUMapMode.READ)
  const mapped = new Float32Array(readBuf.getMappedRange().slice(0))
  readBuf.unmap()
  readBuf.destroy()
  if (bytesPerRow === unpaddedBytesPerRow) return mapped
  const rowFloats = width
  const strideFloats = bytesPerRow / 4
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const srcOff = y * strideFloats
    out.set(mapped.subarray(srcOff, srcOff + rowFloats), y * rowFloats)
  }
  return out
}
