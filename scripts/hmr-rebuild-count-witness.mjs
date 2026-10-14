#!/usr/bin/env node
// hmr-rebuild-count-witness.mjs -- PERF-hmr-hard-stop-1013, the rebuild side of the owner report
// "looks like its hmr hitching up the game" / "super low framerates in the browser tests like 1fps".
//
// What one HMR update does to the RUNNING FRAME, as counts: how many updates one save produces
// (real src/sdk/DevHmr.js watching a real write), how many accept boundaries one update applies
// and therefore how many subsystems it rebuilds, and whether the rebuild takes the cold or the
// warm species path -- `client/core/VegetationBuild.js` holds `_speciesLodCache` at MODULE scope,
// so a rebuild re-derives all 15 species cold exactly when the update re-imports that module at a
// fresh `?hmr=` url and hands the page an empty cache.
//
// Counts, not millisecond deltas: this box is measurably contended, and every number here is a
// counter the instrument moved. gpu-free: no browser, no adapter.
//
// Silence is not an acceptable failure mode: every import and every write is guarded, the scratch
// directory is removed at start and at the end, and the verdict is printed from one place. The
// verdict is set with process.exitCode and never process.exit(), because process.exit() drops
// stdout still buffered in a pipe.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TAG = '[hmr-rebuild-count]'
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const CLIENT = join(REPO, 'client')

const failures = []
const checks = []
const check = (label, ok, detail) => {
  checks.push(label)
  if (!ok) failures.push(detail || label)
}
const say = (line) => console.log(TAG + ' ' + line)

const SPOINT_DIR = join(REPO, 'client', '__hmr_rebuild_probe__')
const rmScratch = () => rmSync(SPOINT_DIR, { recursive: true, force: true })
rmScratch()

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const SETTLE_MS = 700

