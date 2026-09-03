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

  send(data, mt) {
    throw new Error('send() not implemented')
  }

  sendUnreliable(data, mt) {
    return this.send(data, mt)
  }

  close() {
    this.ready = false
  }
}
