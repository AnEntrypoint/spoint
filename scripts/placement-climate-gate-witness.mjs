import { resolve } from 'node:path'
import { loadWorldModule } from '../src/sdk/WorldLocator.js'
import { resolveTerrainConfig } from '../src/shared/terrainConfig.js'
import { loadPlanetSampler, planetSamplerOptsOf } from '../src/terrain/TerrainPhysics.js'
import { createPlanetFrame } from '../src/terrain/PlanetFrame.js'
import { createCachedAnchorField } from '../src/terrain/ClimateCache.js'
import { latticeFor } from '../src/terrain/PlacementChart.js'
import { placementsForChunk, VEG } from '../src/terrain/VegPlacement.js'
import { placementsForRockChunk, ROCK } from '../src/terrain/RockPlacement.js'
import { fnv1aString } from '../src/shared/fnv1a.js'

const CHUNK_COUNT = 120
const REPS = 3

const loaded = await loadWorldModule(resolve(process.cwd(), 'apps/world/tps-game.js'))
const tcfg = resolveTerrainConfig(loaded)
const sampler = await loadPlanetSampler(planetSamplerOptsOf(tcfg))
const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
const cached = createCachedAnchorField(sampler.anchorField, frame)
const directionOnly = cached
const localXZ = { ...cached, climateUsesLocalXZ: true }
const vegLattice = latticeFor(frame, VEG)
const rockLattice = latticeFor(frame, ROCK)

let seedX = 24680
const rand01 = () => { seedX = (seedX * 1103515245 + 12345) & 0x7fffffff; return seedX / 0x7fffffff }
const vegKeys = []
for (let i = 0; i < 900 && vegKeys.length < CHUNK_COUNT; i++) {
  const x = (rand01() - 0.5) * 6000, z = (rand01() - 0.5) * 6000
  const k = vegLattice.chunkKeyOfDir(...frame.localToDir(x, z))
  if (!vegKeys.includes(k)) vegKeys.push(k)
}
const rockKeys = []
for (let i = 0; i < 900 && rockKeys.length < CHUNK_COUNT; i++) {
  const x = (rand01() - 0.5) * 6000, z = (rand01() - 0.5) * 6000
  const k = rockLattice.chunkKeyOfDir(...frame.localToDir(x, z))
  if (!rockKeys.includes(k)) rockKeys.push(k)
}

const r6 = (v) => Math.round(v * 1e6) / 1e6
const flattenVeg = (p) => [r6(p.x), r6(p.y), r6(p.z), p.species, p.shape, r6(p.scale), r6(p.yaw), r6(p.windPhase),
  r6(p.tint[0]), r6(p.tint[1]), r6(p.tint[2]),
  r6(p.tiltQuat[0]), r6(p.tiltQuat[1]), r6(p.tiltQuat[2]), r6(p.tiltQuat[3]),
  r6(p.normal[0]), r6(p.normal[1]), r6(p.normal[2]), p.trunkId]
const flattenRock = (p) => [r6(p.x), r6(p.y), r6(p.z), p.type, r6(p.scale), r6(p.yaw), r6(p.squash), r6(p.variant),
  r6(p.normal[0]), r6(p.normal[1]), r6(p.normal[2]),
  r6(p.tiltQuat[0]), r6(p.tiltQuat[1]), r6(p.tiltQuat[2]), r6(p.tiltQuat[3]), p.rockId]

function dump(field) {
  const out = { veg: [], rock: [] }
  for (const k of vegKeys) out.veg.push(placementsForChunk(k, frame, field, tcfg.seed | 0).map(flattenVeg))
  for (const k of rockKeys) out.rock.push(placementsForRockChunk(k, frame, field, tcfg.seed | 0).map(flattenRock))
  return out
}

function compare(a, b, name) {
  let rows = 0, diffRows = 0, shapeDiff = 0, maxAbs = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i].length !== b[i].length) shapeDiff++
    for (let j = 0; j < Math.min(a[i].length, b[i].length); j++) {
      rows++
      for (let f = 0; f < a[i][j].length; f++) {
        const d = Math.abs(a[i][j][f] - b[i][j][f])
        if (d !== 0) { diffRows++; if (d > maxAbs) maxAbs = d }
      }
    }
  }
  console.log(`${name}: ${rows} placement(s) compared, ${diffRows} differing field(s), ${shapeDiff} chunk(s) with a different row count, maxAbsDelta ${maxAbs}`)
  return { rows, diffRows, shapeDiff, maxAbs }
}

