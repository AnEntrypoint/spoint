import { achievements, AchievementError } from '../src/apps/AppGameplay.js'

let failures = 0
const expect = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` ${detail}` : ''}`)
}
const refusal = (fn) => {
  try { fn(); return null } catch (e) { return e }
}

const stores = new Map()
const ctx = {
  persisted(key, initial) {
    if (!stores.has(key)) {
      const box = { value: initial, saves: 0 }
      stores.set(key, box)
      return { ready: Promise.resolve(), get value() { return box.value }, set value(v) { box.value = v }, save() { box.saves += 1 }, flush: async () => {} }
    }
    const box = stores.get(key)
    return { ready: Promise.resolve(), get value() { return box.value }, set value(v) { box.value = v }, save() { box.saves += 1 }, flush: async () => {} }
  }
}

const defs = {
  first_blood: { title: 'First Blood', description: 'Defeat one enemy' },
  flagless: { title: 'No Description' }
}
const board = achievements(ctx, defs)

expect('declared defs are frozen and indexed', board.defs.size === 2 && Object.isFrozen(board.defs.get('first_blood')))
expect('missing description defaults to empty string only when absent', board.defs.get('flagless').description === '')

const first = board.unlock('p1', 'first_blood')
expect('first unlock is recorded', first.unlocked === true && first.def.title === 'First Blood')
const again = board.unlock('p1', 'first_blood')
expect('repeat unlock is not re-recorded', again.unlocked === false)
expect('unlocked lists the scope ids', JSON.stringify(board.unlocked('p1')) === '["first_blood"]')
expect('scopes are independent', board.unlocked('p2').length === 0)
expect('unlock persists through the store', stores.get('achievements').saves === 1)

const unknown = refusal(() => board.unlock('p1', 'nope'))
expect('unknown id refused with a reason code', unknown instanceof AchievementError && unknown.reasonCode === 'unknown-achievement')

const notObject = refusal(() => achievements(ctx, []))
expect('array defs refused', notObject instanceof AchievementError && notObject.reasonCode === 'defs-not-object')

const noTitle = refusal(() => achievements(ctx, { x: { description: 'no title' } }))
expect('missing title refused with the id', noTitle instanceof AchievementError && noTitle.reasonCode === 'title-missing' && noTitle.message.endsWith(' x'))

const badDesc = refusal(() => achievements(ctx, { y: { title: 'T', description: 3 } }))
expect('non-string description refused', badDesc instanceof AchievementError && badDesc.reasonCode === 'description-not-string')

if (failures > 0) {
  console.log(`RESULT: FAIL (${failures} checks failed)`)
  process.exit(1)
}
console.log('RESULT: PASS')
