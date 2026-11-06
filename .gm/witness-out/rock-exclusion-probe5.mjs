import { resolve } from 'node:path'
import { installSpecifierHooks } from '../../scripts/lib/install-specifier-hooks.mjs'
await installSpecifierHooks()
const ROOT = resolve(import.meta.dirname, '../..')
const { loadWorldModule } = await import('../../src/sdk/WorldLocator.js')
const { loadPlanetSampler, planetSamplerOptsOf } = await import('../../src/terrain/TerrainPhysics.js')
const { createPlanetFrame } = await import('../../src/terrain/PlanetFrame.js')
const { createCachedAnchorField } = await import('../../src/terrain/ClimateCache.js')
const { createBiomeOverride } = await import('../../src/terrain/BiomeOverride.js')
const { placementsForRockChunk } = await import('../../src/terrain/RockPlacement.js')
const { placementsForChunk } = await import('../../src/terrain/VegPlacement.js')
const loaded = await loadWorldModule(resolve(ROOT, 'apps/world/tps-game.js'))
const tcfg = { ...loaded.terrain, bakedHeightfield: undefined }
const sampler = await loadPlanetSampler(planetSamplerOptsOf(tcfg))
const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
const anchor = createBiomeOverride().wrapClimateField(createCachedAnchorField(sampler.anchorField, frame))
let rocks = 0, veg = 0
for (let key = 0; key < 12; key++) {
  rocks += placementsForRockChunk(key, frame, anchor, 1).length
  veg += placementsForChunk(key, frame, anchor, 1).length
}
console.log(JSON.stringify({ rocks, veg, radius: frame.radius, hasClimate: typeof anchor.climateAtLocal }))
