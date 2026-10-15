#!/usr/bin/env node
// hmr-reload-block-witness.mjs -- PERF-hmr-hard-stop-1013.
//
// What one hot reload costs the running frame, measured by running the real
// client/dev/HmrRuntime.js against the real module graph of this repository. gpu-free: it never
// opens a browser and never touches an adapter.
//
// The instrument is a COUNT, not a millisecond delta, because this box is contended: how many
// versioned module fetches, how many subsystem rebuilds and how many page reloads ONE SAVE
// performs. A save writes N files -- save-all, a branch switch, one agent turn -- and N fs events
// used to be N applies. The millisecond phases come second and are read only inside one process,
// where both arms run.
//
// Both arms run inside ONE process through the runtime's own reproduction switches
// (`__spointHmr.setSliced` / `setCoalesced`), so the neighbours this box is running cannot sit
// between the two numbers. `sliced=false` replays the pre-fix path: every liveness lookup scans
// the whole resource timing buffer, every node in the changed module's ancestor set gets its own
// walk up the parents map, and no unit yields to a macrotask. `coalesced=false` replays a queue
// that applies every event it is handed, including the ones a newer event for the same module has
// already superseded and the ones a page reload already ordered will carry away for free.
//
// Each arm imports its own copy of the runtime, so the arm that orders a page reload cannot
// poison the arm that runs after it.
//
// Silence is not an acceptable failure mode: every import is guarded, the counters are initialised
// before anything can throw, and the verdict is printed from one place at the end. The verdict is
// set with process.exitCode and never process.exit(), because process.exit() drops stdout still
// buffered in a pipe.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TAG = '[hmr-reload-block]'
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
let channelsOpened = 0
let setTimeoutCalls = 0
let versionedImports = 0
let handlerRuns = 0
let reloaded = 0
let resolveAt = 0
let firstHandlerAt = 0
let lastHandlerEndAt = 0
const handlerGaps = []

// --- root-absolute specifier remap -------------------------------------------
// Client modules import their siblings by root-absolute specifier ('/core/Foo.js',
// '/src/terrain/PlanetFrame.js'), which the ESM resolver reads as a path from the drive root.
// The `?hmr=<v>&p=<floor>` query rides along so a versioned re-import is a distinct module
// instance, exactly as it is in the browser.
const CLIENT_PREFIXES = ['/src/', '/node_modules/', '/apps/', '/core/', '/hud/', '/dev/', '/editor/', '/netcode/', '/net/', '/ui/', '/sdk/']
function resolveSpecifierHook(specifier, context, nextResolve) {
  if (!specifier.startsWith('/') || specifier.startsWith('//')) return nextResolve(specifier, context)
  const [path, query = ''] = specifier.split('?')
  let file = null
  if (existsSync(join(CLIENT, path))) file = join(CLIENT, path)
  else if (existsSync(join(REPO, path))) file = join(REPO, path)
  if (file === null) return nextResolve(specifier, context)
  if (query.includes('hmr=')) {
    versionedImports++
    if (resolveAt === 0 && CLIENT_PREFIXES.some((p) => path.startsWith(p))) resolveAt = performance.now()
  }
  return nextResolve(pathToFileURL(file).href + (query ? '?' + query : ''), context)
}
async function installHooks() {
  const mod = await import('node:module')
  if (typeof mod.registerHooks === 'function') { mod.registerHooks({ resolve: resolveSpecifierHook }); return 'registerHooks' }
  if (typeof mod.register === 'function') {
    const shim = join(HERE, 'lib', 'hmr-specifier-loader.mjs')
    mod.register(pathToFileURL(shim).href)
    return 'module.register'
  }
  throw new Error(TAG + ' this node exposes neither registerHooks (>=22.15) nor register (>=20.6)')
}
const hookKind = await installHooks()
say('specifier hook: ' + hookKind)

