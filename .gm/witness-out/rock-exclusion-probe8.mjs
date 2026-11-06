import { installSpecifierHooks } from '../../scripts/lib/install-specifier-hooks.mjs'
await installSpecifierHooks()
const { createPlanetFrame } = await import('../../src/terrain/PlanetFrame.js')
const { placementsForRockChunk, ROCK } = await import('../../src/terrain/RockPlacement.js')
const { placementsForChunk, VEG } = await import('../../src/terrain/VegPlacement.js')
const { latticeFor, chunkKeyAtLocal } = await import('../../src/terrain/PlacementChart.js')
const mk = (base, amp) => {
  const sampler = { radius: 1000, heightAt: (d) => base + amp * (Math.sin(d[0] * 7) + Math.cos(d[2] * 5)) }
  return createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.01 })
}
const anchor = { climateUsesLocalXZ: true, climateAtLocal: () => ({ erosion: 0.3, humidity: 0.5, temp: 0.5 }) }
const rockFrame = mk(200, 300)
const vegFrame = mk(50, 0)
const keys = [0, 30, 60, 90].flatMap(x => [0, 30, 60, 90].map(z => ({ x, z })))
const rockLattice = latticeFor(rockFrame, ROCK)
const vegLattice = latticeFor(vegFrame, VEG)
const rocks = [], veg = []
for (const k of keys) {
  rocks.push(...placementsForRockChunk(chunkKeyAtLocal(rockLattice, rockFrame, k.x, k.z), rockFrame, anchor, 1))
  veg.push(...placementsForChunk(chunkKeyAtLocal(vegLattice, vegFrame, k.x, k.z), vegFrame, anchor, 1))
}
const summarize = (a) => ({ n: a.length, minX: Math.min(...a.map(p => p.x)), maxX: Math.max(...a.map(p => p.x)), minZ: Math.min(...a.map(p => p.z)), maxZ: Math.max(...a.map(p => p.z)), sample: a.slice(0, 4).map(p => [p.x, p.z]) })
console.log(JSON.stringify({ rocks: summarize(rocks), veg: summarize(veg) }))
