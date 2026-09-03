import { TransportWrapper } from './TransportWrapper.js'

// Plain WS has no real unreliable/datagram mode -- every send() is a reliable, ordered, queued write. Left
// unguarded, sendUnreliable() would just queue behind whatever's already backed up on the socket, so a
// congested/slow client's snapshot traffic head-of-line-blocks: the tick handler happily queues frame after
// frame into ws's internal buffer while socket.bufferedAmount grows unbounded, and every queued snapshot
// arrives progressively later and staler. A dropped snapshot costs nothing (the client gets a fresh delta or
// keyframe next tick regardless), so past this threshold we drop instead of queueing.
const UNRELIABLE_BACKPRESSURE_DROP_THRESHOLD_BYTES = 64 * 1024

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
        this.emit('open')
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
    // A stale/backed-up snapshot is worse than a skipped one -- drop rather than queue behind congestion.
    if (this.socket.bufferedAmount > UNRELIABLE_BACKPRESSURE_DROP_THRESHOLD_BYTES) return false
    return this.send(data)
  }

  close() {
    super.close()
    if (this.socket.readyState === 1) {
      this.socket.close()
    }
  }
}
