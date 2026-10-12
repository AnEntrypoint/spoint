import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const RECORDER_PATH = join(HERE, 'water-tsl-recorder.mjs')
const WATER_TSL_REL = 'packages/mapspinner/src/tsl/water-tsl.js'
const TERRAIN_MATERIAL_REL = 'packages/mapspinner/src/tsl/terrain-material-tsl.js'
const PLANET_TSL_REL = 'packages/mapspinner/src/tsl/planet-tsl.js'
const GRID_REL = 'packages/mapspinner/src/patch-grid-geometry.js'
const DEFAULTS_REL = 'packages/mapspinner/src/terrain-defaults.js'

const LABEL = 'tsl-water-pass'
const OUT_REL = '.gm/witness-out/water-pass-static-count-' + LABEL + '.txt'
const LINES = []
const CHECKS = []
const say = (s) => { LINES.push(s); process.stdout.write(s + '\n') }
const check = (id, ok, detail) => { CHECKS.push({ id, ok, detail }); say((ok ? 'PASS' : 'FAIL') + ' ' + id + ': ' + detail) }

function sourceNumber(rel, re, label) {
  const src = readFileSync(join(ROOT, rel), 'utf8')
  const m = re.exec(src)
  if (!m) { check('source-const-' + label, false, 'pattern absent in ' + rel); return NaN }
  return Number(m[1])
}

function regionTotals(prefix) {
  let total = 0
  for (const [k, v] of state.counts) {
    const region = k.slice(0, k.lastIndexOf('|'))
    if (region === prefix || region.startsWith(prefix + '/')) total += v
  }
  return total
}

function regionOp(prefix, op) {
  let total = 0
  for (const [k, v] of state.counts) {
    const region = k.slice(0, k.lastIndexOf('|'))
    if (region === prefix || region.startsWith(prefix + '/')) {
      if (k.slice(k.lastIndexOf('|') + 1) === op) total += v
    }
  }
  return total
}

const recorderUrl = pathToFileURL(RECORDER_PATH).href
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'three/tsl' || spec === 'three/webgpu') return { url: recorderUrl, shortCircuit: true }
    return next(spec, ctx)
  },
})

const recorder = await import(recorderUrl)
const state = recorder.state
const waterMod = await import(pathToFileURL(join(ROOT, WATER_TSL_REL)).href)
const gridMod = await import(pathToFileURL(join(ROOT, GRID_REL)).href)
const defaultsMod = await import(pathToFileURL(join(ROOT, DEFAULTS_REL)).href)

say('water-pass-static-count witness (' + LABEL + ') at ' + new Date().toISOString())
say('')

const WATER_GRID = sourceNumber(WATER_TSL_REL, /const WATER_GRID = (\d+)/, 'water-grid')
const WATER_MAX_LEVEL = sourceNumber(WATER_TSL_REL, /const WATER_MAX_LEVEL = (\d+)/, 'water-max-level')
const FD_TAPS = sourceNumber(TERRAIN_MATERIAL_REL, /const FD_TAPS = (\d+)/, 'fd-taps')
const WATER_RENDER_ORDER = sourceNumber(PLANET_TSL_REL, /const WATER_DRAWS_BEFORE_OTHER_TRANSPARENTS = (-?\d+)/, 'water-render-order')
const TERRAIN_RENDER_ORDER = sourceNumber(PLANET_TSL_REL, /const TERRAIN_DRAWS_AFTER_OPAQUE_OCCLUDERS = (-?\d+)/, 'terrain-render-order')
const GRID_MESH_SIZE = defaultsMod.TERRAIN_DEFAULTS.gridMeshSize

check('water-grid', WATER_GRID === 4, 'WATER_GRID=' + WATER_GRID)
check('water-max-level', WATER_MAX_LEVEL === 11, 'WATER_MAX_LEVEL=' + WATER_MAX_LEVEL)
check('fd-taps', FD_TAPS === 5, 'FD_TAPS=' + FD_TAPS)
check('grid-mesh-size', GRID_MESH_SIZE === 9, 'TERRAIN_DEFAULTS.gridMeshSize=' + GRID_MESH_SIZE)
check('water-render-order', WATER_RENDER_ORDER === -1, 'WATER_DRAWS_BEFORE_OTHER_TRANSPARENTS=' + WATER_RENDER_ORDER)
check('terrain-render-order', TERRAIN_RENDER_ORDER === 10, 'TERRAIN_DRAWS_AFTER_OPAQUE_OCCLUDERS=' + TERRAIN_RENDER_ORDER)

const waterVerts = gridMod.buildGridGeometry(WATER_GRID).vertices.length / 3
const terrainVerts = gridMod.buildGridGeometry(GRID_MESH_SIZE).vertices.length / 3
check('water-verts-per-instance', waterVerts === 49, 'water grid ' + WATER_GRID + ' -> ' + waterVerts + ' vertices/instance')
check('terrain-verts-per-instance', terrainVerts === 144, 'terrain grid ' + GRID_MESH_SIZE + ' -> ' + terrainVerts + ' vertices/instance')

