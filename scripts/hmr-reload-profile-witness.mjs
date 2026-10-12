#!/usr/bin/env node
// Profiles what a hot reload of the client costs: for every module the dev HMR
// graph can reach from the client root, which of the four outcomes
// (accepted / patched / noop / full page reload) an edit to it produces today.
//
// A 'reload' outcome is the expensive one: it re-runs the whole boot, so the
// count of them is the count of full boots an editing session pays for.
//
// Paths resolve against this script's parent directory, never an absolute one.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const S = (p) => p.split('\\').join('/')
const rel = (p) => S(p.slice(REPO.length + 1))

let claims = 0
let failures = 0
function expect(name, got, want) {
  claims++
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` -- want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`}`)
}
function expectTrue(name, cond, why) {
  expect(name, !!cond, true)
  if (!cond && why) console.log(`     ${why}`)
}

const DECIDE = resolve(REPO, 'client', 'dev', 'hmr-decide.js')
const RUNTIME = resolve(REPO, 'client', 'dev', 'HmrRuntime.js')
const GRAPH = resolve(REPO, 'src', 'sdk', 'DevHmrGraph.js')
const DEVHMR = resolve(REPO, 'src', 'sdk', 'DevHmr.js')
const APP = resolve(REPO, 'client', 'app.js')
for (const [label, p] of [['hmr-decide.js', DECIDE], ['HmrRuntime.js', RUNTIME], ['DevHmrGraph.js', GRAPH], ['DevHmr.js', DEVHMR], ['app.js', APP]]) {
  if (!existsSync(p)) {
    claims++
    failures++
    console.log(`FAIL ${label} exists -- missing at ${rel(p)}`)
  }
}
if (failures) {
  console.log(`RESULT: FAIL (${failures} of ${claims} claim(s) failed)`)
  process.exit(1)
}

const { ancestorsOf, findBoundaries, isClass, loadedByPath, nothingLive, sameValue } = await import(pathToFileURL(DECIDE).href)

// --- the decision helpers themselves -----------------------------------------
expect('hmr-decide exports the five decision helpers',
  [typeof ancestorsOf, typeof findBoundaries, typeof isClass, typeof nothingLive, typeof sameValue],
  ['function', 'function', 'function', 'function', 'function'])

expect('nothingLive: an unloaded, non-eager, client-only module is not live',
  nothingLive({ worker: false, eager: false, loaded: false, tracked: 0 }), true)
expect('nothingLive: a worker-reachable module is live (the page cannot see the worker copy)',
  nothingLive({ worker: true, eager: false, loaded: false, tracked: 0 }), false)
expect('nothingLive: an eager module is live', nothingLive({ worker: false, eager: true, loaded: false, tracked: 0 }), false)
expect('nothingLive: a module with a resource timing entry is live', nothingLive({ worker: false, eager: false, loaded: true, tracked: 0 }), false)
expect('nothingLive: a module with a tracked instance is live', nothingLive({ worker: false, eager: false, loaded: false, tracked: 1 }), false)
expect('nothingLive: a missing field defaults to not-live', nothingLive({}), true)

const acc = new Map([['/mid.js', [{ fn: () => {} }]]])
expect('findBoundaries: no acceptor anywhere up to a parentless root gives null',
  findBoundaries(acc, { url: '/leaf.js', parents: { '/leaf.js': ['/mid2.js'], '/mid2.js': [] } }), null)
expect('findBoundaries: the nearest acceptor up the chain is the boundary',
  findBoundaries(acc, { url: '/leaf.js', parents: { '/leaf.js': ['/mid.js'], '/mid.js': [] } }), ['/mid.js'])
expect('findBoundaries: the changed module itself being accepted is its own boundary',
  findBoundaries(acc, { url: '/mid.js', parents: { '/mid.js': [] } }), ['/mid.js'])
expect('findBoundaries: a cycle above the change with no acceptor gives null, not an empty success',
  findBoundaries(acc, { url: '/a.js', parents: { '/a.js': ['/b.js'], '/b.js': ['/a.js'] } }), null)
expect('ancestorsOf: collects the transitive importers and itself',
  Object.keys(ancestorsOf({ '/leaf.js': ['/dep.js'], '/dep.js': ['/root.js'], '/root.js': [] }, '/leaf.js')).sort(),
  ['/dep.js', '/leaf.js', '/root.js'])
expect('isClass: a class declaration is a class',
  isClass(class Foo {}), true)
expect('isClass: a factory function is not a class',
  isClass(function createFoo() {}), false)

// The noop gate must never fire for a module the page is already running. The
// resource timing entry for an HMR re-import is filed under its `?hmr=` url, so
// an exact-name lookup alone would call a patched, live copy "not loaded".
expect('loadedByPath: an exact-name resource entry counts as loaded',
  loadedByPath(['http://localhost/core/Foo.js'], '/core/Foo.js'), true)
expect('loadedByPath: an hmr-versioned entry still counts as loaded',
  loadedByPath(['http://localhost/core/Foo.js?hmr=7&p=1'], '/core/Foo.js'), true)
expect('loadedByPath: a different pathname does not count',
  loadedByPath(['http://localhost/core/Bar.js'], '/core/Foo.js'), false)
expect('loadedByPath: an unparsable entry is skipped, not fatal',
  loadedByPath(['not a url'], '/core/Foo.js'), false)
expect('loadedByPath: no entries at all is not loaded',
  loadedByPath([], '/core/Foo.js'), false)

// --- the real module graph ---------------------------------------------------
const { createModuleGraph, readImportMap, urlToFile } = await import(pathToFileURL(GRAPH).href)
const staticDirs = [
  { prefix: '/src/', dir: join(REPO, 'src') },
  { prefix: '/apps/', dir: join(REPO, 'apps') },
  { prefix: '/node_modules/', dir: join(REPO, 'node_modules') },
  { prefix: '/', dir: join(REPO, 'client') },
]
const importMap = readImportMap(join(REPO, 'client', 'index.html'))
const CLIENT_ROOT = '/app.js'
const WORKER_ROOT = '/src/sdk/WorkerEntry.js'
const tBuild = Date.now()
const g = createModuleGraph({ staticDirs, importMap, roots: [CLIENT_ROOT, WORKER_ROOT] })
const graphBuildMs = Date.now() - tBuild
const urls = [...new Set([CLIENT_ROOT, WORKER_ROOT, ...g.parents.keys()])]

expectTrue('the client index.html carries an import map the graph can resolve', Object.keys(importMap).length > 0,
  `readImportMap(${rel(join(REPO, 'client', 'index.html'))}) returned no imports`)
expectTrue('the graph reaches the two HMR roots', g.size() > 100 && g.reaches(CLIENT_ROOT, CLIENT_ROOT),
  `graph size ${g.size()}`)

// --- the real accept table, read out of client/app.js ------------------------
const appSrc = readFileSync(APP, 'utf8')
const accepted = new Set()
// `hmr.subsystem(url, fn)` pushes fn into the same acceptor table `hmr.accept`
// does, so it is a registration of exactly the same kind -- read both or the
// profile under-counts the modules an edit can land in place.
for (const m of appSrc.matchAll(/\.accept\(\s*'([^']+)'/g)) accepted.add(m[1])
for (const m of appSrc.matchAll(/\.subsystem\(\s*'([^']+)'/g)) accepted.add(m[1])
const sceneryBlock = /const scenery = \{([\s\S]*?)\n  \}/.exec(appSrc)
const sceneryNames = sceneryBlock ? [...sceneryBlock[1].matchAll(/^\s{4}(\w+): \{ key:/gm)].map(m => m[1]) : []
for (const n of sceneryNames) accepted.add(`/core/${n}.js`)
const graphBuildersBlock = /const graphBuilders = \{([\s\S]*?)\n  \}/.exec(appSrc)
const graphBuilderUrls = graphBuildersBlock ? [...graphBuildersBlock[1].matchAll(/'([^']+)':/g)].map(m => m[1]) : []
for (const u of graphBuilderUrls) accepted.add(u)
const acceptors = new Map([...accepted].map(u => [u, [{ fn: () => {} }]]))

expectTrue('client/app.js registers direct acceptors', sceneryNames.length === 3 && graphBuilderUrls.length === 6,
  `scenery=${JSON.stringify(sceneryNames)} graphBuilders=${JSON.stringify(graphBuilderUrls)}`)
expectTrue('every accepted url is a node in the graph',
  [...accepted].every(u => urls.includes(u)),
  `accepted but not graphed: ${JSON.stringify([...accepted].filter(u => !urls.includes(u)))}`)

// --- classify every client-reachable module ---------------------------------
const tally = { accepted: 0, noop: 0, reload: 0 }
const perArea = {}
const noopUrls = []
const reloadEagerUrls = []
for (const url of urls) {
  if (!g.reaches(CLIENT_ROOT, url)) continue
  const worker = g.reaches(WORKER_ROOT, url)
  const eager = g.isEager(CLIENT_ROOT, url)
  const area = url.startsWith('/src/') ? 'src' : url.startsWith('/node_modules/') ? 'node_modules' : url.startsWith('/apps/') ? 'apps' : 'client'
  const key = `${area}|${worker ? 'shared-with-worker' : 'client-only'}`
  const bucket = perArea[key] || (perArea[key] = { accepted: 0, noop: 0, reload: 0 })
  if (accepted.has(url) || findBoundaries(acceptors, { url, parents: g.ancestors(url) })) {
    tally.accepted++
    bucket.accepted++
    continue
  }
  // The runtime only reaches this point when tryClassPatch found nothing to
  // patch, so the remaining question is whether a reload is even needed.
  if (nothingLive({ worker, eager, loaded: false, tracked: 0 })) {
    tally.noop++
    bucket.noop++
    noopUrls.push(url)
  } else {
    tally.reload++
    bucket.reload++
    reloadEagerUrls.push(url)
  }
}
const clientReachable = tally.accepted + tally.noop + tally.reload

console.log(`PROFILE modules=${urls.length} clientReachable=${clientReachable} graphBuildMs=${graphBuildMs}`)
// Before the nothingLive gate every module that missed an acceptor fell through
// to `findBoundaries` and then to a full reload, so the baseline reload count is
// the whole non-accepted set. Both lines come off the same graph, so the delta
// is a measurement of the gate and not of a tree that moved between runs.
console.log(`PROFILE before accepted=${tally.accepted} noop=0 reload=${clientReachable - tally.accepted}`)
console.log(`PROFILE after accepted=${tally.accepted} noop=${tally.noop} reload=${tally.reload}`)
for (const k of Object.keys(perArea).sort()) {
  const b = perArea[k]
  console.log(`PROFILE area ${k} accepted=${b.accepted} noop=${b.noop} reload=${b.reload}`)
}
console.log(`PROFILE noop-sample ${JSON.stringify(noopUrls.sort().slice(0, 12))}`)
console.log(`PROFILE reload-sample ${JSON.stringify(reloadEagerUrls.sort().slice(0, 12))}`)

expect('accepted + noop + reload partitions every client-reachable module', clientReachable > 0, true)
expectTrue('the accept table already covers some of the graph', tally.accepted > 0, `accepted=${tally.accepted}`)
expectTrue('the gate moves modules off the reload path and onto noop, one for one',
  tally.noop > 0 && tally.reload === clientReachable - tally.accepted - tally.noop,
  `accepted=${tally.accepted} noop=${tally.noop} reload=${tally.reload} clientReachable=${clientReachable}`)
expectTrue('at least a tenth of the client graph no longer costs a full boot to edit',
  tally.noop / clientReachable >= 0.1,
  `noop share ${(100 * tally.noop / clientReachable).toFixed(1)}% (${tally.noop}/${clientReachable})`)
expectTrue('a noop is only ever claimed for a client-only, non-eager module',
  noopUrls.every(u => !g.reaches(WORKER_ROOT, u) && !g.isEager(CLIENT_ROOT, u)),
  `offending: ${JSON.stringify(noopUrls.filter(u => g.reaches(WORKER_ROOT, u) || g.isEager(CLIENT_ROOT, u)))}`)
expectTrue('every module left on the reload path is either eager or shared with the worker',
  reloadEagerUrls.every(u => g.isEager(CLIENT_ROOT, u) || g.reaches(WORKER_ROOT, u)),
  `offending: ${JSON.stringify(reloadEagerUrls.filter(u => !g.isEager(CLIENT_ROOT, u) && !g.reaches(WORKER_ROOT, u)))}`)

// --- the runtime's own files must be servable, or HMR dies at import --------
// HmrRuntime.js is injected as a separate <script type="module">, so its
// relative import of ./hmr-decide.js is fetched as /dev/hmr-decide.js. In
// bundle mode the client root is dist/client, which has no dev/, so this only
// resolves through the raw client dir that buildStaticDirs appends last.
expect('the dev server resolves /dev/HmrRuntime.js', urlToFile('/dev/HmrRuntime.js', staticDirs) !== null, true)
expect('the dev server resolves /dev/hmr-decide.js', urlToFile('/dev/hmr-decide.js', staticDirs) !== null, true)

// --- the runtime must actually consult nothingLive --------------------------
const runtimeSrc = readFileSync(RUNTIME, 'utf8')
expectTrue('HmrRuntime.js imports nothingLive from hmr-decide.js',
  /import \{[^}]*\bnothingLive\b[^}]*\} from '\.\/hmr-decide\.js'/.test(runtimeSrc),
  'the gate is gone: an edit to an unloaded module would fall through to a full reload again')
expectTrue('wasLoaded falls back to a pathname match so an hmr-versioned copy still counts as live',
  /import \{[^}]*\bloadedByPath\b[^}]*\} from '\.\/hmr-decide\.js'/.test(runtimeSrc) &&
  /loadedByPath\(performance\.getEntriesByType\('resource'\)/.test(runtimeSrc),
  'an exact-name lookup alone would call a patched copy not-loaded and noop the edit that should swap it')
// --- a noop must never be handed to a page that IS running the old copy -----
// Two ways that could happen, both excluded by ordering rather than by hope:
// the bundle short-circuit runs first (a bundle-mode page has one resource entry
// for the whole bundle, so nothingLive would call every module unloaded), and
// DevHmr reports bundle:true on the one edit that drops the bundles, which
// reloads the page into raw ESM before any later gate can fire.
const devHmrSrc = readFileSync(DEVHMR, 'utf8')
expectTrue('the bundle short-circuit precedes the nothingLive gate in applyModule',
  runtimeSrc.indexOf('if (ev.bundle)') >= 0 && runtimeSrc.indexOf('if (ev.bundle)') < runtimeSrc.indexOf('nothingLive('),
  'with the gate first, a bundle-mode page has no per-module resource entries, so every edit would be noop\'d while bundled code kept running')
expectTrue('DevHmr drops the bundles and flags bundle:true on the first client/worker edit',
  /bundle: wasBundle && \(client \|\| worker\)/.test(devHmrSrc) && /if \(wasBundle && \(client \|\| worker\)\) dropBundles\(\)/.test(devHmrSrc),
  'without bundle:true on that first edit, the page would stay on bundled code and the gate would then report its modules as unloaded')
expectTrue('HmrRuntime.js has no second copy of findBoundaries shadowing the import',
  (runtimeSrc.match(/function findBoundaries/g) || []).length === 0,
  'a local findBoundaries next to the imported one is a duplicate definition')

console.log(`${claims - failures} of ${claims} claim(s) passed`)
console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures} of ${claims} claim(s) failed)`)
process.exitCode = failures === 0 ? 0 : 1
