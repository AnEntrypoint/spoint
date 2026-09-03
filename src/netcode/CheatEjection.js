export function wireCheatEjection({ voter, transport, hostMigration, onEjected = null }) {
  if (!voter || typeof voter.getStats !== 'function') throw new Error('[CheatEjection] voter (ConsensusVoter) is required')
  if (!transport || typeof transport.dropPeer !== 'function') throw new Error('[CheatEjection] transport (LockstepInputTransport) is required')

  voter.onCheatingPeer = (peerPubkey, evidence) => {
    transport.dropPeer(peerPubkey)
    if (onEjected) onEjected(peerPubkey, { ...evidence, isHost: false })
  }

  voter.onCheatingHost = (hostPubkey, evidence) => {
    transport.dropPeer(hostPubkey)
    if (hostMigration && typeof hostMigration.forceElection === 'function') hostMigration.forceElection()
    if (onEjected) onEjected(hostPubkey, { ...evidence, isHost: true })
  }

  return {
    destroy() { voter.onCheatingPeer = null; voter.onCheatingHost = null },
  }
}
