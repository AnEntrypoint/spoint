import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { withGpuPage } from './lib/gpu-eval.mjs'
import { findWorldFile, worldRoots } from '../src/sdk/WorldLocator.js'
import { expandWorldPresets } from '../src/shared/worldPresets.js'
import { resolveTerrainConfig, terrainBakeKey, terrainHashVersionOf, terrainCarvesOf, LEGACY_TERRAIN_HASH_VERSION } from '../src/shared/terrainConfig.js'
import { createPlanetFrame } from '../src/terrain/PlanetFrame.js'
import { HEIGHTFIELD_BAKE_CODE_VERSION } from '../src/static/BakeCodeVersion.js'

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
const WORLD = args.world === true ? (() => { throw new Error('[bake] --world needs a world name, e.g. --world tps-game') })() : (args.world || null)
const PROBE_READY_MS = Number(process.env.GPU_EVAL_READY_MS || 90000)

function bakeHeightfieldScript({ N, half, step, center }) {
  return `
const f = __t.frame;
if ((f.hashVersion ?? 1) !== 1) return { __error: 'terrain hashVersion ' + f.hashVersion + ': the GLSL probe draws only hashVersion 1 (no integer hash, no carve term); bake it from the CPU height sampler instead, which this script selects automatically when --world resolves to it' };
const probeWaitStart = Date.now();
while (__R.sampleGroundMSync(f.up) == null && Date.now() - probeWaitStart < ${PROBE_READY_MS}) await new Promise(r => setTimeout(r, 250));
if (__R.sampleGroundMSync(f.up) == null) return { __error: 'GPU height probe never compiled within ${PROBE_READY_MS} ms' };
const heights = new Array(${N * N});
for (let iz = 0; iz < ${N}; iz++) for (let ix = 0; ix < ${N}; ix++) {
  const y = f.solveSurfaceY(${center[0] - half} + ix * ${step}, ${center[1] - half} + iz * ${step}, (d) => __R.sampleGroundMSync(d), 1e-3);
  heights[iz * ${N} + ix] = (y == null || !Number.isFinite(y)) ? null : +y.toFixed(4);
}
if (window.__renderer && window.__renderer.resetState) window.__renderer.resetState();
const gl = document.querySelector('canvas') && document.querySelector('canvas').getContext('webgl2');
const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
return { meta: { anchorDir: f.anchorDir, radius: f.radius, anchorHeight: f.anchorHeight, reliefScale: f.reliefScale, chartEpoch: f.chartEpoch ?? 0 }, heights, vendor: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null };
`.trim()
}

const QUANT_BITS = [8, 16]
function assertQuantBits(bits) {
  if (!QUANT_BITS.includes(bits)) throw new RangeError(`[bake] --bits must be ${QUANT_BITS.join(' or ')}, got ${bits}: the loader reads q as a Uint8Array or Uint16Array`)
  return bits
}

const N = Math.max(2, Math.round(EXTENT / RES) + 1), half = EXTENT / 2, step = EXTENT / (N - 1)

async function resolveWorldTerrain(worldName) {
  if (!worldName) return null
  const worldFile = findWorldFile(worldName, worldRoots(process.cwd()))
  if (!worldFile) throw new Error(`[bake] world "${worldName}" not found under ${worldRoots(process.cwd()).join(', ')}`)
  const mod = await import(pathToFileURL(worldFile).href)
  return resolveTerrainConfig(expandWorldPresets(mod.default || mod))
}

const worldTerrain = await resolveWorldTerrain(WORLD)
if (!worldTerrain) throw new Error('[bake] --world <name> is required: the world decides hashVersion, carves and the terrainKey the loader checks')
const hashVersion = terrainHashVersionOf(worldTerrain)
console.error(`[bake] grid N=${N} step=${step.toFixed(2)}m extent=${EXTENT} center=${CENTER} -> ${N * N} samples of terrain hashVersion ${hashVersion} via ${hashVersion === LEGACY_TERRAIN_HASH_VERSION ? 'the GLSL GPU probe' : 'the CPU height sampler'}`)

async function bakeFromCpuSampler() {
  if (!worldTerrain) throw new Error(`[bake] the GLSL probe draws only hashVersion ${LEGACY_TERRAIN_HASH_VERSION} (no integer hash, no carve term), so a hashVersion ${hashVersion} bake has to come from the CPU height sampler, which needs --world <name>`)
  const { createHeightSampler } = await import('mapspinner/height-cpu')
  const anchorDir = worldTerrain.anchorDir || [0, 1, 0]
  const sampler = await createHeightSampler({ radius: worldTerrain.radius, seed: worldTerrain.seed, reliefScale: worldTerrain.reliefScale, hashVersion, carves: terrainCarvesOf(worldTerrain) })
  const frame = createPlanetFrame({ sampler, anchorDir, offsetY: 0, reliefScale: worldTerrain.reliefScale })
  const heights = new Array(N * N)
  const prevRowY = new Float64Array(N).fill(NaN)
  const t0 = Date.now()
  for (let iz = 0; iz < N; iz++) {
    let prevY = prevRowY[0]
    for (let ix = 0; ix < N; ix++) {
      const y = frame.groundHeightLocal(CENTER[0] - half + ix * step, CENTER[1] - half + iz * step, prevY)
      const ok = y != null && Number.isFinite(y)
      prevRowY[ix] = ok ? y : NaN
      prevY = ok ? y : NaN
      heights[iz * N + ix] = ok ? +y.toFixed(4) : null
    }
  }
  console.error(`[bake] CPU height sampler: ${N * N} samples in ${Date.now() - t0}ms`)
  return { meta: { anchorDir, radius: worldTerrain.radius, anchorHeight: frame.anchorHeight, reliefScale: worldTerrain.reliefScale, chartEpoch: frame.chartEpoch ?? 0 }, heights, vendor: 'cpu-sampler' }
}

const out = hashVersion === LEGACY_TERRAIN_HASH_VERSION
  ? await withGpuPage({ port: PORT, url: WORLD ? `http://localhost:${PORT}/?singleplayer&legacygl=1&world=${encodeURIComponent(WORLD)}&nc=${Date.now()}` : undefined }, async (run) => run(bakeHeightfieldScript({ N, half, step, center: CENTER })))
    .catch(e => { console.error('[bake] error:', e.message); process.exit(1) })
  : await bakeFromCpuSampler()

const { meta, heights, vendor } = out
console.error(`[bake] height source=${vendor}`)
const nNull = heights.filter(h => h == null).length
const heightsOrZero = heights.map(h => (typeof h === 'number' && isFinite(h)) ? h : 0)
const terrainIdentity = worldTerrain ? { seed: worldTerrain.seed, hashVersion: terrainHashVersionOf(worldTerrain), terrainKey: terrainBakeKey(worldTerrain) } : {}
const base = { chartEpoch: meta.chartEpoch ?? 0, anchorDir: meta.anchorDir, radius: meta.radius, reliefScale: meta.reliefScale, anchorHeight: meta.anchorHeight, extent: EXTENT, resolution: RES, N, center: CENTER, backend: vendor, codeVersion: HEIGHTFIELD_BAKE_CODE_VERSION, ...terrainIdentity }

let artifact
const NODES_PER_SECTOR = Number(args.sector || 0)
if (NODES_PER_SECTOR > 0) {
  const Sn = NODES_PER_SECTOR, gridS = Math.ceil(N / Sn), bits = assertQuantBits(Number(args.bits || 8)), qmax = (1 << bits) - 1
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
