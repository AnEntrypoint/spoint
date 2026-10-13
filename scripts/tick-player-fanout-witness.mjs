#!/usr/bin/env node
// Witness for the per-tick PLAYER fan-out of buildAndSendSnapshots (surface: src/sdk/TickHandler.js).
//
// The row this closes (PERF-tick-player-fanout-1013) inherits a measured 8.30 ms snapshot tick at
// 64 players / 3000 entities from PERF-tick-snapshot-send-cost-1013, which bounded the ENTITY walk
// (recipients * population <= SNAP_ENTITY_VISITS_PER_TICK). What it left is a claim about the
// PLAYER walk: that the residual is dominated by stages that walk every CONNECTED player every
// tick -- encodePlayersOnce, filterEncodedPlayers*, nearbyPlayerIds, the tombstone prune and the
// tracked-recipient sweep -- so that a bigger lobby makes the tick worse no matter how small the
// fan-out is.
//
// This witness drives the real createTickHandler over a stated player count and entity population
// and splits the measured per-snapshot-tick cost with the per-player stages broken out separately:
//
//   playersEncode -- SnapshotEncoder.encodePlayersOnce, the bin pack per player
//   nearby        -- appRuntime.nearbyPlayerIds, the per-recipient relevance query
//   playersFilter -- filterEncodedPlayersWithSelf / filterEncodedPlayersTiered, per recipient
//   tombstones    -- SnapshotEncoder.updateTombstones
//   prune         -- TombstoneLog.pruneBefore
//   trackedSweep  -- the per-tick stale-recipient sweep (playerManager.getPlayer per tracked id)
//   encode        -- SnapshotEncoder.encodeDeltaFromCache, per recipient
//   send          -- packSnapshot + connections.sendPacked, per recipient
//   plan          -- the RESIDUAL of the snapshot phase once the named stages are subtracted, so it
//                    is never a number this witness invents.
//
// The snapshot phase total comes from the handler's own instrument (onTick.getMetrics().avgSnapMs),
// which is t5-t4 around buildAndSendSnapshots in production code.
//
// BEFORE/AFTER is struck inside ONE process under ONE load, using the surface's own reproduction
// switch (setPlayerFanoutWholeLobby): with it on, a tick encodes and indexes the whole lobby as it
// used to; with it off, it encodes the union of what the served group can reach. This box runs
// sibling lanes, so two separate runs measure the neighbours as much as the code, and the row
// forbids pricing anything off that kind of number.
//
// Two layouts are measured, because a fan-out bound that only holds where every player is reachable
// proves nothing and one that only holds where they are not proves nothing either:
//
//   packed -- 64 players inside one 60 m cluster at relevance 200, so every player really is in
//             every recipient's neighbourhood. The union IS the lobby: no encode pass can be
//             smaller than what the group is actually sent.
//   spread -- 64 players over 1200 m at relevance 200, so each recipient reaches a handful. The
//             union is a fraction of the lobby, and that fraction is a fact about the world.
//
// Wire identity is proved, not assumed: every packet of every arm, shape and round is hashed as
// (recipient id, length, bytes) into one stream digest, and arm-equality is asserted directly --
// the union arm must emit the SAME digest as the whole-lobby arm, which is what "no behaviour
// change in who receives what" means when it is not merely claimed.

import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(REPO, p)).href)
const TAG = '[tick-player-fanout]'
let BIN_BYTES = 0

const argv = process.argv.slice(2)
const optOf = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const flOf = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  if (hit === undefined) return dflt
  const v = Number(hit.slice(name.length + 3))
  if (!Number.isFinite(v) || v < 0) { console.error(`${TAG} --${name} must be a non-negative number, got "${hit}"`); process.exit(2) }
  return v
}

const PLAYERS = flOf('players', 64)
const ENTITIES = flOf('entities', 3000)
const RELEVANCE = flOf('relevance', 200)
const PACKED_CLUSTER = flOf('packedCluster', 60)
const PACKED_SPREAD = flOf('packedSpread', 120)
const SPREAD_CLUSTER = flOf('spreadCluster', 1200)
const SPREAD_SPREAD = flOf('spreadSpread', 1200)
const STATIC_FRAC = flOf('staticFrac', 0.8)
const TICKS = flOf('ticks', 640)
const ROUNDS = flOf('rounds', 2)
const SEED = flOf('seed', 20261013)
const TICK_RATE = flOf('tickRate', 60)
// The pre-existing rate controller halves the snapshot rate off `_snapCostEmaMs`, a wall-clock
// sample. That is exactly the timer-driven cap this row forbids pricing anything from, and it makes
// two arms incomparable: the slower arm gets a longer interval, so it runs FEWER snapshot ticks
// and the two digests are not even over the same schedule. Pinning the configured rate at or under
// SNAP_RATE_MIN_HZ makes `base` round(60/8) whatever the cost sample says, so both arms run the
// same schedule and the only thing the A/B can be measuring is the code.
const SNAP_RATE = flOf('snapRate', 8)
const SNAP_COST_HIGH_FRAC = 0.35
const TICK_BUDGET_MS = 1000 / TICK_RATE
const SNAP_BUDGET_MS = TICK_BUDGET_MS * SNAP_COST_HIGH_FRAC
const ADJUST_INTERVAL = 64

