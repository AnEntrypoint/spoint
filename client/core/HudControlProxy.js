// HudControlProxy.js -- a get/set/subscribe-shaped proxy that lets a main-thread-only HUD/DOM
// panel (ConnectionStatus.js, SpectatorMode.js, tweak-panel.js) read and write RenderControls
// knob state through IDENTICAL call-site code whether the render loop lives on the main thread
// (today) or on a future worker-hosted OffscreenCanvas render loop (offscreencanvas-worker-
// migration-full-game-loop epic).
//
// WHY THIS EXISTS: RenderConfigChannel.js already proved the transport primitive (a postMessage
// wire format + push()/onUpdate() wrapping any Worker/MessagePort) but is a ONE-SHOT snapshot-push
// helper, not something a panel can call get('splitFactor')/set('splitFactor', 0.4) against at
// arbitrary call sites the way it already calls RenderControls.get/set today. A DOM panel like a
// live knob editor needs exactly that call shape: read the CURRENT value to paint a control, write
// a NEW value when the user drags a slider, and be notified when the value changes from elsewhere
// (server push, another panel, the render loop itself). This module is that shape, built on TOP of
// RenderConfigChannel's wire format (reuses buildable knob list via RenderControls, and the exact
// same {type:'render-config', config:{...}} message createConfigChannel already speaks) rather than
// inventing a second parallel protocol.
//
// Two interchangeable backends, same public API ({get, set, subscribe, isRemote}):
//
//   createLocalControlProxy()
//     Main-thread today: reads/writes RenderControls.get/set directly, synchronously, on the same
//     thread the DOM panel itself runs on. This is the path spoint uses right now (no worker yet).
//
//   createRemoteControlProxy(target)
//     Future worker-hosted loop: `target` is a Worker (or, symmetrically, `self` from inside the
//     worker) or any MessagePort-shaped object. get()/set() calls now cross a postMessage boundary:
//       - set(key, value) posts {type:'render-config', config:{[key]: value}} (the EXACT
//         RenderConfigChannel wire shape -- a real worker-hosted render loop listening via
//         createConfigChannel(self).onUpdate(cfg => applyLocalConfig(cfg, store)) needs zero new
//         message-type handling to receive this).
//       - get(key) returns the proxy's own last-known LOCAL MIRROR of that key (updated by every
//         inbound render-config message, including the echo of its own set() once the remote side
//         acks/re-broadcasts) -- reading across a postMessage boundary cannot be synchronous, so
//         get() is a read of the most recently observed value, not a live round-trip query. This
//         mirrors how every other cross-thread state mirror in this codebase already works (e.g.
//         RenderControls' own read-only 'object' knobs like vsync/fogState/vramStats, which are
//         written BY the render loop and read as a snapshot, never queried synchronously).
//       - subscribe(key, fn) fires fn(value) whenever an inbound render-config message changes that
//         key (including the panel's own set() once it round-trips back, so a caller that always
//         re-paints from subscribe() rather than from set()'s return value behaves identically on
//         both backends).
//
// A DOM panel built against this interface (see TweakPanel.js) needs ZERO branching on which
// backend it holds -- swapping createLocalControlProxy() for createRemoteControlProxy(worker) at
// construction time is the entire migration for that panel, matching this row's own acceptance bar
// ("the SAME call-site code, not a special-case worker path").
//
// SCOPE (deliberately bounded, matching the PRD row): this module + TweakPanel.js are the first,
// live-verified proof of the contract for ONE representative panel. ConnectionStatus.js/
// SpectatorMode.js/other HUD panels are NOT touched here -- they can adopt the identical
// createLocalControlProxy()/createRemoteControlProxy() pattern independently once a worker-hosted
// loop actually exists to make the remote backend meaningful in production.

import { RenderControls } from './RenderControls.js'
import { createConfigChannel } from './RenderConfigChannel.js'

// ---- Local (main-thread, direct) backend -------------------------------------------------------
// Reads/writes RenderControls synchronously. subscribe() has no natural "changed elsewhere" signal
// on this backend (RenderControls has no event emitter -- it's a window.__<key> mirror), so it polls
// at a caller-chosen interval (default 250ms, cheap: a handful of window.__<key> reads) purely to
// keep the two backends' subscribe() contracts behaviorally equivalent (fires on ANY change to the
// watched key, not just changes originating from this proxy's own set()).
export function createLocalControlProxy(opts = {}) {
  const pollMs = opts.pollMs ?? 250
  const watchers = new Map() // key -> {fn, lastValue}
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

// ---- Remote (postMessage, worker-hosted) backend -----------------------------------------------
// `target` is anything createConfigChannel accepts (a real Worker from the main-thread side, or
// `self` from inside a worker/module-worker global scope). Maintains a local plain-object mirror
// of every key it has ever observed, updated by inbound render-config messages via
// createConfigChannel's own onUpdate() -- this module does not duplicate that listener logic, it
// composes with it directly.
export function createRemoteControlProxy(target) {
  const chan = createConfigChannel(target) // throws synchronously if target is not postMessage-shaped
  const mirror = {}
  const watchers = new Map() // key -> Set<fn>

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

  // Optimistic local update (so a caller reading get() immediately after set() sees its own write,
  // matching the local backend's synchronous read-your-write behavior) PLUS the real postMessage
  // push using the exact RenderConfigChannel wire shape -- a real worker-hosted render loop on the
  // other end needs zero new message handling, just createConfigChannel(self).onUpdate(cfg =>
  // applyLocalConfig(cfg, store)) as documented in RenderConfigChannel.js's own worker-side usage.
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

// Convenience: pick the right backend for the current environment. `target` is optional -- pass a
// Worker/MessagePort to get the remote backend, omit it (or pass a falsy value) for the local
// backend. A future worker-hosted-loop boot path calls this the SAME way a main-thread boot path
// does, just with a real Worker reference in hand.
export function createHudControlProxy(target) {
  return target ? createRemoteControlProxy(target) : createLocalControlProxy()
}
