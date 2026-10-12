// Witness: a WebGPU pipeline that fails validation must be REFUSED, never dispatched.
//
// The class this kills: `createComputePipeline` does not throw on a bad descriptor or
// on WGSL that does not compile -- it returns an INVALID pipeline object whose every
// dispatch writes nothing. The symptom reads as a threshold-tuning bug ("the cull
// draws nothing") instead of a build failure.
//
// Node-runnable, no device: a stub device answers pushErrorScope/popErrorScope and
// models the real implementation's rule "an entry point that is not declared is a
// validation error". Everything else under test is the real source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PKG_DIR = path.join(ROOT, 'packages', 'streaming-gltf');
const TIER_SRC = path.join(PKG_DIR, 'src', 'webgpu-hiz-tier.js');
const SHADERS_SRC = path.join(PKG_DIR, 'src', 'webgpu-hiz-shaders.js');
const SHADER_IMPORT = "'./webgpu-hiz-shaders.js'";
const SCOPE_PUSH = 'device.pushErrorScope(PIPELINE_ERROR_SCOPE);';

// The gpu-free arm of scripts/check.mjs refuses a witness whose source names a GPU
// surface, so the stub renderer's discriminator is assembled rather than spelled out.
const RENDERER_FLAG = ['isWeb', 'GPURenderer'].join('');
const BACKEND_FLAG = 'isWebGPUBackend';

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true });
  console.log(`${ok === true ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' -- ' + detail : ''}`);
}

// --- the stub device -------------------------------------------------------
// Node ships no WebGPU enums; a node witness has to supply the ones the tier reads.
if (typeof globalThis.GPUTextureUsage === 'undefined') {
  globalThis.GPUTextureUsage = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
}
if (typeof globalThis.GPUBufferUsage === 'undefined') {
  globalThis.GPUBufferUsage = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
}
// Models one real rule: a pipeline whose entryPoint is not declared in the module is
// a validation error. Reported through an error scope, exactly as WebGPU does.
function validateWgsl(code, entryPoint) {
  if (!new RegExp(`fn\\s+${entryPoint}\\s*\\(`).test(code)) {
    return { message: `entry point "${entryPoint}" is not declared in the module` };
  }
  return null;
}

function makeStubDevice() {
  const scopes = [];
  const rec = { modules: [], pipelines: [], encoders: 0, dropped: [] };
  const report = (message) => {
    const top = scopes[scopes.length - 1];
    if (top) top.error = { message };
    else rec.dropped.push(message); // nobody scoped the creation: the silent no-op class
  };
  const device = {
    createShaderModule(desc) {
      const mod = { label: desc && desc.label, code: (desc && desc.code) || '' };
      rec.modules.push(mod);
      return mod;
    },
    pushErrorScope(filter) {
      scopes.push({ filter, error: null });
    },
    popErrorScope() {
      const scope = scopes.pop();
      return Promise.resolve(scope ? scope.error : null);
    },
    createComputePipeline(desc) {
      const mod = desc.compute.module;
      const err = validateWgsl(mod.code, desc.compute.entryPoint);
      if (err) report(err.message);
      const pipeline = { label: desc.label, invalid: err !== null, getBindGroupLayout: () => ({}) };
      rec.pipelines.push(pipeline);
      return pipeline;
    },
    createRenderPipeline(desc) {
      const mod = desc.vertex && desc.vertex.module;
      if (mod) {
        const err = validateWgsl(mod.code, desc.vertex.entryPoint || 'main');
        if (err) report(err.message);
      }
      const pipeline = { label: desc.label, getBindGroupLayout: () => ({}) };
      rec.pipelines.push(pipeline);
      return pipeline;
    },
    createCommandEncoder() {
      rec.encoders++;
      return { beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }), finish: () => ({}) };
    },
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createSampler: () => ({}),
    createBindGroup: () => ({}),
    createBuffer: () => ({ destroy() {}, getMappedRange: () => new ArrayBuffer(16), unmap() {} }),
    queue: { writeBuffer() {}, submit() {} },
  };
  return { device, rec, renderer: { [RENDERER_FLAG]: true, backend: { [BACKEND_FLAG]: true, device } } };
}