const early = dump(directionOnly)
const late = dump(localXZ)
const veg = compare(early.veg, late.veg, 'veg climate gate')
const rock = compare(early.rock, late.rock, 'rock climate gate')
const digestEarly = fnv1aString(JSON.stringify(early)).toString(16)
const digestLate = fnv1aString(JSON.stringify(late)).toString(16)
console.log(`digest: direction-only ${digestEarly}, local-XZ ${digestLate}`)

const PLACEMENT_CPU_US_PER_CHUNK = 1000

function benchChunk(label, keys, run) {
  let cpuUs = 0
  let units = 0
  for (let attempt = 0; attempt < REPS; attempt++) {
    const cpu = process.cpuUsage()
    for (const k of keys) units += run(k).length
    const delta = process.cpuUsage(cpu)
    cpuUs += delta.user + delta.system
  }
  const usPerChunk = cpuUs / (keys.length * REPS)
  const placementsPerPass = units / REPS
  console.log(`${label}: ${usPerChunk.toFixed(1)} us of CPU per chunk over ${placementsPerPass} placement(s) per pass in ${keys.length} chunk(s) (mean of ${REPS})`)
  return { label, usPerChunk, usPerPlacement: usPerChunk * keys.length / Math.max(1, placementsPerPass), units: placementsPerPass, chunks: keys.length }
}

const vegEarly = benchChunk('veg, climate read before the surface solve', vegKeys, (k) => placementsForChunk(k, frame, directionOnly, tcfg.seed | 0))
const vegLate = benchChunk('veg, climate read after the surface solve ', vegKeys, (k) => placementsForChunk(k, frame, localXZ, tcfg.seed | 0))
const rockEarly = benchChunk('rock, climate read before the surface solve', rockKeys, (k) => placementsForRockChunk(k, frame, directionOnly, tcfg.seed | 0))
const rockLate = benchChunk('rock, climate read after the surface solve ', rockKeys, (k) => placementsForRockChunk(k, frame, localXZ, tcfg.seed | 0))
const quarterVeg = benchChunk('veg, a quarter of the chunks as the counted-unit control', vegKeys.slice(0, Math.floor(CHUNK_COUNT / 4)), (k) => placementsForChunk(k, frame, directionOnly, tcfg.seed | 0))

const arms = [vegEarly, vegLate, rockEarly, rockLate]
const uncounted = arms.filter(a => !(a.units > 0))
const overBudget = arms.filter(a => !(a.usPerChunk > 0) || a.usPerChunk > PLACEMENT_CPU_US_PER_CHUNK)

const identical = veg.diffRows === 0 && rock.diffRows === 0 && veg.shapeDiff === 0 && rock.shapeDiff === 0 && digestEarly === digestLate
const covered = veg.rows > 0 && rock.rows > 0
const counted = uncounted.length === 0 && overBudget.length === 0 && quarterVeg.units > 0 && quarterVeg.units < vegEarly.units
const bad = (identical ? 0 : 1) + (covered ? 0 : 1) + (counted ? 0 : 1)
if (!covered) console.error(`FAIL the climate gate compared ${veg.rows} veg and ${rock.rows} rock placement(s), so identical placements prove nothing`)
if (uncounted.length) console.error(`FAIL ${uncounted.map(a => a.label.trim()).join(', ')} counted 0 placement(s), so its CPU figure is a ratio over zero`)
if (overBudget.length) console.error(`FAIL ${overBudget.map(a => `${a.label.trim()} ${a.usPerChunk.toFixed(1)}`).join(', ')} exceed ${PLACEMENT_CPU_US_PER_CHUNK} us of CPU per chunk`)
if (!(quarterVeg.units > 0 && quarterVeg.units < vegEarly.units)) console.error(`FAIL the quarter-chunk control counted ${quarterVeg.units} placement(s) against ${vegEarly.units} for the full sweep, so the counted unit does not track the workload`)
console.log(`RESULT: ${bad === 0 ? 'PASS' : 'FAIL'} identical ${identical} over ${veg.rows} veg and ${rock.rows} rock placement(s); CPU per chunk veg ${vegEarly.usPerChunk.toFixed(1)}/${vegLate.usPerChunk.toFixed(1)} us, rock ${rockEarly.usPerChunk.toFixed(1)}/${rockLate.usPerChunk.toFixed(1)} us over ${vegEarly.units}/${vegLate.units}/${rockEarly.units}/${rockLate.units} placement(s) (quarter-chunk control ${quarterVeg.units} of ${vegEarly.units})`)
process.exit(bad === 0 ? 0 : 1)
