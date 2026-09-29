import { MSG } from '../protocol/MessageTypes.js'
import { resolveTarget } from '../shared/relocation.js'
import { beginTeleportHold } from '../netcode/TeleportHold.js'

const SNAP_RAY_START_ABOVE = 20
const SNAP_RAY_LENGTH = 2000
const PROBE_RAY_START_ABOVE = 50
const PROBE_RAY_LENGTH = 4000
const SPAWN_CLEARANCE = 2

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

export function groundSnapSpawnPoint(ctx, sp) {
  return snapToGround(ctx, sp[0], sp[1], sp[2], SPAWN_CLEARANCE) || sp
}

export function probeGround(ctx, x, z, fromY) {
  const physics = ctx.physics
  if (!physics || typeof physics.raycast !== 'function') return { hit: false, error: 'physics not ready' }
  const liveY = terrainY(physics, x, z)
  const startY = Number.isFinite(fromY) ? fromY : (liveY ?? 0) + PROBE_RAY_START_ABOVE
  const r = physics.raycast([x, startY, z], [0, -1, 0], PROBE_RAY_LENGTH)
  return { hit: !!(r && r.hit), y: r && r.hit ? r.position[1] : null, terrainY: liveY }
}

export function teleportPlayer(ctx, playerId, spec, { onGrounded } = {}) {
  const { playerManager, physicsIntegration, lagCompensator, appRuntime, tickSystem } = ctx
  const player = playerManager.getPlayer(playerId)
  if (!player) throw new Error(`teleport: no player ${playerId}`)
  const physics = ctx.physics
  const frame = physics?._planetFrame || null
  const heightAt = physics && typeof physics.terrainHeightAt === 'function' ? (x, z) => physics.terrainHeightAt(x, z) : undefined
  const target = resolveTarget(spec, { frame, heightAt })
  let position
  if (target.y !== null) position = [target.x, target.y, target.z]
  else {
    position = snapToGround(ctx, target.x, Number.NEGATIVE_INFINITY, target.z, target.clearance, target.snap)
    if (!position) throw new Error('teleport: no terrain height at target and no explicit y')
  }
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
  beginTeleportHold(player, { onRelease: (release) => onGrounded?.(release) })
  appRuntime.broadcastMessage({ type: 'player_teleport', playerId, position: [...position] })
  return { position, tick: tickSystem.currentTick }
}

export function createRelocationHandlers(ctx) {
  const { connections } = ctx

  function handle(payload, clientId) {
    const reqId = Number.isSafeInteger(payload?.reqId) ? payload.reqId : null
    const op = payload?.op === 'probe' ? 'probe' : 'to'
    const reply = (body) => connections.send(clientId, MSG.TELEPORT_ACK, { reqId, op, ...body })
    if (ctx.currentWorldDef?.relocation === false) { reply({ ok: false, error: 'relocation disabled by this world (relocation: false)' }); return }
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
