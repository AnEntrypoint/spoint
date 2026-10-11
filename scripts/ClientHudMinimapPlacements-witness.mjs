import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_MODULE = path.join(REPO, 'client', 'hud', 'MinimapPlacements.js')
const SRC_ROOT_URL = pathToFileURL(path.join(REPO, 'src')).href + '/'
const WATCHDOG_MS = 240000
const WINDOW_HALF_M = 96
const INTERIOR_HALF_M = 64
const MIN_TREES = 30
const MIN_ROCKS = 3
const SITE_CANDIDATES = 80
const SITE_RANGE_M = 6000
const SITE_KEY_STEP_M = 2
const EXACT_KEY_STEP_M = 0.5
const ROCK_CLASS = 5
const TREE_CLASS_MAX = 4
const GENUS = [['Oak', 0, 4.2], ['Pine', 1, 2.6], ['Aspen', 2, 2.8], ['Ash', 3, 3.6], ['Bush', 4, 1.3]]
const SIZE = [['Small', 0.75], ['Large', 1.3]]
const f32 = Math.fround

const SRC_IMPORT_HOOK = [
  'let srcRoot = null;',
  'export function initialize(data) { srcRoot = data.srcRoot; }',
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier.startsWith('/src/')) return nextResolve(new URL(specifier.slice(5), srcRoot).href, context);",
  '  return nextResolve(specifier, context);',
  '}',
].join('\n')
register('data:text/javascript,' + encodeURIComponent(SRC_IMPORT_HOOK), { parentURL: import.meta.url, data: { srcRoot: SRC_ROOT_URL } })

const watchdog = setTimeout(() => {
  console.log(`RESULT: FAIL -- watchdog: no verdict within ${WATCHDOG_MS / 1000} s`)
  process.exit(1)
}, WATCHDOG_MS)

const outcomes = []
function check(name, ok, detail = '') {
  outcomes.push(ok)
  const suffix = !ok && detail ? ` -- ${detail}` : ''
  console.log(`${ok ? 'ok    ' : 'FAIL  '}${name}${suffix}`)
}

function verdict(reason = null) {
  const failed = outcomes.filter(ok => !ok).length
  console.log(`checks ${outcomes.length} failures ${failed}`)
  if (reason || failed > 0 || outcomes.length === 0) {
    console.log(`RESULT: FAIL -- ${reason || (failed > 0 ? `${failed} of ${outcomes.length} checks failed` : 'no checks ran')}`)
    process.exitCode = 1
  } else {
    console.log('RESULT: PASS')
  }
}

const roiOf = (cx, cz, half) => ({ x0: cx - half, x1: cx + half, z0: cz - half, z1: cz + half })
const within = (g, roi) => g[0] >= roi.x0 && g[0] <= roi.x1 && g[1] >= roi.z0 && g[1] <= roi.z1
const isRock = g => g[2] === ROCK_CLASS
const isTree = g => g[2] !== ROCK_CLASS
const byValue = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]

function sameGlyphs(a, b) {
  if (a.length !== b.length) return false
  const sa = a.slice().sort(byValue)
  const sb = b.slice().sort(byValue)
  return sa.every((g, i) => g.every((v, j) => Object.is(v, sb[i][j])))
}

function wellFormed(g) {
  return g.length === 4 && g.every(Number.isFinite) && ((g[2] >= 0 && g[2] <= TREE_CLASS_MAX) || g[2] === ROCK_CLASS) && g[3] > 0
}

function mostCommon(values) {
  const counts = new Map()
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]
}

function drive(scanner, { frame, field, cx, cz, halfM, sources, seed, sliced }) {
  scanner.begin(frame, field, sources, seed, cx, cz, halfM)
  const packedSizes = []
  let steps = 0
  for (;;) {
    steps++
    if (scanner.step(sliced ? performance.now() : Infinity, packed => packedSizes.push(packed.length))) break
    if (steps > 1000000) throw new Error('scanner.step did not complete')
  }
  return { steps, packedSizes, glyphs: scanner.glyphSnapshot() }
}

