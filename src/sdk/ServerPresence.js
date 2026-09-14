import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const IDENTITY_PATH = join(process.cwd(), 'data', 'nostr-identity.json')
const DEFAULT_NAMESPACE = 'spoint'
const HEARTBEAT_MS = 30000
const PROTOCOL_VERSION = 1
const NIP78_APP_DATA_KIND = 30078

async function loadOrCreateIdentity(NostrTools) {
  if (existsSync(IDENTITY_PATH)) {
    try {
      const raw = JSON.parse(await readFile(IDENTITY_PATH, 'utf8'))
      if (raw?.sk && /^[0-9a-fA-F]{64}$/.test(raw.sk)) return raw.sk
    } catch { }
  }
  const skBytes = NostrTools.generateSecretKey()
  const skHex = Array.from(skBytes).map(b => b.toString(16).padStart(2, '0')).join('')
  await mkdir(join(process.cwd(), 'data'), { recursive: true }).catch(() => {})
  const tmp = IDENTITY_PATH + '.tmp'
  await writeFile(tmp, JSON.stringify({ sk: skHex, createdAt: new Date().toISOString() }), 'utf8')
  await rename(tmp, IDENTITY_PATH)
  return skHex
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function presenceDTag(namespace, port) {
  return `spoint-server:${namespace}:${port}`
}

export async function createServerPresence(opts = {}) {
  const {
    enabled = false,
    relays = null,
    namespace = DEFAULT_NAMESPACE,
    host = 'localhost',
    port,
    worldName = 'unknown',
    tickRate = 60,
    getPlayerCount = () => 0,
    maxPlayers = null,
    mode = 'default',
  } = opts

  if (!enabled) {
    return { publish: async () => {}, stop: async () => {}, pubkey: null, enabled: false }
  }

  const NostrTools = await import('nostr-tools')
  const { NostrAuth, RelayPool } = await import('wireweave')
  const { WebSocket: WSImpl } = await import('ws')

  const auth = new NostrAuth({ nostrTools: NostrTools })
  const skHex = await loadOrCreateIdentity(NostrTools)
  const sk = hexToBytes(skHex)
  const pk = NostrTools.getPublicKey(sk)
  auth.privkey = sk
  auth.pubkey = pk

  const pool = new RelayPool(relays ? { relays, verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WSImpl } : { verifyEvent: NostrTools.verifyEvent, WebSocketImpl: WSImpl })
  pool.connect()

  const dTag = presenceDTag(namespace, port)
  let heartbeatTimer = null

  async function publish(action = 'heartbeat') {
    const payload = {
      action,
      worldName, host, port, mode,
      players: getPlayerCount(),
      maxPlayers,
      tickRate,
      protocolVersion: PROTOCOL_VERSION,
      ts: Date.now(),
    }
    const signed = await auth.sign({
      kind: NIP78_APP_DATA_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', dTag], ['action', action], ['ns', namespace]],
      content: JSON.stringify(payload),
    })
    pool.publish(signed)
    return signed
  }

  async function stop() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
    try { await publish('offline') } catch { }
    pool.disconnect()
  }

  await publish('online')
  heartbeatTimer = setInterval(() => { publish('heartbeat').catch(() => {}) }, HEARTBEAT_MS)

  return { publish, stop, pubkey: pk, enabled: true, pool }
}
