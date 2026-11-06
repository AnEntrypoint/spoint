import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

console.log = console.error
await installSpecifierHooks()
const { setup } = (await import('../apps/character-animator/index.js')).default

const calls = []
const system = {
  initializeController() {},
  setRagdollPlan(plan) { calls.push(plan) },
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

const plan = { strengths: { head: 0.2, chest: 0.5 }, active: true }
appCtx.state._ragdoll = plan
animator.tick(1 / 60)
animator.tick(1 / 60)
assert.equal(calls.length, 1, 'the same plan is applied once, not every tick')
assert.deepEqual(calls[0], plan, 'the plan read from state is passed to setRagdollPlan')

appCtx.state._ragdoll = { strengths: { head: 0 }, active: false }
animator.tick(1 / 60)
assert.equal(calls.length, 2, 'a changed plan is applied again')
process.stdout.write('RESULT: PASS character-animator reads state._ragdoll each tick and applies a new plan to its animation system once per change\n')
