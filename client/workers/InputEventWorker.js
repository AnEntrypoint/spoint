// InputEventWorker.js -- minimal worker-side receiver for the InputEventProxy live-latency probe
// (offscreencanvas-worker-input-event-proxy row). Not the game loop -- a real dedicated module Worker
// used to actually exercise the postMessage transport end-to-end (real structured clone across a real
// thread boundary, not an in-page function call standing in for one), matching the discipline
// client/workers/OffscreenRenderWorker.js already established for the render-loop proxy siblings.
//
// A future worker-hosted game loop imports createInputEventReceiver from ../core/InputEventProxy.js
// directly rather than this file -- this file exists purely so measureInputLatency() (client/core/
// InputEventProxy.js) and this row's own live-verification dispatch have a real minimal worker target
// to round-trip against without depending on the full OffscreenRenderWorker's THREE.js/canvas setup.
import { createInputEventReceiver } from '../core/InputEventProxy.js'

const receiver = createInputEventReceiver(self)
self.postMessage({ type: 'ready' })

// Expose a simple debug counter so a live probe can also assert real events (not just pings) reached
// the worker-side store, matching OffscreenRenderWorker.js's own periodic telemetry-post convention.
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
