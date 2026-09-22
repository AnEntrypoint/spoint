import { TERRAIN_COMPOSEHEIGHT_WGSL } from './terrain-composeheight-wgsl.js'

const BINDINGS_MARKER = '@group(0) @binding(0)'
const COMPOSEHEIGHT_LIB_WGSL = TERRAIN_COMPOSEHEIGHT_WGSL.slice(0, TERRAIN_COMPOSEHEIGHT_WGSL.indexOf(BINDINGS_MARKER))

export const THC_BAKE_RES = 130

export const TERRAIN_HEIGHTBAKE_WGSL = COMPOSEHEIGHT_LIB_WGSL + `
@group(0) @binding(0) var<uniform> paramsU: vec4<u32>;
@group(0) @binding(1) var<uniform> scalarA: vec4<f32>;
@group(0) @binding(2) var<uniform> scalarB: vec4<f32>;
@group(0) @binding(3) var<uniform> basis: array<vec4<f32>, 3>;
@group(0) @binding(4) var<uniform> bakeFrame: mat3x3<f32>;
@group(0) @binding(5) var<uniform> bakeOffset: vec4<f32>;
@group(0) @binding(6) var<storage, read> hpfPool: array<f32>;
@group(0) @binding(7) var<storage, read> sculptTex: array<f32>;
@group(0) @binding(8) var outTex: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn bakeMain(@builtin(global_invocation_id) gid: vec3<u32>) {
  let res = paramsU.x;
  if (gid.x >= res || gid.y >= res) {
    return;
  }
  let resF = f32(res);
  let defRadius = scalarB.z;
  let uv = vec2<f32>(f32(gid.x), f32(gid.y)) / max(resF - 1.0, 1.0);
  let p = uv * bakeOffset.z + bakeOffset.xy;
  let faceLocal = defRadius * tan((p / defRadius) * 0.7853981634);
  let dir0 = normalize(bakeFrame * vec3<f32>(faceLocal, defRadius));
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
  textureStore(outTex, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(h, 0.0, 0.0, 1.0));
}
`

export function supportsHeightBakeCompute(device) {
  return !!device && typeof device.createComputePipeline === 'function' && typeof device.createShaderModule === 'function'
}

export function createHeightBakePipeline(device) {
  const module = device.createShaderModule({ code: TERRAIN_HEIGHTBAKE_WGSL, label: 'mapspinner-height-bake-compute' })
  return device.createComputePipeline({
    label: 'mapspinner-height-bake-pipeline',
    layout: 'auto',
    compute: { module, entryPoint: 'bakeMain' },
  })
}

