import { pack, unpack } from '../protocol/msgpack.js'
import { isUnreliable } from '../protocol/MessageTypes.js'
import { EventEmitter } from '../protocol/EventEmitter.js'

export class ConnectionManager extends EventEmitter {
  constructor(options = {}) {
    super()
    this.clients = new Map()
    this.heartbeatInterval = options.heartbeatInterval || 1000
    this.heartbeatTimeout = options.heartbeatTimeout || 3000
    this.timers = new Map()
  }

  addClient(clientId, transport) {
    const client = {
      id: clientId,
      transport,
      lastHeartbeat: Date.now(),
      sessionToken: null,
      transportType: transport.type || 'websocket'
    }

    transport.on('message', (data) => {
      try {
        client.lastHeartbeat = Date.now()
        const msg = unpack(data)
        this.emit('message', clientId, msg)
      } catch (err) {
        console.error(`[connection] decode error for ${clientId}:`, err.message)
      }
    })

    transport.on('close', () => {
      this.removeClient(clientId)
      this.emit('disconnect', clientId, 'closed')
    })

    transport.on('error', (err) => {
      console.error(`[connection] transport error for ${clientId}:`, err.message)
      this.removeClient(clientId)
      this.emit('disconnect', clientId, 'error')
    })

    this.clients.set(clientId, client)
    this._setupHeartbeat(clientId)
    return client
  }

  _setupHeartbeat(clientId) {
    const check = () => {
      const client = this.clients.get(clientId)
      if (!client) return
      const age = Date.now() - client.lastHeartbeat
      if (age > this.heartbeatTimeout) {
        this.removeClient(clientId)
        this.emit('disconnect', clientId, 'timeout')
        return
      }
      const timer = setTimeout(check, this.heartbeatInterval)
      this.timers.set(`hb-${clientId}`, timer)
    }
    const timer = setTimeout(check, this.heartbeatInterval)
    this.timers.set(`hb-${clientId}`, timer)
  }

  removeClient(clientId) {
    const client = this.clients.get(clientId)
    if (!client) return
    if (client.transport && client.transport.isOpen) {
      client.transport.close()
    }
    this.clients.delete(clientId)
    const timer = this.timers.get(`hb-${clientId}`)
    if (timer) clearTimeout(timer)
    this.timers.delete(`hb-${clientId}`)
  }

  getClient(clientId) {
    return this.clients.get(clientId)
  }

  send(clientId, type, payload = {}) {
    const client = this.clients.get(clientId)
    if (!client || !client.transport.isOpen) return false
    try {
      const data = pack({ type, payload })
      if (isUnreliable(type)) return client.transport.sendUnreliable(data)
      return client.transport.send(data)
    } catch (err) {
      console.error(`[connection] send error to ${clientId}:`, err.message)
      return false
    }
  }

  broadcast(type, payload = {}) {
    const data = pack({ type, payload })
    const unreliable = isUnreliable(type)
    let count = 0
    for (const client of this.clients.values()) {
      if (!client.transport.isOpen) continue
      try {
        if (unreliable) client.transport.sendUnreliable(data)
        else client.transport.send(data)
        count++
      } catch (err) {
        console.error(`[connection] broadcast error to ${client.id}:`, err.message)
      }
    }
    return count
  }

  getAllStats() {
    return {
      activeConnections: this.clients.size,
      clients: Array.from(this.clients.entries()).map(([id, c]) => ({
        id,
        transport: c.transportType,
        sessionToken: c.sessionToken ? '***' : null
      }))
    }
  }

  destroy() {
    for (const clientId of this.clients.keys()) {
      this.removeClient(clientId)
    }
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.clients.clear()
    this.timers.clear()
  }
}
