// Witness for planet-snapshot-prepacked-player-records.
//
// Byte identity: per-viewer snapshot bytes from the spliced path
// (src/netcode/SnapshotPacker.js packSnapshotBytes) must equal, byte for byte,
// pack({ type, payload }) of the TickHandler wrapper. Three input sets are used:
// realistic per-viewer payloads built with the production SnapshotEncoder, edge
// payloads (array-length boundaries, integer and float extremes, bundled strings
// over one bundle, string player ids that must fall back), and an end-to-end
// onTick run through createTickHandler whose sendPacked bytes are hashed.
//
// Timing: per-viewer pack time at 30, 40 and 64 neighbours. Each of three runs
// alternates one baseline pass and one change pass over the same viewers, so both
// sides see the same machine conditions; a run's figure is the median pass. The
// claim holds when the change is at most CLAIM_MAX_RATIO x baseline in every run at
// every neighbour count.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flagOn = (name) => argv.includes(`--${name}`)
const optOf = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const BASELINE_ONLY = flagOn('baseline-only')
const MUTANT = flagOn('mutant')
const MODULE_REL = optOf('module', 'src/netcode/SnapshotPacker.js')
const BASELINE_REL = optOf('baseline', '.gm/witness-out/snapshot-prepacked-baseline.json')
const CLAIM_MAX_RATIO = 0.9
const NEIGHBOUR_COUNTS = [30, 40, 64]
const TIMING_RUNS = 3
const TIMING_SETS = 6
const TIMING_VIEWERS = 48
const TIMING_PASSES = 30
const SEED = 20261009
const CLOCK_BASE_MS = 1791580000000

const say = (s) => console.log(s)

let rngState = SEED >>> 0
const rnd = () => { rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0; return rngState / 4294967296 }
const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1))
const rfl = (a, b) => a + (b - a) * rnd()
const pickOf = (arr) => arr[Math.floor(rnd() * arr.length)]
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}

function makePlayer(id, spread) {
  const yaw = rfl(0, 6.2)
  return {
    id,
    position: [rfl(-spread, spread), rfl(0, 2), rfl(-spread, spread)],
    rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
    velocity: [rfl(-5, 5), 0, rfl(-5, 5)],
    onGround: rnd() < 0.7,
    health: rint(0, 120),
    crouch: rnd() < 0.2 ? 1 : 0,
    lookPitch: rfl(-1.3, 1.3),
    lookYaw: yaw,
    expr: rint(0, 4),
    weapon: rint(0, 3),
    inputSequence: rint(0, 50000),
    inputBuffer: rint(0, 6),
    groundNormal: rnd() < 0.5 ? [0, 1, 0] : [rfl(-0.2, 0.2), 0.98, rfl(-0.2, 0.2)],
    wallNormals: rnd() < 0.25 ? [rfl(-1, 1), rfl(-1, 1)] : null,
  }
}

function makeEntity(id, spread, customChars = 0) {
  let custom
  if (customChars) custom = { blob: 'x'.repeat(customChars) }
  else if (rnd() < 0.4) custom = { hp: rint(1, 9), name: 'crate-' + id }
  return {
    id,
    model: pickOf(['crate', 'barrel', 'tree-oak', 'ab']),
    position: [rfl(-spread, spread), rfl(0, 3), rfl(-spread, spread)],
    rotation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    scale: [1, 1, 1],
    bodyType: pickOf(['dynamic', 'kinematic']),
    custom,
    sleeping: rnd() < 0.5,
  }
}

function pickNeighbours(ids, self, n) {
  const others = ids.filter((id) => id !== self)
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const t = others[i]; others[i] = others[j]; others[j] = t
  }
  return [self, ...others.slice(0, Math.max(0, n - 1))]
}

function viewerPayload(SE, allEncoded, playersById, ids, viewerId, n, clientSeq, reducedTickMod) {
  const nearby = pickNeighbours(ids, viewerId, n)
  const viewer = playersById.get(viewerId)
  if (nearby.length > 30) {
    const t = SE.filterEncodedPlayersTiered(allEncoded, playersById, nearby, viewerId, viewer.position, clientSeq, reducedTickMod)
    return { players: t.players, dots: t.dots.length ? t.dots : undefined, me: SE.encodeSelfBlock(viewer) }
  }
  return { players: SE.SnapshotEncoder.filterEncodedPlayersWithSelf(allEncoded, nearby, viewerId), dots: undefined, me: SE.encodeSelfBlock(viewer) }
}

