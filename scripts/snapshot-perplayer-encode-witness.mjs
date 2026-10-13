#!/usr/bin/env node
// Witness for AppRuntime.getSnapshotForPlayer: a per-recipient snapshot must reuse the
// snapshot encode cache that getSnapshot fills, and the bytes it hands the wire must be
// byte-identical to the ones a full re-encode produces.
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const TAG = '[snapshot-perplayer-encode]'
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--') && a.includes('='))
    .map(a => { const i = a.indexOf('='); return [a.slice(2, i), a.slice(i + 1)] })
)

function numFlag(name, dflt) {
  const raw = args[name]
  if (raw === undefined) return dflt
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) { console.error(`${TAG} --${name} must be a non-negative number, got "${raw}"`); process.exit(2) }
  return n
}

const ENTITIES = numFlag('entities', 1200)
const RECIPIENTS = numFlag('recipients', 8)
const REPS = numFlag('reps', 60)
const RADIUS = numFlag('radius', 200)

const failures = []
function expect(name, got, predicate) {
  let ok = false
  try { ok = Boolean(predicate(got)) } catch { ok = false }
  if (!ok) failures.push(`${name}=${JSON.stringify(got)}`)
  return got
}

const here = pathToFileURL(resolve(REPO_ROOT, 'src')).href
const { AppRuntime } = await import(`${here}/apps/AppRuntime.js`)
const { SnapshotEncoder } = await import(`${here}/netcode/SnapshotEncoder.js`)
// The entity bin the wire carries is BIN_RECORD_BYTES wide (the 22-byte figure is the PLAYER
// bin), so the byte-for-byte comparison below takes its width from the format module and a
// shorter bin can never read as a match of two undefined bytes.
const { BIN_RECORD_BYTES: BIN_BYTES } = await import(`${here}/netcode/SnapshotBinFormat.js`)

const rt = new AppRuntime({})
for (let i = 0; i < ENTITIES; i++) {
  rt.spawnEntity(`e${i}`, {
    position: [(i % 40) * 2.5, 0, Math.floor(i / 40) * 2.5],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
    model: i % 3 === 0 ? 'box' : 'barrel',
    bodyType: i % 4 === 0 ? 'dynamic' : 'static',
    custom: i % 5 === 0 ? { _interior: true, tag: i } : null
  })
}

let reencodes = 0
const encodeEntity = rt._encodeEntity.bind(rt)
rt._encodeEntity = (id, e) => { reencodes++; return encodeEntity(id, e) }

const PRE_FIX_SNAPSHOT_FOR_PLAYER = `getSnapshotForPlayer(pos, r, skipStatic=false) { const e=[], rel=new Set(this.relevantEntities(pos,r)); for (const id of (skipStatic?this._dynamicEntityIds:this.entities.keys())) { const en=this.entities.get(id); if (en&&(rel.has(id)||en.custom?._interior)) e.push(this._encodeEntity(id,en)) } return this._snap(e) }`

// `enc` is the encode step under test: the hooked this._encodeEntity counts re-encodes, so the
// counting passes pass it and the timing passes pass the unhooked original instead, or the legacy
// arm would pay 1200 counter increments per recipient that the cached arm never pays.
function legacyRecords(pos, r, enc = rt._encodeEntity) {
  const out = [], rel = new Set(rt.relevantEntities(pos, r))
  for (const id of rt.entities.keys()) {
    const en = rt.entities.get(id)
    if (en && (rel.has(id) || en.custom?._interior)) out.push(enc(id, en))
  }
  return out
}

const legacyEndToEnd = (pos, r) => rt._snap(legacyRecords(pos, r, encodeEntity))
const cachedEndToEnd = (pos, r) => rt.getSnapshotForPlayer(pos, r)
function relevantIds(pos, r) {
  const rel = new Set(rt.relevantEntities(pos, r))
  const ids = []
  for (const id of rt.entities.keys()) {
    const en = rt.entities.get(id)
    if (en && (rel.has(id) || en.custom?._interior)) ids.push(id)
  }
  return ids
}

function legacyEncodeStage(ids, enc = rt._encodeEntity) {
  const out = []
  for (const id of ids) out.push(enc(id, rt.entities.get(id)))
  return out
}

