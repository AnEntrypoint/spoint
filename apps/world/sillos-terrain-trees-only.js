import { sillosTerrainWorld, sillosVegetation } from './_shared/sillos-terrain.js'

export default sillosTerrainWorld({ port: 3006, vegetation: sillosVegetation({ trees: true, rocks: false }) })
