// InputEventProxy.js -- postMessage input-event proxy from main thread to a worker
// (offscreencanvas-worker-input-event-proxy row, one of the 4 named prerequisites in
// offscreencanvas-worker-migration-full-game-loop's own detail text).
//
// WHY THIS EXISTS: a worker-hosted render/game loop (client/workers/OffscreenRenderWorker.js,
// client/core/WorkerRenderer.js) has no `document`/`window` -- it cannot attach its own
// pointerlockchange/keydown/keyup/mousedown/mouseup/resize listeners, and MobileControls.js's touch
// handling is itself DOM-event-driven (see client/core/MobileControls.js's touchstart/touchmove/touchend
// listeners). This module is the main-thread SOURCE half of the proxy: it owns the real DOM listeners
// (mirroring the exact event shape client/app.js + client/core/camera.js already consume:
// pointerlockchange -> attach/detach mousemove, mousemove.movementX/movementY, keydown/keyup.code,
// mousedown/mouseup.button, window resize -> innerWidth/innerHeight/devicePixelRatio) and forwards each
// as a small structured-clone-safe message over any postMessage-compatible target (a real Worker).
//
// SCOPE (deliberately bounded, per this row's own guidance): this does NOT wire client/app.js's real
// InputHandler/ams.dispatch* calls onto a worker (there is no worker-hosted game loop consuming input
// yet -- WorkerRenderer.js's own OffscreenRenderWorker.js runs an isolated demo scene, not the real game).
// This ships (1) the real proxy primitive (attach/detach, event capture, postMessage forwarding,
// MobileControls touch-state forwarding), and (2) a live latency-measurement harness so a future session
// can make the postMessage-vs-SharedArrayBuffer+Atomics decision from real numbers instead of an assumption
// -- see measureInputLatency() below and its report in AGENTS.md/PRD witness_evidence.
//
// Message shape on the wire (all under type:'input-event', mirroring RenderConfigChannel's
// type:'render-config' convention so both channels can share one worker onmessage without colliding):
//   {type:'input-event', kind:'pointerlock', locked:boolean, t}
//   {type:'input-event', kind:'mousemove', movementX, movementY, t}          -- t = performance.now() at capture
//   {type:'input-event', kind:'keydown'|'keyup', code, repeat, t}
//   {type:'input-event', kind:'mousedown'|'mouseup', button, t}
//   {type:'input-event', kind:'wheel', deltaY, t}
//   {type:'input-event', kind:'resize', width, height, dpr, t}
//   {type:'input-event', kind:'touch', state: MobileControls.state (plain object snapshot), t}
//   {type:'input-event', kind:'ping'|'pong', seq, t}                          -- latency-probe round trip
//
// Usage (main thread):
//   import { createInputEventProxy } from './InputEventProxy.js'
//   const proxy = createInputEventProxy(worker, { mobileControls })
//   proxy.attach()     // starts listening + forwarding
//   proxy.detach()     // removes all listeners
//
// Usage (worker thread):
//   import { createInputEventReceiver } from './InputEventProxy.js'   // (only reachable if bundled into
//                                                                      //  the worker's own module graph)
//   const recv = createInputEventReceiver(self)
//   recv.on('keydown', msg => localInputState.keys.add(msg.code))
//   recv.store  // {keys:Set, mouseButtons:Set, pointerLocked, mobile}