export function bakeHeightTileTexture(device, faceFrame, bakeOffset, opts, pipeline) {
  if (!(faceFrame instanceof Float32Array) || faceFrame.length !== 9) {
    throw new TypeError('bakeHeightTileTexture: faceFrame must be a Float32Array of length 9')
  }
  if (!(bakeOffset instanceof Float32Array) || bakeOffset.length !== 4) {
    throw new TypeError('bakeHeightTileTexture: bakeOffset must be a Float32Array of length 4 (ox, oy, l, level)')
  }
  const p = pipeline || createHeightBakePipeline(device)
  const o = opts || {}
  const res = o.res || THC_BAKE_RES
  const hpfRes = o.hpfRes | 0
  const sculptRes = o.sculptRes | 0
  const hpfPool = o.hpfPool instanceof Float32Array ? o.hpfPool : new Float32Array(6 * hpfRes * hpfRes * 4)
  const sculptTex = o.sculptTex instanceof Float32Array ? o.sculptTex : new Float32Array(Math.max(1, sculptRes * sculptRes))
  const landBias = o.landBias || 0
  const beachShelfM = o.beachShelfM || 0
  const sculptActive = o.sculptActive || 0
  const sculptExtent = o.sculptExtent || 0
  const sculptCenter = o.sculptCenter || [0, 0]
  const defRadius = o.defRadius || 0
  const up = o.up || [0, 1, 0]
  const east = o.east || [1, 0, 0]
  const north = o.north || [0, 0, 1]

  const reliefScale = o.reliefScale != null ? o.reliefScale : defRadius / 63600000.0
  const paramsBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const paramsBytes = new ArrayBuffer(16)
  new Uint32Array(paramsBytes).set([res, hpfRes, sculptRes, 0])
  new Float32Array(paramsBytes)[3] = reliefScale
  device.queue.writeBuffer(paramsBuf, 0, paramsBytes)

  const scalarABuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(scalarABuf, 0, new Float32Array([landBias, beachShelfM, sculptActive, sculptExtent]).buffer)

  const scalarBBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(scalarBBuf, 0, new Float32Array([sculptCenter[0], sculptCenter[1], defRadius, 0]).buffer)

  const basisBuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(basisBuf, 0, new Float32Array([
    up[0], up[1], up[2], 0,
    east[0], east[1], east[2], 0,
    north[0], north[1], north[2], 0,
  ]).buffer)

  const frameBuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(frameBuf, 0, new Float32Array([
    faceFrame[0], faceFrame[1], faceFrame[2], 0,
    faceFrame[3], faceFrame[4], faceFrame[5], 0,
    faceFrame[6], faceFrame[7], faceFrame[8], 0,
  ]).buffer)

  const offsetBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(offsetBuf, 0, bakeOffset)

  const hpfBuf = device.createBuffer({ size: Math.max(4, hpfPool.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, mappedAtCreation: true })
  new Float32Array(hpfBuf.getMappedRange()).set(hpfPool)
  hpfBuf.unmap()

  const sculptBuf = device.createBuffer({ size: Math.max(4, sculptTex.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, mappedAtCreation: true })
  new Float32Array(sculptBuf.getMappedRange()).set(sculptTex)
  sculptBuf.unmap()

  const outTex = device.createTexture({
    label: 'mapspinner-height-bake-tile',
    size: { width: res, height: res, depthOrArrayLayers: 1 },
    format: 'r32float',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  })

  const bindGroup = device.createBindGroup({
    layout: p.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsBuf } },
      { binding: 1, resource: { buffer: scalarABuf } },
      { binding: 2, resource: { buffer: scalarBBuf } },
      { binding: 3, resource: { buffer: basisBuf } },
      { binding: 4, resource: { buffer: frameBuf } },
      { binding: 5, resource: { buffer: offsetBuf } },
      { binding: 6, resource: { buffer: hpfBuf } },
      { binding: 7, resource: { buffer: sculptBuf } },
      { binding: 8, resource: outTex.createView() },
    ],
  })

  const encoder = device.createCommandEncoder({ label: 'mapspinner-height-bake-encoder' })
  const pass = encoder.beginComputePass({ label: 'mapspinner-height-bake-pass' })
  pass.setPipeline(p)
  pass.setBindGroup(0, bindGroup)
  const wg = Math.ceil(res / 8)
  pass.dispatchWorkgroups(wg, wg)
  pass.end()
  device.queue.submit([encoder.finish()])

  paramsBuf.destroy()
  scalarABuf.destroy()
  scalarBBuf.destroy()
  basisBuf.destroy()
  frameBuf.destroy()
  offsetBuf.destroy()
  hpfBuf.destroy()
  sculptBuf.destroy()

  return outTex
}

export async function readHeightTileTexture(device, texture, res) {
  const bytesPerRow = Math.ceil((res * 4) / 256) * 256
  const stagingBuf = device.createBuffer({
    size: bytesPerRow * res,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  })
  const encoder = device.createCommandEncoder({ label: 'mapspinner-height-bake-readback-encoder' })
  encoder.copyTextureToBuffer(
    { texture },
    { buffer: stagingBuf, bytesPerRow, rowsPerImage: res },
    { width: res, height: res, depthOrArrayLayers: 1 },
  )
  device.queue.submit([encoder.finish()])
  await stagingBuf.mapAsync(GPUMapMode.READ)
  const raw = new Float32Array(stagingBuf.getMappedRange().slice(0))
  stagingBuf.unmap()
  stagingBuf.destroy()
  const floatsPerRow = bytesPerRow / 4
  const out = new Float32Array(res * res)
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      out[y * res + x] = raw[y * floatsPerRow + x]
    }
  }
  return out
}

export async function bakeHeightTileReadback(device, faceFrame, bakeOffset, opts, pipeline) {
  const res = (opts && opts.res) || THC_BAKE_RES
  const tex = bakeHeightTileTexture(device, faceFrame, bakeOffset, opts, pipeline)
  const heights = await readHeightTileTexture(device, tex, res)
  tex.destroy()
  return { heights, res }
}
