import { snapshotChart, createChartTransfer } from '../shared/chartAnchor.js'
import { createReexpressPass, clampTiltInducedUpward } from '../shared/chartReexpress.js'

export class ClusterHandoffError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'ClusterHandoffError'
    this.code = code
  }
}

function frameOf(server) {
  const frame = server.physics?._planetFrame
  if (!frame) throw new ClusterHandoffError('handoff-needs-planet-frame', 'the world has no terrain planet frame, so there is no chart to transfer between')
  return frame
}

export function exportPlayerHandoff(server, playerId) {
  const player = server.playerManager.getPlayer(playerId)
  if (!player) throw new ClusterHandoffError('handoff-unknown-player', `player ${playerId} is not in this world`)
  const s = player.state
  return {
    chart: snapshotChart(frameOf(server)),
    name: player.name,
    tick: server.tickSystem.currentTick,
    state: structuredClone({ position: s.position, velocity: s.velocity, rotation: s.rotation, lookYaw: s.lookYaw, lookPitch: s.lookPitch, onGround: s.onGround, groundNormal: s.groundNormal, health: s.health }),
    lastInput: player.lastInput ? structuredClone(player.lastInput) : null,
  }
}

export async function admitPlayerHandoff(server, handoff) {
  const transfer = createChartTransfer(handoff.chart, snapshotChart(frameOf(server)))
  const pass = createReexpressPass(transfer)
  const state = structuredClone(handoff.state)
  pass.point(state.position)
  pass.vector(state.velocity)
  if (state.onGround && state.groundNormal) pass.vector(state.groundNormal)
  pass.look(state, 'lookYaw', 'lookPitch')
  pass.yawRotation(state.rotation)
  if (state.onGround) clampTiltInducedUpward(transfer, state.velocity)
  const lastInput = handoff.lastInput ? structuredClone(handoff.lastInput) : null
  if (lastInput) pass.look(lastInput)
  const streamer = server.physics?._terrainStreamer
  if (streamer?.cover) await streamer.cover([[state.position[0], state.position[2]]])
  const token = server.sessions.create(null, { ...state, name: handoff.name })
  return { token, state, lastInput, transfer }
}

export function playerIdOfSession(server, token) {
  for (const player of server.playerManager.players.values()) if (server.connections.getClient(player.id)?.sessionToken === token) return player.id
  return null
}

export function applyAdmittedInputs(server, token, lastInput) {
  const id = playerIdOfSession(server, token)
  if (id === null) throw new ClusterHandoffError('handoff-session-not-joined', 'the admitted session has no connected player yet')
  if (lastInput) server.playerManager.getPlayer(id).lastInput = lastInput
  return id
}

export function releaseHandoffSource(server, playerId) {
  const client = server.connections.getClient(playerId)
  if (client?.sessionToken) server.sessions.destroy(client.sessionToken)
  client?.transport?.close()
}
