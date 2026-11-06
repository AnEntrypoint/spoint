import { installSpecifierHooks } from '../../scripts/lib/install-specifier-hooks.mjs'
await installSpecifierHooks()
const { createPlanetFrame } = await import('../../src/terrain/PlanetFrame.js')
const { placementsForRockChunk } = await import('../../src/terrain/RockPlacement.js')
const { placementsForChunk } = await import('../../src/terrain/VegPlacement.js')
const sampler = { radius: 6371000, heightAt: () => 5 }
const frame = createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.01 })
const anchor = { climateUsesLocalXZ: true, climateAtLocal: () => ({ erosion: 0.3, humidity: 0.5, temp: 0.5 }) }
const out = []
for (let key = 0; key < 6; key++) {
  out.push({ key, rocks: placementsForRockChunk(key, frame, anchor, 1).length, veg: placementsForChunk(key, frame, anchor, 1).length })
}
console.log(JSON.stringify(out))
