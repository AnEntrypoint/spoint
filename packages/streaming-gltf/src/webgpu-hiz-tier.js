import * as THREE from 'three';
import { IndirectStorageBufferAttribute } from 'three/webgpu';
import {
  HZB_SEED_WGSL, HZB_REDUCE_WGSL, CULL_LOD_WGSL,
  CLUSTER_STRIDE_BYTES, INDIRECT_STRIDE_BYTES, MAX_LOD_SLOTS, flattenClusters
} from './webgpu-hiz-shaders.js';

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _size = new THREE.Vector2();
const HZB_WORKGROUP_DIM = 8;
const CULL_WORKGROUP_SIZE = 64;
const FRAME_PARAMS_FLOATS = 52;
const MAX_THRESHOLD_SLOTS = 2;
const PIPELINE_ERROR_SCOPE = 'validation';

export class WebGPUPipelineError extends Error {
  constructor(label, message) {
    super(`[webgpu-pipeline] "${label}" is invalid: ${message}`);
    this.name = 'WebGPUPipelineError';
    this.reasonCode = 'webgpu-pipeline-invalid';
    this.pipelineLabel = label;
  }
}

// WebGPU does NOT throw when a descriptor is bad or a shader fails to compile: it
// hands back an INVALID pipeline object whose every dispatch writes nothing, which
// reads as a threshold-tuning bug rather than a build failure. A validation error
// scope around the creation is the only way to learn the truth.
export function createPipelineScoped(device, kind, desc) {
  const label = (desc && desc.label) || kind;
  const scoped = typeof device.pushErrorScope === 'function' && typeof device.popErrorScope === 'function';
  if (scoped) device.pushErrorScope(PIPELINE_ERROR_SCOPE);
  let pipeline = null;
  let thrown = null;
  let popped = null;
  try {
    pipeline = kind === 'render' ? device.createRenderPipeline(desc) : device.createComputePipeline(desc);
    popped = scoped ? device.popErrorScope() : null;
  } catch (err) {
    thrown = err;
    if (scoped && popped === null) popped = device.popErrorScope();
  }
  const verdict = Promise.resolve(popped).then((err) => err || null);
  return { label, kind, pipeline, thrown, scoped, verdict };
}

function _drawingBufferHeight(renderer) {
  if (!renderer || typeof renderer.getDrawingBufferSize !== 'function') return 0;
  const sz = renderer.getDrawingBufferSize(_size);
  return sz && sz.y > 0 ? sz.y : 0;
}

function compileShaderModule(device, label, code) {
  return device.createShaderModule({ code, label });
}

