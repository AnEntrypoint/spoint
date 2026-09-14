import * as THREE from 'three';
import { IndirectStorageBufferAttribute } from 'three/webgpu';
import {
  HZB_SEED_WGSL, HZB_REDUCE_WGSL, CULL_LOD_WGSL,
  CLUSTER_STRIDE_BYTES, INDIRECT_STRIDE_BYTES, flattenClusters
} from './webgpu-hiz-shaders.js';

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const HZB_WORKGROUP_DIM = 8;
const CULL_WORKGROUP_SIZE = 64;
const FRAME_PARAMS_FLOATS = 48;

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
    this._hzbMips = [];
    this._hzbLevels = 0;
    this._hzbW = 0;
    this._hzbH = 0;
    this._meshBuffers = new Map();
    this.stats = { levels: 0, queried: 0, occluded: 0, supported: false, drawsWritten: 0 };
  }

  supported() {
    const r = this.renderer;
    if (!r || !r.isWebGPURenderer) return false;
    const backend = r.backend;
    if (!backend || backend.isWebGPUBackend !== true) return false;
    const device = backend.device;
    if (!device || typeof device.createComputePipeline !== 'function') return false;
    this._device = device;
    this.stats.supported = true;
    return true;
  }

  _ensurePipelines() {
    if (this._pipelinesReady) return;
    const device = this._device;
    const seedMod = compileShaderModule(device, 'hzb-seed', HZB_SEED_WGSL);
    const reduceMod = compileShaderModule(device, 'hzb-reduce', HZB_REDUCE_WGSL);
    const cullMod = compileShaderModule(device, 'cluster-cull-lod', CULL_LOD_WGSL);

    this._seedPipeline = device.createComputePipeline({
      label: 'hzb-seed-pipeline',
      layout: 'auto',
      compute: { module: seedMod, entryPoint: 'main' },
    });
    this._reducePipeline = device.createComputePipeline({
      label: 'hzb-reduce-pipeline',
      layout: 'auto',
      compute: { module: reduceMod, entryPoint: 'main' },
    });
    this._cullPipeline = device.createComputePipeline({
      label: 'cluster-cull-lod-pipeline',
      layout: 'auto',
      compute: { module: cullMod, entryPoint: 'main' },
    });
    this._pipelinesReady = true;
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
    for (const m of this._hzbMips) { m.texture.destroy(); }
    this._hzbMips.length = 0;
    this._hzbW = width; this._hzbH = height;
    let w = width, h = height;
    for (;;) {
      const texture = device.createTexture({
        size: { width: w, height: h },
        format: 'r32float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this._hzbMips.push({ texture, view: texture.createView(), w, h });
      if (w === 1 && h === 1) break;
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
    }
    this._hzbLevels = this._hzbMips.length;
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

    const indirectBuf = device.createBuffer({
      size: Math.max(1, n) * INDIRECT_STRIDE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    const countBuf = device.createBuffer({
      size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    const rec = { clusterSet, clusterBuf, indirectBuf, countBuf, n, lod0Count: mesh.lod0Count };
    this._meshBuffers.set(mesh, rec);
    return rec;
  }

  unregisterClusterMesh(mesh) {
    const rec = this._meshBuffers.get(mesh);
    if (!rec) return;
    rec.clusterBuf.destroy();
    rec.indirectBuf.destroy();
    rec.countBuf.destroy();
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

    const screenHeight = opts.screenHeight || 1080;
    const tanHalf = camera.isPerspectiveCamera ? Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) : 1;
    const hyst = opts.hysteresis != null ? opts.hysteresis : 0.15;
    const thresholds = mesh.lodThresholds || [120, 40];

    const fp = new Float32Array(FRAME_PARAMS_FLOATS);
    fp.set(_m.elements, 0);
    fp.set(mesh.matrixWorld.elements, 16);
    _v.setFromMatrixPosition(camera.matrixWorld);
    fp[32] = _v.x; fp[33] = _v.y; fp[34] = _v.z; fp[35] = 0;
    const hystUp = 1 + hyst;
    const hystDown = 1 - hyst;
    fp[36] = screenHeight;
    fp[37] = tanHalf * tanHalf;
    fp[38] = hystUp;
    fp[39] = hystDown;
    fp[40] = thresholds[0] || 120;
    fp[41] = thresholds[1] || 40;
    const fpU32 = new Uint32Array(fp.buffer);
    fpU32[42] = rec.n;
    fpU32[43] = opts.baseVertex || 0;
    fpU32[44] = opts.firstInstance || 0;
    fpU32[45] = this._hzbLevels;
    fp[46] = this._hzbW || 1;
    fp[47] = this._hzbH || 1;

    if (!rec.frameBuf) {
      rec.frameBuf = device.createBuffer({ size: fp.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    device.queue.writeBuffer(rec.frameBuf, 0, fp.buffer, fp.byteOffset, fp.byteLength);
    device.queue.writeBuffer(rec.countBuf, 0, new Uint32Array([0]).buffer);

    const hzbView = this._hzbMips.length ? this._hzbMips[0].view : null;
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
        { binding: 5, resource: rec.dummySampler },
      ],
    });

    const encoder = device.createCommandEncoder({ label: 'cluster-cull-lod' });
    const pass = encoder.beginComputePass({ label: 'cluster-cull-lod-pass' });
    pass.setPipeline(this._cullPipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(rec.n / CULL_WORKGROUP_SIZE), 1, 1);
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

  runQueries(camera, candidates) {
    if (!this.supported()) { this.stats.queried = 0; this.stats.occluded = 0; return; }
    this.stats.queried = 0;
    for (let i = 0; i < candidates.length; i++) {
      const entity = candidates[i];
      const mesh = entity && entity._clusterLodMesh;
      if (mesh && mesh.clusterSet) this.cullAndBuildIndirect(mesh, camera);
    }
  }

  isOccluded(_entity) {
    return false;
  }

  release(mesh) {
    this.unregisterClusterMesh(mesh);
  }

  dispose() {
    for (const m of this._hzbMips) m.texture.destroy();
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
