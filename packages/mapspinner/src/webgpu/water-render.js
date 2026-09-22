import { MapspinnerPipelineCache, TERRAIN_PATCH_VERTEX_BUFFERS } from './pipeline-cache.js'
import { buildGridGeometry, buildInstanceData, createBufferWithData } from './patch-grid-render.js'

const WATER_WGSL = `
struct WaterParams {
  defRadius: f32,
  oceanTime: f32,
  oceanAmp: f32,
  oceanChoppy: f32,
}
@group(0) @binding(0) var<uniform> waterParams: WaterParams;
@group(0) @binding(1) var sceneSampler: sampler;
@group(0) @binding(2) var sceneTex: texture_2d<f32>;
struct ResolutionU {
  resolution: vec2<f32>,
  pad: vec2<f32>,
}
@group(0) @binding(3) var<uniform> resU: ResolutionU;

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

fn seaHash(p: vec2<f32>) -> f32 {
  let q = vec2<u32>(vec2<i32>(p)) * vec2<u32>(1597334673u, 3812015801u);
  let n = (q.x ^ q.y) * 1597334673u;
  return f32(n) * (1.0 / 4294967296.0);
}

fn seaNoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  var f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(seaHash(i), seaHash(i + vec2<f32>(1.0,0.0)), f.x),
             mix(seaHash(i + vec2<f32>(0.0,1.0)), seaHash(i + vec2<f32>(1.0,1.0)), f.x), f.y);
}

fn seaOctave(uvIn: vec2<f32>, choppy: f32) -> f32 {
  let uv = uvIn + seaNoise(uvIn);
  let wv0 = 1.0 - abs(sin(uv));
  let swv = abs(cos(uv));
  let wv = mix(wv0, swv, wv0);
  return pow(1.0 - pow(wv.x * wv.y, 0.65), choppy);
}

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uvSwell: vec2<f32>,
}

@vertex
fn vs_main(
  @location(0) vertex: vec3<f32>,
  @location(1) iOffset: vec4<f32>,
  @location(2) iFace: f32,
  @location(3) iLayer: f32,
) -> VSOut {
  let defRadius = waterParams.defRadius;
  let localToWorld = faceFrame(iFace);
  let absLocal = iOffset.xy + vertex.xy * iOffset.z;
  let faceLocal = patchFaceWarp(absLocal, defRadius);
  let dir0 = normalize(localToWorld * vec3<f32>(faceLocal, defRadius));

  let refAxisW = select(vec3<f32>(1.0,0.0,0.0), vec3<f32>(0.0,1.0,0.0), abs(dir0.y) < 0.99);
  let uxW = normalize(cross(refAxisW, dir0));
  let uyW = cross(dir0, uxW);
  let swellTime = vec2<f32>(waterParams.oceanTime * 0.72, waterParams.oceanTime * 0.48);
  let swellP = vec2<f32>(dot(dir0, uxW), dot(dir0, uyW)) * defRadius;
  let d0 = vec2<f32>(0.866, 0.5);
  let d1 = vec2<f32>(-0.5, 0.866);
  let swell = (seaOctave(swellP * 0.016 + d0 * swellTime.x, waterParams.oceanChoppy)
             + seaOctave(swellP * 0.016 + d1 * swellTime.y, waterParams.oceanChoppy)) * 0.5;
  let hR = (swell - 0.5) * 0.8 * waterParams.oceanAmp;

  let vRel = (dir0 - frame.camDir) * defRadius + dir0 * hR - frame.camDir * frame.camAlt;
  var out: VSOut;
  out.pos = frame.viewProjNoEye * vec4<f32>(vRel, 1.0);
  out.uvSwell = swellP * 0.016;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let screenUV = in.pos.xy / resU.resolution;
  let ripple = vec2<f32>(sin(in.uvSwell.x * 6.2831853 + in.uvSwell.y * 3.0), cos(in.uvSwell.y * 6.2831853)) * 0.006;
  let refracted = clamp(screenUV + ripple, vec2<f32>(0.001, 0.001), vec2<f32>(0.999, 0.999));
  let scene = textureSample(sceneTex, sceneSampler, refracted).rgb;
  let waterTint = vec3<f32>(0.05, 0.22, 0.38);
  let outColor = mix(scene, waterTint, 0.55);
  return vec4<f32>(outColor, 0.75);
}
`

