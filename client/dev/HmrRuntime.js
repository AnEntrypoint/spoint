import { ancestorsOf, createLoadedPaths, findBoundaries, isClass, loadedByPath, nothingLive, sameValue } from './hmr-decide.js'
import { macrotaskYield } from '../core/macrotaskYield.js'

const EVENTS_URL = '/__hmr/events'
const POSE_KEY = '__spointHmrPose'
const ONLY_KEY = '__spointHmrOnly'
const LOG_CAP = 200
const LOG_KEY = '__spointHmrLog'
const PERSISTED_LOG_CAP = 50
const SERVER_WAIT_MS = 60000
const SERVER_POLL_MS = 250
const TICK_HANDLER_PATHS = new Set(['src/sdk/TickHandler.js', 'src/shared/movement.js'])

const acceptors = new Map()
const disposers = new Map()
const store = new Map()
const instances = new Map()
const log = (() => { try { return JSON.parse(sessionStorage.getItem(LOG_KEY) || '[]') } catch (_) { return [] } })()
let queue = Promise.resolve()
let lastBootId = null
let liveBootId = null
let toastModule = null
// The reproduction switch scripts/hmr-reload-block-witness.mjs A/Bs: false replays the pre-fix
// path (scan every resource timing entry, one ancestor walk per node, no macrotask yield).
let sliced = true
// One save is N fs events whenever it writes N files -- a save-all, a branch switch, or one agent
// turn -- and N events used to be N applies: N module fetches, N subsystem rebuilds and, for the
// modules with no accept boundary above them (92% of the real graph), N whole page reloads back to
// back. Two updates that cannot both change the outcome must not both do the work, so the queue
// keeps only the NEWEST event per module and drops the ones it supersedes, and once a page reload
// is ordered every later update already lands with it and does nothing.
let coalesced = true
const pendingUpdates = new Map()
let draining = false
let reloadOrdered = false

const keyOf = (url) => new URL(url, location.href).pathname
const isSingleplayer = () => !!window.__app?.client?._worker
const listOf = (map, key) => { if (!map.has(key)) map.set(key, []); return map.get(key) }

function accept(url, fn) { listOf(acceptors, keyOf(url)).push({ fn, self: false }) }
// ONE self-accept handler per module for the life of the page, and the first registration wins.
// A self-accept handler re-assigns the export bindings of the module instance this page already
// imported, because that is the instance every static importer's live binding reads. A copy
// imported later would re-bind ITS OWN bindings, which nobody reads, so the registration from the
// boot copy is the only one that can take effect and it is never replaced.
function acceptSelf(url, fn) {
  const list = listOf(acceptors, keyOf(url))
  if (list.some(h => h.self)) return
  list.push({ fn, self: true })
}
const assetHandlers = []
function acceptAsset(fn) { assetHandlers.push(fn) }
function dispose(url, fn) { listOf(disposers, keyOf(url)).push(fn) }

// A subsystem is one object the app holds that its module's factory can rebuild
// from scratch. `rebuild` is the function the app calls to build it in the first
// place, so registering it here means a swap runs exactly what a cold boot ran
// and the two cannot drift apart. The returned function is the same one, so the
// construction site and the accept handler are literally one call.
function subsystem(url, rebuild) {
  listOf(acceptors, keyOf(url)).push({ fn: rebuild, self: false })
  return rebuild
}
function data(url) { const k = keyOf(url); if (!store.has(k)) store.set(k, {}); return store.get(k) }

async function toast(message, kind) {
  try {
    toastModule ||= await import('/editor/EditPanelDOM.js')
    toastModule.showToast('HMR: ' + message, kind, kind === 'error' ? 6000 : 1800)
  } catch (_) { console.log('[hmr]', message) }
}

