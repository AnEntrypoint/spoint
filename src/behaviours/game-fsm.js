const _isNode = typeof process !== 'undefined' && !!process.versions?.node
let _xstate
const _bareXstateSpecifierResolvable = _isNode || typeof globalThis.__SPOINT_EDGE_BUNDLED__ !== 'undefined'
if (_bareXstateSpecifierResolvable) {
  _xstate = await import('xstate')
} else {
  const _bundlerOpaqueBrowserXstateSpec = (() => globalThis.location.origin + '/node_modules/' + 'xstate/dist/xstate.esm.js')()
  _xstate = await import(_bundlerOpaqueBrowserXstateSpec)
}
const { setup, createActor, assign } = _xstate

const STATE_KEYS = ['enter', 'entry', 'exit', 'tick', 'on', 'after', 'final', 'type']

const _MS_KEY = /^\d+$/

function describeDef(d) {
  if (typeof d === 'string') return `"${d}"`
  if (Array.isArray(d)) return 'an array'
  return String(d)
}

function checkTransition(stateName, what, def, names) {
  if (def === null || def === undefined || (typeof def !== 'string' && (typeof def !== 'object' || Array.isArray(def)))) {
    throw new Error(`[game-fsm] state "${stateName}" ${what} must be a target state name or a transition object, got ${describeDef(def)}`)
  }
  if (typeof def === 'string') {
    if (!names.includes(def)) throw new Error(`[game-fsm] state "${stateName}" ${what} targets unknown state "${def}"`)
    return
  }
  if (def.target !== undefined) {
    if (typeof def.target !== 'string' || !names.includes(def.target)) {
      throw new Error(`[game-fsm] state "${stateName}" ${what} targets unknown state "${def.target}"`)
    }
  } else if (typeof def.action !== 'function') {
    throw new Error(`[game-fsm] state "${stateName}" ${what} resolves to no transition: it declares neither a target nor an action, so the event is dead in every state that receives it`)
  }
  if (def.guard !== undefined && typeof def.guard !== 'function') {
    throw new Error(`[game-fsm] state "${stateName}" ${what} declares a guard that is not a function, so it is never read`)
  }
  if (def.action !== undefined && typeof def.action !== 'function') {
    throw new Error(`[game-fsm] state "${stateName}" ${what} declares an action that is not a function, so it is never called`)
  }
}

function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('[game-fsm] spec must be an object')
  const states = spec.states
  if (!states || typeof states !== 'object' || !Object.keys(states).length) {
    throw new Error('[game-fsm] spec.states must be a non-empty object')
  }
  const names = Object.keys(states)
  if (!spec.initial) throw new Error('[game-fsm] spec.initial is required')
  if (!names.includes(spec.initial)) {
    throw new Error(`[game-fsm] spec.initial "${spec.initial}" is not a declared state (have: ${names.join(', ')})`)
  }
  for (const name of names) {
    const st = states[name] || {}
    const eachTransition = (what, def) => {
      const list = Array.isArray(def) ? def : [def]
      if (list.length === 0) throw new Error(`[game-fsm] state "${name}" ${what} declares no transition`)
      for (const one of list) checkTransition(name, what, one, names)
    }
    for (const k of Object.keys(st)) {
      if (!STATE_KEYS.includes(k)) throw new Error(`[game-fsm] state "${name}" declares unknown key "${k}" (handled: ${STATE_KEYS.join(', ')})`)
    }
    for (const [evt, def] of Object.entries(st.on || {})) {
      eachTransition(`event "${evt}"`, def)
    }
    for (const [ms, def] of Object.entries(st.after || {})) {
      if (!_MS_KEY.test(ms)) throw new Error(`[game-fsm] state "${name}" declares after(${ms}); the key is a delay in milliseconds and must be a non-negative integer`)
      eachTransition(`after(${ms})`, def)
    }
  }
}

function normalizeTransition(stateName, key, def, guards, actions, getRuntime, getAppCtx) {
  if (Array.isArray(def)) {
    return def.map((d, i) => normalizeOne(stateName, `${key}_${i}`, d, guards, actions, getRuntime, getAppCtx))
  }
  return normalizeOne(stateName, key, def, guards, actions, getRuntime, getAppCtx)
}

