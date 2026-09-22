import { TERRAIN_HEIGHT_WGSL } from './terrain-height-wgsl.js'

export function supportsTerrainHeightCompute(device) {
  return !!device && typeof device.createComputePipeline === 'function' && typeof device.createShaderModule === 'function'
}

export function createTerrainHeightPipeline(device) {
  const module = device.createShaderModule({ code: TERRAIN_HEIGHT_WGSL, label: 'mapspinner-terrain-height-compute' })
  return device.createComputePipeline({
    label: 'mapspinner-terrain-height-pipeline',
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  })
}

export async function computeTerrainHeights(device, directions, pipeline) {
  if (!(directions instanceof Float32Array) || directions.length % 3 !== 0) {
    throw new TypeError('computeTerrainHeights: directions must be a Float32Array of length n*3')
  }
  const n = directions.length / 3
  if (n === 0) return new Float32Array(0)
  const p = pipeline || createTerrainHeightPipeline(device)

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

  const paramsBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(paramsBuf, 0, new Uint32Array([n, 0, 0, 0]).buffer)

  const bindGroup = device.createBindGroup({
    layout: p.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: dirBuf } },
      { binding: 1, resource: { buffer: outBuf } },
      { binding: 2, resource: { buffer: paramsBuf } },
    ],
  })

  const stagingBuf = device.createBuffer({
    size: n * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  })

  const encoder = device.createCommandEncoder({ label: 'mapspinner-terrain-height-encoder' })
  const pass = encoder.beginComputePass({ label: 'mapspinner-terrain-height-pass' })
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
  paramsBuf.destroy()
  stagingBuf.destroy()

  return result
}