function cachedEncodeStage(ids) {
  const out = []
  for (const id of ids) out.push(rt._snapshotEncoding(id, rt.entities.get(id)))
  return out
}

function recipientPositions(n) {
  const out = []
  for (let i = 0; i < n; i++) out.push([i * 7.5, 1, i * 4.5])
  return out
}

const positions = recipientPositions(RECIPIENTS)

rt.getSnapshot()
reencodes = 0
rt.getSnapshot()
const warmGetSnapshotReencodes = reencodes
expect('getSnapshot re-encodes with a warm cache', warmGetSnapshotReencodes, v => v === 0)

reencodes = 0
const cached = positions.map(p => rt.getSnapshotForPlayer(p, RADIUS).entities)
const cachedReencodes = reencodes
expect(`getSnapshotForPlayer re-encodes across ${RECIPIENTS} recipient(s)`, cachedReencodes, v => v === 0)

reencodes = 0
const legacy = positions.map(p => legacyRecords(p, RADIUS))
const legacyReencodes = reencodes
expect('legacy full-encode control re-encodes', legacyReencodes, v => v === RECIPIENTS * ENTITIES)

const wireOf = entities => SnapshotEncoder.encode({ tick: 1, serverTime: 1, players: [], entities })

let binMismatch = 0
let binWidthMismatch = 0
let recordMismatch = 0
let decodedMismatch = 0
let records = 0
for (let i = 0; i < positions.length; i++) {
  const a = wireOf(legacy[i])
  const b = wireOf(cached[i])
  expect(`recipient ${i} entity count`, b.entities.length, v => v === a.entities.length)
  for (let j = 0; j < a.entities.length; j++) {
    const ra = a.entities[j], rb = b.entities[j]
    records++
    const ba = ra[2], bb = rb[2]
    if (ba.length !== BIN_BYTES || bb.length !== BIN_BYTES) { binWidthMismatch++; break }
    for (let k = 0; k < BIN_BYTES; k++) if (ba[k] !== bb[k]) { binMismatch++; break }
    if (JSON.stringify(ra) !== JSON.stringify(rb)) recordMismatch++
  }
  const da = JSON.stringify(SnapshotEncoder.decode(a))
  const db = JSON.stringify(SnapshotEncoder.decode(b))
  if (da !== db) decodedMismatch++
}
expect('bin byte mismatch(es)', binMismatch, v => v === 0)
expect(`bin(s) not ${BIN_BYTES} byte(s) wide`, binWidthMismatch, v => v === 0)
expect('wire record mismatch(es)', recordMismatch, v => v === 0)
expect('decoded payload mismatch(es)', decodedMismatch, v => v === 0)

let notCacheIdentity = 0
for (const rec of cached[0]) if (rt._snapshotEncCache.get(rec.id) !== rec) notCacheIdentity++
expect('record(s) not the cached object itself', notCacheIdentity, v => v === 0)

reencodes = 0
rt.getSnapshot()
expect('encode leaves the cache intact', reencodes, v => v === 0)

const moved = rt.entities.get('e7')
moved.position[0] += 0.25
reencodes = 0
const afterMove = rt.getSnapshotForPlayer(positions[0], RADIUS).entities
const movedReencodes = reencodes
expect('a moved entity forces a re-encode', movedReencodes, v => v >= 1)
const movedRecord = afterMove.find(e => e.id === 'e7')
expect('moved entity carries the new position', movedRecord && movedRecord.position[0], v => v === moved.position[0])
const movedLegacy = legacyRecords(positions[0], RADIUS).find(e => e.id === 'e7')
expect('moved entity matches a full re-encode', JSON.stringify(movedRecord), v => v === JSON.stringify(movedLegacy))

const hrtimeMs = () => Number(process.hrtime.bigint()) / 1e6
const idSets = positions.map(p => relevantIds(p, RADIUS))

const legacySweep = () => { for (const p of positions) legacyEndToEnd(p, RADIUS) }
const cachedSweep = () => { for (const p of positions) cachedEndToEnd(p, RADIUS) }
const legacyStageSweep = () => { for (const ids of idSets) legacyEncodeStage(ids, encodeEntity) }
const cachedStageSweep = () => { for (const ids of idSets) cachedEncodeStage(ids) }

