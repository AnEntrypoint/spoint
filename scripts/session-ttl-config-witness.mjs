import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionStore, resolveSessionTtl } from '../src/connection/SessionStore.js'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const refusalOf = value => {
  try {
    new SessionStore({ ttl: value })
    return null
  } catch (err) {
    return err
  }
}

check('an absent ttl takes the 30 s default', new SessionStore({}).ttl === 30000 && resolveSessionTtl(undefined) === 30000)

for (const bad of [0, -1, NaN, Infinity, -Infinity, '5000', null, true]) {
  const err = refusalOf(bad)
  check(`ttl ${String(bad)} is refused at config time`, err instanceof RangeError && /ttl must be a positive finite number/.test(err.message), err ? err.message : 'no error thrown')
}

check('a positive ttl is kept as given', new SessionStore({ ttl: 1 }).ttl === 1 && new SessionStore({ ttl: 60000 }).ttl === 60000)

const serverSource = await readFile(resolve(SDK_ROOT, 'src/sdk/server.js'), 'utf8')
const workerSource = await readFile(resolve(SDK_ROOT, 'src/sdk/WorkerEntry.js'), 'utf8')
check('server.js passes config.sessionTTL through without a || fallback', serverSource.includes('config.sessionTTL === undefined ? 60000 : config.sessionTTL') && !serverSource.includes('config.sessionTTL ||'))
check('WorkerEntry.js builds its session store with a fixed positive ttl', workerSource.includes('new SessionStore({ ttl: 60000 })'))

const failed = checks.filter(c => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map(c => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log(`RESULT: PASS SessionStore refuses a zero, negative, non-finite or non-number ttl at config time with a RangeError, keeps the 30 s default for an absent ttl, and server.js no longer falls back to its default for a configured value (${checks.length} checks)`)
  await exitAfterQuiesce(0)
}