// --- browser shims, installed before the runtime is imported -----------------
const realPerformance = globalThis.performance
const COLD_LOAD_ENTRIES = 846
const ENTRY_CAP = 20000
let entries = []
const seedEntries = (n) => {
  entries = []
  for (let i = 0; i < n; i++) entries.push({ name: 'http://127.0.0.1:8099/fake/module-' + (i % 900) + '.js' })
}
seedEntries(COLD_LOAD_ENTRIES)

Object.defineProperty(globalThis, 'performance', {
  configurable: true,
  value: {
    timeOrigin: realPerformance.timeOrigin,
    now: () => realPerformance.now(),
    setResourceTimingBufferSize: () => {},
    getEntriesByName: () => [],
    getEntriesByType: (type) => (type === 'resource' ? entries : []),
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
Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'http://127.0.0.1:8099/app.js', reload: () => { reloaded++ } } })
class CustomEventShim {
  constructor(type, init) { this.type = type; this.detail = init && init.detail }
}
Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, value: CustomEventShim })
let lastSource = null
class EventSourceShim {
  constructor(url) { this.url = url; lastSource = this }
}
Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: EventSourceShim })
Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: () => [] } })
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = function (...args) { setTimeoutCalls++; return realSetTimeout.apply(this, args) }
const RealMessageChannel = globalThis.MessageChannel
let countYields = false
globalThis.MessageChannel = class extends RealMessageChannel {
  constructor() { super(); channelsOpened++ }
}
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    dispatchEvent: () => true,
    addEventListener: () => {},
    __app: { client: { playerId: 1 } },
    __spoint: { teleport: async () => ({}) },
  },
})
Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => ({ ok: true }) })

// --- the real module graph ---------------------------------------------------
const GRAPH = join(REPO, 'src', 'sdk', 'DevHmrGraph.js')
const RUNTIME = join(REPO, 'client', 'dev', 'HmrRuntime.js')
const DECIDE = join(REPO, 'client', 'dev', 'hmr-decide.js')
for (const [label, p] of [['DevHmrGraph.js', GRAPH], ['HmrRuntime.js', RUNTIME], ['hmr-decide.js', DECIDE]]) {
  if (!existsSync(p)) check(label + ' exists', false, label + ' missing at ' + p)
}

const FRAME_MS = 16.67
const BURST = 8
const SEEDS = [846, 4000, 10000, 20000]
const WARMUP_RELOADS = 2
const MEASURED_RELOADS = 8
const RELOADS_PER_SEED = WARMUP_RELOADS + MEASURED_RELOADS
const LADDER_APPLIES = SEEDS.length * RELOADS_PER_SEED
// A save writes K files. The unsliced arm never yields, so one save of K writes is one block of about K
// decides long. The session-age axis is capped by the browser's resource buffer (20000 entries, see
// setResourceTimingBufferSize in HmrRuntime.js), so the axis that can keep growing is how many writes one
// save carries: a branch switch writes many files at once. The save ladder doubles K until the unsliced
// block reaches a frame on the running machine, so the claim is measured here, not assumed.
const SAVE_WRITES_CAP = 512
let saveVersion = 1e12 + 700000
const nextSaveVersion = () => (saveVersion += 1000)

if (failures.length) {
  say('RESULT: FAIL (' + failures.length + ' of ' + checks.length + ' claim(s) failed)')
  for (const f of failures) say('[FAIL] ' + f)
  process.exitCode = 1
} else {
  await run()
}