function normalizeOne(stateName, key, def, guards, actions, getRuntime, getAppCtx) {
  const target = typeof def === 'string' ? def : def.target
  const out = { target }
  if (def && typeof def === 'object') {
    if (typeof def.guard === 'function') {
      const gname = `g_${stateName}_${key}`
      guards[gname] = () => !!def.guard(getAppCtx(), getRuntime())
      out.guard = gname
    }
    if (typeof def.action === 'function') {
      const aname = `a_${stateName}_${key}`
      actions[aname] = () => def.action(getAppCtx(), getRuntime())
      out.actions = aname
    }
  }
  return out
}

export function defineGameFSM(spec, appCtx) {
  validateSpec(spec)

  let runtime = null
  const getRuntime = () => runtime
  const getAppCtx = () => appCtx

  const guards = {}
  const actions = {}
  const xstates = {}

  for (const [name, raw] of Object.entries(spec.states)) {
    const st = raw || {}
    const xs = {}
    if (st.final === true || st.type === 'final') xs.type = 'final'

    const enterHook = st.enter ?? st.entry
    if (typeof enterHook === 'function') {
      const an = `enter_${name}`
      actions[an] = () => enterHook(getAppCtx(), getRuntime())
      xs.entry = an
    }
    if (typeof st.exit === 'function') {
      const an = `exit_${name}`
      actions[an] = () => st.exit(getAppCtx(), getRuntime())
      xs.exit = an
    }

    if (st.on) {
      xs.on = {}
      for (const [evt, def] of Object.entries(st.on)) {
        xs.on[evt] = normalizeTransition(name, evt, def, guards, actions, getRuntime, getAppCtx)
      }
    }
    if (st.after) {
      xs.after = {}
      for (const [ms, def] of Object.entries(st.after)) {
        xs.after[ms] = normalizeTransition(name, `after${ms}`, def, guards, actions, getRuntime, getAppCtx)
      }
    }
    xstates[name] = xs
  }

  const machine = setup({ guards, actions }).createMachine({
    id: spec.id || 'game-fsm',
    initial: spec.initial,
    context: { ...(spec.context || {}) },
    states: xstates
  })

  const actor = createActor(machine)
  let _stopped = false
  const _subs = new Set()

  runtime = {
    get context() { return actor.getSnapshot().context },
    get state() { return actor.getSnapshot().value },
    get timeInState() { return _stopped ? 0 : (_now() - _stateEnteredAt) },
    is(s) { return actor.getSnapshot().matches(s) },
    matches(s) { return actor.getSnapshot().matches(s) },
    can(evt) { return actor.getSnapshot().can({ type: evt }) },
    send(type, payload) {
      const event = payload != null ? { type, ...payload } : { type }
      const before = actor.getSnapshot()
      if (_stopped) return { ok: false, reason: 'stopped', event: type, state: before.value }
      if (!before.can(event)) return { ok: false, reason: 'unhandled', event: type, state: before.value }
      actor.send(event)
      return { ok: true, event: type, state: actor.getSnapshot().value }
    },
    onTransition(fn) {
      if (_stopped) return () => {}
      _subs.add(fn)
      return () => _subs.delete(fn)
    },
    tick(dt) {
      if (_stopped) return
      const snap = actor.getSnapshot()
      const inFinalState = snap.status === 'done'
      if (inFinalState) return
      const name = snap.value
      const st = spec.states[name]
      if (st && typeof st.tick === 'function') st.tick(getAppCtx(), dt, runtime)
    },
    stop() {
      if (_stopped) return
      _stopped = true
      _subs.clear()
      try { actor.stop() } catch (_) {}
    }
  }

  let _stateEnteredAt = _now()
  let _lastValue = null
  actor.subscribe((snap) => {
    if (snap.value !== _lastValue) {
      _lastValue = snap.value
      _stateEnteredAt = _now()
      for (const fn of _subs) { try { fn(snap.value, runtime) } catch (_) {} }
    }
  })
  actor.start()

  return runtime
}

function _now() { return Date.now() }

export default defineGameFSM
