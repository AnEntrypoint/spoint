// Expected values are literals taken from the module contract, not from its output:
//   - WebSocket readyState: CONNECTING 0, OPEN 1, CLOSING 2, CLOSED 3 (the module tests readyState === 1 for open).
//   - sendUnreliable drops a frame only when socket.bufferedAmount is strictly above 65536 bytes
//     (64 KiB, the module's UNRELIABLE_BACKPRESSURE_DROP_THRESHOLD_BYTES).
//   - One enumerated lifecycle state ('connecting'|'open'|'closed') is the single source for both
//     isOpen and the send() gate, so the two can never disagree. Events and the socket's own
//     readyState move it: a socket that has left readyState OPEN is 'closed' (a half-close is
//     refused before its 'close' event arrives), and a transient 'error' on a live socket leaves
//     it 'open'.

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3
const DROP_ABOVE_BYTES = 65536

const here = dirname(fileURLToPath(import.meta.url))
const defaultModule = resolve(here, '..', 'src', 'transport', 'WebSocketTransport.js')
const moduleArg = process.argv.slice(2).find((arg) => arg.startsWith('--module='))
const modulePath = moduleArg === undefined ? defaultModule : resolve(moduleArg.slice('--module='.length))

function makeFakeSocket(readyState) {
  const handlers = new Map()
  const socket = {
    readyState,
    bufferedAmount: 0,
    sent: [],
    closeCalls: 0,
    throwOnSend: false,
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
      return socket
    },
    send(data) {
      if (socket.throwOnSend) throw new Error('fake socket send failure')
      socket.sent.push(data)
    },
    close() {
      socket.closeCalls += 1
    },
    fire(event, ...args) {
      for (const fn of handlers.get(event) ?? []) fn(...args)
    },
  }
  return socket
}

function build(WebSocketTransport, readyState) {
  const socket = makeFakeSocket(readyState)
  const transport = new WebSocketTransport(socket)
  const seen = { message: [], open: [], close: [], error: [] }
  for (const name of Object.keys(seen)) {
    transport.on(name, (...args) => seen[name].push(args))
  }
  return { socket, transport, seen }
}

