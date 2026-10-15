import { EventEmitter } from '../protocol/EventEmitter.js'

export let SEND_ACCEPTED = true

export let SEND_REJECTED = false

export let LIFECYCLE_CONNECTING = 'connecting'
export let LIFECYCLE_OPEN = 'open'
export let LIFECYCLE_CLOSED = 'closed'

export class SendContractError extends Error {
  constructor(detail) {
    super(detail)
    this.name = 'SendContractError'
    this.answers = [SEND_ACCEPTED, SEND_REJECTED]
  }
}

export class TransportWrapper extends EventEmitter {
  constructor() {
    super()
    this.type = 'base'
    this.lifecycle = LIFECYCLE_CONNECTING
  }

  get ready() {
    return this.lifecycle === LIFECYCLE_OPEN
  }

  set ready(open) {
    this.lifecycle = open ? LIFECYCLE_OPEN : LIFECYCLE_CLOSED
  }

  get isOpen() {
    return this.ready
  }

  send(data, mt) {
    throw new SendContractError('send() answers one fact: whether the payload reached the wire, as SEND_ACCEPTED or SEND_REJECTED. A scheduler queueing or dropping it is not this answer')
  }

  sendUnreliable(data, mt) {
    return this.send(data, mt) ? SEND_ACCEPTED : SEND_REJECTED
  }

  close() {
    this.ready = false
  }
}

// --- hot swap ----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapTransportWrapper = (next) => {
  SEND_ACCEPTED = next.SEND_ACCEPTED
  SEND_REJECTED = next.SEND_REJECTED
  LIFECYCLE_CONNECTING = next.LIFECYCLE_CONNECTING
  LIFECYCLE_OPEN = next.LIFECYCLE_OPEN
  LIFECYCLE_CLOSED = next.LIFECYCLE_CLOSED
  SendContractError = next.SendContractError
  TransportWrapper = next.TransportWrapper
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapTransportWrapper)
