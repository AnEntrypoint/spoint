const EVENTS_URL = '/__hmr/events'
const POSE_KEY = '__spointHmrPose'
const ONLY_KEY = '__spointHmrOnly'
const LOG_CAP = 200
const TICK_HANDLER_PATHS = new Set(['src/sdk/TickHandler.js', 'src/shared/movement.js'])

const acceptors = new Map()
const disposers = new Map()
const store = new Map()
const instances = new Map()
const log = []
let queue = Promise.resolve()
let lastBootId = null
let toastModule = null

const keyOf = (url) => new URL(url, location.href).pathname
const isSingleplayer = () => !!window.__app?.client?._worker
const listOf = (map, key) => { if (!map.has(key)) map.set(key, []); return map.get(key) }

function accept(url, fn) { listOf(acceptors, keyOf(url)).push({ fn, self: false }) }
function acceptSelf(url, fn) { listOf(acceptors, keyOf(url)).push({ fn, self: true }) }
function dispose(url, fn) { listOf(disposers, keyOf(url)).push(fn) }
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

function reloadPreserving(ev, reason) {
  record(ev, 'reload', reason)
  savePose()
  setTimeout(() => location.reload(), 60)
}

function versionedUrl(key, v) { return `${key}?hmr=${v}` }

function trackChain(ev, boundary) {
  for (const node of Object.keys(ancestorsOf(ev, ev.url))) {
    if (node === boundary || boundary in ancestorsOf(ev, node)) listOf(instances, node).push(versionedUrl(node, ev.v))
  }
}

function ancestorsOf(ev, node) {
  const out = {}, stack = [node]
  while (stack.length) { const n = stack.pop(); if (n in out) continue; out[n] = true; stack.push(...(ev.parents[n] || [])) }
  return out
}

function isClass(v) { return typeof v === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(v)) }

function sameValue(a, b) {
  if (a === b) return true
  if (typeof a === 'function' || typeof b === 'function') return false
  try { return JSON.stringify(a) === JSON.stringify(b) } catch (_) { return false }
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

async function tryClassPatch(ev) {
  const olds = [ev.url, ...(instances.get(ev.url) || [])]
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
  listOf(instances, ev.url).push(versionedUrl(ev.url, ev.v))
  return classes
}

function findBoundaries(ev) {
  const boundaries = new Set(), seen = new Set(), stack = [ev.url]
  while (stack.length) {
    const node = stack.pop()
    if (seen.has(node)) continue
    seen.add(node)
    if (acceptors.get(node)?.length) { boundaries.add(node); continue }
    const parents = ev.parents[node] || []
    if (!parents.length) return null
    stack.push(...parents)
  }
  return [...boundaries]
}

async function applyBoundary(ev, boundary) {
  for (const fn of disposers.get(boundary) || []) await fn(data(boundary))
  disposers.delete(boundary)
  const handlers = acceptors.get(boundary) || []
  acceptors.set(boundary, handlers.filter(h => !h.self))
  const newMod = await import(versionedUrl(boundary, ev.v))
  trackChain(ev, boundary)
  for (const h of handlers) await h.fn(newMod, data(boundary))
}

async function applyWorkerSide(ev) {
  const client = window.__app?.client
  if (!TICK_HANDLER_PATHS.has(ev.path) || !client?.hotReloadTickHandler) return null
  return (await client.hotReloadTickHandler(ev.v)) ? 'worker tick handler swapped' : null
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
  if (ev.serverStale && !isSingleplayer()) parts.push('multiplayer server still runs the old copy until restart')
  if (!ev.client) return parts.length ? record(ev, 'worker-swapped', parts.join('; ')) : record(ev, 'noop', 'not in client graph')
  if (!acceptors.get(ev.url)?.length) {
    const patched = await tryClassPatch(ev).catch(e => { console.warn('[hmr] class patch failed:', e); return false })
    if (patched) { parts.push('patched ' + patched.join(',')); return record(ev, 'patched', parts.join('; ')) }
  }
  const boundaries = findBoundaries(ev)
  if (!boundaries) return reloadPreserving(ev, 'no accept boundary up to the app root')
  for (const b of boundaries) await applyBoundary(ev, b)
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
  if (!isSingleplayer()) return record(ev, 'app-reloaded', `server hot-reloads ${ev.apps.join(',')}${ev.path.startsWith('apps/_lib/') ? ' (multiplayer node server keeps the cached _lib module until restart)' : ''}`)
  const client = window.__app.client
  if (!client.hotReloadApp) return reloadPreserving(ev, 'BrowserServer has no hotReloadApp')
  const results = await Promise.all(ev.apps.map(n => client.hotReloadApp(n)))
  const failed = ev.apps.filter((_, i) => !results[i])
  if (failed.length) return record(ev, 'failed', 'worker rejected ' + failed.join(','))
  return record(ev, 'app-reloaded', 'worker ' + ev.apps.join(','))
}

async function applyAsset(ev) {
  await Promise.all(ev.urls.map(u => fetch(u, { cache: 'reload' }).catch(() => null)))
  const handled = []
  for (const u of ev.urls) for (const h of acceptors.get(u) || []) { await h.fn(u, ev); handled.push(u) }
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
    if (restarted) return reloadPreserving({ ...ev, path: 'server', t: Date.now() }, 'server restarted; its module versions no longer match this page')
    return
  }
  const filter = readOnlyFilter()
  if (filter && !filter.test(ev.path)) return record(ev, 'ignored', 'outside __spointHmr.only filter')
  try {
    if (ev.kind === 'css') return applyCss(ev)
    if (ev.kind === 'module') return await applyModule(ev)
    if (ev.kind === 'app') return await applyApp(ev)
    if (ev.kind === 'asset') return await applyAsset(ev)
    if (ev.kind === 'server') return record(ev, ev.hot ? 'server-hot-swapped' : 'server-restart-needed')
    if (ev.kind === 'reload') return reloadPreserving(ev, ev.reason)
    return record(ev, 'noop', ev.reason || '')
  } catch (e) {
    console.error('[hmr] update failed:', e)
    return reloadPreserving(ev, 'update threw: ' + (e?.message || e))
  }
}

function connect() {
  const source = new EventSource(EVENTS_URL)
  source.onmessage = (msg) => {
    let ev
    try { ev = JSON.parse(msg.data) } catch (_) { return }
    queue = queue.then(() => apply(ev))
  }
}

globalThis.__spointHmr = { accept, acceptSelf, dispose, data, only, log, settled: () => queue }
connect()
restorePose()
