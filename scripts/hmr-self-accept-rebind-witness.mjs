#!/usr/bin/env node
// hmr-self-accept-rebind-witness.mjs -- PERF-hmr-reload-class-1013.
//
// The RELOAD CLASS: an edit to client/core/SceneSetup.js was classified reload, not accept,
// because client/app.js imports it STATICALLY, so findBoundaries walked from it to the app root
// and found no acceptor. 92% of the real module graph is in that class, and four real edits to
// SceneSetup.js measured 0.83 playable frames/s against 59.21 settled
// (scripts/one-fps-pathology-witness.mjs) -- the cost of a save was a whole page load.
//
// An accept boundary ABOVE a root-level static import cannot re-bind that import: a re-import is a
// new module instance and app.js keeps reading the one it imported at boot. What CAN move it is the
// module itself, because an ESM import is a LIVE binding to the instance's export bindings and
// re-assigning them is visible to every importer already holding them. So SceneSetup.js
// self-accepts and re-assigns its exports to the freshly imported copy.
//
// This witness runs the real client/dev/HmrRuntime.js, the real client/dev/hmr-decide.js, the real
// client/core/SceneSetup.js and the real module graph under node. gpu-free: it never opens a
// browser and never touches an adapter. It is a COUNT, not a millisecond delta, because this box is
// contended: page reloads and versioned module fetches per save, and which function object the
// export binding resolves to.
//
// Non-vacuous in both directions. Zero reloads is also what a silent no-op reports, so the witness
// (a) proves the binding actually moved, to the copy the runtime imported for that version, and
// (b) proves a static importer of a self-accepting module reads a GENUINELY EDITED copy after the
// swap, and (c) fires one module with no acceptor at all afterwards to show the reload counter does
// move when it should.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TAG = '[hmr-self-accept-rebind]'
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

// --- counters that must exist before anything can throw ----------------------
let versionedImports = 0
let lastVersionedHref = null
let reloaded = 0

// --- root-absolute specifier remap -------------------------------------------
// Client modules import their siblings by root-absolute specifier ('/core/Foo.js',
// '/src/terrain/PlanetFrame.js'), which the ESM resolver reads as a path from the drive root. The
// `?hmr=<v>&p=<floor>` query rides along so a versioned re-import is a distinct module instance,
// exactly as it is in the browser. A self-acceptor registers under keyOf(import.meta.url), which
// under node is a file:// url, so a specifier that is already an absolute path on this platform is
// accepted too -- that is the shape the runtime's own versionedUrl() produces for such a key.
function resolveSpecifierHook(specifier, context, nextResolve) {
  if (!specifier.startsWith('/') || specifier.startsWith('//')) return nextResolve(specifier, context)
  const [path, query = ''] = specifier.split('?')
  let file = null
  if (existsSync(join(CLIENT, path))) file = join(CLIENT, path)
  else if (existsSync(join(REPO, path))) file = join(REPO, path)
  else if (/^\/[A-Za-z]:/.test(path) && existsSync(path.slice(1))) file = path.slice(1)
  else if (existsSync(path)) file = path
  if (file === null) return nextResolve(specifier, context)
  const href = pathToFileURL(file).href + (query ? '?' + query : '')
  if (query.includes('hmr=')) { versionedImports++; lastVersionedHref = href }
  return nextResolve(href, context)
}
async function installHooks() {
  const mod = await import('node:module')
  if (typeof mod.registerHooks === 'function') { mod.registerHooks({ resolve: resolveSpecifierHook }); return 'registerHooks' }
  if (typeof mod.register === 'function') {
    mod.register(pathToFileURL(join(HERE, 'lib', 'hmr-specifier-loader.mjs')).href)
    return 'module.register'
  }
  throw new Error(TAG + ' this node exposes neither registerHooks (>=22.15) nor register (>=20.6)')
}
say('specifier hook: ' + await installHooks())

// --- browser shims, installed before the runtime is imported -----------------
const realPerformance = globalThis.performance
Object.defineProperty(globalThis, 'performance', {
  configurable: true,
  value: {
    timeOrigin: realPerformance.timeOrigin,
    now: () => realPerformance.now(),
    setResourceTimingBufferSize: () => {},
    getEntriesByName: () => [],
    getEntriesByType: () => [],
  },
})
const store = new Map()
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
})
Object.defineProperty(globalThis, 'location', {
  configurable: true,
  value: { href: 'http://127.0.0.1:8099/app.js', reload: () => { reloaded++ } },
})
Object.defineProperty(globalThis, 'CustomEvent', {
  configurable: true,
  value: class { constructor(type, init) { this.type = type; this.detail = init && init.detail } },
})
let source = null
Object.defineProperty(globalThis, 'EventSource', {
  configurable: true,
  value: class { constructor(url) { this.url = url; source = this } },
})
Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: () => [] } })
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { dispatchEvent: () => true, addEventListener: () => {}, __app: {}, __spoint: {} },
})
Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => ({ ok: true }) })

