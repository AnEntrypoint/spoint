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
const REPS = numFlag('reps', 25)
const RADIUS = numFlag('radius', 200)
const BIN_BYTES = 29

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

function legacyFullEncode(pos, r) {
  const out = [], rel = new Set(rt.relevantEntities(pos, r))
  for (const id of rt.entities.keys()) {
    const en = rt.entities.get(id)
    if (en && (rel.has(id) || en.custom?._interior)) out.push(rt._encodeEntity(id, en))
  }
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
const legacy = positions.map(p => legacyFullEncode(p, RADIUS))
const legacyReencodes = reencodes
expect('legacy full-encode control re-encodes', legacyReencodes, v => v === RECIPIENTS * ENTITIES)

const wireOf = entities => SnapshotEncoder.encode({ tick: 1, serverTime: 1, players: [], entities })

let binMismatch = 0
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
    for (let k = 0; k < BIN_BYTES; k++) if (ba[k] !== bb[k]) { binMismatch++; break }
    if (JSON.stringify(ra) !== JSON.stringify(rb)) recordMismatch++
  }
  const da = JSON.stringify(SnapshotEncoder.decode(a))
  const db = JSON.stringify(SnapshotEncoder.decode(b))
  if (da !== db) decodedMismatch++
}
expect('bin byte mismatch(es)', binMismatch, v => v === 0)
expect('wire record mismatch(es)', recordMismatch, v => v === 0)
expect('decoded payload mismatch(es)', decodedMismatch, v => v === 0)

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
const movedLegacy = legacyFullEncode(positions[0], RADIUS).find(e => e.id === 'e7')
expect('moved entity matches a full re-encode', JSON.stringify(movedRecord), v => v === JSON.stringify(movedLegacy))

const hrtimeMs = () => Number(process.hrtime.bigint()) / 1e6
function median(fn) {
  for (let i = 0; i < 10; i++) fn()
  const ts = []
  for (let i = 0; i < REPS; i++) { const t = hrtimeMs(); fn(); ts.push(hrtimeMs() - t) }
  ts.sort((a, b) => a - b)
  return ts[REPS >> 1]
}
let slot = 0
const legacyArm = () => legacyFullEncode(positions[(slot++) % positions.length], RADIUS)
const cachedArm = () => rt.getSnapshotForPlayer(positions[(slot++) % positions.length], RADIUS)
let legacyMs = Infinity, cachedMs = Infinity
for (let round = 0; round < 3; round++) {
  legacyMs = Math.min(legacyMs, median(legacyArm))
  cachedMs = Math.min(cachedMs, median(cachedArm))
}

const shape = {
  entities: ENTITIES,
  recipients: RECIPIENTS,
  entityRecordsPerRecipient: cached[0].length,
  reencodesWarmCache: cachedReencodes,
  reencodesLegacyControl: legacyReencodes,
  reencodesAfterMove: movedReencodes,
  wireRecordsCompared: records,
  binByteMismatch: binMismatch,
  decodedPayloadMismatch: decodedMismatch,
  msPerRecipientLegacy: Number(legacyMs.toFixed(4)),
  msPerRecipientCached: Number(cachedMs.toFixed(4))
}
console.log(`${TAG} shape ${JSON.stringify(shape)}`)
console.log(`${TAG} encode per recipient: legacy ${(legacyReencodes / RECIPIENTS).toFixed(0)} re-encode(s), cached ${(cachedReencodes / RECIPIENTS).toFixed(0)} re-encode(s)`)
console.log(`${TAG} ms per recipient: legacy ${legacyMs.toFixed(4)}, cached ${cachedMs.toFixed(4)}`)

if (failures.length > 0) {
  for (const f of failures) console.error(`${TAG} [FAIL] ${f}`)
  console.log(`${TAG} RESULT: FAIL -- ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log(`${TAG} RESULT: PASS -- ${RECIPIENTS} recipient(s), ${cachedReencodes} re-encode(s) with a warm cache, ${binMismatch} byte mismatch(es) over ${records} wire record(s)`)
