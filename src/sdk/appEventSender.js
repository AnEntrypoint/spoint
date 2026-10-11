const SENDER = Symbol('appEvent.sender')

function describeValue(v) {
  return typeof v === 'number' ? String(v) : JSON.stringify(v)
}

function isSenderId(v) {
  return (typeof v === 'string' && v !== '') || (typeof v === 'number' && Number.isFinite(v))
}

export function stampSender(message, { id, fromClient }) {
  if (typeof message !== 'object' || message === null) throw new TypeError(`[appEventSender] message must be an object, got ${describeValue(message)}`)
  if (!isSenderId(id)) throw new TypeError(`[appEventSender] sender id must be a non-empty string or a finite number, got ${describeValue(id)}`)
  if (typeof fromClient !== 'boolean') throw new TypeError(`[appEventSender] fromClient must be a boolean, got ${describeValue(fromClient)}`)
  Object.defineProperty(message, SENDER, {
    value: Object.freeze({ id, fromClient }),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return message
}

export function senderOf(message) {
  if (typeof message !== 'object' || message === null) return null
  return message[SENDER] || null
}
