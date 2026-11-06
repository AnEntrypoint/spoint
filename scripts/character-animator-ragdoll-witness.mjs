import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

console.log = console.error
await installSpecifierHooks()
const { setup } = (await import('../apps/character-animator/index.js')).default
const { parseRagdollActivation } = await import('../src/animation/ragdollActivation.js')

const { applyRagdollActivation } = await import('../src/animation/ragdollActivation.js')
const calls = []
const pose = { setAll() {}, setStrength() {} }
const system = {
  initializeController() {},
  setRagdollPlan(plan) {
    applyRagdollActivation(pose, plan)
    calls.push(plan)
  },
  update() {},
  playAnimation() {},
  setIKTarget() {},
  dispose() {},
}
const appCtx = {
  state: {},
  gltfLoader: { loadAsync: async () => ({ scene: {}, animations: [] }) },
  createAnimationSystem: () => system,
}
const world = { onBeforeUnload: [] }
const scene = { add() {}, remove() {} }
const animator = await setup(scene, world, appCtx)
await animator.loadCharacter('model.glb')

animator.tick(1 / 60)
assert.equal(calls.length, 0, 'no ragdoll plan means nothing is applied')

const plan = parseRagdollActivation({ bones: { head: { strength: 0.2 }, chest: 0.5 } })
appCtx.state._ragdoll = plan
animator.tick(1 / 60)
animator.tick(1 / 60)
assert.equal(calls.length, 1, 'the same plan is applied once, not every tick')
assert.deepEqual(calls[0], plan, 'the plan read from state is passed to setRagdollPlan')
assert.equal(animator.getRagdollRefusal(), null, 'a valid plan is not refused')

const off = parseRagdollActivation({ bones: { head: 0 }, active: false })
appCtx.state._ragdoll = off
animator.tick(1 / 60)
assert.equal(calls.length, 2, 'a changed plan is applied again')

const refused = [
  [{ strengths: { head: 2 }, explicit: ['head'], active: true }, 'strength-invalid'],
  [{ strengths: { tail: 0.5 }, explicit: ['tail'], active: true }, 'unknown-bone'],
  [{ strengths: { head: 0.5 }, explicit: 'head', active: true }, 'plan-invalid'],
  ['not a plan', 'plan-invalid'],
]
for (const [bad, code] of refused) {
  appCtx.state._ragdoll = bad
  animator.tick(1 / 60)
  assert.equal(animator.getRagdollRefusal(), code, `a malformed plan refuses with ${code}`)
  assert.equal(calls.length, 2, 'a refused plan is not handed to the animation system')
}

appCtx.state._ragdoll = parseRagdollActivation({ bones: { chest: 0.25 } })
animator.tick(1 / 60)
assert.equal(animator.getRagdollRefusal(), null, 'a valid plan after a refusal clears the refusal')
assert.equal(calls.length, 3, 'the valid plan after a refusal is applied')
process.stdout.write('RESULT: PASS character-animator reads state._ragdoll each tick, applies a new plan once per change, and refuses a malformed plan with a named reason code without handing it to the animation system\n')
