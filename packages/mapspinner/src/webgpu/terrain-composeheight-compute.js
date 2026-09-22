import { TERRAIN_COMPOSEHEIGHT_WGSL } from './terrain-composeheight-wgsl.js'

export function supportsTerrainComposeHeightCompute(device) {
  return !!device && typeof device.createComputePipeline === 'function' && typeof device.createShaderModule === 'function'
}

export function createTerrainComposeHeightPipeline(device) {
  const module = device.createShaderModule({ code: TERRAIN_COMPOSEHEIGHT_WGSL, label: 'mapspinner-terrain-composeheight-compute' })
  return device.createComputePipeline({
    label: 'mapspinner-terrain-composeheight-pipeline',
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  })
}

export async function computeTerrainComposeHeights(device, directions, opts, pipeline) {
  if (!(directions instanceof Float32Array) || directions.length % 3 !== 0) {
    throw new TypeError('computeTerrainComposeHeights: directions must be a Float32Array of length n*3')
  }
  const n = directions.length / 3
  if (n === 0) return new Float32Array(0)
  const p = pipeline || createTerrainComposeHeightPipeline(device)

  const o = opts || {}
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

  const dirBuf = device.createBuffer({
    size: directions.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  })
  new Float32Array(dirBuf.getMappedRange()).set(directions)
  dirBuf.unmap()

  const outBuf = device.createBuffer({
    size: n * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  })

  const hpfBuf = device.createBuffer({
    size: Math.max(4, hpfPool.byteLength),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  })
  new Float32Array(hpfBuf.getMappedRange()).set(hpfPool)
  hpfBuf.unmap()

  const sculptBuf = device.createBuffer({
    size: Math.max(4, sculptTex.byteLength),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  })
  new Float32Array(sculptBuf.getMappedRange()).set(sculptTex)
  sculptBuf.unmap()

  const paramsBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(paramsBuf, 0, new Uint32Array([n, hpfRes, sculptRes, 0]).buffer)

  const scalarABuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(scalarABuf, 0, new Float32Array([landBias, beachShelfM, sculptActive, sculptExtent]).buffer)

  const scalarBBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(scalarBBuf, 0, new Float32Array([sculptCenter[0], sculptCenter[1], defRadius, 0]).buffer)

  const basisBuf = device.createBuffer({
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(basisBuf, 0, new Float32Array([
    up[0], up[1], up[2], 0,
    east[0], east[1], east[2], 0,
    north[0], north[1], north[2], 0,
  ]).buffer)

  const bindGroup = device.createBindGroup({
    layout: p.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsBuf } },
      { binding: 1, resource: { buffer: scalarABuf } },
      { binding: 2, resource: { buffer: scalarBBuf } },
      { binding: 3, resource: { buffer: basisBuf } },
      { binding: 4, resource: { buffer: dirBuf } },
      { binding: 5, resource: { buffer: outBuf } },
      { binding: 6, resource: { buffer: hpfBuf } },
      { binding: 7, resource: { buffer: sculptBuf } },
    ],
  })

  const stagingBuf = device.createBuffer({
    size: n * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  })

  const encoder = device.createCommandEncoder({ label: 'mapspinner-terrain-composeheight-encoder' })
  const pass = encoder.beginComputePass({ label: 'mapspinner-terrain-composeheight-pass' })
  pass.setPipeline(p)
  pass.setBindGroup(0, bindGroup)
  pass.dispatchWorkgroups(Math.ceil(n / 64))
  pass.end()
  encoder.copyBufferToBuffer(outBuf, 0, stagingBuf, 0, n * 4)
  device.queue.submit([encoder.finish()])

  await stagingBuf.mapAsync(GPUMapMode.READ)
  const result = new Float32Array(stagingBuf.getMappedRange().slice(0))
  stagingBuf.unmap()

  dirBuf.destroy()
  outBuf.destroy()
  hpfBuf.destroy()
  sculptBuf.destroy()
  paramsBuf.destroy()
  scalarABuf.destroy()
  scalarBBuf.destroy()
  basisBuf.destroy()
  stagingBuf.destroy()

  return result
}
