import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './lib/cdp-browser.mjs';
import { gpuArgs, vendorGpuArgs } from './lib/gpu-probe.mjs';

// Counts CPU-cull vs HiZ-cull disagreements per frame, on a real WebGPU device,
// with the real WGSL and the real ClusterLodMesh._selectClods. Counted units only:
// no timings are read or reported anywhere in this witness.

function argValue(name, dflt = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return hit === undefined ? dflt : hit.slice(prefix.length);
}

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const LABEL = argValue('label', 'worktree');
const SESSION = argValue('session', 'unset');
const VENDOR = argValue('vendor', 'nvidia');
const SRC_DIR = path.resolve(argValue('src', path.join(REPO_ROOT, 'packages', 'streaming-gltf', 'src')));
const THREE_BUILD = path.join(REPO_ROOT, 'node_modules', 'three', 'build', 'three.webgpu.js');
const OUT_DIR = path.join(REPO_ROOT, '.gm', 'witness-out');
const LOG_PATH = path.join(REPO_ROOT, '.gm', 'witness-log.md');
const WITNESS = 'webgpu-hiz-cull-parity';

const VENDOR_PATTERNS = { nvidia: /nvidia|geforce|quadro|rtx/i, amd: /amd|radeon/i, intel: /intel|arc|iris|uhd/i };

