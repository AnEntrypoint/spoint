import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const TAG = 'region-ipc-transport'
const HONEST_MODULE = fileURLToPath(new URL('../src/sharding/RegionIPCTransport.js', import.meta.url))
const measurements = []

function modulePathFromArgv(argv) {
  const flag = argv.find(arg => arg.startsWith('--module='))
  return flag === undefined ? HONEST_MODULE : path.resolve(flag.slice('--module='.length))
}

function expect(name, expected, got) {
  const expectedText = JSON.stringify(expected)
  const gotText = got === undefined ? 'undefined' : JSON.stringify(got)
  const passed = expectedText === gotText
  measurements.push(passed)
  if (passed) {
    console.log(`[${TAG}] ok   ${name} = ${expectedText}`)
  } else {
    console.log(`[${TAG}] FAIL ${name}: expected ${expectedText}, got ${gotText}`)
  }
}

function measure(name, expected, observe) {
  let got
  try {
    got = observe()
  } catch (error) {
    got = `threw: ${error && error.message}`
  }
  expect(name, expected, got)
}

function fakeRouterChannel() {
  const frames = []
  const sendToRouter = (message) => {
    frames.push(JSON.parse(JSON.stringify(message)))
  }
  return { frames, sendToRouter }
}

function routerDecodeBytes(frame) {
  return Array.from(Buffer.from(frame.dataB64, 'base64'))
}

function sortedKeys(object) {
  return Object.keys(object).sort()
}

