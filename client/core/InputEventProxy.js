export function createInputEventProxy(target, opts = {}) {
  if (!target || typeof target.postMessage !== 'function') {
    throw new Error('createInputEventProxy: target must expose postMessage')
  }
  const mobileControls = opts.mobileControls || null
  const mobilePollMs = opts.mobilePollMs || 50
  let attached = false
  let pointerLocked = false
  let mobileTimer = 0

  const post = (kind, data) => {
    try { target.postMessage({ type: 'input-event', kind, t: performance.now(), ...data }) }
    catch (err) { if (opts.onError) opts.onError(err) }
  }

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
    _post: post
  }
}

export function createInputEventReceiver(target) {
  if (!target || typeof target.addEventListener !== 'function') {
    throw new Error('createInputEventReceiver: target must expose addEventListener')
  }
  const store = { keys: new Set(), mouseButtons: new Set(), pointerLocked: false, mobile: null }
  const listeners = new Map()

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
