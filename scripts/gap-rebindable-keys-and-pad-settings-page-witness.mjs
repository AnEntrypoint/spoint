#!/usr/bin/env node
import { createKeyBindings, DEFAULT_KEY_BINDINGS, DEFAULT_PAD_BINDINGS, KEY_BINDINGS_STORAGE_KEY } from '../client/core/keybindings.js'

const failures = []
let checks = 0
function expect(name, ok) {
  checks += 1
  if (ok !== true) failures.push(name)
  console.log(`${ok === true ? 'ok  ' : 'FAIL'} ${name}`)
}
function throwsReason(fn, reasonCode) {
  try {
    fn()
    return false
  } catch (e) {
    return e && e.reasonCode === reasonCode
  }
}
function memoryStorage(seed = null) {
  const map = new Map()
  if (seed !== null) map.set(KEY_BINDINGS_STORAGE_KEY, seed)
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    raw: () => map.get(KEY_BINDINGS_STORAGE_KEY) ?? null,
  }
}

const kb = createKeyBindings()
expect('defaults: forward is KeyW', JSON.stringify(kb.keysFor('forward')) === '["KeyW"]')
expect('defaults: KeyW maps to forward', kb.actionForKey('KeyW') === 'forward')
expect('defaults: jump pad button 0', JSON.stringify(kb.padFor('jump')) === '[0]')
expect('returned lists are copies', (() => { const l = kb.keysFor('forward'); l.push('X'); return kb.keysFor('forward').length === 1 })())

expect('rebind jump to KeyJ', JSON.stringify(kb.rebindKeys('jump', ['KeyJ'])) === '["KeyJ"]')
expect('rebound key resolves to action', kb.actionForKey('KeyJ') === 'jump')
expect('old key no longer resolves', kb.actionForKey('Space') === null)
expect('rebind to a key bound elsewhere is refused', throwsReason(() => kb.rebindKeys('jump', ['KeyW']), 'conflict'))
expect('refused rebind leaves the table unchanged', JSON.stringify(kb.keysFor('jump')) === '["KeyJ"]')
expect('unknown action is refused', throwsReason(() => kb.rebindKeys('fly', ['KeyF']), 'unknown-action'))
expect('empty key list is refused', throwsReason(() => kb.rebindKeys('jump', []), 'bad-keys'))
expect('non-string key code is refused', throwsReason(() => kb.rebindKeys('jump', [3]), 'bad-keys'))
expect('pad button out of range is refused', throwsReason(() => kb.rebindPad('jump', [99]), 'bad-pad'))
expect('pad button non-integer is refused', throwsReason(() => kb.rebindPad('jump', ['0']), 'bad-pad'))
expect('pad rebind to a button bound elsewhere is refused', throwsReason(() => kb.rebindPad('jump', [2]), 'conflict'))
expect('pad rebind to free button succeeds', JSON.stringify(kb.rebindPad('jump', [1])) === '[1]')
expect('pad button resolves to action', kb.actionForPad(1) === 'jump')

kb.resetAll()
expect('resetAll restores key defaults', JSON.stringify(kb.keysFor('jump')) === JSON.stringify(DEFAULT_KEY_BINDINGS.jump))
expect('resetAll restores pad defaults', JSON.stringify(kb.padFor('jump')) === JSON.stringify(DEFAULT_PAD_BINDINGS.jump))

const store = memoryStorage()
const saver = createKeyBindings({ storage: store })
saver.rebindKeys('interact', ['KeyF'])
expect('save writes a record', saver.save() === true && store.raw() !== null)
const reloaded = createKeyBindings({ storage: store })
expect('a saved rebinding survives reload', JSON.stringify(reloaded.keysFor('interact')) === '["KeyF"]')
expect('untouched actions keep defaults after reload', JSON.stringify(reloaded.keysFor('back')) === '["KeyS"]')
expect('save without storage reports false', createKeyBindings().save() === false)

expect('a stored record naming an unknown action is refused at load', (() => {
  try {
    createKeyBindings({ storage: memoryStorage(JSON.stringify({ keys: { fly: ['KeyF'] } })) })
    return false
  } catch (e) {
    return e.reasonCode === 'unknown-action'
  }
})())
expect('a stored record with a bad pad button is refused at load', (() => {
  try {
    createKeyBindings({ storage: memoryStorage(JSON.stringify({ pad: { jump: [-1] } })) })
    return false
  } catch (e) {
    return e.reasonCode === 'bad-pad'
  }
})())
expect('a stored record that is not JSON throws', (() => {
  try {
    createKeyBindings({ storage: memoryStorage('{nope') })
    return false
  } catch (e) {
    return e instanceof SyntaxError
  }
})())
expect('a stored record that is an array is refused', throwsReason(() => createKeyBindings({ storage: memoryStorage('[]') }), 'bad-record'))

const snap = reloaded.snapshot()
snap.keys.forward.push('Extra')
expect('snapshot is a copy', reloaded.keysFor('forward').length === 1)

console.log(`checks=${checks} failures=${failures.length}`)
if (failures.length > 0) {
  console.log(`RESULT: FAIL ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('RESULT: PASS')