function record(ev, result, detail = '') {
  const entry = { seq: ev.seq, kind: ev.kind, path: ev.path, result, detail, serverStamp: ev.t, appliedAt: Date.now(), ms: ev.t ? Date.now() - ev.t : null }
  log.push(entry)
  if (log.length > LOG_CAP) log.shift()
  try { sessionStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-PERSISTED_LOG_CAP))) } catch (_) {}
  console.log(`[hmr] ${ev.path} -> ${result}${detail ? ' (' + detail + ')' : ''}${entry.ms != null ? ' in ' + entry.ms + 'ms' : ''}`)
  window.dispatchEvent(new CustomEvent('spoint-hmr', { detail: entry }))
  const kind = result === 'reload' || result === 'server-restart-needed' ? 'warn' : result === 'failed' ? 'error' : 'success'
  if (result !== 'ignored') toast(`${ev.path.split('/').pop()} ${result}${detail ? ': ' + detail : ''}`, kind)
  return entry
}

function savePose() {
  try {
    const where = window.__spoint?.where?.()
    const p = where?.position || where
    if (Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)) sessionStorage.setItem(POSE_KEY, JSON.stringify({ x: p[0], y: p[1], z: p[2], at: Date.now() }))
    const cam = window.__app?.cam?.save?.()
    if (cam) sessionStorage.setItem('cam', JSON.stringify(cam))
  } catch (_) {}
}

async function restorePose() {
  let pose = null
  try { pose = JSON.parse(sessionStorage.getItem(POSE_KEY) || 'null'); sessionStorage.removeItem(POSE_KEY) } catch (_) {}
  if (!pose || Date.now() - pose.at > 120000) return
  for (let i = 0; i < 600 && !(window.__spoint?.teleport && window.__app?.client?.playerId != null); i++) await new Promise(r => setTimeout(r, 100))
  try { await window.__spoint?.teleport?.({ x: pose.x, y: pose.y, z: pose.z }, { clearance: 0 }) } catch (e) { console.warn('[hmr] pose restore failed:', e?.message || e) }
}

async function waitForServer(staleBootId) {
  const until = Date.now() + SERVER_WAIT_MS
  while (Date.now() < until) {
    const restarted = !staleBootId || (liveBootId && liveBootId !== staleBootId)
    const r = restarted ? await fetch('/__identity', { cache: 'no-store' }).catch(() => null) : null
    if (r?.ok) return true
    await new Promise(res => setTimeout(res, SERVER_POLL_MS))
  }
  return false
}

async function reloadPreserving(ev, reason) {
  // Set before the first await, not after it: the reload is ordered HERE, and every update that
  // arrives while waitForServer runs is already going to land with it.
  reloadOrdered = true
  record(ev, 'reload', reason)
  savePose()
  await waitForServer(ev.restarting ? ev.bootId : null)
  location.reload()
}

const PAGE_FLOOR = Math.floor(performance.timeOrigin)
function versionedUrl(key, v) { return `${key}?hmr=${v}&p=${PAGE_FLOOR}` }

function trackChain(ev, boundary) {
  const reached = Object.keys(ancestorsOf(ev.parents, ev.url))
  if (!sliced) {
    for (const node of reached) {
      if (node === boundary || boundary in ancestorsOf(ev.parents, node)) listOf(instances, node).push(versionedUrl(node, ev.v))
    }
    return
  }
  // `boundary in ancestorsOf(parents, node)` is one walk up per node, so the whole chain cost
  // nodes squared. Walk the parents map down from the boundary once instead: a node is under the
  // boundary exactly when the boundary is one of its ancestors.
  const children = new Map()
  for (const [node, parents] of Object.entries(ev.parents)) {
    for (const p of parents) { const list = children.get(p); if (list) list.push(node); else children.set(p, [node]) }
  }
  const under = new Set([boundary])
  const stack = [boundary]
  while (stack.length) {
    const u = stack.pop()
    for (const c of children.get(u) || []) if (!under.has(c)) { under.add(c); stack.push(c) }
  }
  for (const node of reached) if (under.has(node)) listOf(instances, node).push(versionedUrl(node, ev.v))
}

