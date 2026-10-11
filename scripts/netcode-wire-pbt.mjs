import {
  BIN_RECORD_BYTES,
  PLAYER_BIN_RECORD_BYTES,
  clampI16,
  clampI32Pos,
  clampU16Scale,
  packBinRecord,
  packPlayerBinRecord,
  packQuat,
  unpackBinRecord,
  unpackPlayerBinRecord,
  unpackQuat,
} from '../src/netcode/SnapshotBinFormat.js'
import { checksumBodies } from '../src/netcode/LockstepChecksum.js'
import {
  CONSENSUS_CTRL_PREFIX,
  LOCKSTEP_CTRL_PREFIX,
  ROLLBACK_CTRL_PREFIX,
  controlFrameKinds,
  encodeControlFrame,
  parseControlFrame,
} from '../src/netcode/controlFrame.js'

const flag = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : dflt
}
const SEED = Number(flag('seed', '20261011')) || 20261011
const CASES = Math.max(1, Number(flag('cases', '400')) || 400)

function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = (rng, atoms) => atoms[Math.floor(rng() * atoms.length) % atoms.length]
const near = (x, y, tol) => Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= tol
const roundAt = (v) => Math.round(v * 100) / 100

const VEL = [0, 1, -1, 0.01, -0.01, 327.67, -327.67, 1e4, -1e4, NaN, Infinity, -Infinity]
const POS = [0, 1, -1, 0.01, 21474836.47, -21474836.47, 1e7, -1e7, NaN, Infinity, -Infinity]
const SCALE = [1, 0, 0.01, 655.35, 700, -1, -700, NaN, Infinity, -Infinity]
const QUAT = [0, 1, -1, 0.5, -0.5, 2, -2, 1e-8, NaN, Infinity]
const VEL_R = [0, 1, -1, 0.01, -0.01, 327.67, -327.67]
const POS_R = [0, 1, -1, 0.01, 1e5, -1e5]
const SCALE_R = [1, 0, 0.01, 655.35, 2.5]
const QUAT_R = [0, 1, -1, 0.5, -0.5, 2]
const TICK_LIT = ['1', '0', '-1', '1.5', '9007199254740993', '1e-999', '1e999', '-1e999']
const TICK_INT = [0, 1, -1, 2147483647]
const COUNT = [0, 1, 2, 3]
const PREFIX_IDX = [0, 1, 2]
const KIND_IDX = [0, 1]
const PACKED = [0, 1, 511, 1073741823, 2147483648, 3221225471, 4294967295]
const PREFIXES = [LOCKSTEP_CTRL_PREFIX, ROLLBACK_CTRL_PREFIX, CONSENSUS_CTRL_PREFIX]

const unit = (a, b, c, d) => {
  const n = Math.hypot(a, b, c, d)
  return n > 0 ? [a / n, b / n, c / n, d / n] : [0, 0, 0, 1]
}

const frameFor = (prefix, kind) => {
  if (kind === 'input') return { type: 'input', tick: prefix === LOCKSTEP_CTRL_PREFIX ? 7 : 3 }
  if (kind === 'drop') return { type: 'drop', peer: 'p', have: 2, tail: [] }
  return { type: 'checksum', tick: prefix === CONSENSUS_CTRL_PREFIX ? 0 : 3, pubkey: 'p', checksum: 'c' }
}

