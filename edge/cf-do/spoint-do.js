import { initJoltForEdge } from './jolt-edge-init.js'
import { init as workerEntryInit } from '../../src/sdk/WorkerEntry.js'
import { TransportWrapper } from '../../src/transport/TransportWrapper.js'
import worldDef from '../../apps/world/e2e-ci-arena.js'

class DurableObjectWebSocketTransport extends TransportWrapper {
  constructor(ws) {
    super()
    this.type = 'websocket'
    this.ws = ws
    this.ready = true
    ws.binaryType = 'arraybuffer'
    ws.addEventListener('message', (event) => {
      const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data
      this.emit('message', data)
    })
    ws.addEventListener('close', () => { this.ready = false; this.emit('close') })
    ws.addEventListener('error', (e) => { this.ready = false; this.emit('error', e) })
  }

  get isOpen() { return this.ready }

  send(data) {
    if (!this.ready) return false
    try {
      const buf = data instanceof Uint8Array
        ? (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
        : data
      this.ws.send(buf)
      return true
    } catch (e) { return false }
  }

  close() {
    super.close()
    try { this.ws.close() } catch (e) {}
  }
}

export class SpointGameRoom {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.ctxPromise = null
  }

  async _ensureCtx() {
    if (!this.ctxPromise) {
      this.ctxPromise = (async () => {
        await initJoltForEdge()
        const ctx = await workerEntryInit({ worldDef, apps: [] })
        return ctx
      })()
    }
    return this.ctxPromise
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade')
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    server.accept()

    const ctx = await this._ensureCtx()
    const transport = new DurableObjectWebSocketTransport(server)
    ctx.onClientConnect(transport)

    return new Response(null, { status: 101, webSocket: client })
  }
}

function isWebSocketUpgrade(request) {
  const h = request.headers.get('Upgrade')
  return !!h && h.toLowerCase() === 'websocket'
}

export default {
  async fetch(request, env) {
    if (isWebSocketUpgrade(request)) {
      const id = env.SPOINT_GAME_ROOM.idFromName('probe-room')
      const stub = env.SPOINT_GAME_ROOM.get(id)
      return stub.fetch(request)
    }
    if (!env.STATIC_ORIGIN) {
      return new Response('edge Worker has no STATIC_ORIGIN configured for non-WebSocket requests', { status: 502 })
    }
    const url = new URL(request.url)
    const originUrl = new URL(url.pathname + url.search, env.STATIC_ORIGIN)
    const originRequest = new Request(originUrl, request)
    originRequest.headers.set('x-spoint-edge-proxy', '1')
    return fetch(originRequest)
  }
}
