import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from '../protocol/EventEmitter.js'
import { WebTransportTransport } from './WebTransportTransport.js'

let Http3Server = null
let nativeAvailable = false

try {
  const require = createRequire(import.meta.url)
  const quichePath = require.resolve('@fails-components/webtransport-transport-http3-quiche')
  const nativePath = quichePath.replace(/lib[/\\]index\.js$/, 'build/Release/webtransport.node')
  if (existsSync(nativePath)) {
    const mod = await import('@fails-components/webtransport')
    Http3Server = mod.Http3Server
    nativeAvailable = true
  }
} catch (e) {}

export class WebTransportServer extends EventEmitter {
  constructor(options = {}) {
    super()
    this.port = options.port || 4433
    this.cert = options.cert || null
    this.key = options.key || null
    this.server = null
    this.running = false
  }

  async start() {
    if (!nativeAvailable || !Http3Server) {
      console.log('[webtransport] Native binary not available, skipping')
      return false
    }
    if (!this.cert || !this.key) {
      console.log('[webtransport] TLS cert/key not provided, skipping')
      return false
    }
    try {
      // secret must never ship as a literal default -- process.env.WEBTRANSPORT_SECRET when configured,
      // else a freshly generated random secret (warned loudly, since it changes every boot and thus
      // invalidates session resumption across restarts -- fine for dev, callers who need stable resumption
      // must set WEBTRANSPORT_SECRET explicitly).
      let secret = process.env.WEBTRANSPORT_SECRET
      if (!secret) {
        secret = randomBytes(32).toString('hex')
        console.warn('[webtransport] WEBTRANSPORT_SECRET not set; using a randomly generated secret for this run (session resumption will not survive a restart). Set WEBTRANSPORT_SECRET to a stable value in production.')
      }
      this.server = new Http3Server({
        port: this.port,
        host: '0.0.0.0',
        secret,
        cert: this.cert,
        privKey: this.key
      })
      this.server.startServer()
      this.running = true
      this._acceptSessions()
      return true
    } catch (e) {
      console.error('[webtransport] Failed to start:', e.message)
      return false
    }
  }

  async _acceptSessions() {
    const sessionStream = await this.server.sessionStream('/')
    const reader = sessionStream.getReader()
    while (this.running) {
      try {
        const { value, done } = await reader.read()
        if (done) break
        if (value) {
          const transport = new WebTransportTransport(value)
          this.emit('session', transport)
        }
      } catch (e) {
        if (this.running) console.error('[webtransport] Session error:', e.message)
      }
    }
  }

  stop() {
    this.running = false
    if (this.server) {
      try { this.server.destroy() } catch (e) {}
      this.server = null
    }
  }
}
