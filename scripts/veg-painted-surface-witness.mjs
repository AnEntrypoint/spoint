import { resolve } from 'node:path'
import { loadWorldModule } from '../src/sdk/WorldLocator.js'
import { resolveTerrainConfig } from '../src/shared/terrainConfig.js'
import { loadPlanetSampler, planetSamplerOptsOf } from '../src/terrain/TerrainPhysics.js'
import { createPlanetFrame } from '../src/terrain/PlanetFrame.js'
import { createCachedAnchorField } from '../src/terrain/ClimateCache.js'
import { latticeFor, tangentFrame, radialSlopeAt, climateAt } from '../src/terrain/PlacementChart.js'
import { paintedWeightsFor, paintedSlopeOf } from '../src/terrain/PaintedWeights.js'
import { placementsForChunk, classify, createPlacementCell, placementCellAt, VEG, SPECIES } from '../src/terrain/VegPlacement.js'
import { placementsForGrassChunk, GRASS } from '../src/terrain/GrassPlacement.js'
import { fnv1aString } from '../src/shared/fnv1a.js'

const CHUNK_COUNT = 120
const SPAN_M = 4000

const loaded = await loadWorldModule(resolve(process.cwd(), 'apps/world/tps-game.js'))
const tcfg = resolveTerrainConfig(loaded)
const sampler = await loadPlanetSampler(planetSamplerOptsOf(tcfg))
const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
const field = createCachedAnchorField(sampler.anchorField, frame)
const vegLattice = latticeFor(frame, VEG)
const grassLattice = latticeFor(frame, GRASS)
const weights = paintedWeightsFor(frame.hashVersion)

let seedX = 13571
const rand01 = () => { seedX = (seedX * 1103515245 + 12345) & 0x7fffffff; return seedX / 0x7fffffff }
const dirKeys = (lattice, n) => {
  const out = []
  for (let i = 0; i < 900 && out.length < n; i++) {
    const x = (rand01() - 0.5) * SPAN_M * 2, z = (rand01() - 0.5) * SPAN_M * 2
    const k = lattice.chunkKeyOfDir(...frame.localToDir(x, z))
    if (!out.includes(k)) out.push(k)
  }
  return out
}
const vegKeys = dirKeys(vegLattice, CHUNK_COUNT)
const grassKeys = dirKeys(grassLattice, CHUNK_COUNT)

const r6 = (v) => Math.round(v * 1e6) / 1e6
const flattenVeg = (p) => [r6(p.x), r6(p.y), r6(p.z), p.species, p.shape, r6(p.scale), r6(p.yaw), r6(p.windPhase),
  r6(p.tint[0]), r6(p.tint[1]), r6(p.tint[2]),
  r6(p.tiltQuat[0]), r6(p.tiltQuat[1]), r6(p.tiltQuat[2]), r6(p.tiltQuat[3]),
  r6(p.normal[0]), r6(p.normal[1]), r6(p.normal[2]), p.trunkId]

function surfaceOf(frame, cell, out) {
  const elev = cell.rho - frame.radius
  const tf = tangentFrame(frame, cell.dir[0], cell.dir[1], cell.dir[2])
  const slope = radialSlopeAt(frame, tf, cell.rho, VEG.SLOPE_D)
  const clim = climateAt(field, cell.at[0], cell.at[2], cell.dir)
  const w = weights(cell.dir, elev, paintedSlopeOf(slope[0], slope[1]), clim?.temp ?? 0.5, clim?.humidity ?? 0.5)
  out.elev = elev
  out.grass = w.grass; out.rock = w.rock; out.sand = w.sand; out.snow = w.snow
  return out
}

function dump() {
  const surface = { elev: 0, grass: 0, rock: 0, sand: 0, snow: 0 }
  const rows = []
  const tally = { grass: 0, rock: 0, sand: 0, snow: 0 }
  let snowDominant = 0, bareSand = 0, bushes = 0, bushOnSnow = 0
  let cellsSampled = 0, snowCellsAll = 0, bareCellsAll = 0
  for (const key of vegKeys) {
    const dec = vegLattice.decodeChunk(key, [0, 0, 0])
    const seed = (tcfg.seed | 0) ^ 0x7eed
    const cell = createPlacementCell(frame)
    for (let gz = 0; gz < VEG.GRID; gz++) {
      for (let gx = 0; gx < VEG.GRID; gx++) {
        placementCellAt(frame, vegLattice, dec, gx, gz, seed, VEG.JITTER / VEG.CELL, 0, 1, cell)
        const p = classify(frame, field, cell)
        const s = surfaceOf(frame, cell, surface)
        const snow = s.snow > s.grass && s.snow > s.rock && s.snow > s.sand
        const bare = s.grass < 0.08 && s.sand > 0.5
        cellsSampled++
        if (snow) snowCellsAll++
        if (bare) bareCellsAll++
        if (!p) continue
        rows.push(flattenVeg(p))
        if (snow) { snowDominant++; tally.snow++ } else if (s.sand > s.grass && s.sand > s.rock) tally.sand++
        else if (s.rock > s.grass) tally.rock++
        else tally.grass++
        if (bare) bareSand++
        if (SPECIES[p.species].startsWith('Bush')) { bushes++; if (snow) bushOnSnow++ }
      }
    }
  }
  return { rows, tally, snowDominant, bareSand, bushes, bushOnSnow, cellsSampled, snowCellsAll, bareCellsAll }
}

const first = dump()
const second = dump()
const digestA = fnv1aString(JSON.stringify(first.rows)).toString(16)
const digestB = fnv1aString(JSON.stringify(second.rows)).toString(16)

let grassCount = 0
for (const k of grassKeys) grassCount += placementsForGrassChunk(k, frame, field, tcfg.seed | 0).length

const checks = [
  ['the sample contains snow-dominant cells for the placement test to reject', first.snowCellsAll > 0, `${first.snowCellsAll} of ${first.cellsSampled} sampled cell(s)`],
  ['the sample contains bare painted sand for the placement test to reject', first.bareCellsAll > 0, `${first.bareCellsAll} of ${first.cellsSampled} sampled cell(s)`],
  ['no vegetation on a snow-dominant painted surface', first.snowDominant === 0, `placed on ${first.snowDominant} of ${first.snowCellsAll}`],
  ['no vegetation on bare painted sand', first.bareSand === 0, `placed on ${first.bareSand} of ${first.bareCellsAll}`],
  ['placement is deterministic across runs', digestA === digestB, `digest ${digestA} vs ${digestB}`],
  ['grass still places where vegetation does', grassCount > 0, `grass ${grassCount}`],
  ['bushes still place somewhere', first.bushes > 0, `bushes ${first.bushes}`],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} (${detail})`)
}
console.log(`veg ${first.rows.length} placement(s) over ${vegKeys.length} chunk(s): grass ${first.tally.grass} rock ${first.tally.rock} sand ${first.tally.sand} snow ${first.tally.snow}; bushes ${first.bushes} of which on snow ${first.bushOnSnow}; grass placements ${grassCount}; digest ${digestA}`)
console.log(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} -- ${first.rows.length} placement(s) over ${first.cellsSampled} cell(s), of which ${first.snowCellsAll} snow-dominant carrying ${first.snowDominant} and ${first.bareCellsAll} bare-sand carrying ${first.bareSand}; determinism ${digestA === digestB}`)
process.exit(failed === 0 ? 0 : 1)
