const COLOR_WRITE_ALL = 0xF
const COLOR_WRITE_NONE = 0x0

const BLEND_SRC_ALPHA_OVER = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}
const BLEND_ONE_OVER = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}

export const TERRAIN_PATCH_VERTEX_BUFFERS = [
  { arrayStride: 12, stepMode: 'vertex', attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
  ] },
  { arrayStride: 24, stepMode: 'instance', attributes: [
    { shaderLocation: 1, offset: 0, format: 'float32x4' },
    { shaderLocation: 2, offset: 16, format: 'float32' },
    { shaderLocation: 3, offset: 20, format: 'float32' },
  ] },
]

export const STATE_DESCRIPTORS = {
  'sky-depth-tested': { hasDepth: true, depthWrite: false, depthCompare: 'less-equal', cullMode: 'none', blend: null, colorWrite: COLOR_WRITE_ALL },
  'sky-no-depth': { hasDepth: false, cullMode: 'none', blend: null, colorWrite: COLOR_WRITE_ALL },
  'fullscreen-blit': { hasDepth: false, cullMode: 'none', blend: null, colorWrite: COLOR_WRITE_ALL },
  'depth-writeback-colormask-off': { hasDepth: true, depthWrite: true, depthCompare: 'always', cullMode: 'none', blend: null, colorWrite: COLOR_WRITE_NONE },
  'depth-writeback-colormask-on': { hasDepth: true, depthWrite: true, depthCompare: 'always', cullMode: 'none', blend: null, colorWrite: COLOR_WRITE_ALL },
  'terrain-opaque-cull-none': { hasDepth: true, depthWrite: true, depthCompare: 'less', cullMode: 'none', blend: null, colorWrite: COLOR_WRITE_ALL },
  'terrain-opaque-cull-front': { hasDepth: true, depthWrite: true, depthCompare: 'less', cullMode: 'front', blend: null, colorWrite: COLOR_WRITE_ALL },
  'terrain-opaque-cull-back': { hasDepth: true, depthWrite: true, depthCompare: 'less', cullMode: 'back', blend: null, colorWrite: COLOR_WRITE_ALL },
  'water-vis-probe': { hasDepth: true, depthWrite: false, depthCompare: 'always', cullMode: 'none', blend: null, colorWrite: COLOR_WRITE_NONE },
  'water-underwater': { hasDepth: true, depthWrite: true, depthCompare: 'less', cullMode: 'none', blend: null, colorWrite: COLOR_WRITE_ALL },
  'water-blended-cull-front': { hasDepth: true, depthWrite: false, depthCompare: 'less', cullMode: 'front', blend: BLEND_SRC_ALPHA_OVER, colorWrite: COLOR_WRITE_ALL },
  'water-blended-cull-off': { hasDepth: true, depthWrite: false, depthCompare: 'less', cullMode: 'none', blend: BLEND_SRC_ALPHA_OVER, colorWrite: COLOR_WRITE_ALL },
  'water-depth-share-cull-front': { hasDepth: true, depthWrite: true, depthCompare: 'less', cullMode: 'front', blend: null, colorWrite: COLOR_WRITE_NONE },
  'water-depth-share-cull-off': { hasDepth: true, depthWrite: true, depthCompare: 'less', cullMode: 'none', blend: null, colorWrite: COLOR_WRITE_NONE },
  'hrw-composite': { hasDepth: false, cullMode: 'none', blend: BLEND_ONE_OVER, colorWrite: COLOR_WRITE_ALL },
  'probe-draw': { hasDepth: false, cullMode: 'none', blend: null, colorWrite: COLOR_WRITE_ALL },
  'bake-tile': { hasDepth: false, cullMode: 'none', blend: null, colorWrite: COLOR_WRITE_ALL },
}

export function supportsPipelineCache(renderer) {
  const backend = renderer && renderer.backend
  return !!backend && backend.isWebGPUBackend === true && !!backend.device && typeof backend.device.createRenderPipeline === 'function'
}

export class MapspinnerPipelineCache {
  constructor(device) {
    if (!device || typeof device.createRenderPipeline !== 'function') {
      throw new TypeError('MapspinnerPipelineCache requires a GPUDevice')
    }
    this.device = device
    this._pipelines = new Map()
    this._modules = new Map()
  }

  _shaderModule(code, label) {
    let mod = this._modules.get(code)
    if (!mod) {
      mod = this.device.createShaderModule({ code, label })
      this._modules.set(code, mod)
    }
    return mod
  }

  getPipeline(stateKey, opts) {
    const state = STATE_DESCRIPTORS[stateKey]
    if (!state) throw new Error(`MapspinnerPipelineCache: unknown state key '${stateKey}'`)
    if (!opts || typeof opts.vertexCode !== 'string' || typeof opts.fragmentCode !== 'string') {
      throw new TypeError('MapspinnerPipelineCache.getPipeline requires opts.vertexCode and opts.fragmentCode')
    }
    const vertexEntryPoint = opts.vertexEntryPoint || 'vs_main'
    const fragmentEntryPoint = opts.fragmentEntryPoint || 'fs_main'
    const colorFormat = opts.colorFormat || 'bgra8unorm'
    const depthFormat = opts.depthFormat || 'depth24plus'
    const topology = opts.topology || 'triangle-list'
    const vertexBuffers = opts.vertexBuffers || TERRAIN_PATCH_VERTEX_BUFFERS
    const shaderId = opts.shaderId || (opts.vertexCode + '::' + opts.fragmentCode)
    const cacheKey = [stateKey, shaderId, colorFormat, state.hasDepth ? depthFormat : 'nodepth', topology].join('|')

    const cached = this._pipelines.get(cacheKey)
    if (cached) return cached

    const vertexModule = this._shaderModule(opts.vertexCode, (opts.label || stateKey) + '-vs')
    const fragmentModule = this._shaderModule(opts.fragmentCode, (opts.label || stateKey) + '-fs')

    const descriptor = {
      label: opts.label || stateKey,
      layout: opts.layout || 'auto',
      vertex: { module: vertexModule, entryPoint: vertexEntryPoint, buffers: vertexBuffers },
      fragment: {
        module: fragmentModule,
        entryPoint: fragmentEntryPoint,
        targets: [{ format: colorFormat, blend: state.blend || undefined, writeMask: state.colorWrite }],
      },
      primitive: { topology, cullMode: state.cullMode, frontFace: 'ccw' },
    }
    if (state.hasDepth) {
      descriptor.depthStencil = { format: depthFormat, depthWriteEnabled: state.depthWrite, depthCompare: state.depthCompare }
    }

    const pipeline = this.device.createRenderPipeline(descriptor)
    this._pipelines.set(cacheKey, pipeline)
    return pipeline
  }

  get size() { return this._pipelines.size }

  clear() {
    this._pipelines.clear()
    this._modules.clear()
  }
}

export function createPipelineCache(renderer) {
  if (!supportsPipelineCache(renderer)) {
    throw new Error('mapspinner pipeline-cache: renderer has no usable WebGPU device')
  }
  return new MapspinnerPipelineCache(renderer.backend.device)
}