// Served verbatim to the page. No backticks: this is embedded in a template literal.
const HARNESS = [
  "import * as THREE from 'three';",
  "import { ClusterLodMesh } from '/src/cluster-lod-mesh.js';",
  "import { WebGpuHizTier } from '/src/webgpu-hiz-tier.js';",
  '',
  'const W = 512, H = 512;',
  'const NCL = 16;',
  'const LOD0_IDX = 30, LOD1_IDX = 12, LOD2_IDX = 6;',
  'const LOD0_COUNT = NCL * LOD0_IDX;',
  'const COARSE_COUNT = NCL * (LOD1_IDX + LOD2_IDX);',
  '',
  'function buildClusterSet() {',
  '  const clusters = [];',
  '  for (let i = 0; i < NCL; i++) {',
  '    const x = -6 + i * 0.8;',
  '    clusters.push({',
  '      aabb: [x - 0.5, -0.5, -12.5, x + 0.5, 0.5, -11.5],',
  '      sphere: [x, 0, -12, 0.3 + i * 0.15],',
  '      lods: [',
  '        { offset: i * LOD0_IDX, count: LOD0_IDX, stream: 0 },',
  //     LOD1 base 480 + i*12, LOD2 base 480 + i*6
  // collide (cluster 2j's LOD2 offset is cluster j's LOD1 offset), so the
  // indirect-args offset no longer identifies one (cluster, lod) pair and the
  // comparison counts phantom disagreements. Keep every LOD range disjoint.
  '        { offset: i * LOD1_IDX, count: LOD1_IDX, stream: 1 },',
  '        { offset: NCL * LOD1_IDX + i * LOD2_IDX, count: LOD2_IDX, stream: 1 },',
  '      ],',
  '    });',
  '  }',
  '  return { clusters };',
  '}',
  '',
  'function makeMesh(clusterSet) {',
  '  const idx = new THREE.BufferAttribute(new Uint32Array(LOD0_COUNT + COARSE_COUNT), 1);',
  '  const geo = new THREE.BufferGeometry();',
  '  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3 * 64), 3));',
  '  geo.setIndex(idx);',
  '  return new ClusterLodMesh(geo, new THREE.MeshBasicMaterial(), clusterSet, { lod0Count: LOD0_COUNT });',
  '}',
  '',
  'function makeCamera(cx, away) {',
  '  const cam = new THREE.PerspectiveCamera(60, W / H, 0.1, 100);',
  '  cam.coordinateSystem = THREE.WebGPUCoordinateSystem;',
  '  cam.position.set(cx, 0, 0);',
  '  if (away) cam.lookAt(cx, 0, 40); else cam.lookAt(cx, 0, -12);',
  '  cam.updateProjectionMatrix();',
  '  cam.updateMatrixWorld(true);',
  '  return cam;',
  '}',
  '',
  'const QUAD_WGSL = [',
  '  "struct Q { rect: vec4<f32>, z: f32 };",',
  '  "@group(0) @binding(0) var<uniform> q: Q;",',
  '  "@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {",',
  '  "  var c = array<vec2<f32>, 6>(vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0));",',
  '  "  let t = c[vi];",',
  '  "  let x = mix(q.rect.x, q.rect.z, t.x);",',
  '  "  let y = mix(q.rect.y, q.rect.w, t.y);",',
  '  "  return vec4<f32>(x, y, q.z, 1.0);",',
  '  "}",',
  '].join("\\n");',
  '',
  'function readU32(device, src, bytes) {',
  '  const dst = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });',
  '  const enc = device.createCommandEncoder();',
  '  enc.copyBufferToBuffer(src, 0, dst, 0, bytes);',
  '  device.queue.submit([enc.finish()]);',
  '  return dst.mapAsync(GPUMapMode.READ).then(() => {',
  '    const out = new Uint32Array(new Uint8Array(dst.getMappedRange()).slice().buffer);',
  '    dst.unmap(); dst.destroy();',
  '    return out;',
  '  });',
  '}',
  '',
  'function compare(cpuM, gpuM) {',
  '  let cpuCulledGpuDrawn = 0, gpuCulledCpuDrawn = 0, lodMismatch = 0;',
  '  for (const k of gpuM.keys()) if (!cpuM.has(k)) cpuCulledGpuDrawn++;',
  '  for (const k of cpuM.keys()) if (!gpuM.has(k)) gpuCulledCpuDrawn++;',
  '  for (const [k, v] of gpuM) {',
  '    const c = cpuM.get(k);',
  '    if (c && (c.start !== v.start || c.count !== v.count)) lodMismatch++;',
  '  }',
  '  return { cpuCulledGpuDrawn, gpuCulledCpuDrawn, lodMismatch };',
  '}',
  '',
  'window.__hizParity = async function () {',
  '  const errors = [];',
  '  const adapter = await navigator.gpu.requestAdapter();',
  '  if (!adapter) return { fatal: "no adapter" };',
  '  const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);',
  '  const device = await adapter.requestDevice();',
  '  device.onuncapturederror = (e) => {',
  '    const m = e.error && e.error.message ? e.error.message : String(e.error);',
  '    if (errors.length < 8) errors.push(m.split("\\n")[0]);',
  '  };',
  '',
  '  const clusterSet = buildClusterSet();',
  '  const mesh = makeMesh(clusterSet);',
  '  const offsetToCi = new Map();',
  '  for (let ci = 0; ci < clusterSet.clusters.length; ci++) {',
  '    const lods = clusterSet.clusters[ci].lods;',
  '    for (let l = 0; l < lods.length; l++) {',
  '      const base = lods[l].stream === 1 ? LOD0_COUNT : 0;',
  '      offsetToCi.set(base + lods[l].offset, { ci, lod: l });',
  '    }',
  '  }',
  '',
  '  const renderer = {',
  '    isWebGPURenderer: true,',
  '    backend: { isWebGPUBackend: true, device },',
  '    info: { render: { frame: 0 } },',
  '    getDrawingBufferSize(v) { v.set(W, H); return v; },',
  '  };',
  '  const tier = new WebGpuHizTier(renderer, {});',
  '  if (!tier.supported()) return { fatal: "tier unsupported" };',
  '',
  '  const quadMod = device.createShaderModule({ code: QUAD_WGSL });',
  '  const quadUni = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });',
  '  const quadPipe = device.createRenderPipeline({',
  '    layout: "auto",',
  '    vertex: { module: quadMod, entryPoint: "vs" },',
  '    depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" },',
  '  });',
  '  const quadBg = device.createBindGroup({ layout: quadPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: quadUni } }] });',
  '',
  '  function makeDepth(clearValue, quad) {',
  '    const tex = device.createTexture({',
  '      size: { width: W, height: H }, format: "depth32float",',
  '      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,',
  '    });',
  '    const enc = device.createCommandEncoder();',
  '    const pass = enc.beginRenderPass({',
  '      colorAttachments: [],',
  '      depthStencilAttachment: {',
  '        view: tex.createView(), depthClearValue: clearValue,',
  '        depthLoadOp: "clear", depthStoreOp: "store",',
  '      },',
  '    });',
  '    if (quad) {',
  '      device.queue.writeBuffer(quadUni, 0, new Float32Array([quad[0], quad[1], quad[2], quad[3], quad[4], 0, 0, 0]));',
  '      pass.setPipeline(quadPipe); pass.setBindGroup(0, quadBg); pass.draw(6);',
  '    }',
  '    pass.end();',
  '    device.queue.submit([enc.finish()]);',
  '    return tex;',
  '  }',
  '',
  '  async function step(cam, stamp, depthTex) {',
  '    mesh.updateWorldMatrix(true, false);',
  '    mesh.prepare(cam, H, stamp);',
  '    if (depthTex) tier.buildHzb(depthTex.createView(), W, H);',
  '    tier.cullAndBuildIndirect(mesh, cam);',
  '    const rec = tier._meshBuffers.get(mesh);',
  '    const cnt = await readU32(device, rec.countBuf, 4);',
  '    const bytes = Math.min((rec.n + 1) * 20, rec.indirectBuf.size);',
  '    const args = await readU32(device, rec.indirectBuf, bytes);',
  '    const n = Math.min(cnt[0], Math.floor(bytes / 20));',
  '    const gpuM = new Map();',
  '    let unknownOffset = 0;',
  '    for (let s = 0; s < n; s++) {',
  '      const o = s * 5;',
  '      const indexCount = args[o], firstIndex = args[o + 2];',
  '      const hit = offsetToCi.get(firstIndex);',
  '      if (firstIndex === 0 && indexCount === LOD0_COUNT && n === 1) gpuM.set(-1, { start: 0, count: indexCount, lod: -1 });',
  '      else if (hit) gpuM.set(hit.ci, { start: firstIndex, count: indexCount, lod: hit.lod });',
  '      else { unknownOffset++; gpuM.set(-1000 - s, { start: firstIndex, count: indexCount, lod: -3 }); }',
  '    }',
  '    const cpuM = new Map();',
  '    const drawn = mesh._drawnCi;',
  '    if (!drawn || drawn.length === 0) cpuM.set(-1, { start: 0, count: LOD0_COUNT, lod: -1 });',
  '    else for (const ci of drawn) {',
  '      const g = mesh._groupPoolByClusterIndex[ci];',
  '      const hit = offsetToCi.get(g.start);',
  '      cpuM.set(ci, { start: g.start, count: g.count, lod: hit ? hit.lod : -9 });',
  '    }',
  '    return { cpuM, gpuM, n, unknownOffset };',
  '  }',
  '',
  '  const out = {',
  '    adapter: info ? { vendor: info.vendor || null, architecture: info.architecture || null, device: info.device || null, description: info.description || null } : null,',
  '    levels: 0, errors, scenarios: {},',
  '  };',
  '',
  '  // S0: camera faces away, so no cluster survives the CPU cull and the CPU emits',
  '  // its full-LOD0 fallback group. The GPU cull must emit the same draw.',
  '  {',
  '    const cam = makeCamera(0, true);',
  '    const r = await step(cam, 9001, null);',
  '    out.scenarios.S0_awayFallback = {',
  '      cpuDraws: r.cpuM.size, gpuDraws: r.gpuM.size,',
  '      cpuFallback: r.cpuM.has(-1), gpuFallback: r.gpuM.has(-1),',
  '      unknownOffset: r.unknownOffset,',
  '      ...compare(r.cpuM, r.gpuM),',
  '    };',
  '  }',
  '',
  '  // S1: no pyramid at all (production state: buildHzb has no caller).',
  '  // S2: pyramid present but cleared to far, so nothing is occluded.',
  '  // Both must reproduce the CPU set exactly, over a camera sweep that crosses',
  '  // frustum edges and LOD hysteresis thresholds in both directions.',
  '  for (const sc of ["S1_noPyramid", "S2_farPyramid"]) {',
  '    const acc = { cpuCulledGpuDrawn: 0, gpuCulledCpuDrawn: 0, lodMismatch: 0 };',
  '    let frames = 0, cpuDraws = 0, gpuDraws = 0, unknownOffset = 0;',
  '    const detail = [];',
  '    for (let s = 0; s < 12; s++) {',
  '      const cam = makeCamera(-5 + s * 1.0, false);',
  '      const depthTex = sc === "S2_farPyramid" ? makeDepth(1.0, null) : null;',
  '      const r = await step(cam, 100 + s, depthTex);',
  '      const c = compare(r.cpuM, r.gpuM);',
  '      acc.cpuCulledGpuDrawn += c.cpuCulledGpuDrawn;',
  '      acc.gpuCulledCpuDrawn += c.gpuCulledCpuDrawn;',
  '      acc.lodMismatch += c.lodMismatch;',
  '      cpuDraws += r.cpuM.size; gpuDraws += r.gpuM.size;',
  '      unknownOffset += r.unknownOffset;',
  '      if (s < 3) detail.push({ s,',
  '        cpu: [...r.cpuM.entries()].map(([k, v]) => [k, v.lod]),',
  '        gpu: [...r.gpuM.entries()].map(([k, v]) => [k, v.lod]),',
  '      });',
  '      frames++;',
  '      if (depthTex) depthTex.destroy();',
  '    }',
  '    out.levels = tier._hzbLevels;',
  '    out.scenarios[sc] = { frames, cpuDraws, gpuDraws, unknownOffset, ...acc, detail };',
  '  }',
  '',
  '  // S3: whole screen at depth 0 (an occluder at the near plane). Every cluster',
  '  // whose corners are all in front of the camera must be occluded.',
  '  {',
  '    const cam = makeCamera(0, false);',
  '    const depthTex = makeDepth(0.0, null);',
  '    const r = await step(cam, 500, depthTex);',
  '    let expectedOccluded = 0;',
  '    const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);',
  '    for (const c of clusterSet.clusters) {',
  '      let allInFront = true;',
  '      for (let i = 0; i < 8; i++) {',
  '        const v = new THREE.Vector4(',
  '          (i & 1) ? c.aabb[3] : c.aabb[0],',
  '          (i & 2) ? c.aabb[4] : c.aabb[1],',
  '          (i & 4) ? c.aabb[5] : c.aabb[2], 1);',
  '        v.applyMatrix4(vp);',
  '        if (v.w <= 0.0001) allInFront = false;',
  '      }',
  '      if (allInFront) expectedOccluded++;',
  '    }',
  '    out.scenarios.S3_nearPyramid = {',
  '      cpuDraws: r.cpuM.size, gpuDraws: r.gpuM.size,',
  '      expectedOccluded,',
  '      occludedBeyondCpu: r.cpuM.size - r.gpuM.size,',
  '      gpuFallback: r.gpuM.has(-1),',
  '      unknownOffset: r.unknownOffset,',
  '    };',
  '    depthTex.destroy();',
  '  }',
  '',
  '  // S4: a real occluder quad over the left half of the screen at depth 0.3, far',
  '  // elsewhere. Clusters whose texel footprint lies wholly outside the quad must',
  '  // NOT be culled (false occlusion == pop-out); clusters whose footprint lies',
  '  // wholly inside it and are nearer... further away must be culled.',
  '  {',
  '    const QZ = 0.3;',
  '    const QRECT = [-1.0, -1.0, 0.5, 1.0];',
  '    // QRECT is NDC; the footprint is screen-u in [0,1]. Mixing the two marks',
  '    // clusters sitting inside the quad as outside and invents a false occlusion.',
  '    const QU0 = (QRECT[0] + 1) * 0.5, QU1 = (QRECT[2] + 1) * 0.5;',
  '    const cam = makeCamera(0, false);',
  '    const depthTex = makeDepth(1.0, [QRECT[0], QRECT[1], QRECT[2], QRECT[3], QZ]);',
  '    const r = await step(cam, 700, depthTex);',
  '    const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);',
  '    const levels = tier._hzbLevels;',
  '    const v4 = new THREE.Vector4();',
  '    let mustNotCull = 0, mustCull = 0, ambiguous = 0, falseOcclusion = 0, missedOcclusion = 0;',
  '    for (let ci = 0; ci < clusterSet.clusters.length; ci++) {',
  '      const c = clusterSet.clusters[ci];',
  '      let minX = 1e30, maxX = -1e30, minY = 1e30, maxY = -1e30, minZ = 1.0, allInFront = true;',
  '      for (let i = 0; i < 8; i++) {',
  '        v4.set((i & 1) ? c.aabb[3] : c.aabb[0], (i & 2) ? c.aabb[4] : c.aabb[1], (i & 4) ? c.aabb[5] : c.aabb[2], 1).applyMatrix4(vp);',
  '        if (v4.w <= 0.0001) { allInFront = false; continue; }',
  '        const sx = v4.x / v4.w * 0.5 + 0.5, sy = v4.y / v4.w * 0.5 + 0.5, sz = v4.z / v4.w;',
  '        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);',
  '        minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);',
  '        minZ = Math.min(minZ, sz);',
  '      }',
  '      if (!allInFront) { ambiguous++; continue; }',
  '      minX = Math.max(0, Math.min(1, minX)); maxX = Math.max(0, Math.min(1, maxX));',
  '      minY = Math.max(0, Math.min(1, minY)); maxY = Math.max(0, Math.min(1, maxY));',
  '      const spanPx = Math.max((maxX - minX) * W, (maxY - minY) * H);',
  '      const level = Math.max(0, Math.min(levels - 1, Math.ceil(Math.log2(Math.max(spanPx, 1)))));',
  '      const lw = Math.max(1, Math.ceil(W / Math.pow(2, level)));',
  '      const lh = Math.max(1, Math.ceil(H / Math.pow(2, level)));',
  '      // grow by one texel so the footprint really covers every texel it touches',
  '      const gx0 = minX - 1 / lw, gx1 = maxX + 1 / lw, gy0 = minY - 1 / lh, gy1 = maxY + 1 / lh;',
  '      const insideQuad = gx0 >= QU0 && gx1 <= QU1;',
  '      const outsideQuad = gx0 >= QU1 || gx1 <= QU0;',
  '      const cpuDrew = r.cpuM.has(ci), gpuDrew = r.gpuM.has(ci);',
  '      if (insideQuad && minZ > QZ + 1e-5) {',
  '        mustCull++;',
  '        if (gpuDrew) missedOcclusion++;',
  '      } else if (outsideQuad) {',
  '        mustNotCull++;',
  '        if (cpuDrew && !gpuDrew) falseOcclusion++;',
  '      } else { ambiguous++; }',
  '    }',
  '    out.scenarios.S4_quadOccluder = {',
  '      mustNotCull, mustCull, ambiguous, falseOcclusion, missedOcclusion,',
  '      cpuDraws: r.cpuM.size, gpuDraws: r.gpuM.size,',
  '      occludedBeyondCpu: r.cpuM.size - r.gpuM.size,',
  '      unknownOffset: r.unknownOffset,',
  '    };',
  '    depthTex.destroy();',
  '  }',
  '',
  '  out.errors = errors;',
  '  out.tierStats = JSON.parse(JSON.stringify(tier.stats));',
  '  await device.destroy();',
  '  return out;',
  '};',
  'window.__hizReady = true;',
].join('\n');