function patchClass(oldCls, newCls) {
  for (const key of Object.getOwnPropertyNames(oldCls.prototype)) {
    if (key === 'constructor' || Object.prototype.hasOwnProperty.call(newCls.prototype, key)) continue
    if (Object.getOwnPropertyDescriptor(oldCls.prototype, key).configurable) delete oldCls.prototype[key]
  }
  for (const key of Object.getOwnPropertyNames(newCls.prototype)) {
    if (key === 'constructor') continue
    const d = Object.getOwnPropertyDescriptor(newCls.prototype, key)
    const o = Object.getOwnPropertyDescriptor(oldCls.prototype, key)
    if (!o || o.configurable) Object.defineProperty(oldCls.prototype, key, d)
  }
  for (const key of Object.getOwnPropertyNames(newCls)) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue
    const o = Object.getOwnPropertyDescriptor(oldCls, key)
    if (!o || o.configurable) Object.defineProperty(oldCls, key, Object.getOwnPropertyDescriptor(newCls, key))
  }
}

const loaded = createLoadedPaths(location.href)

function wasLoaded(url) {
  if (sliced) { loaded.absorb(performance.getEntriesByType('resource')); return loaded.has(url) }
  if (performance.getEntriesByName(new URL(url, location.href).href).length > 0) return true
  return loadedByPath(performance.getEntriesByType('resource').map(e => e.name), url, location.href)
}

async function tryClassPatch(ev) {
  const olds = [...(ev.eager || wasLoaded(ev.url) ? [ev.url] : []), ...(instances.get(ev.url) || [])]
  if (!olds.length) return false
  const newMod = await import(versionedUrl(ev.url, ev.v))
  const names = Object.keys(newMod)
  const classes = names.filter(n => isClass(newMod[n]))
  if (!classes.length) return false
  const oldMods = await Promise.all(olds.map(u => import(u)))
  for (const oldMod of oldMods) for (const n of names) {
    if (classes.includes(n)) { if (!isClass(oldMod[n])) return false; continue }
    if (!sameValue(oldMod[n], newMod[n])) return false
  }
  for (const oldMod of oldMods) for (const n of classes) patchClass(oldMod[n], newMod[n])
  if (ev.worker) listOf(instances, ev.url).push(versionedUrl(ev.url, ev.v))
  else fetch(`/__hmr/patched?url=${encodeURIComponent(ev.url)}&v=${ev.v}`, { method: 'POST' }).catch(() => {})
  return classes
}

async function applyBoundary(ev, boundary) {
  for (const fn of disposers.get(boundary) || []) await fn(data(boundary))
  disposers.delete(boundary)
  const handlers = (acceptors.get(boundary) || []).filter(h => !h.self || boundary === ev.url)
  if (sliced) await macrotaskYield()
  const newMod = await import(versionedUrl(boundary, ev.v))
  trackChain(ev, boundary)
  // The handlers of one boundary stay in one block on purpose: a frame rendered between them
  // would run update() against a subsystem half of the way through being replaced.
  if (sliced) await macrotaskYield()
  for (const h of handlers) await h.fn(newMod, data(boundary))
}

async function applyWorkerSide(ev) {
  const client = window.__app?.client
  if (!TICK_HANDLER_PATHS.has(ev.path) || !client?.hotReloadTickHandler) return null
  return (await client.hotReloadTickHandler(ev.v, PAGE_FLOOR)) ? 'worker tick handler swapped' : null
}

