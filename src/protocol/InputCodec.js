export const DEFAULT_INPUT_BUTTONS = Object.freeze([
  'forward', 'backward', 'left', 'right', 'jump', 'sprint', 'crouch', 'shoot',
  'aim', 'reload', 'interact', 'use', 'weapon', 'ability1', 'ability2', 'ability3'
])
export const MAX_INPUT_BUTTONS = 32
export const MAX_INPUTS_PER_PACKET = 8
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
  for (const b of extraButtons) if (typeof b === 'string' && !buttons.includes(b)) buttons.push(b)
  if (buttons.length > MAX_INPUT_BUTTONS) throw new Error(`[InputCodec] ${buttons.length} input buttons declared, max ${MAX_INPUT_BUTTONS}`)
  const axes = extraAxes.filter(a => typeof a === 'string' && !buttons.includes(a) && a !== 'yaw' && a !== 'pitch')
  return Object.freeze({ buttons: Object.freeze(buttons), axes: Object.freeze(axes) })
}

export const DEFAULT_INPUT_SCHEMA = createInputSchema()

function recordBytes(schema, input) {
  const hasAnalog = input.analogForward !== undefined || input.analogRight !== undefined
  return RECORD_FIXED_BYTES + (hasAnalog ? ANALOG_BYTES : 0) + schema.axes.length * AXIS_BYTES
}

function quantYaw(yaw) {
  const y = Number.isFinite(yaw) ? yaw : 0
  return Math.round(((y % TAU + TAU) % TAU) / TAU * YAW_STEPS) % YAW_STEPS
}

function quantPitch(pitch) {
  const p = Number.isFinite(pitch) ? Math.max(-HALF_PI, Math.min(HALF_PI, pitch)) : 0
  return Math.round(p * PITCH_SCALE)
}

function quantAnalog(v) {
  const a = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0
  return Math.round(a * ANALOG_SCALE)
}

function writeRecord(view, off, schema, sequence, input) {
  let bits = 0
  const { buttons, axes } = schema
  for (let i = 0; i < buttons.length; i++) if (input[buttons[i]]) bits |= (1 << i)
  const hasAnalog = input.analogForward !== undefined || input.analogRight !== undefined
  view.setUint32(off, sequence >>> 0, true)
  view.setUint32(off + 4, bits >>> 0, true)
  view.setUint16(off + 8, quantYaw(input.yaw), true)
  view.setInt16(off + 10, quantPitch(input.pitch), true)
  view.setUint8(off + 12, Math.max(0, Math.min(255, input.expr | 0)))
  view.setUint8(off + 13, hasAnalog ? FLAG_ANALOG : 0)
  off += RECORD_FIXED_BYTES
  if (hasAnalog) {
    view.setInt8(off, quantAnalog(input.analogForward))
    view.setInt8(off + 1, quantAnalog(input.analogRight))
    off += ANALOG_BYTES
  }
  for (const a of axes) { const v = input[a]; view.setFloat32(off, Number.isFinite(v) ? v : 0, true); off += AXIS_BYTES }
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
  if (flags & FLAG_ANALOG) {
    if (off + ANALOG_BYTES > end) throw new RangeError('[InputCodec] truncated analog axes')
    input.analogForward = view.getInt8(off) / ANALOG_SCALE
    input.analogRight = view.getInt8(off + 1) / ANALOG_SCALE
    off += ANALOG_BYTES
  }
  if (off + axes.length * AXIS_BYTES > end) throw new RangeError('[InputCodec] truncated extra axes')
  for (const a of axes) { const v = view.getFloat32(off, true); input[a] = Number.isFinite(v) ? v : 0; off += AXIS_BYTES }
  return { sequence, data: input, next: off }
}

export function encodeInputPacket(schema, entries, chartEpoch = 0) {
  const n = Math.min(MAX_INPUTS_PER_PACKET, entries.length)
  const first = entries.length - n
  const tagged = chartEpoch > 0
  let size = tagged ? 1 + EPOCH_BYTES : 1
  for (let i = first; i < entries.length; i++) size += recordBytes(schema, entries[i].data)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  out[0] = n | (tagged ? FLAG_EPOCH_TAGGED : 0)
  let off = 1
  if (tagged) { view.setUint32(off, chartEpoch >>> 0, true); off += EPOCH_BYTES }
  for (let i = first; i < entries.length; i++) off = writeRecord(view, off, schema, entries[i].sequence, entries[i].data)
  return out
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

export function quantizeInput(schema, input) {
  const buf = new Uint8Array(recordBytes(schema, input))
  writeRecord(new DataView(buf.buffer), 0, schema, 0, input)
  return readRecord(new DataView(buf.buffer), 0, schema, buf.length).data
}
