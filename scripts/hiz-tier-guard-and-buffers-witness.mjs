import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIER = path.join(ROOT, 'packages', 'streaming-gltf', 'src', 'webgpu-hiz-tier.js');

globalThis.GPUBufferUsage = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
globalThis.GPUTextureUsage = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
globalThis.GPUMapMode = { READ: 1, WRITE: 2 };

function makeDevice(counts) {
  const buffers = [];
  const device = {
    pushErrorScope() {},
    popErrorScope() { return null; },
    createShaderModule(desc) { return { code: desc.code, label: desc.label }; },
    createComputePipeline(desc) { return { label: desc.label, getBindGroupLayout: () => ({}) }; },
    createRenderPipeline(desc) { return { label: desc.label, getBindGroupLayout: () => ({}) }; },
    createTexture(desc) {
      counts.createTexture++;
      return { desc, createView: () => ({}), destroy() { counts.destroyTexture++; } };
    },
    createBuffer(desc) {
      counts.createBuffer++;
      const buf = {
        size: desc.size,
        destroyed: false,
        getMappedRange: () => new ArrayBuffer(desc.size),
        unmap() {},
        destroy() {
          if (!buf.destroyed) counts.destroyBuffer++;
          buf.destroyed = true;
        },
      };
      buffers.push(buf);
      return buf;
    },
    createBindGroup() { return {}; },
    createSampler() { return {}; },
    createCommandEncoder() {
      return {
        beginComputePass() {
          return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
        },
        copyBufferToBuffer() {},
        finish() { return {}; },
      };
    },
    queue: { submit() {}, writeBuffer() {} },
  };
  return { device, buffers };
}

function makeRenderer(device, drawing) {
  const depthTexture = { sampleCount: 1, createView: () => ({}) };
  const rt = { depthBuffer: true, depthTexture: null };
  const backend = { isWebGPUBackend: true, device, get: () => ({ texture: depthTexture }) };
  return {
    isWebGPURenderer: true,
    backend,
    reversedDepthBuffer: false,
    _textures: new Map([[rt, { depthTexture: {} }]]),
    getRenderTarget: () => rt,
    getDrawingBufferSize(v) { v.x = drawing.w; v.y = drawing.h; return v; },
  };
}

function liveBuffers(buffers) {
  return buffers.filter((b) => !b.destroyed).length;
}

const results = [];
function expect(name, got, want) {
  const ok = Object.is(got, want);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

try {
  const { WebGpuHizTier } = await import(pathToFileURL(TIER).href);
  console.log('stubs: GPU device (buffers, textures, pipelines, encoder, queue) and the GPU usage globals; renderer object exposes only the fields the tier reads');

  {
    const counts = { createBuffer: 0, destroyBuffer: 0, createTexture: 0, destroyTexture: 0 };
    const { device, buffers } = makeDevice(counts);
    const renderer = makeRenderer(device, { w: 256, h: 256 });
    const tier = new WebGpuHizTier(renderer);
    const view = {};
    tier.buildHzb(view, 256, 256, 1);
    const afterFirst = counts.createBuffer;
    tier.buildHzb(view, 256, 256, 1);
    const afterSecond = counts.createBuffer;
    expect('buffers created after 1st buildHzb > 0 (control)', afterFirst > 0, true);
    expect('createBuffer count does not grow across two buildHzb calls', afterSecond, afterFirst);
    tier.dispose();
    expect('no tier-created buffer is left alive after dispose', liveBuffers(buffers), 0);
  }

  {
    const counts = { createBuffer: 0, destroyBuffer: 0, createTexture: 0, destroyTexture: 0 };
    const { device } = makeDevice(counts);
    const renderer = makeRenderer(device, { w: 256, h: 256 });
    const tier = new WebGpuHizTier(renderer);
    tier.runQueries({}, [{}]);
    expect('positive control: non-empty drawing buffer builds a pyramid', tier.stats.pyramidsBuilt, 1);
  }

  {
    const counts = { createBuffer: 0, destroyBuffer: 0, createTexture: 0, destroyTexture: 0 };
    const { device } = makeDevice(counts);
    const renderer = makeRenderer(device, { w: 0, h: 0 });
    const tier = new WebGpuHizTier(renderer);
    const before = { ...counts };
    tier.runQueries({}, [{}]);
    expect('zero drawing buffer: no pyramid is built', tier.stats.pyramidsBuilt, 0);
    expect('zero drawing buffer: skippedNoPyramid counts the refusal', tier.stats.skippedNoPyramid >= 1, true);
    expect('zero drawing buffer: no buffer is created', counts.createBuffer, before.createBuffer);
    expect('zero drawing buffer: no texture is created', counts.createTexture, before.createTexture);
  }

  {
    const counts = { createBuffer: 0, destroyBuffer: 0, createTexture: 0, destroyTexture: 0 };
    const { device } = makeDevice(counts);
    const renderer = makeRenderer(device, { w: 0.4, h: 256 });
    const tier = new WebGpuHizTier(renderer);
    tier.runQueries({}, [{}]);
    expect('sub-pixel width rounds to 0 and builds no pyramid', tier.stats.pyramidsBuilt, 0);
  }
} catch (err) {
  console.log(`error: ${err && err.stack ? err.stack : err}`);
  results.push(false);
}

const pass = results.length > 0 && results.every(Boolean);
console.log(`RESULT: ${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