async function applyModule(ev) {
  if (ev.bundle) return reloadPreserving(ev, 'prebuilt bundle is stale; server switched to live ESM')
  const parts = []
  if (ev.worker && isSingleplayer()) {
    const done = await applyWorkerSide(ev)
    if (!done && !ev.client) return reloadPreserving(ev, 'singleplayer worker module has no hot path')
    if (done) parts.push(done)
  }
  if (ev.worker && !isSingleplayer() && !ev.client) return record(ev, ev.serverHot ? 'server-hot-swapped' : 'server-restart-needed')
  if (ev.serverStale && !isSingleplayer()) parts.push(ev.restarting ? 'multiplayer server restarting with it' : 'multiplayer server still runs the old copy until restart')
  if (!ev.client) return parts.length ? record(ev, 'worker-swapped', parts.join('; ')) : record(ev, 'noop', 'not in client graph')
  if (!acceptors.get(ev.url)?.length && nothingLive({ worker: ev.worker, eager: ev.eager, loaded: wasLoaded(ev.url), tracked: (instances.get(ev.url) || []).length })) {
    return record(ev, 'noop', 'no acceptor and nothing on this page loaded it, so the next import reads the new copy')
  }
  if (!acceptors.get(ev.url)?.length) {
    if (sliced) await macrotaskYield()
    const patched = await tryClassPatch(ev).catch(e => { console.warn('[hmr] class patch failed:', e); return false })
    if (patched) { parts.push('patched ' + patched.join(',')); return record(ev, 'patched', parts.join('; ')) }
  }
  const boundaries = findBoundaries(acceptors, ev)
  if (!boundaries) return reloadPreserving(ev, 'no accept boundary up to the app root')
  for (const b of boundaries) {
    if (sliced) await macrotaskYield()
    await applyBoundary(ev, b)
  }
  parts.push('accepted at ' + boundaries.join(','))
  return record(ev, 'accepted', parts.join('; '))
}

function applyCss(ev) {
  let swapped = 0
  const targets = new Set(ev.urls)
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const href = link.getAttribute('href') || ''
    const path = keyOf(href.split('?')[0])
    if (!targets.has(path)) continue
    const next = link.cloneNode()
    next.href = `${path}?hmr=${ev.t}`
    next.onload = () => link.remove()
    next.onerror = () => next.remove()
    link.after(next)
    swapped++
  }
  return swapped ? record(ev, 'css-swapped', `${swapped} link(s)`) : record(ev, 'noop', 'stylesheet not linked on this page')
}

async function applyApp(ev) {
  if (!ev.apps.length) return record(ev, 'noop', 'no app imports this file')
  if (!isSingleplayer()) return record(ev, 'app-reloaded', `server hot-reloads ${ev.apps.join(',')}`)
  const client = window.__app.client
  if (!client.hotReloadApp) return reloadPreserving(ev, 'BrowserServer has no hotReloadApp')
  const running = new Set(window.__app.engine?.entityAppMap?.values?.() || [])
  const apps = ev.apps.filter(n => running.has(n))
  if (!apps.length) return record(ev, 'noop', `no running entity uses ${ev.apps.join(',')}`)
  const results = await Promise.all(apps.map(n => client.hotReloadApp(n)))
  const failed = apps.filter((_, i) => !results[i])
  if (failed.length) return record(ev, 'failed', 'worker rejected ' + failed.join(','))
  return record(ev, 'app-reloaded', 'worker ' + apps.join(','))
}

async function applyAsset(ev) {
  await Promise.all(ev.urls.map(u => fetch(u, { cache: 'reload' }).catch(() => null)))
  const handled = []
  for (const u of ev.urls) {
    for (const h of acceptors.get(u) || []) { await h.fn(u, ev); handled.push(u) }
    for (const h of assetHandlers) if (await h(u, ev)) handled.push(u)
  }
  if (handled.length) return record(ev, 'asset-swapped', handled.join(','))
  return reloadPreserving(ev, 'asset re-fetched into the HTTP cache; no in-place consumer registered for it')
}

function readOnlyFilter() {
  try { const s = sessionStorage.getItem(ONLY_KEY); return s ? new RegExp(s) : null } catch (_) { return null }
}

