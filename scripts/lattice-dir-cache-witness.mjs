import { resolve } from 'node:path'
import { loadWorldModule } from '../src/sdk/WorldLocator.js'
import { resolveTerrainConfig } from '../src/shared/terrainConfig.js'
import { loadPlanetSampler, planetSamplerOptsOf } from '../src/terrain/TerrainPhysics.js'
import { createPlanetFrame } from '../src/terrain/PlanetFrame.js'
import { latticeFor } from '../src/terrain/PlacementChart.js'
import { VEG } from '../src/terrain/VegPlacement.js'

const SDK_ROOT = resolve(process.cwd())
const loaded = await loadWorldModule(resolve(SDK_ROOT, 'apps/world/tps-game.js'))
const tcfg = resolveTerrainConfig(loaded)
const sampler = await loadPlanetSampler(planetSamplerOptsOf(tcfg))
const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
const lattice = latticeFor(frame, VEG)
const N = lattice.chunksPerFace
let sx = 12345
const r01 = () => { sx = (sx * 1103515245 + 12345) & 0x7fffffff; return sx / 0x7fffffff }
const a = [0, 0, 0], b = [0, 0, 0]
let bad = 0
let checked = 0
for (let i = 0; i < 200000; i++) {
  const key = lattice.chunkKeyOfDir(...frame.localToDir((r01() - 0.5) * 40000, (r01() - 0.5) * 40000))
  lattice.chunkCentreDir(key, a)
  lattice.chunkCornerDir(key, 0.5, 0.5, b)
  checked++
  for (let k = 0; k < 3; k++) if (a[k] !== b[k]) { bad++; break }
  if (i % 7 === 0) lattice.chunkCentreDir(key, a)
}
console.log(`chunkCentreDir vs uncached chunkCornerDir: ${checked} key(s), ${bad} mismatch(es)`)

let ringBad = 0
let ringKeys = 0
let ringCalls = 0
for (let i = 0; i < 200; i++) {
  const d = frame.localToDir((r01() - 0.5) * 40000, (r01() - 0.5) * 40000)
  const ring = lattice.ringAroundDir(d[0], d[1], d[2], 74)
  ringCalls++
  const seen = new Set()
  for (const key of ring) {
    ringKeys++
    if (seen.has(key)) ringBad++
    seen.add(key)
    lattice.chunkCentreDir(key, a)
    const len = Math.hypot(a[0], a[1], a[2])
    if (Math.abs(len - 1) > 1e-9) ringBad++
    const chord = Math.hypot(a[0] - d[0], a[1] - d[1], a[2] - d[2])
    if (chord > 2 * Math.sin((74 / frame.radius) / 2) + 1e-12) ringBad++
  }
}
console.log(`ring key/unit-radius/chord violations: ${ringBad} over ${ringKeys} key(s) in ${ringCalls} ring(s)`)

const failures = []
if (checked === 0) failures.push(`no chunk key was compared, so the centre/corner agreement proved nothing`)
if (ringKeys === 0) failures.push(`ringAroundDir returned no key across ${ringCalls} ring(s), so the ring invariants proved nothing`)
if (bad !== 0) failures.push(`${bad} chunkCentreDir/chunkCornerDir mismatch(es) over ${checked} key(s)`)
if (ringBad !== 0) failures.push(`${ringBad} ring key/unit-radius/chord violation(s) over ${ringKeys} key(s)`)
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`)
  console.log(`RESULT: FAIL (${failures.length} check(s))`)
  process.exit(1)
}
console.log(`RESULT: PASS -- ${checked} chunk key(s) agree and ${ringKeys} ring key(s) across ${ringCalls} ring(s) hold the unit-radius and chord bounds`)
process.exit(0)
