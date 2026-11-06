import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { createPlanetFrame } = await import('../src/terrain/PlanetFrame.js')
const { placementsForRockChunk, ROCK } = await import('../src/terrain/RockPlacement.js')
const { placementsForChunk, VEG } = await import('../src/terrain/VegPlacement.js')
const { latticeFor, chunkKeyAtLocal } = await import('../src/terrain/PlacementChart.js')
const { createModelExclusionField } = await import('../src/terrain/ModelExclusionField.js')

const frameFor = (base, amp) => createPlanetFrame({
  sampler: { radius: 1000, heightAt: d => base + amp * (Math.sin(d[0] * 7) + Math.cos(d[2] * 5)) },
  anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.01,
})
const rockFrame = frameFor(200, 300)
const vegFrame = frameFor(50, 0)
const baseField = { climateUsesLocalXZ: true, climateAtLocal: () => ({ erosion: 0.3, humidity: 0.5, temp: 0.5 }) }
const model = { id: 'placed', model: 'arena.glb', position: [50, 0, 50], scale: [20, 20, 20] }
const exclusion = createModelExclusionField([model])
const excludedField = exclusion.wrapClimateField(baseField)
assert.equal(exclusion.circleCount, 1)
assert.equal(exclusion.blockedAt(50, 50), true)
assert.equal(exclusion.blockedAt(200, 200), false)

const coords = [0, 30, 60, 90].flatMap(x => [0, 30, 60, 90].map(z => ({ x, z })))
const rockLattice = latticeFor(rockFrame, ROCK)
const vegLattice = latticeFor(vegFrame, VEG)
const rockKeys = coords.map(c => chunkKeyAtLocal(rockLattice, rockFrame, c.x, c.z))
const vegKeys = coords.map(c => chunkKeyAtLocal(vegLattice, vegFrame, c.x, c.z))

function collect(keys, frame, field, fn) {
  const out = []
  for (const key of keys) out.push(...fn(key, frame, field, 1))
  return out
}
const rockBaseline = collect(rockKeys, rockFrame, baseField, placementsForRockChunk)
const vegBaseline = collect(vegKeys, vegFrame, baseField, placementsForChunk)
const rockExcluded = collect(rockKeys, rockFrame, excludedField, placementsForRockChunk)
const vegExcluded = collect(vegKeys, vegFrame, excludedField, placementsForChunk)

assert.ok(rockBaseline.length > 0, 'rock placement must be non-vacuous')
assert.ok(vegBaseline.length > 0, 'vegetation placement must be non-vacuous')
assert.ok(rockBaseline.some(p => exclusion.blockedAt(p.x, p.z)), 'the model footprint must overlap rock placements')
assert.ok(vegBaseline.some(p => exclusion.blockedAt(p.x, p.z)), 'the model footprint must overlap vegetation placements')
assert.ok(rockExcluded.length < rockBaseline.length, 'rock placements inside the footprint must be removed')
assert.ok(vegExcluded.length < vegBaseline.length, 'vegetation placements inside the footprint must be removed')
assert.ok(rockExcluded.every(p => !exclusion.blockedAt(p.x, p.z)), 'no surviving rock may sit inside the footprint')
assert.ok(vegExcluded.every(p => !exclusion.blockedAt(p.x, p.z)), 'no surviving plant may sit inside the footprint')

const interior = { id: 'interior', model: 'arena.glb', position: [50, 0, 50], scale: [20, 20, 20], custom: { _interior: true } }
const interiorExclusion = createModelExclusionField([interior])
assert.equal(interiorExclusion.circleCount, 1, 'an interior placed model must still produce a footprint')
const interiorField = interiorExclusion.wrapClimateField(baseField)
const interiorRocks = collect(rockKeys, rockFrame, interiorField, placementsForRockChunk)
const interiorVeg = collect(vegKeys, vegFrame, interiorField, placementsForChunk)
assert.ok(interiorRocks.length < rockBaseline.length, 'an interior footprint must remove rocks')
assert.ok(interiorVeg.length < vegBaseline.length, 'an interior footprint must remove plants')
assert.equal(interiorRocks.filter(p => interiorExclusion.blockedAt(p.x, p.z)).length, 0, 'interior rock survivor count must be 0')
assert.equal(interiorVeg.filter(p => interiorExclusion.blockedAt(p.x, p.z)).length, 0, 'interior plant survivor count must be 0')

const rocksSrc = readFileSync('client/core/Rocks.js', 'utf8')
const vegSrc = readFileSync('client/core/Vegetation.js', 'utf8')
const appSrc = readFileSync('client/app.js', 'utf8')
assert.match(rocksSrc, /createModelExclusionField\(opts\.placedModels\)/)
assert.match(vegSrc, /createModelExclusionField\(opts\.placedModels\)/)
assert.match(appSrc, /createVegetation\([^)]*placedModels: worldConfig\.entities/)
assert.match(appSrc, /createRocks\([^)]*placedModels: worldConfig\.entities/)

console.log(`RESULT: PASS ordinary placed-model footprint removes ${rockBaseline.length - rockExcluded.length} rock(s) and ${vegBaseline.length - vegExcluded.length} plant(s); no survivor sits inside it; _interior map models also exclude with 0 survivors; Rocks.js, Vegetation.js and app.js are wired`)
