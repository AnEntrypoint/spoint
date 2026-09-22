import { TERRAIN_COMPOSEHEIGHT_WGSL } from './terrain-composeheight-wgsl.js'
import { MapspinnerPipelineCache, TERRAIN_PATCH_VERTEX_BUFFERS } from './pipeline-cache.js'
import { M4 } from '../gl-render-mat4.js'
import { THC_BAKE_RES, createHeightBakePipeline, bakeHeightTileTexture } from './height-bake-compute.js'

const COMPOSEHEIGHT_MARKER = '@group(0) @binding(0)'
const COMPOSEHEIGHT_FUNCTIONS_WGSL = TERRAIN_COMPOSEHEIGHT_WGSL.slice(0, TERRAIN_COMPOSEHEIGHT_WGSL.indexOf(COMPOSEHEIGHT_MARKER))

const RENDER_WGSL = COMPOSEHEIGHT_FUNCTIONS_WGSL + `
@group(0) @binding(0) var<uniform> paramsU: vec4<u32>;
@group(0) @binding(1) var<uniform> scalarA: vec4<f32>;
@group(0) @binding(2) var<uniform> scalarB: vec4<f32>;
@group(0) @binding(3) var<uniform> basis: array<vec4<f32>, 3>;
@group(0) @binding(6) var<storage, read> hpfPool: array<f32>;
@group(0) @binding(7) var<storage, read> sculptTex: array<f32>;

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

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) worldRel: vec3<f32>,
  @location(1) height: f32,
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
  let vRel = (dir0 - frame.camDir) * defRadius + dir0 * h - frame.camDir * frame.camAlt;
  var out: VSOut;
  out.pos = frame.viewProjNoEye * vec4<f32>(vRel, 1.0);
  out.worldRel = vRel;
  out.height = h;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let dx = dpdx(in.worldRel);
  let dy = dpdy(in.worldRel);
  let n = normalize(cross(dx, dy));
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
  let vRel = (dir0 - frame.camDir) * defRadius + dir0 * h - frame.camDir * frame.camAlt;
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
  const paramsU = createBufferWithData(device, new Uint32Array(paramsBuf), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
  const scalarA = createBufferWithData(device, new Float32Array([
    opts.landBias || 0, opts.beachShelfM || 150, opts.sculptActive || 0, opts.sculptExtent || 0,
  ]), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
  const sculptCenter = opts.sculptCenter || [0, 0]
  const scalarB = createBufferWithData(device, new Float32Array([sculptCenter[0], sculptCenter[1], defRadius, opts.poolRes || 0]), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
  const up = opts.sculptUp || [0, 1, 0]
  const east = opts.sculptEast || [1, 0, 0]
  const north = opts.sculptNorth || [0, 0, 1]
  const basis = createBufferWithData(device, new Float32Array([
    up[0], up[1], up[2], 0,
    east[0], east[1], east[2], 0,
    north[0], north[1], north[2], 0,
  ]), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
  const hpfFloats = 6 * hpfRes * hpfRes * 4
  const hpfPool = createBufferWithData(device, opts.hpfPoolData || new Float32Array(Math.max(hpfFloats, 4)), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
  const sculptFloats = sculptRes * sculptRes
  const sculptTex = createBufferWithData(device, opts.sculptTexData || new Float32Array(Math.max(sculptFloats, 4)), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
  return { paramsU, scalarA, scalarB, basis, hpfPool, sculptTex }
}

export function createFrameUniformBuffer(device) {
  return device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
}

export function writeFrameUniforms(device, buffer, { viewProjNoEye, camDir, camAlt }) {
  const data = new Float32Array(20)
  data.set(viewProjNoEye, 0)
  data[16] = camDir[0]; data[17] = camDir[1]; data[18] = camDir[2]
  data[19] = camAlt
  device.queue.writeBuffer(buffer, 0, data)
}

export function createDepthTexture(device, width, height, format = 'depth24plus') {
  return device.createTexture({
    size: { width, height, depthOrArrayLayers: 1 },
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  })
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
      this.pipeline = this.pipelineCache.getPipeline(this.stateKey, {
        vertexCode: RENDER_WGSL,
        fragmentCode: RENDER_WGSL,
        colorFormat: this.colorFormat,
        depthFormat: this.depthFormat,
        vertexBuffers: TERRAIN_PATCH_VERTEX_BUFFERS,
        label: 'patch-grid-render',
      })
      this.bindGroup0 = device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: p.paramsU } },
          { binding: 1, resource: { buffer: p.scalarA } },
          { binding: 2, resource: { buffer: p.scalarB } },
          { binding: 3, resource: { buffer: p.basis } },
          { binding: 6, resource: { buffer: p.hpfPool } },
          { binding: 7, resource: { buffer: p.sculptTex } },
        ],
      })
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
    passEncoder.setVertexBuffer(0, this.gridVertexBuffer)
    passEncoder.setVertexBuffer(1, this.instanceBuffer)
    passEncoder.setIndexBuffer(this.gridIndexBuffer, 'uint32')
    passEncoder.drawIndexed(this.indexCount, this._instanceCount)
  }
}

export { RENDER_WGSL, createBufferWithData, buildSampleWgsl }