const spec = { composeHeight() { state.composeHeight += 1; return recorder.__node('height') } }
const terrainUniforms = {
  defRadius: recorder.__node('defRadius'),
  camDir: recorder.__node('camDir'),
  camAlt: recorder.__node('camAlt'),
  camRender: recorder.__node('camRender'),
  east: recorder.__node('east'),
  up: recorder.__node('up'),
  north: recorder.__node('north'),
}
const water = waterMod.createWaterTSL({
  spec,
  terrainUniforms,
  faceU: recorder.__node('faceU'),
  faceV: recorder.__node('faceV'),
  faceC: recorder.__node('faceC'),
})

const heightPerWaterVertex = state.composeHeight
check('water-vs-height-evaluations', heightPerWaterVertex === 1, 'createWaterTSL positionNode evaluates composeHeight ' + heightPerWaterVertex + ' time(s) per water vertex')
const terrainHeightPerInstance = terrainVerts * FD_TAPS
const vertexShare = (waterVerts * heightPerWaterVertex) / terrainHeightPerInstance
check('water-vertex-share-of-terrain', vertexShare < 0.1, 'water VS height work per quad ' + (waterVerts * heightPerWaterVertex) + ' vs terrain ' + terrainHeightPerInstance + ' = ' + (vertexShare * 100).toFixed(1) + '%')

const topLevelIfs = state.counts.get('root|If') || 0
const landRegions = [...state.counts.keys()]
  .map((k) => k.slice(0, k.lastIndexOf('|')))
  .filter((r, i, a) => a.indexOf(r) === i && r.endsWith(':then') && regionTotals(r) === 1 && regionOp(r, 'Discard') === 1)
check('land-discard-branch-isolated', landRegions.length === 1, 'top-level If nodes ' + topLevelIfs + '; discard-only branch regions: ' + JSON.stringify(landRegions))
const LAND = landRegions.length === 1 ? landRegions[0] : 'absent'
const topLevelElse = [...state.counts.keys()]
  .map((k) => k.slice(0, k.lastIndexOf('|')))
  .filter((r, i, a) => a.indexOf(r) === i && !r.includes('/') && r.endsWith(':else'))
check('single-surface-branch', topLevelElse.length === 1, 'top-level else regions: ' + JSON.stringify(topLevelElse))
const OCEAN = topLevelElse.length === 1 ? topLevelElse[0] : 'absent'
const UNDERWATER = OCEAN === 'absent' ? 'absent' : OCEAN.slice(0, -':else'.length) + ':then'

const discardIdx = state.order.indexOf(LAND + '|Discard')
const firstSeaIdx = state.order.findIndex((k) => k.includes('call:sea'))
check('land-discard-reached', discardIdx >= 0, 'land branch ' + LAND + ' Discard at order index ' + discardIdx)
check('discard-precedes-sea-evaluations', discardIdx >= 0 && firstSeaIdx >= 0 && discardIdx < firstSeaIdx, 'Discard index ' + discardIdx + ' < first sea evaluation index ' + firstSeaIdx)

const landTotal = regionTotals(LAND)
const landSea = ['call:seaOctave', 'call:seaNoise', 'call:seaHeight', 'call:seaHeightLF'].reduce((t, op) => t + regionOp(LAND, op), 0)
check('land-branch-cost', landTotal === 1 && landSea === 0, LAND + ' (terrain above sea) emits ' + landTotal + ' op(s), ' + landSea + ' sea evaluation(s)')

const underwaterTotal = regionTotals(UNDERWATER)
const oceanTotal = regionTotals(OCEAN)
const oceanOctave = regionOp(OCEAN, 'call:seaOctave')
const oceanNoise = regionOp(OCEAN, 'call:seaNoise')
const oceanHeight = regionOp(OCEAN, 'call:seaHeight')
const oceanHeightLF = regionOp(OCEAN, 'call:seaHeightLF')
check('ocean-branch-cost', oceanOctave > 0 && oceanNoise > 0 && oceanHeight > 0, OCEAN + ' emits ' + oceanTotal + ' ops: seaOctave ' + oceanOctave + ', seaNoise ' + oceanNoise + ', seaHeight ' + oceanHeight + ', seaHeightLF ' + oceanHeightLF)
check('ocean-branch-gated-by-discard', oceanTotal > landTotal, 'ocean branch ' + oceanTotal + ' ops vs land branch ' + landTotal + ' op(s)')

const material = water.material
check('water-material-transparent', material.transparent === true, 'material.transparent=' + material.transparent)
check('water-material-depth-write', material.depthWrite === true, 'material.depthWrite=' + material.depthWrite)
check('water-material-double-sided', material.side === 2, 'material.side=DoubleSide(' + material.side + ')')
check('water-shader-name', material.name === 'mapspinner-water-tsl', 'material.name=' + material.name)