function checks(WebSocketTransport) {
  const frame = 'frame-1'
  const errValue = new Error('fake transport error')
  return [
    {
      id: 'C01',
      label: 'transport type',
      run() {
        const { transport } = build(WebSocketTransport, OPEN)
        return { expected: 'websocket', actual: transport.type }
      },
    },
    {
      id: 'C02',
      label: 'ready on OPEN socket',
      run() {
        const { transport } = build(WebSocketTransport, OPEN)
        return { expected: true, actual: transport.ready }
      },
    },
    {
      id: 'C03',
      label: 'not ready on CONNECTING socket',
      run() {
        const { transport } = build(WebSocketTransport, CONNECTING)
        return { expected: false, actual: transport.ready }
      },
    },
    {
      id: 'C04',
      label: 'open event makes a CONNECTING transport ready and emits open once',
      run() {
        const { socket, transport, seen } = build(WebSocketTransport, CONNECTING)
        socket.readyState = OPEN
        socket.fire('open')
        return {
          expected: 'ready=true opens=1',
          actual: `ready=${transport.ready} opens=${seen.open.length}`,
        }
      },
    },
    {
      id: 'C05',
      label: 'the lifecycle closes when the socket leaves readyState OPEN, half-close included',
      run() {
        const { socket, transport } = build(WebSocketTransport, OPEN)
        const table = []
        for (const state of [CONNECTING, OPEN, CLOSING, CLOSED]) {
          socket.readyState = state
          table.push(`${state}:${transport.isOpen}`)
        }
        return { expected: '0:false,1:true,2:false,3:false', actual: table.join(',') }
      },
    },
    {
      id: 'C06',
      label: 'message event forwards the same payload object once',
      run() {
        const { socket, seen } = build(WebSocketTransport, OPEN)
        const msg = { bytes: 'msg-1' }
        socket.fire('message', msg)
        const same = seen.message.length === 1 && seen.message[0][0] === msg
        return { expected: 'count=1 same=true', actual: `count=${seen.message.length} same=${same}` }
      },
    },
    {
      id: 'C07',
      label: 'close event clears ready and emits close once',
      run() {
        const { socket, transport, seen } = build(WebSocketTransport, OPEN)
        socket.fire('close')
        return {
          expected: 'ready=false closes=1',
          actual: `ready=${transport.ready} closes=${seen.close.length}`,
        }
      },
    },
    {
      id: 'C08',
      label: 'a transient error on an OPEN socket forwards the error and leaves the socket open',
      run() {
        const { socket, transport, seen } = build(WebSocketTransport, OPEN)
        socket.fire('error', errValue)
        const same = seen.error.length === 1 && seen.error[0][0] === errValue
        return {
          expected: 'ready=true errors=1 same=true',
          actual: `ready=${transport.ready} errors=${seen.error.length} same=${same}`,
        }
      },
    },
    {
      id: 'C09',
      label: 'send on OPEN returns true and hands the same data to the socket once',
      run() {
        const { socket, transport } = build(WebSocketTransport, OPEN)
        const ret = transport.send(frame)
        const same = socket.sent.length === 1 && socket.sent[0] === frame
        return {
          expected: 'ret=true sent=1 same=true',
          actual: `ret=${ret} sent=${socket.sent.length} same=${same}`,
        }
      },
    },
    {
      id: 'C10',
      label: 'send follows the lifecycle: refused before open, accepted once open, refused after close',
      run() {
        const { socket, transport } = build(WebSocketTransport, CONNECTING)
        const beforeOpen = transport.send(frame)
        socket.readyState = OPEN
        socket.fire('open')
        const opened = transport.send(frame)
        socket.fire('close')
        const afterClose = transport.send(frame)
        return {
          expected: 'beforeOpen=false,opened=true,afterClose=false sent=1',
          actual: `beforeOpen=${beforeOpen},opened=${opened},afterClose=${afterClose} sent=${socket.sent.length}`,
        }
      },
    },
    {
      id: 'C11',
      label: 'send returns false instead of throwing when the socket throws',
      run() {
        const { socket, transport } = build(WebSocketTransport, OPEN)
        socket.throwOnSend = true
        const ret = transport.send(frame)
        return { expected: 'ret=false sent=0', actual: `ret=${ret} sent=${socket.sent.length}` }
      },
    },
    {
      id: 'C12',
      label: 'sendUnreliable sends with an empty buffer',
      run() {
        const { socket, transport } = build(WebSocketTransport, OPEN)
        socket.bufferedAmount = 0
        const ret = transport.sendUnreliable(frame)
        return { expected: 'ret=true sent=1', actual: `ret=${ret} sent=${socket.sent.length}` }
      },
    },
    {
      id: 'C13',
      label: 'sendUnreliable still sends at exactly 65536 buffered bytes',
      run() {
        const { socket, transport } = build(WebSocketTransport, OPEN)
        socket.bufferedAmount = DROP_ABOVE_BYTES
        const ret = transport.sendUnreliable(frame)
        return { expected: 'ret=true sent=1', actual: `ret=${ret} sent=${socket.sent.length}` }
      },
    },
    {
      id: 'C14',
      label: 'sendUnreliable drops one byte above 65536 buffered bytes',
      run() {
        const { socket, transport } = build(WebSocketTransport, OPEN)
        socket.bufferedAmount = DROP_ABOVE_BYTES + 1
        const ret = transport.sendUnreliable(frame)
        return { expected: 'ret=false sent=0', actual: `ret=${ret} sent=${socket.sent.length}` }
      },
    },
    {
      id: 'C15',
      label: 'sendUnreliable refused once the socket has closed, with an empty buffer',
      run() {
        const { socket, transport } = build(WebSocketTransport, OPEN)
        socket.fire('close')
        socket.bufferedAmount = 0
        const ret = transport.sendUnreliable(frame)
        return { expected: 'ret=false sent=0', actual: `ret=${ret} sent=${socket.sent.length}` }
      },
    },
    {
      id: 'C16',
      label: 'close on OPEN clears ready and closes the socket once',
      run() {
        const { socket, transport } = build(WebSocketTransport, OPEN)
        transport.close()
        return {
          expected: 'ready=false closeCalls=1',
          actual: `ready=${transport.ready} closeCalls=${socket.closeCalls}`,
        }
      },
    },
    {
      id: 'C17',
      label: 'close on CLOSED clears ready and does not call the socket',
      run() {
        const { socket, transport } = build(WebSocketTransport, OPEN)
        socket.readyState = CLOSED
        transport.close()
        return {
          expected: 'ready=false closeCalls=0',
          actual: `ready=${transport.ready} closeCalls=${socket.closeCalls}`,
        }
      },
    },
    {
      id: 'C18',
      label: 'the lifecycle is one enumerated state, never a ready/_closed pair',
      run() {
        const { socket, transport } = build(WebSocketTransport, CONNECTING)
        const atConnect = transport.state
        socket.readyState = OPEN
        socket.fire('open')
        const atOpen = transport.state
        socket.fire('close')
        const atClose = transport.state
        return {
          expected: 'connecting,open,closed',
          actual: `${atConnect},${atOpen},${atClose}`,
        }
      },
    },
    {
      id: 'C19',
      label: 'isOpen and the send() gate agree at every lifecycle step, transient error included',
      run() {
        const { socket, transport } = build(WebSocketTransport, CONNECTING)
        const rows = []
        const step = (name) => {
          const open = transport.isOpen
          const sent = transport.send(frame)
          rows.push(`${name}:isOpen=${open}/send=${sent}/readyState=${socket.readyState}`)
        }
        step('connecting')
        socket.readyState = OPEN
        socket.fire('open')
        step('open')
        socket.fire('error', errValue)
        step('afterError')
        socket.fire('close')
        step('closed')
        return {
          expected:
            'connecting:isOpen=false/send=false/readyState=0,open:isOpen=true/send=true/readyState=1,afterError:isOpen=true/send=true/readyState=1,closed:isOpen=false/send=false/readyState=1',
          actual: rows.join(','),
        }
      },
    },
  ]
}

