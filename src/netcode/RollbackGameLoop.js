import { canonicalJSON } from '../shared/canonicalJSON.js'

const DESYNC_LOG_LIMIT = 16
const TIME_SYNC_SLACK_TICKS = 2
const TIME_SYNC_YIELD_EVERY = 4

export const ROLLBACK_DEFAULTS = Object.freeze({ inputDelayTicks: 1, maxRollbackTicks: 12, checksumIntervalTicks: 30 })

export function createRollbackGameLoop({ tickSystem, transport, rollback, roster, localPeerId, simulate, getLocalInput, checksumOf = null, observeRollback = null, options = {} } = {}) {
  if (!tickSystem || typeof tickSystem.onTick !== 'function') throw new Error('[RollbackGameLoop] tickSystem is required')
  if (!transport || typeof transport.submitLocalInput !== 'function') throw new Error('[RollbackGameLoop] transport (RollbackInputTransport) is required')
  if (!rollback || typeof rollback.restore !== 'function') throw new Error('[RollbackGameLoop] rollback (RollbackLoop state ring) is required')
  if (!Array.isArray(roster) || !roster.includes(localPeerId)) throw new Error('[RollbackGameLoop] roster must list every peer pubkey including localPeerId')
  if (typeof simulate !== 'function' || typeof getLocalInput !== 'function') throw new Error('[RollbackGameLoop] simulate(tick, dt, inputsByPeer, resim) and getLocalInput() are required')
  const opts = { ...ROLLBACK_DEFAULTS, ...options }
  if (opts.maxRollbackTicks + opts.inputDelayTicks >= rollback.windowSize) throw new Error(`[RollbackGameLoop] maxRollbackTicks+inputDelayTicks (${opts.maxRollbackTicks + opts.inputDelayTicks}) must be < state ring window (${rollback.windowSize})`)

  const remotes = roster.filter(pk => pk !== localPeerId)
  const confirmed = new Map(roster.map(pk => [pk, new Map()]))
  const lastConfirmed = new Map(roster.map(pk => [pk, 0]))
  const used = new Map()
  const localChecksums = new Map(), remoteChecksums = new Map(), desyncLog = []
  const remoteAdvantage = new Map()
  let simTick = 0, dtS = 0, pendingRollbackFrom = null, nextChecksumTick = opts.checksumIntervalTicks
  const stats = { ticksSimulated: 0, stalls: 0, timeSyncYields: 0, rollbacks: 0, rollbackTicks: 0, maxRollbackDepth: 0, unrecoverableRollbacks: 0, predictedTicks: 0, mispredictions: 0, checksumsCompared: 0, desyncs: 0, firstDesyncTick: null }

  function confirm(peer, tick, input) {
    const m = confirmed.get(peer)
    if (!m || m.has(tick)) return false
    m.set(tick, input ?? null)
    let c = lastConfirmed.get(peer)
    while (m.has(c + 1)) c++
    lastConfirmed.set(peer, c)
    return true
  }

  function inputFor(peer, tick) {
    const m = confirmed.get(peer)
    if (m.has(tick)) return m.get(tick)
    const c = lastConfirmed.get(peer)
    return c > 0 ? m.get(c) : null
  }

  function inputsFor(tick) {
    const inputs = new Map(), keys = new Map()
    for (const pk of roster) {
      const inp = inputFor(pk, tick)
      inputs.set(pk, inp)
      keys.set(pk, canonicalJSON(inp))
      if (pk !== localPeerId && !confirmed.get(pk).has(tick)) stats.predictedTicks++
    }
    used.set(tick, keys)
    return inputs
  }

  function onRemoteInput(peer, tick, input, advantage = 0) {
    remoteAdvantage.set(peer, advantage)
    if (!confirm(peer, tick, input)) return
    const keys = used.get(tick)
    if (!keys || tick > simTick) return
    if (keys.get(peer) === canonicalJSON(input ?? null)) return
    stats.mispredictions++
    pendingRollbackFrom = pendingRollbackFrom == null ? tick : Math.min(pendingRollbackFrom, tick)
  }

  function onRemoteChecksum(peer, tick, checksum) {
    let row = remoteChecksums.get(tick)
    if (!row) { row = new Map(); remoteChecksums.set(tick, row) }
    row.set(peer, checksum)
    compareChecksums(tick)
  }

  function compareChecksums(tick) {
    const mine = localChecksums.get(tick), row = remoteChecksums.get(tick)
    if (mine == null || !row) return
    for (const [peer, cs] of row) {
      stats.checksumsCompared++
      if (cs !== mine) {
        stats.desyncs++
        if (stats.firstDesyncTick == null) stats.firstDesyncTick = tick
        if (desyncLog.length < DESYNC_LOG_LIMIT) desyncLog.push({ tick, peer, mine, theirs: cs })
      }
      row.delete(peer)
    }
  }

  transport.onRemoteInput = onRemoteInput
  transport.onRemoteChecksum = onRemoteChecksum

  function doRollback() {
    const from = pendingRollbackFrom
    pendingRollbackFrom = null
    if (!rollback.has(from - 1)) { stats.unrecoverableRollbacks++; return }
    const before = observeRollback ? observeRollback.before() : null
    rollback.restore(from - 1)
    const depth = simTick - from + 1
    for (let t = from; t <= simTick; t++) { simulate(t, dtS, inputsFor(t), true); rollback.save(t) }
    if (observeRollback) observeRollback.after(before, depth)
    stats.rollbacks++; stats.rollbackTicks += depth
    if (depth > stats.maxRollbackDepth) stats.maxRollbackDepth = depth
  }

  function minRemoteConfirmed() {
    let m = Infinity
    for (const pk of remotes) m = Math.min(m, lastConfirmed.get(pk))
    return m === Infinity ? simTick : m
  }

  function emitChecksums() {
    if (!checksumOf) return
    const settled = Math.min(minRemoteConfirmed(), simTick)
    while (nextChecksumTick <= settled) {
      const snap = rollback.get(nextChecksumTick)
      if (snap) {
        const cs = checksumOf(nextChecksumTick, snap)
        localChecksums.set(nextChecksumTick, cs)
        transport.submitChecksum(nextChecksumTick, cs)
        compareChecksums(nextChecksumTick)
      }
      nextChecksumTick += opts.checksumIntervalTicks
    }
    for (const t of localChecksums.keys()) if (t < settled - opts.checksumIntervalTicks * 8) { localChecksums.delete(t); remoteChecksums.delete(t) }
  }

  function submitLocal(tick) {
    const input = getLocalInput()
    confirm(localPeerId, tick, input)
    transport.submitLocalInput(tick, input, localAdvantage())
  }

  function localAdvantage() {
    return simTick - (minRemoteConfirmed() - opts.inputDelayTicks)
  }

  function shouldYieldForTimeSync(driverTick) {
    let remoteMax = -Infinity
    for (const pk of remotes) remoteMax = Math.max(remoteMax, remoteAdvantage.get(pk) ?? 0)
    if (remoteMax === -Infinity) return false
    return localAdvantage() - remoteMax > TIME_SYNC_SLACK_TICKS && driverTick % TIME_SYNC_YIELD_EVERY === 0
  }

  function prune() {
    const keep = simTick - rollback.windowSize
    for (const t of used.keys()) { if (t >= keep) break; used.delete(t) }
    for (const m of confirmed.values()) for (const t of m.keys()) { if (t >= keep - 1) break; m.delete(t) }
  }

  function onDriverTick(driverTick, dt) {
    dtS = dt
    if (pendingRollbackFrom != null) doRollback()
    if (simTick + 1 - minRemoteConfirmed() > opts.maxRollbackTicks) { stats.stalls++; emitChecksums(); return }
    if (shouldYieldForTimeSync(driverTick)) { stats.timeSyncYields++; emitChecksums(); return }
    const t = simTick + 1
    submitLocal(t + opts.inputDelayTicks)
    simulate(t, dt, inputsFor(t), false)
    simTick = t
    rollback.save(t)
    stats.ticksSimulated++
    emitChecksums()
    prune()
  }

  function start() {
    rollback.save(0)
    for (let t = 1; t <= opts.inputDelayTicks; t++) { confirm(localPeerId, t, null); transport.submitLocalInput(t, null) }
    tickSystem.onTick(onDriverTick)
    tickSystem.start()
  }

  return {
    start,
    stop() { tickSystem.stop() },
    get simTick() { return simTick },
    get options() { return { ...opts } },
    inspectTick(tick) { return { used: used.has(tick) ? Object.fromEntries(used.get(tick)) : null, checksum: localChecksums.get(tick) ?? null, snapshot: rollback.get(tick) ?? null } },
    getStats() { return { ...stats, desyncLog: [...desyncLog], simTick, runAhead: simTick - minRemoteConfirmed(), localAdvantage: localAdvantage(), remoteAdvantage: Object.fromEntries(remoteAdvantage), avgRollbackDepth: stats.rollbacks ? stats.rollbackTicks / stats.rollbacks : 0 } }
  }
}
