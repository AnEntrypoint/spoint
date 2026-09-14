import { RenderControls } from './RenderControls.js'

const SYNCABLE_TYPES = new Set(['boolean', 'number', 'string'])

function syncableControls() {
  return RenderControls.controls.filter(c => SYNCABLE_TYPES.has(c.type))
}

export function snapshotRenderConfig() {
  const out = {}
  for (const c of syncableControls()) {
    const v = RenderControls.get(c.key)
    out[c.key] = v === undefined ? null : v
  }
  return out
}

export function applyRenderConfig(config) {
  if (!config || typeof config !== 'object') return []
  const changed = []
  const byKey = new Map(syncableControls().map(c => [c.key, c]))
  for (const key of Object.keys(config)) {
    if (!byKey.has(key)) continue
    const prev = RenderControls.get(key)
    const next = config[key]
    if (prev !== next) {
      RenderControls.set(key, next)
      changed.push(key)
    }
  }
  return changed
}

export function applyLocalConfig(config, store) {
  if (!config || typeof config !== 'object') return []
  if (!store || typeof store !== 'object') throw new Error('applyLocalConfig: store must be a plain object')
  const changed = []
  const knownKeys = new Set(syncableControls().map(c => c.key))
  for (const key of Object.keys(config)) {
    if (!knownKeys.has(key)) continue
    if (store[key] !== config[key]) {
      store[key] = config[key]
      changed.push(key)
    }
  }
  return changed
}

export function diffRenderConfig(prevSnap, nextSnap) {
  const out = {}
  const keys = new Set([...Object.keys(prevSnap || {}), ...Object.keys(nextSnap || {})])
  for (const key of keys) {
    const a = prevSnap ? prevSnap[key] : undefined
    const b = nextSnap ? nextSnap[key] : undefined
    if (a !== b) out[key] = [a === undefined ? null : a, b === undefined ? null : b]
  }
  return out
}

export function createConfigChannel(target) {
  if (!target || typeof target.postMessage !== 'function') {
    throw new Error('createConfigChannel: target must expose postMessage')
  }
  const listeners = new Set()

  function handleMessage(e) {
    const msg = (e && e.data) || e
    if (!msg || msg.type !== 'render-config') return
    for (const fn of listeners) {
      try { fn(msg.config) } catch (err) { console.error('[render-config-channel] listener threw', err) }
    }
  }

  if (typeof target.addEventListener === 'function') {
    target.addEventListener('message', handleMessage)
  } else {
    const prior = target.onmessage
    target.onmessage = (e) => { if (prior) prior(e); handleMessage(e) }
  }

  function push(config) {
    target.postMessage({ type: 'render-config', config })
  }

  function onUpdate(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  return { push, onUpdate }
}