const BOUNDARIES = [
  {
    id: 'velocity-i16',
    atoms: { v: VEL },
    prop: (c) => {
      const o = clampI16(c.v)
      return Number.isInteger(o) && o >= -32767 && o <= 32767
    },
  },
  {
    id: 'position-i32',
    atoms: { v: POS },
    prop: (c) => {
      const o = clampI32Pos(c.v)
      return Number.isInteger(o) && o >= -2147483647 && o <= 2147483647
    },
  },
  {
    id: 'scale-u16',
    atoms: { v: SCALE },
    prop: (c) => {
      const o = clampU16Scale(c.v)
      return Number.isInteger(o) && o >= 0 && o <= 65535
    },
  },
  {
    id: 'quat-roundtrip',
    atoms: { a: QUAT, b: QUAT, c: QUAT, d: QUAT },
    prop: (k) => {
      const q = unit(k.a, k.b, k.c, k.d)
      let out
      try { out = unpackQuat(packQuat(q[0], q[1], q[2], q[3]), [0, 0, 0, 0]) } catch (_e) { return true }
      const dot = out[0] * q[0] + out[1] * q[1] + out[2] * q[2] + out[3] * q[3]
      return Math.abs(dot) >= 0.999
    },
  },
  {
    id: 'quat-wire-unit',
    atoms: { packed: PACKED },
    prop: (c) => {
      let out
      try { out = unpackQuat(c.packed, [0, 0, 0, 0]) } catch (_e) { return true }
      return out.every(Number.isFinite) && Math.abs(Math.hypot(out[0], out[1], out[2], out[3]) - 1) <= 0.01
    },
  },
  {
    id: 'bin-record-roundtrip',
    atoms: {
      px: POS_R, py: POS_R, pz: POS_R,
      qa: QUAT_R, qb: QUAT_R, qc: QUAT_R, qd: QUAT_R,
      vx: VEL_R, vy: VEL_R, vz: VEL_R,
      sx: SCALE_R, sy: SCALE_R, sz: SCALE_R,
    },
    prop: (c) => {
      const q = unit(c.qa, c.qb, c.qc, c.qd)
      const buf = packBinRecord(c.px, c.py, c.pz, packQuat(q[0], q[1], q[2], q[3]), c.vx, c.vy, c.vz, c.sx, c.sy, c.sz, 1)
      if (buf.length !== BIN_RECORD_BYTES) return false
      const o = unpackBinRecord(buf, {})
      return near(o.px, roundAt(c.px), 1e-6) && near(o.py, roundAt(c.py), 1e-6) && near(o.pz, roundAt(c.pz), 1e-6)
        && near(o.vx, roundAt(c.vx), 1e-6) && near(o.vy, roundAt(c.vy), 1e-6) && near(o.vz, roundAt(c.vz), 1e-6)
        && near(o.sx, roundAt(c.sx), 1e-6) && near(o.sy, roundAt(c.sy), 1e-6) && near(o.sz, roundAt(c.sz), 1e-6)
        && o.flags === 1
    },
  },
  {
    id: 'player-record-roundtrip',
    atoms: {
      px: POS_R, py: POS_R, pz: POS_R,
      qa: QUAT_R, qb: QUAT_R, qc: QUAT_R, qd: QUAT_R,
      vx: VEL_R, vy: VEL_R, vz: VEL_R,
    },
    prop: (c) => {
      const q = unit(c.qa, c.qb, c.qc, c.qd)
      const buf = packPlayerBinRecord(c.px, c.py, c.pz, packQuat(q[0], q[1], q[2], q[3]), c.vx, c.vy, c.vz)
      if (buf.length !== PLAYER_BIN_RECORD_BYTES) return false
      const o = unpackPlayerBinRecord(buf, {})
      return near(o.px, roundAt(c.px), 1e-6) && near(o.py, roundAt(c.py), 1e-6) && near(o.pz, roundAt(c.pz), 1e-6)
        && near(o.vx, roundAt(c.vx), 1e-6) && near(o.vy, roundAt(c.vy), 1e-6) && near(o.vz, roundAt(c.vz), 1e-6)
    },
  },
  {
    id: 'checksum-digest-stable',
    atoms: { tick: TICK_INT, n: COUNT, jitter: COUNT },
    prop: (c) => {
      const build = () => {
        const snap = new Map()
        for (let i = 0; i < c.n; i++) {
          const k = (i + 1) * 7 + c.jitter
          snap.set(k, { position: [i + c.jitter, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] })
        }
        return snap
      }
      const forward = build()
      const reverse = new Map([...forward].reverse())
      const a = checksumBodies(c.tick, forward)
      return /^[0-9a-f]{16}$/.test(a) && a === checksumBodies(c.tick, build()) && a === checksumBodies(c.tick, reverse)
    },
  },
  {
    id: 'control-frame-roundtrip',
    atoms: { pi: PREFIX_IDX, ki: KIND_IDX },
    prop: (c) => {
      const prefix = PREFIXES[c.pi]
      const kinds = controlFrameKinds(prefix)
      const data = encodeControlFrame(prefix, frameFor(prefix, kinds[c.ki % kinds.length]))
      return parseControlFrame(prefix, data).status === 'accepted'
    },
  },
  {
    id: 'control-frame-consensus-tick',
    atoms: { tickLit: TICK_LIT },
    prop: (c) => {
      const data = CONSENSUS_CTRL_PREFIX + '{"type":"checksum","tick":' + c.tickLit + ',"pubkey":"p","checksum":"c"}'
      const parsed = parseControlFrame(CONSENSUS_CTRL_PREFIX, data)
      return parsed.status !== 'accepted' || Number.isFinite(parsed.frame.tick)
    },
  },
]

