import { RenderControls } from './RenderControls.js'
import { createConfigChannel } from './RenderConfigChannel.js'

export function createLocalControlProxy(opts = {}) {
  const pollMs = opts.pollMs ?? 250
  const watchers = new Map()
  let timer = null

  function _ensurePolling() {
    if (timer || watchers.size === 0) return
    timer = setInterval(() => {
      for (const [key, w] of watchers) {
        const v = RenderControls.get(key)
        if (v !== w.lastValue) {
          w.lastValue = v
          for (const fn of w.fns) {
            try { fn(v) } catch (err) { console.error('[hud-control-proxy:local] subscriber threw for', key, err) }
          }
        }
      }
    }, pollMs)
  }

  function get(key) {
    return RenderControls.get(key)
  }

  function set(key, value) {
    return RenderControls.set(key, value)
  }

  function subscribe(key, fn) {
    let w = watchers.get(key)
    if (!w) { w = { fns: new Set(), lastValue: RenderControls.get(key) }; watchers.set(key, w) }
    w.fns.add(fn)
    _ensurePolling()
    return () => {
      w.fns.delete(fn)
      if (w.fns.size === 0) watchers.delete(key)
      if (watchers.size === 0 && timer) { clearInterval(timer); timer = null }
    }
  }

  function destroy() {
    if (timer) { clearInterval(timer); timer = null }
    watchers.clear()
  }

  return { get, set, subscribe, destroy, isRemote: false }
}

export function createRemoteControlProxy(target) {
  const chan = createConfigChannel(target)
  const mirror = {}
  const watchers = new Map()

  const unsubscribeChannel = chan.onUpdate((config) => {
    if (!config || typeof config !== 'object') return
    for (const key of Object.keys(config)) {
      const v = config[key]
      const prev = mirror[key]
      mirror[key] = v
      if (prev === v) continue
      const fns = watchers.get(key)
      if (!fns || !fns.size) continue
      for (const fn of fns) {
        try { fn(v) } catch (err) { console.error('[hud-control-proxy:remote] subscriber threw for', key, err) }
      }
    }
  })

  function get(key) {
    return mirror[key]
  }

  function set(key, value) {
    mirror[key] = value
    chan.push({ [key]: value })
    return true
  }

  function subscribe(key, fn) {
    let fns = watchers.get(key)
    if (!fns) { fns = new Set(); watchers.set(key, fns) }
    fns.add(fn)
    return () => {
      fns.delete(fn)
      if (fns.size === 0) watchers.delete(key)
    }
  }

  function destroy() {
    unsubscribeChannel()
    watchers.clear()
  }

  return { get, set, subscribe, destroy, isRemote: true }
}

export function createHudControlProxy(target) {
  return target ? createRemoteControlProxy(target) : createLocalControlProxy()
}
