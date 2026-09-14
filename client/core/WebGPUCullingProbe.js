export async function probeWebGPU() {
  const detail = { apiSurface: false, adapter: false, device: false, limits: null, error: null }
  try {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      detail.error = 'navigator.gpu undefined (no WebGPU implementation in this browser)'
      return { supported: false, detail }
    }
    detail.apiSurface = true

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) {
      detail.error = 'requestAdapter() resolved null (WebGPU present but no usable adapter)'
      return { supported: false, detail }
    }
    detail.adapter = true
    detail.adapterInfo = adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description } : null

    const device = await adapter.requestDevice()
    if (!device) {
      detail.error = 'requestDevice() resolved null'
      return { supported: false, detail }
    }
    detail.device = true
    detail.limits = {
      maxComputeWorkgroupsPerDimension: device.limits.maxComputeWorkgroupsPerDimension,
      maxComputeWorkgroupSizeX: device.limits.maxComputeWorkgroupSizeX,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      maxBufferSize: device.limits.maxBufferSize,
    }
    device.destroy()
    return { supported: true, detail }
  } catch (e) {
    detail.error = 'probe threw: ' + (e && e.message || e)
    return { supported: false, detail }
  }
}

const CULL_WGSL = `
struct Instance {
  centerX: f32, centerY: f32, centerZ: f32, radius: f32,
};

struct Plane { a: f32, b: f32, c: f32, d: f32 };

@group(0) @binding(0) var<storage, read> instances: array<Instance>;
@group(0) @binding(1) var<storage, read> planes: array<Plane, 6>;
@group(0) @binding(2) var<storage, read_write> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read_write> visibleCount: atomic<u32>;
@group(0) @binding(4) var<storage, read_write> visFlags: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&instances)) { return; }
  let inst = instances[i];
  var inside = true;
  for (var p = 0u; p < 6u; p = p + 1u) {
    let pl = planes[p];
    let dist = pl.a * inst.centerX + pl.b * inst.centerY + pl.c * inst.centerZ + pl.d;
    if (dist < -inst.radius) { inside = false; }
  }
  if (inside) {
    let slot = atomicAdd(&visibleCount, 1u);
    visibleIndices[slot] = i;
    visFlags[i] = 1u;
  } else {
    visFlags[i] = 0u;
  }
}
`

export function extractFrustumPlanes(m) {
  const planes = []
  const unnormalizedPlanesLeftRightBottomTopNearFar = [
    [m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]],
    [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],
    [m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]],
    [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],
    [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]],
    [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],
  ]
  for (const [a, b, c, d] of unnormalizedPlanesLeftRightBottomTopNearFar) {
    const len = Math.hypot(a, b, c) || 1
    planes.push([a / len, b / len, c / len, d / len])
  }
  return planes
}

export async function runComputeCullingPoC(instances, viewProjection) {
  if (typeof navigator === 'undefined' || !navigator.gpu) throw new Error('WebGPU not available')
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('no WebGPU adapter')
  const device = await adapter.requestDevice()

  const n = instances.length
  const instanceData = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    instanceData[i * 4 + 0] = instances[i].x
    instanceData[i * 4 + 1] = instances[i].y
    instanceData[i * 4 + 2] = instances[i].z
    instanceData[i * 4 + 3] = instances[i].radius
  }
  const planeArr = extractFrustumPlanes(viewProjection)
  const planeData = new Float32Array(6 * 4)
  for (let p = 0; p < 6; p++) planeData.set(planeArr[p], p * 4)

  const mkBuf = (data, usage) => {
    const buf = device.createBuffer({ size: data.byteLength, usage, mappedAtCreation: true })
    new Float32Array(buf.getMappedRange()).set(data)
    buf.unmap()
    return buf
  }

  const instanceBuf = mkBuf(instanceData, GPUBufferUsage.STORAGE)
  const planeBuf = mkBuf(planeData, GPUBufferUsage.STORAGE)
  const visibleIndicesBuf = device.createBuffer({ size: Math.max(4, n * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
  const visibleCountBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(visibleCountBuf, 0, new Uint32Array([0]))
  const visFlagsBuf = device.createBuffer({ size: Math.max(4, n * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })

  const module = device.createShaderModule({ code: CULL_WGSL })
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } })
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: instanceBuf } },
      { binding: 1, resource: { buffer: planeBuf } },
      { binding: 2, resource: { buffer: visibleIndicesBuf } },
      { binding: 3, resource: { buffer: visibleCountBuf } },
      { binding: 4, resource: { buffer: visFlagsBuf } },
    ],
  })

  const t0 = performance.now()
  const encoder = device.createCommandEncoder()
  const pass = encoder.beginComputePass()
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bindGroup)
  pass.dispatchWorkgroups(Math.ceil(n / 64))
  pass.end()

  const readCountBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const readIndicesBuf = device.createBuffer({ size: Math.max(4, n * 4), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const readFlagsBuf = device.createBuffer({ size: Math.max(4, n * 4), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  encoder.copyBufferToBuffer(visibleCountBuf, 0, readCountBuf, 0, 4)
  encoder.copyBufferToBuffer(visibleIndicesBuf, 0, readIndicesBuf, 0, Math.max(4, n * 4))
  encoder.copyBufferToBuffer(visFlagsBuf, 0, readFlagsBuf, 0, Math.max(4, n * 4))
  device.queue.submit([encoder.finish()])
  await device.queue.onSubmittedWorkDone()
  const gpuMs = performance.now() - t0

  await readCountBuf.mapAsync(GPUMapMode.READ)
  const visibleCount = new Uint32Array(readCountBuf.getMappedRange())[0]
  readCountBuf.unmap()

  await readIndicesBuf.mapAsync(GPUMapMode.READ)
  const visibleIndices = Array.from(new Uint32Array(readIndicesBuf.getMappedRange().slice(0, visibleCount * 4)))
  readIndicesBuf.unmap()

  await readFlagsBuf.mapAsync(GPUMapMode.READ)
  const visFlags = Array.from(new Uint32Array(readFlagsBuf.getMappedRange().slice(0, n * 4)))
  readFlagsBuf.unmap()

  device.destroy()
  return { visibleCount, visibleIndices, visFlags, gpuMs, totalInstances: n }
}

if (typeof window !== 'undefined') {
  window.__webgpuCullingProbe = { probeWebGPU, runComputeCullingPoC, extractFrustumPlanes }
}
