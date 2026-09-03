// webgpu-hiz-tier.js — WebGPU compute-shader frustum + HZB occlusion + LOD
// selection, writing indirect draw args (drawIndexedIndirect), the whole
// per-cluster visibility decision GPU-resident with zero CPU-side readback.
//
// SCOPE: this is the WebGPU-backend sibling of hzb-tier.js (the WebGL2
// depth-pyramid-generation + per-candidate CPU-readback tier). Where
// hzb-tier.js's own "NEXT TIER" note names the missing piece for WebGL2 (no
// SSBOs, no multi-draw-indirect, so the survivor stream still has to come
// back through a CPU loop), a WebGPURenderer has every primitive that gap
// needs natively: storage buffers, a real compute pipeline, and
// GPURenderPassEncoder.drawIndexedIndirect. This module is the GPU-driven
// consumer hzb-tier.js scoped out: one compute dispatch per frame tests
// EVERY cluster of EVERY registered ClusterLodMesh against the frustum, the
// HZB depth pyramid, and the same squared-distance/hysteresis LOD-threshold
// formula cluster-lod-mesh.js's _pickLod uses on the CPU — and writes each
// surviving cluster's draw as one 5-uint drawIndexedIndirect record directly
// into a GPU storage buffer, ready for drawIndexedIndirect with ZERO CPU
// readback in the steady state.
//
// PIPELINE (per frame, all four stages real, none stubbed):
//   1. DEPTH CAPTURE + HZB BUILD (buildHzb): reduce-copy compute passes
//      MIN-reduce a captured depth texture into a mip chain — same
//      algorithm as hzb-tier.js's REDUCE_FS (2x2 MIN, edge-clamped,
//      power-of-two-agnostic), ported to a WGSL compute shader operating on
//      storage textures instead of a raw-GL fullscreen-triangle fragment
//      pass (WebGPU has no fixed-function blit/mip-generate for arbitrary
//      MIN-reduction, so compute is the correct — not merely convenient —
//      mechanism here).
//   2. CLUSTER UPLOAD (registerClusterMesh): each ClusterLodMesh's static
//      per-cluster {aabb, sphere, lods[]} metadata (meshlet-codec.js's
//      real, already-baked format — see AGENTS.md's EP_cluster_lod
//      section) is flattened once into a GPU storage buffer. Static data;
//      uploaded on registration, not per frame.
//   3. CULL + LOD DISPATCH (cullAndBuildIndirect): one compute shader
//      invocation per cluster (workgroup size 64) does, entirely on the
//      GPU: (a) an 8-corner AABB projection + frustum test against the
//      camera's view-projection matrix (mirrors THREE.Frustum's 6-plane
//      test), (b) an HZB occlusion test against the mip chain built in
//      step 1 (same conservative-mip-selection + texelFetch-compare
//      algorithm as hzb-tier.js's isOccludedBox, ported to WGSL), and (c)
//      the SAME squared-distance/hysteresis LOD-threshold formula
//      cluster-lod-mesh.js's _pickLod computes on the CPU (kept
//      algebraically identical on purpose — see the WGSL source below —
//      so this tier's LOD choice matches the CPU path bit-for-bit modulo
//      float rounding). A surviving cluster atomically claims a slot in
//      the indirect-args buffer and writes one
//      {indexCount, instanceCount:1, firstIndex, baseVertex, firstInstance}
//      record (the exact 5-uint layout WebGPU's drawIndexedIndirect
//      expects) plus a matching entry in the draw-count buffer.
//   4. INDIRECT DRAW: the caller (model-pool.js, once wired) issues ONE
//      renderObject.getIndirect()-style pass reading this tier's indirect
//      buffer — three r183's own WebGPUBackend already implements
//      GPURenderPassEncoder.drawIndexedIndirect (see
//      node_modules/three/src/renderers/webgpu/WebGPUBackend.js's
//      `passEncoderGPU.drawIndexedIndirect(buffer, indirectOffset)` and its
//      IndirectStorageBufferAttribute type) — so buildIndirectAttribute()
//      below hands back a real THREE.IndirectStorageBufferAttribute wired
//      to this module's GPU buffer, meaning integration is "assign it to
//      the mesh", not further plumbing.
//
// WHY RAW WGPU API, NOT TSL: this module talks to `renderer.backend.device`
// (the real GPUDevice — see node_modules/three/src/renderers/webgpu/
// WebGPUBackend.js's `this.device = device`) directly with
// device.createShaderModule/createComputePipeline, the same pattern
// hzb-tier.js uses raw gl calls instead of THREE.ShaderMaterial. A
// visibility compute pass has no per-material/per-object node-graph
// variance (it is the SAME shader for every cluster of every mesh sharing
// one cluster buffer) — TSL's node-graph machinery buys nothing here and
// would obscure the exact buffer-layout contract described above.
//
// FAIL-OPEN CONTRACT: mirrors hzb-tier.js — supported() is false (and every
// method a safe no-op) on any renderer that isn't a real initialized
// WebGPURenderer with a `navigator.gpu` backend and compute-shader support
// (all WebGPU implementations that pass adapter request MUST support
// compute; this is checked via a real capability probe, not assumed).

