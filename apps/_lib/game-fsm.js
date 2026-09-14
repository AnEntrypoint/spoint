const _isNode = typeof process !== 'undefined' && !!process.versions?.node
let _xstate
const _bareXstateSpecifierResolvable = _isNode || typeof globalThis.__SPOINT_EDGE_BUNDLED__ !== 'undefined'
if (_bareXstateSpecifierResolvable) {
  _xstate = await import('xstate')
} else {
  const _bundlerOpaqueBrowserXstateSpec = (() => '/node_modules/' + 'xstate/dist/xstate.esm.js')()
  _xstate = await import(_bundlerOpaqueBrowserXstateSpec)
}
const { setup, createActor, assign } = _xstate

const HOOK_KEYS = ['enter', 'exit', 'tick']

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
  const targetsOf = (def) => (Array.isArray(def) ? def : [def]).map(d => typeof d === 'string' ? d : d?.target).filter(Boolean)
  for (const name of names) {
    const st = states[name] || {}
    for (const [evt, def] of Object.entries(st.on || {})) {
      for (const target of targetsOf(def)) {
        if (!names.includes(target)) throw new Error(`[game-fsm] state "${name}" event "${evt}" targets unknown state "${target}"`)
      }
    }
    for (const [ms, def] of Object.entries(st.after || {})) {
      for (const target of targetsOf(def)) {
        if (!names.includes(target)) throw new Error(`[game-fsm] state "${name}" after(${ms}) targets unknown state "${target}"`)
      }
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

    if (typeof st.enter === 'function') {
      const an = `enter_${name}`
      actions[an] = () => st.enter(getAppCtx(), getRuntime())
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
      if (_stopped) return
      actor.send(payload != null ? { type, ...payload } : { type })
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
