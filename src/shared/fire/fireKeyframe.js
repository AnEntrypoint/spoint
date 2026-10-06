import { FIRE_EVENT, FIRE_STATE } from './fireKernel.js'

const MAGIC = 0x46524b31
const VERSION = 4
const HEADER_BYTES = 24
const TILE_CELL_SHIFT = 6
const TILE_CELLS = 1 << TILE_CELL_SHIFT
const CELL_SCAR = 1
const CELL_FULL = 2
const HASH_SEED = 0x811c9dc5
const HASH_PRIME = 0x01000193
const SCAR_BLOCK = 1024
const TILE_BLOCK = 16
const HASH_BLOCK = 16384
const B64_BLOCK = 49152
const PHASE_SCAR = 0
const PHASE_CELL = 1
const PHASE_LOG = 2
const PHASE_HASH = 3
const PHASE_FINAL = 4
const PHASE_B64 = 5
const PHASE_DONE = 6
const SLOT_FIELDS = ['face', 'I', 'J', 'source', 'radius', 'value', 'wx', 'wy', 'wz']
const SCALAR_F64 = ['stepStart', 'nextStepTick']
const SCALAR_U32 = ['tileCount', 'activeCount', 'activeTileCount', 'scarCount', 'stepIndex', 'phase', 'cursor', 'phaseEnd', 'writePtr', 'quota', 'stepInterval', 'moisture', 'rain', 'eventSeq']
const STAT_FIELDS = ['steps', 'cellsVisited', 'ignitions', 'spots', 'deniedActivations', 'deniedTiles', 'slowSteps']
const TILE_ARRAYS = [
  ['tileFace', Uint8Array], ['tileI', Int32Array], ['tileJ', Int32Array], ['maskLo', Uint32Array], ['maskHi', Uint32Array],
  ['tileListed', Uint8Array], ['interiorLo', Uint32Array], ['interiorHi', Uint32Array], ['activeTiles', Int32Array],
]

function nowMs() { return typeof performance === 'object' && performance !== null ? performance.now() : Date.now() }

function createWriter(reserve = 1024) {
  let bytes = new Uint8Array(Math.max(64, reserve)), view = new DataView(bytes.buffer), at = 0
  const need = n => {
    if (at + n <= bytes.length) return
    let size = bytes.length
    while (size < at + n) size *= 2
    const next = new Uint8Array(size)
    next.set(bytes.subarray(0, at))
    bytes = next; view = new DataView(bytes.buffer)
  }
  return {
    u8(v) { need(1); view.setUint8(at, v); at += 1 },
    u32(v) { need(4); view.setUint32(at, v, true); at += 4 },
    i32(v) { need(4); view.setInt32(at, v, true); at += 4 },
    f64(v) { need(8); view.setFloat64(at, v, true); at += 8 },
    raw(src) {
      const view8 = new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
      need(view8.byteLength)
      bytes.set(view8, at); at += view8.byteLength
    },
    peek() { return bytes.subarray(0, at) },
    done() { return bytes.subarray(0, at) },
  }
}

function createReader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  return {
    u8() { const v = view.getUint8(at); at += 1; return v },
    u32() { const v = view.getUint32(at, true); at += 4; return v },
    i32() { const v = view.getInt32(at, true); at += 4; return v },
    f64() { const v = view.getFloat64(at, true); at += 8; return v },
    rest() { return bytes.subarray(at) },
    advance(n) { at += n },
    typed(Ctor, length) {
      const out = new Ctor(length)
      const dst = new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
      dst.set(bytes.subarray(at, at + dst.byteLength))
      at += dst.byteLength
      return out
    },
    get at() { return at },
  }
}

function fnv1a(bytes) {
  let h = HASH_SEED
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, HASH_PRIME) }
  return h >>> 0
}

