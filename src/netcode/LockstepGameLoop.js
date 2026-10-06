import { canonicalJSON } from '../shared/canonicalJSON.js'

export const LOCKSTEP_DEFAULTS = Object.freeze({ inputDelayTicks: 3, checksumIntervalTicks: 30, stallTicks: 600, maxCatchUpTicks: 4 })
export const INPUT_RETAIN_TICKS = 240
const LATENCY_RING = 1024
const DROP_LOG_LIMIT = 16
const TIME_SYNC_SLACK_TICKS = 2
const TIME_SYNC_YIELD_EVERY = 4
const ADVANTAGE_SMOOTHING = 0.05

export function createLockstepGameLoop({ tickSystem, transport, roster, localPeerId, simulate, getLocalInput, voter = null, options = {}, now = () => performance.now() } = {}) {
  if (!tickSystem || typeof tickSystem.onTick !== 'function') throw new Error('[LockstepGameLoop] tickSystem is required')
  if (!transport || typeof transport.submitLocalInput !== 'function' || typeof transport.submitDropReport !== 'function') throw new Error('[LockstepGameLoop] transport (LockstepInputTransport) is required')
  if (!Array.isArray(roster) || !roster.includes(localPeerId)) throw new Error('[LockstepGameLoop] roster must list every peer pubkey including localPeerId')
  if (typeof simulate !== 'function' || typeof getLocalInput !== 'function') throw new Error('[LockstepGameLoop] simulate(tick, dt, inputsByPeer) and getLocalInput() are required')
  const opts = { ...LOCKSTEP_DEFAULTS, ...options }
  if (opts.inputDelayTicks < 1) throw new Error('[LockstepGameLoop] inputDelayTicks must be >= 1: tick t can only run once every peer input for t has arrived')
  if (opts.maxCatchUpTicks < 1) throw new Error('[LockstepGameLoop] maxCatchUpTicks must be >= 1')

  const inputs = new Map(roster.map(pk => [pk, new Map()]))
  const lastConfirmed = new Map(roster.map(pk => [pk, 0]))
  const cuts = new Map()
  const dropping = new Map()
  const dropLog = []
  const used = new Map()
  const remoteAdvantage = new Map()
  const newestReceived = new Map()
  const connectingTicks = new Map()
  const sampledAt = new Map()
  const latencyRing = []
  const latency = { count: 0, sumMs: 0, maxMs: 0 }
  let simTick = 0, driverTicks = 0, yieldCursor = 0, stalledDriverTicks = 0, evicted = null, smoothedAdvantage = 0
  const stats = { ticksSimulated: 0, stalls: 0, timeSyncYields: 0, catchUpTicks: 0, maxStallRun: 0, connectingTicks: 0, lateInputsIgnored: 0, futureInputsIgnored: 0 }

  function confirm(peer, tick, input) {
    const m = inputs.get(peer)
    if (!m || cuts.has(peer) || m.has(tick)) return false
    if (tick <= simTick) { stats.lateInputsIgnored++; return false }
    if (tick > simTick + INPUT_RETAIN_TICKS) { stats.futureInputsIgnored++; return false }
    m.set(tick, input ?? null)
    let c = lastConfirmed.get(peer)
    while (m.has(c + 1)) c++
    lastConfirmed.set(peer, c)
    return true
  }

  function has(peer, tick) {
    const cut = cuts.get(peer)
    if (cut != null && tick > cut) return true
    return inputs.get(peer).has(tick)
  }

  function inputOf(peer, tick) {
    const cut = cuts.get(peer)
    if (cut != null && tick > cut) return null
    return inputs.get(peer).get(tick)
  }

  function waitingOn(tick) { return roster.filter(pk => !has(pk, tick)) }
  function ready(tick) { for (const pk of roster) if (!has(pk, tick)) return false; return true }

  function onRemoteInput(peer, tick, input, advantage = 0) {
    if (dropping.has(peer) || cuts.has(peer)) return
    remoteAdvantage.set(peer, advantage)
    if (tick > (newestReceived.get(peer) ?? 0)) newestReceived.set(peer, tick)
    confirm(peer, tick, input)
  }

  function survivors() { return roster.filter(pk => !cuts.has(pk) && !dropping.has(pk)) }

  function tailOf(peer) {
    const out = []
    for (const [t, inp] of inputs.get(peer)) if (t > simTick && t <= lastConfirmed.get(peer)) out.push([t, inp])
    return out
  }

  function dropPeer(peer, reason = 'stall') {
    if (peer === localPeerId || cuts.has(peer) || !inputs.has(peer) || evicted) return
    let d = dropping.get(peer)
    if (!d) { d = { reason, reports: new Map(), startedAtSimTick: simTick }; dropping.set(peer, d) }
    if (d.reports.has(localPeerId)) return
    const have = lastConfirmed.get(peer)
    d.reports.set(localPeerId, have)
    transport.submitDropReport(peer, have, tailOf(peer))
    finishDrops()
  }

  function onRemoteDrop(from, peer, have, tail) {
    if (!inputs.has(from) || cuts.has(from) || from === peer) return
    if (peer === localPeerId) { if (!evicted) evicted = { by: from, atSimTick: simTick }; return }
    if (!inputs.has(peer) || cuts.has(peer)) return
    for (const row of tail) if (Array.isArray(row) && Number.isInteger(row[0]) && row[0] <= have) confirm(peer, row[0], row[1])
    let d = dropping.get(peer)
    if (!d) { d = { reason: 'peer-report', reports: new Map(), startedAtSimTick: simTick }; dropping.set(peer, d) }
    d.reports.set(from, have)
    if (!d.reports.has(localPeerId)) dropPeer(peer, d.reason)
    finishDrops()
  }

  function finishDrops() {
    let progressed = true
    while (progressed) {
      progressed = false
      const alive = survivors()
      for (const [peer, d] of dropping) {
        if (!alive.every(pk => d.reports.has(pk))) continue
        let cut = 0
        for (const pk of alive) cut = Math.max(cut, d.reports.get(pk))
        const m = inputs.get(peer)
        for (const t of [...m.keys()]) if (t > cut) m.delete(t)
        cuts.set(peer, cut)
        dropping.delete(peer)
        if (voter) voter.removePeer(peer)
        if (dropLog.length < DROP_LOG_LIMIT) dropLog.push({ peer, reason: d.reason, cutTick: cut, reports: Object.fromEntries(d.reports), startedAtSimTick: d.startedAtSimTick, finishedAtSimTick: simTick })
        progressed = true
        break
      }
    }
  }

  transport.onRemoteInput = onRemoteInput
  transport.onRemoteDrop = onRemoteDrop
  transport.onPeerClosed = peer => dropPeer(peer, 'closed')

  function submitLocal(tick) {
    const input = getLocalInput()
    confirm(localPeerId, tick, input)
    sampledAt.set(tick, now())
    transport.submitLocalInput(tick, input, smoothedAdvantage)
  }

  function recordLatency(tick) {
    const s = sampledAt.get(tick)
    if (s == null) return
    sampledAt.delete(tick)
    const ms = now() - s
    latency.count++; latency.sumMs += ms; if (ms > latency.maxMs) latency.maxMs = ms
    if (latencyRing.length >= LATENCY_RING) latencyRing.shift()
    latencyRing.push(ms)
  }

  function step(dt) {
    const t = simTick + 1
    submitLocal(t + opts.inputDelayTicks)
    const byPeer = new Map(), keys = {}
    for (const pk of roster) { const inp = inputOf(pk, t); byPeer.set(pk, inp); keys[pk] = canonicalJSON(inp) }
    used.set(t, keys)
    simulate(t, dt, byPeer)
    simTick = t
    recordLatency(t)
    if (voter) voter.tick(t)
    stats.ticksSimulated++
  }

  function prune() {
    const keep = simTick - INPUT_RETAIN_TICKS
    for (const t of used.keys()) { if (t >= keep) break; used.delete(t) }
    for (const m of inputs.values()) for (const t of m.keys()) if (t < keep) m.delete(t)
    for (const t of sampledAt.keys()) if (t < keep) sampledAt.delete(t)
  }

  function minRemoteNewest() {
    let m = Infinity
    for (const pk of roster) if (pk !== localPeerId && !cuts.has(pk)) m = Math.min(m, newestReceived.get(pk) ?? 0)
    return m === Infinity ? simTick + opts.inputDelayTicks : m
  }

  function localAdvantage() { return simTick - (minRemoteNewest() - opts.inputDelayTicks) }

  function pendingPeers() {
    return roster.filter(pk => pk !== localPeerId && !cuts.has(pk) && !dropping.has(pk) && !newestReceived.has(pk))
  }

  function remoteAdvantageMax() {
    let remoteMax = -Infinity
    for (const [pk, adv] of remoteAdvantage) if (!cuts.has(pk)) remoteMax = Math.max(remoteMax, adv)
    return remoteMax
  }

  function shouldYieldForTimeSync() {
    smoothedAdvantage += (localAdvantage() - smoothedAdvantage) * ADVANTAGE_SMOOTHING
    const remoteMax = remoteAdvantageMax()
    if (remoteMax === -Infinity) return false
    return smoothedAdvantage - remoteMax > TIME_SYNC_SLACK_TICKS && yieldCursor % TIME_SYNC_YIELD_EVERY === 0
  }

  function onDriverTick(driverTick, dt) {
    driverTicks++
    yieldCursor++
    const pending = pendingPeers()
    if (pending.length) {
      stats.connectingTicks++
      for (const pk of pending) {
        const waited = (connectingTicks.get(pk) ?? 0) + 1
        connectingTicks.set(pk, waited)
        if (waited >= opts.stallTicks) dropPeer(pk, 'no-first-input')
      }
      return
    }
    if (evicted) { stats.stalls++; return }
    if (shouldYieldForTimeSync()) { driverTicks--; stats.timeSyncYields++; return }
    let advanced = 0
    while (advanced < opts.maxCatchUpTicks && simTick < driverTicks && ready(simTick + 1)) { step(dt); advanced++ }
    if (!advanced && simTick >= driverTicks) return
    if (advanced > 1) stats.catchUpTicks += advanced - 1
    if (advanced) { stalledDriverTicks = 0; prune(); return }
    stats.stalls++
    stalledDriverTicks++
    if (stalledDriverTicks > stats.maxStallRun) stats.maxStallRun = stalledDriverTicks
    if (stalledDriverTicks >= opts.stallTicks) for (const pk of waitingOn(simTick + 1)) dropPeer(pk, 'stall')
  }

  function start() {
    for (let t = 1; t <= opts.inputDelayTicks; t++) { confirm(localPeerId, t, null); transport.submitLocalInput(t, null) }
    tickSystem.onTick(onDriverTick)
    tickSystem.start()
  }

  function latencyStats() {
    const sorted = [...latencyRing].sort((a, b) => a - b)
    const p = q => sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(1) : 0
    return { avg: latency.count ? +(latency.sumMs / latency.count).toFixed(1) : 0, p50: p(0.5), p95: p(0.95), max: +latency.maxMs.toFixed(1) }
  }

  return {
    start,
    stop() { tickSystem.stop() },
    dropPeer,
    get simTick() { return simTick },
    get options() { return { ...opts } },
    inspectTick(tick) { return { used: used.get(tick) ?? null } },
    getStats() {
      const v = voter ? voter.getStats() : null
      return {
        ...stats, connectingTicksByPeer: Object.fromEntries(connectingTicks), simTick, driverTicks, smoothedAdvantage: +smoothedAdvantage.toFixed(2), remoteAdvantageMax: remoteAdvantageMax(), evicted, localAdvantage: localAdvantage(), remoteAdvantage: Object.fromEntries(remoteAdvantage),
        waitingOn: ready(simTick + 1) ? [] : waitingOn(simTick + 1),
        lastConfirmed: Object.fromEntries(lastConfirmed), cuts: Object.fromEntries(cuts), dropping: [...dropping.keys()], dropLog: [...dropLog],
        inputLatencyMs: latencyStats(),
        checksumsCompared: v ? v.verified + v.desyncsDetected : 0, desyncs: v ? v.desyncsDetected : 0, firstDesyncTick: v?.firstDesyncTick ?? null, voter: v
      }
    }
  }
}