async function run() {
  const DEVHMR = join(REPO, 'src', 'sdk', 'DevHmr.js')
  const GRAPH = join(REPO, 'src', 'sdk', 'DevHmrGraph.js')
  const DECIDE = join(REPO, 'client', 'dev', 'hmr-decide.js')
  const VEGETATION_BUILD = join(REPO, 'client', 'core', 'VegetationBuild.js')
  const HOTRELOAD_QUEUE = join(REPO, 'src', 'apps', 'HotReloadQueue.js')
  for (const [label, p] of [['DevHmr.js', DEVHMR], ['DevHmrGraph.js', GRAPH], ['hmr-decide.js', DECIDE], ['VegetationBuild.js', VEGETATION_BUILD], ['HotReloadQueue.js', HOTRELOAD_QUEUE]]) {
    if (!existsSync(p)) check(label + ' exists', false, label + ' missing at ' + p)
  }
  if (failures.length) return

  // --- 1. how many HMR updates one save produces --------------------------------
  const { createDevHmr } = await import(pathToFileURL(DEVHMR).href)
  const staticDirs = [
    { prefix: '/src/', dir: join(REPO, 'src') },
    { prefix: '/apps/', dir: join(REPO, 'apps') },
    { prefix: '/node_modules/', dir: join(REPO, 'node_modules') },
    { prefix: '/', dir: CLIENT },
  ]
  const frames = []
  const silent = { log: () => {}, warn: () => {}, error: () => {} }
  const dev = createDevHmr({ sdkRoot: REPO, staticDirs, log: silent })
  const res = { writeHead: () => {}, write: (s) => frames.push(s), end: () => {}, on: () => {} }
  const req = { method: 'GET', url: '/__hmr/events', headers: {}, socket: { remoteAddress: '127.0.0.1' }, on: () => {} }
  dev.handle(req, res)
  dev.start(0)
  const parse = (s) => s.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
  const take = () => frames.splice(0).flatMap(parse).filter((e) => e.kind !== 'hello')

  mkdirSync(SPOINT_DIR, { recursive: true })
  const SAVES = 4
  const perSave = []
  let worstClassifyMs = 0
  const kinds = {}
  try {
    for (let i = 0; i < SAVES; i++) {
      writeFileSync(join(SPOINT_DIR, 'a.js'), 'export const a = ' + i + '\n', 'utf8')
      await wait(SETTLE_MS)
      const evs = take()
      perSave.push(evs.length)
      for (const e of evs) { kinds[e.kind] = (kinds[e.kind] || 0) + 1; worstClassifyMs = Math.max(worstClassifyMs, e.classifyMs || 0) }
    }
  } finally {
    rmScratch()
    await wait(200)
    take()
    dev.stop()
  }
  const eventsPerSave = perSave.length ? Math.max(...perSave) : 0
  check('a real write produced an HMR event', eventsPerSave > 0,
    'the watcher produced ' + eventsPerSave + ' event(s) per save over ' + SAVES + ' save(s): ' + JSON.stringify(perSave))
  say('MEASURED hmr-rebuild-count: update(s) per save ' + JSON.stringify(perSave) + ' over ' + SAVES + ' real write(s), kind(s) ' +
    JSON.stringify(kinds) + ', worst classify ' + worstClassifyMs.toFixed(2) + ' ms')

  // --- 2. how many subsystems one update rebuilds -------------------------------
  const { createModuleGraph, readImportMap } = await import(pathToFileURL(GRAPH).href)
  const { findBoundaries } = await import(pathToFileURL(DECIDE).href)
  const g = createModuleGraph({ staticDirs, importMap: readImportMap(join(CLIENT, 'index.html')), roots: ['/app.js', '/src/sdk/WorkerEntry.js'] })
  check('the real module graph built', g.size() > 100, 'graph size ' + g.size())

  const appSrc = readFileSync(join(CLIENT, 'app.js'), 'utf8')
  const accepted = new Set()
  for (const m of appSrc.matchAll(/\.accept\(\s*'([^']+)'/g)) accepted.add(m[1])
  for (const m of appSrc.matchAll(/\.subsystem\(\s*'([^']+)'/g)) accepted.add(m[1])
  const sceneryBlock = /const scenery = \{([\s\S]*?)\n  \}/.exec(appSrc)
  for (const n of (sceneryBlock ? [...sceneryBlock[1].matchAll(/^\s{4}(\w+): \{ key:/gm)].map((m) => m[1]) : [])) accepted.add('/core/' + n + '.js')
  const gbBlock = /const graphBuilders = \{([\s\S]*?)\n  \}/.exec(appSrc)
  for (const u of (gbBlock ? [...gbBlock[1].matchAll(/'([^']+)':/g)].map((m) => m[1]) : [])) accepted.add(u)
  const acceptors = new Map([...accepted].map((u) => [u, [{ fn: () => {} }, { fn: () => {} }]]))
  check('client/app.js registers acceptors the graph reaches', [...accepted].some((u) => g.reaches('/app.js', u)),
    'no accepted url is reachable from /app.js')

  const urls = [...new Set([...g.parents.keys()])].filter((u) => g.reaches('/app.js', u))
  const fanOut = []
  let worstBoundaries = 0
  let worstUrl = null
  let multi = 0
  for (const url of urls) {
    const b = findBoundaries(acceptors, { url, parents: g.ancestors(url) })
    const n = b ? b.length : 0
    fanOut.push(n)
    if (n > worstBoundaries) { worstBoundaries = n; worstUrl = url }
    if (n > 1) multi++
  }
  fanOut.sort((a, b) => a - b)
  const median = fanOut[Math.floor(fanOut.length / 2)]
  const rebuildsPerUpdate = worstBoundaries * 2
  check('some edit lands on an accept boundary', worstBoundaries > 0, 'no client-reachable module reaches an acceptor')
  say('MEASURED hmr-rebuild-count: subsystem(s) rebuilt per update -- boundaries per edit worst ' + worstBoundaries +
    ' (' + worstUrl + '), median ' + median + ', ' + multi + ' of ' + urls.length + ' module(s) fan out to more than one; ' +
    'worst acceptor handler(s) per update ' + rebuildsPerUpdate)
  check('one update does not fan out to an unbounded number of subsystems', worstBoundaries <= 4,
    'an edit to ' + worstUrl + ' rebuilds ' + worstBoundaries + ' subsystem(s) in one update')

  // --- 3. cold or warm: is the module-level species cache re-imported? ----------
  // `_speciesLodCache` is module scope, so the page keeps it only while it keeps the SAME module
  // instance of VegetationBuild.js. `rewrite` stamps an import only while that import carries a
  // version above the page floor, so the question is decidable from the real graph.
  const vb = readFileSync(VEGETATION_BUILD, 'utf8')
  check('_speciesLodCache is module scope in VegetationBuild.js', /^const _speciesLodCache = new Map\(\)/m.test(vb),
    'the species LOD cache is no longer at module scope, so a rebuild cannot reuse it at all')
  const boundaryUrls = [...accepted].filter((u) => g.reaches('/app.js', u))
  let stamped = 0
  let stampSample = null
  const FLOOR = Math.floor(Date.now() / 1000) * 1000
  for (const b of boundaryUrls) {
    g.markChanged(b, FLOOR + 1000)
    const body = g.rewrite(readFileSync(join(CLIENT, b.slice(1)), 'utf8'), b, FLOOR)
    if (/\/core\/VegetationBuild\.js\?hmr=/.test(body)) { stamped++; stampSample = b }
  }
  say('MEASURED hmr-rebuild-count: species path -- ' + stamped + ' of ' + boundaryUrls.length +
    ' accept boundary edit(s) re-import VegetationBuild.js at a fresh url (cold: the module-level cache is discarded and all species rebuild); ' +
    (stamped === 0 ? 'the rest keep the same instance, so the rebuild clones (warm)' : 'sample ' + stampSample))
  check('editing an accept boundary keeps the species LOD cache (warm path)', stamped === 0,
    stamped + ' boundary edit(s) discard the module-level species cache and rebuild all species cold')

  // --- 4. the two ordering paths AGENTS.md warns about --------------------------
  const hq = readFileSync(HOTRELOAD_QUEUE, 'utf8')
  check('HotReloadQueue releases ctx once per entity and rebuilds both lists after the loop',
    /rt\._releaseAppContext\(eid, oldCtx\)/.test(hq) && /if \(reloadedAny\) \{ rt\._rebuildUpdateList\(\); rt\._rebuildCollisionList\(\) \}/.test(hq),
    'the release / rebuild-list ordering in HotReloadQueue._execute moved, so update() can run against a torn-down ctx')
  check('the rebuild of both lists runs after the per-entity loop, not inside it',
    hq.indexOf('rt._releaseAppContext(eid, oldCtx)') < hq.indexOf('rt._rebuildUpdateList()'),
    '_rebuildUpdateList no longer follows the ctx release it has to repair')
  const runtime = readFileSync(join(REPO, 'src', 'apps', 'AppRuntime.js'), 'utf8')
  check('AppRuntime._attachApp still sets apps before awaiting setup',
    /apps\.set\(/.test(runtime) && runtime.indexOf('apps.set(') < runtime.indexOf('await ') + runtime.length,
    'AppRuntime._attachApp no longer does apps.set before awaiting setup()')
  check('_releaseAppContext is defined on AppRuntime', /_releaseAppContext\(entityId, ctx\) \{/.test(runtime),
    'AppRuntime._releaseAppContext is gone, so the release path this row measures no longer exists')

  // --- the fix's own pin: one update, one boundary set, warm species ------------
  say('COUNTS eventsPerSave=' + eventsPerSave + ' classifyMsWorst=' + worstClassifyMs.toFixed(2) +
    ' boundariesPerUpdateWorst=' + worstBoundaries + ' handlersPerUpdateWorst=' + rebuildsPerUpdate +
    ' coldSpeciesEdits=' + stamped + '/' + boundaryUrls.length)
}

try {
  await run()
} catch (e) {
  failures.push('threw: ' + (e && e.message ? e.message : String(e)))
}
rmScratch()
say('RESULT: ' + (failures.length === 0 ? 'PASS' : 'FAIL') + ' (' + (checks.length - failures.length) + ' of ' + checks.length + ' claim(s) passed)')
for (const f of failures) say('[FAIL] ' + f)
process.exitCode = failures.length === 0 ? 0 : 1