// --- the real module graph ---------------------------------------------------
const GRAPH = join(REPO, 'src', 'sdk', 'DevHmrGraph.js')
const DECIDE = join(CLIENT, 'dev', 'hmr-decide.js')
const RUNTIME = join(CLIENT, 'dev', 'HmrRuntime.js')
const SCENE_SETUP = join(CLIENT, 'core', 'SceneSetup.js')
for (const [label, p] of [['DevHmrGraph.js', GRAPH], ['hmr-decide.js', DECIDE], ['HmrRuntime.js', RUNTIME], ['SceneSetup.js', SCENE_SETUP]]) {
  if (!existsSync(p)) check(label + ' exists', false, label + ' missing at ' + p)
}
if (failures.length) {
  say('RESULT: FAIL (' + failures.length + ' of ' + checks.length + ' claim(s) failed)')
  for (const f of failures) say('[FAIL] ' + f)
  process.exitCode = 1
} else {
  await run()
}

async function run() {
  const { createModuleGraph, readImportMap } = await import(pathToFileURL(GRAPH).href)
  const { findBoundaries } = await import(pathToFileURL(DECIDE).href)
  check('findBoundaries is exported by hmr-decide.js', typeof findBoundaries === 'function',
    'hmr-decide.js exported no findBoundaries, so the classification is not the real one')

  const staticDirs = [
    { prefix: '/src/', dir: join(REPO, 'src') },
    { prefix: '/apps/', dir: join(REPO, 'apps') },
    { prefix: '/node_modules/', dir: join(REPO, 'node_modules') },
    { prefix: '/', dir: CLIENT },
  ]
  const importMap = readImportMap(join(CLIENT, 'index.html'))
  const CLIENT_ROOT = '/app.js'
  const WORKER_ROOT = '/src/sdk/WorkerEntry.js'
  const g = createModuleGraph({ staticDirs, importMap, roots: [CLIENT_ROOT, WORKER_ROOT] })
  check('the real module graph built', g.size() > 100, 'graph size ' + g.size())

  const SCENE_SETUP_URL = '/core/SceneSetup.js'
  const sample = [...g.parents.keys()].filter((u) => !u.startsWith('/node_modules/'))
  const appSrc = readFileSync(join(CLIENT, 'app.js'), 'utf8')
  const above = new Set()
  for (const m of appSrc.matchAll(/\.accept\(\s*'([^']+)'/g)) above.add(m[1])
  for (const m of appSrc.matchAll(/\.subsystem\(\s*'([^']+)'/g)) above.add(m[1])
  const reachBase = new Map()
  for (const u of above) if (g.reaches(CLIENT_ROOT, u)) reachBase.set(u, [{ fn: () => {}, self: false }])
  // A self-acceptor is registered by the module itself, so the acceptor set that reflects the
  // source is "every module whose source calls acceptSelf".
  const selfAccepting = sample.filter((u) => {
    try { return /acceptSelf\s*[?(]/.test(readFileSync(join(CLIENT, u.slice(1)), 'utf8')) } catch (_) { return false }
  })
  const reachAll = new Map(reachBase)
  for (const u of selfAccepting) {
    const list = (reachAll.get(u) || []).slice()
    list.push({ fn: () => {}, self: true })
    reachAll.set(u, list)
  }
  check('at least one real module self-accepts', selfAccepting.length > 0,
    'no module under client/ calls acceptSelf, so the reload class is untouched')

  const share = (reach) => {
    let reload = 0
    let accept = 0
    for (const u of sample) { if (findBoundaries(reach, { url: u, parents: g.ancestors(u) })) accept++; else reload++ }
    return { reload, accept }
  }
  const before = share(reachBase)
  const after = share(reachAll)
  say('DECIDE over the real graph: ' + sample.length + ' module(s), ' + above.size +
    ' acceptor(s) registered above, ' + selfAccepting.length + ' self-accepting module(s): ' +
    before.reload + ' reload / ' + before.accept + ' accept -> ' + after.reload + ' reload / ' + after.accept + ' accept')

  const atBase = findBoundaries(reachBase, { url: SCENE_SETUP_URL, parents: g.ancestors(SCENE_SETUP_URL) })
  const atAll = findBoundaries(reachAll, { url: SCENE_SETUP_URL, parents: g.ancestors(SCENE_SETUP_URL) })
  check('SceneSetup.js lands on the full page reload without its self-acceptor', atBase === null,
    'findBoundaries returned ' + JSON.stringify(atBase) + ' for ' + SCENE_SETUP_URL + ', so the row premise does not hold')
  check('SceneSetup.js accepts at itself once it self-accepts',
    !!atAll && atAll.length === 1 && atAll[0] === SCENE_SETUP_URL,
    'findBoundaries returned ' + JSON.stringify(atAll) + ' for ' + SCENE_SETUP_URL)
  check('the self-acceptor does not swallow a dependency of the module it sits on',
    g.depsOf(SCENE_SETUP_URL).every((d) => {
      const b = findBoundaries(reachAll, { url: d, parents: g.ancestors(d) })
      return !b || !b.includes(SCENE_SETUP_URL)
    }),
    'a dependency of ' + SCENE_SETUP_URL + ' resolves to ' + SCENE_SETUP_URL +
    ', which would report that edit as accepted while nothing re-reads it')

  // --- the real runtime, the real module, a real save ---------------------------
  await import(pathToFileURL(RUNTIME).href)
  const hmr = globalThis.__spointHmr
  check('HmrRuntime.js exposes its api', !!hmr && typeof hmr.acceptSelf === 'function' && typeof hmr.settled === 'function',
    '__spointHmr is missing acceptSelf/settled')
  check('HmrRuntime.js connected an event source', !!source, 'no EventSource was constructed')
  if (!hmr || !source) return

  const live = await import(SCENE_SETUP_URL)
  // keyOf(import.meta.url): under node that is a file:// url, and the runtime keys acceptors by
  // pathname, so the event url the module registered under is exactly this.
  const LIVE_KEY = new URL(pathToFileURL(SCENE_SETUP).href).pathname
  const beforeFns = [live.createScene, live.setupLights, live.warmupShaders, live.limitTextureSize]
  check('SceneSetup.js loaded with every export it is meant to re-bind',
    beforeFns.every((f) => typeof f === 'function') && typeof live.MAX_UNMANIFESTED_WARMUP_MESHES === 'number',
    'SceneSetup.js did not export the functions the hot swap re-binds')

  const fireSave = async (v0, n) => {
    for (let i = 0; i < n; i++) {
      source.onmessage({ data: JSON.stringify({
        kind: 'module', seq: v0 + i, t: Date.now(), path: 'core/SceneSetup.js', url: LIVE_KEY, v: v0 + i,
        parents: {}, client: true, worker: false, eager: true,
      }) })
    }
    await hmr.settled()
  }

  const seg0 = { reloads: reloaded, imports: versionedImports }
  await fireSave(1000, 4)
  const first = { reloads: reloaded - seg0.reloads, imports: versionedImports - seg0.imports, href: lastVersionedHref }
  const swapped = first.href ? await import(first.href) : null
  check('four edits to SceneSetup.js ordered NO page reload', first.reloads === 0,
    first.reloads + ' page reload(s) for one save of ' + SCENE_SETUP_URL)
  check('one save fetched the module once, not once per edit', first.imports === 1,
    first.imports + ' versioned module fetch(es) for one save')
  check('the runtime imported a copy to swap in', !!swapped && swapped !== live,
    'no versioned copy of SceneSetup.js was imported, so the swap had nothing to swap to')
  if (!swapped) return
  const movedFns = [live.createScene, live.setupLights, live.warmupShaders, live.limitTextureSize]
  const moved = movedFns.filter((f, i) => f === swapped[['createScene', 'setupLights', 'warmupShaders', 'limitTextureSize'][i]] && f !== beforeFns[i]).length
  check('the export bindings resolve to the copy the runtime just imported', moved === movedFns.length,
    moved + ' of ' + movedFns.length + ' export binding(s) moved to the new copy')
  check('the value export moved too', live.MAX_UNMANIFESTED_WARMUP_MESHES === swapped.MAX_UNMANIFESTED_WARMUP_MESHES,
    'MAX_UNMANIFESTED_WARMUP_MESHES did not move, so a re-assigned `export let` is not reaching its importers')

  // A second save has to land as well: acceptSelf used to be dropped after it ran once.
  const seg1 = { reloads: reloaded, imports: versionedImports }
  const secondBefore = live.setupLights
  await fireSave(2000, 4)
  const second = { reloads: reloaded - seg1.reloads, imports: versionedImports - seg1.imports, href: lastVersionedHref }
  const swapped2 = second.href ? await import(second.href) : null
  check('a SECOND save still reloads nothing and still swaps', second.reloads === 0 && second.imports === 1 &&
    !!swapped2 && live.setupLights === swapped2.setupLights && live.setupLights !== secondBefore,
    'second save: ' + second.reloads + ' reload(s), ' + second.imports + ' fetch(es), binding moved=' +
    (!!swapped2 && live.setupLights === swapped2.setupLights))

  // --- non-vacuity: the edit really reaches a static importer -------------------
  // Zero reloads is what a silent no-op reports too. The pair below is the smallest thing with the
  // same shape as app.js -> SceneSetup.js: a STATIC import, a self-accepting module, and a swap.
  // It is edited on disk between the two imports, so the function the importer ends up calling is
  // demonstrably the post-edit one.
  const TMP = join(REPO, '.gm', 'tmp', 'hmr-self-accept-rebind')
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  const targetPath = join(TMP, 'target.js')
  const consumerPath = join(TMP, 'consumer.js')
  const writeTarget = (v) => writeFileSync(targetPath, [
    "export let marker = '" + v + "'",
    'export function read() { return marker }',
    'const swap = (next) => { marker = next.marker; read = next.read }',
    'export function hotSwap(next) { swap(next) }',
    'globalThis.__spointHmr?.acceptSelf?.(import.meta.url, swap)',
    '',
  ].join('\n'))
  writeFileSync(consumerPath, ["import { read } from './target.js'", 'export const value = () => read()', ''].join('\n'))
  let pairOk = false
  let pairDetail = 'not run'
  try {
    writeTarget('v1')
    const target = await import(pathToFileURL(targetPath).href)
    const consumer = await import(pathToFileURL(consumerPath).href)
    const readBefore = consumer.value()
    writeTarget('v2')
    const edited = await import(pathToFileURL(targetPath).href + '?hmr=2')
    const readNew = edited.read()
    target.hotSwap(edited)
    const readAfter = consumer.value()
    pairOk = readBefore === 'v1' && readNew === 'v2' && readAfter === 'v2'
    pairDetail = 'importer saw ' + readBefore + ' before, ' + readAfter + ' after the swap (new copy reads ' + readNew + ')'
  } catch (e) {
    pairDetail = 'the static-importer pair threw: ' + (e && e.message)
  } finally {
    rmSync(TMP, { recursive: true, force: true })
  }
  check('a static importer calls the EDITED copy after the swap', pairOk, pairDetail)

  // --- non-vacuity: the reload counter does move when it should -----------------
  const doomed = sample.find((u) => {
    if (u === SCENE_SETUP_URL || selfAccepting.includes(u)) return false
    return findBoundaries(reachAll, { url: u, parents: g.ancestors(u) }) === null
  })
  const seg2 = reloaded
  if (doomed) source.onmessage({ data: JSON.stringify({
    kind: 'module', seq: 9000, t: Date.now(), path: doomed.slice(1), url: doomed, v: 9000,
    parents: g.ancestors(doomed), client: true, worker: false, eager: true,
  }) })
  await hmr.settled()
  const control = reloaded - seg2
  check('a module with no acceptor at all still reloads the page', !!doomed && control === 1,
    'control ' + (doomed || 'no such module') + ' produced ' + control + ' reload(s), so "0 reloads" above proves nothing')

  // --- the before arm: the same save, in a runtime that holds no acceptor --------
  // Both arms have to run inside one process, so the before arm is a SECOND instance of the real
  // runtime: it starts with an empty acceptor map, which is exactly the page this row started from,
  // and this is what one save of SceneSetup.js costs there.
  await import(pathToFileURL(RUNTIME).href + '?arm=before')
  const hmrBefore = globalThis.__spointHmr
  const seg3 = { reloads: reloaded, imports: versionedImports }
  if (hmrBefore && source) {
    for (let i = 0; i < 4; i++) {
      source.onmessage({ data: JSON.stringify({
        kind: 'module', seq: 3000 + i, t: Date.now(), path: 'core/SceneSetup.js', url: SCENE_SETUP_URL, v: 3000 + i,
        parents: g.ancestors(SCENE_SETUP_URL), client: true, worker: false, eager: true,
      }) })
    }
    await hmrBefore.settled()
  }
  const beforeArm = { reloads: reloaded - seg3.reloads, imports: versionedImports - seg3.imports }
  check('one save of SceneSetup.js reloaded the page in the arm that has no self-acceptor',
    beforeArm.reloads === 1,
    'the before arm produced ' + beforeArm.reloads + ' reload(s), so the after arm has nothing to beat')

  say('MEASURED hmr-self-accept-rebind: page reload(s) per save for client/core/SceneSetup.js ' +
    beforeArm.reloads + ' -> ' + first.reloads + ' (control module ' + (doomed || 'none') + ' still ' + control + '); versioned module fetch(es) per save ' +
    first.imports + '; export binding(s) moved to the new copy ' + moved + ' of ' + movedFns.length +
    '; reload class of the real graph ' + before.reload + '/' + sample.length + ' -> ' + after.reload + '/' + sample.length)
  say('RESULT: ' + (failures.length === 0 ? 'PASS' : 'FAIL') + ' (' + (checks.length - failures.length) + ' of ' + checks.length + ' claim(s) passed)')
  for (const f of failures) say('[FAIL] ' + f)
  process.exitCode = failures.length === 0 ? 0 : 1
}