const terrainMaterialSrc = readFileSync(join(ROOT, TERRAIN_MATERIAL_REL), 'utf8')
check('terrain-material-opaque', !/\.transparent\s*=/.test(terrainMaterialSrc), 'terrain TSL material assigns no .transparent -> opaque render list')
check('terrain-material-no-opacity', !/opacityNode/.test(terrainMaterialSrc), 'terrain TSL material declares no opacityNode')

const nDistinct = 200
const off = new Float32Array(nDistinct * 4)
const fc = new Float32Array(nDistinct)
for (let i = 0; i < nDistinct; i++) { off[i * 4] = (i % 20) * 8; off[i * 4 + 1] = Math.floor(i / 20) * 8; off[i * 4 + 2] = 8; off[i * 4 + 3] = WATER_MAX_LEVEL; fc[i] = 0 }
const wcDistinct = water.setQuads(off, fc, nDistinct)
check('water-instances-positive', wcDistinct >= 1, 'setQuads over ' + nDistinct + ' terrain quads -> ' + wcDistinct + ' water instances')
check('water-instances-bounded', wcDistinct <= nDistinct, 'water instances ' + wcDistinct + ' <= terrain quads ' + nDistinct)

const offDup = new Float32Array(50 * 4)
const fcDup = new Float32Array(50)
for (let i = 0; i < 50; i++) { offDup[i * 4] = 0; offDup[i * 4 + 1] = 0; offDup[i * 4 + 2] = 8; offDup[i * 4 + 3] = WATER_MAX_LEVEL; fcDup[i] = 0 }
const wcDup = water.setQuads(offDup, fcDup, 50)
check('water-instances-dedup', wcDup === 1, '50 identical quads collapse to ' + wcDup + ' water instance')
check('instance-count-matches-return', water.mesh.geometry.instanceCount === wcDup, 'geo.instanceCount=' + water.mesh.geometry.instanceCount + ' == setQuads return ' + wcDup)

const offFine = new Float32Array(64 * 4)
const fcFine = new Float32Array(64)
for (let i = 0; i < 64; i++) { offFine[i * 4] = i % 8; offFine[i * 4 + 1] = Math.floor(i / 8); offFine[i * 4 + 2] = 1; offFine[i * 4 + 3] = WATER_MAX_LEVEL + 3; fcFine[i] = 0 }
const wcFine = water.setQuads(offFine, fcFine, 64)
let maxLv = -Infinity
const emitted = water.mesh.geometry.attributes.iOffset.array
for (let i = 0; i < wcFine; i++) maxLv = Math.max(maxLv, emitted[i * 4 + 3])
check('water-level-coarsened', wcFine > 0 && maxLv <= WATER_MAX_LEVEL, 'level ' + (WATER_MAX_LEVEL + 3) + ' quads coarsen to max emitted level ' + maxLv + ' (cap ' + WATER_MAX_LEVEL + '), ' + wcFine + ' instances')

water.update({ camWorldPos: [0, 0, 0], camDist: 6360000, R: 6360000, sunDir: [0, 1, 0], time: 0, ocean: {} })
check('water-visible-by-default', water.mesh.visible === true, 'mesh.visible=true with no window override')
globalThis.window = { __waterSurface: false }
water.update({ camWorldPos: [0, 0, 0], camDist: 6360000, R: 6360000, sunDir: [0, 1, 0], time: 0, ocean: {} })
check('water-surface-toggle', water.mesh.visible === false, 'window.__waterSurface===false hides the water mesh')
delete globalThis.window

say('')
say('measured counts')
say('  water vertices/instance        ' + waterVerts)
say('  terrain vertices/instance      ' + terrainVerts)
say('  composeHeight per water vertex ' + heightPerWaterVertex)
say('  composeHeight per terrain quad ' + terrainHeightPerInstance)
say('  water VS share of terrain      ' + (vertexShare * 100).toFixed(1) + '%')
say('  land branch ops / sea evals    ' + landTotal + ' / ' + landSea)
say('  underwater branch ops          ' + underwaterTotal)
say('  ocean branch ops               ' + oceanTotal)
say('  ocean seaOctave / seaNoise     ' + oceanOctave + ' / ' + oceanNoise)
say('  ocean seaHeight / seaHeightLF  ' + oceanHeight + ' / ' + oceanHeightLF)

const failed = CHECKS.filter((c) => !c.ok)
writeFileSync(join(ROOT, OUT_REL), LINES.join('\n') + '\n')
say('')
say(failed.length === 0 ? 'RESULT: PASS (' + CHECKS.length + ' checks)' : 'RESULT: FAIL ' + failed.length + ' of ' + CHECKS.length + ': ' + failed.map((c) => c.id).join(', '))
process.exitCode = failed.length === 0 ? 0 : 1
