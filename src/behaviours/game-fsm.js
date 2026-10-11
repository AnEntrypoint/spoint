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

export class GameFSMError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'GameFSMError'
    this.code = code
  }
}

const STATE_KEYS = ['enter', 'entry', 'exit', 'tick', 'on', 'after', 'final', 'type']

const _MS_KEY = /^\d+$/

const _isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

const _quote = (v) => JSON.stringify(v ?? null)

function describeDef(d) {
  if (typeof d === 'string') return `"${d}"`
  if (d === null) return 'null'
  if (d === undefined) return 'undefined'
  if (typeof d === 'function') return 'a function'
  if (Array.isArray(d)) return 'an array'
  return String(d)
}

function checkTransition(stateName, what, def, names) {
  if (def === null || def === undefined || (typeof def !== 'string' && (typeof def !== 'object' || Array.isArray(def)))) {
    throw new GameFSMError('game-fsm-transition-shape', `state "${stateName}" ${what} must be a target state name or a transition object, got ${describeDef(def)}: a definition that is neither is never taken, so the event is dead in every state that receives it`)
  }
  if (typeof def === 'string') {
    if (!names.includes(def)) throw new GameFSMError('game-fsm-transition-unknown-target', `state "${stateName}" ${what} targets unknown state "${def}" (have: ${names.join(', ')}): the machine can never enter it, so the transition is dead rather than refused`)
    return
  }
  if (def.target !== undefined) {
    if (typeof def.target !== 'string' || !names.includes(def.target)) {
      throw new GameFSMError('game-fsm-transition-unknown-target', `state "${stateName}" ${what} targets unknown state ${_quote(def.target)} (have: ${names.join(', ')})`)
    }
  } else if (typeof def.action !== 'function') {
    throw new GameFSMError('game-fsm-transition-dead', `state "${stateName}" ${what} resolves to no transition: it declares neither a target nor an action, so the event is dead in every state that receives it`)
  }
  if (def.guard !== undefined && typeof def.guard !== 'function') {
    throw new GameFSMError('game-fsm-transition-guard-not-function', `state "${stateName}" ${what} declares a guard of type ${typeof def.guard}: it is never called, so the transition is taken unconditionally instead of being gated`)
  }
  if (def.action !== undefined && typeof def.action !== 'function') {
    throw new GameFSMError('game-fsm-transition-action-not-function', `state "${stateName}" ${what} declares an action of type ${typeof def.action}: it is never called, so the transition runs without the effect the spec wrote for it`)
  }
}

