import fs from 'node:fs'
import path from 'node:path'
import { withGpuPage, drainedSampleGroundMExpr } from './lib/gpu-eval.mjs'

function parseArgs(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) { const t = argv[i]; if (t.startsWith('--')) { const k = t.slice(2); const n = argv[i + 1]; if (n === undefined || n.startsWith('--')) a[k] = true; else { a[k] = n; i++ } } else a._.push(t) }
  return a
}
const args = parseArgs(process.argv.slice(2))
const PORT = Number(args.port || process.env.PORT || 8090), ANGLE = args.angle || process.env.ANGLE || 'd3d11'
const EXTENT = Number(args.extent || 512), RES = Number(args.res || 16)
const CENTER = (args.center ? args.center.split(',').map(Number) : [0, 0])
const OUT = args.out || 'data/heightfield.json'

const out = await withGpuPage({ port: PORT, angle: ANGLE }, async (evalIn, { vendor }) => {
  console.error(`[bake] backend=${ANGLE} renderer=${vendor}`)
  const meta = await evalIn('(()=>{const f=window.__terrain.frame;return {anchorDir:f.anchorDir,radius:f.radius,anchorHeight:f.anchorHeight,reliefScale:f.reliefScale};})()')
  const N = Math.max(2, Math.round(EXTENT / RES) + 1), half = EXTENT / 2, step = EXTENT / (N - 1)
  console.error(`[bake] grid N=${N} step=${step.toFixed(2)}m extent=${EXTENT} center=${CENTER} -> ${N * N} GPU samples`)
  const heights = new Array(N * N)
  let done = 0
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const x = CENTER[0] - half + ix * step, z = CENTER[1] - half + iz * step
    const dirExpr = `window.__terrain.frame.localToDir(${x},${z})`
    const h = await evalIn(`(async()=>{ const f=window.__terrain.frame; const abs=await ${drainedSampleGroundMExpr(dirExpr)};
      if(!isFinite(abs)) return null; const R=f.radius, r2=${x}*${x}+${z}*${z}, s=r2/(R*R), sq=Math.sqrt(1+s), drop=r2/R/((sq+1)*sq);
      return (abs - f.anchorHeight) - drop; })()`)
    heights[iz * N + ix] = (typeof h === 'number' && isFinite(h)) ? +h.toFixed(4) : null
    if (++done % 50 === 0) console.error(`[bake] ${done}/${N * N}`)
  }
  return { meta, N, heights }
}).catch(e => { console.error('[bake] error:', e.message); process.exit(1) })

const { meta, N, heights } = out.result
const nNull = heights.filter(h => h == null).length
const heightsOrZero = heights.map(h => (typeof h === 'number' && isFinite(h)) ? h : 0)
const base = { anchorDir: meta.anchorDir, radius: meta.radius, reliefScale: meta.reliefScale, anchorHeight: meta.anchorHeight, extent: EXTENT, resolution: RES, N, center: CENTER, backend: ANGLE }

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
  const ab = encodeHeightfield(artifact)
  fs.writeFileSync(OUT, Buffer.from(ab))
} else {
  fs.writeFileSync(OUT, JSON.stringify(artifact))
}
const bytes = fs.statSync(OUT).size
console.error(`[bake] wrote ${OUT} (N=${N}, ${N * N} samples, ${nNull} null, ${NODES_PER_SECTOR > 0 ? 'sectorized ' + NODES_PER_SECTOR + 'n/' + (args.bits || 8) + 'bit' : 'flat float'}, ${binary ? 'BINARY' : 'json'}, ${bytes}B)`)
console.log(JSON.stringify({ out: OUT, N, samples: N * N, nullCount: nNull, bytes, sectorized: NODES_PER_SECTOR > 0, binary, anchorHeight: meta.anchorHeight }))
