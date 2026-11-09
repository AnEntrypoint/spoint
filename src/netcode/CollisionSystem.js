let _pruneTick = 0

const SEPARATION_PUSH_VELOCITY_CAP = 3.0
export const COLLISION_LAG_INPUTS = 16

export function separationPush(dx, dy, dz, minDist, dt, out) {
  const dist2 = dx * dx + dy * dy + dz * dz
  if (dist2 >= minDist * minDist || dist2 === 0) return false
  const dist = Math.sqrt(dist2), nx = dx / dist, nz = dz / dist
  const halfPush = (minDist - dist) * 0.5, pushVel = Math.min(halfPush / dt, SEPARATION_PUSH_VELOCITY_CAP)
  out[0] = nx * halfPush; out[1] = nz * halfPush; out[2] = nx * pushVel; out[3] = nz * pushVel
  return true
}

const push = [0, 0, 0, 0]

function pushQueueOf(player) {
  if (!player.pushQueue) player.pushQueue = new Array(COLLISION_LAG_INPUTS).fill(null)
  return player.pushQueue
}

export function advancePushQueue(player, physicsIntegration) {
  const queue = pushQueueOf(player)
  queue.push(player.pendingPush || null)
  player.pendingPush = null
  const due = queue.shift()
  if (!due) return
  const p = player.state.position, v = player.state.velocity
  p[0] += due[0]; p[2] += due[1]; v[0] += due[2]; v[2] += due[3]
  physicsIntegration.setPlayerPosition(player.id, p)
}

export function planPlayerCollisions(players, grid, gridCells, cellSz, minDist2, minDist, dt) {
  grid.clear()
  for (const p of players) {
    const cx = Math.floor(p.state.position[0] / cellSz), cz = Math.floor(p.state.position[2] / cellSz), ck = cx * 65536 + cz
    let cell = grid.get(ck)
    if (!cell) { cell = gridCells.get(ck); if (!cell) { cell = []; gridCells.set(ck, cell) } else { cell.length = 0 }; grid.set(ck, cell) }
    cell.push(p)
  }
  if ((++_pruneTick & 63) === 0 || gridCells.size > players.length * 4) {
    for (const k of gridCells.keys()) { if (!grid.has(k)) gridCells.delete(k) }
  }
  for (const player of players) {
    const px = player.state.position[0], py = player.state.position[1], pz = player.state.position[2]
    const cx = Math.floor(px / cellSz), cz = Math.floor(pz / cellSz)
    for (let ddx = -1; ddx <= 1; ddx++) for (let ddz = -1; ddz <= 1; ddz++) {
      const neighbors = grid.get((cx + ddx) * 65536 + (cz + ddz))
      if (!neighbors) continue
      for (const other of neighbors) {
        if (other.id <= player.id) continue
        const ox = other.state.position[0], oy = other.state.position[1], oz = other.state.position[2]
        const dx = ox - px, dy = oy - py, dz = oz - pz
        if (dx * dx + dy * dy + dz * dz >= minDist2 || !separationPush(dx, dy, dz, minDist, dt, push)) continue
        const a = player.pendingPush || (player.pendingPush = [0, 0, 0, 0])
        a[0] -= push[0]; a[1] -= push[1]; a[2] -= push[2]; a[3] -= push[3]
        const b = other.pendingPush || (other.pendingPush = [0, 0, 0, 0])
        b[0] += push[0]; b[1] += push[1]; b[2] += push[2]; b[3] += push[3]
      }
    }
  }
}

export function pushWindowOf(player) {
  return pushQueueOf(player).slice(0, COLLISION_LAG_INPUTS)
}

export function resetPushQueue(player) {
  pushQueueOf(player).fill(null)
  player.pendingPush = null
}
