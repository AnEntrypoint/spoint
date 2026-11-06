const _isNode = typeof process !== 'undefined' && process.versions?.node
const { createMachine, createActor, assign } = await import(_isNode ? 'xstate' : '/node_modules/xstate/dist/xstate.esm.js')
import { STRINGS } from './strings.js'

const STEPS = ['assets', 'environment', 'firstSnapshot', 'models']

export const notModelFailure = ({ context }) => context.modelFailure !== true

export const allDone = ({ context }) => !context.modelFailure && STEPS.every((s) => context[s]) && context.entityPending <= 0

export const hasContent = ({ context }) => !context.modelFailure && context.firstSnapshot && context.environment

export const worldExists = ({ context }) => context.world === true

export const LOADING_FALLBACK_MS = 10000
export const LOADING_HARD_MS = 45000

export const loadingMachine = createMachine({
  id: 'loading',
  initial: 'loading',
  context: {
    assets: false, worldConfig: false, environment: false,
    firstSnapshot: false, models: false, entityPending: 0, world: false, modelFailure: false,
    label: STRINGS.loadingConnecting
  },
  states: {
    loading: {
      after: {
        [LOADING_FALLBACK_MS]: [{ guard: hasContent, target: 'ready' }, { target: 'loading' }],
        [LOADING_HARD_MS]: [{ guard: notModelFailure, target: 'ready' }, { target: 'loading' }]
      },
      on: {
        MODEL_LOAD_FAILED: { actions: assign({ modelFailure: true, label: ({ event }) => STRINGS.connectionFailed(event.reasonCode || 'model load failed') }) },
        ASSETS_DONE: { actions: assign({ assets: true, label: () => STRINGS.loadingEnvironment }), target: 'checking' },
        WORLD_CONFIG: { actions: assign({ worldConfig: true, label: () => STRINGS.loadingSyncingServer }), target: 'checking' },
        ENVIRONMENT_DONE: { actions: assign({ environment: true }), target: 'checking' },
        FIRST_SNAPSHOT: { actions: assign({ firstSnapshot: true }), target: 'checking' },
        MODELS_DONE: { actions: assign({ models: true }), target: 'checking' },
        SET_PENDING: { actions: assign({ entityPending: ({ event }) => event.count ?? 0 }), target: 'checking' },
        ENTITY_LOADED: { actions: assign({ entityPending: ({ context }) => Math.max(0, context.entityPending - 1) }), target: 'checking' },
        WORLD_EXISTS: { actions: assign({ world: true }) },
        FORCE_READY: [{ guard: notModelFailure, target: 'ready' }, { target: 'loading' }]
      }
    },
    checking: {
      always: [
        { guard: allDone, target: 'ready' },
        { target: 'loading' }
      ],
      after: {
        [LOADING_FALLBACK_MS]: [{ guard: hasContent, target: 'ready' }, { target: 'loading' }],
        [LOADING_HARD_MS]: [{ guard: notModelFailure, target: 'ready' }, { target: 'loading' }]
      },
      on: {
        WORLD_EXISTS: { actions: assign({ world: true }) },
        MODEL_LOAD_FAILED: { actions: assign({ modelFailure: true, label: ({ event }) => STRINGS.connectionFailed(event.reasonCode || 'model load failed') }), target: 'loading' }
      }
    },
    ready: {
      entry: assign({ label: () => STRINGS.loadingStartingGame }),
      always: { guard: worldExists, target: 'worldReady' },
      on: {
        WORLD_EXISTS: { actions: assign({ world: true }) }
      }
    },
    worldReady: {
      entry: assign({ label: () => STRINGS.loadingStartingGame }),
      type: 'final'
    }
  }
})

export function createLoadingStateMachine() {
  const actor = createActor(loadingMachine)
  actor.start()
  const snap = () => actor.getSnapshot()
  return {
    actor,
    get state() { return snap().value },
    get context() { return snap().context },
    get label() { return snap().context.label },
    get inputsDone() { return snap().matches('ready') || snap().matches('worldReady') },
    get isReady() { return snap().status === 'done' || snap().value === 'worldReady' },
    get isWorldReady() { return snap().status === 'done' || snap().value === 'worldReady' },
    get progress() {
      const c = snap().context
      const done = STEPS.filter((s) => c[s]).length + (c.entityPending <= 0 ? 1 : 0) + (c.world ? 1 : 0)
      return Math.min(1, done / (STEPS.length + 2))
    },
    send: (type, extra) => actor.send(typeof type === 'string' ? { type, ...extra } : type),
    matches: (s) => snap().matches(s),
    subscribe: (fn) => actor.subscribe((s) => fn(s.value, s))
  }
}
