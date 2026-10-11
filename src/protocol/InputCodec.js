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

export const INPUT_CASE = Object.freeze({
  ACCEPTED: 'input_packet_accepted',
  CLAMPED: 'input_field_clamped',
  DROPPED: 'input_records_dropped',
  SCHEMA: 'input_schema_undeclared',
  ENTRIES: 'input_entries_not_array',
  ENTRIES_EMPTY: 'input_entries_empty',
  RECORD: 'input_record_not_object',
  RECORD_DATA: 'input_record_data_not_object',
  SEQUENCE: 'input_sequence_out_of_domain',
  EPOCH: 'input_epoch_out_of_domain',
  FIELD: 'input_field_not_finite',
  PAYLOAD: 'input_payload_not_binary',
  PAYLOAD_EMPTY: 'input_payload_empty',
  COUNT: 'input_count_out_of_range',
  TRUNCATED_EPOCH: 'input_truncated_epoch',
  TRUNCATED_RECORD: 'input_truncated_record',
  TRUNCATED_ANALOG: 'input_truncated_analog',
  TRUNCATED_AXES: 'input_truncated_axes',
  FLAGS: 'input_flags_unknown_bits',
  AXIS: 'input_axis_not_finite',
  TRAILING: 'input_trailing_bytes',
})

export const INPUT_CASE_CODES = Object.freeze(Object.values(INPUT_CASE))

function renderCase(c) {
  switch (c.code) {
    case INPUT_CASE.CLAMPED: return `input record field "${c.field}" is outside ${c.lo}..${c.hi} and was clamped, not sent as given (got ${c.got})`
    case INPUT_CASE.DROPPED: return `input packet was given ${c.got} records and holds ${c.kept}, so the oldest ${c.dropped} were not sent`
    case INPUT_CASE.SCHEMA: return 'input packet schema is not a declared input schema'
    case INPUT_CASE.ENTRIES: return `input packet entries is not an array (got ${c.gotType})`
    case INPUT_CASE.ENTRIES_EMPTY: return 'input packet carries no records'
    case INPUT_CASE.RECORD: return `input packet record ${c.index} is not an object`
    case INPUT_CASE.RECORD_DATA: return `input packet record ${c.index} data is not an object`
    case INPUT_CASE.SEQUENCE: return `input packet record ${c.index} sequence ${c.got} outside ${c.lo}..${c.hi}`
    case INPUT_CASE.EPOCH: return `input packet chart epoch ${c.got} outside ${c.lo}..${c.hi}`
    case INPUT_CASE.FIELD: return `input record field "${c.field}" is not a finite number (got ${c.gotType} ${c.got})`
    case INPUT_CASE.PAYLOAD: return 'input payload is not binary (pre-v2 client?)'
    case INPUT_CASE.PAYLOAD_EMPTY: return 'empty input packet'
    case INPUT_CASE.COUNT: return `input packet record count ${c.got} outside 1..${c.hi}`
    case INPUT_CASE.TRUNCATED_EPOCH: return 'truncated input packet chart epoch'
    case INPUT_CASE.TRUNCATED_RECORD: return 'truncated input record header'
    case INPUT_CASE.TRUNCATED_ANALOG: return 'truncated analog axes'
    case INPUT_CASE.TRUNCATED_AXES: return 'truncated extra axes'
    case INPUT_CASE.FLAGS: return `input record flags 0x${Number(c.got).toString(16)} set bits no flag is declared for`
    case INPUT_CASE.AXIS: return `extra axis "${c.field}" is not a finite f32`
    case INPUT_CASE.TRAILING: return `input packet has ${c.got} trailing bytes`
    default: return c.message ?? `input packet case ${String(c.code)} has no rendering`
  }
}

function inputCase(code, fields = {}) {
  const out = { code, ...fields }
  Object.defineProperty(out, 'reason', { enumerable: true, configurable: true, get: () => `[InputCodec] ${renderCase(out)}` })
  return Object.freeze(out)
}

function rejection(code, fields = {}) {
  return Object.freeze({ accepted: false, ...inputCase(code, fields) })
}

function throwableRejection(code, fields = {}) {
  const r = rejection(code, fields)
  const err = new RangeError(r.reason)
  err.rejection = r
  return err
}