function only(pattern) {
  try { if (pattern) sessionStorage.setItem(ONLY_KEY, pattern instanceof RegExp ? pattern.source : String(pattern)); else sessionStorage.removeItem(ONLY_KEY) } catch (_) {}
  return readOnlyFilter()
}

async function apply(ev) {
  if (ev.kind === 'hello') {
    const restarted = lastBootId && lastBootId !== ev.bootId
    lastBootId = ev.bootId
    if (!restarted) return
    const restartEv = { ...ev, path: 'server', t: Date.now() }
    if (!isSingleplayer()) return reloadPreserving(restartEv, 'multiplayer server restarted; rejoining at the same pose')
    const versions = {}
    for (const [key, urls] of instances) { const v = Number(new URL(urls[urls.length - 1], location.href).searchParams.get('hmr')); if (v) versions[key] = v }
    const r = await fetch('/__hmr/sync', { method: 'POST', body: JSON.stringify(versions) }).catch(() => null)
    return r?.ok ? record(restartEv, 'resynced', `${Object.keys(versions).length} module version(s) handed back to the restarted server`) : reloadPreserving(restartEv, 'server restarted and version resync failed')
  }
  const filter = readOnlyFilter()
  if (filter && !filter.test(ev.path)) return record(ev, 'ignored', 'outside __spointHmr.only filter')
  if (reloadOrdered && coalesced) return record(ev, 'ignored', 'a page reload is already ordered; this update lands with it')
  try {
    if (ev.kind === 'css') return applyCss(ev)
    if (ev.kind === 'module') return await applyModule(ev)
    if (ev.kind === 'app') return await applyApp(ev)
    if (ev.kind === 'asset') return await applyAsset(ev)
    if (ev.kind === 'server') return record(ev, ev.hot ? 'server-hot-swapped' : ev.restarting ? 'server-restarting' : 'server-restart-needed')
    if (ev.kind === 'world') return isSingleplayer() || !ev.restarting ? reloadPreserving(ev, ev.reason) : record(ev, 'server-restarting', 'world rebuild; this page rejoins at the same pose when the server is back')
    if (ev.kind === 'reload') return reloadPreserving(ev, ev.reason)
    return record(ev, 'noop', ev.reason || '')
  } catch (e) {
    console.error('[hmr] update failed:', e)
    return reloadPreserving(ev, 'update threw: ' + (e?.message || e))
  }
}

// A versioned import reads the file from disk at request time, so for one module the newest event
// already carries every older one's edit: applying it makes the superseded ones pure waste.
const updateKey = (ev) => (ev.kind === 'module' ? 'module:' + ev.url : ev.kind + ':' + (ev.url || '') + ':' + (ev.path || ''))
const enqueue = (ev) => {
  if (!coalesced) { queue = queue.then(() => apply(ev)); return queue }
  pendingUpdates.set(updateKey(ev), ev)
  if (draining) return queue
  draining = true
  queue = queue.then(async () => {
    while (pendingUpdates.size) {
      const batch = [...pendingUpdates.values()]
      pendingUpdates.clear()
      for (const e of batch) await apply(e)
    }
    draining = false
  })
  return queue
}

function connect() {
  const source = new EventSource(EVENTS_URL)
  source.onmessage = (msg) => {
    let ev
    try { ev = JSON.parse(msg.data) } catch (_) { return }
    if (ev.kind === 'hello') liveBootId = ev.bootId
    enqueue(ev)
  }
}

globalThis.__spointHmr = {
  accept, acceptSelf, acceptAsset, dispose, data, only, log, subsystem,
  settled: () => queue,
  setSliced: (on) => { sliced = !!on; return sliced },
  setCoalesced: (on) => { coalesced = !!on; return coalesced },
  pendingCount: () => pendingUpdates.size,
  reloadOrdered: () => reloadOrdered,
}
performance.setResourceTimingBufferSize?.(20000)
connect()
restorePose()