function encodeEntities(SE, raws, tick, serverTime) {
  return SE.SnapshotEncoder.encodeDelta({ tick, serverTime, players: [], entities: raws }, new Map(), []).encoded.entities
}

async function main() {
  const { pack, ensurePacked } = await import(pathToFileURL(join(REPO, 'src/protocol/msgpack.js')).href)
  const { MSG } = await import(pathToFileURL(join(REPO, 'src/protocol/MessageTypes.js')).href)
  const SE = await import(pathToFileURL(join(REPO, 'src/netcode/SnapshotEncoder.js')).href)
  const { createTickHandler } = await import(pathToFileURL(join(REPO, 'src/sdk/TickHandler.js')).href)
  const { NetworkState } = await import(pathToFileURL(join(REPO, 'src/netcode/NetworkState.js')).href)
  await ensurePacked

  let CHG = null
  if (!BASELINE_ONLY) {
    const modPath = resolve(REPO, MODULE_REL)
    if (!existsSync(modPath)) { say(`RESULT: FAIL (module path missing: ${MODULE_REL})`); return 1 }
    try { CHG = await import(pathToFileURL(modPath).href) } catch (e) { say(`RESULT: FAIL (module import threw: ${e.message})`); return 1 }
    if (typeof CHG.packSnapshotBytes !== 'function' || typeof CHG.newRecordMemo !== 'function') {
      say('RESULT: FAIL (module lacks packSnapshotBytes or newRecordMemo export)')
      return 1
    }
  }

  const mode = BASELINE_ONLY ? 'baseline-only' : (MUTANT ? 'mutant' : 'change')
  say(`witness=scripts/snapshot-prepacked-witness.mjs node=${process.version} platform=${process.platform} mode=${mode} module=${BASELINE_ONLY ? 'none' : MODULE_REL}`)

  const ident = { cases: 0, bytes: 0, fast: 0, fallback: 0, mismatch: null, baseHash: createHash('sha256'), chgHash: createHash('sha256') }
  const judge = (label, seq, enc, me, chartEpoch, expectFast) => {
    const base = Buffer.from(pack({ type: MSG.SNAPSHOT, payload: { seq, tick: enc.tick, serverTime: enc.serverTime, players: enc.players, entities: enc.entities, removed: enc.removed, delta: enc.delta, dots: enc.dots, me, chartEpoch } }))
    ident.cases++
    ident.bytes += base.length
    ident.baseHash.update(base)
    if (!CHG) return
    let got = CHG.packSnapshotBytes(MSG.SNAPSHOT, seq, enc, me, chartEpoch, CHG.newRecordMemo())
    if (MUTANT && ident.cases === 1 && got) { got = Buffer.from(got); got[got.length >> 1] ^= 0x01 }
    if (got === null) {
      if (expectFast) { if (!ident.mismatch) ident.mismatch = { label, reason: 'fast path refused a numeric-id payload' } }
      else ident.fallback++
      ident.chgHash.update(base)
      return
    }
    const gb = Buffer.from(got)
    ident.fast++
    ident.chgHash.update(gb)
    if (!gb.equals(base) && !ident.mismatch) {
      ident.mismatch = { label, reason: 'bytes differ', baseLen: base.length, chgLen: gb.length, firstDiff: firstDiff(base, gb) }
    }
  }

  for (let t = 0; t < 6; t++) {
    const players = []
    for (let i = 1; i <= 64; i++) players.push(makePlayer(i, 60))
    const allEncoded = SE.SnapshotEncoder.encodePlayersOnce(players)
    const playersById = new Map(players.map((p) => [p.id, p]))
    const ids = players.map((p) => p.id)
    const nEnt = [0, 3, 20, 60, 120, 20][t]
    const ents = []
    for (let k = 0; k < nEnt; k++) ents.push(makeEntity(5000 + k, 60, t === 4 && k % 9 === 0 ? 200 : 0))
    const serverTime = CLOCK_BASE_MS + t * 17 + 0.5
    const entities = encodeEntities(SE, ents, t, serverTime)
    for (let v = 1; v <= 24; v++) {
      const n = [1, 5, 17, 30, 31, 40, 50, 64][(v + t) % 8]
      const vp = viewerPayload(SE, allEncoded, playersById, ids, v, n, t + 1, 4)
      judge(`real t=${t} v=${v} n=${n}`, 100 + t * 24 + v, { tick: 300 + t, serverTime, players: vp.players, entities, removed: v % 3 === 0 ? [9000 + v] : undefined, delta: 1, dots: vp.dots }, vp.me, 4 + t, true)
    }
  }

  // B. Player-array length boundaries (fixarray, 0xdc, edge counts) with fresh record arrays.
  for (const n of [0, 1, 15, 16, 17, 31, 255, 256, 300]) {
    const ps = []
    for (let i = 1; i <= n; i++) ps.push(makePlayer(i, 80))
    const preEnc = SE.SnapshotEncoder.encodePlayers(ps)
    const ents = encodeEntities(SE, [makeEntity(8000 + n, 10), makeEntity(8100 + n, 10)], 2, 1.25)
    judge(`edge-players n=${n}`, n, { tick: n, serverTime: 1.25, players: preEnc, entities: ents, removed: n % 2 ? undefined : [n, 'gone-long-id'], delta: 1, dots: n % 3 === 0 ? [[1, -2, 3], [0, 0, 1]] : undefined }, n % 2 ? undefined : SE.encodeSelfBlock(ps[0]), n, true)
  }

  const seqs = [0, 1, 127, 128, 255, 256, 65535, 65536, 4294967295, 4294967296, 1099511627776]
  const times = [0, 0.5, 1791580000000, -3.25, 1e-9, 123456789.125]
  const epochs = [0, 1, 200, 70000, 2 ** 40]
  for (let k = 0; k < seqs.length; k++) {
    const ps = []
    for (let i = 1; i <= 3; i++) ps.push(makePlayer(i, 20))
    const preEnc = SE.SnapshotEncoder.encodePlayers(ps)
    const ents = encodeEntities(SE, [makeEntity(9000 + k, 20)], k, times[k % times.length])
    judge(`edge-scalars k=${k}`, seqs[k], { tick: seqs[(k + 3) % seqs.length], serverTime: times[k % times.length], players: preEnc, entities: ents, removed: [k, -k, 'r' + k], delta: 1, dots: [[k, -k, 1]] }, SE.encodeSelfBlock(ps[1]), epochs[k % epochs.length], true)
  }

  // D. Entity strings that overflow one msgpackr string bundle (more than 0x5500 characters).
  {
    const ps = []
    for (let i = 1; i <= 8; i++) ps.push(makePlayer(i, 40))
    const preEnc = SE.SnapshotEncoder.encodePlayers(ps)
    const raws = []
    for (let k = 0; k < 120; k++) raws.push(makeEntity(10000 + k, 40, 300))
    const ents = encodeEntities(SE, raws, 5, 2.5)
    judge('edge-bundle-overflow', 77, { tick: 5, serverTime: 2.5, players: preEnc, entities: ents, removed: undefined, delta: 1, dots: undefined }, SE.encodeSelfBlock(ps[0]), 3, true)
  }

  // E. String player ids: the spliced path must refuse them (fallback), never splice them.
  {
    const ps = [makePlayer('p-1', 10), makePlayer('p-22', 10)]
    const preEnc = SE.SnapshotEncoder.encodePlayers(ps)
    const ents = encodeEntities(SE, [makeEntity(11000, 10)], 6, 3)
    judge('edge-string-ids', 9, { tick: 6, serverTime: 3, players: preEnc, entities: ents, removed: undefined, delta: 1, dots: undefined }, undefined, 0, false)
    const mixed = [makePlayer(7, 10), makePlayer('p-x', 10)]
    judge('edge-mixed-ids', 10, { tick: 7, serverTime: 3, players: SE.SnapshotEncoder.encodePlayers(mixed), entities: ents, removed: undefined, delta: 1, dots: undefined }, undefined, 0, false)
  }

  // F. Player count above 0xffff (the 0xdd array header).
  {
    const ps = []
    for (let i = 1; i <= 65536; i++) ps.push(makePlayer(i, 500))
    const preEnc = SE.SnapshotEncoder.encodePlayers(ps)
    judge('edge-65536-players', 12, { tick: 8, serverTime: 4, players: preEnc, entities: [], removed: undefined, delta: 1, dots: undefined }, undefined, 1, true)
  }

  const identDigest = ident.baseHash.digest('hex')
  const chgDigest = CHG ? ident.chgHash.digest('hex') : null
  say(`identity: cases=${ident.cases} bytes=${ident.bytes} baseline_sha256=${identDigest}` + (CHG ? ` change_sha256=${chgDigest} fast_path=${ident.fast} fallback=${ident.fallback}` : ''))

  if (MUTANT) {
    if (ident.mismatch) {
      say(`mutant: identity check detected the flipped byte: ${JSON.stringify(ident.mismatch)}`)
      say('RESULT: FAIL (mutant: one output byte changed; byte-identity check refused it)')
      return 1
    }
    say('RESULT: FAIL (mutant was not detected: witness has no byte sensitivity)')
    return 1
  }

  if (ident.mismatch && CHG) {
    say(`identity mismatch: ${JSON.stringify(ident.mismatch)}`)
    say('RESULT: FAIL (change bytes differ from the baseline wrapper pack)')
    return 1
  }

  const realNow = Date.now
  let nowMs = CLOCK_BASE_MS
  Date.now = () => nowMs
  const sent = []
  try {
    const ns = new NetworkState()
    const players = []
    const queues = new Map()
    const playersById = new Map()
    for (let i = 1; i <= 6; i++) {
      const pos = [i * 3.5, 0, (i % 2) * 4]
      ns.addPlayer(i, { position: pos })
      const p = { id: i, state: { position: pos.slice(), rotation: [0, 0, 0, 1], velocity: [0, 0, 0], onGround: true, crouch: 0, lookPitch: 0, lookYaw: 0, expr: 0, health: 100, weapon: 0 }, inputSequence: 0, lastInput: null, hasSentInput: false, starvedTicks: 0 }
      players.push(p)
      playersById.set(i, p)
      queues.set(i, [])
    }
    const ents = []
    for (let k = 0; k < 14; k++) ents.push(makeEntity(3000 + k, 40, k === 5 ? 320 : 0))
    const appRuntime = { tick() {}, getSnapshot: () => ({ entities: ents }), _drainReloadQueue() {} }
    const connections = {
      sendPacked(id, buf) { sent.push({ id, bytes: Buffer.from(buf) }) },
      send() {}, broadcast() {}, emit() {}, getClient: () => null, clients: new Map(),
    }
    const physicsIntegration = {
      config: { capsuleRadius: 0.4 },
      setCrouch() {},
      updatePlayerPhysics(_id, st, accumDt) { st.position[0] += st.velocity[0] * accumDt; st.position[2] += st.velocity[2] * accumDt },
    }
    const onTick = createTickHandler({
      networkState: ns,
      playerManager: {
        getConnectedPlayers: () => players,
        getInputs: (id) => queues.get(id) || [],
        getMovementOverride: () => null,
        getPlayer: (id) => playersById.get(id),
      },
      physicsIntegration,
      lagCompensator: { recordPlayerPosition() {} },
      physics: { step() {} },
      appRuntime,
      connections,
      stageLoader: null,
      getRelevanceRadius: () => 0,
      tickRate: 60,
    })
    for (let t = 0; t < 40; t++) {
      nowMs += 17
      for (const p of players) {
        queues.get(p.id).push({ sequence: t + 1, data: { forward: rnd() < 0.6, backward: false, left: rnd() < 0.2, right: false, jump: false, yaw: rfl(0, 6.2), pitch: 0, crouch: false, expr: 0 } })
      }
      onTick(t, 1 / 60)
    }
  } finally {
    Date.now = realNow
  }
  const entryHash = createHash('sha256')
  let entryBytes = 0
  for (const s of sent) {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(s.id >>> 0, 0)
    head.writeUInt32BE(s.bytes.length, 4)
    entryHash.update(head)
    entryHash.update(s.bytes)
    entryBytes += s.bytes.length
  }
  const entryDigest = entryHash.digest('hex')
  say(`entry: packets=${sent.length} bytes=${entryBytes} sha256=${entryDigest}`)
  if (sent.length === 0) { say('RESULT: FAIL (entry scenario sent no snapshot packets)'); return 1 }

  const buildSets = (n) => {
    const sets = []
    for (let t = 0; t < TIMING_SETS; t++) {
      const players = []
      for (let i = 1; i <= 64; i++) players.push(makePlayer(i, 60))
      const arrs = SE.SnapshotEncoder.encodePlayers(players)
      const allEncoded = new Map(players.map((p, i) => [p.id, arrs[i]]))
      const playersById = new Map(players.map((p) => [p.id, p]))
      const ids = players.map((p) => p.id)
      const ents = []
      for (let k = 0; k < 20; k++) ents.push(makeEntity(7000 + k, 60))
      const serverTime = CLOCK_BASE_MS + t * 17
      const entities = encodeEntities(SE, ents, t, serverTime)
      const viewers = []
      for (let v = 1; v <= TIMING_VIEWERS; v++) {
        const vp = viewerPayload(SE, allEncoded, playersById, ids, v, n, t + 3, 4)
        viewers.push({ seq: 1000 + t * 100 + v, chartEpoch: 9, me: vp.me, enc: { tick: 500 + t, serverTime, players: vp.players, entities, removed: undefined, delta: 1, dots: vp.dots } })
      }
      sets.push(viewers)
    }
    return sets
  }
  const wrapper = { type: MSG.SNAPSHOT, payload: null }
  const payload = { seq: 0, tick: 0, serverTime: 0, players: null, entities: null, removed: undefined, delta: 1, dots: undefined, me: undefined, chartEpoch: 0 }
  wrapper.payload = payload
  let timingSink = 0
  const passBaseline = (sets) => {
    let calls = 0
    const t0 = process.hrtime.bigint()
    for (const viewers of sets) {
      for (const v of viewers) {
        payload.seq = v.seq; payload.tick = v.enc.tick; payload.serverTime = v.enc.serverTime; payload.players = v.enc.players
        payload.entities = v.enc.entities; payload.removed = v.enc.removed; payload.delta = v.enc.delta; payload.dots = v.enc.dots
        payload.me = v.me; payload.chartEpoch = v.chartEpoch
        timingSink += pack(wrapper).length
        calls++
      }
    }
    return Number(process.hrtime.bigint() - t0) / 1000 / calls
  }
  let timingNulls = 0
  const passChange = (sets) => {
    let calls = 0
    const t0 = process.hrtime.bigint()
    for (const viewers of sets) {
      const memo = CHG.newRecordMemo()
      for (const v of viewers) {
        const out = CHG.packSnapshotBytes(MSG.SNAPSHOT, v.seq, v.enc, v.me, v.chartEpoch, memo)
        if (out === null) timingNulls++
        else timingSink += out.length
        calls++
      }
    }
    return Number(process.hrtime.bigint() - t0) / 1000 / calls
  }
  const timing = {}
  for (const n of NEIGHBOUR_COUNTS) {
    const sets = buildSets(n)
    passBaseline(sets)
    if (CHG) passChange(sets)
    const base = [], chg = []
    for (let r = 0; r < TIMING_RUNS; r++) {
      const bp = [], cp = []
      for (let p = 0; p < TIMING_PASSES; p++) {
        bp.push(passBaseline(sets))
        if (CHG) cp.push(passChange(sets))
      }
      base.push(median(bp))
      if (CHG) chg.push(median(cp))
    }
    timing[n] = { base_us: base, chg_us: chg }
  }
  if (timingNulls > 0) { say(`RESULT: FAIL (timing change side fell back on ${timingNulls} viewer calls)`); return 1 }

  if (BASELINE_ONLY) {
    for (const n of NEIGHBOUR_COUNTS) {
      const b = timing[n].base_us
      say(`timing n=${n} baseline_us_per_viewer runs=[${b.map((x) => x.toFixed(2)).join(', ')}] median=${median(b).toFixed(2)} range=[${Math.min(...b).toFixed(2)}, ${Math.max(...b).toFixed(2)}]`)
    }
    const out = resolve(REPO, BASELINE_REL)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify({
      witness: 'scripts/snapshot-prepacked-witness.mjs',
      node: process.version,
      identity: { cases: ident.cases, bytes: ident.bytes, sha256: identDigest },
      entry: { packets: sent.length, bytes: entryBytes, sha256: entryDigest },
      timing,
    }, null, 2) + '\n')
    say(`baseline stored: ${BASELINE_REL}`)
    say('RESULT: BASELINE-CAPTURED (pre-change hashes and baseline timings; no change side evaluated)')
    return 0
  }

  const storedPath = resolve(REPO, BASELINE_REL)
  if (!existsSync(storedPath)) { say(`RESULT: FAIL (pre-change baseline missing: ${BASELINE_REL}; run --baseline-only first)`); return 1 }
  const stored = JSON.parse(readFileSync(storedPath, 'utf8'))
  const identityEqual = identDigest === stored.identity.sha256 && chgDigest === stored.identity.sha256 && ident.cases === stored.identity.cases && ident.bytes === stored.identity.bytes
  const entryEqual = entryDigest === stored.entry.sha256 && sent.length === stored.entry.packets && entryBytes === stored.entry.bytes
  say(`identity vs pre-change baseline: cases=${ident.cases} (stored ${stored.identity.cases}) bytes=${ident.bytes} (stored ${stored.identity.bytes}) change_sha256=${chgDigest} stored_sha256=${stored.identity.sha256} equal=${identityEqual}`)
  say(`entry vs pre-change baseline: packets=${sent.length} (stored ${stored.entry.packets}) bytes=${entryBytes} (stored ${stored.entry.bytes}) sha256=${entryDigest} stored_sha256=${stored.entry.sha256} equal=${entryEqual}`)

  let timingClaim = true
  for (const n of NEIGHBOUR_COUNTS) {
    const { base_us: b, chg_us: c } = timing[n]
    const ratios = c.map((x, i) => x / b[i])
    const holds = ratios.every((r) => r <= CLAIM_MAX_RATIO)
    if (!holds) timingClaim = false
    say(`timing n=${n} baseline_us_per_viewer runs=[${b.map((x) => x.toFixed(2)).join(', ')}] median=${median(b).toFixed(2)} range=[${Math.min(...b).toFixed(2)}, ${Math.max(...b).toFixed(2)}] | change_us_per_viewer runs=[${c.map((x) => x.toFixed(2)).join(', ')}] median=${median(c).toFixed(2)} range=[${Math.min(...c).toFixed(2)}, ${Math.max(...c).toFixed(2)}] | ratio_runs=[${ratios.map((x) => x.toFixed(3)).join(', ')}] median_ratio=${median(ratios).toFixed(3)} claim_max=${CLAIM_MAX_RATIO} holds=${holds}`)
  }

  if (!identityEqual || ident.mismatch) { say('RESULT: FAIL (identity hashes differ from the pre-change baseline)'); return 1 }
  if (!entryEqual) { say('RESULT: FAIL (end-to-end packets differ from the pre-change baseline)'); return 1 }
  if (!timingClaim) { say(`RESULT: FAIL (timing claim not met: change not <= ${CLAIM_MAX_RATIO} x baseline in every run at every neighbour count)`); return 1 }
  say(`RESULT: PASS (identity ${ident.cases} cases fast_path=${ident.fast} fallback=${ident.fallback}; entry ${sent.length} packets; timing n=${NEIGHBOUR_COUNTS.join('/')} 3 interleaved runs)`)
  return 0
}

main().then((code) => { process.exitCode = code }).catch((e) => {
  console.log(`RESULT: FAIL (witness error: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e})`)
  process.exitCode = 1
})
