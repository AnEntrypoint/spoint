// Dual import: same definition unit-testable under node and runnable in browser.
const _isNode = typeof process !== 'undefined' && process.versions?.node
const { createMachine, createActor, assign } = await import(_isNode ? 'xstate' : '/node_modules/xstate/dist/xstate.esm.js')
import { STRINGS } from './strings.js'

const STEPS = ['assets', 'environment', 'firstSnapshot', 'models']

const allDone = ({ context }) => STEPS.every((s) => context[s]) && context.entityPending <= 0

// Soft fallback must gate on real content (firstSnapshot+environment): forcing ready on a bare timer would lift the curtain onto an empty scene while a singleplayer worker is still booting.
const hasContent = ({ context }) => context.firstSnapshot && context.environment

export const LOADING_FALLBACK_MS = 10000
export const LOADING_HARD_MS = 45000

export const loadingMachine = createMachine({
  id: 'loading',
  initial: 'loading',
  context: {
    assets: false, worldConfig: false, environment: false,
    firstSnapshot: false, models: false, entityPending: 0,
    label: STRINGS.loadingConnecting
  },
  states: {
    loading: {
      after: {
        [LOADING_FALLBACK_MS]: [{ guard: hasContent, target: 'ready' }, { target: 'loading' }],
        [LOADING_HARD_MS]: { target: 'ready' }
      },
      on: {
        ASSETS_DONE: { actions: assign({ assets: true, label: () => STRINGS.loadingEnvironment }), target: 'checking' },
        WORLD_CONFIG: { actions: assign({ worldConfig: true, label: () => STRINGS.loadingSyncingServer }), target: 'checking' },
        ENVIRONMENT_DONE: { actions: assign({ environment: true }), target: 'checking' },
        FIRST_SNAPSHOT: { actions: assign({ firstSnapshot: true }), target: 'checking' },
        MODELS_DONE: { actions: assign({ models: true }), target: 'checking' },
        SET_PENDING: { actions: assign({ entityPending: ({ event }) => event.count ?? 0 }), target: 'checking' },
        ENTITY_LOADED: { actions: assign({ entityPending: ({ context }) => Math.max(0, context.entityPending - 1) }), target: 'checking' },
        FORCE_READY: 'ready'
      }
    },
    checking: {
      always: [
        { guard: allDone, target: 'ready' },
        { target: 'loading' }
      ],
      after: {
        [LOADING_FALLBACK_MS]: [{ guard: hasContent, target: 'ready' }, { target: 'loading' }],
        [LOADING_HARD_MS]: { target: 'ready' }
      }
    },
    ready: {
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
    get isReady() { return snap().status === 'done' || snap().value === 'ready' },
    get progress() {
      const c = snap().context
      const done = STEPS.filter((s) => c[s]).length + (c.entityPending <= 0 ? 1 : 0)
      return Math.min(1, done / (STEPS.length + 1))
    },
    send: (type, extra) => actor.send(typeof type === 'string' ? { type, ...extra } : type),
    matches: (s) => snap().matches(s),
    subscribe: (fn) => actor.subscribe((s) => fn(s.value, s))
  }
}