export function toRejection(e, fallback = INPUT_CASE.FIELD) {
  return e?.rejection ?? rejection(fallback, { message: e?.message ?? String(e) })
}

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
  throw throwableRejection(INPUT_CASE.FIELD, { field: name, gotType: typeof value, got: String(value) })
}

function quantYaw(yaw) {
  const y = finiteField('yaw', yaw)
  return Math.round(((y % TAU + TAU) % TAU) / TAU * YAW_STEPS) % YAW_STEPS
}

function clampedTo(field, got, sent, lo, hi, cases) {
  cases.push(inputCase(INPUT_CASE.CLAMPED, { field, lo, hi, got, sent }))
  return sent
}

function bounds(name, value, lo, hi, cases) {
  if (value < lo) return clampedTo(name, value, lo, lo, hi, cases)
  if (value > hi) return clampedTo(name, value, hi, lo, hi, cases)
  return value
}

function quantPitch(pitch, cases) {
  const p = bounds('pitch', finiteField('pitch', pitch), -HALF_PI, HALF_PI, cases)
  return Math.round(p * PITCH_SCALE)
}

function quantAnalog(name, v, cases) {
  const a = bounds(name, finiteField(name, v), -1, 1, cases)
  return Math.round(a * ANALOG_SCALE)
}

function uint32Field(name, value) {
  if (Number.isInteger(value) && value >= 0 && value < UINT32_CEILING) return value
  throw throwableRejection(name === 'chartEpoch' ? INPUT_CASE.EPOCH : INPUT_CASE.SEQUENCE, { got: String(value), lo: 0, hi: UINT32_CEILING - 1 })
}

function writeRecord(view, off, schema, sequence, input, cases) {
  let bits = 0
  const { buttons, axes } = schema
  for (let i = 0; i < buttons.length; i++) if (input[buttons[i]]) bits |= (1 << i)
  const hasAnalog = input.analogForward !== undefined || input.analogRight !== undefined
  view.setUint32(off, sequence, true)
  view.setUint32(off + 4, bits >>> 0, true)
  view.setUint16(off + 8, quantYaw(input.yaw), true)
  view.setInt16(off + 10, quantPitch(input.pitch, cases), true)
  view.setUint8(off + 12, bounds('expr', finiteField('expr', input.expr), 0, 255, cases))
  view.setUint8(off + 13, hasAnalog ? FLAG_ANALOG : 0)
  off += RECORD_FIXED_BYTES
  if (hasAnalog) {
    view.setInt8(off, quantAnalog('analogForward', input.analogForward, cases))
    view.setInt8(off + 1, quantAnalog('analogRight', input.analogRight, cases))
    off += ANALOG_BYTES
  }
  for (const a of axes) { view.setFloat32(off, finiteField(a, input[a]), true); off += AXIS_BYTES }
  return off
}

function readRecord(view, off, schema, end) {
  if (off + RECORD_FIXED_BYTES > end) throw throwableRejection(INPUT_CASE.TRUNCATED_RECORD, { offset: off, end })
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
  if (flags & ~FLAG_ANALOG) throw throwableRejection(INPUT_CASE.FLAGS, { got: flags })
  if (flags & FLAG_ANALOG) {
    if (off + ANALOG_BYTES > end) throw throwableRejection(INPUT_CASE.TRUNCATED_ANALOG, { offset: off, end })
    input.analogForward = view.getInt8(off) / ANALOG_SCALE
    input.analogRight = view.getInt8(off + 1) / ANALOG_SCALE
    off += ANALOG_BYTES
  }
  if (off + axes.length * AXIS_BYTES > end) throw throwableRejection(INPUT_CASE.TRUNCATED_AXES, { offset: off, end })
  for (const a of axes) {
    const v = view.getFloat32(off, true); off += AXIS_BYTES
    if (!Number.isFinite(v)) throw throwableRejection(INPUT_CASE.AXIS, { field: a })
    input[a] = v
  }
  return { sequence, data: input, next: off }
}

