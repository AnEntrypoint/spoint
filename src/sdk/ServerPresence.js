// Server presence: publishes this dedicated server's liveness/player-count as a signed, replaceable
// nostr event (NIP-78 "application-specific data", kind:30078) so a client-side server browser (see
// PRD row nostr-server-browser-client-ui, the sibling consumer of this wire format) can discover
// dedicated servers the exact same way client/HostMigration.js + client/WireweaveClient.js already
// discover P2P wireweave-hosted rooms via presence events -- one unified discovery mechanism for both
// server shapes, not two.
//
// Reuses wireweave's OWN presence primitives (node_modules/wireweave/src/data.js's _publishPresence,
// node_modules/wireweave/src/servers.js's replaceable-34550 pattern) rather than hand-rolling a new
// nostr client: NostrAuth (keypair + event signing) and RelayPool (WebSocket relay fan-out, publish/
// subscribe) are both plain ES modules with zero DOM/browser dependency -- verified by reading their
// source directly, neither imports `window`/`document`/localStorage. RelayPool's only environment
// requirement is a WebSocket constructor, which this module supplies explicitly via node:ws's
// WebSocketServer sibling import (the `ws` package, already a direct dependency of this repo per
// src/sdk/ServerAPI.js) since Node's own built-in global WebSocket (present since Node 22, confirmed
// live via `node -e "console.log(typeof WebSocket)"` -> 'function' on this repo's targeted Node 24) is
// also viable but the `ws` package is preferred here for parity with the exact class RelayPool's own
// browser callers get from the platform, and to avoid a silent behavior gap on any Node version this
// repo is later run under that ships an older/incomplete global WebSocket.
//
// Server identity: unlike a browser client (which persists its nostr keypair to localStorage via
// NostrAuth.loadFromStorage/generateKey), a dedicated server has no localStorage. This module persists
// the generated keypair to data/nostr-identity.json (same atomic tmp-then-rename write discipline as
// src/storage/FSAdapter.js) so the server's pubkey is STABLE across restarts -- a server browser
// treating "same pubkey" as "same server" would otherwise see a new phantom server identity on every
// process restart. The file contains a raw hex secret key: gitignored (see .gitignore's new
// /data/nostr-identity.json entry), analogous to any other server-side secret.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const IDENTITY_PATH = join(process.cwd(), 'data', 'nostr-identity.json')
const DEFAULT_NAMESPACE = 'spoint'
const HEARTBEAT_MS = 30000
const PROTOCOL_VERSION = 1

async function loadOrCreateIdentity(NostrTools) {
  if (existsSync(IDENTITY_PATH)) {
    try {
      const raw = JSON.parse(await readFile(IDENTITY_PATH, 'utf8'))
      if (raw?.sk && /^[0-9a-fA-F]{64}$/.test(raw.sk)) return raw.sk
    } catch { /* fall through to regenerate on any read/parse failure */ }
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

// dTag is the NIP-78 addressable-event key: unique per (namespace, host:port) so a relay treats
// repeated publishes from the same server as REPLACEMENTS of one addressable event (last-write-wins by
// created_at, per-relay), not an ever-growing event history -- matches wireweave's own
// 'wireweave-data:<roomId>' pattern in data.js.
function presenceDTag(namespace, port) {
  return `spoint-server:${namespace}:${port}`
}

// opts: { enabled, relays, namespace, host, port, worldName, tickRate, getPlayerCount, maxPlayers, mode }
// getPlayerCount is a live accessor (fn), not a snapshotted count -- every publish call (boot, heartbeat,
// join/leave, shutdown) re-reads current player count at call time so the wire payload never goes stale
// between heartbeats even though heartbeat cadence is coarse (HEARTBEAT_MS).
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
    // Explicit opt-in only: publishing to public nostr relays is an outbound-network side effect a
    // server operator did not necessarily ask for just by booting -- see worldDef.presence.enabled /
    // env SPOINT_PRESENCE gating in server.js's boot() call site. A disabled instance returns a
    // fully-shaped no-op controller so callers never need an `if (presence)` branch.
    return { publish: async () => {}, stop: async () => {}, pubkey: null, enabled: false }
  }

  const NostrTools = await import('nostr-tools')
  const { NostrAuth, RelayPool } = await import('wireweave')
  const { WebSocket: WSImpl } = await import('ws')

  const auth = new NostrAuth({ nostrTools: NostrTools })
  const skHex = await loadOrCreateIdentity(NostrTools)
  const sk = hexToBytes(skHex)
  const pk = NostrTools.getPublicKey(sk)
  // Mirror NostrAuth._persist's in-memory assignment (its own persist() call is skipped -- there is no
  // browser storage object here, identity persistence is this module's own file-based scheme above) so
  // auth.sign()/auth.isLoggedIn() behave exactly as they would after a real login.
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
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', dTag], ['action', action], ['ns', namespace]],
      content: JSON.stringify(payload),
    })
    pool.publish(signed)
    return signed
  }

  async function stop() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
    try { await publish('offline') } catch { /* best-effort on shutdown, never block the shutdown path */ }
    pool.disconnect()
  }

  await publish('online')
  heartbeatTimer = setInterval(() => { publish('heartbeat').catch(() => {}) }, HEARTBEAT_MS)

  return { publish, stop, pubkey: pk, enabled: true, pool }
}