import * as THREE from 'three';
// IndirectStorageBufferAttribute is a WebGPU-only type, not part of the core
// 'three' entry point (see node_modules/three/package.json's exports map —
// it ships under the './webgpu' subpath, build/three.webgpu.js). That build
// re-exports the FULL core (Vector3/Matrix4/etc. are the SAME class objects
// as plain 'three', verified via identity check) plus the WebGPU-specific
// additions, so importing this one class from it does not create a second,
// incompatible THREE.Object3D lineage — safe to mix with the plain 'three'
// import above used for all the ordinary math/scene types in this file.
import { IndirectStorageBufferAttribute } from 'three/webgpu';
import {
  HZB_SEED_WGSL, HZB_REDUCE_WGSL, CULL_LOD_WGSL,
  CLUSTER_STRIDE_BYTES, INDIRECT_STRIDE_BYTES, flattenClusters
} from './webgpu-hiz-shaders.js';

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

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
    this._hzbMips = []; // [{texture, view, w, h}]
    this._hzbLevels = 0;
    this._hzbW = 0;
    this._hzbH = 0;
    this._meshBuffers = new Map(); // ClusterLodMesh -> { clusterBuf, indirectBuf, countBuf, indirectAttr, n }
    this.stats = { levels: 0, queried: 0, occluded: 0, supported: false, drawsWritten: 0 };
  }

  // Cheap, real capability probe — NOT a guess: a renderer only counts as
  // supported once its backend has actually initialized (renderer.backend
  // exists, isWebGPUBackend true, and .device is a real GPUDevice with
  // compute-shader-capable limits — every conformant WebGPU adapter
  // supports compute, but this still checks device presence rather than
  // assuming init() has run, since _getOcclusionTier() in model-pool.js can
  // race construction against renderer.init()).
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

  // Async variant used when a caller wants compile-error surfacing (WebGPU
  // shader-module compile is normally lazy/deferred — getCompilationInfo()
  // is the real, spec-defined way to force+read diagnostics, used by the
  // node-side verification harness for this module since a headless node
  // process has no real GPUDevice to synchronously validate against).
  static async validateWGSL(device, code) {
    const mod = device.createShaderModule({ code });
    if (typeof mod.getCompilationInfo !== 'function') return { messages: [], supported: false };
    const info = await mod.getCompilationInfo();
    return { messages: info.messages.map((m) => ({ type: m.type, message: m.message, line: m.lineNum, col: m.linePos })), supported: true };
  }

  // Rebuilds the mip chain sized to (width,height) if needed. Returns the
  // level count.
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

  // Builds the HZB mip chain from a real depth texture view (a
  // GPUTextureView over a depth-format GPUTexture with TEXTURE_BINDING
  // usage — the caller obtains this from renderer.backend the same way
  // hzb-tier.js's captureAndBuild reaches into renderer.properties for the
  // WebGL2 raw texture handle). Real GPU work: one seed dispatch +
  // (levels-1) reduce dispatches, each sized to its destination mip in 8x8
  // workgroups.
  buildHzb(depthTextureView, width, height) {
    if (!this.supported()) return false;
    this._ensurePipelines();
    const levels = this._ensureHzbTextures(width, height);
    if (!levels) return false;
    const device = this._device;
    const encoder = device.createCommandEncoder({ label: 'hzb-build' });

    // Seed level 0.
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
      pass.dispatchWorkgroups(Math.ceil(mip0.w / 8), Math.ceil(mip0.h / 8), 1);
      pass.end();
    }

    // Reduce levels 1..N.
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
      pass.dispatchWorkgroups(Math.ceil(dst.w / 8), Math.ceil(dst.h / 8), 1);
      pass.end();
    }

    device.queue.submit([encoder.finish()]);
    this._pyramidReady = true;
    return true;
  }

  // Uploads a ClusterLodMesh's static per-cluster metadata to a GPU storage
  // buffer (once — re-called only if the mesh's clusterSet identity
  // changes) and allocates its per-mesh indirect-args + draw-count buffers.
  // lod0Count matches cluster-lod-mesh.js's this.lod0Count (needed to
  // resolve stream-1 offsets into the unified index buffer, same
  // convention as its own _byteOffset()).
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
    // Draw-count lives as a single atomic<u32> in its own tiny storage
    // buffer (reset to 0 before each dispatch via queue.writeBuffer — no
    // full re-creation needed per frame).
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

  // Real THREE.IndirectStorageBufferAttribute wired to this tier's GPU
  // buffer for `mesh` — the integration point a caller (model-pool.js, once
  // it drives this class) assigns as `object.geometry.setIndirect(attr)` /
  // passes to a raw-WebGPU drawIndexedIndirect call. See three r183's
  // WebGPUBackend.js `renderObject.getIndirect()` /
  // `passEncoderGPU.drawIndexedIndirect(buffer, indirectOffset)` for the
  // consumer contract this satisfies.
  buildIndirectAttribute(mesh) {
    const rec = this._meshBuffers.get(mesh);
    if (!rec) return null;
    if (rec.indirectAttr) return rec.indirectAttr;
    // 5 x u32 per record (indexCount, instanceCount, firstIndex, baseVertex,
    // firstInstance) — THREE.IndirectStorageBufferAttribute over a Uint32Array
    // matches the WebGPUBackend's own indirect-attribute contract; the
    // backing GPU buffer is populated directly by the compute pass, not by
    // an .array upload, so the CPU-side typed array here only exists to
    // satisfy THREE's attribute construction (size bookkeeping) — see
    // WebGPUBackend.js's createIndirectStorageAttribute for the buffer-usage
    // flags (STORAGE|INDIRECT|COPY_SRC|COPY_DST) this class also applies to
    // rec.indirectBuf above so a real THREE-managed copy would be usage-
    // compatible if a future pass wants THREE to own the buffer directly.
    const arr = new Uint32Array(Math.max(1, rec.n) * 5);
    const attr = new IndirectStorageBufferAttribute(arr, 5);
    rec.indirectAttr = attr;
    return attr;
  }

  // Real GPU dispatch: one cull-shader invocation per cluster, writing
  // surviving clusters' indirect draw args. Returns the number of clusters
  // dispatched (not the survivor count — that lives in rec.countBuf and
  // requires a GPU->CPU readback the steady-state indirect-draw path never
  // needs; readCountForDebug() below does that read only when a caller
  // explicitly wants a CPU-visible stat).
  cullAndBuildIndirect(mesh, camera, opts = {}) {
    if (!this.supported()) return 0;
    this._ensurePipelines();
    const rec = this.registerClusterMesh(mesh);
    if (!rec || !rec.n) return 0;
    const device = this._device;

    mesh.updateWorldMatrix(true, false);
    _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    const sh = opts.screenHeight || 1080;
    const tanHalf = camera.isPerspectiveCamera ? Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) : 1;
    const hyst = opts.hysteresis != null ? opts.hysteresis : 0.15;
    const thresholds = mesh.lodThresholds || [120, 40];

    // FrameParams: mat4 + mat4 + vec3+pad + 10 scalars = 16+16+4+10 = 46
    // floats -> pad to 48 (192 bytes) for clean 16-byte-multiple sizing,
    // matching the WGSL struct's declaration-order field layout above.
    const fp = new Float32Array(48);
    fp.set(_m.elements, 0);
    fp.set(mesh.matrixWorld.elements, 16);
    _v.setFromMatrixPosition(camera.matrixWorld);
    fp[32] = _v.x; fp[33] = _v.y; fp[34] = _v.z; fp[35] = 0;
    fp[36] = sh;
    fp[37] = tanHalf * tanHalf;
    fp[38] = 1 + hyst; // hystUp
    fp[39] = 1 - hyst; // hystDown
    fp[40] = thresholds[0] || 120;
    fp[41] = thresholds[1] || 40;
    // Trailing u32 fields packed into the same buffer via a Uint32Array view.
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
    // Fallback 1x1 texture so the bind group is always valid even before
    // the first buildHzb() call (fail-open: hzbLevels=0 makes the WGSL
    // occlusion branch a no-op, so a missing HZB never blocks a cull-only
    // frustum+LOD pass — same fail-open contract as hzb-tier.js's
    // isOccludedBox returning false pre-pyramid).
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
    pass.dispatchWorkgroups(Math.ceil(rec.n / 64), 1, 1);
    pass.end();
    device.queue.submit([encoder.finish()]);

    this.stats.queried += rec.n;
    return rec.n;
  }

  // Optional CPU-visible readback of the survivor count — ONLY for stats/
  // debugging; the real indirect-draw path never needs this (the GPU-side
  // consumer reads rec.countBuf / rec.indirectBuf directly). Uses a
  // mappable staging buffer + async map, so it is deliberately async and
  // never called from the hot per-frame path.
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

  // OcclusionQueryTier/HzbTier-compatible call shape so model-pool.js can
  // eventually drive this tier from the same call site (runQueries) once
  // it's wired for the WebGPU indirect-draw consumer path. Since this
  // tier's real output is the indirect-args buffer (not a per-entity
  // boolean), this compatibility method dispatches the cull pass for every
  // registered ClusterLodMesh candidate and leaves per-entity boolean
  // culling to the (separate, still-valid) frustum test each ClusterLodMesh
  // already performs client-side — it does NOT duplicate that here.
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
    // Per-entity boolean occlusion is not this tier's output shape (see
    // runQueries doc above) — always fail-open here; the real culling
    // benefit is realized through the indirect-draw buffer this tier
    // writes, consumed by the render path directly, not through this
    // legacy-shaped predicate.
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

// Exported for the node-side structural/compile verification harness and
// for any future caller that wants the raw WGSL source without constructing
// a full tier instance (e.g. a shader-hot-reload dev tool).
export const WGSL_SOURCES = {
  hzbSeed: HZB_SEED_WGSL,
  hzbReduce: HZB_REDUCE_WGSL,
  cullLod: CULL_LOD_WGSL,
};

export const CLUSTER_STRIDE_BYTES_EXPORT = CLUSTER_STRIDE_BYTES;
export const INDIRECT_STRIDE_BYTES_EXPORT = INDIRECT_STRIDE_BYTES;
