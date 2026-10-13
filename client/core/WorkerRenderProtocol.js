export const WORKER_MESSAGE = Object.freeze({
  INIT: 'init',
  RESIZE: 'resize',
  STOP: 'stop',
  READY: 'ready',
  FRAME: 'frame',
  STOPPED: 'stopped',
  ERROR: 'error',
})

export const WORKER_INBOUND_TYPES = Object.freeze([
  WORKER_MESSAGE.INIT,
  WORKER_MESSAGE.RESIZE,
  WORKER_MESSAGE.STOP,
])

export const WORKER_OUTBOUND_TYPES = Object.freeze([
  WORKER_MESSAGE.READY,
  WORKER_MESSAGE.FRAME,
  WORKER_MESSAGE.STOPPED,
  WORKER_MESSAGE.ERROR,
])

export const WORKER_REFUSAL = Object.freeze({
  INIT_WHILE_RUNNING: 'init-while-running',
  INIT_NO_CANVAS: 'init-no-canvas',
  BAD_INIT_PAYLOAD: 'bad-init-payload',
  BAD_RESIZE_PAYLOAD: 'bad-resize-payload',
  RESIZE_NO_RENDER_TARGET: 'resize-no-render-target',
  UNKNOWN_MESSAGE_TYPE: 'unknown-message-type',
  HANDLER_THREW: 'handler-threw',
})

export const WORKER_REFUSAL_CODES = Object.freeze(Object.values(WORKER_REFUSAL))

const FRAME_STATS_GATE_MS = 250
export const FRAME_LIVE_BOUND_GATES = 4

export const WORKER_CLOCK_MS = Object.freeze({
  FRAME_STATS_GATE_MS,
  FRAME_LIVE_BOUND_MS: FRAME_STATS_GATE_MS * FRAME_LIVE_BOUND_GATES,
  TERMINATE_AFTER_STOP_REQUEST_MS: 250,
  STOP_CONFIRM_TIMEOUT_MS: 1000,
})

export function isWorkerOutboundType(type) {
  return WORKER_OUTBOUND_TYPES.includes(type)
}

export function isWorkerRefusalCode(code) {
  return WORKER_REFUSAL_CODES.includes(code)
}

export function workerDimsAreValid(width, height) {
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
}

export function workerStamped(seq, run, message) {
  return { seq, run, ...message }
}

export function workerFrameMessage(frame, ms, drawCalls, triangles, renderMs) {
  return { type: WORKER_MESSAGE.FRAME, frame, ms, drawCalls, triangles, renderMs }
}

export function workerRefusalMessage(code, message, stack) {
  if (!isWorkerRefusalCode(code)) {
    throw new Error('workerRefusalMessage: ' + String(code) + ' is not a declared refusal code')
  }
  return { type: WORKER_MESSAGE.ERROR, code, message, stack: stack || null }
}

export function undeclaredWorkerMessagePart(msg) {
  const type = msg === null || msg === undefined ? undefined : msg.type
  if (type !== undefined && !isWorkerOutboundType(type)) return 'type'
  if (type === WORKER_MESSAGE.ERROR && typeof msg.code === 'string' && !isWorkerRefusalCode(msg.code)) return 'code'
  return null
}
