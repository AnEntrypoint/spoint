import { installSpecifierHooks } from '../../scripts/lib/install-specifier-hooks.mjs'
await installSpecifierHooks()
const { createPlanetFrame } = await import('../../src/terrain/PlanetFrame.js')
const { placementsForRockChunk, ROCK } = await import('../../src/terrain/RockPlacement.js')
const { placementsForChunk, VEG } = await import('../../src/terrain/VegPlacement.js')
const { latticeFor, chunkKeyAtLocal } = await import('../../src/terrain/PlacementChart.js')
const sampler = { radius: 1000, heightAt: (d) => 50 + 20 * (Math.sin(d[0] * 7) + Math.cos(d[2] * 5)) }
const frame = createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.01 })
const anchor = { climateUsesLocalXZ: true, climateAtLocal: () => ({ erosion: 0.3, humidity: 0.5, temp: 0.5 }) }
const rockLattice = latticeFor(frame, ROCK)
const vegLattice = latticeFor(frame, VEG)
const keys = [0, 50, 100].flatMap(x => [0, 50, 100].map(z => ({ x, z, rockKey: chunkKeyAtLocal(rockLattice, frame, x, z), vegKey: chunkKeyAtLocal(vegLattice, frame, x, z) })))
const out = keys.map(k => ({ ...k, rocks: placementsForRockChunk(k.rockKey, frame, anchor, 1).length, veg: placementsForChunk(k.vegKey, frame, anchor, 1).length }))
console.log(JSON.stringify(out))
