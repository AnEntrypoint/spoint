import { installSpecifierHooks } from '../../scripts/lib/install-specifier-hooks.mjs'
await installSpecifierHooks()
const { createPlanetFrame } = await import('../../src/terrain/PlanetFrame.js')
const { placementsForRockChunk } = await import('../../src/terrain/RockPlacement.js')
const { placementsForChunk } = await import('../../src/terrain/VegPlacement.js')
const out = []
for (const radius of [1000, 10000, 6371000]) {
  for (const h of [0, 5, 50]) {
    const sampler = { radius, heightAt: () => h }
    const frame = createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.01 })
    const anchor = { climateUsesLocalXZ: true, climateAtLocal: () => ({ erosion: 0.3, humidity: 0.5, temp: 0.5 }) }
    let rocks = 0, veg = 0
    for (let key = 0; key < 12; key++) {
      rocks += placementsForRockChunk(key, frame, anchor, 1).length
      veg += placementsForChunk(key, frame, anchor, 1).length
    }
    out.push({ radius, h, rocks, veg })
  }
}
console.log(JSON.stringify(out))