function show(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

function errorText(err) {
  return err && err.message ? err.message : String(err)
}

function finish(pass) {
  console.log(`RESULT: ${pass ? 'PASS' : 'FAIL'}`)
  process.exitCode = pass ? 0 : 1
}

async function main() {
  console.log('witness: WebSocketTransport')
  console.log(`module: ${modulePath}`)
  if (!existsSync(modulePath)) {
    console.log('reason: module path does not exist')
    finish(false)
    return
  }
  let WebSocketTransport
  try {
    const mod = await import(pathToFileURL(modulePath).href)
    WebSocketTransport = mod.WebSocketTransport
  } catch (err) {
    console.log(`reason: import failed: ${errorText(err)}`)
    finish(false)
    return
  }
  if (typeof WebSocketTransport !== 'function') {
    console.log('reason: module does not export a WebSocketTransport class')
    finish(false)
    return
  }
  const list = checks(WebSocketTransport)
  let failed = 0
  for (const check of list) {
    try {
      const { expected, actual } = check.run()
      const ok = Object.is(expected, actual)
      if (!ok) failed += 1
      console.log(
        `CLAIM ${check.id} ${ok ? 'PASS' : 'FAIL'} ${check.label}: expected=${show(expected)} got=${show(actual)}`,
      )
    } catch (err) {
      failed += 1
      console.log(`CLAIM ${check.id} FAIL ${check.label}: threw ${errorText(err)}`)
    }
  }
  console.log(`claims=${list.length} failed=${failed}`)
  finish(failed === 0)
}

main().catch((err) => {
  console.log(`reason: ${errorText(err)}`)
  finish(false)
})
