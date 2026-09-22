import { TERRAIN_COMPOSEHEIGHT_WGSL } from './terrain-composeheight-wgsl.js'

export function supportsGroundProbeCompute(device) {
  return !!device && typeof device.createComputePipeline === 'function' && typeof device.createBuffer === 'function'
}

export async function createGroundProbePipeline(device) {
  const module = device.createShaderModule({ code: TERRAIN_COMPOSEHEIGHT_WGSL, label: 'mapspinner-ground-probe-compute' })
  return device.createComputePipelineAsync({
    label: 'mapspinner-ground-probe-pipeline',
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  })
}

export class GroundProbe {
  constructor(device, pipeline, opts) {
    if (!supportsGroundProbeCompute(device)) throw new TypeError('GroundProbe requires a GPUDevice')
    if (!pipeline) throw new TypeError('GroundProbe requires an already-created compute pipeline (see createGroundProbePipeline)')
    this.device = device
    this.pipeline = pipeline

    const o = opts || {}
    this.hpfRes = o.hpfRes | 0
    this.sculptRes = o.sculptRes | 0
    const hpfPool = o.hpfPool instanceof Float32Array ? o.hpfPool : new Float32Array(6 * this.hpfRes * this.hpfRes * 4)
    const sculptTex = o.sculptTex instanceof Float32Array ? o.sculptTex : new Float32Array(Math.max(1, this.sculptRes * this.sculptRes))
    this.landBias = o.landBias || 0
    this.beachShelfM = o.beachShelfM || 0
    this.sculptActive = o.sculptActive || 0
    this.sculptExtent = o.sculptExtent || 0
    this.sculptCenter = o.sculptCenter || [0, 0]
    this.defRadius = o.defRadius || 0
    this.up = o.up || [0, 1, 0]
    this.east = o.east || [1, 0, 0]
    this.north = o.north || [0, 0, 1]

    this.dirBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.outBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })

    this.hpfBuf = device.createBuffer({ size: Math.max(4, hpfPool.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, mappedAtCreation: true })
    new Float32Array(this.hpfBuf.getMappedRange()).set(hpfPool)
    this.hpfBuf.unmap()

    this.sculptBuf = device.createBuffer({ size: Math.max(4, sculptTex.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, mappedAtCreation: true })
    new Float32Array(this.sculptBuf.getMappedRange()).set(sculptTex)
    this.sculptBuf.unmap()

    this.paramsBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(this.paramsBuf, 0, new Uint32Array([1, this.hpfRes, this.sculptRes, 0]).buffer)

    this.scalarABuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.scalarBBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.basisBuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this._writeScalars()

    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuf } },
        { binding: 1, resource: { buffer: this.scalarABuf } },
        { binding: 2, resource: { buffer: this.scalarBBuf } },
        { binding: 3, resource: { buffer: this.basisBuf } },
        { binding: 4, resource: { buffer: this.dirBuf } },
        { binding: 5, resource: { buffer: this.outBuf } },
        { binding: 6, resource: { buffer: this.hpfBuf } },
        { binding: 7, resource: { buffer: this.sculptBuf } },
      ],
    })

    this._staleStaging = [
      device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    ]
    this._staleBusy = [false, false]
    this._staleRing = 0
    this._staleLastM = null

    this._exactStaging = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    this._exactChain = Promise.resolve()
  }

  _writeScalars() {
    const device = this.device
    device.queue.writeBuffer(this.scalarABuf, 0, new Float32Array([this.landBias, this.beachShelfM, this.sculptActive, this.sculptExtent]).buffer)
    device.queue.writeBuffer(this.scalarBBuf, 0, new Float32Array([this.sculptCenter[0], this.sculptCenter[1], this.defRadius, 0]).buffer)
    device.queue.writeBuffer(this.basisBuf, 0, new Float32Array([
      this.up[0], this.up[1], this.up[2], 0,
      this.east[0], this.east[1], this.east[2], 0,
      this.north[0], this.north[1], this.north[2], 0,
    ]).buffer)
  }

  setBasis(up, east, north, defRadius) {
    this.up = up
    this.east = east
    this.north = north
    if (defRadius !== undefined) this.defRadius = defRadius
    this._writeScalars()
  }

  _dispatchInto(dir, staging) {
    const device = this.device
    const pl = Math.hypot(dir[0], dir[1], dir[2]) || 1
    device.queue.writeBuffer(this.dirBuf, 0, new Float32Array([dir[0] / pl, dir[1] / pl, dir[2] / pl, 0]).buffer)
    const encoder = device.createCommandEncoder({ label: 'mapspinner-ground-probe-encoder' })
    const pass = encoder.beginComputePass({ label: 'mapspinner-ground-probe-pass' })
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.bindGroup)
    pass.dispatchWorkgroups(1)
    pass.end()
    encoder.copyBufferToBuffer(this.outBuf, 0, staging, 0, 4)
    device.queue.submit([encoder.finish()])
  }

  sampleStale(dir) {
    const idx = this._staleRing
    if (!this._staleBusy[idx]) {
      this._staleBusy[idx] = true
      const staging = this._staleStaging[idx]
      this._dispatchInto(dir, staging)
      staging.mapAsync(GPUMapMode.READ).then(() => {
        this._staleLastM = new Float32Array(staging.getMappedRange())[0]
        staging.unmap()
        this._staleBusy[idx] = false
      }).catch(() => { this._staleBusy[idx] = false })
      this._staleRing = (idx + 1) % this._staleStaging.length
    }
    return this._staleLastM
  }

  sampleExact(dir) {
    const staging = this._exactStaging
    const run = () => {
      this._dispatchInto(dir, staging)
      return staging.mapAsync(GPUMapMode.READ).then(() => {
        const v = new Float32Array(staging.getMappedRange())[0]
        staging.unmap()
        return v
      })
    }
    const result = this._exactChain.then(run, run)
    this._exactChain = result.catch(() => {})
    return result
  }

  destroy() {
    this.dirBuf.destroy()
    this.outBuf.destroy()
    this.hpfBuf.destroy()
    this.sculptBuf.destroy()
    this.paramsBuf.destroy()
    this.scalarABuf.destroy()
    this.scalarBBuf.destroy()
    this.basisBuf.destroy()
    for (const s of this._staleStaging) s.destroy()
    this._exactStaging.destroy()
  }
}

export async function createGroundProbe(device, opts) {
  const pipeline = (opts && opts.pipeline) || await createGroundProbePipeline(device)
  return new GroundProbe(device, pipeline, opts)
}
