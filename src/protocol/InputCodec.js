export const DEFAULT_INPUT_BUTTONS = Object.freeze([
  'forward', 'backward', 'left', 'right', 'jump', 'sprint', 'crouch', 'shoot',
  'aim', 'reload', 'interact', 'use', 'weapon', 'ability1', 'ability2', 'ability3'
])
export const MAX_INPUT_BUTTONS = 32
export const MAX_INPUTS_PER_PACKET = 8
const UINT32_CEILING = 0x100000000
const RESERVED_INPUT_NAMES = new Set(['yaw', 'pitch', 'expr', 'analogForward', 'analogRight'])
const TAU = 2 * Math.PI
const HALF_PI = Math.PI / 2
const YAW_STEPS = 65536
const PITCH_SCALE = 32767 / HALF_PI
const ANALOG_SCALE = 127
const FLAG_ANALOG = 1
const RECORD_FIXED_BYTES = 14
const ANALOG_BYTES = 2
const AXIS_BYTES = 4
const FLAG_EPOCH_TAGGED = 0x80
const EPOCH_BYTES = 4

export function createInputSchema(netcodeConfig = null) {
  const extraButtons = Array.isArray(netcodeConfig?.inputButtons) ? netcodeConfig.inputButtons : []
  const extraAxes = Array.isArray(netcodeConfig?.inputAxes) ? netcodeConfig.inputAxes : []
  const buttons = [...DEFAULT_INPUT_BUTTONS]
  for (const b of extraButtons) {
    if (typeof b !== 'string' || buttons.includes(b)) continue
    if (RESERVED_INPUT_NAMES.has(b)) throw new Error(`[InputCodec] input button "${b}" collides with a fixed field of every input record`)
    buttons.push(b)
  }
  if (buttons.length > MAX_INPUT_BUTTONS) throw new Error(`[InputCodec] ${buttons.length} input buttons declared, max ${MAX_INPUT_BUTTONS}`)
  const axes = []
  for (const a of extraAxes) {
    if (typeof a !== 'string' || buttons.includes(a)) continue
    if (RESERVED_INPUT_NAMES.has(a)) throw new Error(`[InputCodec] input axis "${a}" collides with a fixed field of every input record`)
    if (axes.includes(a)) throw new Error(`[InputCodec] input axis "${a}" is declared twice`)
    axes.push(a)
  }
  return Object.freeze({ buttons: Object.freeze(buttons), axes: Object.freeze(axes) })
}

export const DEFAULT_INPUT_SCHEMA = createInputSchema()

function recordBytes(schema, input) {
  const hasAnalog = input.analogForward !== undefined || input.analogRight !== undefined
  return RECORD_FIXED_BYTES + (hasAnalog ? ANALOG_BYTES : 0) + schema.axes.length * AXIS_BYTES
}

function finiteField(name, value) {
  if (value === undefined) return 0
  if (Number.isFinite(value)) return value
  throw new RangeError(`[InputCodec] input record field "${name}" is not a finite number (got ${typeof value} ${String(value)})`)
}

function quantYaw(yaw) {
  const y = finiteField('yaw', yaw)
  return Math.round(((y % TAU + TAU) % TAU) / TAU * YAW_STEPS) % YAW_STEPS
}

function bounds(name, value, lo, hi, clamped) {
  if (value < lo) { clamped.push(name); return lo }
  if (value > hi) { clamped.push(name); return hi }
  return value
}

function quantPitch(pitch, clamped) {
  const p = bounds('pitch', finiteField('pitch', pitch), -HALF_PI, HALF_PI, clamped)
  return Math.round(p * PITCH_SCALE)
}

function quantAnalog(name, v, clamped) {
  const a = bounds(name, finiteField(name, v), -1, 1, clamped)
  return Math.round(a * ANALOG_SCALE)
}

function uint32Field(name, value) {
  if (Number.isInteger(value) && value >= 0 && value < UINT32_CEILING) return value
  throw new RangeError(`[InputCodec] input packet field "${name}" is not a uint32 (got ${typeof value} ${String(value)})`)
}

function writeRecord(view, off, schema, sequence, input, clamped) {
  let bits = 0
  const { buttons, axes } = schema
  for (let i = 0; i < buttons.length; i++) if (input[buttons[i]]) bits |= (1 << i)
  const hasAnalog = input.analogForward !== undefined || input.analogRight !== undefined
  view.setUint32(off, sequence, true)
  view.setUint32(off + 4, bits >>> 0, true)
  view.setUint16(off + 8, quantYaw(input.yaw), true)
  view.setInt16(off + 10, quantPitch(input.pitch, clamped), true)
  view.setUint8(off + 12, bounds('expr', finiteField('expr', input.expr) | 0, 0, 255, clamped))
  view.setUint8(off + 13, hasAnalog ? FLAG_ANALOG : 0)
  off += RECORD_FIXED_BYTES
  if (hasAnalog) {
    view.setInt8(off, quantAnalog('analogForward', input.analogForward, clamped))
    view.setInt8(off + 1, quantAnalog('analogRight', input.analogRight, clamped))
    off += ANALOG_BYTES
  }
  for (const a of axes) { view.setFloat32(off, finiteField(a, input[a]), true); off += AXIS_BYTES }
  return off
}

