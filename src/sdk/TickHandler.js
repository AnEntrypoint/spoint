import { MSG } from '../protocol/MessageTypes.js'
import { SnapshotEncoder } from '../netcode/SnapshotEncoder.js'
import { applyMovement } from '../shared/movement.js'
import { SnapshotSystem } from './systems/SnapshotSystem.js'

const KEYFRAME_INTERVAL = 1280
const MAX_SENDS_PER_TICK = 25

export function createTickHandler(deps) {
  const { networkState, playerManager, physicsIntegration, lagCompensator, physics, appRuntime, connections, movement: m = {}, stageLoader, getRelevanceRadius } = deps
  const movement = { maxSpeed: 8.0, groundAccel: 10.0, airAccel: 1.0, friction: 6.0, stopSpeed: 2.0, jumpImpulse: 4.5, ...m }
  let grid = new Map(), gridCells = new Map(), profileLog = 0
  const snapSystem = new SnapshotSystem({ ...deps, SnapshotEncoder, getRelevanceRadius })

  return function onTick(tick, dt) {
    const t0 = performance.now(); const nowS = Date.now(); networkState.setTick(tick, nowS); const players = playerManager.getConnectedPlayers(); const nP = players.length
    for (let i = 0; i < nP; i++) {
      const p = players[i], pid = p.id, inputs = p.inputBuffer, st = p.state
      if (inputs && inputs.length > 0) { p.lastInput = inputs[inputs.length - 1].data; inputs.length = 0 }
      const inp = p.lastInput || null; let cy, sy
      if (inp) {
        const yaw = inp.yaw || 0, hy = yaw * 0.5; sy = Math.sin(hy); cy = Math.cos(hy)
        const rot = st.rotation; rot[0] = 0; rot[1] = sy; rot[2] = 0; rot[3] = cy
        st.crouch = inp.crouch ? 1 : 0; st.lookPitch = inp.pitch || 0; st.lookYaw = yaw
        applyMovement(st, inp, movement, dt, cy*cy-sy*sy, 2*sy*cy)
        physicsIntegration.setCrouch(pid, !!inp.crouch)
      } else { applyMovement(st, null, movement, dt) }
      const vel = st.velocity, wVx = vel[0], wVz = vel[2]
      const updated = physicsIntegration.updatePlayerPhysics(pid, st, dt)
      const uVel = updated.velocity
      vel[0] = wVx; vel[1] = uVel[1]; vel[2] = wVz
      lagCompensator.recordPlayerPosition(pid, st.position, st.rotation, vel, tick, p)
      const nsp = networkState.players.get(pid)
      if (nsp) {
        const np = nsp.position, nr = nsp.rotation, nv = nsp.velocity, sp = st.position, sr = st.rotation
        np[0] = sp[0]; np[1] = sp[1]; np[2] = sp[2]
        nr[0] = sr[0]; nr[1] = sr[1]; nr[2] = sr[2]; nr[3] = sr[3]
        nv[0] = vel[0]; nv[1] = vel[1]; nv[2] = vel[2]
        nsp.onGround = st.onGround; nsp.health = st.health; nsp.inputSequence = p.inputSequence
        nsp.crouch = st.crouch || 0; nsp.lookPitch = st.lookPitch || 0; nsp.lookYaw = st.lookYaw || 0
      }
    }
    const t1 = performance.now(); const cellSz = (physicsIntegration.config.capsuleRadius || 0.4) * 8, minDist = (physicsIntegration.config.capsuleRadius || 0.4) * 2, minDist2 = minDist * minDist; grid.clear()
    for (let i = 0; i < nP; i++) { const p = players[i], cx = Math.floor(p.state.position[0] / cellSz), cz = Math.floor(p.state.position[2] / cellSz), ck = cx * 65536 + cz; let c = grid.get(ck); if (!c) { c = gridCells.get(ck); if (!c) { c = []; gridCells.set(ck, c) } else { c.length = 0 }; grid.set(ck, c) }; c.push(p) }
    for (let i = 0; i < nP; i++) {
      const p = players[i], px = p.state.position[0], py = p.state.position[1], pz = p.state.position[2], cx = Math.floor(px / cellSz), cz = Math.floor(pz / cellSz)
      for (let dx = -1; dx <= 1; dx++) { for (let dz = -1; dz <= 1; dz++) {
        const neighbors = grid.get((cx + dx) * 65536 + (cz + dz)); if (!neighbors) continue; for (let j = 0; j < neighbors.length; j++) {
          const o = neighbors[j]; if (o.id <= p.id) continue; const ox = o.state.position[0], oy = o.state.position[1], oz = o.state.position[2], ddx = ox - px, ddy = oy - py, ddz = oz - pz, d2 = ddx*ddx + ddy*ddy + ddz*ddz; if (d2 >= minDist2 || d2 === 0) continue
          const dist = Math.sqrt(d2), nx = ddx / dist, nz = ddz / dist, overlap = minDist - dist, half = overlap * 0.5, push = Math.min(half / dt, 3.0); p.state.position[0] -= nx * half; p.state.position[2] -= nz * half; p.state.velocity[0] -= nx * push; p.state.velocity[2] -= nz * push; o.state.position[0] += nx * half; o.state.position[2] += nz * half; o.state.velocity[0] += nx * push; o.state.velocity[2] += nz * push; physicsIntegration.setPlayerPosition(p.id, p.state.position); physicsIntegration.setPlayerPosition(o.id, o.state.position)
        }
      } }
    }
    const t2 = performance.now(); physics.step(dt); const t3 = performance.now(); appRuntime.tick(tick, dt, grid); const t4 = performance.now()
    if (nP > 0) { const playerSnap = networkState.getSnapshot(), preEncPlayers = SnapshotEncoder.encodePlayers(playerSnap.players); snapSystem.snapshotSeq++; snapSystem.send(tick, players, playerSnap, preEncPlayers, Math.max(1, Math.ceil(nP / MAX_SENDS_PER_TICK)), tick % Math.max(1, Math.ceil(nP / MAX_SENDS_PER_TICK)), snapSystem.snapshotSeq % KEYFRAME_INTERVAL === 0, grid) }
    snapSystem.cleanup(playerManager); const t5 = performance.now(); if (t5 - t4 > 8) console.warn(`[TickHandler] Slow snapshot phase: ${(t5 - t4).toFixed(2)}ms`); try { appRuntime._drainReloadQueue() } catch (e) { console.error('[TickHandler] reload queue error:', e.message) }
    if (++profileLog % 1280 === 0) { const total = t5 - t0; const mem = process.memoryUsage(); console.log(`[tick-profile] tick:${tick} players:${nP} entities:${appRuntime.entities.size} total:${total.toFixed(2)}ms | mv:${(t1 - t0).toFixed(2)} col:${(t2 - t1).toFixed(2)} phys:${(t3 - t2).toFixed(2)} app:${(t4 - t3).toFixed(2)} snap:${(t5 - t4).toFixed(2)} | heap:${(mem.heapUsed / 1048576).toFixed(1)}MB rss:${(mem.rss / 1048576).toFixed(1)}MB`) }
  }
}
