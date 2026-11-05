#!/usr/bin/env node
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileInputActions, actionsFor, touchActionsFor, InputActionError } from '../src/client/InputActions.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
function expect(label, ok) {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
}
function refusedWith(actions, reasonCode) {
  try {
    compileInputActions(actions)
    return false
  } catch (err) {
    return err instanceof InputActionError && err.reasonCode === reasonCode
  }
}

const compiled = compileInputActions({
  fire: { keys: ['Space'], mouse: 'left', gamepad: 'rt', touch: { button: true, label: 'Fire', slot: 1, gesture: 'press' } },
  jump: { keys: ['KeyW', 'Space'], gamepad: 'a', activeOn: 'keydown', touch: { slot: 2 } },
  sprint: { keys: ['ShiftLeft'], modifiers: ['ctrl'], activeOn: 'hold', gamepad: 'Gamepad:Button12' },
})

expect('key lookup returns every action bound to a code', JSON.stringify(actionsFor(compiled, 'key', 'Space')) === '["fire","jump"]')
expect('mouse lookup resolves a named button', JSON.stringify(actionsFor(compiled, 'mouse', 'left')) === '["fire"]')
expect('gamepad lookup accepts indexed buttons', JSON.stringify(actionsFor(compiled, 'gamepad', 'Gamepad:Button12')) === '["sprint"]')
expect('unbound code resolves to no actions', actionsFor(compiled, 'key', 'KeyQ').length === 0)
expect('touch slot resolves to its action', JSON.stringify(touchActionsFor(compiled, 1)) === '["fire"]')
expect('touch defaults gesture to tap', compiled.actions.find((a) => a.name === 'jump').touch.gesture === 'tap')
expect('touch button flag carries through', compiled.actions.find((a) => a.name === 'fire').touch.button === true)
expect('compiled table is frozen', Object.isFrozen(compiled))

expect('unknown field is refused', refusedWith({ a: { keys: ['KeyA'], hold: true } }, 'unknown-field'))
expect('unknown mouse button is refused', refusedWith({ a: { mouse: 'mouse9' } }, 'bad-mouse'))
expect('unknown gamepad button is refused', refusedWith({ a: { gamepad: 'turbo' } }, 'bad-gamepad'))
expect('bad activeOn is refused', refusedWith({ a: { keys: ['KeyA'], activeOn: 'tap' } }, 'bad-active-on'))
expect('empty key string is refused', refusedWith({ a: { keys: [''] } }, 'bad-list'))
expect('touch slot out of range is refused', refusedWith({ a: { keys: ['KeyA'], touch: { slot: 5 } } }, 'bad-touch-slot'))
expect('touch gesture outside set is refused', refusedWith({ a: { keys: ['KeyA'], touch: { gesture: 'swipe' } } }, 'bad-touch-gesture'))
expect('action with no binding is refused', refusedWith({ a: { modifiers: ['ctrl'] } }, 'unbound-action'))
expect('two actions on one touch slot are refused', refusedWith({
  a: { keys: ['KeyA'], touch: { slot: 3 } },
  b: { keys: ['KeyB'], touch: { slot: 3 } },
}, 'touch-slot-taken'))
expect('non-object actions are refused', refusedWith([], 'bad-actions'))
expect('non-object action is refused', refusedWith({ a: 'KeyA' }, 'bad-action'))

if (failures > 0) {
  console.log(`RESULT: FAIL (${failures} checks failed) root=${REPO_ROOT}`)
  process.exit(1)
}
console.log(`RESULT: PASS root=${REPO_ROOT}`)
