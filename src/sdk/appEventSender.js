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

// --- hot swap -----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapAppEventSender = (next) => {
  stampSender = next.stampSender
  senderOf = next.senderOf
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapAppEventSender)