const claims = []
function runClaim(id, text, fn) {
  try {
    const o = fn()
    claims.push(o.ok === true)
    console.log(`${o.ok === true ? 'PASS' : 'FAIL'} ${id} ${text} -- ${o.detail}`)
  } catch (err) {
    claims.push(false)
    console.log(`FAIL ${id} ${text} -- exception ${err && err.name}: ${err && err.message}`)
  }
}
const failures = []
function expect(name, got, predicate) {
  let ok = false
  try { ok = Boolean(predicate(got)) } catch { ok = false }
  if (!ok) failures.push(`${name}=${JSON.stringify(got)}`)
  return got
}
const f2 = (n) => Number(n).toFixed(4)

let rng = SEED >>> 0
const rnd = () => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng / 4294967296 }
const rfl = (a, b) => a + (b - a) * rnd()

function encodeEntityForSnapshot(e) {
  return { id: e.id, model: e.model, position: [...e.position], rotation: [...e.rotation], scale: [...(e.scale || [1, 1, 1])], velocity: [...(e.velocity || [0, 0, 0])], bodyType: e.bodyType, custom: e.custom || null, parent: null }
}

function makeEntity(id, spread, isStatic) {
  return {
    id, model: isStatic ? 'wall' : 'crate',
    position: [rfl(-spread, spread), rfl(0, 2), rfl(-spread, spread)],
    rotation: [0, 0, 0, 1], velocity: [0, 0, 0], scale: [1, 1, 1],
    bodyType: isStatic ? 'static' : 'dynamic', custom: { hp: 3 }, sleeping: false,
  }
}

function makeAppRuntimeStub(ents, players) {
  const rt = {
    entities: new Map(ents.map((e) => [e.id, e])),
    staticEntities: ents.filter((e) => e.bodyType === 'static'),
    currentTick: 0,
    _dynamicEntityIds: new Set(), _staticEntityIds: new Set(), _movedStaticIds: new Set(),
    _activeDynamicIds: new Set(), _sleepingDynamicIds: new Set(), _suspendedEntityIds: new Set(),
    _staticCustomSum: 0, _staticVersion: 0,
    _playerIndex: {
      nearby: (pos, r) => players.filter((p) => { const q = p.state.position, dx = q[0] - pos[0], dz = q[2] - pos[2]; return dx * dx + dz * dz <= r * r }).map((p) => p.id),
      pruneIdleKeys() {},
    },
    tick(t) { this.currentTick = t },
    getSnapshot() { return { tick: this.currentTick, timestamp: Date.now(), entities: Array.from(this.entities.values(), encodeEntityForSnapshot) } },
    getStaticSnapshot() { return { tick: this.currentTick, timestamp: Date.now(), entities: this.staticEntities.map(encodeEntityForSnapshot) } },
    getStaticCustomVersionSum() { return this._staticCustomSum },
    getActiveDynamicIds() { return this._activeDynamicIds },
    getSleepingDynamicIds() { return this._sleepingDynamicIds },
    getSuspendedEntityIds() { return this._suspendedEntityIds },
    getUnmanagedDynamicIds() { return [] },
    relevantEntities(pos, r) {
      const out = []
      for (const [id, e] of this.entities) { const dx = e.position[0] - pos[0], dz = e.position[2] - pos[2]; if (dx * dx + dz * dz <= r * r) out.push(id) }
      return out
    },
    getRelevantDynamicIdsWithStarvation(pos, r, _key, _m, baseIds) { return new Set(baseIds || this.relevantEntities(pos, r)) },
    nearbyPlayerIds(pos, r) {
      if (!Array.isArray(pos) || pos.length !== 3 || pos.some((v) => !Number.isFinite(v))) throw new TypeError('[AppRuntime] nearbyPlayerIds: pos must be a length-3 array of finite numbers')
      return this._playerIndex.nearby(pos, r)
    },
    _drainReloadQueue() {},
  }
  for (const e of ents) {
    if (e.bodyType === 'static') { rt._staticEntityIds.add(e.id); continue }
    rt._dynamicEntityIds.add(e.id); rt._activeDynamicIds.add(e.id)
  }
  return rt
}

