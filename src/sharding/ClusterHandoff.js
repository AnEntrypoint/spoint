import { MSG } from '../protocol/MessageTypes.js'
import { snapshotChart, createChartTransfer } from '../shared/chartAnchor.js'
import { createReexpressPass, clampTiltInducedUpward } from '../shared/chartReexpress.js'
import { parseSessionToken, SESSION_TOKEN_MALFORMED } from './RegionRouter.js'

export const CLUSTER_LOCAL_PLAYER_ID_MALFORMED = 'cluster-local-player-id-malformed'
export const HANDOFF_UNKNOWN_CLUSTER_LOCAL_PLAYER = 'handoff-unknown-cluster-local-player'
export const HANDOFF_SESSION_NOT_JOINED = 'handoff-session-not-joined'

export function parseClusterLocalPlayerId(value) {
  if (!Number.isInteger(value) || value < 0) return { ok: false, reason: CLUSTER_LOCAL_PLAYER_ID_MALFORMED, value: value ?? null }
  return { ok: true, clusterLocalPlayerId: value }
}

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

export function exportPlayerHandoff(server, clusterLocalPlayerId) {
  const parsed = parseClusterLocalPlayerId(clusterLocalPlayerId)
  if (!parsed.ok) throw new ClusterHandoffError(parsed.reason, `clusterLocalPlayerId ${JSON.stringify(parsed.value)} is not a cluster-world-local player id`)
  const id = parsed.clusterLocalPlayerId
  const player = server.playerManager.getPlayer(id)
  if (!player) throw new ClusterHandoffError(HANDOFF_UNKNOWN_CLUSTER_LOCAL_PLAYER, `clusterLocalPlayerId ${id} is not in this world`)
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

export function parsePlayerIdOfSession(server, token) {
  const parsedToken = parseSessionToken(token)
  if (!parsedToken.ok) return { ok: false, reason: parsedToken.reason, sessionToken: parsedToken.value }
  if (parsedToken.sessionToken === null) return { ok: false, reason: SESSION_TOKEN_MALFORMED, sessionToken: null }
  for (const player of server.playerManager.players.values()) {
    if (server.connections.getClient(player.id)?.sessionToken === parsedToken.sessionToken) {
      return { ok: true, clusterLocalPlayerId: player.id, sessionToken: parsedToken.sessionToken }
    }
  }
  return { ok: false, reason: HANDOFF_SESSION_NOT_JOINED, sessionToken: parsedToken.sessionToken }
}

export function applyAdmittedInputs(server, token, lastInput) {
  const parsed = parsePlayerIdOfSession(server, token)
  if (!parsed.ok) throw new ClusterHandoffError(parsed.reason, `session token ${JSON.stringify(parsed.sessionToken)} names no connected player in this world`)
  const id = parsed.clusterLocalPlayerId
  if (lastInput) server.playerManager.getPlayer(id).lastInput = lastInput
  return id
}

export function releaseHandoffSource(server, clusterLocalPlayerId, destination = null) {
  const parsed = parseClusterLocalPlayerId(clusterLocalPlayerId)
  if (!parsed.ok) throw new ClusterHandoffError(parsed.reason, `clusterLocalPlayerId ${JSON.stringify(parsed.value)} is not a cluster-world-local player id`)
  const id = parsed.clusterLocalPlayerId
  const client = server.connections.getClient(id)
  const token = client?.sessionToken
  if (destination?.url && destination?.sessionToken && client) {
    server.connections.send(id, MSG.CLUSTER_HANDOFF, { url: destination.url, sessionToken: destination.sessionToken, clusterId: destination.clusterId ?? null })
    if (token) server.sessions.destroy(token)
    return
  }
  if (token) server.sessions.destroy(token)
  client?.transport?.close()
}