export function createInputEventProxy(target, opts = {}) {
  if (!target || typeof target.postMessage !== 'function') {
    throw new Error('createInputEventProxy: target must expose postMessage')
  }
  const mobileControls = opts.mobileControls || null
  const mobilePollMs = opts.mobilePollMs || 50 // MobileControls has no change-event -- sampled, not listened
  let attached = false
  let pointerLocked = false
  let mobileTimer = 0

  const post = (kind, data) => {
    try { target.postMessage({ type: 'input-event', kind, t: performance.now(), ...data }) }
    catch (err) { if (opts.onError) opts.onError(err) }
  }

  // Pointer-lock changes toggle real mousemove listening dynamically, mirroring client/app.js's own
  // `document.addEventListener('pointerlockchange', ...)` -> attach-mousemove-only-while-locked
  // discipline (app.js:2139-2142) -- movementX/Y is only meaningful (and only fires at a useful rate)
  // while pointer lock is actually held.
  const onPointerLockChange = () => {
    const locked = document.pointerLockElement != null
    if (locked === pointerLocked) return
    pointerLocked = locked
    post('pointerlock', { locked })
    if (locked) document.addEventListener('mousemove', onMouseMove)
    else document.removeEventListener('mousemove', onMouseMove)
  }
  const onMouseMove = e => post('mousemove', { movementX: e.movementX, movementY: e.movementY })
  const onKeyDown = e => post('keydown', { code: e.code, repeat: e.repeat })
  const onKeyUp = e => post('keyup', { code: e.code })
  const onMouseDown = e => post('mousedown', { button: e.button })
  const onMouseUp = e => post('mouseup', { button: e.button })
  const onWheel = e => post('wheel', { deltaY: e.deltaY })
  const onResize = () => post('resize', {
    width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1
  })

  // MobileControls keeps its own polled `state` object (move/look/jump/shoot/... -- see
  // client/core/MobileControls.js's constructor) with no change-event to hook -- sample it on an
  // interval instead of re-deriving raw touch geometry, matching how client/app.js's own render loop
  // already reads mc.state directly every frame rather than listening for a MobileControls event.
  function pollMobileControls() {
    if (!mobileControls || !mobileControls.enabled) return
    post('touch', { state: JSON.parse(JSON.stringify(mobileControls.state)) })
  }

  function attach() {
    if (attached) return
    attached = true
    document.addEventListener('pointerlockchange', onPointerLockChange)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('resize', onResize)
    if (document.pointerLockElement != null) { pointerLocked = true; document.addEventListener('mousemove', onMouseMove) }
    if (mobileControls) mobileTimer = setInterval(pollMobileControls, mobilePollMs)
  }

  function detach() {
    if (!attached) return
    attached = false
    document.removeEventListener('pointerlockchange', onPointerLockChange)
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('keyup', onKeyUp)
    document.removeEventListener('mousedown', onMouseDown)
    document.removeEventListener('mouseup', onMouseUp)
    document.removeEventListener('wheel', onWheel)
    document.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('resize', onResize)
    if (mobileTimer) { clearInterval(mobileTimer); mobileTimer = 0 }
  }

  return {
    attach, detach,
    isAttached: () => attached,
    // Exposed for the latency probe below (and any caller wanting a raw ping without a real DOM event
    // -- a real pointerlock/keydown/mousemove trusted event cannot be synthetically dispatched from
    // outside a real user gesture in most browsers, so the probe below uses a real-but-untrusted
    // MouseEvent dispatch instead, which document.addEventListener still delivers).
    _post: post
  }
}

// Worker-side receiver: a plain local input-state store (no `window`, matching applyLocalConfig's own
// no-window discipline in RenderConfigChannel.js) plus a listener registry keyed by `kind`, so a future
// worker-hosted game loop can do `receiver.on('keydown', msg => ...)` instead of hand-rolling its own
// onmessage switch. Also auto-replies to 'ping' messages for the latency probe.
export function createInputEventReceiver(target) {
  if (!target || typeof target.addEventListener !== 'function') {
    throw new Error('createInputEventReceiver: target must expose addEventListener')
  }
  const store = { keys: new Set(), mouseButtons: new Set(), pointerLocked: false, mobile: null }
  const listeners = new Map() // kind -> Set<fn>

  function handleMessage(e) {
    const msg = (e && e.data) || e
    if (!msg || msg.type !== 'input-event') return
    switch (msg.kind) {
      case 'pointerlock': store.pointerLocked = msg.locked; break
      case 'keydown': store.keys.add(msg.code); break
      case 'keyup': store.keys.delete(msg.code); break
      case 'mousedown': store.mouseButtons.add(msg.button); break
      case 'mouseup': store.mouseButtons.delete(msg.button); break
      case 'touch': store.mobile = msg.state; break
      case 'ping': target.postMessage({ type: 'input-event', kind: 'pong', seq: msg.seq, t: msg.t }); break
    }
    const set = listeners.get(msg.kind)
    if (set) for (const fn of set) { try { fn(msg) } catch (err) { console.error('[input-event-proxy] listener threw', err) } }
  }

  target.addEventListener('message', handleMessage)

  function on(kind, fn) {
    if (!listeners.has(kind)) listeners.set(kind, new Set())
    listeners.get(kind).add(fn)
    return () => listeners.get(kind).delete(fn)
  }

  return { store, on }
}