export function createSceneCopyTexture(device, width, height, format) {
  return device.createTexture({
    size: { width: Math.max(1, width | 0), height: Math.max(1, height | 0), depthOrArrayLayers: 1 },
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
}

export function captureSceneCopy(encoder, sourceTexture, destTexture, width, height) {
  encoder.copyTextureToTexture(
    { texture: sourceTexture },
    { texture: destTexture },
    { width: Math.max(1, width | 0), height: Math.max(1, height | 0), depthOrArrayLayers: 1 },
  )
}

export class WaterOcclusionProbe {
  constructor(device) {
    this.device = device
    this.querySet = device.createQuerySet({ type: 'occlusion', count: 1 })
    this.resolveBuffer = device.createBuffer({ size: 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
    this.stagingBuffers = [
      device.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      device.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    ]
    this._stagingBusy = [false, false]
    this._ring = 0
    this.lastSampleCount = 0n
  }

  resolve(encoder) {
    encoder.resolveQuerySet(this.querySet, 0, 1, this.resolveBuffer, 0)
    const idx = this._ring
    if (this._stagingBusy[idx]) return -1
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.stagingBuffers[idx], 0, 8)
    this._ring = (this._ring + 1) % this.stagingBuffers.length
    return idx
  }

  async read(idx) {
    if (idx < 0) return this.lastSampleCount
    const buf = this.stagingBuffers[idx]
    this._stagingBusy[idx] = true
    await buf.mapAsync(GPUMapMode.READ)
    const arr = new BigUint64Array(buf.getMappedRange().slice(0))
    buf.unmap()
    this._stagingBusy[idx] = false
    this.lastSampleCount = arr[0]
    return this.lastSampleCount
  }
}

export class WaterRenderer {
  constructor(device, opts = {}) {
    this.device = device
    this.gridSize = opts.gridSize || 16
    this.colorFormat = opts.colorFormat || 'bgra8unorm'
    this.depthFormat = opts.depthFormat || 'depth24plus'
    this.pipelineCache = opts.pipelineCache || new MapspinnerPipelineCache(device)
    this.mainStateKey = opts.mainStateKey || 'water-blended-cull-front'
    this.frameUniformBuffer = opts.frameUniformBuffer

    const geo = buildGridGeometry(this.gridSize)
    this.indexCount = geo.indices.length
    this.gridVertexBuffer = createBufferWithData(device, geo.vertices, GPUBufferUsage.VERTEX)
    this.gridIndexBuffer = createBufferWithData(device, geo.indices, GPUBufferUsage.INDEX)

    this.waterParamsBuffer = createBufferWithData(device, new Float32Array([
      opts.defRadius || 6360000, 0, opts.oceanAmp != null ? opts.oceanAmp : 1.0, opts.oceanChoppy != null ? opts.oceanChoppy : 0.5,
    ]), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
    this.resolutionBuffer = createBufferWithData(device, new Float32Array([
      opts.width || 1, opts.height || 1, 0, 0,
    ]), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    this.sceneTexture = opts.sceneTexture

    this.mainPipeline = this.pipelineCache.getPipeline(this.mainStateKey, {
      vertexCode: WATER_WGSL,
      fragmentCode: WATER_WGSL,
      colorFormat: this.colorFormat,
      depthFormat: this.depthFormat,
      vertexBuffers: TERRAIN_PATCH_VERTEX_BUFFERS,
      label: 'water-render-main',
    })
    this.visProbePipeline = this.pipelineCache.getPipeline('water-vis-probe', {
      vertexCode: WATER_WGSL,
      fragmentCode: WATER_WGSL,
      colorFormat: this.colorFormat,
      depthFormat: this.depthFormat,
      vertexBuffers: TERRAIN_PATCH_VERTEX_BUFFERS,
      label: 'water-render-visprobe',
    })

    this.mainBindGroups = this._makeBindGroups(this.mainPipeline)
    this.visProbeBindGroups = this._makeBindGroups(this.visProbePipeline)

    this.instanceBuffer = null
    this.instanceCapacity = 0
    this._quadsRef = null
    this._instanceCount = 0
  }

  _makeBindGroups(pipeline) {
    const bindGroup0 = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.waterParamsBuffer } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: this.sceneTexture.createView() },
        { binding: 3, resource: { buffer: this.resolutionBuffer } },
      ],
    })
    const bindGroup1 = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [{ binding: 0, resource: { buffer: this.frameUniformBuffer } }],
    })
    return { bindGroup0, bindGroup1 }
  }

  setSceneTexture(sceneTexture) {
    this.sceneTexture = sceneTexture
    this.mainBindGroups = this._makeBindGroups(this.mainPipeline)
    this.visProbeBindGroups = this._makeBindGroups(this.visProbePipeline)
  }

  updateOceanParams({ defRadius, oceanTime, oceanAmp, oceanChoppy }) {
    const data = new Float32Array(4)
    data[0] = defRadius
    data[1] = oceanTime
    data[2] = oceanAmp
    data[3] = oceanChoppy
    this.device.queue.writeBuffer(this.waterParamsBuffer, 0, data)
  }

  updateResolution(width, height) {
    this.device.queue.writeBuffer(this.resolutionBuffer, 0, new Float32Array([width, height, 0, 0]))
  }

  _ensureInstanceBuffer(quads) {
    if (quads === this._quadsRef) return
    const data = buildInstanceData(quads)
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

  _bindDraw(passEncoder, pipeline, bindGroups) {
    passEncoder.setPipeline(pipeline)
    passEncoder.setBindGroup(0, bindGroups.bindGroup0)
    passEncoder.setBindGroup(1, bindGroups.bindGroup1)
    passEncoder.setVertexBuffer(0, this.gridVertexBuffer)
    passEncoder.setVertexBuffer(1, this.instanceBuffer)
    passEncoder.setIndexBuffer(this.gridIndexBuffer, 'uint32')
    passEncoder.drawIndexed(this.indexCount, this._instanceCount)
  }

  renderVisProbe(passEncoder, quads, occlusionProbe) {
    if (quads.length === 0) return
    this._ensureInstanceBuffer(quads)
    passEncoder.beginOcclusionQuery(0)
    this._bindDraw(passEncoder, this.visProbePipeline, this.visProbeBindGroups)
    passEncoder.endOcclusionQuery()
  }

  render(passEncoder, quads) {
    if (quads.length === 0) return
    this._ensureInstanceBuffer(quads)
    this._bindDraw(passEncoder, this.mainPipeline, this.mainBindGroups)
  }
}

export { WATER_WGSL }