// A stage is timed by wrapping the ONE function that owns it, so the named stages plus the plan
// residual account for the snapshot phase rather than re-deriving it. The wrapper costs two hrtime
// reads per call, which is why the uninflated total is read separately from the handler's own
// instrument. `trackedSweep` is timed through playerManager.getPlayer because the stale-recipient
// sweep is the only thing in the snapshot phase that calls it.
function instrument(rt, SnapshotEncoder, TombstoneLog, connections, playerManager, stage) {
  const saved = []
  const wrap = (obj, key, bucket) => {
    const orig = obj[key]
    saved.push([obj, key, orig])
    obj[key] = function (...a) {
      const s = process.hrtime.bigint()
      const r = orig.apply(this, a)
      stage[bucket] += Number(process.hrtime.bigint() - s) / 1e6
      stage[bucket + 'Calls']++
      if (bucket === 'encode' && r && r.encoded && Array.isArray(r.encoded.entities)) {
        for (const rec of r.encoded.entities) {
          stage.records++
          const bin = rec && rec[2]
          if (bin instanceof Uint8Array) { stage.bins++; if (bin.byteLength !== BIN_BYTES) stage.badWidth++ }
        }
      }
      return r
    }
  }
  wrap(SnapshotEncoder, 'encodePlayersOnce', 'playersEncode')
  wrap(SnapshotEncoder, 'filterEncodedPlayersWithSelf', 'playersFilter')
  wrap(SnapshotEncoder, 'filterEncodedPlayersTiered', 'playersFilter')
  wrap(SnapshotEncoder, 'updateTombstones', 'tombstones')
  wrap(SnapshotEncoder, 'encodeDeltaFromCache', 'encode')
  wrap(SnapshotEncoder, 'encodeStaticEntities', 'encode')
  wrap(TombstoneLog.prototype, 'pruneBefore', 'prune')
  wrap(rt, 'nearbyPlayerIds', 'nearby')
  wrap(playerManager, 'getPlayer', 'trackedSweep')
  wrap(connections, 'sendPacked', 'send')
  // The encoder namespace object outlives a round, so a wrapper left installed would be wrapped
  // again by the next round and the encode stage would pay a deeper stack each time.
  return () => { for (const [o, k, v] of saved) o[k] = v }
}

