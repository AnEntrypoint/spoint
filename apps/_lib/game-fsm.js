// spec = { initial, context?, states: { name: { enter/exit/tick(ctx,fsm), on: {EVT: target|{target,guard,action}}, after: {ms: target}, final? } } }; defineGameFSM(spec, appCtx)
const _isNode = typeof process !== 'undefined' && !!process.versions?.node
// Edge-target seam (edge-cf-durable-object-transport-adapter-real-websocketpair, same session as
// World.js's getJolt() __SPOINT_EDGE_JOLT__ seam): a real Cloudflare Durable Object has
// process.versions.node UNDEFINED (no nodejs_compat needed/wanted for this graph -- see World.js's
// comment for why nodejs_compat itself breaks jolt-physics), so `_isNode` correctly evaluates false
// there, same as a real browser -- but unlike a real browser, a DO's module resolution is a bundler
// (esbuild via wrangler), which CAN resolve the bare 'xstate' specifier (a real bundleable pure-JS
// npm package, zero Node-native hazard) but has no filesystem to serve the browser-only ABSOLUTE
// '/node_modules/...' path from -- live-reproduced as a real workerd runtime error ('No such module
// "node_modules/xstate/dist/xstate.esm.js"'), distinct from the BUILD-time-only esbuild-static-
// resolution problem the specifier-built-at-runtime fix (still applied below) solves. The edge DO
// entry script (edge/cf-do/jolt-edge-init.js's sibling initJoltForEdge, called before any app module
// loads) sets this flag so xstate resolves via the bare specifier there too.
let _xstate
if (_isNode || typeof globalThis.__SPOINT_EDGE_BUNDLED__ !== 'undefined') {
  // Real literal specifier (not obfuscated) -- 'xstate' is a real bundleable pure-JS npm package with
  // zero Node-native hazard, so a bundler-based edge/DO build target SHOULD statically resolve+bundle
  // it here, unlike jolt-physics/draco3dgltf's specifier-built-at-runtime fixes elsewhere in this
  // session (those obfuscate a specifier that must NOT be bundled/resolved at all).
  _xstate = await import('xstate')
} else {
  // Real un-bundled browser only: obfuscated so a bundler build never tries to statically resolve
  // this absolute path (which has no real module behind it in a bundled/edge context anyway).
  const _browserXstateSpec = (() => '/node_modules/' + 'xstate/dist/xstate.esm.js')()
  _xstate = await import(_browserXstateSpec)
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
    // final states do not tick
    tick(dt) {
      if (_stopped) return
      const snap = actor.getSnapshot()
      if (snap.status === 'done') return
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