function b64Chunk(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function writeEvent(w, ev) {
  w.u8(ev.kind ?? 0)
  w.f64(ev.tick ?? 0)
  w.u32(ev.seq ?? 0)
  w.f64(ev.id ?? 0)
  for (const f of SLOT_FIELDS) w.i32(Number.isFinite(ev[f]) ? ev[f] : 0)
}

function readEvent(r) {
  const kind = r.u8(), tick = r.f64(), seq = r.u32(), id = r.f64()
  const ev = { kind, tick, seq, id }
  for (const f of SLOT_FIELDS) ev[f] = r.i32()
  if (kind === FIRE_EVENT.WIND) return { kind, tick, seq, id, wx: ev.wx, wy: ev.wy, wz: ev.wz }
  if (kind === FIRE_EVENT.MOISTURE || kind === FIRE_EVENT.RAIN) return { kind, tick, seq, id, value: ev.value }
  if (kind === FIRE_EVENT.EXTINGUISH || kind === FIRE_EVENT.IGNITE_AREA) return { kind, tick, seq, id, face: ev.face, I: ev.I, J: ev.J, radius: ev.radius }
  return { kind, tick, seq, id, face: ev.face, I: ev.I, J: ev.J, source: ev.source }
}

export function createKeyframeEncoder({ tick, snapshot, logOf = () => [] }) {
  if (!snapshot || !Number.isFinite(tick)) throw new TypeError('[fireKeyframe] a keyframe needs a snapshot and its tick')
  const classFuel = snapshot.classFuel
  if (!classFuel) throw new TypeError('[fireKeyframe] the snapshot carries no classFuel; a keyframe needs the kernel fuel table')
  const tileCount = snapshot.tileCount ?? 0
  const cells = tileCount << TILE_CELL_SHIFT
  const cls = snapshot.cls
  if (!cls || cls.length < cells) throw new TypeError(`[fireKeyframe] the snapshot carries ${cls ? cls.length : 0} class entries for ${cells} cells`)
  const scar = snapshot.scar
  const scarCount = snapshot.scarCount ?? 0
  if (scarCount > 0 && (!scar || scar.length < scarCount * 2)) throw new TypeError(`[fireKeyframe] the snapshot carries no scar ring for ${scarCount} scars`)
  const w = createWriter(HEADER_BYTES + 4096 + cells * 9 + scarCount * 4)
  w.u32(MAGIC)
  w.u32(VERSION)
  w.u32(0)
  w.u32(0)
  w.f64(tick)
  for (const f of SCALAR_U32) w.u32(snapshot[f] ?? 0)
  for (const f of SCALAR_F64) w.f64(snapshot[f] ?? 0)
  for (let i = 0; i < 3; i++) w.i32(snapshot.wind ? snapshot.wind[i] : 0)
  for (const f of STAT_FIELDS) w.f64(snapshot.stats ? snapshot.stats[f] ?? 0 : 0)
  w.u32(classFuel.length)
  w.raw(classFuel instanceof Uint16Array ? classFuel : Uint16Array.from(classFuel))
  const pending = snapshot.pending ?? []
  w.u32(pending.length)
  for (const ev of pending) writeEvent(w, ev)
  w.raw(cls.subarray(0, cells))
  for (const [name, Ctor] of TILE_ARRAYS) {
    const arr = snapshot[name]
    const length = name === 'activeTiles' ? (snapshot.activeTileCount ?? 0) : tileCount
    w.u32(length)
    if (length > 0) {
      if (!arr || arr.length < length) throw new TypeError(`[fireKeyframe] the snapshot carries no ${name} for ${length} entries`)
      w.raw(arr instanceof Ctor ? arr.subarray(0, length) : Ctor.from(arr.subarray(0, length)))
    }
  }
  w.u32(scarCount)
  const scarBuf = new Uint8Array(SCAR_BLOCK * 8)
  const tileBuf = new Uint8Array(8 + TILE_CELLS * 8)
  const tileView = new DataView(tileBuf.buffer)
  const codes = new Uint8Array(TILE_CELLS)
  const { state, fuel, heat, timer } = snapshot
  let phase = PHASE_SCAR
  let scarAt = 0, prevStep = 0, scarBytes = 0
  let tileAt = 0
  let hash = HASH_SEED
  let hashAt = HEADER_BYTES
  let b64At = 0
  const b64Parts = []
  let base64 = null
  let out = null

  function writeTile(t) {
    const base = t << TILE_CELL_SHIFT
    let lo = 0, hi = 0
    for (let i = 0; i < 32; i++) {
      const g = base + i
      const code = state[g] === FIRE_STATE.UNBURNT && heat[g] === 0 && timer[g] === 0 && fuel[g] === classFuel[cls[g]] ? 0
        : state[g] === FIRE_STATE.BURNT && fuel[g] === 0 && heat[g] === 0 && timer[g] === 0 ? CELL_SCAR : CELL_FULL
      codes[i] = code
      if (code !== 0) lo |= 1 << i
    }
    for (let i = 32; i < TILE_CELLS; i++) {
      const g = base + i
      const code = state[g] === FIRE_STATE.UNBURNT && heat[g] === 0 && timer[g] === 0 && fuel[g] === classFuel[cls[g]] ? 0
        : state[g] === FIRE_STATE.BURNT && fuel[g] === 0 && heat[g] === 0 && timer[g] === 0 ? CELL_SCAR : CELL_FULL
      codes[i] = code
      if (code !== 0) hi |= 1 << (i - 32)
    }
    tileView.setUint32(0, lo, true)
    tileView.setUint32(4, hi, true)
    let n = 8
    for (let i = 0; i < TILE_CELLS; i++) {
      const code = codes[i]
      if (code === 0) continue
      if (code === CELL_SCAR) { tileBuf[n++] = CELL_SCAR; continue }
      const g = base + i
      tileBuf[n++] = CELL_FULL
      tileBuf[n++] = state[g]
      tileBuf[n++] = fuel[g] & 0xff; tileBuf[n++] = fuel[g] >>> 8
      tileBuf[n++] = heat[g] & 0xff; tileBuf[n++] = heat[g] >>> 8
      tileBuf[n++] = timer[g] & 0xff; tileBuf[n++] = timer[g] >>> 8
    }
    w.raw(tileBuf.subarray(0, n))
  }

  function stepScars(deadline) {
    while (scarAt < scarCount) {
      const blockEnd = Math.min(scarCount, scarAt + SCAR_BLOCK)
      scarBytes = 0
      while (scarAt < blockEnd) {
        const step = scar[scarAt * 2 + 1]
        if (step < prevStep) throw new RangeError(`[fireKeyframe] scar ${scarAt} is scheduled at step ${step} before scar ${scarAt - 1} at ${prevStep}; the ring must be ordered`)
        let x = scar[scarAt * 2] >>> 0
        while (x >= 0x80) { scarBuf[scarBytes++] = (x & 0x7f) | 0x80; x >>>= 7 }
        scarBuf[scarBytes++] = x
        x = step - prevStep
        while (x >= 0x80) { scarBuf[scarBytes++] = (x & 0x7f) | 0x80; x >>>= 7 }
        scarBuf[scarBytes++] = x
        prevStep = step
        scarAt++
      }
      w.raw(scarBuf.subarray(0, scarBytes))
      if (nowMs() >= deadline) return
    }
    phase = PHASE_CELL
  }

  function stepCells(deadline) {
    while (tileAt < tileCount) {
      const blockEnd = Math.min(tileCount, tileAt + TILE_BLOCK)
      while (tileAt < blockEnd) writeTile(tileAt++)
      if (nowMs() >= deadline) return
    }
    phase = PHASE_LOG
  }

  function stepLog() {
    const rows = logOf()
    w.u32(rows.length)
    for (const ev of rows) writeEvent(w, ev)
    phase = PHASE_HASH
  }

  function stepHash(deadline) {
    if (out === null) out = w.peek()
    const end = out.length
    while (hashAt < end) {
      const blockEnd = Math.min(end, hashAt + HASH_BLOCK)
      while (hashAt < blockEnd) { hash ^= out[hashAt++]; hash = Math.imul(hash, HASH_PRIME) }
      if (nowMs() >= deadline) return
    }
    phase = PHASE_FINAL
  }

  function stepFinal() {
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
    view.setUint32(8, out.byteLength, true)
    view.setUint32(12, hash >>> 0, true)
    phase = PHASE_B64
  }

  function stepB64(deadline) {
    if (b64At === 0 && out.length <= B64_BLOCK) {
      base64 = b64Chunk(out)
      b64At = out.length
      phase = PHASE_DONE
      return
    }
    while (b64At < out.length) {
      const blockEnd = Math.min(out.length, b64At + B64_BLOCK)
      b64Parts.push(b64Chunk(out.subarray(b64At, blockEnd)))
      b64At = blockEnd
      if (nowMs() >= deadline) return
    }
    base64 = b64Parts.join('')
    phase = PHASE_DONE
  }

  return {
    get done() { return phase === PHASE_DONE },
    get bytes() {
      if (phase !== PHASE_DONE) throw new Error('[fireKeyframe] the keyframe is still being encoded; advance(budgetMs) until done')
      return out
    },
    get base64() {
      if (phase !== PHASE_DONE) throw new Error('[fireKeyframe] the keyframe is still being encoded; advance(budgetMs) until done')
      return base64
    },
    advance(budgetMs) {
      const deadline = nowMs() + budgetMs
      while (phase !== PHASE_DONE && nowMs() < deadline) {
        if (phase === PHASE_SCAR) stepScars(deadline)
        else if (phase === PHASE_CELL) stepCells(deadline)
        else if (phase === PHASE_LOG) stepLog()
        else if (phase === PHASE_HASH) stepHash(deadline)
        else if (phase === PHASE_FINAL) stepFinal()
        else stepB64(deadline)
      }
      return phase === PHASE_DONE
    },
    finish() {
      while (phase !== PHASE_DONE) {
        if (phase === PHASE_SCAR) stepScars(Infinity)
        else if (phase === PHASE_CELL) stepCells(Infinity)
        else if (phase === PHASE_LOG) stepLog()
        else if (phase === PHASE_HASH) stepHash(Infinity)
        else if (phase === PHASE_FINAL) stepFinal()
        else stepB64(Infinity)
      }
      return out
    },
  }
}

export function encodeFireKeyframe({ tick, snapshot, log = [] }) {
  return createKeyframeEncoder({ tick, snapshot, logOf: () => log }).finish()
}

export function decodeFireKeyframe(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('[fireKeyframe] keyframe must be a Uint8Array')
  if (bytes.byteLength < HEADER_BYTES) throw new TypeError(`[fireKeyframe] keyframe is ${bytes.byteLength} B, too short`)
  const r = createReader(bytes)
  if (r.u32() !== MAGIC) throw new TypeError('[fireKeyframe] keyframe magic mismatch')
  if (r.u32() !== VERSION) throw new TypeError(`[fireKeyframe] keyframe version mismatch, expected ${VERSION}`)
  const declared = r.u32()
  const hash = r.u32()
  if (declared !== bytes.byteLength) throw new TypeError(`[fireKeyframe] keyframe declares ${declared} B but carries ${bytes.byteLength} B`)
  if (fnv1a(bytes.subarray(HEADER_BYTES)) !== hash) throw new TypeError('[fireKeyframe] keyframe checksum mismatch')
  const tick = r.f64()
  const snapshot = { pending: [], stats: {} }
  for (const f of SCALAR_U32) snapshot[f] = r.u32()
  for (const f of SCALAR_F64) snapshot[f] = r.f64()
  snapshot.wind = new Int32Array([r.i32(), r.i32(), r.i32()])
  for (const f of STAT_FIELDS) snapshot.stats[f] = r.f64()
  snapshot.classFuel = r.typed(Uint16Array, r.u32())
  const pendingCount = r.u32()
  for (let i = 0; i < pendingCount; i++) snapshot.pending.push(readEvent(r))
  const tileCount = snapshot.tileCount
  const cells = tileCount << TILE_CELL_SHIFT
  const cls = r.typed(Uint8Array, cells)
  snapshot.cls = cls
  for (const [name, Ctor] of TILE_ARRAYS) {
    const length = r.u32()
    snapshot[name] = length > 0 ? r.typed(Ctor, length) : new Ctor(0)
  }
  const declaredScars = r.u32()
  if (declaredScars !== snapshot.scarCount) throw new TypeError(`[fireKeyframe] keyframe declares ${declaredScars} scars, its scalars say ${snapshot.scarCount}`)
  const scar = new Int32Array(snapshot.scarCount * 2)
  const rest = r.rest()
  let p = 0
  let prevStep = 0
  for (let i = 0; i < snapshot.scarCount; i++) {
    let v = 0, shift = 0, byte = 0
    do { byte = rest[p++]; v |= (byte & 0x7f) << shift; shift += 7 } while (byte >= 0x80)
    scar[i * 2] = v >>> 0
    v = 0; shift = 0
    do { byte = rest[p++]; v |= (byte & 0x7f) << shift; shift += 7 } while (byte >= 0x80)
    prevStep += v >>> 0
    scar[i * 2 + 1] = prevStep
  }
  snapshot.scar = scar
  const classFuel = snapshot.classFuel
  const state = new Uint8Array(cells), fuel = new Uint16Array(cells), heat = new Uint16Array(cells), timer = new Uint16Array(cells)
  for (let t = 0; t < tileCount; t++) {
    const base = t << TILE_CELL_SHIFT
    const lo = rest[p] | (rest[p + 1] << 8) | (rest[p + 2] << 16) | (rest[p + 3] << 24)
    const hi = rest[p + 4] | (rest[p + 5] << 8) | (rest[p + 6] << 16) | (rest[p + 7] << 24)
    p += 8
    for (let i = 0; i < TILE_CELLS; i++) {
      const g = base + i
      if (i < 32 ? (lo & (1 << i)) === 0 : (hi & (1 << (i - 32))) === 0) { fuel[g] = classFuel[cls[g]]; continue }
      const code = rest[p++]
      if (code === CELL_SCAR) { state[g] = FIRE_STATE.BURNT; continue }
      state[g] = rest[p++]
      fuel[g] = rest[p++] | (rest[p++] << 8)
      heat[g] = rest[p++] | (rest[p++] << 8)
      timer[g] = rest[p++] | (rest[p++] << 8)
    }
  }
  r.advance(p)
  const logCount = r.u32()
  const log = []
  for (let i = 0; i < logCount; i++) log.push(readEvent(r))
  snapshot.state = state; snapshot.fuel = fuel; snapshot.heat = heat; snapshot.timer = timer
  return { tick, snapshot, log }
}

export function keyframeToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

export function keyframeFromBase64(text) {
  if (typeof text !== 'string' || text.length === 0) throw new TypeError('[fireKeyframe] keyframe payload must be a base64 string')
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(text, 'base64')
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }
  const raw = atob(text)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}