const dump = argValue('dump-harness');
if (dump) { fs.writeFileSync(dump, HARNESS); console.log(`harness written to ${dump} (${HARNESS.length} bytes)`); process.exit(0); }

function serve() {
  return http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const send = (body, type) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
    try {
      if (url === '/' || url === '/index.html') {
        return send(
          '<!doctype html><html><head><meta charset="utf-8"><title>hiz parity</title>' +
          '<script type="importmap">{"imports":{"three":"/vendor/three.webgpu.js","three/webgpu":"/vendor/three.webgpu.js"}}</script>' +
          '</head><body>hiz parity' +
          '<script>window.__errs=[];window.addEventListener("error",function(e){window.__errs.push(String(e && e.message||e));});</script>' +
          '<script type="module" src="/harness.js"></script></body></html>',
          'text/html; charset=utf-8',
        );
      }
      if (url === '/harness.js') return send(HARNESS, 'application/javascript; charset=utf-8');
      if (url.startsWith('/vendor/')) {
        const file = path.join(REPO_ROOT, 'node_modules', 'three', 'build', path.basename(url));
        return send(fs.readFileSync(file), 'application/javascript; charset=utf-8');
      }
      if (url.startsWith('/src/')) {
        const name = path.basename(url);
        const file = path.join(SRC_DIR, name);
        return send(fs.readFileSync(file), 'application/javascript; charset=utf-8');
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      res.writeHead(500); res.end(String(e && e.message));
    }
  });
}

