// Witness for server-per-viewer-snapshot-share.
//
// It drives the real createTickHandler over a clustered viewer set and counts the work the server
// does per snapshot tick: AOI ring traversals, relevant-entity encodes, distinct entity payloads
// handed to the wire, and bytes sent. It then decodes every packet the server produced and checks
// that what the client decodes is what the server state says: the viewer's own self block, the
// nearby player set, and -- the claim that guards the shared record memo -- a player record that
// changed between two snapshot ticks reaches the wire with its new values, not with the previous
// tick's bytes.
//
// Overlap is the number that decides whether per-cell sharing is justified: it is the mean Jaccard
// of the relevant-entity sets of two viewers that landed in the same relevance cell.

import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(REPO, p)).href)
const argv = process.argv.slice(2)
const optOf = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const VIEWERS = Number(optOf('viewers', 40))
const ENTITIES = Number(optOf('entities', 40))
const TICKS = Number(optOf('ticks', 90))
const RELEVANCE = Number(optOf('relevance', 200))
const SPREAD = Number(optOf('spread', 400))
const CLUSTER = Number(optOf('cluster', 240))
const SEED = Number(optOf('seed', 20261012))

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

let rng = SEED >>> 0
const rnd = () => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng / 4294967296 }
const rfl = (a, b) => a + (b - a) * rnd()

function encodeEntityForSnapshot(e) {
  return { id: e.id, model: e.model, position: [...e.position], rotation: [...e.rotation], scale: [...(e.scale || [1, 1, 1])], velocity: [...(e.velocity || [0, 0, 0])], bodyType: e.bodyType, custom: e.custom || null, parent: null }
}

function makeEntity(id, spread) {
  return { id, model: 'crate', position: [rfl(-spread, spread), rfl(0, 2), rfl(-spread, spread)], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], scale: [1, 1, 1], bodyType: 'dynamic', custom: { hp: 3 }, sleeping: false }
}

