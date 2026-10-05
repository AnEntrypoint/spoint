import { clampTiltInducedUpward } from '../../shared/chartReexpress.js'

function reexpressPlayerState(pass, state) {
  pass.point(state.position)
  pass.vector(state.velocity)
  if (state.onGround) pass.vector(state.groundNormal)
  pass.clear(state.wallNormals)
  pass.look(state, 'lookYaw', 'lookPitch')
  pass.yawRotation(state.rotation)
}

function reexpressBufferedInputs(pass, inputs) {
  for (const input of inputs) pass.look(input.data)
}

function reexpressNetworkPlayer(pass, networkPlayer) {
  pass.point(networkPlayer.position)
  pass.vector(networkPlayer.velocity)
  if (networkPlayer.onGround) pass.vector(networkPlayer.groundNormal)
  pass.clear(networkPlayer.wallNormals)
  pass.look(networkPlayer, 'lookYaw', 'lookPitch')
  pass.yawRotation(networkPlayer.rotation)
}

export function createPlayerMigrator({ playerManager, networkState, lagCompensator, physicsIntegration }) {
  return function migratePlayers({ transfer }, pass) {
    const counts = { players: 0, bufferedInputs: 0, networkPlayers: 0, lagSamples: 0, characters: 0 }
    for (const player of playerManager.players.values()) {
      reexpressPlayerState(pass, player.state)
      pass.look(player.lastInput)
      const buffered = playerManager.getInputs(player.id)
      reexpressBufferedInputs(pass, buffered)
      counts.players++
      counts.bufferedInputs += buffered.length
    }
    for (const networkPlayer of networkState.players.values()) {
      reexpressNetworkPlayer(pass, networkPlayer)
      counts.networkPlayers++
    }
    counts.lagSamples = lagCompensator.applyChartTransfer(transfer)
    const physicsWorld = physicsIntegration.physicsWorld
    const groundedClamp = physicsWorld?._charMgr?.applyChartTransfer(transfer)
    if (groundedClamp) Object.assign(counts, groundedClamp, { stateVelocityClamped: 0 })
    for (const player of playerManager.players.values()) {
      const charId = physicsIntegration.playerBodies.get(player.id)?.charId
      if (charId == null || !physicsWorld.getCharacterGroundState(charId)) continue
      if (clampTiltInducedUpward(transfer, player.state.velocity)) counts.stateVelocityClamped++
    }
    return counts
  }
}
