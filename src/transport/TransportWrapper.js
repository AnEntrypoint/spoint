import { EventEmitter } from '../protocol/EventEmitter.js'

export const SEND_ACCEPTED = true

export const SEND_REJECTED = false

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
    this.ready = false
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