const KNOWN = [
  { id: 'quat-roundtrip', shrunk: '{"a":"Infinity","b":-0.5,"c":-0.5,"d":-0.5}' },
]

const render = (c) => JSON.stringify(c, (_k, v) => {
  if (typeof v === 'number' && !Number.isFinite(v)) return Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity'
  return v
})

const shrink = (boundary, failing) => {
  let cur = failing
  for (let pass = 0; pass < 8; pass++) {
    let moved = false
    for (const field of Object.keys(boundary.atoms)) {
      const atoms = boundary.atoms[field]
      const at = atoms.findIndex((a) => Object.is(a, cur[field]))
      for (let i = 0; i < at; i++) {
        const trial = { ...cur, [field]: atoms[i] }
        if (!boundary.prop(trial)) { cur = trial; moved = true; break }
      }
    }
    if (!moved) break
  }
  return cur
}

const weight = (c) => Object.keys(c).reduce((n, k) => n + (Number.isFinite(c[k]) && Math.abs(c[k]) <= 1000 ? 0 : 1), 0)
const better = (a, b) => (weight(a) !== weight(b) ? weight(a) < weight(b) : render(a) < render(b))

const canonicalize = (boundary, c) => {
  let cur = c
  for (let pass = 0; pass < 8; pass++) {
    let moved = false
    for (const field of Object.keys(boundary.atoms)) {
      let bestTrial = null
      for (const atom of boundary.atoms[field]) {
        if (Object.is(atom, cur[field])) continue
        const trial = { ...cur, [field]: atom }
        if (boundary.prop(trial)) continue
        if (bestTrial === null || better(trial, bestTrial)) bestTrial = trial
      }
      if (bestTrial !== null && better(bestTrial, cur)) { cur = bestTrial; moved = true }
    }
    for (const fa of Object.keys(boundary.atoms)) {
      for (const fb of Object.keys(boundary.atoms)) {
        if (fa === fb) continue
        for (const aa of boundary.atoms[fa]) {
          for (const ab of boundary.atoms[fb]) {
            const trial = { ...cur, [fa]: aa, [fb]: ab }
            if (boundary.prop(trial)) continue
            if (better(trial, cur)) { cur = trial; moved = true }
          }
        }
      }
    }
    if (!moved) break
  }
  return cur
}

const rng = mulberry32(SEED)
const open = []
for (const b of BOUNDARIES) {
  let failing = null
  for (let i = 0; i < CASES && failing === null; i++) {
    const c = {}
    for (const field of Object.keys(b.atoms)) c[field] = pick(rng, b.atoms[field])
    if (!b.prop(c)) failing = c
  }
  if (failing === null) {
    console.log('BOUNDARY ' + b.id + ' cases=' + CASES + ' status=held')
    continue
  }
  const minimal = canonicalize(b, shrink(b, failing))
  console.log('BOUNDARY ' + b.id + ' status=open')
  console.log('SHRUNK ' + b.id + ' ' + render(minimal))
  open.push({ id: b.id, shrunk: render(minimal) })
}

const observed = JSON.stringify(open)
const expected = JSON.stringify(KNOWN)
if (observed !== expected) {
  console.log('KNOWN ' + expected)
  console.log('OBSERVED ' + observed)
  console.log('RESULT: FAIL')
  process.exit(1)
}
console.log('OPEN ' + open.length + ' known-minimized')
console.log('RESULT: PASS')