async function main() {
  const { pack: _unused, unpack, ensurePacked } = await imp('src/protocol/msgpack.js')
  const { SnapshotEncoder, TombstoneLog } = await imp('src/netcode/SnapshotEncoder.js')
  const TH = await imp('src/sdk/TickHandler.js')
  const { createTickHandler, SNAP_ENTITY_VISITS_PER_TICK, PLAYERS_PER_SNAP_GROUP, resetPlayerFanoutWork, playerFanoutWorkSnapshot, setPlayerFanoutWholeLobby } = TH
  const { NetworkState } = await imp('src/netcode/NetworkState.js')
  const { mixinStaticMotion } = await imp('src/apps/AppRuntimeStaticMotion.js')
  const AOI = await imp('src/sdk/TickHandlerAOI.js')
  const { MSG } = await imp('src/protocol/MessageTypes.js')
  const { BIN_RECORD_BYTES } = await imp('src/netcode/SnapshotBinFormat.js')
  await ensurePacked
  BIN_BYTES = BIN_RECORD_BYTES

  console.log(`witness=scripts/tick-player-fanout-witness.mjs node=${process.version} platform=${process.platform}`)
  console.log(`${TAG} shape players=${PLAYERS} entities=${ENTITIES} static_frac=${STATIC_FRAC} relevance=${RELEVANCE} packed cluster=${PACKED_CLUSTER}/spread=${PACKED_SPREAD} spread cluster=${SPREAD_CLUSTER}/spread=${SPREAD_SPREAD} ticks=${TICKS} rounds=${ROUNDS} tick_rate=${TICK_RATE} tick_budget_ms=${TICK_BUDGET_MS.toFixed(3)} snap_budget_ms=${SNAP_BUDGET_MS.toFixed(3)}`)

  const LAYOUTS = {
    packed: { cluster: PACKED_CLUSTER, spread: PACKED_SPREAD },
    spread: { cluster: SPREAD_CLUSTER, spread: SPREAD_SPREAD },
  }

  async function runRound(timed, layout, wholeLobby) {
    rng = SEED >>> 0
    const { cluster, spread } = LAYOUTS[layout]
    setPlayerFanoutWholeLobby(wholeLobby)
    resetPlayerFanoutWork()
    const ns = new NetworkState()
    const players = [], queues = new Map(), playersById = new Map()
    for (let i = 1; i <= PLAYERS; i++) {
      const pos = [rfl(0, cluster), 0, rfl(0, cluster)]
      ns.addPlayer(i, { position: pos })
      const p = { id: i, state: { position: pos.slice(), rotation: [0, 0, 0, 1], velocity: [0, 0, 0], onGround: true, crouch: 0, lookPitch: 0, lookYaw: 0, expr: 0, health: 100, weapon: 0 }, inputSequence: 0, lastInput: null, hasSentInput: false, starvedTicks: 0 }
      players.push(p); playersById.set(i, p); queues.set(i, [])
    }
    const ents = []
    for (let k = 0; k < ENTITIES; k++) ents.push(makeEntity(5000 + k, spread, rnd() < STATIC_FRAC))
    const appRuntime = makeAppRuntimeStub(ents, players)
    mixinStaticMotion(appRuntime)

    const stage = { playersEncode: 0, playersEncodeCalls: 0, nearby: 0, nearbyCalls: 0, playersFilter: 0, playersFilterCalls: 0, tombstones: 0, tombstonesCalls: 0, prune: 0, pruneCalls: 0, trackedSweep: 0, trackedSweepCalls: 0, encode: 0, encodeCalls: 0, send: 0, sendCalls: 0, records: 0, bins: 0, badWidth: 0 }
    const sent = []
    let bytes = 0
    const connections = {
      sendPacked(id, buf) { bytes += buf.length; sent.push({ id, tick: sentTick, bytes: Uint8Array.from(buf) }) },
      send() {}, broadcast() {}, emit() {}, getClient: () => null, clients: new Map(),
    }
    const playerManager = { getConnectedPlayers: () => players, getInputs: (id) => queues.get(id) || [], getMovementOverride: () => null, getPlayer: (id) => playersById.get(id) }
    let restore = () => {}
    if (timed) restore = instrument(appRuntime, SnapshotEncoder, TombstoneLog, connections, playerManager, stage)

    const physicsIntegration = { config: { capsuleRadius: 0.4 }, setCrouch() {}, setPlayerPosition() {}, updatePlayerPhysics(_id, st, dt) { st.position[0] += st.velocity[0] * dt; st.position[2] += st.velocity[2] * dt } }
    const onTick = createTickHandler({
      networkState: ns,
      playerManager,
      physicsIntegration,
      lagCompensator: { beginTick() {}, recordPlayerPosition() {} },
      physics: { step() {} },
      appRuntime, connections, stageLoader: null,
      getRelevanceRadius: () => RELEVANCE, tickRate: TICK_RATE,
      getNetcodeConfig: () => ({ snapshotRate: SNAP_RATE, adaptiveSnapshotRate: false }),
    })
    AOI.resetAoiRingWork()
    await AOI.installAoiCodeEpoch()
    // The AOI keeps per-viewer priority accumulators and the spatial/ring/cell-base caches at
    // module scope, so a second round in one process is not the same experiment as the first.
    AOI._spatialCache.clear()
    AOI._ringCache.clear()
    AOI.invalidateAoiCellBaseCache()
    for (const p of players) AOI.clearPlayerPriorityAccumulator(p.id)

    const realNow = Date.now
    let clock = 1791580000000
    Date.now = () => clock
    const servedPerSnapTick = []
    let snapTicks = 0
    let step = 0
    let sentTick = -1
    const tickCosts = []
    const idleCosts = []
    try {
      for (let t = 0; t < TICKS; t++) {
        clock += Math.round(1000 / TICK_RATE)
        sentTick = t
        for (const p of players) {
          step++
          const moving = (step % 7) !== 0
          queues.get(p.id).push({ sequence: t + 1, data: { forward: moving, backward: false, left: false, right: false, jump: false, yaw: moving ? 0.7 : 0, pitch: 0, crouch: false, expr: 0 } })
        }
        const beforePackets = sent.length
        const t0 = process.hrtime.bigint()
        onTick(t, 1 / TICK_RATE)
        const tickMs = Number(process.hrtime.bigint() - t0) / 1e6
        const servedThisTick = sent.length - beforePackets
        if (servedThisTick > 0) { snapTicks++; servedPerSnapTick.push(servedThisTick); tickCosts.push([tickMs, servedThisTick, t]) }
        else idleCosts.push([tickMs, t])
      }
    } finally {
      Date.now = realNow
      restore()
      setPlayerFanoutWholeLobby(false)
    }
    const metrics = onTick.getMetrics()
    const hash = createHash('sha256')
    for (const s of sent) { const head = Buffer.alloc(8); head.writeUInt32BE(s.id >>> 0, 0); head.writeUInt32BE(s.bytes.length, 4); hash.update(head); hash.update(s.bytes) }
    // Per (tick, recipient) rather than one stream digest: the stream digest is only comparable
    // between two arms if they ran the same number of ticks at the same schedule, and keying on the
    // tick makes the comparison independent of that.
    const perKey = new Map()
    for (const s of sent) perKey.set(`${s.tick}:${s.id}`, createHash('sha256').update(s.bytes).digest('hex'))
    return { stage, sent, bytes, snapTicks, servedPerSnapTick, tickCosts, idleCosts, metrics, streamSha: hash.digest('hex'), perKey, work: playerFanoutWorkSnapshot(), aoiWork: { ...AOI.aoiRingWork } }
  }

  // The bound can only be priced once the handler has taken a measurement, and it takes it every
  // SNAP_RATE_ADJUST_INTERVAL ticks, so the ticks before the first adjustment are unmeasured
  // start-up and are excluded from the worst case.
  function servedWindow(tickCosts) {
    const settled = tickCosts.filter((c) => c[2] >= ADJUST_INTERVAL)
    return settled.length > 0 ? settled : tickCosts
  }

  // The minimum over fresh rounds, not a median: each round allocates a fresh world and a fresh
  // handler, and this box runs sibling lanes, so a central estimator measures GC and neighbours
  // as much as the code.
  async function measure(layout, wholeLobby) {
    // The first round of a process is cold in ways that have nothing to do with this row, so it is
    // discarded: a "the two arms differ" verdict must never be the cold start wearing a costume.
    await runRound(false, layout, wholeLobby)
    let best = null
    const allShas = new Set()
    // Every round's packets are folded into one per-(tick, recipient) digest, so the identity claim
    // is struck over every packet this arm emitted and not over the one round the timing estimator
    // happened to pick.
    const allPerKey = new Map()
    let roundMismatch = 0
    const fold = (r) => {
      allShas.add(r.streamSha)
      for (const [k, v] of r.perKey) {
        const prev = allPerKey.get(k)
        if (prev === undefined) allPerKey.set(k, v)
        else if (prev !== v) roundMismatch++
      }
    }
    fold(await runRound(true, layout, wholeLobby))
    for (let r = 0; r < ROUNDS; r++) {
      const timed = await runRound(true, layout, wholeLobby)
      const plain = await runRound(false, layout, wholeLobby)
      fold(timed)
      fold(plain)
      const snapTicks = Math.max(1, timed.snapTicks)
      // avgSnapMs is t5-t4 averaged over EVERY tick that had players, while the stage sums are
      // accumulated over the whole run, so both are put on the same per-snapshot-tick footing.
      const spread = TICKS / snapTicks
      const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length)
      // The snapshot phase measured as the tick that has one minus the tick that does not. The
      // handler's avgSnapMs is t5-t4 averaged over EVERY tick that had players, including the ticks
      // that ran no snapshot at all, so reading a per-snapshot-tick figure off it needs a multiplier
      // that depends on the schedule. Differencing the two populations does not, and it is the
      // figure the parent row's 8.30 ms was struck on.
      const totalDelta = mean(servedWindow(timed.tickCosts).map((c) => c[0])) - mean(timed.idleCosts.filter((c) => c[1] >= ADJUST_INTERVAL).map((c) => c[0]))
      const per = {
        total: totalDelta,
        totalInstrument: timed.metrics.avgSnapMs * spread,
        totalPlain: plain.metrics.avgSnapMs * (TICKS / Math.max(1, plain.snapTicks)),
        tickTotal: timed.metrics.avgTotalMs,
        mv: timed.metrics.avgMvMs,
        phys: timed.metrics.avgPhysMs,
        playersEncode: timed.stage.playersEncode / snapTicks,
        nearby: timed.stage.nearby / snapTicks,
        playersFilter: timed.stage.playersFilter / snapTicks,
        tombstones: timed.stage.tombstones / snapTicks,
        prune: timed.stage.prune / snapTicks,
        trackedSweep: timed.stage.trackedSweep / snapTicks,
        encode: timed.stage.encode / snapTicks,
        send: timed.stage.send / snapTicks,
        packets: timed.sent.length,
        bytes: timed.bytes,
        snapTicks: timed.snapTicks,
        idleTicks: timed.idleCosts.filter((c) => c[1] >= ADJUST_INTERVAL).length,
        snapSamples: servedWindow(timed.tickCosts).length,
        servedPerSnapTick: timed.servedPerSnapTick.reduce((a, b) => a + b, 0) / Math.max(1, timed.servedPerSnapTick.length),
        maxServed: Math.max(...servedWindow(timed.tickCosts).map((c) => c[1])),
        worst: servedWindow(timed.tickCosts).reduce((a, b) => (b[0] > a[0] ? b : a), [0, 1, 0]),
        streamSha: timed.streamSha,
        perKey: timed.perKey,
        work: timed.work,
        aoiWork: timed.aoiWork,
        sent: timed.sent,
        records: timed.stage.records,
        bins: timed.stage.bins,
        badWidth: timed.stage.badWidth,
      }
      per.playerWalk = per.playersEncode + per.nearby + per.playersFilter + per.tombstones + per.prune + per.trackedSweep
      per.plan = per.total - (per.playerWalk + per.encode + per.send)
      per.worstTickMs = per.worst[0]
      per.worstTickServed = per.worst[1]
      if (best === null || per.total < best.total) best = per
    }
    best.shas = [...allShas]
    best.distinctShas = allShas.size
    best.allPerKey = allPerKey
    best.roundMismatch = roundMismatch
    best.encodedPerTick = best.work.snapshots > 0 ? best.work.encodedPlayers / best.work.snapshots : 0
    best.lobbyPerTick = best.work.snapshots > 0 ? best.work.lobbyPlayers / best.work.snapshots : 0
    best.nearbyPerTick = best.work.snapshots > 0 ? best.work.nearbyVisits / best.work.snapshots : 0
    best.recipientsPerTick = best.work.snapshots > 0 ? best.work.recipients / best.work.snapshots : 0
    return best
  }

  const arms = {}
  for (const layout of ['packed', 'spread']) {
    arms[layout] = { legacy: await measure(layout, true), union: await measure(layout, false) }
  }

  for (const layout of ['packed', 'spread']) {
    for (const [arm, m] of [['legacy', arms[layout].legacy], ['union', arms[layout].union]]) {
      console.log(`${TAG} ${layout}/${arm} snap_ticks=${m.snapTicks} packets=${m.packets} bytes=${m.bytes} bytes_per_snap_tick=${(m.bytes / Math.max(1, m.snapTicks)).toFixed(0)}`)
      console.log(`${TAG} ${layout}/${arm} per_tick_ms snapshot=${f2(m.total)} snapshot_handler_instrument=${f2(m.totalInstrument)} snapshot_uninstrumented=${f2(m.totalPlain)} whole_tick=${f2(m.tickTotal)} mv=${f2(m.mv)} phys=${f2(m.phys)}`)
      console.log(`${TAG} ${layout}/${arm} per_snapshot_tick_ms playersEncode=${f2(m.playersEncode)} nearby=${f2(m.nearby)} playersFilter=${f2(m.playersFilter)} tombstones=${f2(m.tombstones)} prune=${f2(m.prune)} trackedSweep=${f2(m.trackedSweep)} playerWalk=${f2(m.playerWalk)}`)
      console.log(`${TAG} ${layout}/${arm} per_snapshot_tick_ms encode=${f2(m.encode)} send=${f2(m.send)} plan=${f2(m.plan)} sum=${f2(m.playerWalk + m.encode + m.send + m.plan)} total=${f2(m.total)}`)
      console.log(`${TAG} ${layout}/${arm} fanout recipients=${f2(m.recipientsPerTick)} encoded_players=${f2(m.encodedPerTick)} of lobby=${f2(m.lobbyPerTick)} nearby_visits=${f2(m.nearbyPerTick)}`)
      console.log(`${TAG} ${layout}/${arm} population=${ENTITIES} entity(ies) recipients_per_snap_tick=${f2(m.servedPerSnapTick)} max=${m.maxServed}`)
      console.log(`${TAG} ${layout}/${arm} stream_sha256=${m.streamSha} distinct=${m.distinctShas}/${m.shas.length} round_mismatch=${m.roundMismatch}`)
      console.log(`${TAG} ${layout}/${arm} worst_tick ms=${f2(m.worstTickMs)} served=${m.worstTickServed} snap_budget_ms=${f2(SNAP_BUDGET_MS)}`)
    }
    const L = arms[layout].legacy, U = arms[layout].union
    console.log(`${TAG} ${layout} BEFORE->AFTER snapshot ${f2(L.total)} -> ${f2(U.total)} ms | playerWalk ${f2(L.playerWalk)} -> ${f2(U.playerWalk)} ms (encode ${f2(L.playersEncode)} -> ${f2(U.playersEncode)}, nearby ${f2(L.nearby)} -> ${f2(U.nearby)}, filter ${f2(L.playersFilter)} -> ${f2(U.playersFilter)}, tombstones ${f2(L.tombstones)} -> ${f2(U.tombstones)}, prune ${f2(L.prune)} -> ${f2(U.prune)}, sweep ${f2(L.trackedSweep)} -> ${f2(U.trackedSweep)}) | encode pass ${f2(L.encodedPerTick)} -> ${f2(U.encodedPerTick)} of lobby ${f2(L.lobbyPerTick)}`)
  }
  const P = arms.packed, S = arms.spread
  console.log(`${TAG} MEASURED packed: encode pass ${f2(P.legacy.encodedPerTick)} -> ${f2(P.union.encodedPerTick)} player(s) per tick of a ${f2(P.union.lobbyPerTick)} player lobby (every player reachable, so no pass can be smaller than what is delivered)`)
  console.log(`${TAG} MEASURED spread: encode pass ${f2(S.legacy.encodedPerTick)} -> ${f2(S.union.encodedPerTick)} player(s) per tick of a ${f2(S.union.lobbyPerTick)} player lobby, recipients ${f2(S.union.recipientsPerTick)} nearby visits ${f2(S.union.nearbyPerTick)}`)
  console.log(`${TAG} MEASURED player-walk ms per snapshot tick: packed ${f2(P.legacy.playerWalk)} -> ${f2(P.union.playerWalk)}, spread ${f2(S.legacy.playerWalk)} -> ${f2(S.union.playerWalk)}`)
  console.log(`${TAG} bin record bytes=${BIN_RECORD_BYTES}`)

  const all = [P.legacy, P.union, S.legacy, S.union]

  runClaim('C1', 'the snapshot phase is measured, not assumed: every arm ran snapshot ticks AND idle ticks to difference them against, and the handler\'s own instrument reported a non-zero average', () => {
    const ok = all.every((m) => m.snapTicks > 0 && m.totalPlain > 0 && m.idleTicks > 0 && m.snapSamples > 0)
    return { ok, detail: all.map((m, i) => `${['packed/legacy', 'packed/union', 'spread/legacy', 'spread/union'][i]} snap_ticks=${m.snapTicks} idle_ticks=${m.idleTicks} avgSnapMs(instrument)=${f2(m.totalPlain)}`).join(' ') }
  })

  runClaim('C2', 'the named stages account for the snapshot phase in every arm: none is negative and the plan residual never swallows the whole', () => {
    const ok = all.every((m) => m.playersEncode >= 0 && m.nearby >= 0 && m.playersFilter >= 0 && m.tombstones >= 0 && m.prune >= 0 && m.trackedSweep >= 0 && m.encode >= 0 && m.send >= 0 && m.plan >= 0 && m.plan < m.total)
    return { ok, detail: all.map((m, i) => `${['packed/legacy', 'packed/union', 'spread/legacy', 'spread/union'][i]} plan=${f2(m.plan)}/${f2(m.total)}`).join(' ') }
  })

  runClaim('C3', 'every connected player is still a recipient in every arm and layout: nobody is dropped from the rotation', () => {
    const det = all.map((m, i) => `${['packed/legacy', 'packed/union', 'spread/legacy', 'spread/union'][i]}=${new Set(m.sent.map((s) => s.id)).size}/${PLAYERS}`)
    const ok = all.every((m) => new Set(m.sent.map((s) => s.id)).size === PLAYERS)
    return { ok, detail: det.join(' ') }
  })

  // The whole point of the reproduction switch: the arm that encodes only what the group can reach
  // must emit the SAME bytes as the arm that encodes the whole lobby, packet for packet, at every
  // (tick, recipient) both arms served. That is "no behaviour change in who receives what" proved
  // rather than claimed, and it is struck inside one process so the neighbours cannot be mistaken
  // for the code.
  runClaim('C4', 'the wire is byte-identical between the two arms at the same world state, packet for packet over thousands of packets in both layouts', () => {
    let compared = 0, mismatch = 0, onlyLegacy = 0, onlyUnion = 0
    for (const layout of ['packed', 'spread']) {
      const L = arms[layout].legacy.allPerKey, U = arms[layout].union.allPerKey
      for (const [k, v] of L) { if (!U.has(k)) { onlyLegacy++; continue } compared++; if (U.get(k) !== v) mismatch++ }
      for (const k of U.keys()) if (!L.has(k)) onlyUnion++
    }
    expect('packet(s) only one arm sent at a tick the other served', onlyLegacy + onlyUnion, v => v === 0)
    expect('packet(s) that differ between the arms', mismatch, v => v === 0)
    return { ok: compared > 2000 && mismatch === 0 && onlyLegacy === 0 && onlyUnion === 0, detail: `${compared} packet(s) compared byte for byte, ${mismatch} differing, ${onlyLegacy} legacy-only, ${onlyUnion} union-only` }
  })

  runClaim('C5', 'the wire is byte-identical run to run for the same world state: every round of every arm agrees packet for packet at the pinned schedule, and every round hashes to one stream digest', () => {
    const ok = all.every((m) => m.distinctShas === 1 && m.roundMismatch === 0)
    return { ok, detail: all.map((m, i) => `${['packed/legacy', 'packed/union', 'spread/legacy', 'spread/union'][i]} distinct=${m.distinctShas}/${m.shas.length} round_mismatch=${m.roundMismatch}`).join(' ') }
  })

  runClaim('C6', 'every packet unpacks, decodes as a SNAPSHOT and carries its own recipient as a player', () => {
    let typeBad = 0, decodeBad = 0, selfBad = 0, playersSeen = 0, selfSeen = 0, packets = 0
    const seenIds = new Set()
    for (const m of all) {
      for (const s of m.sent) {
        packets++
        let msg
        try { msg = unpack(Buffer.from(s.bytes)) } catch { decodeBad++; continue }
        if (!msg || msg.type !== MSG.SNAPSHOT) { typeBad++; continue }
        const decoded = SnapshotEncoder.decode(msg.payload)
        const ids = decoded.players.map((p) => p && p.id)
        playersSeen += ids.length
        for (const id of ids) seenIds.add(id)
        if (!ids.includes(s.id)) selfBad++
        if (decoded.me) selfSeen++
      }
    }
    expect('packet(s) that did not unpack', decodeBad, v => v === 0)
    expect('packet(s) that are not a SNAPSHOT', typeBad, v => v === 0)
    expect('packet(s) missing their own recipient', selfBad, v => v === 0)
    return { ok: packets > 0 && typeBad === 0 && decodeBad === 0 && selfBad === 0 && selfSeen > 0, detail: `packets=${packets} players_decoded=${playersSeen} distinct_player_ids=${seenIds.size} self_blocks=${selfSeen}` }
  })

  runClaim('C7', 'the entity records the encoder hands the wire are the width the format module declares, over thousands of records', () => {
    const records = all.reduce((a, m) => a + m.records, 0)
    const bins = all.reduce((a, m) => a + m.bins, 0)
    const badWidth = all.reduce((a, m) => a + m.badWidth, 0)
    expect('entity record(s) whose bin is not the declared width', badWidth, v => v === 0)
    return { ok: records > 1000 && bins > 1000 && badWidth === 0, detail: `entity_records=${records} bins=${bins} bad_width=${badWidth} declared_bytes=${BIN_RECORD_BYTES}` }
  })

  // The bound this row adds is a function of world state, never of a clock. Two things pin that:
  // the encode pass never exceeds the lobby (and is strictly smaller where the world says it can
  // be), and where every player really is reachable it is NOT smaller -- a pass that shrank there
  // would be dropping players a recipient can see, which is a behaviour change, not a bound.
  runClaim('C8', 'the per-tick player walk is bounded by world state: the encode pass never exceeds the lobby, it is strictly smaller in the spread layout where the world says it can be, and it is NOT smaller in the packed layout where every player really is reachable', () => {
    expect('packed union encode pass equals the lobby (every player reachable)', P.union.encodedPerTick === P.union.lobbyPerTick, v => v === true)
    expect('spread union encode pass is strictly under the lobby', S.union.encodedPerTick < S.union.lobbyPerTick, v => v === true)
    expect('spread union encode pass is above zero', S.union.encodedPerTick > 0, v => v === true)
    const ok = all.every((m) => m.encodedPerTick <= m.lobbyPerTick && m.lobbyPerTick === PLAYERS)
    return { ok, detail: `packed ${f2(P.union.encodedPerTick)}/${f2(P.union.lobbyPerTick)} spread ${f2(S.union.encodedPerTick)}/${f2(S.union.lobbyPerTick)} (legacy arms ${f2(P.legacy.encodedPerTick)}/${f2(S.legacy.encodedPerTick)})` }
  })

  // The failure mode this row exists to prevent: a cap priced from a timer drove the fan-out down
  // to one recipient with a 25.7 ms worst tick, because a smaller fan-out measured a bigger cost
  // per recipient, which shrank the fan-out again. The recipient count and the schedule have to be
  // the same in both arms -- the change is not allowed to touch who gets served how often.
  runClaim('C9', 'the fan-out did not move: both arms serve the same recipients per snapshot tick at the same schedule, so the bound is not the timer-driven collapse this row forbids', () => {
    const ok = ['packed', 'spread'].every((l) => arms[l].legacy.recipientsPerTick === arms[l].union.recipientsPerTick && arms[l].legacy.servedPerSnapTick === arms[l].union.servedPerSnapTick && arms[l].legacy.maxServed === arms[l].union.maxServed && arms[l].union.maxServed > 1)
    return { ok, detail: `packed recipients ${f2(P.legacy.recipientsPerTick)}/${f2(P.union.recipientsPerTick)} max ${P.legacy.maxServed}/${P.union.maxServed}; spread recipients ${f2(S.legacy.recipientsPerTick)}/${f2(S.union.recipientsPerTick)} max ${S.legacy.maxServed}/${S.union.maxServed}` }
  })

  runClaim('C10', 'the entity bound the previous row added still holds: the largest recipient list times the population never exceeds the per-tick visit budget', () => {
    const ok = all.every((m) => m.maxServed * ENTITIES <= Math.max(SNAP_ENTITY_VISITS_PER_TICK, ENTITIES))
    return { ok, detail: `visits=${all.map((m) => m.maxServed * ENTITIES).join('/')} of ${Math.max(SNAP_ENTITY_VISITS_PER_TICK, ENTITIES)} budget=${SNAP_ENTITY_VISITS_PER_TICK} recipient_ceiling=${PLAYERS_PER_SNAP_GROUP}` }
  })

  const passed = claims.filter(Boolean).length
  if (failures.length > 0) for (const f of failures) console.error(`${TAG} [FAIL] ${f}`)
  if (passed !== claims.length || failures.length > 0) {
    console.log(`${TAG} RESULT: FAIL -- ${claims.length - passed} claim(s) and ${failures.length} expectation(s) failed`)
    process.exitCode = 1
    return
  }
  console.log(`${TAG} RESULT: PASS -- ${passed} of ${claims.length} claim(s)`)
}

main().then(() => { if (process.exitCode === undefined) process.exitCode = 0 }).catch((e) => {
  console.log(`${TAG} RESULT: FAIL (witness error: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e})`)
  process.exitCode = 1
})
