import { createRollbackLoop } from './RollbackLoop.js'
import { createRollbackGameLoop } from './RollbackGameLoop.js'
import { RollbackInputTransport } from './RollbackInputTransport.js'
import { createLockstepGameLoop } from './LockstepGameLoop.js'
import { LockstepInputTransport } from './LockstepInputTransport.js'
import { ConsensusVoter } from './ConsensusVoter.js'
import { wireCheatEjection } from './CheatEjection.js'

export const PEER_LOOP_FACTORIES = Object.freeze({
  rollback: ({ bridge, tickSystem, roster, localPeerId, simulate, getLocalInput, checksumOf, observeRollback, capture, apply, stateRingTicks, options }) => {
    const transport = new RollbackInputTransport({ bridge })
    const rollback = createRollbackLoop({ capture, apply, windowSize: stateRingTicks })
    const loop = createRollbackGameLoop({ tickSystem, transport, rollback, roster, localPeerId, simulate, getLocalInput, checksumOf, observeRollback, options })
    return { loop, transport, voter: null }
  },
  lockstep: ({ bridge, tickSystem, roster, localPeerId, simulate, getLocalInput, liveChecksum, options }) => {
    const transport = new LockstepInputTransport({ bridge })
    const voter = new ConsensusVoter({ bridge, checksumOf: liveChecksum, localPeerId, expectedPeerIds: roster, checksumIntervalTicks: options.checksumIntervalTicks })
    const loop = createLockstepGameLoop({ tickSystem, transport, roster, localPeerId, simulate: (t, dt, byPeer) => simulate(t, dt, byPeer, false), getLocalInput, voter, options })
    wireCheatEjection({ voter, transport: loop })
    return { loop, transport, voter }
  }
})

export const PEER_SIMULATED_PROFILES = new Set(Object.keys(PEER_LOOP_FACTORIES))
