import { createVirtualClock } from './lib/virtual-clock.mjs'
import { driveVirtual } from './lib/virtual-runtime.mjs'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}
const sleepOn = clock => ms => new Promise(resolveSleep => clock.setTimeout(resolveSleep, ms))

async function orderScenario(seed) {
  const clock = createVirtualClock({ seed })
  return clock.drive(async () => {
    const log = []
    clock.setTimeout(() => log.push('a@5'), 5)
    clock.setTimeout(() => log.push('b@5'), 5)
    clock.setTimeout(() => log.push('c@1'), 1)
    clock.setImmediate(() => log.push('imm@0'))
    await sleepOn(clock)(10)
    return { log, now: clock.now() }
  })
}

async function intervalScenario() {
  const clock = createVirtualClock({ seed: 2 })
  return clock.drive(async () => {
    const ticks = []
    const handle = clock.setInterval(() => {
      ticks.push(clock.now())
      if (ticks.length === 3) clock.clearInterval(handle)
    }, 4)
    await sleepOn(clock)(40)
    return ticks
  })
}

async function clearScenario() {
  const clock = createVirtualClock({ seed: 3 })
  return clock.drive(async () => {
    const fired = []
    const handle = clock.setTimeout(() => fired.push('x'), 3)
    clock.clearTimeout(handle)
    await sleepOn(clock)(10)
    return fired
  })
}

const draws = seed => {
  const random = createVirtualClock({ seed }).random
  return [random(), random(), random(), random(), random()]
}

const ordered = await orderScenario(1)
check('timers fire in virtual time order, then creation order, with immediates first at the same instant', JSON.stringify(ordered.log) === JSON.stringify(['imm@0', 'c@1', 'a@5', 'b@5']), ordered.log.join(','))
check('the awaiting task resumes at its virtual deadline', ordered.now === 10, `now ${ordered.now}`)
const orderedAgain = await orderScenario(1)
check('two independent runs of the same schedule give the same order and time', JSON.stringify(ordered) === JSON.stringify(orderedAgain))

const ticks = await intervalScenario()
check('an interval repeats on its period and stops when cleared', JSON.stringify(ticks) === JSON.stringify([4, 8, 12]), ticks.join(','))

const cleared = await clearScenario()
check('a cleared timer never fires', cleared.length === 0, `fired ${cleared.length}`)

check('Math.random streams from the seed: the same seed repeats, another seed differs', JSON.stringify(draws(9)) === JSON.stringify(draws(9)) && JSON.stringify(draws(9)) !== JSON.stringify(draws(10)))

const timeClock = createVirtualClock({ seed: 4 })
const timeProbe = await timeClock.drive(async () => {
  const date0 = timeClock.dateNow()
  const now0 = timeClock.now()
  await sleepOn(timeClock)(25)
  return { dateMs: timeClock.dateNow() - date0, nowMs: timeClock.now() - now0 }
})
check('Date.now and performance.now advance by exactly the virtual sleep', timeProbe.dateMs === 25 && timeProbe.nowMs === 25, `date ${timeProbe.dateMs} now ${timeProbe.nowMs}`)

const wsModule = await import('ws')
const virtualWs = await import('./lib/virtual-ws.mjs')
check('the ws specifier resolves to the virtual socket module', wsModule.WebSocketServer === virtualWs.WebSocketServer)

const roundTrip = await driveVirtual(async () => {
  const httpServer = { address: () => ({ port: 4242 }) }
  const wss = new wsModule.WebSocketServer({ server: httpServer, path: '/ws' })
  const served = []
  let serverClosed = false
  wss.on('connection', socket => {
    socket.on('message', data => {
      served.push({ bytes: [...data], at: performance.now() })
      socket.send(new Uint8Array([9, 8, 7]))
    })
    socket.on('close', () => { serverClosed = true })
  })
  const client = new wsModule.WebSocket('ws://127.0.0.1:4242/ws')
  const received = []
  const opened = new Promise(resolveOpen => {
    client.onopen = () => {
      client.send(new Uint8Array([1, 2, 3]))
      resolveOpen()
    }
  })
  const reply = new Promise(resolveReply => {
    client.addEventListener('message', event => {
      received.push({ bytes: [...new Uint8Array(event.data)], at: performance.now() })
      resolveReply()
    }, { once: true })
  })
  await opened
  await reply
  client.close(1000, 'done')
  await sleepOn({ setTimeout })(5)
  wss.close()
  return { served, received, serverClosed, clientState: client.readyState }
})
check('the server receives the client bytes', JSON.stringify(roundTrip.served.map(s => s.bytes)) === JSON.stringify([[1, 2, 3]]), JSON.stringify(roundTrip.served))
check('the client receives the server reply after the server got the request', JSON.stringify(roundTrip.received.map(r => r.bytes)) === JSON.stringify([[9, 8, 7]]) && roundTrip.received[0].at > roundTrip.served[0].at, JSON.stringify(roundTrip.received))
check('a client close reaches the server and both ends end closed', roundTrip.serverClosed && roundTrip.clientState === 3, `serverClosed ${roundTrip.serverClosed} clientState ${roundTrip.clientState}`)

const refused = await driveVirtual(async () => {
  const client = new wsModule.WebSocket('ws://127.0.0.1:4343/ws')
  return new Promise(resolveRefused => {
    client.onclose = event => resolveRefused({ code: event.code, state: client.readyState })
  })
})
check('a connect to a port with no server is refused with code 1006', refused.code === 1006 && refused.state === 3, JSON.stringify(refused))

const failed = checks.filter(c => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map(c => c.name).join('; ')}`)
  process.exitCode = 1
} else {
  console.log(`RESULT: PASS the virtual clock orders timers, intervals and immediates deterministically, seeds Math.random, reports virtual Date.now and performance.now, and carries the virtual socket round trip, close and refusal (${checks.length} checks)`)
}
