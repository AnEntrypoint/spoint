import { evalInRealm } from '../src/debug/EvalDoor.js'

let failures = 0
const expect = (label, pass, detail = '') => {
  if (!pass) failures += 1
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${pass ? '' : ` ${detail}`}`)
}

const realm = { answer: 42, nested: { list: [1, 2] } }

const expr = await evalInRealm('return realm.answer * 2', realm)
expect('returns a value from the realm', expr.ok === true && expr.value === 84, JSON.stringify(expr))

const awaited = await evalInRealm('return await Promise.resolve(realm.nested.list.length)', realm)
expect('awaits an async body', awaited.ok === true && awaited.value === 2, JSON.stringify(awaited))

const undef = await evalInRealm('return undefined', realm)
expect('undefined serialises to null', undef.ok === true && undef.value === null, JSON.stringify(undef))

const thrown = await evalInRealm('throw new TypeError("boom")', realm)
expect('a throw is reported, not raised', thrown.ok === false && thrown.error.name === 'TypeError' && thrown.error.message === 'boom', JSON.stringify(thrown))

const syntax = await evalInRealm('return (', realm)
expect('a syntax error is reported as ok:false', syntax.ok === false && syntax.error.name === 'SyntaxError', JSON.stringify(syntax))

const cyclic = { name: 'loop' }
cyclic.self = cyclic
const circ = await evalInRealm('return realm.c', { c: cyclic })
expect('a cycle is cut with a marker', circ.ok === true && circ.value.self === '[circular]', JSON.stringify(circ))

const nonFinite = await evalInRealm('return [NaN, Infinity, 1n]', realm)
expect('non-finite numbers and bigints stay JSON-safe', nonFinite.ok === true && nonFinite.value[0] === 'NaN' && nonFinite.value[1] === 'Infinity' && nonFinite.value[2] === '1', JSON.stringify(nonFinite))

const fn = await evalInRealm('return realm.fn', { fn() {} })
expect('a function is named, not serialised', fn.ok === true && fn.value === '[function]', JSON.stringify(fn))

if (failures > 0) {
  console.log(`RESULT: FAIL (${failures} failed)`)
  process.exit(1)
}
console.log('RESULT: PASS')
