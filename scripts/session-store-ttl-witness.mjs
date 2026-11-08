import { SessionStore } from '../src/connection/SessionStore.js'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const TTL = 5000
const realNow = Date.now
let clock = 1_000_000
Date.now = () => clock

const store = new SessionStore({ ttl: TTL })

check('a store with no TTL option defaults to 30 s', new SessionStore().ttl === 30000, `ttl ${new SessionStore().ttl}`)

const exact = store.create(1, {})
clock += TTL
check('a session read exactly at its TTL after the last touch is still live', store.get(exact) !== null)

clock = store.sessions.get(exact).lastTouched + TTL + 1
const late = store.get(exact)
check('a session read one millisecond past its TTL is expired and removed', late === null && store.getActiveCount() === 0, `active ${store.getActiveCount()}`)

const touched = store.create(2, {})
const createdAt = store.sessions.get(touched).lastTouched
clock = createdAt + TTL - 1
store.update(touched, {})
clock = createdAt + 2 * TTL - 2
check('an update one millisecond before the TTL re-arms it, so the session outlives the original deadline', store.get(touched) !== null)

const pinned = store.create(3, {})
store.pin(pinned)
clock += 10 * TTL
check('a pinned session does not expire on access', store.get(pinned) !== null)

store.release(pinned)
clock += TTL + 1
check('releasing a pinned session restarts its TTL from the release', store.get(pinned) === null)

Date.now = realNow
const short = new SessionStore({ ttl: 40 })
short.create(4, {})
await new Promise(resolve => setTimeout(resolve, 150))
check('the expiry timer removes a session at its TTL with no access', short.getActiveCount() === 0, `active ${short.getActiveCount()}`)

store.destroyAll()
short.destroyAll()

const failed = checks.filter(c => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map(c => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log(`RESULT: PASS SessionStore expires a session strictly after its TTL from the last touch, re-arms it on each touch, keeps a pinned session, and removes it on its timer (${checks.length} checks)`)
  await exitAfterQuiesce(0)
}
