#!/usr/bin/env node
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from './lib/cdp-browser.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const REV = process.env.PROBE_REV || null
const PAGE_PATH = '/__gpu-cull-draw-count.mjs'
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.html': 'text/html' }

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>gpu-cull-draw-count</title>
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.webgpu.js","three/webgpu":"/node_modules/three/build/three.webgpu.js"}}</script>
</head><body style="margin:0;background:#000">
<script type="module" src="${PAGE_PATH}"></script>
</body></html>`

const PAGE_SOURCE = `
import * as THREE from 'three';
import { ClusterLodMesh } from '/packages/streaming-gltf/src/cluster-lod-mesh.js';
import { WebGpuHizTier } from '/packages/streaming-gltf/src/webgpu-hiz-tier.js';

const W = 1280, H = 720;
const NON_COMPACT_LOD0 = 4194307;
const GRID_COLS = 8, GRID_ROWS = 8;

const POSES = [
  { name: 'front-center', eye: [0, 0, 0], target: [0, 0, -1] },
  { name: 'front-left', eye: [-15, 0, 0], target: [0, 0, -1] },
  { name: 'front-right', eye: [15, 0, 0], target: [0, 0, -1] },
  { name: 'high-looking-down', eye: [0, 40, 0], target: [0, 0, -50] },
  { name: 'close-to-grid', eye: [0, 0, -8], target: [0, 0, -60] },
  { name: 'facing-away', eye: [0, 0, 0], target: [0, 0, 1] },
  { name: 'far-behind-grid', eye: [0, 0, -200], target: [0, 0, -300] },
  { name: 'grazing-side', eye: [40, 0, -40], target: [-40, 0, -40] },
];

function buildClusterSet() {
  const clusters = [];
  for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
    const x = (i % GRID_COLS) * 6 - 21;
    const z = -10 - Math.floor(i / GRID_COLS) * 12;
    clusters.push({ aabb: [x - 1, -1, z - 1, x + 1, 1, z + 1], sphere: [x, 0, z, 1.7], lods: [{ offset: 3 * i, count: 3, stream: 0 }] });
  }
  return { version: 2, lodCount: 1, coarseIndexAccessor: -1, coarseIndexCount: 0, materialBucket: null, clusters };
}

function cameraFor(pose) {
  const cam = new THREE.PerspectiveCamera(60, W / H, 0.1, 1000);
  cam.position.set(...pose.eye);
  cam.lookAt(...pose.target);
  cam.updateMatrixWorld(true);
  return cam;
}

async function main() {
  const report = { rows: [], error: null, summary: null };
  window.__gpuCullDrawCount = report;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  document.body.appendChild(canvas);
  try {
    report.hasNavigatorGpu = !!navigator.gpu;
    if (!navigator.gpu) throw new Error('navigator.gpu is absent: this browser has no WebGPU');
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
    await renderer.init();
    report.backend = renderer.backend ? renderer.backend.constructor.name : null;
    const tier = new WebGpuHizTier(renderer, {});
    report.supported = tier.supported();
    await tier.ensurePipelinesValidated();
    report.pipelinesValidated = tier.stats.pipelinesValidated;

    const index = new Uint32Array(NON_COMPACT_LOD0);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    const mesh = new ClusterLodMesh(geometry, new THREE.MeshBasicMaterial(), buildClusterSet(), { lod0Count: NON_COMPACT_LOD0, screenHeight: H });
    mesh.updateMatrixWorld(true);
    report.compact = mesh._compact;
    report.clusters = mesh.clusterSet.clusters.length;
    report.indirectAttached = !!tier.attachIndirect(mesh);

    let frame = 0;
    const fakeRenderer = { info: { render: { frame: 0 } }, getDrawingBufferSize: (v) => v.set(W, H) };
    for (const pose of POSES) {
      const cam = cameraFor(pose);
      frame += 1;
      fakeRenderer.info.render.frame = frame;
      mesh._render(fakeRenderer, null, cam, geometry);
      const cpuGroups = geometry.groups.length;
      const cpuIndices = geometry.groups.reduce((sum, g) => sum + g.count, 0);
      const cullReturn = tier.cullAndBuildIndirect(mesh, cam, { screenHeight: H });
      const gpuDraws = await tier.readCountForDebug(mesh);
      report.rows.push({ pose: pose.name, cpuGroups, cpuIndices, gpuDraws, cullReturn, match: gpuDraws === cpuGroups });
    }
    const mismatches = report.rows.filter((r) => !r.match).length;
    report.summary = {
      poses: report.rows.length,
      gpuDrawsTotal: report.rows.reduce((s, r) => s + r.gpuDraws, 0),
      cpuGroupsTotal: report.rows.reduce((s, r) => s + r.cpuGroups, 0),
      mismatches,
    };
    tier.dispose();
  } catch (err) {
    report.error = String((err && err.stack) || err);
  }
  report.done = true;
}

main();
`

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
    res.end(PAGE_HTML)
    return
  }
  if (url.pathname === PAGE_PATH) {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' })
    res.end(PAGE_SOURCE)
    return
  }
  const file = resolve(join(ROOT, decodeURIComponent(url.pathname)))
  if (!file.startsWith(ROOT + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(sourceFor(url.pathname.slice(1), file))
})

function sourceFor(rel, file) {
  if (!REV) return readFileSync(file)
  try {
    return execFileSync('git', ['-C', ROOT, 'show', `${REV}:${rel}`], { maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return readFileSync(file)
  }
}

const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--ignore-gpu-blocklist']
const POLL_MS = 500
const DEADLINE_MS = 180000

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/`
const browser = await chromium.launch({ args: GPU_ARGS })
let exitCode = 1
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  const started = Date.now()
  let report = null
  while (Date.now() - started < DEADLINE_MS) {
    report = await page.evaluate(() => (window.__gpuCullDrawCount && window.__gpuCullDrawCount.done ? window.__gpuCullDrawCount : null))
    if (report) break
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  if (!report) {
    console.log('[gpu-cull-draw-count] RESULT: FAIL the page did not finish within the deadline')
  } else {
    console.log(JSON.stringify(report, null, 2))
    const ok = !report.error && report.summary && report.summary.mismatches === 0 && report.summary.gpuDrawsTotal > 0
    if (report.summary) console.log(`[gpu-cull-draw-count] GPU draw count total ${report.summary.gpuDrawsTotal} over ${report.summary.poses} poses; CPU groups total ${report.summary.cpuGroupsTotal}; mismatches ${report.summary.mismatches}`)
    console.log(ok ? 'RESULT: PASS every pose: GPU draw count equals the CPU group count' : 'RESULT: FAIL')
    exitCode = ok ? 0 : 1
  }
} finally {
  await browser.close()
  server.close()
}
process.exit(exitCode)
