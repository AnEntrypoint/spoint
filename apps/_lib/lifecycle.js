import { createMachine, createActor } from '/spoint/node_modules/xstate/dist/xstate.esm.js'

const _machine = createMachine({
  id: 'app',
  initial: 'idle',
  states: {
    idle: { on: { SETUP: 'setting_up' } },
    setting_up: { on: { READY: 'ready', ERROR: 'error' } },
    ready: { on: { DESTROY: 'destroyed' } },
    error: { on: { DESTROY: 'destroyed' } },
    destroyed: { type: 'final' }
  }
})

export function createAppMachine(ctx) {
  const key = '_xstateMachine'
  if (ctx.state[key]) return ctx.state[key]
  const actor = createActor(_machine)
  actor.start()
  ctx.state[key] = {
    get state() { return actor.getSnapshot().value },
    send: (type) => actor.send({ type }),
    is: (s) => actor.getSnapshot().matches(s),
    onTransition: (fn) => actor.subscribe(snap => fn(snap.value))
  }
  return ctx.state[key]
}
