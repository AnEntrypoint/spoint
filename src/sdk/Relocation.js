import { MSG } from '../protocol/MessageTypes.js'
import { resolveTarget } from '../shared/relocation.js'
import { beginTeleportHold } from '../netcode/TeleportHold.js'
import { spawnSurfaceY } from '../shared/SpawnSurface.js'

const SNAP_RAY_START_ABOVE = 20
const SNAP_RAY_LENGTH = 2000
const PROBE_RAY_START_ABOVE = 50
const PROBE_RAY_LENGTH = 4000
const SPAWN_CLEARANCE = 2
const FALLBACK_STANDING_OFFSET = 1.4
const SPAWN_STATIC_WAIT_RADIUS = 256
const SPAWN_HOLD_MAX_MS = 20000
const SPAWN_HOLD_MOVED_EPS = 0.01

function terrainY(physics, x, z) {
  const y = typeof physics?.terrainHeightAt === 'function' ? physics.terrainHeightAt(x, z) : null
  return Number.isFinite(y) ? y : null
}

export function snapToGround(ctx, x, hintY, z, clearance, snap = 'first') {
  const physics = ctx.physics
  const liveY = terrainY(physics, x, z)
  if (snap === 'terrain' && liveY !== null) return [x, liveY + clearance, z]
  if (physics && typeof physics.raycast === 'function') {
    const heightHint = liveY !== null ? Math.max(hintY, liveY) : hintY
    if (Number.isFinite(heightHint)) {
      const hit = physics.raycast([x, heightHint + SNAP_RAY_START_ABOVE, z], [0, -1, 0], SNAP_RAY_LENGTH)
      if (hit && hit.hit && Number.isFinite(hit.position?.[1])) return [x, hit.position[1] + clearance, z]
    }
  }
  if (liveY !== null) return [x, liveY + clearance, z]
  return Number.isFinite(hintY) ? [x, hintY, z] : null
}

export function probeSpawnGroundY(ctx, sp) {
  const physics = ctx.physics
  if (!physics || typeof physics.raycast !== 'function') return null
  const standingOffset = ctx.physicsIntegration?.standingCentreY?.(0)
  return spawnSurfaceY((o, d, l) => physics.raycast(o, d, l), sp, {
    standingOffset: standingOffset > 0 ? standingOffset : FALLBACK_STANDING_OFFSET,
    terrainY: terrainY(physics, sp[0], sp[2]),
    radius: ctx.physicsIntegration?.config?.capsuleRadius || 0,
  })
}

export function groundSnapSpawnPoint(ctx, sp) {
  const groundY = probeSpawnGroundY(ctx, sp)
  return groundY !== null ? [sp[0], groundY + SPAWN_CLEARANCE, sp[2]] : sp
}

function staticCollidersPendingNear(ctx, p) {
  const runtime = ctx.appRuntime
  if (runtime?._pendingTrimeshBuilds?.size > 0) return true
  const pending = runtime?._pendingTrimeshEntities
  if (!pending || pending.size === 0) return false
  for (const ent of pending.values()) {
    const e = ent.position || [0, 0, 0]
    if (Math.hypot(e[0] - p[0], e[2] - p[2]) <= SPAWN_STATIC_WAIT_RADIUS) return true
  }
  return false
}

export function holdSpawnUntilGrounded(ctx, playerId, sp, { rejoin = false } = {}) {
  const player = ctx.playerManager.getPlayer(playerId)
  if (!player) return
  const probeGroundY = () => {
    if (staticCollidersPendingNear(ctx, sp)) return null
    if (!rejoin) return probeSpawnGroundY(ctx, sp)
    if (!ctx.physics || typeof ctx.physics.raycast !== 'function') return null
    const r = ctx.physics.raycast([sp[0], sp[1], sp[2]], [0, -1, 0], SNAP_RAY_LENGTH)
    return r && r.hit && Number.isFinite(r.position?.[1]) ? r.position[1] : null
  }
  beginTeleportHold(player, {
    maxMs: SPAWN_HOLD_MAX_MS,
    probeGroundY,
    onRelease: ({ groundY }) => {
      if (rejoin) return
      const p = player.state.position
      const movedDuringHold = Math.abs(p[0] - sp[0]) + Math.abs(p[1] - sp[1]) + Math.abs(p[2] - sp[2]) > SPAWN_HOLD_MOVED_EPS
      if (movedDuringHold) return
      const y = groundY !== null ? groundY : probeSpawnGroundY(ctx, sp)
      if (y === null) return
      placePlayerAt(ctx, playerId, [sp[0], ctx.physicsIntegration.standingCentreY(y), sp[2]])
    },
  })
}

