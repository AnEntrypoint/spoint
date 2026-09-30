import { LockstepTickSystem } from './LockstepTickSystem.js'
import { createRollbackLoop } from './RollbackLoop.js'
import { createRollbackGameLoop } from './RollbackGameLoop.js'
import { RollbackInputTransport } from './RollbackInputTransport.js'
import { createWorkerBridgeProxy } from './WorkerBridgeProxy.js'
import { checksumBodies, createChecksumFold } from './LockstepChecksum.js'
import { resolveNetcodeProfile, PEER_SIMULATED_PROFILES } from './NetcodeProfile.js'

const STATE_RING_TICKS = 32
const STATS_POST_INTERVAL_MS = 1000

function spawnFor(ctx, index) {
  const pts = ctx.worldSpawnPoints || [ctx.worldSpawnPoint || [0, 5, 0]]
  return [...pts[index % pts.length]]
}

export function createPeerSimSession(ctx, { roster, localPubkey, post }) {
  const profile = resolveNetcodeProfile(ctx.currentWorldDef)
  if (!PEER_SIMULATED_PROFILES.has(profile.name)) throw new Error(`[PeerSimSession] world netcode profile '${profile.name}' is not peer-simulated`)
  if (!Array.isArray(roster) || !roster.includes(localPubkey)) throw new Error('[PeerSimSession] roster must be an array of peer pubkeys including localPubkey')
  const { playerManager, networkState, physicsIntegration, physics, lagCompensator, connections } = ctx
  const sorted = [...roster].sort()
  const playerIdByPeer = new Map()
  const playerConfig = ctx.currentWorldDef?.player || {}
  sorted.forEach((pk, i) => {
    const sp = spawnFor(ctx, i)
    const id = playerManager.addPlayer(null, { position: sp, health: playerConfig.health })
    networkState.addPlayer(id, { position: sp })
    physicsIntegration.addPlayerCollider(id, playerConfig.capsuleRadius || 0.4)
    physicsIntegration.setPlayerPosition(id, sp)
    const st = playerManager.getPlayer(id).state
    lagCompensator.recordPlayerPosition(id, st.position, st.rotation, st.velocity, 0)
    playerIdByPeer.set(pk, id)
  })
  const localPlayerId = playerIdByPeer.get(localPubkey)
  const bridge = createWorkerBridgeProxy({ localPubkey, roster: sorted, post })
  let lastLocalInput = null

  function getLocalInput() {
    const q = playerManager.getInputs(localPlayerId)
    if (q.length) { lastLocalInput = q[q.length - 1].data; q.length = 0 }
    return lastLocalInput ? { ...lastLocalInput } : null
  }

  function toPlayerInputs(inputsByPeer) {
    const m = new Map()
    for (const [pk, inp] of inputsByPeer) m.set(playerIdByPeer.get(pk), inp)
    return m
  }

  function simulate(tick, dt, inputsByPeer, resim) {
    const explicit = toPlayerInputs(inputsByPeer)
    if (resim) { ctx.tickHandlerFn.simulateTick(tick, dt, playerManager.getConnectedPlayers(), explicit); return }
    ctx.handlerState.fn(tick, dt, explicit)
    connections.flushAll()
  }

  const recorders = Array.from({ length: STATE_RING_TICKS + 2 }, () => physics.createStateRecorder())

  function capture(tick) {
    const lastInputs = new Map()
    for (const p of playerManager.getConnectedPlayers()) lastInputs.set(p.id, p.lastInput ? { ...p.lastInput } : null)
    const exact = physics.saveExactState(recorders[tick % recorders.length])
    return { exact, bodies: physics.snapshotBodies(), players: playerManager.snapshotState(), lastInputs, sim: ctx.tickHandlerFn.snapshotSimState(), crouch: physicsIntegration.snapshotCrouchStates() }
  }

  function apply(snap) {
    physics.restoreExactState(snap.exact)
    playerManager.restoreState(snap.players)
    physicsIntegration.restoreCrouchStates(snap.crouch)
    ctx.tickHandlerFn.restoreSimState(snap.sim)
    for (const p of playerManager.getConnectedPlayers()) {
      p.lastInput = snap.lastInputs.get(p.id) ?? null
      const body = physicsIntegration.playerBodies.get(p.id)
      if (body) body.onGround = !!p.state.onGround
    }
  }

  function checksumOf(tick, snap) {
    const fold = createChecksumFold().pushInt(tick)
    fold.pushInt(parseInt(checksumBodies(tick, snap.bodies).slice(0, 8), 16))
    const ids = [...snap.players.keys()].sort((a, b) => a - b)
    for (const id of ids) {
      const s = snap.players.get(id).state
      fold.pushInt(id)
      for (const v of s.position) fold.push(v)
      for (const v of s.velocity) fold.push(v)
    }
    return fold.digest()
  }

  const corrections = { count: 0, sumM: 0, maxM: 0, remoteMaxM: 0, remoteSumM: 0 }
  const observeRollback = {
    before: () => new Map(playerManager.getConnectedPlayers().map(p => [p.id, [...p.state.position]])),
    after: (before) => {
      for (const p of playerManager.getConnectedPlayers()) {
        const b = before.get(p.id); if (!b) continue
        const d = Math.hypot(p.state.position[0] - b[0], p.state.position[1] - b[1], p.state.position[2] - b[2])
        corrections.count++; corrections.sumM += d; if (d > corrections.maxM) corrections.maxM = d
        if (p.id !== localPlayerId) { corrections.remoteSumM += d; if (d > corrections.remoteMaxM) corrections.remoteMaxM = d }
      }
    }
  }

  const tickSystem = new LockstepTickSystem(ctx.tickRate)
  let loop = null
  if (profile.name === 'rollback') {
    const transport = new RollbackInputTransport({ bridge })
    const rollback = createRollbackLoop({ capture, apply, windowSize: STATE_RING_TICKS })
    loop = createRollbackGameLoop({ tickSystem, transport, rollback, roster: sorted, localPeerId: localPubkey, simulate, getLocalInput, checksumOf, observeRollback, options: profile.options })
    loop.transport = transport
  }
  if (!loop) throw new Error(`[PeerSimSession] no peer loop for netcode profile '${profile.name}'`)

  let statsTimer = null
  return {
    profile,
    loop,
    localPlayerId,
    playerIdByPeer,
    bridge,
    claimLocalPlayer(transport) {
      const p = playerManager.getPlayer(localPlayerId)
      if (p) p.socket = transport
      return localPlayerId
    },
    start() {
      loop.start()
      statsTimer = setInterval(() => post({ type: 'PEER_STATS', stats: this.getStats() }), STATS_POST_INTERVAL_MS)
    },
    stop() {
      loop?.stop()
      if (statsTimer) clearInterval(statsTimer)
      for (const r of recorders) physics.destroyStateRecorder(r)
      recorders.length = 0
    },
    getStats() { return { profile: profile.name, options: profile.options, localPlayerId, loop: loop.getStats(), corrections: { ...corrections }, transport: loop.transport?.getStats?.() } }
  }
}
