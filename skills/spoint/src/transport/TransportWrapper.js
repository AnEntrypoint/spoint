import { EventEmitter } from '../protocol/EventEmitter.js'

export class TransportWrapper extends EventEmitter {
  constructor() {
    super()
    this.type = 'base'
    this.ready = false
  }

  get isOpen() {
    return this.ready
  }

  send(data) {
    throw new Error('send() not implemented')
  }

  sendUnreliable(data) {
    return this.send(data)
  }

  close() {
    this.ready = false
  }
}