async function run() {
  const { createModuleGraph, readImportMap } = await import(pathToFileURL(GRAPH).href)
  const { createLoadedPaths, loadedByPath, findBoundaries, ancestorsOf, isClass } = await import(pathToFileURL(DECIDE).href)
  check('createLoadedPaths is exported by hmr-decide.js', typeof createLoadedPaths === 'function',
    'hmr-decide.js exported no createLoadedPaths, so the liveness index is not the real one')

  const staticDirs = [
    { prefix: '/src/', dir: join(REPO, 'src') },
    { prefix: '/apps/', dir: join(REPO, 'apps') },
    { prefix: '/node_modules/', dir: join(REPO, 'node_modules') },
    { prefix: '/', dir: CLIENT },
  ]
  const importMap = readImportMap(join(CLIENT, 'index.html'))
  const CLIENT_ROOT = '/app.js'
  const WORKER_ROOT = '/src/sdk/WorkerEntry.js'
  const tBuild = performance.now()
  const g = createModuleGraph({ staticDirs, importMap, roots: [CLIENT_ROOT, WORKER_ROOT] })
  const graphBuildMs = performance.now() - tBuild
  check('the real module graph built', g.size() > 100, 'graph size ' + g.size())

  // --- graph phase: what one edit costs on the server side --------------------
  // DevHmrGraph walks the graph on every file event, so it is the row's second suspect. Walk it
  // over a ladder of session ages: the version set only grows, so if the per-edit cost grew with
  // the number of files edited in the session, this is where it would show.
  const sample = [...g.parents.keys()].filter((u) => !u.startsWith('/node_modules/'))
  let stamp = 1e12
  const graphLadder = []
  let edited = 0
  for (const edits of [1, 32, 128, 320]) {
    let worst = 0
    for (let i = 0; i < edits; i++) {
      const u = sample[(i * 7 + edited) % sample.length]
      const t = performance.now()
      g.markChanged(u, stamp++)
      worst = Math.max(worst, performance.now() - t)
      edited++
    }
    graphLadder.push({ edits: edited, worstMs: +worst.toFixed(2) })
  }
  const graphWorstMs = Math.max(...graphLadder.map((r) => r.worstMs))
  say('PHASE graph: worst markChanged+propagate over a session of ' +
    graphLadder.map((r) => r.edits + ' edit(s) -> ' + r.worstMs + ' ms').join(', ') +
    ' (graph build ' + graphBuildMs.toFixed(0) + ' ms once, ' + g.size() + ' module(s))')
  check('the graph phase does not grow with the edits in the session', graphWorstMs < FRAME_MS,
    'markChanged cost ' + graphWorstMs.toFixed(2) + ' ms after ' + edited + ' edit(s), so DevHmrGraph is the block')

  // --- what one save decides, over every real module ---------------------------
  const appSrc = readFileSync(join(CLIENT, 'app.js'), 'utf8')
  const accepted = new Set()
  for (const m of appSrc.matchAll(/\.accept\(\s*'([^']+)'/g)) accepted.add(m[1])
  for (const m of appSrc.matchAll(/\.subsystem\(\s*'([^']+)'/g)) accepted.add(m[1])
  const reach = new Map()
  for (const u of accepted) if (g.reaches(CLIENT_ROOT, u)) reach.set(u, [{ fn: () => {}, self: false }])
  let reloadPath = 0
  let acceptedPath = 0
  let worstBoundaries = 0
  for (const u of sample) {
    const b = findBoundaries(reach, { url: u, parents: g.ancestors(u) })
    if (!b) { reloadPath++; continue }
    acceptedPath++
    worstBoundaries = Math.max(worstBoundaries, b.length)
  }
  say('DECIDE over the real graph: ' + sample.length + ' module(s), ' + accepted.size + ' accept boundary(ies); ' +
    acceptedPath + ' apply in place (up to ' + worstBoundaries + ' subsystem rebuild(s)), ' +
    reloadPath + ' take the full page reload')
  check('the reload share of the real module set is measured', reloadPath + acceptedPath === sample.length,
    reloadPath + ' + ' + acceptedPath + ' != ' + sample.length)
  check('most real modules do land on the full page reload', reloadPath > acceptedPath,
    'reload=' + reloadPath + ' accepted=' + acceptedPath + ': the witness premise does not hold')

  // --- a real boundary and a real module under it ------------------------------
  // The pair has to be one findBoundaries ACTUALLY resolves to that boundary: the previous draft
  // of this witness picked a module whose walk reaches a root, so every event took the reload
  // path, no handler ever ran and every handler claim passed on zero work.
  let boundary = null
  let changed = null
  let changedAncestors = 0
  for (const b of [...reach.keys()].slice(0, 16)) {
    try { await import(pathToFileURL(join(CLIENT, b.slice(1))).href) } catch (_) { continue }
    const probe = new Map([[b, [{ fn: () => {}, self: false }]]])
    for (const d of g.depsOf(b)) {
      if (d.startsWith('/node_modules/') || accepted.has(d) || !g.reaches(b, d)) continue
      const parents = g.ancestors(d)
      const bs = findBoundaries(probe, { url: d, parents })
      const n = Object.keys(ancestorsOf(parents, d)).length
      if (bs && bs.length === 1 && bs[0] === b && n > changedAncestors) { changedAncestors = n; boundary = b; changed = d }
    }
  }
  check('a real accept boundary imports under node', boundary !== null, 'no accepted module in the graph imports under node')
  check('a real module under that boundary resolves to it', changed !== null, 'no dependency of any boundary resolves to that boundary alone')
  check('the edited module has an ancestor set worth walking', changedAncestors >= 2,
    'the edited module has ' + changedAncestors + ' ancestor(s)')
  if (!boundary || !changed) return
  say('boundary: ' + boundary + '  changed: ' + changed + '  ancestors: ' + changedAncestors)

  // --- modules no boundary covers: the full page reload path -------------------
  // A module that exports a class is class-patched in place instead of reloading, so it would not
  // exercise the reload path: require one whose exports carry no class, which is what sends it to
  // findBoundaries and then to the full page reload.
  const doomedProbe = new Map([[boundary, [{ fn: () => {}, self: false }]]])
  const doomed = []
  for (const u of sample) {
    if (doomed.length >= BURST) break
    if (u === changed || u === boundary) continue
    if (findBoundaries(doomedProbe, { url: u, parents: g.ancestors(u) })) continue
    let mod = null
    try { mod = await import(pathToFileURL(join(CLIENT, u.slice(1))).href) } catch (_) { continue }
    if (mod && Object.keys(mod).some((k) => isClass(mod[k]))) continue
    doomed.push(u)
  }
  check('the reload path is exercised by real modules', doomed.length === BURST,
    'only ' + doomed.length + ' module(s) of ' + sample.length + ' resolve to no boundary AND import under node')

  // --- one runtime instance per arm --------------------------------------------
  const openRuntime = async (arm) => {
    lastSource = null
    await import(pathToFileURL(RUNTIME).href + '?arm=' + arm)
    const hmr = globalThis.__spointHmr
    const source = lastSource
    if (!hmr || !source) return null
    const dataRef = hmr.data(boundary)
    dataRef.sentinel = 'kept-across-reloads'
    const timeHandler = (fn) => async (mod, d) => {
      const t = performance.now()
      if (firstHandlerAt === 0) firstHandlerAt = t
      if (lastHandlerEndAt !== 0) handlerGaps.push(t - lastHandlerEndAt)
      const out = await fn(mod, d)
      lastHandlerEndAt = performance.now()
      handlerRuns++
      return out
    }
    hmr.accept(boundary, timeHandler((m) => { dataRef.first = (dataRef.first || 0) + 1; return typeof m === 'object' }))
    hmr.accept(boundary, timeHandler((m) => { dataRef.second = (dataRef.second || 0) + 1; return typeof m === 'object' }))
    return { hmr, source, dataRef }
  }

  const eventFor = (url, v, extra = {}) => ({
    kind: 'module', seq: v, t: Date.now(), path: url.slice(1), url, v,
    parents: g.ancestors(url), client: true, worker: false, eager: true, ...extra,
  })
  const fire = (source, ev) => source.onmessage({ data: JSON.stringify(ev) })
  const snapshot = () => ({ imports: versionedImports, handlers: handlerRuns, reloads: reloaded, yields: channelsOpened, timeouts: setTimeoutCalls })
  const delta = (a, b) => ({ imports: b.imports - a.imports, handlers: b.handlers - a.handlers, reloads: b.reloads - a.reloads, yields: b.yields - a.yields, timeouts: b.timeouts - a.timeouts })

  const arm = async (name, sliced, coalesced, saveWrites = null) => {
    const opened = await openRuntime(name)
    if (!opened) { check(name + ': the runtime connected an event source', false, 'no EventSource was constructed'); return null }
    const { hmr, source, dataRef } = opened
    check(name + ': HmrRuntime.js exposes both reproduction switches',
      typeof hmr.setSliced === 'function' && typeof hmr.setCoalesced === 'function',
      '__spointHmr is missing setSliced/setCoalesced, so the before arm cannot be replayed')
    hmr.setSliced(sliced)
    hmr.setCoalesced(coalesced)

    // --- ladder: one update at a time, over a ladder of session ages -----------
    // The resource timing buffer only grows: a page starts at the cold-load count measured on this
    // project this session (846 resources) and every reload adds the modules it re-imported, up to
    // the 20000 cap HmrRuntime.js sets. The age of the session is the input the liveness lookup
    // scales with, so the ladder is what tells a real win from a lucky single count.
    const rows = []
    let ladderGaps = []
    const seg0 = snapshot()
    for (const seed of SEEDS) {
      seedEntries(seed)
      const idx = createLoadedPaths('http://127.0.0.1:8099/app.js')
      let decide = 0
      let swap = 0
      let handler = 0
      for (let i = 0; i < RELOADS_PER_SEED; i++) {
        const until = Math.min(ENTRY_CAP, seed + i * 60)
        while (entries.length < until) entries.push({ name: 'http://127.0.0.1:8099/fake/extra-' + entries.length + '.js' })
        resolveAt = 0
        firstHandlerAt = 0
        lastHandlerEndAt = 0
        handlerGaps.length = 0
        const t0 = performance.now()
        fire(source, eventFor(changed, stamp + 100000 + i * 1000))
        await hmr.settled()
        if (i < WARMUP_RELOADS) continue
        decide = Math.max(decide, resolveAt ? resolveAt - t0 : -1)
        swap = Math.max(swap, firstHandlerAt ? firstHandlerAt - resolveAt : -1)
        handler = Math.max(handler, lastHandlerEndAt - firstHandlerAt)
        if (i === RELOADS_PER_SEED - 1) ladderGaps = handlerGaps.slice()
      }
      const names = entries.map((e) => e.name)
      let scanMs = 0
      for (let i = 0; i < 20; i++) {
        const t = performance.now()
        loadedByPath(names, '/src/terrain/Never-Fetched.js', 'http://127.0.0.1:8099/app.js')
        scanMs = Math.max(scanMs, performance.now() - t)
      }
      // The index is built once from the buffer the page already holds and appended to after that,
      // so the number a lookup costs is the number AFTER the build, never the build itself.
      idx.absorb(entries)
      let lookupMs = 0
      for (let i = 0; i < 20; i++) {
        const t = performance.now()
        idx.absorb(entries)
        idx.has('/src/terrain/Never-Fetched.js')
        lookupMs = Math.max(lookupMs, performance.now() - t)
      }
      rows.push({ seed, entries: entries.length, decide, swap, handler, scanMs, lookupMs })
    }
    const ladder = delta(seg0, snapshot())
    const worst = rows.reduce((a, r) => (Math.max(r.decide, r.swap, r.handler) > Math.max(a.decide, a.swap, a.handler) ? r : a), rows[0])

    // --- burst: one save that writes the same module BURST times ----------------
    handlerGaps.length = 0
    const seg1 = snapshot()
    const appliesBeforeBurst = dataRef.first || 0
    for (let i = 0; i < BURST; i++) fire(source, eventFor(changed, stamp + 300000 + i * 1000))
    await hmr.settled()
    const burst = delta(seg1, snapshot())
    burst.applies = (dataRef.first || 0) - appliesBeforeBurst

    // The save ladder runs BEFORE the doomed burst: a page reload already ordered makes the coalesced arm
    // ignore every later update (HmrRuntime enqueue), so a save measured after a reload measures nothing.
    // --- one save of K writes to ONE module, in one turn -----------------------
    // The before arm searches K upward until its block reaches a frame; the after arm replays the same K.
    const saveRungs = []
    let k = saveWrites || BURST
    for (;;) {
      const seg = snapshot()
      const t0 = performance.now()
      for (let i = 0; i < k; i++) fire(source, eventFor(changed, nextSaveVersion()))
      await hmr.settled()
      saveRungs.push({ writes: k, ms: performance.now() - t0, yields: snapshot().yields - seg.yields })
      if (saveWrites !== null || saveRungs[saveRungs.length - 1].ms > FRAME_MS || k >= SAVE_WRITES_CAP) break
      k *= 2
    }

    // --- burst: one save that writes BURST modules no boundary covers -----------
    const seg2 = snapshot()
    for (let i = 0; i < doomed.length; i++) fire(source, eventFor(doomed[i], stamp + 500000 + i * 1000))
    await hmr.settled()
    const doomedBurst = delta(seg2, snapshot())

    return { name, rows, worst, ladder, burst, doomedBurst, dataRef, hmr, ladderGaps, saveRungs }
  }

  const before = await arm('before', false, false)
  const finalSave = before.saveRungs[before.saveRungs.length - 1]
  const after = await arm('after', true, true, finalSave.writes)
  const saveWritesRun = before.saveRungs.reduce((n, r) => n + r.writes, 0)
  if (!before || !after) return

  for (let i = 0; i < before.rows.length; i++) {
    const b = before.rows[i]
    const a = after.rows[i]
    say('LADDER entries=' + String(b.entries).padStart(5) + '  decide ' + b.decide.toFixed(2).padStart(7) + ' -> ' + a.decide.toFixed(2).padStart(6) +
      ' ms | swap ' + b.swap.toFixed(2).padStart(6) + ' -> ' + a.swap.toFixed(2).padStart(6) +
      ' ms | handler ' + b.handler.toFixed(2).padStart(5) + ' -> ' + a.handler.toFixed(2).padStart(5) +
      ' ms | liveness lookup ' + b.scanMs.toFixed(2).padStart(6) + ' -> ' + a.lookupMs.toFixed(3) + ' ms/lookup')
  }
  const longest = (r) => Math.max(r.decide, r.swap, r.handler)
  say('PHASE before  graph ' + graphWorstMs.toFixed(2) + ' ms | decide ' + before.worst.decide.toFixed(2) + ' ms | swap ' +
    before.worst.swap.toFixed(2) + ' ms | handler ' + before.worst.handler.toFixed(2) + ' ms')
  say('PHASE after   graph ' + graphWorstMs.toFixed(2) + ' ms | decide ' + after.worst.decide.toFixed(2) + ' ms | swap ' +
    after.worst.swap.toFixed(2) + ' ms | handler ' + after.worst.handler.toFixed(2) + ' ms')

  say('COUNT one save, ' + BURST + ' write(s) to ONE module: module fetch(es) ' + before.burst.imports + ' -> ' + after.burst.imports +
    ', subsystem rebuild(s) ' + before.burst.handlers + ' -> ' + after.burst.handlers +
    ', apply(ies) ' + before.burst.applies + ' -> ' + after.burst.applies)
  say('COUNT one save, ' + BURST + ' module(s) with no accept boundary: module fetch(es) ' + before.doomedBurst.imports + ' -> ' + after.doomedBurst.imports +
    ', page reload(s) ' + before.doomedBurst.reloads + ' -> ' + after.doomedBurst.reloads)
  for (const r of before.saveRungs) say('SAVE rung: one save of ' + r.writes + ' write(s) to one module, unsliced ' + r.ms.toFixed(2) + ' ms in one turn (' + r.yields + ' yield(s))')
  say('SAVE after: the same ' + finalSave.writes + ' write(s), sliced ' + after.saveRungs[0].ms.toFixed(2) + ' ms (' + after.saveRungs[0].yields + ' yield(s))')
  say('MEASURED hmr-reload-block: longest synchronous block ' + longest(before.worst).toFixed(2) + ' ms -> ' + longest(after.worst).toFixed(2) +
    ' ms (frame budget ' + FRAME_MS + ' ms); one save of ' + finalSave.writes + ' writes ' + finalSave.ms.toFixed(2) + ' ms -> ' + after.saveRungs[0].ms.toFixed(2) +
    ' ms; macrotask yield(s) per update ' + (before.ladder.yields / LADDER_APPLIES).toFixed(2) + ' -> ' + (after.ladder.yields / LADDER_APPLIES).toFixed(2))

  // --- claims -----------------------------------------------------------------
  check('the before arm produced a measurement', before.worst.decide > 0 && before.worst.swap > 0,
    'the unsliced arm measured decide=' + before.worst.decide.toFixed(2) + ' swap=' + before.worst.swap.toFixed(2))
  check('the unsliced arm blocks for more than a frame in one save on this machine', finalSave.ms > FRAME_MS,
    'one unsliced save of ' + finalSave.writes + ' write(s) took ' + finalSave.ms.toFixed(2) + ' ms, under the ' + FRAME_MS + ' ms frame budget at the ' + SAVE_WRITES_CAP + '-write cap, so the fix proves nothing')
  check('the before arm took no macrotask yield', before.ladder.yields === 0,
    'the unsliced arm yielded ' + before.ladder.yields + ' time(s), so it is not the pre-fix path')
  check('the after arm yields at least twice per update',
    after.ladder.yields >= 2 * LADDER_APPLIES,
    'the sliced arm yielded ' + (after.ladder.yields / LADDER_APPLIES).toFixed(2) + ' time(s) per update, so the swap and the handler chain are still one block')
  check('MessageChannel carried the yield and no setTimeout did',
    after.ladder.yields > 0 && before.ladder.timeouts === 0 && after.ladder.timeouts === 0,
    'delivery: messageChannel=' + after.ladder.yields + ' setTimeout before=' + before.ladder.timeouts + ' after=' + after.ladder.timeouts)
  check('the liveness lookup stopped scaling with the resource buffer', after.worst.lookupMs * 4 <= before.worst.scanMs,
    'indexed ' + after.worst.lookupMs.toFixed(3) + ' ms vs loadedByPath ' + before.worst.scanMs.toFixed(2) + ' ms over ' + before.worst.entries + ' entr(ies)')
  check('the decide phase fits inside one frame after the fix', after.worst.decide <= FRAME_MS,
    'decide ' + after.worst.decide.toFixed(2) + ' ms, frame budget ' + FRAME_MS + ' ms')
  check('one save of the same writes is at least 4x shorter sliced than unsliced', after.saveRungs[0].ms * 4 <= finalSave.ms,
    'save of ' + finalSave.writes + ' writes: ' + finalSave.ms.toFixed(2) + ' ms -> ' + after.saveRungs[0].ms.toFixed(2) + ' ms')
  // The ladder is a ladder of session AGES, and the unsliced arm only clears a frame at the older
  // ones: at the youngest age the whole pre-fix update costs about 4 ms on this box, so demanding
  // the sliced arm halve THAT is demanding it beat the box's noise floor -- one macrotask turn
  // costs 1-4 ms here and the sliced arm pays one by construction. What the fix owes at EVERY age
  // is that no single block reaches a frame; where the unsliced arm blocked for more than half a
  // frame there is signal above the noise, and there the win has to be at least 4x.
  const ladderMisses = after.rows
    .map((r, i) => [r.entries, longest(r), longest(before.rows[i])])
    .filter(([, afterMs, beforeMs]) => afterMs > FRAME_MS || (beforeMs > FRAME_MS / 2 && afterMs * 4 > beforeMs))
  check('the win holds at every session age on the ladder', ladderMisses.length === 0,
    'session age(s) where the sliced arm neither fit one frame nor cut a real block by 4x: ' +
    JSON.stringify(ladderMisses.map(([e, a, b]) => [e, a.toFixed(2), b.toFixed(2)])))
  const gaps = [...before.ladderGaps, ...after.ladderGaps]
  check('the handler chain of one boundary stays one block', gaps.length > 0 && gaps.every((gapMs) => gapMs < FRAME_MS),
    gaps.length + ' gap(s), worst ' + Math.max(-1, ...gaps).toFixed(2) + ' ms between two handlers of one boundary, so update() can run against a half-replaced subsystem')

  // --- the counts that are the point of the row --------------------------------
  check('a save that writes one module ' + BURST + ' times fetches it once, not ' + BURST + ' times',
    before.burst.imports === 2 * BURST && after.burst.imports === 2,
    'module fetch(es) per save: ' + before.burst.imports + ' -> ' + after.burst.imports + ' (want ' + 2 * BURST + ' -> 2)')
  check('a save that writes one module ' + BURST + ' times rebuilds its subsystem once, not ' + BURST + ' times',
    before.burst.handlers === 2 * BURST && after.burst.handlers === 2,
    'subsystem rebuild(s) per save: ' + before.burst.handlers + ' -> ' + after.burst.handlers + ' (want ' + 2 * BURST + ' -> 2)')
  check('the coalesced burst still applied the change', after.burst.applies === 1 && before.burst.applies === BURST,
    'apply(ies): ' + before.burst.applies + ' -> ' + after.burst.applies + ', so the newest version did not land')
  check('a save that writes ' + BURST + ' modules with no accept boundary reloads the page once, not ' + BURST + ' times',
    before.doomedBurst.reloads === BURST && after.doomedBurst.reloads === 1,
    'page reload(s) per save: ' + before.doomedBurst.reloads + ' -> ' + after.doomedBurst.reloads + ' (want ' + BURST + ' -> 1)')
  check('the updates after the first reload do no work at all',
    before.doomedBurst.imports >= BURST && after.doomedBurst.imports === 1,
    'module fetch(es) per save: ' + before.doomedBurst.imports + ' -> ' + after.doomedBurst.imports + ', so a doomed update still fetches and evaluates')

  // --- correctness: HMR still replaces the module and keeps the state it keeps --
  for (const a of [before, after]) {
    check(a.name + ': the state the boundary preserves survived', a.dataRef.sentinel === 'kept-across-reloads',
      'hmr.data() no longer returns the state it was seeded with')
    check(a.name + ': both acceptor handlers of an apply ran, every time',
      a.dataRef.first === a.dataRef.second && a.dataRef.first > 0,
      'first=' + a.dataRef.first + ' second=' + a.dataRef.second)
  }
  check('every update the queue was handed, it applied',
    after.dataRef.first === LADDER_APPLIES + 2 && before.dataRef.first === LADDER_APPLIES + BURST + saveWritesRun,
    'apply count after=' + after.dataRef.first + ' before=' + before.dataRef.first +
    ' (want ' + (LADDER_APPLIES + 2) + ' and ' + (LADDER_APPLIES + BURST + saveWritesRun) + ')')

  const runtimeSrc = readFileSync(RUNTIME, 'utf8')
  check('HmrRuntime.js yields through macrotaskYield, not requestAnimationFrame',
    /macrotaskYield\(/.test(runtimeSrc) && !/requestAnimationFrame/.test(runtimeSrc),
    'requestAnimationFrame is throttled or stopped in a hidden tab and must not gate a reload')
  check('the chain walk no longer walks up once per node',
    (runtimeSrc.match(/ancestorsOf\(ev\.parents, node\)/g) || []).length === 1,
    'one ancestor walk per node is nodes squared; the parents map is walked down from the boundary once instead')
}

say('RESULT: ' + (failures.length === 0 ? 'PASS' : 'FAIL') + ' (' + (checks.length - failures.length) + ' of ' + checks.length + ' claim(s) passed)')
for (const f of failures) say('[FAIL] ' + f)
process.exitCode = failures.length === 0 ? 0 : 1
