import { installSpecifierHooks } from '../../scripts/lib/install-specifier-hooks.mjs'
await installSpecifierHooks()
const { createPlanetFrame } = await import('../../src/terrain/PlanetFrame.js')
const { placementsForRockChunk, ROCK } = await import('../../src/terrain/RockPlacement.js')
const { placementsForChunk, VEG } = await import('../../src/terrain/VegPlacement.js')
const { latticeFor, chunkKeyAtLocal } = await import('../../src/terrain/PlacementChart.js')
const out = []
for (const base of [200, 500, 1000]) {
  for (const amp of [100, 300]) {
    const sampler = { radius: 1000, heightAt: (d) => base + amp * (Math.sin(d[0] * 7) + Math.cos(d[2] * 5)) }
    const frame = createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.01 })
    const anchor = { climateUsesLocalXZ: true, climateAtLocal: () => ({ erosion: 0.3, humidity: 0.5, temp: 0.5 }) }
    const rockLattice = latticeFor(frame, ROCK)
    const vegLattice = latticeFor(frame, VEG)
    const keys = [0, 30, 60, 90].flatMap(x => [0, 30, 60, 90].map(z => ({ r: chunkKeyAtLocal(rockLattice, frame, x, z), v: chunkKeyAtLocal(vegLattice, frame, x, z) })))
    let rocks = 0, veg = 0
    for (const k of keys) { rocks += placementsForRockChunk(k.r, frame, anchor, 1).length; veg += placementsForChunk(k.v, frame, anchor, 1).length }
    out.push({ base, amp, rocks, veg })
  }
}
console.log(JSON.stringify(out))
