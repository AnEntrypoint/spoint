import { pack } from '../protocol/msgpack.js'

// Packs the player records once per memo and copies them into every viewer's snapshot bytes.
//
// snapshotHead probes the live packer once per type and memoises the head for the process, so it is
// only valid while WIRE_STRUCTURES (src/protocol/msgpack.js) is fixed. Under msgpackr's bundleStrings
// a bundled string is written past the tail, so a record holding one is not position-independent --
// strings of one or two bytes are inlined and would splice unchanged, but recordBytes refuses every
// string rather than track that threshold. A carved range is never rewritten, so a caller may hold a
// returned buffer until the arena rolls.

const ARENA_BYTES = 1 << 18
const COPY_LOOP_MAX = 32
const KIND_UNSHAREABLE = 0
const KIND_SCALARS = 1
const KIND_WITH_BINS = 2

const _heads = new Map()
const _numbers = [0, 0, 0]
const _fields = [undefined, undefined, undefined, undefined, undefined, undefined]
const _recs = []
let _arena = null
let _arenaUsed = 0

function bytesEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function snapshotHead(type) {
  let head = _heads.get(type)
  if (head !== undefined) return head
  const probe = pack({ type, payload: { seq: 0, tick: 0, serverTime: 0, players: [], entities: [], removed: undefined, delta: 1, dots: undefined, me: undefined, chartEpoch: 0 } })
  const tail = pack([[], undefined, 1, undefined, undefined, 0]).subarray(1)
  const cut = probe.length - tail.length - 4
  const layoutHolds = cut > 0 && probe[cut] === 0x00 && probe[cut + 1] === 0x00 && probe[cut + 2] === 0x00 && probe[cut + 3] === 0x90 && bytesEqual(probe.subarray(cut + 4), tail)
  head = layoutHolds ? Uint8Array.from(probe.subarray(0, cut)) : null
  _heads.set(type, head)
  return head
}

function arrayHeaderLength(n) {
  return n < 16 ? 1 : n < 0x10000 ? 3 : 5
}

function writeArrayHeader(out, offset, n) {
  if (n < 16) { out[offset] = 0x90 | n; return offset + 1 }
  if (n < 0x10000) { out[offset] = 0xdc; out[offset + 1] = n >> 8; out[offset + 2] = n & 0xff; return offset + 3 }
  out[offset] = 0xdd
  out[offset + 1] = (n >>> 24) & 0xff
  out[offset + 2] = (n >>> 16) & 0xff
  out[offset + 3] = (n >>> 8) & 0xff
  out[offset + 4] = n & 0xff
  return offset + 5
}

function copyRange(out, src, from, offset) {
  const length = src.length - from
  if (length < COPY_LOOP_MAX) {
    for (let i = 0; i < length; i++) out[offset + i] = src[from + i]
  } else {
    out.set(from === 0 ? src : src.subarray(from), offset)
  }
  return offset + length
}

function carve(length) {
  if (_arena === null || _arenaUsed + length > _arena.length) {
    const size = Math.max(ARENA_BYTES, length)
    _arena = typeof Buffer !== 'undefined' ? Buffer.allocUnsafeSlow(size) : new Uint8Array(size)
    _arenaUsed = 0
  }
  const out = _arena.subarray(_arenaUsed, _arenaUsed + length)
  _arenaUsed += length
  return out
}

function recordKind(rec) {
  if (!Array.isArray(rec)) return KIND_UNSHAREABLE
  let kind = KIND_SCALARS
  for (let i = 0; i < rec.length; i++) {
    const v = rec[i]
    if (v instanceof Uint8Array) { kind = KIND_WITH_BINS; continue }
    const t = typeof v
    if (t === 'number' || t === 'boolean' || t === 'undefined' || v === null) continue
    return KIND_UNSHAREABLE
  }
  return kind
}

function sameScalars(values, rec) {
  if (values.length !== rec.length) return false
  for (let i = 0; i < rec.length; i++) if (values[i] !== rec[i]) return false
  return true
}

function recordBytes(rec, memo) {
  const known = memo.byRef.get(rec)
  if (known !== undefined) return known
  const kind = recordKind(rec)
  if (kind === KIND_UNSHAREABLE) { memo.byRef.set(rec, null); return null }
  if (kind === KIND_WITH_BINS) {
    const bytes = new Uint8Array(pack(rec))
    memo.byRef.set(rec, bytes)
    return bytes
  }
  const cached = memo.byId.get(rec[0])
  if (cached !== undefined && sameScalars(cached.values, rec)) return cached.bytes
  const bytes = new Uint8Array(pack(rec))
  memo.byId.set(rec[0], { values: rec.slice(), bytes })
  return bytes
}

export function newRecordMemo() {
  return { byRef: new WeakMap(), byId: new Map() }
}

export function packSnapshotBytes(type, seq, encoded, me, chartEpoch, memo) {
  const head = snapshotHead(type)
  const players = encoded.players
  if (head === null || !Array.isArray(players)) return null
  const n = players.length
  _numbers[0] = seq; _numbers[1] = encoded.tick; _numbers[2] = encoded.serverTime
  const numbers = pack(_numbers)
  _fields[0] = encoded.entities; _fields[1] = encoded.removed; _fields[2] = encoded.delta
  _fields[3] = encoded.dots; _fields[4] = me; _fields[5] = chartEpoch
  const tail = pack(_fields)
  let total = head.length + (numbers.length - 1) + arrayHeaderLength(n) + (tail.length - 1)
  for (let i = 0; i < n; i++) {
    const bytes = recordBytes(players[i], memo)
    if (bytes === null) return null
    _recs[i] = bytes
    total += bytes.length
  }
  const out = carve(total)
  let offset = copyRange(out, head, 0, 0)
  offset = copyRange(out, numbers, 1, offset)
  offset = writeArrayHeader(out, offset, n)
  for (let i = 0; i < n; i++) offset = copyRange(out, _recs[i], 0, offset)
  copyRange(out, tail, 1, offset)
  return out
}