const medianOf = arr => { arr.sort((a, b) => a - b); return arr[arr.length >> 1] }
// The two arms allocate differently by construction (the legacy arm builds a fresh record per
// entity, the cached arm returns the cached one), and this box runs sibling lanes, so a central
// estimator of an allocating sweep measures GC and neighbours as much as the code. The minimum
// over interleaved repetitions is the sample least contaminated by either.
function measureInterleaved(a, b) {
  for (let i = 0; i < 10; i++) { a(); b() }
  const ta = [], tb = []
  for (let i = 0; i < REPS; i++) {
    const t0 = hrtimeMs(); a(); const t1 = hrtimeMs(); b(); const t2 = hrtimeMs()
    ta.push(t1 - t0); tb.push(t2 - t1)
  }
  return [Math.min(...ta) / RECIPIENTS, Math.min(...tb) / RECIPIENTS, medianOf(ta) / RECIPIENTS, medianOf(tb) / RECIPIENTS]
}
let legacyMs = Infinity, cachedMs = Infinity, legacyStageMs = Infinity, cachedStageMs = Infinity
let legacyMsMed = Infinity, cachedMsMed = Infinity
for (let round = 0; round < 3; round++) {
  const [l, c, lm, cm] = measureInterleaved(legacySweep, cachedSweep)
  legacyMs = Math.min(legacyMs, l); cachedMs = Math.min(cachedMs, c)
  legacyMsMed = Math.min(legacyMsMed, lm); cachedMsMed = Math.min(cachedMsMed, cm)
  const [ls, cs] = measureInterleaved(legacyStageSweep, cachedStageSweep)
  legacyStageMs = Math.min(legacyStageMs, ls); cachedStageMs = Math.min(cachedStageMs, cs)
}

reencodes = 0
rt.getSnapshotForPlayer(positions[0], RADIUS)
expect('the wire encode left the cache intact', reencodes, v => v === 0)

const shape = {
  entities: ENTITIES,
  recipients: RECIPIENTS,
  entityRecordsPerRecipient: cached[0].length,
  reencodesWarmCache: cachedReencodes,
  reencodesLegacyControl: legacyReencodes,
  reencodesAfterMove: movedReencodes,
  wireRecordsCompared: records,
  binByteMismatch: binMismatch,
  binWidthBytes: BIN_BYTES,
  decodedPayloadMismatch: decodedMismatch,
  msPerRecipientLegacy: Number(legacyMs.toFixed(4)),
  msPerRecipientCached: Number(cachedMs.toFixed(4)),
  msPerRecipientEncodeStageLegacy: Number(legacyStageMs.toFixed(4)),
  msPerRecipientEncodeStageCached: Number(cachedStageMs.toFixed(4)),
  msPerRecipientLegacyMedian: Number(legacyMsMed.toFixed(4)),
  msPerRecipientCachedMedian: Number(cachedMsMed.toFixed(4)),
  msPerRecipientSavedCached: Number((legacyMs - cachedMs).toFixed(4)),
  msPerRecipientSavedEncodeStage: Number((legacyStageMs - cachedStageMs).toFixed(4))
}
console.log(`${TAG} shape ${JSON.stringify(shape)}`)
console.log(`${TAG} encode per recipient: legacy ${(legacyReencodes / RECIPIENTS).toFixed(0)} re-encode(s), cached ${(cachedReencodes / RECIPIENTS).toFixed(0)} re-encode(s)`)
console.log(`${TAG} pre-fix ${PRE_FIX_SNAPSHOT_FOR_PLAYER}`)
console.log(`${TAG} ms per recipient (relevance + record build + _snap): legacy ${legacyMs.toFixed(4)}, cached ${cachedMs.toFixed(4)}`)
console.log(`${TAG} ms per recipient (record build stage only, relevance excluded): legacy ${legacyStageMs.toFixed(4)}, cached ${cachedStageMs.toFixed(4)}`)

if (failures.length > 0) {
  for (const f of failures) console.error(`${TAG} [FAIL] ${f}`)
  console.log(`${TAG} RESULT: FAIL -- ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log(`${TAG} RESULT: PASS -- ${RECIPIENTS} recipient(s), ${cachedReencodes} re-encode(s) with a warm cache, ${binMismatch} byte mismatch(es) over ${records} wire record(s)`)
