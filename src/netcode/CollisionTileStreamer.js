import { MSG } from '../protocol/MessageTypes.js'

export const COLLISION_TILE_RING = 1
export const COLLISION_TILE_FORGET_RING = 2
const STREAM_EVERY_TICKS = 2
const MAX_TILES_PER_PASS = 2
const TILE_IDLE_SWEEP_MS = 10000

export function collisionMirrorEnabled(netcode) {
  return (netcode?.profile ?? 'authoritative') === 'authoritative' && netcode?.collisionMirror !== false
}

function characterConfig(physics, physicsIntegration, playerId) {
  const charId = physicsIntegration.playerBodies.get(playerId)?.charId
  const mgr = physics._charMgr
  const shape = charId != null ? mgr?._charShapes.get(charId) : null
  if (!shape) return null
  return {
    radius: shape.radius, halfHeight: shape.standHeight, crouchHalfHeight: shape.crouchHeight, maxSlopeAngle: shape.slopeAngle,
    maxStepHeight: mgr.config.maxStepHeight, stickToFloorDistance: mgr.config.stickToFloorDistance,
    mass: physicsIntegration.config.playerMass, gravity: physicsIntegration.config.gravity
  }
}

export function createCollisionTileStreamer({ physics, physicsIntegration, connections, getNetcodeConfig }) {
  const clients = new Map()
  const stats = { tilesSent: 0, bytesSent: 0 }
  let index = null, lastSweepAt = 0

  function sendTile(playerId, t) {
    const bytes = new Uint8Array(t.verts.buffer, t.verts.byteOffset, t.verts.byteLength)
    connections.send(playerId, MSG.COLLISION_TILE, { tx: t.tx, tz: t.tz, h: t.hash, v: bytes })
    stats.tilesSent++; stats.bytesSent += bytes.byteLength
  }

  function streamTo(player, c, now) {
    const T = index.tileM, pos = player.state.position
    const cx = Math.floor(pos[0] / T), cz = Math.floor(pos[2] / T)
    for (const [k, s] of c.sent) if (Math.max(Math.abs(s.tx - cx), Math.abs(s.tz - cz)) > COLLISION_TILE_FORGET_RING) c.sent.delete(k)
    let budget = MAX_TILES_PER_PASS
    for (let r = 0; r <= COLLISION_TILE_RING && budget > 0; r++) {
      for (let dx = -r; dx <= r && budget > 0; dx++) for (let dz = -r; dz <= r && budget > 0; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        const t = index.get(cx + dx, cz + dz, now)
        const s = c.sent.get(t.k)
        if (s && s.hash === t.hash) continue
        sendTile(player.id, t)
        c.sent.set(t.k, { tx: t.tx, tz: t.tz, hash: t.hash })
        budget--
      }
    }
  }

  function tick(tick, players) {
    if (tick % STREAM_EVERY_TICKS !== 0) return
    if (!players.length) { clients.clear(); return }
    if (!collisionMirrorEnabled(getNetcodeConfig?.())) return
    if (!index) index = physics.enableStaticTiles?.() || null
    if (!index) return
    const now = performance.now()
    if (now - lastSweepAt > TILE_IDLE_SWEEP_MS) { index.sweep(now - TILE_IDLE_SWEEP_MS); lastSweepAt = now }
    for (const player of players) {
      const conn = connections.getClient?.(player.id) || null
      let c = clients.get(player.id)
      if (c && c.conn !== conn) c = null
      if (!c) {
        const cfg = characterConfig(physics, physicsIntegration, player.id)
        if (!cfg) continue
        c = { sent: new Map(), conn }
        clients.set(player.id, c)
        connections.send(player.id, MSG.COLLISION_CONFIG, { ...cfg, tileM: index.tileM, marginM: index.marginM, forgetRing: COLLISION_TILE_FORGET_RING })
      }
      streamTo(player, c, now)
    }
    if (clients.size > players.length) {
      const live = new Set(players.map(p => p.id))
      for (const id of clients.keys()) if (!live.has(id)) clients.delete(id)
    }
  }

  function reset(playerId) { clients.delete(playerId) }

  return { tick, reset, stats, getIndexStats: () => index?.stats || null }
}
