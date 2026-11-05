import assert from 'node:assert/strict'
import { settleTrade, createTradeBook } from '../src/behaviours/trade.js'

const proposer = Object.freeze({ id: 'alice', items: Object.freeze({ apple: 2 }), currency: 10 })
const responder = Object.freeze({ id: 'bob', items: Object.freeze({ coin: 3 }), currency: 5 })
const offer = { items: { apple: 1 }, currency: 2 }
const request = { items: { coin: 2 }, currency: 3 }

const settled = settleTrade({ proposer, responder, offer, request })
assert.equal(settled.ok, true)
assert.deepEqual(settled.proposer, { id: 'alice', items: { apple: 1, coin: 2 }, currency: 11 })
assert.deepEqual(settled.responder, { id: 'bob', items: { coin: 1, apple: 1 }, currency: 4 })
assert.deepEqual(proposer.items, { apple: 2 }, 'the kernel must not mutate the proposer')
assert.deepEqual(responder.items, { coin: 3 }, 'the kernel must not mutate the responder')

for (const [call, code] of [
  [() => settleTrade({ proposer, responder: { ...responder, id: 'alice' }, offer, request }), 'trade-same-party'],
  [() => settleTrade({ proposer, responder, offer: { items: { apple: 99 } }, request }), 'trade-not-held'],
  [() => settleTrade({ proposer, responder, offer, request, withdrawn: true }), 'trade-withdrawn'],
  [() => settleTrade({ proposer: { ...proposer, id: '' }, responder, offer, request }), 'trade-unknown-target'],
  [() => settleTrade({ proposer, responder, offer: { items: { apple: -1 } }, request }), 'trade-invalid-quantity'],
]) {
  assert.throws(call, e => e.reasonCode === code, `expected refusal code ${code}`)
}

const wallets = new Map([
  ['alice', { id: 'alice', items: { apple: 2 }, currency: 10 }],
  ['bob', { id: 'bob', items: { coin: 3 }, currency: 5 }],
])
const commits = []
const book = createTradeBook(
  id => wallets.get(id),
  result => { commits.push(result); wallets.set(result.proposer.id, result.proposer); wallets.set(result.responder.id, result.responder) },
)

book.offer({ id: 't1', proposerId: 'alice', responderId: 'bob', offer, request })
assert.equal(book.accept({ id: 't1', by: 'alice' }).settled, false)
assert.equal(commits.length, 0, 'one acceptance must not settle')
assert.equal(book.accept({ id: 't1', by: 'bob' }).settled, true)
assert.equal(commits.length, 1, 'both acceptances settle exactly once')
assert.equal(book.status('t1').settled, true)
assert.deepEqual(wallets.get('alice').items, { apple: 1, coin: 2 })
assert.deepEqual(wallets.get('bob').items, { coin: 1, apple: 1 })
assert.throws(() => book.accept({ id: 't1', by: 'alice' }), e => e.reasonCode === 'trade-already-settled')

book.offer({ id: 't2', proposerId: 'alice', responderId: 'bob', offer: { items: { apple: 1 } }, request: { items: { coin: 99 } } })
book.accept({ id: 't2', by: 'alice' })
assert.throws(() => book.accept({ id: 't2', by: 'bob' }), e => e.reasonCode === 'trade-not-held')
assert.equal(book.status('t2').settled, false, 'a refused settlement must leave the trade open')
assert.equal(commits.length, 1, 'a refused settlement must not commit')

book.offer({ id: 't3', proposerId: 'alice', responderId: 'bob', offer, request })
book.withdraw({ id: 't3', by: 'bob' })
assert.throws(() => book.accept({ id: 't3', by: 'alice' }), e => e.reasonCode === 'trade-withdrawn')
assert.throws(() => book.accept({ id: 't3', by: 'eve' }), e => e.reasonCode === 'trade-withdrawn')
assert.throws(() => book.accept({ id: 'missing', by: 'alice' }), e => e.reasonCode === 'trade-unknown-trade')
assert.throws(() => book.offer({ id: 't4', proposerId: 'alice', responderId: 'alice', offer, request }), e => e.reasonCode === 'trade-same-party')

console.log('RESULT: PASS two-sided trade settles atomically only after both acceptances, never mutates inputs, and refuses by code')
