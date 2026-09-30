import { sillosTerrainWorld, sillosVegetation } from './_shared/sillos-terrain.js'

export default sillosTerrainWorld({ port: 3005, vegetation: sillosVegetation({ trees: false, rocks: true }) })
