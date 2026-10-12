import * as THREE from 'three';
import { IndirectStorageBufferAttribute } from 'three/webgpu';
import {
  HZB_SEED_WGSL, HZB_SEED_MSAA_WGSL, HZB_REDUCE_WGSL, CULL_LOD_WGSL, ENTITY_HZB_WGSL,
  CLUSTER_STRIDE_BYTES, INDIRECT_STRIDE_BYTES, MAX_LOD_SLOTS,
  ENTITY_BOX_STRIDE_BYTES, ENTITY_PARAMS_BYTES, flattenClusters
} from './webgpu-hiz-shaders.js';

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _size = new THREE.Vector2();
const _entBox = new THREE.Box3();
const HZB_WORKGROUP_DIM = 8;
const CULL_WORKGROUP_SIZE = 64;
const ENTITY_WORKGROUP_SIZE = 64;
const FRAME_PARAMS_FLOATS = 52;
const ENTITY_PARAMS_FLOATS = ENTITY_PARAMS_BYTES / 4;
const MAX_THRESHOLD_SLOTS = 2;
const PIPELINE_ERROR_SCOPE = 'validation';
const ENTITY_STAGING_POOL = 3;
const _EMPTY = [];

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
  // Identity label, not a knob: `constructor.name` is gone from a minified bundle, so a
  // caller that has to prove which tier is installed has nothing else to read.
  kind = 'webgpu-hiz';
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
    this._entityPipeline = null;
    this._entityPipelineInit = null;
    this._msaaSeedPipeline = null;
    this._msaaSeedInit = null;
    this._depthSamples = 1;
    this._entityBoxBuf = null;
    this._entityParamBuf = null;
    this._entityVerdictBuf = null;
    this._depthTex = null;
    this._depthView = null;
    this._entityStaging = [];
    this._boxCache = new WeakMap();
    this._verdictSnapshot = null;
    this._boxScratch = new Float32Array(64);
    this._boxScratchFilled = 0;
    this._attachRefused = new WeakSet();
    // Per-candidate verdict bookkeeping, the WebGPU half of what OcclusionQueryTier keeps
    // in `_records`: how many verdicts have landed for a candidate, and what the last one
    // said. Both are candidate-keyed, never mesh-keyed.
    this._resolveCount = new WeakMap();
    this._lastVerdict = new WeakMap();
    // Rotation cursor for the discovery sweep. The population is stable and far larger
    // than a frame's budget, so a cursor covers it at a uniform rate.
    this._rrCursor = 0;
    // Undefined means "no slice in force", which is what ModelPool gets and what this
    // tier has always done. A finite number is the frame's slice; zero is the caller's
    // "the camera has not moved" gate.
    this.maxQueriesPerFrame = opts.maxQueriesPerFrame;
    this.stats = { levels: 0, queried: 0, occluded: 0, supported: false, drawsWritten: 0, skippedNoPyramid: 0, lodSlotOverflow: 0, pipelinesValidated: 0, pipelineRefusals: 0, entityTested: 0, entityOccluded: 0, entityReadbacks: 0, pyramidsBuilt: 0, indirectAttached: 0, indirectAttachRefused: 0, readbackStarved: 0, sliceSize: 0, reverify: 0, discovered: 0 };
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
    this._ensureEntityPipeline();
    this._ensureMsaaSeedPipeline();
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
    this._ensureEntityPipeline();
    this._ensureMsaaSeedPipeline();
    await Promise.all([this._pipelineInit, this._entityPipelineInit, this._msaaSeedInit]);
    this._refuseInvalidPipelines();
    return this.stats.pipelinesValidated;
  }

  // The entity verdict pipeline is validated apart from the four cluster pipelines:
  // `pipelinesValidated` is the count scripts/webgpu-pipeline-validation-refusal-witness.mjs
  // pins at 4, and a refusal here has to kill the tier just as loudly.
  _ensureEntityPipeline() {
    if (!this._device || this._entityPipelineInit) return;
    const built = createPipelineScoped(this._device, 'compute', {
      label: 'entity-hzb-pipeline',
      layout: 'auto',
      compute: { module: compileShaderModule(this._device, 'entity-hzb', ENTITY_HZB_WGSL), entryPoint: 'main' },
    });
    this._entityPipeline = built.pipeline;
    this._entityPipelineInit = built.verdict.then((error) => {
      if (error || built.thrown || !built.pipeline) {
        const detail = built.thrown
          ? (built.thrown.message || String(built.thrown))
          : ((error && (error.message || String(error))) || 'no pipeline object returned');
        this._pipelineError = new WebGPUPipelineError(built.label, detail);
        this.stats.supported = false;
        this.stats.pipelineRefusals++;
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error(`[webgpu-pipeline] "${built.label}" failed validation -- the HiZ cull refuses to dispatch: ${detail}`);
        }
      }
    });
  }

  // The MSAA seed is the same refusal story again: `texture_depth_multisampled_2d`
  // is a different binding type, so it needs its own pipeline, and the app that
  // renders 4x MSAA is exactly the app this cull has to work in.
  _ensureMsaaSeedPipeline() {
    if (!this._device || this._msaaSeedInit) return;
    const built = createPipelineScoped(this._device, 'compute', {
      label: 'hzb-seed-msaa-pipeline',
      layout: 'auto',
      compute: { module: compileShaderModule(this._device, 'hzb-seed-msaa', HZB_SEED_MSAA_WGSL), entryPoint: 'main' },
    });
    this._msaaSeedPipeline = built.pipeline;
    this._msaaSeedInit = built.verdict.then((error) => {
      if (error || built.thrown || !built.pipeline) {
        const detail = built.thrown
          ? (built.thrown.message || String(built.thrown))
          : ((error && (error.message || String(error))) || 'no pipeline object returned');
        this._pipelineError = new WebGPUPipelineError(built.label, detail);
        this.stats.supported = false;
        this.stats.pipelineRefusals++;
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error(`[webgpu-pipeline] "${built.label}" failed validation -- the HiZ cull refuses to dispatch: ${detail}`);
        }
      }
    });
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

  // HZB_SEED_WGSL binds `texture_depth_2d`, so a colour attachment is not
  // substitutable and `ctx.res.sceneDepth` (a RenderGraph dependency TAG) carries no
  // texture. The scene renders into the frame buffer target whenever tone mapping or
  // the output colour-space conversion needs one -- which is the default -- so the
  // canvas depth attachment is empty while the picture is correct. The depth to read
  // is the depth of the target `render()` actually drew the scene into.
  _sceneTarget() {
    const r = this.renderer;
    if (typeof r.getRenderTarget === 'function') {
      const rt = r.getRenderTarget();
      if (rt) return rt;
    }
    if (r.needsFrameBufferTarget === true && typeof r._getFrameBufferTarget === 'function') {
      const fbt = r._getFrameBufferTarget();
      if (fbt) return fbt;
    }
    if (typeof r.getOutputRenderTarget === 'function') {
      const ort = r.getOutputRenderTarget();
      if (ort) return ort;
    }
    // No intermediate: the scene went straight to the canvas, whose own depth
    // attachment is the depth to read.
    return typeof r.getCanvasTarget === 'function' ? r.getCanvasTarget() : null;
  }

  _sceneDepthView() {
    const r = this.renderer;
    if (!r || !r.isWebGPURenderer) return null;
    const backend = r.backend;
    if (!backend || backend.isWebGPUBackend !== true) return null;
    // Reversed depth inverts near/far, so `minZ > farthest` would cull the nearest
    // object and keep the farthest one.
    if (r.reversedDepthBuffer === true) return null;
    const rt = this._sceneTarget();
    if (!rt || rt.depthBuffer === false) return null;
    // three keeps a render target's depth texture in its own texture bookkeeping, not
    // on the RenderTarget: `RenderTarget.depthTexture` stays null for the internal
    // frame buffer target even though it has a depth buffer.
    const book = r._textures;
    const data = book && typeof book.get === 'function' ? book.get(rt) : null;
    const dt = (data && data.depthTexture) || rt.depthTexture || null;
    if (!dt || typeof backend.get !== 'function') return null;
    const tex = backend.get(dt).texture;
    // No texture yet means no frame has been rendered into this target, so there is
    // no depth to read. An unwritten depth texture is a legal `texture_depth_2d`
    // that reads all zeros, and an all-zero pyramid reports every entity occluded.
    if (!tex || typeof tex.createView !== 'function') return null;
    // The count has to come off the texture: the renderer's `currentSamples` and the
    // target actually holding the scene depth disagree (the frame buffer target keeps
    // its own sample count), and binding a multisampled texture as `texture_depth_2d`
    // is a per-frame validation error, not a one-off.
    this._depthSamples = tex.sampleCount > 1 ? tex.sampleCount : 1;
    if (this._depthTex !== tex) {
      this._depthTex = tex;
      this._depthView = tex.createView();
    }
    return this._depthView;
  }

  // The pyramid is the occluder source for every verdict this tier returns, so the
  // tier builds it itself at the top of the frame it is asked to cull. Leaving that
  // to a caller is what made `buildHzb` dead code.
  _syncPyramid() {
    const view = this._sceneDepthView();
    if (!view) { this.stats.skippedNoPyramid++; return false; }
    const sz = this.renderer.getDrawingBufferSize(_size);
    const w = Math.max(1, Math.round(sz && sz.x ? sz.x : 0));
    const h = Math.max(1, Math.round(sz && sz.y ? sz.y : 0));
    if (!w || !h) { this.stats.skippedNoPyramid++; return false; }
    const ok = this.buildHzb(view, w, h, this._depthSamples);
    if (ok) this.stats.pyramidsBuilt++;
    else this.stats.skippedNoPyramid++;
    return ok;
  }

  buildHzb(depthTextureView, width, height, sampleCount = 1) {
    if (!this.supported()) return false;
    this._ensurePipelines();
    this._ensureMsaaSeedPipeline();
    const msaa = sampleCount > 1;
    const seedPipeline = msaa ? this._msaaSeedPipeline : this._seedPipeline;
    if (!seedPipeline) { this.stats.skippedNoPyramid++; return false; }
    const levels = this._ensureHzbTextures(width, height);
    if (!levels) return false;
    const device = this._device;
    const encoder = device.createCommandEncoder({ label: 'hzb-build' });

    {
      const mip0 = this._hzbMips[0];
      const bg = device.createBindGroup({
        layout: seedPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: depthTextureView },
          { binding: 1, resource: mip0.view },
        ],
      });
      const pass = encoder.beginComputePass({ label: 'hzb-seed' });
      pass.setPipeline(seedPipeline);
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

  // Indirect draws are only consumable on a mesh whose index buffer still holds the
  // full LOD0+coarse layout the cull offsets into. A compact ClusterLodMesh rewrites
  // `geometry.index` down to `_drawCapacity` entries every frame, so a coarse-LOD
  // `firstIndex` of `lod0Count + offset` reads past the end of it; attaching there
  // would draw garbage, so the mesh is refused instead and the frame keeps the CPU
  // cull's groups.
  attachIndirect(mesh) {
    if (!mesh || !mesh.clusterSet || !mesh.geometry) return null;
    const existing = this._meshBuffers.get(mesh);
    if (existing && existing.indirectAttached) return existing.indirectAttr;
    if (this._attachRefused.has(mesh)) return null;
    if (mesh._compact === true) {
      this._attachRefused.add(mesh);
      this.stats.indirectAttachRefused++;
      return null;
    }
    const rec = this.registerClusterMesh(mesh);
    if (!rec || !rec.n) return null;
    const attr = this.buildIndirectAttribute(mesh);
    if (!attr) return null;
    // three issues one `drawIndexedIndirect` per entry here, per render item, so the
    // offsets are byte-spaced by INDIRECT_STRIDE_BYTES and cover n+1 slots: the cull
    // can emit one draw more than there are clusters when nothing survives and it
    // falls back to the whole LOD0.
    const offsets = new Array(rec.n + 1);
    for (let i = 0; i <= rec.n; i++) offsets[i] = i * INDIRECT_STRIDE_BYTES;
    mesh.geometry.setIndirect(attr, offsets);
    rec.indirectAttached = true;
    rec.indirectOffsets = offsets;
    this.stats.indirectAttached++;
    return attr;
  }

  _entityWorldBox(entity) {
    const root = entity && (entity.root || entity.object3d);
    if (!root || typeof root.updateWorldMatrix !== 'function') return null;
    let rec = this._boxCache.get(root);
    if (!rec) {
      rec = { mn: new Float32Array(3), mx: new Float32Array(3), m: new Float32Array(16), valid: false };
      this._boxCache.set(root, rec);
    }
    const me = root.matrixWorld.elements;
    let changed = !rec.valid;
    if (!changed) {
      for (let i = 0; i < 16; i++) if (rec.m[i] !== me[i]) { changed = true; break; }
    }
    if (!changed) return rec;
    _entBox.setFromObject(root);
    if (_entBox.isEmpty()) { rec.valid = false; return null; }
    rec.mn[0] = _entBox.min.x; rec.mn[1] = _entBox.min.y; rec.mn[2] = _entBox.min.z;
    rec.mx[0] = _entBox.max.x; rec.mx[1] = _entBox.max.y; rec.mx[2] = _entBox.max.z;
    rec.m.set(me);
    rec.valid = true;
    return rec;
  }

  _takeStaging(bytes) {
    for (let i = 0; i < this._entityStaging.length; i++) {
      const s = this._entityStaging[i];
      if (s.busy) continue;
      if (s.buf.size < bytes) {
        s.buf.destroy();
        s.buf = this._device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      }
      return s;
    }
    if (this._entityStaging.length >= ENTITY_STAGING_POOL) return null;
    const s = { busy: false, buf: this._device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }) };
    this._entityStaging.push(s);
    return s;
  }

  _runEntityOcclusion(camera, candidates) {
    this.stats.entityTested = 0;
    if (!this._hzbLevels || !this._entityPipeline) return;
    const device = this._device;
    const slots = new Map();
    let count = 0;
    for (let i = 0; i < candidates.length; i++) {
      const e = candidates[i];
      if (!e) continue;
      const rec = this._entityWorldBox(e);
      if (!rec) continue;
      const floats = count * 8;
      if (this._boxScratch.length < floats + 8) {
        const grown = new Float32Array(Math.max(64, this._boxScratch.length * 2, floats + 8));
        grown.set(this._boxScratch.subarray(0, this._boxScratchFilled || 0));
        this._boxScratch = grown;
      }
      const o = count * 8;
      this._boxScratch[o] = rec.mn[0];
      this._boxScratch[o + 1] = rec.mn[1];
      this._boxScratch[o + 2] = rec.mn[2];
      this._boxScratch[o + 3] = 0;
      this._boxScratch[o + 4] = rec.mx[0];
      this._boxScratch[o + 5] = rec.mx[1];
      this._boxScratch[o + 6] = rec.mx[2];
      this._boxScratch[o + 7] = 0;
      slots.set(e, count);
      count++;
    }
    this._boxScratchFilled = count * 8;
    if (!count) return;

    const boxBytes = count * ENTITY_BOX_STRIDE_BYTES;
    const verdictBytes = count * 4;
    if (!this._entityBoxBuf || this._entityBoxBuf.size < boxBytes) {
      if (this._entityBoxBuf) this._entityBoxBuf.destroy();
      this._entityBoxBuf = device.createBuffer({ size: boxBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    }
    if (!this._entityVerdictBuf || this._entityVerdictBuf.size < verdictBytes) {
      if (this._entityVerdictBuf) this._entityVerdictBuf.destroy();
      this._entityVerdictBuf = device.createBuffer({ size: verdictBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    }
    if (!this._entityParamBuf) {
      this._entityParamBuf = device.createBuffer({ size: ENTITY_PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }

    const staging = this._takeStaging(verdictBytes);
    // Every staging buffer in flight means this frame gets no verdicts, and a frame
    // with no verdicts is indistinguishable from a frame that tested nothing.
    if (!staging) { this.stats.readbackStarved++; return; }

    _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const fp = new Float32Array(ENTITY_PARAMS_FLOATS);
    fp.set(_m.elements, 0);
    const fpU32 = new Uint32Array(fp.buffer);
    fpU32[16] = count;
    fpU32[17] = this._hzbLevels;
    fp[18] = this._hzbW || 1;
    fp[19] = this._hzbH || 1;
    device.queue.writeBuffer(this._entityParamBuf, 0, fp.buffer, 0, ENTITY_PARAMS_BYTES);
    device.queue.writeBuffer(this._entityBoxBuf, 0, this._boxScratch.buffer, this._boxScratch.byteOffset, boxBytes);

    const bg = device.createBindGroup({
      layout: this._entityPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this._entityBoxBuf } },
        { binding: 1, resource: { buffer: this._entityParamBuf } },
        { binding: 2, resource: { buffer: this._entityVerdictBuf } },
        { binding: 3, resource: this._hzbView },
      ],
    });
    const encoder = device.createCommandEncoder({ label: 'entity-hzb' });
    const pass = encoder.beginComputePass({ label: 'entity-hzb-pass' });
    pass.setPipeline(this._entityPipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(count / ENTITY_WORKGROUP_SIZE), 1, 1);
    pass.end();
    encoder.copyBufferToBuffer(this._entityVerdictBuf, 0, staging.buf, 0, verdictBytes);
    device.queue.submit([encoder.finish()]);
    this.stats.entityTested = count;

    staging.busy = true;
    const n = count;
    staging.buf.mapAsync(GPUMapMode.READ).then(() => {
      const arr = new Uint32Array(staging.buf.getMappedRange(0, verdictBytes)).slice();
      staging.buf.unmap();
      staging.busy = false;
      let occ = 0;
      for (let i = 0; i < arr.length; i++) if (arr[i] === 1) occ++;
      // A verdict lands for every candidate of the dispatch, so this is where each one's
      // resolved count advances and where the sweep learns which candidates are being
      // hidden. Both are what make the next slice's correctness classes meaningful.
      for (const c of slots.keys()) {
        this._resolveCount.set(c, (this._resolveCount.get(c) || 0) + 1);
        const slot = slots.get(c);
        this._lastVerdict.set(c, slot < arr.length && arr[slot] === 1);
      }
      this._verdictSnapshot = { arr, slots };
      this.stats.entityOccluded = occ;
      this.stats.entityReadbacks++;
    }).catch(() => { staging.busy = false; });
  }

  // How many verdicts have landed for this candidate -- the same question
  // OcclusionQueryTier.getResolveCount answers, and the only thing the caller's policy
  // can tell a fresh verdict from a repeated one with.
  getResolveCount(candidate) {
    return candidate ? (this._resolveCount.get(candidate) || 0) : 0;
  }

  // What the last verdict said, kept per candidate so the sweep can still tell "this is
  // being hidden right now" for a candidate the previous dispatch did not include. The
  // snapshot alone cannot: it only holds the candidates of one dispatch.
  _wasOccluded(candidate) {
    return this._lastVerdict.get(candidate) === true;
  }

  // The frame's slice of a population far larger than one dispatch should carry.
  //
  // Three classes, and the order between them is correctness, not tuning:
  //  1. re-verification -- a candidate the last verdict called occluded is one a consumer
  //     is currently hiding. Dropping it from the slice leaves it with a verdict the
  //     policy will eventually fail open, which is exactly the pop the one-frame floor
  //     exists to prevent. Re-verifying is not budget work, so it is never sliced.
  //  2. discovery -- a candidate with no verdict yet has nothing to be stale, and until
  //     it has one the tier cannot say anything about it at all.
  //  3. rotation over everything else, at a rate the caller's budget sets.
  //
  // The order is deliberately NOT by instance count. Measured on tps-game, hiding every
  // grass cell at once costs 0 draw calls while hiding every rock cell costs 112, and a
  // grass cell carries ~7830 instances against a rock cell's ~0.2 -- so an
  // instance-weighted order spends the budget on the one subsystem that cannot move a
  // draw. Rotation makes no bet about which candidate carries the cost.
  _selectFrameSlice(candidates) {
    const limit = this.maxQueriesPerFrame;
    if (!Number.isFinite(limit)) return candidates;
    if (limit <= 0) return _EMPTY;
    if (candidates.length <= limit) return candidates;
    const out = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (c && this._wasOccluded(c)) out.push(c);
    }
    this.stats.reverify = out.length;
    let room = limit;
    for (let i = 0; i < candidates.length && room > 0; i++) {
      const c = candidates[i];
      if (!c || this._wasOccluded(c) || this._resolveCount.get(c)) continue;
      out.push(c); room--;
    }
    if (room > 0) this._takeRotating(candidates, room, out);
    this.stats.sliceSize = out.length;
    return out;
  }

  // A rotating window, so a population larger than the budget is still covered at a
  // uniform rate instead of the same candidates being tested every frame.
  _takeRotating(candidates, room, out) {
    const n = candidates.length;
    let idx = this._rrCursor % n;
    let taken = 0;
    for (let examined = 0; examined < n && taken < room; examined++, idx = (idx + 1) % n) {
      const c = candidates[idx];
      if (!c || this._wasOccluded(c)) continue;
      out.push(c);
      taken++;
    }
    this._rrCursor = idx;
    this.stats.discovered = taken;
    return out;
  }

  runQueries(camera, candidates) {
    if (!this.supported()) { this.stats.queried = 0; this.stats.occluded = 0; return; }
    this.stats.queried = 0;
    this.stats.sliceSize = 0;
    this.stats.reverify = 0;
    this.stats.discovered = 0;
    const slice = candidates && candidates.length ? this._selectFrameSlice(candidates) : _EMPTY;
    if (!slice.length) return;
    if (!this._syncPyramid()) return;
    this._runEntityOcclusion(camera, slice);
    for (let i = 0; i < slice.length; i++) {
      const meshes = this._clusterMeshesOf(slice[i]);
      if (!meshes) continue;
      for (let k = 0; k < meshes.length; k++) {
        const mesh = meshes[k];
        if (!mesh || !mesh.clusterSet) continue;
        if (!this.attachIndirect(mesh)) continue;
        this.cullAndBuildIndirect(mesh, camera);
      }
    }
  }

  // Fail-open: an entity with no resolved verdict yet stays visible, and a verdict is
  // always the previous frame's, so a disappearing occluder costs one frame of
  // lateness rather than a permanently hidden entity.
  isOccluded(entity) {
    if (!entity) return false;
    const snap = this._verdictSnapshot;
    if (!snap) return false;
    const slot = snap.slots.get(entity);
    if (slot === undefined || slot >= snap.arr.length) return false;
    return snap.arr[slot] === 1;
  }

  // Candidate-scoped, not mesh-scoped: this is what `SceneOcclusion` calls when a
  // subsystem's candidate set drops a cell, and a cell is a `{root, key}` proxy with no
  // cluster mesh behind it. Forgetting it means the next slice must re-discover it, and
  // `isOccluded` fails open in the meantime, which is the visible direction.
  release(candidate) {
    if (!candidate) return;
    if (this._meshBuffers.has(candidate)) { this.unregisterClusterMesh(candidate); return; }
    const root = candidate.root || candidate.object3d || null;
    if (root) this._boxCache.delete(root);
    this._resolveCount.delete(candidate);
    this._lastVerdict.delete(candidate);
    if (this._verdictSnapshot) this._verdictSnapshot.slots.delete(candidate);
  }

  dispose() {
    if (this._hzbTex) { this._hzbTex.destroy(); this._hzbTex = null; }
    this._hzbView = null;
    this._depthTex = null;
    this._depthView = null;
    this._depthSamples = 1;
    this._msaaSeedPipeline = null;
    if (this._entityBoxBuf) { this._entityBoxBuf.destroy(); this._entityBoxBuf = null; }
    if (this._entityParamBuf) { this._entityParamBuf.destroy(); this._entityParamBuf = null; }
    if (this._entityVerdictBuf) { this._entityVerdictBuf.destroy(); this._entityVerdictBuf = null; }
    for (const s of this._entityStaging) s.buf.destroy();
    this._entityStaging.length = 0;
    this._boxCache = new WeakMap();
    this._resolveCount = new WeakMap();
    this._lastVerdict = new WeakMap();
    this._verdictSnapshot = null;
    this._hzbMips.length = 0;
    for (const mesh of Array.from(this._meshBuffers.keys())) this.unregisterClusterMesh(mesh);
    this._pipelinesReady = false;
    this._pyramidReady = false;
  }
}

export const WGSL_SOURCES = {
  hzbSeed: HZB_SEED_WGSL,
  hzbSeedMsaa: HZB_SEED_MSAA_WGSL,
  hzbReduce: HZB_REDUCE_WGSL,
  cullLod: CULL_LOD_WGSL,
};

export const CLUSTER_STRIDE_BYTES_EXPORT = CLUSTER_STRIDE_BYTES;
export const INDIRECT_STRIDE_BYTES_EXPORT = INDIRECT_STRIDE_BYTES;