async function main() {
  const modulePath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_MODULE
  if (!existsSync(modulePath)) {
    verdict(`module path not found: ${modulePath}`)
    return
  }
  console.log(`module ${modulePath}`)
  console.log(`module sha256 ${createHash('sha256').update(readFileSync(modulePath)).digest('hex')}`)

  const mod = await import(pathToFileURL(modulePath).href)
  const { GLYPH_STRIDE, GLYPH_ROCK, GLYPH_CLASS_COUNT, createPlacementScanner } = mod
  check('exports: GLYPH_STRIDE 4, GLYPH_ROCK 5, GLYPH_CLASS_COUNT 6', GLYPH_STRIDE === 4 && GLYPH_ROCK === ROCK_CLASS && GLYPH_CLASS_COUNT === 6, `got ${GLYPH_STRIDE}, ${GLYPH_ROCK}, ${GLYPH_CLASS_COUNT}`)
  check('exports: createPlacementScanner is a function', typeof createPlacementScanner === 'function')

  const { loadWorldModule } = await import(pathToFileURL(path.join(REPO, 'src', 'sdk', 'WorldLocator.js')).href)
  const { resolveTerrainConfig } = await import(pathToFileURL(path.join(REPO, 'src', 'shared', 'terrainConfig.js')).href)
  const { loadPlanetSampler, planetSamplerOptsOf } = await import(pathToFileURL(path.join(REPO, 'src', 'terrain', 'TerrainPhysics.js')).href)
  const { createPlanetFrame } = await import(pathToFileURL(path.join(REPO, 'src', 'terrain', 'PlanetFrame.js')).href)
  const { createCachedAnchorField } = await import(pathToFileURL(path.join(REPO, 'src', 'terrain', 'ClimateCache.js')).href)
  const { latticeFor, chunkKeyAtLocal } = await import(pathToFileURL(path.join(REPO, 'src', 'terrain', 'PlacementChart.js')).href)
  const { placementsForChunk, VEG, SPECIES } = await import(pathToFileURL(path.join(REPO, 'src', 'terrain', 'VegPlacement.js')).href)
  const { placementsForRockChunk, ROCK } = await import(pathToFileURL(path.join(REPO, 'src', 'terrain', 'RockPlacement.js')).href)

  const loaded = await loadWorldModule(path.join(REPO, 'apps', 'world', 'tps-game.js'))
  const tcfg = resolveTerrainConfig(loaded)
  const SEED = tcfg.seed | 0
  const sampler = await loadPlanetSampler(planetSamplerOptsOf(tcfg))
  const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
  const anchorField = sampler.anchorField
  check('terrain: the tps-game world sampler exposes an anchor field', !!anchorField)
  if (!anchorField) {
    verdict('world sampler has no anchor field')
    return
  }
  const cached = createCachedAnchorField(anchorField, frame)
  const vegLattice = latticeFor(frame, VEG)
  const rockLattice = latticeFor(frame, ROCK)

  let decodes = 0
  for (const lattice of [vegLattice, rockLattice]) {
    const decodeChunk = lattice.decodeChunk
    lattice.decodeChunk = function countedDecode(key, out) {
      decodes++
      return decodeChunk.call(this, key, out)
    }
  }

  const keysCovering = (lattice, roi, step) => {
    const keys = new Set()
    const nx = Math.round((roi.x1 - roi.x0) / step)
    const nz = Math.round((roi.z1 - roi.z0) / step)
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) keys.add(chunkKeyAtLocal(lattice, frame, roi.x0 + i * step, roi.z0 + j * step))
    }
    return keys
  }

  const treeGlyph = p => {
    const name = SPECIES[p.species]
    const genus = GENUS.find(g => name.startsWith(g[0])) || GENUS[0]
    const size = SIZE.find(s => name.includes(s[0]))
    return [f32(p.x), f32(p.z), genus[1], f32(f32(genus[2] * (size ? size[1] : 1)) * p.scale)]
  }
  const rockGlyph = p => [f32(p.x), f32(p.z), ROCK_CLASS, f32(p.scale * 0.5)]

  const oracle = (seed, roi, step) => {
    const trees = []
    for (const key of keysCovering(vegLattice, roi, step)) {
      for (const p of placementsForChunk(key, frame, cached, seed)) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue
        const g = treeGlyph(p)
        if (within(g, roi)) trees.push({ species: p.species, g })
      }
    }
    const rocks = []
    for (const key of keysCovering(rockLattice, roi, step)) {
      for (const p of placementsForRockChunk(key, frame, cached, seed)) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue
        const g = rockGlyph(p)
        if (within(g, roi)) rocks.push(g)
      }
    }
    return { trees, rocks }
  }

  let rs = 24680
  const nextUnit = () => {
    rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0
    return rs / 4294967296
  }
  let site = null
  for (let i = 0; i < SITE_CANDIDATES && site === null; i++) {
    const cx = (nextUnit() * 2 - 1) * SITE_RANGE_M
    const cz = (nextUnit() * 2 - 1) * SITE_RANGE_M
    const roi = roiOf(cx, cz, INTERIOR_HALF_M)
    const coarse = oracle(SEED, roi, SITE_KEY_STEP_M)
    if (coarse.trees.length < MIN_TREES || coarse.rocks.length < MIN_ROCKS) continue
    const exact = oracle(SEED, roi, EXACT_KEY_STEP_M)
    if (exact.trees.length >= MIN_TREES && exact.rocks.length >= MIN_ROCKS) site = { cx, cz, roi, expected: exact }
  }
  check('site: a window with vegetation and rocks exists among the candidates', site !== null, `no candidate of ${SITE_CANDIDATES} has >= ${MIN_TREES} trees and >= ${MIN_ROCKS} rocks in its interior`)
  if (site === null) {
    verdict()
    return
  }
  const { roi, expected } = site
  const runWindow = (scanner, sources, seed, sliced, field = anchorField) =>
    drive(scanner, { frame, field, cx: site.cx, cz: site.cz, halfM: WINDOW_HALF_M, sources, seed, sliced })

  const idle = runWindow(createPlacementScanner(), {}, SEED, false)
  check('no sources: one step completes and emits nothing', idle.steps === 1 && idle.glyphs.length === 0 && idle.packedSizes.length === 0, `steps ${idle.steps}, glyphs ${idle.glyphs.length}`)

  const sourcesAll = { vegetation: { _meshes: SPECIES.map(name => ({ name })) }, rocks: {} }
  const scannerA = createPlacementScanner()
  decodes = 0
  const oneShot = runWindow(scannerA, sourcesAll, SEED, false)
  const decodesOneShot = decodes
  const gotTrees = oneShot.glyphs.filter(g => isTree(g) && within(g, roi))
  const gotRocks = oneShot.glyphs.filter(g => isRock(g) && within(g, roi))
  check('one-shot: vegetation glyphs in the interior equal the placement oracle (position, class, canopy radius)', sameGlyphs(gotTrees, expected.trees.map(t => t.g)), `want ${expected.trees.length} got ${gotTrees.length}`)
  check('one-shot: rock glyphs in the interior equal the placement oracle (position, class 5, radius = 0.5 x scale)', sameGlyphs(gotRocks, expected.rocks), `want ${expected.rocks.length} got ${gotRocks.length}`)
  check('one-shot: every glyph is a finite 4-field record with class 0-4 or 5 and radius > 0', oneShot.glyphs.every(wellFormed), `${oneShot.glyphs.filter(g => !wellFormed(g)).length} malformed`)
  check('one-shot: every packed chunk is a whole number of glyph records', oneShot.packedSizes.length > 0 && oneShot.packedSizes.every(n => n % GLYPH_STRIDE === 0), `${oneShot.packedSizes.length} chunks`)
  check('instrumentation: the one-shot run decoded chunks through the lattice the module uses', decodesOneShot > 0, `decodes ${decodesOneShot}`)

  const sliced = runWindow(createPlacementScanner(), sourcesAll, SEED, true)
  check('sliced: a deadline-bounded run takes several steps and matches the one-shot glyphs exactly', sliced.steps > 1 && sameGlyphs(sliced.glyphs, oneShot.glyphs), `steps ${sliced.steps}, glyphs ${sliced.glyphs.length} vs ${oneShot.glyphs.length}`)

  decodes = 0
  const repeat = runWindow(scannerA, sourcesAll, SEED, false)
  check('cache: a repeat run on the same scanner decodes no chunk and returns the same glyphs', decodes === 0 && sameGlyphs(repeat.glyphs, oneShot.glyphs), `decodes ${decodes}`)

  const SEED2 = SEED + 1
  const expectedSeed2 = oracle(SEED2, roi, EXACT_KEY_STEP_M)
  check('seed precondition: the second seed changes the vegetation at this site', !sameGlyphs(expected.trees.map(t => t.g), expectedSeed2.trees.map(t => t.g)))
  const reseeded = runWindow(scannerA, sourcesAll, SEED2, false)
  const reseededTrees = reseeded.glyphs.filter(g => isTree(g) && within(g, roi))
  const reseededRocks = reseeded.glyphs.filter(g => isRock(g) && within(g, roi))
  check('seed change: the same scanner re-derives the interior glyphs for the new seed', sameGlyphs(reseededTrees, expectedSeed2.trees.map(t => t.g)) && sameGlyphs(reseededRocks, expectedSeed2.rocks), `trees want ${expectedSeed2.trees.length} got ${reseededTrees.length}; rocks want ${expectedSeed2.rocks.length} got ${reseededRocks.length}`)

  const excluded = mostCommon(expected.trees.map(t => t.species))
  const subsetSources = { vegetation: { _meshes: SPECIES.filter((_, i) => i !== excluded).map(name => ({ name })) }, rocks: {} }
  const subset = runWindow(createPlacementScanner(), subsetSources, SEED, false)
  const wantSubset = expected.trees.filter(t => t.species !== excluded).map(t => t.g)
  const gotSubset = subset.glyphs.filter(g => isTree(g) && within(g, roi))
  check('rendered filter: trees of a species with no mesh are dropped and the rest are kept', wantSubset.length < expected.trees.length && sameGlyphs(gotSubset, wantSubset), `want ${wantSubset.length} got ${gotSubset.length} (of ${expected.trees.length})`)

  const validWindow = () => ({ frame, field: anchorField, cx: site.cx, cz: site.cz, halfM: WINDOW_HALF_M, sources: sourcesAll, seed: SEED })
  const refused = (name, tweak) => {
    const args = validWindow()
    tweak(args)
    const scanner = createPlacementScanner()
    let threw = null
    let armed = null
    let steps = 0
    try {
      armed = scanner.begin(args.frame, args.field, args.sources, args.seed, args.cx, args.cz, args.halfM)
      for (;;) {
        steps++
        if (scanner.step(Infinity, () => {})) break
        if (steps > 1000000) throw new Error('scanner.step did not complete')
      }
    } catch (err) {
      threw = err
    }
    const glyphs = scanner.glyphSnapshot().length
    check(`precondition ${name}: begin refuses without throwing and the scan emits no glyph`, threw === null && armed === false && glyphs === 0, threw ? threw.message : `begin returned ${armed}, steps ${steps}, glyphs ${glyphs}`)
  }
  refused('sources absent', a => { a.sources = null })
  refused('sources not an object', a => { a.sources = 'vegetation' })
  refused('worldSeed absent', a => { a.seed = undefined })
  refused('worldSeed not an integer', a => { a.seed = SEED + 0.5 })
  refused('centre not finite', a => { a.cx = NaN })
  refused('halfM zero', a => { a.halfM = 0 })
  refused('halfM negative', a => { a.halfM = -WINDOW_HALF_M })
  refused('halfM not finite', a => { a.halfM = Infinity })
  refused('frame absent', a => { a.frame = null })
  refused('strokeCount not a count', a => { a.sources = { vegetation: { _meshes: SPECIES.map(name => ({ name })), biomeOverride: { strokeCount: -1 } }, rocks: {} } })

  const armedScanner = createPlacementScanner()
  const armedArgs = validWindow()
  check('precondition held: a valid window is armed', armedScanner.begin(armedArgs.frame, armedArgs.field, armedArgs.sources, armedArgs.seed, armedArgs.cx, armedArgs.cz, armedArgs.halfM) === true)
  const armedRun = drive(armedScanner, { frame, field: anchorField, cx: site.cx, cz: site.cz, halfM: WINDOW_HALF_M, sources: sourcesAll, seed: SEED, sliced: false })
  check('precondition held: the armed scan still matches the placement oracle', sameGlyphs(armedRun.glyphs.filter(g => within(g, roi)), [...expected.trees.map(t => t.g), ...expected.rocks]), `glyphs ${armedRun.glyphs.length}`)
  const armBreach = { vegetation: { _meshes: SPECIES.map(name => ({ name })), biomeOverride: { strokeCount: 2, wrapClimateField: f => f } }, rocks: {} }
  check('precondition: a source with a whole stroke count is accepted', armedScanner.begin(frame, anchorField, armBreach, SEED, site.cx, site.cz, WINDOW_HALF_M) === true)

  const brokenField = { sampleDir() { throw new Error('witness climate failure') } }
  let brokenRun = null
  let brokenError = null
  try {
    brokenRun = runWindow(createPlacementScanner(), sourcesAll, SEED, false, brokenField)
  } catch (err) {
    brokenError = err
  }
  check('classify failure: step completes without throwing and emits no glyphs', brokenError === null && brokenRun !== null && brokenRun.glyphs.length === 0, brokenError ? brokenError.message : `glyphs ${brokenRun ? brokenRun.glyphs.length : 'n/a'}`)

  verdict()
}

main()
  .catch(err => {
    console.log(`RESULT: FAIL -- uncaught: ${err && err.message ? err.message : err}`)
    process.exitCode = 1
  })
  .finally(() => clearTimeout(watchdog))
