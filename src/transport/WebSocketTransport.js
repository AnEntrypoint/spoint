import { TransportWrapper } from './TransportWrapper.js'

export class WebSocketTransport extends TransportWrapper {
  constructor(socket) {
    super()
    this.type = 'websocket'
    this.socket = socket
    this.ready = socket.readyState === 1

    socket.on('message', (data) => {
      this.emit('message', data)
    })

    socket.on('close', () => {
      this.ready = false
      this.emit('close')
    })

    socket.on('error', (err) => {
      this.ready = false
      this.emit('error', err)
    })

    if (!this.ready) {
      socket.on('open', () => {
        this.ready = true
      })
    }
  }

  get isOpen() {
    return this.socket.readyState === 1
  }

  send(data) {
    if (this.socket.readyState !== 1) return false
    try {
      this.socket.send(data)
      return true
    } catch (e) {
      return false
    }
  }

  sendUnreliable(data) {
    return this.send(data)
  }

  close() {
    super.close()
    if (this.socket.readyState === 1) {
      this.socket.close()
    }
  }
}