export class WebGpuHizTier {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.minCandidates = opts.minCandidates ?? 64;
    this._device = null;
    this._pipelinesReady = false;
    this._seedPipeline = null;
    this._reducePipeline = null;
    this._cullPipeline = null;
    this._pipelineInit = null;
    this._pipelineError = null;
    this._hzbMips = [];
    this._hzbTex = null;
    this._hzbView = null;
    this._hzbLevels = 0;
    this._hzbW = 0;
    this._hzbH = 0;
    this._meshBuffers = new Map();
    this.stats = { levels: 0, queried: 0, occluded: 0, supported: false, drawsWritten: 0, skippedNoPyramid: 0, lodSlotOverflow: 0, pipelinesValidated: 0, pipelineRefusals: 0 };
  }

  supported() {
    // Once a pipeline has been refused this tier is dead: dispatching on an invalid
    // pipeline writes zero indirect draws, which is indistinguishable from "everything
    // was culled", so `false` here is the refusal, not a probe that failed.
    if (this._pipelineError) { this.stats.supported = false; return false; }
    const r = this.renderer;
    if (!r || !r.isWebGPURenderer) return false;
    const backend = r.backend;
    if (!backend || backend.isWebGPUBackend !== true) return false;
    const device = backend.device;
    if (!device || typeof device.createComputePipeline !== 'function') return false;
    this._device = device;
    this.stats.supported = true;
    // Build at the first probe rather than at the first dispatch, so a shader that
    // does not compile is known before anything is asked to draw.
    this._ensurePipelines();
    return true;
  }

  _refuseInvalidPipelines() {
    if (!this._pipelineError) return;
    this.stats.pipelineRefusals++;
    throw this._pipelineError;
  }

  // Awaitable form of `_ensurePipelines`: resolves once every pipeline is known
  // valid, throws WebGPUPipelineError on the first one that is not. Callers that
  // build the tier at init await this and never install a dead tier.
  async ensurePipelinesValidated() {
    if (!this._device) throw new WebGPUPipelineError('device', 'no WebGPU device; supported() was never true');
    this._ensurePipelines();
    await this._pipelineInit;
    this._refuseInvalidPipelines();
    return this.stats.pipelinesValidated;
  }

  _settlePipelines(results) {
    let valid = 0;
    for (const r of results) if (!r.error && !r.thrown && r.pipeline) valid++;
    this.stats.pipelinesValidated = valid;
    if (valid === results.length) {
      this._pipelinesReady = true;
      return true;
    }
    const bad = results.find((r) => r.error || r.thrown || !r.pipeline);
    const detail = bad.thrown
      ? (bad.thrown.message || String(bad.thrown))
      : ((bad.error && (bad.error.message || String(bad.error))) || 'no pipeline object returned');
    this._pipelineError = new WebGPUPipelineError(bad.label, detail);
    this._pipelinesReady = false;
    this.stats.supported = false;
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error(`[webgpu-pipeline] "${bad.label}" failed validation (${valid}/${results.length} valid) -- the HiZ cull refuses to dispatch: ${detail}`);
    }
    return false;
  }

  _ensurePipelines() {
    this._refuseInvalidPipelines();
    if (this._pipelineInit) return;
    const device = this._device;
    const seedMod = compileShaderModule(device, 'hzb-seed', HZB_SEED_WGSL);
    const reduceMod = compileShaderModule(device, 'hzb-reduce', HZB_REDUCE_WGSL);
    const cullMod = compileShaderModule(device, 'cluster-cull-lod', CULL_LOD_WGSL);

    const built = [
      createPipelineScoped(device, 'compute', { label: 'hzb-seed-pipeline', layout: 'auto', compute: { module: seedMod, entryPoint: 'main' } }),
      createPipelineScoped(device, 'compute', { label: 'hzb-reduce-pipeline', layout: 'auto', compute: { module: reduceMod, entryPoint: 'main' } }),
      createPipelineScoped(device, 'compute', { label: 'cluster-cull-lod-pipeline', layout: 'auto', compute: { module: cullMod, entryPoint: 'main' } }),
      createPipelineScoped(device, 'compute', { label: 'cluster-cull-fallback-pipeline', layout: 'auto', compute: { module: cullMod, entryPoint: 'fallbackMain' } }),
    ];
    this._seedPipeline = built[0].pipeline;
    this._reducePipeline = built[1].pipeline;
    this._cullPipeline = built[2].pipeline;
    this._fallbackPipeline = built[3].pipeline;
    this.stats.pipelinesValidated = 0;
    this._pipelineInit = Promise.all(built.map((b) => b.verdict.then((error) => ({ label: b.label, pipeline: b.pipeline, thrown: b.thrown, error }))))
      .then((results) => this._settlePipelines(results));
  }

  static async validateWGSL(device, code) {
    const mod = device.createShaderModule({ code });
    if (typeof mod.getCompilationInfo !== 'function') return { messages: [], supported: false };
    const info = await mod.getCompilationInfo();
    return { messages: info.messages.map((m) => ({ type: m.type, message: m.message, line: m.lineNum, col: m.linePos })), supported: true };
  }

  _ensureHzbTextures(width, height) {
    const device = this._device;
    width = Math.max(1, width | 0);
    height = Math.max(1, height | 0);
    if (this._hzbW === width && this._hzbH === height && this._hzbMips.length) return this._hzbMips.length;
    if (this._hzbTex) { this._hzbTex.destroy(); this._hzbTex = null; this._hzbView = null; }
    this._hzbMips.length = 0;
    this._hzbW = width; this._hzbH = height;
    // WebGPU derives mip sizes as max(1, w >> level), so the CPU chain must use the
    // same floor rule or `_hzbLevels` stops matching the texture it indexes.
    const dims = [];
    let w = width, h = height;
    for (;;) {
      dims.push({ w, h });
      if (w === 1 && h === 1) break;
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    const levels = dims.length;
    // One texture, one mip chain. The cull samples an arbitrary level with
    // textureLoad, which a per-level (mipLevelCount 1) view cannot serve.
    this._hzbTex = device.createTexture({
      label: 'hzb-pyramid',
      size: { width, height },
      format: 'r32float',
      mipLevelCount: levels,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._hzbView = this._hzbTex.createView({ baseMipLevel: 0, mipLevelCount: levels });
    for (let i = 0; i < levels; i++) {
      this._hzbMips.push({
        view: this._hzbTex.createView({ baseMipLevel: i, mipLevelCount: 1 }),
        w: dims[i].w, h: dims[i].h,
      });
    }
    this._hzbLevels = levels;
    this.stats.levels = this._hzbLevels;
    return this._hzbLevels;
  }

  buildHzb(depthTextureView, width, height) {
    if (!this.supported()) return false;
    this._ensurePipelines();
    const levels = this._ensureHzbTextures(width, height);
    if (!levels) return false;
    const device = this._device;
    const encoder = device.createCommandEncoder({ label: 'hzb-build' });

    {
      const mip0 = this._hzbMips[0];
      const bg = device.createBindGroup({
        layout: this._seedPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: depthTextureView },
          { binding: 1, resource: mip0.view },
        ],
      });
      const pass = encoder.beginComputePass({ label: 'hzb-seed' });
      pass.setPipeline(this._seedPipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(mip0.w / HZB_WORKGROUP_DIM), Math.ceil(mip0.h / HZB_WORKGROUP_DIM), 1);
      pass.end();
    }

    for (let i = 1; i < levels; i++) {
      const src = this._hzbMips[i - 1];
      const dst = this._hzbMips[i];
      const paramsBuf = device.createBuffer({
        size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, mappedAtCreation: true,
      });
      new Uint32Array(paramsBuf.getMappedRange()).set([src.w, src.h, dst.w, dst.h]);
      paramsBuf.unmap();
      const bg = device.createBindGroup({
        layout: this._reducePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: src.view },
          { binding: 1, resource: dst.view },
          { binding: 2, resource: { buffer: paramsBuf } },
        ],
      });
      const pass = encoder.beginComputePass({ label: `hzb-reduce-${i}` });
      pass.setPipeline(this._reducePipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(dst.w / HZB_WORKGROUP_DIM), Math.ceil(dst.h / HZB_WORKGROUP_DIM), 1);
      pass.end();
    }

    device.queue.submit([encoder.finish()]);
    this._pyramidReady = true;
    return true;
  }

  registerClusterMesh(mesh) {
    if (!this.supported()) return null;
    const existing = this._meshBuffers.get(mesh);
    if (existing && existing.clusterSet === mesh.clusterSet) return existing;
    if (existing) this.unregisterClusterMesh(mesh);
    const device = this._device;
    const clusterSet = mesh.clusterSet;
    const n = clusterSet.clusters.length;
    const flat = flattenClusters(clusterSet, mesh.lod0Count);

    const clusterBuf = device.createBuffer({
      size: flat.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, mappedAtCreation: true,
    });
    new Uint8Array(clusterBuf.getMappedRange()).set(new Uint8Array(flat));
    clusterBuf.unmap();

    let overflow = 0;
    for (const c of clusterSet.clusters) if (c.lods.length > MAX_LOD_SLOTS) overflow++;
    if (overflow) this.stats.lodSlotOverflow = overflow;

    // +1 slot: the cull can emit one more draw than there are clusters when no
    // cluster survives and it falls back to the whole LOD0, like the CPU does.
    const indirectBuf = device.createBuffer({
      size: (n + 1) * INDIRECT_STRIDE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    const countBuf = device.createBuffer({
      size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    const visibleBuf = device.createBuffer({
      size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    // Last LOD index per cluster, owned by the CPU cull and re-uploaded every
    // dispatch: a GPU-side copy of that hysteresis state would drift.
    const lodStateBuf = device.createBuffer({
      size: Math.max(1, n) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const rec = { clusterSet, clusterBuf, indirectBuf, countBuf, visibleBuf, lodStateBuf, n, lod0Count: mesh.lod0Count, lodSlot: new Int32Array(Math.max(1, n)) };
    this._meshBuffers.set(mesh, rec);
    return rec;
  }

  unregisterClusterMesh(mesh) {
    const rec = this._meshBuffers.get(mesh);
    if (!rec) return;
    rec.clusterBuf.destroy();
    rec.indirectBuf.destroy();
    rec.countBuf.destroy();
    if (rec.visibleBuf) rec.visibleBuf.destroy();
    if (rec.lodStateBuf) rec.lodStateBuf.destroy();
    if (rec.frameBuf) rec.frameBuf.destroy();
    if (rec.stagingBuf) rec.stagingBuf.destroy();
    if (rec.dummyTex) rec.dummyTex.destroy();
    this._meshBuffers.delete(mesh);
  }

  buildIndirectAttribute(mesh) {
    const rec = this._meshBuffers.get(mesh);
    if (!rec) return null;
    if (rec.indirectAttr) return rec.indirectAttr;
    const arr = new Uint32Array(Math.max(1, rec.n) * 5);
    const attr = new IndirectStorageBufferAttribute(arr, 5);
    rec.indirectAttr = attr;
    return attr;
  }

  cullAndBuildIndirect(mesh, camera, opts = {}) {
    if (!this.supported()) return 0;
    this._ensurePipelines();
    const rec = this.registerClusterMesh(mesh);
    if (!rec || !rec.n) return 0;
    const device = this._device;

    mesh.updateWorldMatrix(true, false);
    _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    // Every input below mirrors ClusterLodMesh._cameraState / _pickLod. The cull is
    // only allowed to differ by the occlusion term, so screen height, tanHalf,
    // hysteresis and thresholds must be the CPU's, not local defaults.
    const screenHeight = opts.screenHeight || _drawingBufferHeight(this.renderer) || mesh._screenHeight || 1080;
    const tanHalf = camera.isPerspectiveCamera ? Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) : 1;
    const hyst = opts.hysteresis != null ? opts.hysteresis : (mesh._hyst != null ? mesh._hyst : 0.15);
    const thresholds = mesh.lodThresholds || [120, 40];
    const thresholdCount = Math.min(thresholds.length, MAX_THRESHOLD_SLOTS);

    const fp = new Float32Array(FRAME_PARAMS_FLOATS);
    fp.set(_m.elements, 0);
    fp.set(mesh.matrixWorld.elements, 16);
    _v.setFromMatrixPosition(camera.matrixWorld);
    fp[32] = _v.x; fp[33] = _v.y; fp[34] = _v.z; fp[35] = 0;
    fp[36] = screenHeight;
    fp[37] = tanHalf * tanHalf;
    fp[38] = 1 + hyst;
    fp[39] = 1 - hyst;
    fp[40] = thresholds[0] || 120;
    fp[41] = thresholds[1] || 40;
    const fpU32 = new Uint32Array(fp.buffer);
    fpU32[42] = rec.n;
    fpU32[43] = opts.baseVertex || 0;
    fpU32[44] = opts.firstInstance || 0;
    fpU32[45] = this._hzbLevels;
    fp[46] = this._hzbW || 1;
    fp[47] = this._hzbH || 1;
    fpU32[48] = thresholdCount;
    // The CPU skips the frustum test for these meshes too, so the GPU must as well.
    fpU32[49] = mesh._spointNoClusterCull ? 1 : 0;
    fpU32[50] = rec.lod0Count;
    fpU32[51] = 0;

    if (!rec.frameBuf || rec.frameBuf.size !== fp.byteLength) {
      if (rec.frameBuf) rec.frameBuf.destroy();
      rec.frameBuf = device.createBuffer({ size: fp.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    device.queue.writeBuffer(rec.frameBuf, 0, fp.buffer, fp.byteOffset, fp.byteLength);
    const zero = new Uint32Array([0]).buffer;
    device.queue.writeBuffer(rec.countBuf, 0, zero);
    device.queue.writeBuffer(rec.visibleBuf, 0, zero);

    const curLod = (mesh._lodStateIn && mesh._lodStateIn.length >= rec.n) ? mesh._lodStateIn : mesh._curLod;
    const lodSlot = rec.lodSlot;
    for (let i = 0; i < rec.n; i++) lodSlot[i] = curLod && i < curLod.length ? curLod[i] : -1;
    device.queue.writeBuffer(rec.lodStateBuf, 0, lodSlot.buffer, lodSlot.byteOffset, lodSlot.byteLength);

    const hzbView = this._hzbView || rec.dummyView;
    if (!rec.dummySampler) rec.dummySampler = device.createSampler({});
    if (!rec.dummyTex) {
      rec.dummyTex = device.createTexture({ size: { width: 1, height: 1 }, format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      rec.dummyView = rec.dummyTex.createView();
    }

    const bg = device.createBindGroup({
      layout: this._cullPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: rec.clusterBuf } },
        { binding: 1, resource: { buffer: rec.frameBuf } },
        { binding: 2, resource: { buffer: rec.indirectBuf } },
        { binding: 3, resource: { buffer: rec.countBuf } },
        { binding: 4, resource: hzbView || rec.dummyView },
        { binding: 6, resource: { buffer: rec.lodStateBuf } },
        { binding: 7, resource: { buffer: rec.visibleBuf } },
      ],
    });

    const encoder = device.createCommandEncoder({ label: 'cluster-cull-lod' });
    const pass = encoder.beginComputePass({ label: 'cluster-cull-lod-pass' });
    pass.setPipeline(this._cullPipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(rec.n / CULL_WORKGROUP_SIZE), 1, 1);
    // Second dispatch in the SAME pass: it observes main's final draw count and
    // reproduces ClusterLodMesh._render's "no cluster survived" full-LOD0 group.
    const fbBg = device.createBindGroup({
      layout: this._fallbackPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 1, resource: { buffer: rec.frameBuf } },
        { binding: 2, resource: { buffer: rec.indirectBuf } },
        { binding: 3, resource: { buffer: rec.countBuf } },
        { binding: 7, resource: { buffer: rec.visibleBuf } },
      ],
    });
    pass.setPipeline(this._fallbackPipeline);
    pass.setBindGroup(0, fbBg);
    pass.dispatchWorkgroups(1, 1, 1);
    pass.end();
    device.queue.submit([encoder.finish()]);

    this.stats.queried += rec.n;
    return rec.n;
  }

  async readCountForDebug(mesh) {
    const rec = this._meshBuffers.get(mesh);
    if (!rec) return 0;
    const device = this._device;
    if (!rec.stagingBuf) {
      rec.stagingBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    }
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(rec.countBuf, 0, rec.stagingBuf, 0, 4);
    device.queue.submit([encoder.finish()]);
    await rec.stagingBuf.mapAsync(GPUMapMode.READ);
    const count = new Uint32Array(rec.stagingBuf.getMappedRange())[0];
    rec.stagingBuf.unmap();
    this.stats.occluded = Math.max(0, rec.n - count);
    return count;
  }

  // Entities expose their cluster meshes as children of `entity.root`; there is no
  // `_clusterLodMesh` field anywhere, so looking only there found nothing.
  _clusterMeshesOf(entity) {
    if (!entity) return null;
    if (entity.clusterSet) return [entity];
    if (entity._clusterLodMesh && entity._clusterLodMesh.clusterSet) return [entity._clusterLodMesh];
    const root = entity.root || entity.object3d || null;
    if (!root) return null;
    const found = [];
    for (const c of root.children) if (c && c.clusterSet) found.push(c);
    if (!found.length) {
      for (const c of root.children) {
        c.traverse((o) => { if (o && o.clusterSet) found.push(o); });
        if (found.length) break;
      }
    }
    return found.length ? found : null;
  }

  runQueries(camera, candidates) {
    if (!this.supported()) { this.stats.queried = 0; this.stats.occluded = 0; return; }
    this.stats.queried = 0;
    // No pyramid means no occluder depth: the pass would reproduce the CPU cull and
    // nothing else, for indirect draws nobody consumes. Skip it instead of paying it.
    if (!this._hzbLevels) { this.stats.skippedNoPyramid++; return; }
    for (let i = 0; i < candidates.length; i++) {
      const meshes = this._clusterMeshesOf(candidates[i]);
      if (!meshes) continue;
      for (let k = 0; k < meshes.length; k++) {
        const mesh = meshes[k];
        if (mesh && mesh.clusterSet) this.cullAndBuildIndirect(mesh, camera);
      }
    }
  }

  isOccluded(_entity) {
    return false;
  }

  release(mesh) {
    this.unregisterClusterMesh(mesh);
  }

  dispose() {
    if (this._hzbTex) { this._hzbTex.destroy(); this._hzbTex = null; }
    this._hzbView = null;
    this._hzbMips.length = 0;
    for (const mesh of Array.from(this._meshBuffers.keys())) this.unregisterClusterMesh(mesh);
    this._pipelinesReady = false;
    this._pyramidReady = false;
  }
}

export const WGSL_SOURCES = {
  hzbSeed: HZB_SEED_WGSL,
  hzbReduce: HZB_REDUCE_WGSL,
  cullLod: CULL_LOD_WGSL,
};

export const CLUSTER_STRIDE_BYTES_EXPORT = CLUSTER_STRIDE_BYTES;
export const INDIRECT_STRIDE_BYTES_EXPORT = INDIRECT_STRIDE_BYTES;