async function driveModule(modulePath) {
  const { RegionIPCTransport } = await import(pathToFileURL(modulePath).href)
  measure('module.exportsRegionIPCTransport', 'function', () => typeof RegionIPCTransport)

  const channel = fakeRouterChannel()
  const transport = new RegionIPCTransport('p7', channel.sendToRouter)
  measure('construct.type', 'region-ipc', () => transport.type)
  measure('construct.routerPlayerId', 'p7', () => transport.routerPlayerId)
  measure('construct.ready', true, () => transport.ready)
  measure('construct.isOpen', true, () => transport.isOpen)

  const sendReturn = transport.send(new Uint8Array([0, 1, 2, 250, 255]))
  measure('send.returnValue', true, () => sendReturn)
  measure('send.routerFrameCount', 1, () => channel.frames.length)
  measure('send.frameKeys', ['dataB64', 'routerPlayerId', 'type'], () => sortedKeys(channel.frames[0]))
  measure('send.frameType', 'WORKER_FRAME', () => channel.frames[0].type)
  measure('send.frameRouterPlayerId', 'p7', () => channel.frames[0].routerPlayerId)
  measure('send.frameDataB64', 'AAEC+v8=', () => channel.frames[0].dataB64)
  measure('send.routerDecodedBytes', [0, 1, 2, 250, 255], () => routerDecodeBytes(channel.frames[0]))

  const windowChannel = fakeRouterChannel()
  new RegionIPCTransport('p7', windowChannel.sendToRouter).send(new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]).subarray(2, 5))
  measure('send.subarrayViewDecodedBytes', [7, 6, 5], () => routerDecodeBytes(windowChannel.frames[0]))

  const float32Channel = fakeRouterChannel()
  new RegionIPCTransport('p7', float32Channel.sendToRouter).send(new Float32Array([1.5, 2.5]))
  measure('send.float32ArrayDecodedBytes', [0, 0, 192, 63, 0, 0, 32, 64], () => routerDecodeBytes(float32Channel.frames[0]))

  const float32WindowChannel = fakeRouterChannel()
  new RegionIPCTransport('p7', float32WindowChannel.sendToRouter).send(new Float32Array([1.5, 2.5, 3.5]).subarray(1))
  measure('send.float32SubarrayViewDecodedBytes', [0, 0, 32, 64, 0, 0, 96, 64], () => routerDecodeBytes(float32WindowChannel.frames[0]))

  const dataViewWindowChannel = fakeRouterChannel()
  new RegionIPCTransport('p7', dataViewWindowChannel.sendToRouter).send(new DataView(new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]).buffer, 2, 3))
  measure('send.dataViewWindowDecodedBytes', [7, 6, 5], () => routerDecodeBytes(dataViewWindowChannel.frames[0]))

  const dataViewFullChannel = fakeRouterChannel()
  new RegionIPCTransport('p7', dataViewFullChannel.sendToRouter).send(new DataView(new Uint8Array([1, 2, 3]).buffer))
  measure('send.dataViewFullDecodedBytes', [1, 2, 3], () => routerDecodeBytes(dataViewFullChannel.frames[0]))

  const bufferChannel = fakeRouterChannel()
  const bufferTransport = new RegionIPCTransport('p7', bufferChannel.sendToRouter)
  bufferTransport.send(new Uint8Array([9, 8, 7]).buffer)
  measure('send.arrayBufferDecodedBytes', [9, 8, 7], () => routerDecodeBytes(bufferChannel.frames[0]))
  bufferTransport.send('hi')
  measure('send.stringDecodedBytes', [104, 105], () => routerDecodeBytes(bufferChannel.frames[1]))

  const brokenChannel = new RegionIPCTransport('p8', () => { throw new Error('channel gone') })
  const brokenReturn = brokenChannel.send(new Uint8Array([1]))
  measure('send.routerThrowReturnsFalse', false, () => brokenReturn)

  const closedChannel = fakeRouterChannel()
  const closedTransport = new RegionIPCTransport('p9', closedChannel.sendToRouter)
  closedTransport.close()
  const afterCloseReturn = closedTransport.send(new Uint8Array([1, 2]))
  measure('send.afterCloseReturnsFalse', false, () => afterCloseReturn)
  measure('send.afterCloseRouterFrameCount', 1, () => closedChannel.frames.length)

  const closeEvents = []
  transport.on('close', () => closeEvents.push('close'))
  transport.close()
  const lastFrame = () => channel.frames[channel.frames.length - 1]
  measure('close.routerFrameCount', 2, () => channel.frames.length)
  measure('close.frameKeys', ['routerPlayerId', 'type'], () => sortedKeys(lastFrame()))
  measure('close.frameType', 'CLIENT_CLOSE_FROM_WORKER', () => lastFrame().type)
  measure('close.frameRouterPlayerId', 'p7', () => lastFrame().routerPlayerId)
  measure('close.closeEventCount', 1, () => closeEvents.length)
  measure('close.readyAfterClose', false, () => transport.ready)
  measure('close.isOpenAfterClose', false, () => transport.isOpen)
  transport.close()
  measure('close.secondCloseRouterFrameCount', 2, () => channel.frames.length)
  measure('close.secondCloseEventCount', 1, () => closeEvents.length)

  const thrownKind = (observe) => {
    try {
      observe()
      return 'returned'
    } catch (error) {
      return error instanceof TypeError ? 'TypeError' : 'other'
    }
  }

  const deliveredCloseChannel = fakeRouterChannel()
  const deliveredClose = new RegionIPCTransport('p14', deliveredCloseChannel.sendToRouter)
  measure('close.returnValueWhenDelivered', true, () => deliveredClose.close())
  measure('close.returnValueWhenAlreadyClosed', false, () => deliveredClose.close())
  measure('close.deliveredFrameCount', 1, () => deliveredCloseChannel.frames.length)

  const throwingCloseEvents = []
  const throwingCloseChannel = new RegionIPCTransport('p13', () => { throw new Error('channel gone') })
  throwingCloseChannel.on('close', () => throwingCloseEvents.push('close'))
  const throwingCloseReturns = []
  measure('closeRouterThrow.doesNotThrow', 'returned', () => { throwingCloseReturns.push(throwingCloseChannel.close()); return 'returned' })
  measure('closeRouterThrow.returnValue', false, () => throwingCloseReturns[0])
  measure('closeRouterThrow.closeEventCount', 1, () => throwingCloseEvents.length)
  measure('closeRouterThrow.readyAfterClose', false, () => throwingCloseChannel.ready)
  measure('closeRouterThrow.sendAfterCloseReturnsFalse', false, () => throwingCloseChannel.send(new Uint8Array([1])))
  measure('closeRouterThrow.secondCloseReturnValue', false, () => throwingCloseChannel.close())
  measure('closeRouterThrow.closeEventCountAfterSecondClose', 1, () => throwingCloseEvents.length)

  const invalidChannel = fakeRouterChannel()
  const invalidTransport = new RegionIPCTransport('p15', invalidChannel.sendToRouter)
  measure('send.numberInputThrowsTypeError', 'TypeError', () => thrownKind(() => invalidTransport.send(42)))
  measure('send.nullInputThrowsTypeError', 'TypeError', () => thrownKind(() => invalidTransport.send(null)))
  measure('send.objectInputThrowsTypeError', 'TypeError', () => thrownKind(() => invalidTransport.send({})))
  const detachedFloat32 = new Float32Array([1.5, 2.5])
  structuredClone(detachedFloat32.buffer, { transfer: [detachedFloat32.buffer] })
  measure('send.detachedFloat32ViewThrowsTypeError', 'TypeError', () => thrownKind(() => invalidTransport.send(detachedFloat32)))
  const detachedUint8 = new Uint8Array([1, 2, 3])
  structuredClone(detachedUint8.buffer, { transfer: [detachedUint8.buffer] })
  measure('send.detachedUint8ArrayThrowsTypeError', 'TypeError', () => thrownKind(() => invalidTransport.send(detachedUint8)))
  measure('send.invalidInputRouterFrameCount', 0, () => invalidChannel.frames.length)
  measure('send.invalidInputLeavesTransportOpen', true, () => invalidTransport.ready)

  const inboundChannel = fakeRouterChannel()
  const inbound = new RegionIPCTransport('p7', inboundChannel.sendToRouter)
  const inboundBuffers = []
  inbound.on('message', (buffer) => inboundBuffers.push(buffer))
  inbound.deliver('AAEC+v8=')
  measure('deliver.messageCount', 1, () => inboundBuffers.length)
  measure('deliver.isBuffer', true, () => Buffer.isBuffer(inboundBuffers[0]))
  measure('deliver.decodedBytes', [0, 1, 2, 250, 255], () => Array.from(inboundBuffers[0]))
  inbound.deliver('+/+/')
  measure('deliver.standardAlphabetDecodedBytes', [251, 255, 191], () => Array.from(inboundBuffers[1]))
  inbound.deliver('YQ==')
  inbound.deliver('Yg==')
  measure('deliver.orderPreserved', ['a', 'b'], () => inboundBuffers.slice(2).map(buffer => buffer.toString('utf8')))
  measure('deliver.sendsNoRouterFrame', 0, () => inboundChannel.frames.length)

  const everyByte = Array.from({ length: 256 }, (_, value) => value)
  const roundTripChannel = fakeRouterChannel()
  new RegionIPCTransport('p1', roundTripChannel.sendToRouter).send(Uint8Array.from(everyByte))
  measure('roundTrip.routerDecodesEveryByte', everyByte, () => routerDecodeBytes(roundTripChannel.frames[0]))
  const routerBytes = Array.from(Buffer.from(roundTripChannel.frames[0]?.dataB64 ?? '', 'base64'))
  const echoed = new RegionIPCTransport('p1', () => {})
  const echoedBuffers = []
  echoed.on('message', (buffer) => echoedBuffers.push(buffer))
  echoed.deliver(Buffer.from(routerBytes).toString('base64'))
  measure('roundTrip.echoedEveryByte', everyByte, () => Array.from(echoedBuffers[0]))

  const firstChannel = fakeRouterChannel()
  const secondChannel = fakeRouterChannel()
  new RegionIPCTransport('p1', firstChannel.sendToRouter).send(new Uint8Array([1]))
  new RegionIPCTransport('p2', secondChannel.sendToRouter).send(new Uint8Array([2]))
  measure('route.routerPlayerIdTagsEachFrame', ['p1', 'p2'], () => [firstChannel.frames[0].routerPlayerId, secondChannel.frames[0].routerPlayerId])
}

function reportVerdict() {
  const total = measurements.length
  const failedCount = measurements.filter(passed => !passed).length
  const passedCount = total - failedCount
  const verdictExit = total > 0 && failedCount === 0 ? 0 : 1
  if (verdictExit === 0) {
    console.log(`RESULT: PASS -- ${total} measurement(s) of RegionIPCTransport | expects ${passedCount}/${total}`)
  } else {
    console.log(`RESULT: FAIL -- ${failedCount} of ${total} measurement(s) failed | expects ${passedCount}/${total}`)
  }
  process.exitCode = verdictExit
}

const modulePath = modulePathFromArgv(process.argv)
console.log(`[${TAG}] module=${modulePath}`)
try {
  await driveModule(modulePath)
} catch (error) {
  expect('module.drivesWithoutThrowing', 'no throw', `threw: ${error && error.message}`)
}
reportVerdict()