function placePlayerAt(ctx, playerId, position) {
  const { playerManager, physicsIntegration, lagCompensator, appRuntime } = ctx
  const player = playerManager.getPlayer(playerId)
  if (!player) return
  const st = player.state
  st.position[0] = position[0]; st.position[1] = position[1]; st.position[2] = position[2]
  st.velocity[0] = 0; st.velocity[1] = 0; st.velocity[2] = 0
  st.onGround = false
  st.swimming = false
  physicsIntegration.setPlayerPosition(playerId, position)
  const charId = physicsIntegration.playerBodies.get(playerId)?.charId
  if (charId && physicsIntegration.physicsWorld) physicsIntegration.physicsWorld.setCharacterVelocity(charId, [0, 0, 0])
  playerManager.clearInputs(playerId)
  player.lastInput = null
  lagCompensator.clearPlayerHistory(playerId)
  appRuntime.broadcastMessage({ type: 'player_teleport', playerId, position: [...position] })
}

export function probeGround(ctx, x, z, fromY) {
  const physics = ctx.physics
  if (!physics || typeof physics.raycast !== 'function') return { hit: false, error: 'physics not ready' }
  const liveY = terrainY(physics, x, z)
  const startY = Number.isFinite(fromY) ? fromY : (liveY ?? 0) + PROBE_RAY_START_ABOVE
  const r = physics.raycast([x, startY, z], [0, -1, 0], PROBE_RAY_LENGTH)
  return { hit: !!(r && r.hit), y: r && r.hit ? r.position[1] : null, terrainY: liveY }
}

export function teleportPlayer(ctx, playerId, spec, { onGrounded = null } = {}) {
  const player = ctx.playerManager.getPlayer(playerId)
  if (!player) throw new Error(`teleport: no player ${playerId}`)
  const physics = ctx.physics
  const frame = physics?._planetFrame || null
  const heightAt = physics && typeof physics.terrainHeightAt === 'function' ? (x, z) => physics.terrainHeightAt(x, z) : undefined
  const target = resolveTarget(spec, { frame, heightAt })
  let position
  const standY = target.standNearY !== null ? probeSpawnGroundY(ctx, [target.x, target.standNearY, target.z]) : null
  if (target.y !== null) position = [target.x, target.y, target.z]
  else if (standY !== null) position = [target.x, ctx.physicsIntegration.standingCentreY(standY), target.z]
  else if (target.standNearY !== null) position = [target.x, target.standNearY, target.z]
  else {
    position = snapToGround(ctx, target.x, Number.NEGATIVE_INFINITY, target.z, target.clearance, target.snap)
    if (!position) throw new Error('teleport: no terrain height at target and no explicit y')
  }
  placePlayerAt(ctx, playerId, position)
  beginTeleportHold(player, { onRelease: (release) => onGrounded?.(release) })
  return { position, tick: ctx.tickSystem.currentTick }
}

export function createRelocationHandlers(ctx) {
  const { connections } = ctx

  function handle(payload, clientId) {
    const reqId = Number.isSafeInteger(payload?.reqId) ? payload.reqId : null
    const op = payload?.op === 'probe' ? 'probe' : 'to'
    const reply = (body) => connections.send(clientId, MSG.TELEPORT_ACK, { reqId, op, ...body })
    if (ctx.currentWorldDef?.relocation === false) { reply({ ok: false, error: 'relocation disabled by this world (relocation: false)' }); return }
    if (ctx.peerSession && op === 'to') { reply({ ok: false, error: `relocation would desync the '${ctx.peerSession.profile?.name}' peer-simulated session: a teleport is not a peer input` }); return }
    try {
      if (op === 'probe') {
        if (!Number.isFinite(payload.x) || !Number.isFinite(payload.z)) throw new Error('probe needs finite x and z')
        const self = ctx.playerManager.getPlayer(clientId)
        reply({ ok: true, ...probeGround(ctx, payload.x, payload.z, payload.fromY), player: self ? [...self.state.position] : null, held: !!self?.teleportHold })
        return
      }
      const { position, tick } = teleportPlayer(ctx, clientId, payload, {
        onGrounded: (release) => {
          const held = ctx.playerManager.getPlayer(clientId)
          if (held) reply({ ok: true, phase: 'grounded', position: [...held.state.position], ...release })
        }
      })
      reply({ ok: true, phase: 'placed', position, velocity: [0, 0, 0], tick })
    } catch (e) {
      reply({ ok: false, error: e.message })
    }
  }

  return { [MSG.TELEPORT]: handle }
}
