import { createInputEventReceiver } from '../core/InputEventProxy.js'

const receiver = createInputEventReceiver(self)
self.postMessage({ type: 'ready' })

let eventCount = 0
receiver.on('keydown', () => eventCount++)
receiver.on('mousemove', () => eventCount++)
receiver.on('mousedown', () => eventCount++)
receiver.on('resize', () => eventCount++)
receiver.on('touch', () => eventCount++)
setInterval(() => {
  self.postMessage({
    type: 'input-event-stats',
    eventCount,
    keys: [...receiver.store.keys],
    pointerLocked: receiver.store.pointerLocked
  })
}, 250)
