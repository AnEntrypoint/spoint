#!/usr/bin/env node
// Witness for csproto-2: msgName/isUnreliable refuse an unregistered message id with a coded RangeError;
// registered ids answer their name and boolean; isRegisteredMessage answers a boolean for both.
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const M = await import(resolve(ROOT, 'src/protocol/MessageTypes.js'))
const UNKNOWN = 0xdead
const failures = []
const expect = (label, ok, got) => { if (!ok) failures.push(label + ' got=' + String(got)) ; console.log((ok ? 'ok   ' : 'FAIL ') + label + ' got=' + String(got)) }

expect('msgName(HEARTBEAT) === "HEARTBEAT"', M.msgName(M.MSG.HEARTBEAT) === 'HEARTBEAT', M.msgName(M.MSG.HEARTBEAT))
expect('isUnreliable(HEARTBEAT) === true', M.isUnreliable(M.MSG.HEARTBEAT) === true, M.isUnreliable(M.MSG.HEARTBEAT))
expect('isRegisteredMessage(HEARTBEAT) === true', M.isRegisteredMessage(M.MSG.HEARTBEAT) === true, M.isRegisteredMessage(M.MSG.HEARTBEAT))
expect('isRegisteredMessage(0xdead) === false', M.isRegisteredMessage(UNKNOWN) === false, M.isRegisteredMessage(UNKNOWN))

for (const [name, fn] of [['msgName', M.msgName], ['isUnreliable', M.isUnreliable]]) {
  let thrown = null
  try { fn(UNKNOWN) } catch (e) { thrown = e }
  expect(name + '(0xdead) throws', thrown instanceof RangeError, thrown && thrown.message)
  expect(name + '(0xdead) reasonCode', thrown && thrown.reasonCode === 'unknown-message-id', thrown && thrown.reasonCode)
}

const harness = await import('node:fs/promises').then(f => f.readFile(resolve(ROOT, 'scripts/chart-reanchor-wire-harness.mjs'), 'utf8'))
expect('harness line guards with isRegisteredMessage before isUnreliable', /isRegisteredMessage\(type\) && !isUnreliable\(type\)/.test(harness), harness.includes('isRegisteredMessage(type) && !isUnreliable(type)'))

console.log(failures.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL ' + failures.length)
process.exit(failures.length === 0 ? 0 : 1)
