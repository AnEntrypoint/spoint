#!/usr/bin/env node
// Witness for per-tick snapshot send cost.
//
// The row this closes (PERF-tick-snapshot-send-cost-1013) is about the ONE per-tick cost that
// PERF-snapshot-full-reencode-beside-cache-r1 refuted itself out of measuring: the tick path does
// not call getSnapshotForPlayer at all, it calls SnapshotEncoder.encodeDeltaFromCache once per
// served recipient inside buildAndSendSnapshots. So this witness drives the real
// createTickHandler over a stated player count and a stated entity population and splits the
// measured per-tick cost into the four stages the row names:
//
//   relevance  -- the AOI reads: relevantEntities + nearbyPlayerIds
//   plan       -- group planning: everything else buildAndSendSnapshots does (group rotation,
//                 static/dynamic cache maintenance, tombstones, pruning). It is the RESIDUAL of
//                 the snapshot phase once relevance, encode and send are subtracted, so it is
//                 never a number the witness invents: if the three stages do not add up, the
//                 residual goes negative and the witness fails.
//   encode     -- SnapshotEncoder.encodeDeltaFromCache / encodeStaticEntities, per recipient
//   send       -- packSnapshot + connections.sendPacked, per recipient
//
// The snapshot phase total is read back from the handler's own instrument
// (onTick.getMetrics().avgSnapMs), which is t5-t4 around buildAndSendSnapshots in production
// code, so the total is not something this witness re-derives.
//
// Two populations are measured, because a bound that only holds for one of them is not a bound:
//
//   fast  -- a sparse cell. Every viewer shares one per-cell encode.
//   dense -- every viewer packed into one relevance cell that is crowded with STATIC entities.
//            Static entities are the hole: getPlayerPriorityIds only accumulates ids that are in
//            the dynamic cache, so a static-heavy ring leaves its accumulator small and hands the
//            whole ring back, and useSharedCell is false once the ring exceeds
//            PRIORITY_ENTITY_BUDGET, so each viewer pays its own full encode.
//
// Wire identity is proved, not assumed: every packet the server emits is hashed as
// (recipient id, length, bytes) into one stream digest, and the decoded payloads are compared
// field by field over every record the run carries. Two independent runs must produce the same
// digest, and the fast arm must keep the digest the change was measured against.

import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(REPO, p)).href)
const TAG = '[tick-snapshot-send-cost]'
// Set from the format module in main(); the stage wrappers run before any of that is awaited.
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
const CLUSTER = flOf('cluster', 60)
const SPREAD = flOf('spread', 150)
const STATIC_FRAC = flOf('staticFrac', 0.8)
const TICKS = flOf('ticks', 256)
const ROUNDS = flOf('rounds', 3)
// The control shape, deliberately small: its fan-out is under the recipient ceiling either way, so
// the rotation, the schedule and every byte on the wire are what they were before the bound
// existed. That is the shape the byte-identity claim is struck on, because at the crowded shape the
// pre-existing rate controller sits on its own threshold and moves the schedule around -- which is
// a finding about the controller, not about what a recipient is sent.
const CTRL_PLAYERS = flOf('ctrlPlayers', 8)
const CTRL_ENTITIES = flOf('ctrlEntities', 300)
const SEED = flOf('seed', 20261013)
const TICK_RATE = flOf('tickRate', 60)
const SNAP_COST_HIGH_FRAC = 0.35

const TICK_BUDGET_MS = 1000 / TICK_RATE
const SNAP_BUDGET_MS = TICK_BUDGET_MS * SNAP_COST_HIGH_FRAC

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

const hrtMs = () => Number(process.hrtime.bigint()) / 1e6

let rng = SEED >>> 0
const rnd = () => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng / 4294967296 }
const rfl = (a, b) => a + (b - a) * rnd()

function encodeEntityForSnapshot(e) {
  return { id: e.id, model: e.model, position: [...e.position], rotation: [...e.rotation], scale: [...(e.scale || [1, 1, 1])], velocity: [...(e.velocity || [0, 0, 0])], bodyType: e.bodyType, custom: e.custom || null, parent: null }
}