function validateSpec(spec) {
  if (!_isPlainObject(spec)) throw new GameFSMError('game-fsm-spec-not-object', `spec is ${describeDef(spec)}: the machine is read from spec.states, so a value that is not a plain object carries no state to read and the failure would surface inside xstate with no spec named`)
  if (spec.id !== undefined && (typeof spec.id !== 'string' || spec.id.length === 0)) {
    throw new GameFSMError('game-fsm-spec-id-not-string', `spec.id is ${describeDef(spec.id)}: it becomes the xstate machine id, so a value that is not a non-empty string is coerced into an id no caller can look this machine up by`)
  }
  if (spec.context !== undefined && !_isPlainObject(spec.context)) {
    throw new GameFSMError('game-fsm-context-not-object', `spec.context is ${describeDef(spec.context)}: it is spread into the machine context, so a value that is not a plain object either contributes no field or contributes its own indices as field names, and every fsm.context.<field> read then answers undefined in place of the seeded value`)
  }
  const states = spec.states
  if (!_isPlainObject(states) || !Object.keys(states).length) {
    throw new GameFSMError('game-fsm-states-not-object', `spec.states is ${describeDef(states)}: it must be a non-empty plain object of state definitions, and an empty or non-object one leaves the machine with no state to enter`)
  }
  const names = Object.keys(states)
  if (!spec.initial) throw new GameFSMError('game-fsm-initial-required', 'spec.initial is required: the machine enters it on start, so without one there is no state to enter')
  if (!names.includes(spec.initial)) {
    throw new GameFSMError('game-fsm-initial-undeclared', `spec.initial "${spec.initial}" is not a declared state (have: ${names.join(', ')})`)
  }
  for (const name of names) {
    const st = states[name]
    if (!_isPlainObject(st)) {
      throw new GameFSMError('game-fsm-state-def-not-object', `state "${name}" is ${describeDef(st)}: a state definition must be a plain object of hooks and transitions, and any other value reads as an empty state, so every hook and transition written for it is dropped without being reported`)
    }
    if (st.type !== undefined && st.type !== 'final') {
      throw new GameFSMError('game-fsm-state-type-unsupported', `state "${name}" declares type ${_quote(st.type)}: this module builds a flat machine and reads only "final", so any other type is dropped and the state is entered as an ordinary one, which is what makes a "parallel" state behave as if it were a single state`)
    }
    if (st.final !== undefined && typeof st.final !== 'boolean') {
      throw new GameFSMError('game-fsm-state-final-not-boolean', `state "${name}" declares final ${_quote(st.final)}: only true marks the state terminal, so a truthy value that is not true leaves the machine running in a state the author meant to be final, and its tick hook keeps being called`)
    }
    if (st.enter != null && st.entry != null) {
      throw new GameFSMError('game-fsm-state-enter-and-entry', `state "${name}" declares both "enter" and "entry": "enter" is read and "entry" is dropped, so one of the two hooks never runs and the state enters half-initialised`)
    }
    const eachTransition = (what, def) => {
      const list = Array.isArray(def) ? def : [def]
      if (list.length === 0) throw new GameFSMError('game-fsm-transition-list-empty', `state "${name}" ${what} declares no transition: an empty candidate list matches nothing, so the event is dead rather than refused`)
      for (const one of list) checkTransition(name, what, one, names)
    }
    for (const k of Object.keys(st)) {
      if (!STATE_KEYS.includes(k)) throw new GameFSMError('game-fsm-state-unknown-key', `state "${name}" declares unknown key "${k}" (handled: ${STATE_KEYS.join(', ')}): an unhandled key is never read, so the hook or transition it names is silently absent from the machine`)
    }
    for (const [evt, def] of Object.entries(st.on || {})) {
      eachTransition(`event "${evt}"`, def)
    }
    for (const [ms, def] of Object.entries(st.after || {})) {
      if (!_MS_KEY.test(ms)) throw new GameFSMError('game-fsm-after-delay-not-ms', `state "${name}" declares after(${ms}); the key is a delay in milliseconds and must be a non-negative integer, so any other key is a timer that never fires`)
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
  if (appCtx !== undefined && !_isPlainObject(appCtx)) {
    throw new GameFSMError('game-fsm-appctx-not-object', `appCtx is ${describeDef(appCtx)}: every hook is called as hook(appCtx, ...) and every guard reads it, so a value that is not a plain object turns each of those reads into a failure raised inside the hook, far from this call that could have named it`)
  }

  const _declaredStates = Object.keys(spec.states)
  const _stateArg = (s, method) => {
    if (typeof s !== 'string' || !_declaredStates.includes(s)) {
      throw new GameFSMError('game-fsm-undeclared-state-name', `${method} was given the state ${_quote(s)}: this machine declares ${_declaredStates.join(', ')}, and any other name matches nothing, so the call answers false forever and a typo reads as "not in that state" instead of being refused here`)
    }
    return s
  }
  const _eventArg = (evt, method) => {
    if (typeof evt !== 'string' || evt.length === 0) {
      throw new GameFSMError('game-fsm-event-name-not-string', `${method} was given the event ${_quote(evt)}: xstate matches events by their type, so a name that is not a non-empty string matches no transition and the call answers false or delivers nothing instead of being refused here`)
    }
    return evt
  }

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
    is(s) { return actor.getSnapshot().matches(_stateArg(s, 'is')) },
    matches(s) { return actor.getSnapshot().matches(_stateArg(s, 'matches')) },
    can(evt) { return actor.getSnapshot().can({ type: _eventArg(evt, 'can') }) },
    send(type, payload) {
      const eventName = _eventArg(type, 'send')
      if (payload != null && !_isPlainObject(payload)) {
        throw new GameFSMError('game-fsm-payload-not-object', `send("${eventName}") was given the payload ${describeDef(payload)}: it is spread into the event, so a value that is not a plain object reaches the guard and action as fields that were never sent -- a primitive contributes nothing at all and an array contributes its own indices -- instead of being refused here`)
      }
      if (payload != null && Object.prototype.hasOwnProperty.call(payload, 'type')) {
        throw new GameFSMError('game-fsm-payload-overrides-type', `send("${eventName}") was given a payload carrying its own "type" ${_quote(payload.type)}: the payload is spread over { type }, so it replaces the event name and a different event is delivered from the one the call named`)
      }
      const event = payload != null ? { type: eventName, ...payload } : { type: eventName }
      const before = actor.getSnapshot()
      if (_stopped) return { ok: false, reason: 'stopped', event: eventName, state: before.value }
      if (!before.can(event)) return { ok: false, reason: 'unhandled', event: eventName, state: before.value }
      actor.send(event)
      return { ok: true, event: eventName, state: actor.getSnapshot().value }
    },
    onTransition(fn) {
      if (typeof fn !== 'function') {
        throw new GameFSMError('game-fsm-listener-not-function', `onTransition was given ${describeDef(fn)}: it is stored as a listener and called on every transition, and the notify loop contains each listener's throw so the transition still completes, so a non-function is a listener that never reports anything and never reports why`)
      }
      if (_stopped) return () => {}
      _subs.add(fn)
      return () => _subs.delete(fn)
    },
    tick(dt) {
      if (!Number.isFinite(dt)) {
        throw new GameFSMError('game-fsm-dt-not-finite-number', `tick was given dt ${_quote(dt)}: it is passed straight to the active state's tick hook, so a value that is not a finite number arrives there as NaN and every comparison against it is false, which reads as "nothing happened" instead of as a bad dt`)
      }
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
      for (const fn of _subs) {
        try {
          fn(snap.value, runtime)
        } catch (error) {
          console.error(`game-fsm-listener-threw: ${error?.message ?? error}: the throw is contained so the transition still completes, so a listener that throws would otherwise vanish without a trace and read as a machine that never transitions`)
        }
      }
    }
  })
  actor.start()

  return runtime
}

function _now() { return Date.now() }

export default defineGameFSM