export function tryEncodeInputPacket(schema, entries, chartEpoch = 0) {
  if (!schema || !Array.isArray(schema.buttons) || !Array.isArray(schema.axes)) return rejection(INPUT_CASE.SCHEMA, {})
  if (!Array.isArray(entries)) return rejection(INPUT_CASE.ENTRIES, { gotType: typeof entries })
  if (entries.length === 0) return rejection(INPUT_CASE.ENTRIES_EMPTY, {})
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e || typeof e !== 'object') return rejection(INPUT_CASE.RECORD, { index: i })
    if (!Number.isInteger(e.sequence) || e.sequence < 0 || e.sequence >= UINT32_CEILING) return rejection(INPUT_CASE.SEQUENCE, { index: i, got: String(e.sequence), lo: 0, hi: UINT32_CEILING - 1 })
    if (!e.data || typeof e.data !== 'object') return rejection(INPUT_CASE.RECORD_DATA, { index: i })
  }
  const epoch = chartEpoch === undefined || chartEpoch === null ? 0 : chartEpoch
  if (!Number.isInteger(epoch) || epoch < 0 || epoch >= UINT32_CEILING) return rejection(INPUT_CASE.EPOCH, { got: String(chartEpoch), lo: 0, hi: UINT32_CEILING - 1 })
  const n = Math.min(MAX_INPUTS_PER_PACKET, entries.length)
  const first = entries.length - n
  const tagged = epoch > 0
  const cases = []
  if (first > 0) cases.push(inputCase(INPUT_CASE.DROPPED, { dropped: first, kept: n, got: entries.length }))
  let size = tagged ? 1 + EPOCH_BYTES : 1
  for (let i = first; i < entries.length; i++) size += recordBytes(schema, entries[i].data)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  out[0] = n | (tagged ? FLAG_EPOCH_TAGGED : 0)
  let off = 1
  if (tagged) { view.setUint32(off, uint32Field('chartEpoch', epoch), true); off += EPOCH_BYTES }
  try {
    for (let i = first; i < entries.length; i++) off = writeRecord(view, off, schema, uint32Field('sequence', entries[i].sequence), entries[i].data, cases)
  } catch (e) {
    return toRejection(e)
  }
  return Object.freeze({ accepted: true, code: INPUT_CASE.ACCEPTED, bytes: out, count: n, dropped: first, cases })
}

export function encodeInputPacket(schema, entries, chartEpoch = 0) {
  const r = tryEncodeInputPacket(schema, entries, chartEpoch)
  if (!r.accepted) throw new RangeError(r.reason)
  return r.bytes
}

export function decodeInputPacket(schema, bytes) {
  if (!(bytes instanceof Uint8Array)) return rejection(INPUT_CASE.PAYLOAD, {})
  if (bytes.length < 1) return rejection(INPUT_CASE.PAYLOAD_EMPTY, {})
  const n = bytes[0] & ~FLAG_EPOCH_TAGGED
  if (n === 0 || n > MAX_INPUTS_PER_PACKET) return rejection(INPUT_CASE.COUNT, { got: n, hi: MAX_INPUTS_PER_PACKET })
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries = []
  let off = 1
  let chartEpoch = 0
  if (bytes[0] & FLAG_EPOCH_TAGGED) {
    if (bytes.length < 1 + EPOCH_BYTES) return rejection(INPUT_CASE.TRUNCATED_EPOCH, { offset: off, end: bytes.length })
    chartEpoch = view.getUint32(off, true); off += EPOCH_BYTES
  }
  try {
    for (let i = 0; i < n; i++) { const r = readRecord(view, off, schema, bytes.length); entries.push({ sequence: r.sequence, data: r.data }); off = r.next }
  } catch (e) {
    return toRejection(e, INPUT_CASE.TRUNCATED_RECORD)
  }
  if (off !== bytes.length) return rejection(INPUT_CASE.TRAILING, { got: bytes.length - off })
  return Object.freeze({ accepted: true, code: INPUT_CASE.ACCEPTED, entries, chartEpoch })
}

export function quantizeInput(schema, input, cases = []) {
  const buf = new Uint8Array(recordBytes(schema, input))
  writeRecord(new DataView(buf.buffer), 0, schema, 0, input, cases)
  return readRecord(new DataView(buf.buffer), 0, schema, buf.length).data
}