const checks = [];
function check(id, ok, detail) {
  checks.push({ id, ok, detail });
  console.log(`CHECK ${id} ${ok ? 'PASS' : 'FAIL'} ${detail}`);
}

async function main() {
  const server = serve();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const args = [
    ...gpuArgs({ accelerated: true }),
    ...vendorGpuArgs(VENDOR),
    '--enable-unsafe-webgpu',
    '--enable-features=WebGPU',
  ];
  const browser = await chromium.launch({ root: REPO_ROOT, owner: `${WITNESS}-${LABEL}`, args, leaseWaitMs: Number(process.env.HIZ_LEASE_WAIT_MS || 240000) });
  let out;
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e).split('\n')[0]));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const ready = await page.evaluate(() => !!window.__hizReady && typeof window.__hizParity === 'function');
    if (!ready) {
      const errs = await page.evaluate(() => window.__errs || []);
      const diag = await page.evaluate(async () => {
        const r = { resources: performance.getEntriesByType('resource').map((x) => [String(x.name).split('/').pop(), x.responseStatus || 0, x.transferSize]) };
        for (const u of ['/harness.js', '/vendor/three.webgpu.js', '/src/webgpu-hiz-tier.js', '/src/cluster-lod-mesh.js']) {
          try { const res = await fetch(u); r[u] = [res.status, res.headers.get('content-type'), (await res.text()).length]; } catch (e) { r[u] = ['err', String(e)]; }
        }
        try { await import('/harness.js'); r.imported = true; } catch (e) { r.importErr = String(e && e.message || e); }
        r.gpu = !!navigator.gpu;
        return r;
      });
      check('P00-harness-ready', false, `harness did not load; page=${JSON.stringify(pageErrors.slice(0, 5))} window=${JSON.stringify(errs.slice(0, 5))} diag=${JSON.stringify(diag)}`);
      console.log('RESULT: FAIL -- harness did not load');
      process.exitCode = 1;
      return;
    }
    out = await page.evaluate(() => window.__hizParity());
    out.pageErrors = pageErrors;
  } finally {
    await browser.close();
    server.close();
  }

  if (out.fatal) {
    check('P00-harness-ready', false, `harness returned fatal: ${out.fatal}`);
    console.log('RESULT: FAIL -- ' + out.fatal);
    process.exitCode = 1;
    return;
  }

  const adapter = out.adapter || {};
  const haystack = [adapter.vendor, adapter.architecture, adapter.device, adapter.description].filter(Boolean).join(' | ');
  const pat = VENDOR_PATTERNS[VENDOR] || new RegExp(VENDOR, 'i');
  check('P01-adapter-pinned', pat.test(haystack), `vendor=${VENDOR} adapter="${haystack}"`);
  check('P02-no-device-errors', (out.errors || []).length === 0, `${(out.errors || []).length} uncaptured device errors ${JSON.stringify((out.errors || []).slice(0, 3))}`);
  check('P03-hzb-levels', out.levels > 1, `_hzbLevels=${out.levels}`);

  const s0 = out.scenarios.S0_awayFallback || {};
  const s1 = out.scenarios.S1_noPyramid || {};
  const s2 = out.scenarios.S2_farPyramid || {};
  const s3 = out.scenarios.S3_nearPyramid || {};
  const s4 = out.scenarios.S4_quadOccluder || {};

  check('P04-S0-fallback-mirrored', s0.cpuCulledGpuDrawn === 0 && s0.gpuCulledCpuDrawn === 0 && s0.lodMismatch === 0,
    `cpuFallback=${s0.cpuFallback} gpuFallback=${s0.gpuFallback} cpuDraws=${s0.cpuDraws} gpuDraws=${s0.gpuDraws} disagree cpuCulledGpuDrawn=${s0.cpuCulledGpuDrawn} gpuCulledCpuDrawn=${s0.gpuCulledCpuDrawn} lodMismatch=${s0.lodMismatch}`);
  check('P05-S1-no-pyramid-parity', s1.cpuCulledGpuDrawn === 0 && s1.gpuCulledCpuDrawn === 0 && s1.lodMismatch === 0,
    `frames=${s1.frames} cpuDraws=${s1.cpuDraws} gpuDraws=${s1.gpuDraws} cpuCulledGpuDrawn=${s1.cpuCulledGpuDrawn} gpuCulledCpuDrawn=${s1.gpuCulledCpuDrawn} lodMismatch=${s1.lodMismatch}`);
  check('P06-S2-far-pyramid-parity', s2.cpuCulledGpuDrawn === 0 && s2.gpuCulledCpuDrawn === 0 && s2.lodMismatch === 0,
    `frames=${s2.frames} cpuDraws=${s2.cpuDraws} gpuDraws=${s2.gpuDraws} cpuCulledGpuDrawn=${s2.cpuCulledGpuDrawn} gpuCulledCpuDrawn=${s2.gpuCulledCpuDrawn} lodMismatch=${s2.lodMismatch}`);
  check('P07-S3-occlusion-engages', s3.occludedBeyondCpu === s3.expectedOccluded && s3.gpuDraws === 0,
    `expectedOccluded=${s3.expectedOccluded} occludedBeyondCpu=${s3.occludedBeyondCpu} cpuDraws=${s3.cpuDraws} gpuDraws=${s3.gpuDraws} gpuFallback=${s3.gpuFallback}`);
  check('P08-S4-no-false-occlusion', s4.falseOcclusion === 0,
    `mustNotCull=${s4.mustNotCull} falseOcclusion=${s4.falseOcclusion} cpuDraws=${s4.cpuDraws} gpuDraws=${s4.gpuDraws}`);
  check('P09-S4-real-occlusion-caught', s4.mustCull === 0 || s4.missedOcclusion === 0,
    `mustCull=${s4.mustCull} missedOcclusion=${s4.missedOcclusion} ambiguous=${s4.ambiguous} occludedBeyondCpu=${s4.occludedBeyondCpu}`);
  const unknown = (s0.unknownOffset || 0) + (s1.unknownOffset || 0) + (s2.unknownOffset || 0) + (s3.unknownOffset || 0) + (s4.unknownOffset || 0);
  check('P10-indirect-offsets-decoded', unknown === 0, `undecodable indirect args=${unknown}`);

  const failed = checks.filter((c) => !c.ok).length;
  const tag = `label=${LABEL} session=${SESSION} vendor=${VENDOR} src=${SRC_DIR}`;
  const line = `RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} -- ${checks.length - failed} of ${checks.length} checks passed ${tag}`;
  console.log(line);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `${WITNESS}-${LABEL}.txt`);
  fs.writeFileSync(outPath, [line, ...checks.map((c) => `CHECK ${c.id} ${c.ok ? 'PASS' : 'FAIL'} ${c.detail}`), '', JSON.stringify(out, null, 2)].join('\n') + '\n');
  fs.appendFileSync(LOG_PATH, `\n- [${WITNESS}/${LABEL}] ${line}\n  - out: .gm/witness-out/${WITNESS}-${LABEL}.txt\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.log('RESULT: FAIL -- ' + (e && e.message ? e.message : String(e)));
  process.exitCode = 1;
});