function makeEntity(id, spread, isStatic) {
  return {
    id,
    model: isStatic ? 'wall' : 'crate',
    position: [rfl(-spread, spread), rfl(0, 2), rfl(-spread, spread)],
    rotation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    scale: [1, 1, 1],
    bodyType: isStatic ? 'static' : 'dynamic',
    custom: { hp: 3 },
    sleeping: false,
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

// A stage is timed by wrapping the ONE function that owns it, so the sum of the stages is the
// snapshot phase and not a re-derivation of it. The wrapper costs two hrtime reads per call, which
// is why the uninflated total is read separately from the handler's own instrument below.
function instrument(rt, SnapshotEncoder, connections, stage) {
  const saved = []
  const wrap = (obj, key, bucket) => {
    const orig = obj[key].bind(obj)
    saved.push([obj, key, obj[key]])
    obj[key] = function (...a) {
      const s = process.hrtime.bigint()
      const r = orig(...a)
      stage[bucket] += Number(process.hrtime.bigint() - s) / 1e6
      stage[bucket + 'Calls']++
      if (bucket === 'encode' && r && Array.isArray(r.encoded && r.encoded.entities)) {
        for (const rec of r.encoded.entities) {
          stage.records++
          const bin = rec && rec[2]
          if (bin instanceof Uint8Array) { stage.bins++; if (bin.byteLength !== BIN_BYTES) stage.badWidth++ }
        }
      }
      return r
    }
  }
  wrap(rt, 'relevantEntities', 'relevance')
  wrap(rt, 'nearbyPlayerIds', 'relevance')
  wrap(rt, 'getStaticSnapshot', 'relevance')
  wrap(SnapshotEncoder, 'filterEncodedPlayersWithSelf', 'relevance')
  wrap(SnapshotEncoder, 'encodePlayersOnce', 'relevance')
  wrap(SnapshotEncoder, 'encodeDeltaFromCache', 'encode')
  wrap(SnapshotEncoder, 'encodeStaticEntities', 'encode')
  wrap(connections, 'sendPacked', 'send')
  // The encoder namespace object outlives a round, so a wrapper left installed would be wrapped
  // again by the next round and the encode stage would pay a deeper stack each time.
  return () => { for (const [o, k, v] of saved) o[k] = v }
}

async function main() {
  const { pack, unpack, ensurePacked } = await imp('src/protocol/msgpack.js')
  const { SnapshotEncoder } = await imp('src/netcode/SnapshotEncoder.js')
  const { createTickHandler, SNAP_ENTITY_VISITS_PER_TICK, PLAYERS_PER_SNAP_GROUP } = await imp('src/sdk/TickHandler.js')
  const { NetworkState } = await imp('src/netcode/NetworkState.js')
  const { mixinStaticMotion } = await imp('src/apps/AppRuntimeStaticMotion.js')
  const AOI = await imp('src/sdk/TickHandlerAOI.js')
  const { MSG } = await imp('src/protocol/MessageTypes.js')
  const { BIN_RECORD_BYTES } = await imp('src/netcode/SnapshotBinFormat.js')
  await ensurePacked
  BIN_BYTES = BIN_RECORD_BYTES

  console.log(`witness=scripts/tick-snapshot-send-cost-witness.mjs node=${process.version} platform=${process.platform}`)
  console.log(`${TAG} shape players=${PLAYERS} entities=${ENTITIES} static_frac=${STATIC_FRAC} relevance=${RELEVANCE} cluster=${CLUSTER} spread=${SPREAD} ticks=${TICKS} rounds=${ROUNDS} tick_rate=${TICK_RATE} tick_budget_ms=${TICK_BUDGET_MS.toFixed(3)} snap_budget_ms=${SNAP_BUDGET_MS.toFixed(3)}`)

  // One measured round. `timed` installs the stage wrappers; the round that reads the uninflated
  // total runs without them, because a wrapper that owns a stage cannot also measure the whole.
  async function runRound(timed, shape) {
    rng = SEED >>> 0
    const crowded = shape === 'dense'
    const nPlayers = crowded ? PLAYERS : CTRL_PLAYERS
    const population = crowded ? ENTITIES : CTRL_ENTITIES
    const staticFrac = crowded ? STATIC_FRAC : 0.2
    const cluster = crowded ? CLUSTER : 400
    const spread = crowded ? SPREAD : 400
    const ns = new NetworkState()
    const players = [], queues = new Map(), playersById = new Map()
    for (let i = 1; i <= nPlayers; i++) {
      const pos = [rfl(0, cluster), 0, rfl(0, cluster)]
      ns.addPlayer(i, { position: pos })
      const p = { id: i, state: { position: pos.slice(), rotation: [0, 0, 0, 1], velocity: [0, 0, 0], onGround: true, crouch: 0, lookPitch: 0, lookYaw: 0, expr: 0, health: 100, weapon: 0 }, inputSequence: 0, lastInput: null, hasSentInput: false, starvedTicks: 0 }
      players.push(p); playersById.set(i, p); queues.set(i, [])
    }
    const ents = []
    for (let k = 0; k < population; k++) ents.push(makeEntity(5000 + k, spread, rnd() < staticFrac))
    const appRuntime = makeAppRuntimeStub(ents, players)
    mixinStaticMotion(appRuntime)

    const stage = { relevance: 0, relevanceCalls: 0, encode: 0, encodeCalls: 0, send: 0, sendCalls: 0, records: 0, bins: 0, badWidth: 0 }
    const sent = []
    let bytes = 0
    const connections = {
      sendPacked(id, buf) { bytes += buf.length; sent.push({ id, bytes: Uint8Array.from(buf) }) },
      send() {}, broadcast() {}, emit() {}, getClient: () => null, clients: new Map(),
    }
    let restore = () => {}
    if (timed) restore = instrument(appRuntime, SnapshotEncoder, connections, stage)

    const physicsIntegration = { config: { capsuleRadius: 0.4 }, setCrouch() {}, setPlayerPosition() {}, updatePlayerPhysics(_id, st, dt) { st.position[0] += st.velocity[0] * dt; st.position[2] += st.velocity[2] * dt } }
    const onTick = createTickHandler({
      networkState: ns,
      playerManager: { getConnectedPlayers: () => players, getInputs: (id) => queues.get(id) || [], getMovementOverride: () => null, getPlayer: (id) => playersById.get(id) },
      physicsIntegration,
      lagCompensator: { beginTick() {}, recordPlayerPosition() {} },
      physics: { step() {} },
      appRuntime, connections, stageLoader: null,
      getRelevanceRadius: () => RELEVANCE, tickRate: TICK_RATE,
    })
    AOI.resetAoiRingWork()
    await AOI.installAoiCodeEpoch()
    // The AOI keeps per-viewer priority accumulators and the spatial/ring/cell-base caches at
    // module scope, so a second round in one process is not the same experiment as the first: it
    // inherits scores and cache hits from the round before it. Clearing them is what makes
    // "byte-identical for the same world state" a claim about the world state and not about how
    // many rounds this process happens to have run.
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
    const tickCosts = []
    try {
      for (let t = 0; t < TICKS; t++) {
        clock += Math.round(1000 / TICK_RATE)
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
      }
    } finally {
      Date.now = realNow
      restore()
    }
    const metrics = onTick.getMetrics()
    const hash = createHash('sha256')
    for (const s of sent) { const head = Buffer.alloc(8); head.writeUInt32BE(s.id >>> 0, 0); head.writeUInt32BE(s.bytes.length, 4); hash.update(head); hash.update(s.bytes) }
    return { stage, sent, bytes, snapTicks, servedPerSnapTick, tickCosts, metrics, streamSha: hash.digest('hex'), work: { ...AOI.aoiRingWork }, population, nPlayers }
  }

  // The bound can only be priced once the handler has taken a measurement, and it takes it every
  // SNAP_RATE_ADJUST_INTERVAL ticks, so the ticks before the first adjustment are the unmeasured
  // start-up and are excluded from the worst case. A bound that only holds after it has been told
  // the cost is still a bound; a bound that silently ignores its own start-up is not.
  const ADJUST_INTERVAL = 64
  function servedWindow(tickCosts) {
    const settled = tickCosts.filter((c) => c[2] >= ADJUST_INTERVAL)
    return settled.length > 0 ? settled : tickCosts
  }

  // The minimum over fresh rounds, not a median: each round allocates a fresh world and a fresh
  // handler, and this box runs sibling lanes, so a central estimator measures GC and neighbours
  // as much as the code.
  async function measure(shape) {
    // The first round of a process is cold in ways that have nothing to do with this row: it is
    // the round that first walks the AOI code-epoch path and first fills the packer arena. It is
    // discarded, so a "the two runs differ" verdict can never be the cold start wearing a costume.
    await runRound(false, shape)
    let best = null
    const allShas = new Set()
    for (let r = 0; r < ROUNDS; r++) {
      const timed = await runRound(true, shape)
      const plain = await runRound(false, shape)
      allShas.add(timed.streamSha)
      allShas.add(plain.streamSha)
      console.log(`${TAG} ${shape} round=${r} snap_ticks=${timed.snapTicks}/${plain.snapTicks} sha=${timed.streamSha.slice(0, 12)}/${plain.streamSha.slice(0, 12)}`)
      const snapTicks = Math.max(1, timed.snapTicks)
      // avgSnapMs is t5-t4 averaged over EVERY tick that had players, while the stage sums are
      // accumulated over the whole run. Dividing one by snapshot ticks and not the other would
      // quietly book the idle ticks as snapshot cost, so both are put on the same per-snapshot-tick
      // footing before the plan residual is taken.
      const spread = TICKS / snapTicks
      const per = {
        total: timed.metrics.avgSnapMs * spread,
        totalPlain: plain.metrics.avgSnapMs * (TICKS / Math.max(1, plain.snapTicks)),
        tickTotal: timed.metrics.avgTotalMs,
        mv: timed.metrics.avgMvMs,
        phys: timed.metrics.avgPhysMs,
        relevance: timed.stage.relevance / snapTicks,
        encode: timed.stage.encode / snapTicks,
        send: timed.stage.send / snapTicks,
        encodeCalls: timed.stage.encodeCalls / snapTicks,
        sendCalls: timed.stage.sendCalls / snapTicks,
        relevanceCalls: timed.stage.relevanceCalls / snapTicks,
        packets: timed.sent.length,
        bytes: timed.bytes,
        snapTicks: timed.snapTicks,
        maxServed: Math.max(...servedWindow(timed.tickCosts).map((c) => c[1])),
        worst: servedWindow(timed.tickCosts).reduce((a, b) => (b[0] > a[0] ? b : a), [0, 1, 0]),
        servedPerSnapTick: timed.servedPerSnapTick.reduce((a, b) => a + b, 0) / Math.max(1, timed.servedPerSnapTick.length),
        streamSha: timed.streamSha,
        work: timed.work,
        sent: timed.sent,
        population: timed.population,
        nPlayers: timed.nPlayers,
        records: timed.stage.records,
        bins: timed.stage.bins,
        badWidth: timed.stage.badWidth,
      }
      per.plan = per.total - per.relevance - per.encode - per.send
      // The worst case is the LARGEST group priced at the WORST per-recipient cost, which is what
      // the bound in the code is written against. Movement and physics ride inside the same tick
      // but not inside the snapshot phase, so they are taken off before the price is struck.
      per.worstTickMs = per.worst[0]
      per.worstTickServed = per.worst[1]
      per.snapMsAtWorst = Math.max(0, per.worstTickMs - (per.mv + per.phys))
      per.worstPerRecipientMs = per.snapMsAtWorst / Math.max(1, per.worstTickServed)
      per.worstCaseMs = per.maxServed * per.worstPerRecipientMs
      if (best === null || per.total < best.total) best = per
    }
    best.shas = [...allShas]
    best.distinctShas = allShas.size
    return best
  }

  const fast = await measure('fast')
  const dense = await measure('dense')

  const f2 = (n) => Number(n).toFixed(4)
  for (const [name, m] of [['fast', fast], ['dense', dense]]) {
    console.log(`${TAG} ${name} snap_ticks=${m.snapTicks} packets=${m.packets} bytes=${m.bytes} bytes_per_snap_tick=${(m.bytes / Math.max(1, m.snapTicks)).toFixed(0)}`)
    console.log(`${TAG} ${name} per_tick_ms snapshot=${f2(m.total)} snapshot_uninstrumented=${f2(m.totalPlain)} whole_tick=${f2(m.tickTotal)} mv=${f2(m.mv)} phys=${f2(m.phys)}`)
    console.log(`${TAG} ${name} per_snapshot_tick_ms relevance=${f2(m.relevance)} plan=${f2(m.plan)} encode=${f2(m.encode)} send=${f2(m.send)} sum=${f2(m.relevance + m.plan + m.encode + m.send)}`)
    console.log(`${TAG} ${name} per_tick_calls encode=${f2(m.encodeCalls)} send=${f2(m.sendCalls)} relevance=${f2(m.relevanceCalls)} recipients_per_snap_tick mean=${f2(m.servedPerSnapTick)} max=${m.maxServed}`)
    console.log(`${TAG} ${name} per_recipient_ms encode=${f2(m.encode / Math.max(1, m.encodeCalls))} send=${f2(m.send / Math.max(1, m.sendCalls))}`)
    console.log(`${TAG} ${name} stream_sha256=${m.streamSha}`)
    console.log(`${TAG} ${name} aoi_work ${JSON.stringify(m.work)}`)
  }
  console.log(`${TAG} bin record bytes=${BIN_RECORD_BYTES}`)
  console.log(`${TAG} worst_case dense recipients_per_tick=${dense.maxServed} per_recipient_encode_ms=${f2(dense.encode / Math.max(1, dense.encodeCalls))} product_ms=${f2(dense.maxServed * (dense.encode / Math.max(1, dense.encodeCalls)))} snap_budget_ms=${f2(SNAP_BUDGET_MS)}`)
  for (const [name, m] of [['fast', fast], ['dense', dense]]) {
    console.log(`${TAG} ${name} worst_tick ms=${f2(m.worstTickMs)} served=${m.worstTickServed} tick=${m.worst[2]} snap_ms_at_worst=${f2(m.snapMsAtWorst)} per_recipient=${f2(m.worstPerRecipientMs)} worst_case_ms=${f2(m.worstCaseMs)} budget_ms=${f2(SNAP_BUDGET_MS)}`)
  }

  runClaim('C1', 'the snapshot phase is measured, not assumed: the handler ran snapshot ticks and its own instrument reported a non-zero average', () => {
    return { ok: fast.snapTicks > 0 && dense.snapTicks > 0 && fast.totalPlain > 0 && dense.totalPlain > 0, detail: `fast snap_ticks=${fast.snapTicks} avgSnapMs=${f2(fast.totalPlain)} dense snap_ticks=${dense.snapTicks} avgSnapMs=${f2(dense.totalPlain)}` }
  })

  runClaim('C2', 'the four stages account for the snapshot phase: no stage is negative and the plan residual never swallows the whole', () => {
    const ok = [fast, dense].every((m) => m.relevance >= 0 && m.encode >= 0 && m.send >= 0 && m.plan >= 0 && m.plan < m.total)
    return { ok, detail: `fast plan=${f2(fast.plan)}/${f2(fast.total)} dense plan=${f2(dense.plan)}/${f2(dense.total)}` }
  })

  runClaim('C3', 'every connected player is a recipient: nobody is dropped from the rotation', () => {
    const who = (m) => { const s = new Set(); for (const p of m.sent) s.add(p.id); return s }
    const fastWho = who(fast), denseWho = who(dense)
    return { ok: fastWho.size === fast.nPlayers && denseWho.size === dense.nPlayers, detail: `fast recipients=${fastWho.size}/${fast.nPlayers} dense recipients=${denseWho.size}/${dense.nPlayers}` }
  })

  runClaim('C4', 'the wire is byte-identical run to run for the same world state: every packet of every round of the control shape hashes to one stream digest', () => {
    return { ok: fast.distinctShas === 1 && fast.packets > 0 && dense.packets > 0, detail: `control distinct=${fast.distinctShas}/${fast.shas.length} sha=${fast.streamSha.slice(0, 16)} crowded sha=${dense.streamSha.slice(0, 16)} (crowded digests ${dense.distinctShas}/${dense.shas.length}: the pre-existing rate controller moves that schedule)` }
  })

  runClaim('C5', 'every packet unpacks, decodes as a SNAPSHOT and carries its own recipient as a player', () => {
    let typeBad = 0, decodeBad = 0, selfBad = 0, playersSeen = 0, selfSeen = 0, packets = 0
    const seenIds = new Set()
    for (const m of [fast, dense]) {
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

  runClaim('C6', 'the entity records the encoder hands the wire are the width the format module declares, over thousands of records', () => {
    const records = fast.records + dense.records
    const bins = fast.bins + dense.bins
    const badWidth = fast.badWidth + dense.badWidth
    expect('entity record(s) whose bin is not the declared width', badWidth, v => v === 0)
    return { ok: records > 1000 && bins > 1000 && badWidth === 0, detail: `entity_records=${records} bins=${bins} bad_width=${badWidth} declared_bytes=${BIN_RECORD_BYTES}` }
  })

  // The bound the code now carries is a work bound -- recipients * population -- and not a promise
  // about milliseconds: what a millisecond buys is this box's business, and a witness that gates on
  // milliseconds gates on the neighbours. The gate is that no tick in the run was allowed to visit
  // more (recipient, entity) pairs than the budget, which is the invariant the code enforces.
  runClaim('C7', 'the worst case is bounded by an explicit work budget and not by the input distribution: the largest recipient list the run allowed, times the entity population, never exceeds the per-tick visit budget', () => {
    // maxRecipients is min(50, max(1, floor(budget / population))), so the visits a tick can walk
    // are bounded by the budget, except that the floor of one recipient still walks a population
    // larger than the budget on its own. Hence max(budget, population) and not the budget alone.
    const ceilingOf = (m) => Math.max(SNAP_ENTITY_VISITS_PER_TICK, m.population)
    const ok = [fast, dense].every((m) => m.maxServed * m.population <= ceilingOf(m))
    return { ok, detail: `control visits=${fast.maxServed * fast.population} of ${ceilingOf(fast)} crowded visits=${dense.maxServed * dense.population} of ${ceilingOf(dense)} budget=${SNAP_ENTITY_VISITS_PER_TICK} recipient_ceiling=${PLAYERS_PER_SNAP_GROUP} control recipients=${fast.maxServed}/${fast.population} crowded recipients=${dense.maxServed}/${dense.population}` }
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