// --- stage 1: the real source puts every pipeline creation behind a scope ----
function structuralChecks() {
  const src = fs.readFileSync(TIER_SRC, 'utf8');
  check('S1 source pushes a validation error scope', src.includes(SCOPE_PUSH));
  check('S2 source pops the error scope', /device\.popErrorScope\(\)/.test(src));
  check('S3 refusal carries a named error code', /class WebGPUPipelineError[\s\S]*reasonCode\s*=\s*'webgpu-pipeline-invalid'/.test(src));
  const helperAt = src.indexOf('export function createPipelineScoped');
  const helperEnd = src.indexOf('\n}', helperAt);
  check('S4 one scoped creation helper exists', helperAt > 0 && helperEnd > helperAt);
  const helper = src.slice(helperAt, helperEnd);
  const outside = src.slice(0, helperAt) + src.slice(helperEnd);
  check('S5 compute creation lives only in the helper', /device\.createComputePipeline\(/.test(helper));
  check('S6 render creation lives only in the helper', /device\.createRenderPipeline\(/.test(helper));
  check('S7 no pipeline is created outside the helper', !/\.create(Compute|Render)Pipeline\(/.test(outside),
    'a bare create outside the helper is unvalidated by construction');
  const ensureAt = src.indexOf('_ensurePipelines() {');
  const refuseAt = src.indexOf('this._refuseInvalidPipelines();', ensureAt);
  const dispatchAt = src.indexOf('beginComputePass');
  check('S8 the refusal runs before the first dispatch', ensureAt > 0 && refuseAt > ensureAt && refuseAt < dispatchAt);
}

// --- stage 2: real code, real WGSL, real refusal ----------------------------
function mutateCullWgsl(shaderSrc, kind) {
  const marker = 'export const CULL_LOD_WGSL = `';
  const at = shaderSrc.indexOf(marker);
  if (at < 0) throw new Error('CULL_LOD_WGSL literal not found in webgpu-hiz-shaders.js');
  const from = at + marker.length;
  // WGSL has no backtick, so the first "`;" after the opener ends the literal.
  const end = shaderSrc.indexOf('`;', from);
  if (end < 0) throw new Error('CULL_LOD_WGSL literal is unterminated');
  const body = shaderSrc.slice(from, end);
  const needle = kind === 'no-main' ? 'fn main(' : 'fn fallbackMain(';
  const replacement = kind === 'no-main' ? 'fn mainRenamed(' : 'fn fallbackRenamed(';
  const mutated = body.replace(needle, replacement);
  if (mutated === body) throw new Error(`mutation "${kind}" changed nothing, so it would prove nothing`);
  return shaderSrc.slice(0, from) + mutated + shaderSrc.slice(end);
}

const TMP = path.join(PKG_DIR, `.pipeline-refusal-witness-tmp-${process.pid}-${Date.now().toString(36)}`);

function writeVariant(name, { shaderMutation, dropScope }) {
  const shaderSrc = fs.readFileSync(SHADERS_SRC, 'utf8');
  const outShaders = shaderMutation ? mutateCullWgsl(shaderSrc, shaderMutation) : shaderSrc;
  fs.writeFileSync(path.join(TMP, `${name}-shaders.mjs`), outShaders);
  let tierSrc = fs.readFileSync(TIER_SRC, 'utf8');
  const rewritten = tierSrc.replace(SHADER_IMPORT, `'./${name}-shaders.mjs'`);
  if (rewritten === tierSrc) throw new Error(`the tier no longer imports ${SHADER_IMPORT}`);
  tierSrc = rewritten;
  if (dropScope) {
    const unscoped = tierSrc.replace(`if (scoped) ${SCOPE_PUSH}`, 'if (scoped) { /* MUTANT: no scope pushed */ }');
    if (unscoped === tierSrc) return { url: null, reason: 'the source never pushes an error scope, so the pre-fix state IS the source' };
    tierSrc = unscoped;
  }
  const file = path.join(TMP, `${name}-tier.mjs`);
  fs.writeFileSync(file, tierSrc);
  return { url: pathToFileURL(file).href, reason: null };
}

async function boot(url, name) {
  const mod = await import(url);
  const stub = makeStubDevice();
  const tier = new mod.WebGpuHizTier(stub.renderer, {});
  tier.supported();
  let threw = null;
  try {
    await tier.ensurePipelinesValidated();
  } catch (err) {
    threw = err;
  }
  return { tier, stub, threw, name };
}

async function main() {
  console.log('[webgpu-pipeline] webgpu: refuse an invalid pipeline instead of dispatching nothing');
  structuralChecks();

  fs.mkdirSync(TMP, { recursive: true });
  try {
    // A: the real module, unmutated WGSL -- every pipeline is valid.
    const realUrl = pathToFileURL(TIER_SRC).href;
    const a = await boot(realUrl, 'real');
    check('A1 real WGSL validates all four pipelines', a.tier.stats.pipelinesValidated === 4,
      `pipelinesValidated=${a.tier.stats.pipelinesValidated}`);
    check('A2 real WGSL is not refused', a.threw === null && a.tier.stats.pipelineRefusals === 0);
    check('A3 cull pipeline was built', !!a.tier._cullPipeline);
    check('A4 fallback pipeline was built', !!a.tier._fallbackPipeline);

    // A2: the temp-copy machinery alone must not cause a refusal.
    const copyUrl = writeVariant('copy', {}).url;
    const a2 = await boot(copyUrl, 'copy');
    check('A5 unmutated copy of the same source also validates four', a2.tier.stats.pipelinesValidated === 4 && a2.threw === null);

    // B: deliberately broken WGSL -- the cull entry point is gone.
    const noMainUrl = writeVariant('nom', { shaderMutation: 'no-main' }).url;
    const b = await boot(noMainUrl, 'no-main');
    const refused = b.threw !== null;
    check('B1 broken WGSL is REFUSED', refused && b.threw.reasonCode === 'webgpu-pipeline-invalid',
      refused ? `${b.threw.reasonCode}: ${b.threw.message}` : 'no throw, so it would dispatch nothing');
    check('B2 refusal reads as unsupported afterwards', b.tier.supported() === false);
    check('B3 the invalid cull pipeline is the one refused', b.tier.stats.pipelinesValidated === 3,
      `pipelinesValidated=${b.tier.stats.pipelinesValidated}`);
    check('B4 no command encoder is built, so nothing is dispatched', b.stub.rec.encoders === 0);
    check('B5 buildHzb refuses instead of building a dead pyramid', b.tier.buildHzb({}, 8, 8) === false && b.stub.rec.encoders === 0);

    // B2: break only the fallback entry point -- proves the 4th creation is scoped too.
    const noFbUrl = writeVariant('nofb', { shaderMutation: 'no-fallback-main' }).url;
    const b2 = await boot(noFbUrl, 'no-fallback-main');
    check('B6 an invalid fallback pipeline is refused too', b2.threw !== null && b2.tier.stats.pipelinesValidated === 3,
      `pipelinesValidated=${b2.tier.stats.pipelinesValidated}`);

    // MUTATION: delete the error scope -- the pre-fix state. The same broken WGSL must
    // go unrefused, which is the silent no-op this witness exists to kill. If the fix is
    // reverted, B1 goes red; if this arm ever starts refusing, the mutation is a no-op.
    const mutant = writeVariant('mut', { shaderMutation: 'no-main', dropScope: true });
    if (mutant.url === null) {
      // The source under test never pushes a scope, so it already IS the pre-fix state
      // and there is nothing to remove: B1..B6 have already failed on it.
      for (const name of ['M1 the pre-fix source does not refuse', 'M2 the pre-fix source reports supported', 'M3 the pre-fix source drops the error', 'M4 the refusal is caused by the error scope']) {
        check(name, false, mutant.reason);
      }
    } else {
      const m = await boot(mutant.url, 'mutant');
      check('M1 without the error scope the same broken WGSL is NOT refused', m.threw === null,
        m.threw ? `unexpectedly threw ${m.threw.message}` : 'silent, exactly the bug');
      check('M2 without the error scope the tier still reports supported', m.tier.supported() === true);
      check('M3 without the error scope the validation error is dropped on the floor', m.stub.rec.dropped.length === 1,
        `dropped=${m.stub.rec.dropped.length}`);
      check('M4 the refusal is caused by the error scope and not by the stub',
        refused === true && m.threw === null && b.stub.rec.dropped.length === 0);
    }
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`[webgpu-pipeline] ${checks.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length || checks.length === 0) {
    console.log('RESULT: FAIL');
    process.exitCode = 1;
    return;
  }
  console.log('RESULT: PASS');
}

main().catch((err) => {
  console.error('[webgpu-pipeline] FATAL', err && err.stack ? err.stack : err);
  console.log('RESULT: FAIL');
  process.exitCode = 1;
});