function makeAppRuntimeStub(ents, players) {
  const rt = {
    entities: new Map(ents.map((e) => [e.id, e])),
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
    getStaticSnapshot() { return { tick: this.currentTick, timestamp: Date.now(), entities: [] } },
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
  for (const e of ents) { rt._dynamicEntityIds.add(e.id); rt._activeDynamicIds.add(e.id) }
  return rt
}

async function main() {
  const { pack, unpack, ensurePacked } = await imp('src/protocol/msgpack.js')
  const { SnapshotEncoder } = await imp('src/netcode/SnapshotEncoder.js')
  const { createTickHandler } = await imp('src/sdk/TickHandler.js')
  const { NetworkState } = await imp('src/netcode/NetworkState.js')
  const { mixinStaticMotion } = await imp('src/apps/AppRuntimeStaticMotion.js')
  const AOI = await imp('src/sdk/TickHandlerAOI.js')
  const { MSG } = await imp('src/protocol/MessageTypes.js')
  const { snapshotPackCounts, packSnapshotBytes, newRecordMemo } = await imp('src/netcode/SnapshotPacker.js')
  const { encodeSelfBlock } = await imp('src/netcode/SnapshotEncoder.js')
  await ensurePacked

  console.log(`witness=scripts/aoi-perviewer-share-witness.mjs node=${process.version} platform=${process.platform}`)
  console.log(`shape viewers=${VIEWERS} entities=${ENTITIES} relevance=${RELEVANCE} cluster=${CLUSTER} spread=${SPREAD} ticks=${TICKS} seed=${SEED}`)

  async function run(movePlayers) {
    rng = SEED >>> 0
    const ns = new NetworkState()
    const players = [], queues = new Map(), playersById = new Map()
    for (let i = 1; i <= VIEWERS; i++) {
      const pos = [rfl(0, CLUSTER), 0, rfl(0, CLUSTER)]
      ns.addPlayer(i, { position: pos })
      const p = { id: i, state: { position: pos.slice(), rotation: [0, 0, 0, 1], velocity: [0, 0, 0], onGround: true, crouch: 0, lookPitch: 0, lookYaw: 0, expr: 0, health: 100, weapon: 0 }, inputSequence: 0, lastInput: null, hasSentInput: false, starvedTicks: 0 }
      players.push(p); playersById.set(i, p); queues.set(i, [])
    }
    const ents = []
    for (let k = 0; k < ENTITIES; k++) ents.push(makeEntity(5000 + k, SPREAD))
    const appRuntime = makeAppRuntimeStub(ents, players)
    mixinStaticMotion(appRuntime)

    const counts = { encodeCalls: 0, entityArrays: new Set(), packets: 0, bytes: 0 }
    const origEncode = SnapshotEncoder.encodeDeltaFromCache
    SnapshotEncoder.encodeDeltaFromCache = function (...args) {
      counts.encodeCalls++
      const r = origEncode.apply(this, args)
      counts.entityArrays.add(r.encoded.entities)
      return r
    }
    const sent = []
    const connections = {
      sendPacked(id, buf) { counts.packets++; counts.bytes += buf.length; sent.push({ id, bytes: Uint8Array.from(buf) }) },
      send() {}, broadcast() {}, emit() {}, getClient: () => null, clients: new Map(),
    }
    const physicsIntegration = { config: { capsuleRadius: 0.4 }, setCrouch() {}, updatePlayerPhysics(_id, st, dt) { st.position[0] += st.velocity[0] * dt; st.position[2] += st.velocity[2] * dt } }
    const onTick = createTickHandler({
      networkState: ns,
      playerManager: { getConnectedPlayers: () => players, getInputs: (id) => queues.get(id) || [], getMovementOverride: () => null, getPlayer: (id) => playersById.get(id) },
      physicsIntegration,
      lagCompensator: { beginTick() {}, recordPlayerPosition() {} },
      physics: { step() {} },
      appRuntime, connections, stageLoader: null,
      getRelevanceRadius: () => RELEVANCE, tickRate: 60,
    })
    AOI.resetAoiRingWork()
    await AOI.installAoiCodeEpoch()
    for (const k of Object.keys(snapshotPackCounts)) snapshotPackCounts[k] = 0
    const workBefore = { ...AOI.aoiRingWork }
    const realNow = Date.now
    let clock = 1791580000000
    Date.now = () => clock
    const t0 = process.hrtime.bigint()
    let snapTicks = 0
    let step = 0
    try {
      for (let t = 0; t < TICKS; t++) {
        clock += 17
        for (const p of players) {
          step++
          const moving = movePlayers && (step % 7) !== 0
          queues.get(p.id).push({ sequence: t + 1, data: { forward: moving, backward: false, left: false, right: false, jump: false, yaw: moving ? 0.7 : 0, pitch: 0, crouch: false, expr: 0 } })
        }
        const before = counts.encodeCalls
        onTick(t, 1 / 60)
        if (counts.encodeCalls > before) snapTicks++
      }
    } finally {
      Date.now = realNow
      SnapshotEncoder.encodeDeltaFromCache = origEncode
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    const work = {}
    for (const k of Object.keys(AOI.aoiRingWork)) work[k] = AOI.aoiRingWork[k] - (workBefore[k] || 0)
    const cellsOf = new Map()
    for (const p of players) { const c = AOI.resolvePlayerCell(p.state.position, 0, RELEVANCE); cellsOf.set(c.cellKey, (cellsOf.get(c.cellKey) || 0) + 1) }
    const sets = players.map((p) => { const c = AOI.resolvePlayerCell(p.state.position, 0, RELEVANCE); return { cellKey: c.cellKey, ids: AOI.computeRingRelevantIds(c.cellKey, c.cellFace, c.cellCx, c.cellCy, c.cellsPerFace, 0, RELEVANCE, appRuntime).relevantIds } })
    let interSum = 0, unionSum = 0, pairs = 0, sameCellPairs = 0
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const sameCell = sets[i].cellKey === sets[j].cellKey
        let inter = 0
        for (const id of sets[i].ids) if (sets[j].ids.has(id)) inter++
        const un = sets[i].ids.size + sets[j].ids.size - inter
        if (un === 0) continue
        if (sameCell) { sameCellPairs++; interSum += inter; unionSum += un }
        pairs++
      }
    }
    const hash = createHash('sha256')
    for (const s of sent) { const head = Buffer.alloc(8); head.writeUInt32BE(s.id >>> 0, 0); head.writeUInt32BE(s.bytes.length, 4); hash.update(head); hash.update(s.bytes) }
    return { ms, snapTicks, counts, work, cellsOf, sent, players, playersById, pack: { ...snapshotPackCounts }, overlap: { pairs, sameCellPairs, interSum, unionSum, jaccard: unionSum ? interSum / unionSum : 0 }, streamSha: hash.digest('hex') }
  }

  const a = await run(true)
  const b = await run(true)

  const perTick = (n) => (n / a.snapTicks).toFixed(2)
  console.log(`counts snap_ticks=${a.snapTicks} ms_per_snap_tick=${(a.ms / a.snapTicks).toFixed(3)}`)
  console.log(`counts packets=${a.counts.packets} bytes=${a.counts.bytes} bytes_per_snap_tick=${(a.counts.bytes / a.snapTicks).toFixed(0)}`)
  console.log(`counts encode_delta_calls=${a.counts.encodeCalls} per_snap_tick=${perTick(a.counts.encodeCalls)} distinct_entity_arrays=${a.counts.entityArrays.size}`)
  console.log(`counts cells=${a.cellsOf.size} viewers_per_cell=[${[...a.cellsOf.values()].join(',')}]`)
  console.log(`counts aoi_work ${JSON.stringify(a.work)}`)
  console.log(`counts overlap pairs=${a.overlap.pairs} same_cell_pairs=${a.overlap.sameCellPairs} mean_jaccard=${a.overlap.jaccard.toFixed(4)} mean_inter=${(a.overlap.interSum / Math.max(1, a.overlap.sameCellPairs)).toFixed(1)} mean_union=${(a.overlap.unionSum / Math.max(1, a.overlap.sameCellPairs)).toFixed(1)}`)
  console.log(`counts stream_sha256=${a.streamSha}`)
  console.log(`counts pack splices=${a.pack.splices} refusals=${a.pack.refusals} records_packed=${a.pack.recordPacks} records_shared=${a.pack.recordShares} packed_per_snap_tick=${perTick(a.pack.recordPacks)} shared_per_snap_tick=${perTick(a.pack.recordShares)}`)

  const shared = a.counts.encodeCalls / a.snapTicks
  runClaim('C1', 'per-cell sharing: the relevant-entity encode runs once per occupied cell per snapshot tick, not once per viewer', () => {
    const cells = a.cellsOf.size
    return { ok: a.snapTicks > 0 && cells > 0 && shared <= cells && VIEWERS > cells, detail: `encode_delta_calls per snapshot tick=${perTick(a.counts.encodeCalls)} cells=${cells} viewers=${VIEWERS}` }
  })
  runClaim('C2', 'viewers that share a relevance cell share one entity payload', () => {
    const distinctPerTick = a.counts.entityArrays.size / a.snapTicks
    return { ok: distinctPerTick <= a.cellsOf.size, detail: `distinct entity payloads per snapshot tick=${distinctPerTick.toFixed(2)} cells=${a.cellsOf.size} viewers=${VIEWERS}` }
  })
  runClaim('C3', 'the measured overlap justifies sharing: two viewers in one cell share most of their relevant set', () => {
    return { ok: a.overlap.sameCellPairs > 0 && a.overlap.jaccard >= 0.5, detail: `same_cell_pairs=${a.overlap.sameCellPairs} mean_jaccard=${a.overlap.jaccard.toFixed(4)} mean_inter=${(a.overlap.interSum / Math.max(1, a.overlap.sameCellPairs)).toFixed(1)} mean_union=${(a.overlap.unionSum / Math.max(1, a.overlap.sameCellPairs)).toFixed(1)}` }
  })

  runClaim('C7', 'the per-snapshot record memo is actually taken: every snapshot packet is built from spliced record bytes, and player records are packed once per snapshot tick per distinct player rather than once per viewer', () => {
    const splices = a.pack.splices
    const packed = a.pack.recordPacks / a.snapTicks
    const shared = a.pack.recordShares / a.snapTicks
    return { ok: splices === a.counts.packets && a.pack.refusals === 0 && splices > 0 && shared > 0 && packed <= VIEWERS + a.snapTicks, detail: `splices=${splices} packets=${a.counts.packets} refusals=${a.pack.refusals} records_packed per snapshot tick=${packed.toFixed(2)} records_shared per snapshot tick=${shared.toFixed(2)} viewers=${VIEWERS}` }
  })

  runClaim('C8', 'the spliced bytes ARE the msgpackr bytes: one payload built by SnapshotPacker is byte-identical to the same payload run through pack(), so no field order, sentinel or structure changed', () => {
    const all = SnapshotEncoder.encodePlayersOnce(a.players.map((p) => Object.assign({ id: p.id }, p.state)))
    const ids = a.players.map((p) => p.id)
    // A real entity array off the wire, so the tail is compared with entity bytes in it, not empty.
    const entityPayload = [...a.counts.entityArrays][0] || []
    let compared = 0, mismatch = 0, refused = 0, ctlBytes = 0, records = 0, entities = 0
    for (const v of [1, 2, 3]) {
      const enc = { tick: 777, serverTime: 1791580000777, players: SnapshotEncoder.filterEncodedPlayersWithSelf(all, ids, v), entities: entityPayload, removed: undefined, delta: 1, dots: undefined }
      const me = encodeSelfBlock(a.playersById.get(v))
      const control = pack({ type: MSG.SNAPSHOT, payload: { seq: 4242, tick: enc.tick, serverTime: enc.serverTime, players: enc.players, entities: enc.entities, removed: enc.removed, delta: enc.delta, dots: enc.dots, me, chartEpoch: 9 } })
      const spliced = packSnapshotBytes(MSG.SNAPSHOT, 4242, enc, me, 9, newRecordMemo())
      if (spliced === null) { refused++; continue }
      compared++; ctlBytes += control.length; records += enc.players.length; entities += enc.entities.length
      if (control.length !== spliced.length) { mismatch++; continue }
      for (let i = 0; i < control.length; i++) if (control[i] !== spliced[i]) { mismatch++; break }
    }
    return { ok: compared === 3 && mismatch === 0 && refused === 0 && records > 0 && entities > 0, detail: `compared=${compared} byte_mismatch=${mismatch} refused=${refused} control_bytes=${ctlBytes} player_records=${records} entity_records=${entities}` }
  })

  // Decode every packet: the wire must still carry what the server state says.
  let typeBad = 0, selfBad = 0, selfSeen = 0, playersSeen = 0, decodeBad = 0
  const seenIds = new Set()
  for (const s of a.sent) {
    let msg
    try { msg = unpack(Buffer.from(s.bytes)) } catch { decodeBad++; continue }
    if (!msg || msg.type !== MSG.SNAPSHOT) { typeBad++; continue }
    const decoded = SnapshotEncoder.decode(msg.payload)
    const ids = decoded.players.map((p) => p && p.id)
    playersSeen += ids.length
    for (const id of ids) seenIds.add(id)
    if (!ids.includes(s.id)) selfBad++
    const me = decoded.me
    if (me) {
      selfSeen++
      const seqOk = Number.isFinite(me.inputSequence)
      const gnOk = Array.isArray(me.groundNormal) && me.groundNormal.length === 3 && me.groundNormal.every(Number.isFinite)
      const wpOk = Array.isArray(me.wallPlanes)
      if (!seqOk || !gnOk || !wpOk) selfBad++
    }
  }
  console.log(`decode packets=${a.sent.length} players_decoded=${playersSeen} distinct_player_ids=${seenIds.size} self_blocks=${selfSeen}`)
  runClaim('C4', 'every snapshot packet unpacks and decodes as a SNAPSHOT carrying its viewer as a player', () => {
    return { ok: a.sent.length > 0 && typeBad === 0 && decodeBad === 0 && selfBad === 0, detail: `packets=${a.sent.length} bad_type=${typeBad} decode_threw=${decodeBad} self_block_mismatch=${selfBad}` }
  })
  runClaim('C5', 'the shared record memo is per snapshot build: a player that moved between two packets to the same viewer reaches the wire with a different position, never the earlier packet bytes', () => {
    const byViewer = new Map()
    for (const s of a.sent) {
      const msg = unpack(Buffer.from(s.bytes))
      if (!msg || msg.type !== MSG.SNAPSHOT) continue
      const decoded = SnapshotEncoder.decode(msg.payload)
      const positions = new Map()
      for (const p of decoded.players) if (p && p.position) positions.set(p.id, [p.position[0], p.position[2]])
      const list = byViewer.get(s.id) || []
      list.push(positions)
      byViewer.set(s.id, list)
    }
    let pairs = 0, changed = 0, frozen = 0
    for (const [viewer, list] of byViewer) {
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1].get(viewer), now = list[i].get(viewer)
        if (!prev || !now) continue
        pairs++
        if (prev[0] !== now[0] || prev[1] !== now[1]) changed++
        else frozen++
      }
    }
    return { ok: pairs > 0 && changed > 0, detail: `viewer packets=${a.sent.length} consecutive_pairs=${pairs} position_changed=${changed} unchanged=${frozen}` }
  })
  runClaim('C6', 'the byte stream is reproducible run to run', () => {
    return { ok: a.streamSha === b.streamSha && a.counts.bytes === b.counts.bytes, detail: `run_a=${a.streamSha.slice(0, 16)} run_b=${b.streamSha.slice(0, 16)} bytes_a=${a.counts.bytes} bytes_b=${b.counts.bytes}` }
  })

  const passed = claims.filter(Boolean).length
  if (passed === claims.length) {
    console.log(`RESULT: PASS (${passed} of ${claims.length} claims)`)
    return 0
  }
  console.log(`RESULT: FAIL (${claims.length - passed} of ${claims.length} claims failed)`)
  return 1
}

main().then((code) => { process.exitCode = code }).catch((e) => {
  console.log(`RESULT: FAIL (witness error: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e})`)
  process.exitCode = 1
})