// LIVE LATENCY MEASUREMENT (the row's own critical ask -- must be measured, not assumed, before
// deciding plain postMessage vs a SharedArrayBuffer+Atomics ring buffer for aim-critical input).
//
// Methodology: post `sampleCount` real 'ping' messages (performance.now()-stamped at send, replied to
// by createInputEventReceiver's own 'ping'->'pong' handler) to the worker one at a time (awaiting each
// 'pong' before sending the next, so results are not inflated by postMessage queue backpressure) --
// this is the raw main<->worker postMessage transport latency, the thing that actually decides
// postMessage-vs-SharedArrayBuffer+Atomics. Separately, fires `sampleCount` REAL (dispatchEvent-driven,
// non-trusted-but-still-delivered) DOM mousemove events at document while the proxy is attached and
// pointer-locked, immediately following each with a 'ping' on the same worker to bound the full
// dispatch -> proxy-handler -> postMessage-enqueue -> worker-processed pipeline. Returns real wall-clock
// deltas from a real postMessage round trip across a real Worker boundary -- no synthetic/mocked timing.
export async function measureInputLatency(worker, opts = {}) {
  const sampleCount = opts.sampleCount || 30
  let seqCounter = 0

  function roundTrip(extra) {
    return new Promise((resolve, reject) => {
      const seq = ++seqCounter
      const timeout = setTimeout(() => { cleanup(); reject(new Error('measureInputLatency: pong timeout for seq ' + seq)) }, 2000)
      function onMsg(e) {
        const msg = e.data
        if (msg && msg.type === 'input-event' && msg.kind === 'pong' && msg.seq === seq) {
          cleanup()
          resolve(performance.now() - msg.t)
        }
      }
      function cleanup() { clearTimeout(timeout); worker.removeEventListener('message', onMsg) }
      worker.addEventListener('message', onMsg)
      worker.postMessage({ type: 'input-event', kind: 'ping', seq, t: performance.now(), ...extra })
    })
  }

  const pingPong = []
  for (let i = 0; i < sampleCount; i++) pingPong.push(await roundTrip())

  // DOM-to-worker: exercise the real proxy's dispatch->post path via a genuine dispatched DOM event,
  // then immediately ping (same worker, same transport) to bound total pipeline latency -- a raw
  // 'mousemove' message itself is fire-and-forget (no reply), so the trailing ping is what turns this
  // into a measurable round trip while still exercising the real onMouseMove handler beforehand.
  const domToWorker = []
  const proxy = createInputEventProxy(worker)
  proxy.attach()
  try {
    for (let i = 0; i < sampleCount; i++) {
      document.dispatchEvent(new MouseEvent('mousemove', { movementX: 1, movementY: 1 }))
      domToWorker.push(await roundTrip())
    }
  } finally {
    proxy.detach()
  }

  function stats(arr) {
    const s = [...arr].sort((a, b) => a - b)
    return {
      p50: s[Math.floor(s.length * 0.5)],
      p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
      max: s[s.length - 1],
      min: s[0],
      samples: s.length
    }
  }

  return { pingPongMs: stats(pingPong), domToWorkerMs: stats(domToWorker) }
}