function readRecord(view, off, schema, end) {
  if (off + RECORD_FIXED_BYTES > end) throw new RangeError('[InputCodec] truncated input record header')
  const sequence = view.getUint32(off, true)
  const bits = view.getUint32(off + 4, true)
  const input = {}
  const { buttons, axes } = schema
  for (let i = 0; i < buttons.length; i++) input[buttons[i]] = (bits & (1 << i)) !== 0
  input.yaw = view.getUint16(off + 8, true) / YAW_STEPS * TAU
  input.pitch = view.getInt16(off + 10, true) / PITCH_SCALE
  input.expr = view.getUint8(off + 12)
  const flags = view.getUint8(off + 13)
  off += RECORD_FIXED_BYTES
  if (flags & ~FLAG_ANALOG) throw new RangeError(`[InputCodec] input record flags 0x${flags.toString(16)} set bits no flag is declared for`)
  if (flags & FLAG_ANALOG) {
    if (off + ANALOG_BYTES > end) throw new RangeError('[InputCodec] truncated analog axes')
    input.analogForward = view.getInt8(off) / ANALOG_SCALE
    input.analogRight = view.getInt8(off + 1) / ANALOG_SCALE
    off += ANALOG_BYTES
  }
  if (off + axes.length * AXIS_BYTES > end) throw new RangeError('[InputCodec] truncated extra axes')
  for (const a of axes) {
    const v = view.getFloat32(off, true); off += AXIS_BYTES
    if (!Number.isFinite(v)) throw new RangeError(`[InputCodec] extra axis "${a}" is not a finite f32`)
    input[a] = v
  }
  return { sequence, data: input, next: off }
}

export function tryEncodeInputPacket(schema, entries, chartEpoch = 0) {
  if (!schema || !Array.isArray(schema.buttons) || !Array.isArray(schema.axes)) return { accepted: false, reason: 'input packet schema is not a declared input schema' }
  if (!Array.isArray(entries)) return { accepted: false, reason: `input packet entries is not an array (got ${typeof entries})` }
  if (entries.length === 0) return { accepted: false, reason: 'input packet carries no records' }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e || typeof e !== 'object') return { accepted: false, reason: `input packet record ${i} is not an object` }
    if (!Number.isInteger(e.sequence) || e.sequence < 0 || e.sequence >= UINT32_CEILING) return { accepted: false, reason: `input packet record ${i} sequence ${String(e.sequence)} outside 0..${UINT32_CEILING - 1}` }
    if (!e.data || typeof e.data !== 'object') return { accepted: false, reason: `input packet record ${i} data is not an object` }
  }
  const epoch = chartEpoch === undefined || chartEpoch === null ? 0 : chartEpoch
  if (!Number.isInteger(epoch) || epoch < 0 || epoch >= UINT32_CEILING) return { accepted: false, reason: `input packet chart epoch ${String(chartEpoch)} outside 0..${UINT32_CEILING - 1}` }
  const n = Math.min(MAX_INPUTS_PER_PACKET, entries.length)
  const first = entries.length - n
  const tagged = epoch > 0
  const clamped = []
  let size = tagged ? 1 + EPOCH_BYTES : 1
  for (let i = first; i < entries.length; i++) size += recordBytes(schema, entries[i].data)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  out[0] = n | (tagged ? FLAG_EPOCH_TAGGED : 0)
  let off = 1
  if (tagged) { view.setUint32(off, uint32Field('chartEpoch', epoch), true); off += EPOCH_BYTES }
  try {
    for (let i = first; i < entries.length; i++) off = writeRecord(view, off, schema, uint32Field('sequence', entries[i].sequence), entries[i].data, clamped)
  } catch (e) {
    return { accepted: false, reason: e.message }
  }
  return { accepted: true, bytes: out, count: n, dropped: first, clamped }
}

export function encodeInputPacket(schema, entries, chartEpoch = 0) {
  const r = tryEncodeInputPacket(schema, entries, chartEpoch)
  if (!r.accepted) throw new RangeError(`[InputCodec] ${r.reason}`)
  return r.bytes
}

export function decodeInputPacket(schema, bytes) {
  if (!(bytes instanceof Uint8Array)) return { accepted: false, reason: 'input payload is not binary (pre-v2 client?)' }
  if (bytes.length < 1) return { accepted: false, reason: 'empty input packet' }
  const n = bytes[0] & ~FLAG_EPOCH_TAGGED
  if (n === 0 || n > MAX_INPUTS_PER_PACKET) return { accepted: false, reason: `input packet record count ${n} outside 1..${MAX_INPUTS_PER_PACKET}` }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries = []
  let off = 1
  let chartEpoch = 0
  if (bytes[0] & FLAG_EPOCH_TAGGED) {
    if (bytes.length < 1 + EPOCH_BYTES) return { accepted: false, reason: 'truncated input packet chart epoch' }
    chartEpoch = view.getUint32(off, true); off += EPOCH_BYTES
  }
  try {
    for (let i = 0; i < n; i++) { const r = readRecord(view, off, schema, bytes.length); entries.push({ sequence: r.sequence, data: r.data }); off = r.next }
  } catch (e) {
    return { accepted: false, reason: e.message }
  }
  if (off !== bytes.length) return { accepted: false, reason: `input packet has ${bytes.length - off} trailing bytes` }
  return { accepted: true, entries, chartEpoch }
}

export function quantizeInput(schema, input, clamped = []) {
  const buf = new Uint8Array(recordBytes(schema, input))
  writeRecord(new DataView(buf.buffer), 0, schema, 0, input, clamped)
  return readRecord(new DataView(buf.buffer), 0, schema, buf.length).data
}
