import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { PhysicsNetworkClient } = await import(pathToFileURL(path.join(ROOT, 'src/client/PhysicsNetworkClient.js')).href)

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const URL_UNDER_TEST = 'ws://127.0.0.1:9/ws'
const sockets = []
class FakeSocket {
  constructor(url) { this.url = url; this.readyState = 0; sockets.push(this) }
  send() {}
  close() { this.closed = true }
}
const newClient = () => new PhysicsNetworkClient({ url: URL_UNDER_TEST, autoMigrate: false, webTransport: { enabled: false } })
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const refusalOf = async (promise) => { try { await promise; return null } catch (e) { return e } }

globalThis.WebSocket = class { constructor() { throw new Error('no socket in this runtime') } }
const unavailable = await refusalOf(newClient().connect())
check('a runtime with no usable socket rejects with TransportConnectError websocket-unavailable', unavailable?.name === 'TransportConnectError' && unavailable?.reason === 'websocket-unavailable', `name=${unavailable?.name} reason=${unavailable?.reason}`)
check('the refusal names the url and carries the constructor message', unavailable?.url === URL_UNDER_TEST && String(unavailable?.message).includes('no socket in this runtime'), unavailable?.message)

globalThis.WebSocket = FakeSocket
const errored = newClient().connect()
await settle()
sockets.at(-1).onerror({ message: 'refused by peer' })
const erroredErr = await refusalOf(errored)
check('a socket error before open rejects with websocket-error and the event message', erroredErr?.name === 'TransportConnectError' && erroredErr?.reason === 'websocket-error' && String(erroredErr?.message).includes('refused by peer'), `reason=${erroredErr?.reason}`)

const closed = newClient().connect()
await settle()
sockets.at(-1).onclose({ code: 1006 })
const closedErr = await refusalOf(closed)
check('a close before open rejects with websocket-closed-before-open and the close code', closedErr?.name === 'TransportConnectError' && closedErr?.reason === 'websocket-closed-before-open' && String(closedErr?.message).includes('close code 1006'), `reason=${closedErr?.reason}`)

const racer = newClient()
const racerStart = sockets.length
const first = racer.connect()
const second = racer.connect()
await settle()
const racerSockets = sockets.length - racerStart
const staleSocket = sockets[racerStart]
staleSocket.onopen()
const supersededErr = await refusalOf(first)
check('an open for a generation that a newer connect replaced rejects with connect-superseded', supersededErr?.name === 'TransportConnectError' && supersededErr?.reason === 'connect-superseded', `reason=${supersededErr?.reason}`)
check('the superseded socket is closed and each connect opened its own socket', staleSocket.closed === true && racerSockets === 2, `closed=${staleSocket.closed} racerSockets=${racerSockets}`)

const live = newClient()
const opened = live.connect()
await settle()
let openedErr = null
try { sockets.at(-1).onopen() } catch (e) { openedErr = e }
const openedOk = (await refusalOf(opened)) === null
check('the current generation opens without a TransportConnectError', openedOk && openedErr === null, openedErr && openedErr.message)
live.disconnect()

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
}
console.log('RESULT: PASS PhysicsNetworkClient.connect rejects with a TransportConnectError carrying a stable reason for websocket-unavailable, websocket-error, websocket-closed-before-open and connect-superseded, and resolves for the current generation')
await exitAfterQuiesce(0)
