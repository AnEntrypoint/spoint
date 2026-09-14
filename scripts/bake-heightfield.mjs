import fs from 'node:fs'
import path from 'node:path'
import { withGpuPage } from './lib/gpu-eval.mjs'

function parseArgs(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) { const t = argv[i]; if (t.startsWith('--')) { const k = t.slice(2); const n = argv[i + 1]; if (n === undefined || n.startsWith('--')) a[k] = true; else { a[k] = n; i++ } } else a._.push(t) }
  return a
}
const args = parseArgs(process.argv.slice(2))
const PORT = Number(args.port || process.env.PORT || 8090)
const EXTENT = Number(args.extent || 512), RES = Number(args.res || 16)
const CENTER = (args.center ? args.center.split(',').map(Number) : [0, 0])
const OUT = args.out || 'data/heightfield.json'
const WORLD = args.world || null
const PROBE_READY_MS = Number(process.env.GPU_EVAL_READY_MS || 90000)

function bakeHeightfieldScript({ N, half, step, center }) {
  return `
const f = __t.frame;
const probeWaitStart = Date.now();
while (__R.sampleGroundMSync(f.up) == null && Date.now() - probeWaitStart < ${PROBE_READY_MS}) await new Promise(r => setTimeout(r, 250));
if (__R.sampleGroundMSync(f.up) == null) return { __error: 'GPU height probe never compiled within ${PROBE_READY_MS} ms' };
const heights = new Array(${N * N});
for (let iz = 0; iz < ${N}; iz++) for (let ix = 0; ix < ${N}; ix++) {
  const y = f.solveSurfaceY(${center[0] - half} + ix * ${step}, ${center[1] - half} + iz * ${step}, (d) => __R.sampleGroundMSync(d));
  heights[iz * ${N} + ix] = (y == null || !Number.isFinite(y)) ? null : +y.toFixed(4);
}
if (window.__renderer && window.__renderer.resetState) window.__renderer.resetState();
const gl = document.querySelector('canvas') && document.querySelector('canvas').getContext('webgl2');
const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
return { meta: { anchorDir: f.anchorDir, radius: f.radius, anchorHeight: f.anchorHeight, reliefScale: f.reliefScale }, heights, vendor: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null };
`.trim()
}

const N = Math.max(2, Math.round(EXTENT / RES) + 1), half = EXTENT / 2, step = EXTENT / (N - 1)
console.error(`[bake] grid N=${N} step=${step.toFixed(2)}m extent=${EXTENT} center=${CENTER} -> ${N * N} exact render-inverse GPU samples`)
const url = WORLD ? `http://localhost:${PORT}/?singleplayer&world=${encodeURIComponent(WORLD)}&nc=${Date.now()}` : undefined
const out = await withGpuPage({ port: PORT, url }, async (run) => (await run(bakeHeightfieldScript({ N, half, step, center: CENTER }))).result)
  .catch(e => { console.error('[bake] error:', e.message); process.exit(1) })

const { meta, heights, vendor } = out
console.error(`[bake] renderer=${vendor}`)
const nNull = heights.filter(h => h == null).length
const heightsOrZero = heights.map(h => (typeof h === 'number' && isFinite(h)) ? h : 0)
const base = { anchorDir: meta.anchorDir, radius: meta.radius, reliefScale: meta.reliefScale, anchorHeight: meta.anchorHeight, extent: EXTENT, resolution: RES, N, center: CENTER, backend: vendor }

let artifact
const NODES_PER_SECTOR = Number(args.sector || 0)
if (NODES_PER_SECTOR > 0) {
  const Sn = NODES_PER_SECTOR, gridS = Math.ceil(N / Sn), bits = Number(args.bits || 8), qmax = (1 << bits) - 1
  const sectorMin = new Array(gridS * gridS).fill(Infinity), sectorMax = new Array(gridS * gridS).fill(-Infinity)
  const sidx = (ix, iz) => Math.min((iz / Sn) | 0, gridS - 1) * gridS + Math.min((ix / Sn) | 0, gridS - 1)
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) { const si = sidx(ix, iz), v = heightsOrZero[iz * N + ix]; if (v < sectorMin[si]) sectorMin[si] = v; if (v > sectorMax[si]) sectorMax[si] = v }
  const q = new Array(N * N)
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) { const si = sidx(ix, iz), lo = sectorMin[si], hi = sectorMax[si], v = heightsOrZero[iz * N + ix]; q[iz * N + ix] = (hi > lo) ? Math.round((v - lo) / (hi - lo) * qmax) : 0 }
  artifact = { ...base, sectors: { gridS, nodesPerSector: Sn, qmax, bits }, sectorMin: sectorMin.map(v => +v.toFixed(3)), sectorMax: sectorMax.map(v => +v.toFixed(3)), q }
} else {
  artifact = { ...base, heights: heightsOrZero.map(h => +h.toFixed(4)) }
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
const binary = /\.hf$/i.test(OUT) || args.binary
if (binary) {
  if (!artifact.sectors) { console.error('[bake] --binary requires --sector S (binary format is sector-quant only)'); process.exit(2) }
  const { encodeHeightfield } = await import('mapspinner/heightfield-codec')
  fs.writeFileSync(OUT, Buffer.from(encodeHeightfield(artifact)))
} else {
  fs.writeFileSync(OUT, JSON.stringify(artifact))
}
const bytes = fs.statSync(OUT).size
console.error(`[bake] wrote ${OUT} (N=${N}, ${N * N} samples, ${nNull} null, ${NODES_PER_SECTOR > 0 ? 'sectorized ' + NODES_PER_SECTOR + 'n/' + (args.bits || 8) + 'bit' : 'flat float'}, ${binary ? 'BINARY' : 'json'}, ${bytes}B)`)
console.log(JSON.stringify({ out: OUT, N, samples: N * N, nullCount: nNull, bytes, sectorized: NODES_PER_SECTOR > 0, binary, anchorHeight: meta.anchorHeight }))
