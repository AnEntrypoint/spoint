const SLOT_FIELDS = new Set(['color', 'roughness', 'metalness', 'texture'])
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/
const TEXTURE_PATH_RE = /^[A-Za-z0-9_\-./]{1,512}$/
const MAX_SLOT_NAME = 128
const MAX_SLOTS = 64

function refuse(reason, detail) {
  return { ok: false, reason, detail }
}

function unitInterval(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
}

function parseSlot(name, raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return refuse('slot-not-object', name)
  const out = {}
  for (const key of Object.keys(raw)) {
    if (!SLOT_FIELDS.has(key)) return refuse('slot-unknown-field', `${name}.${key}`)
    const v = raw[key]
    if (key === 'color') {
      if (typeof v !== 'string' || !HEX_COLOR_RE.test(v)) return refuse('slot-bad-color', name)
    } else if (key === 'texture') {
      if (typeof v !== 'string' || !TEXTURE_PATH_RE.test(v) || v.includes('..')) return refuse('slot-bad-texture', name)
    } else if (!unitInterval(v)) {
      return refuse('slot-bad-range', `${name}.${key}`)
    }
    out[key] = v
  }
  return { ok: true, value: out }
}

export function parseMaterialSlots(raw) {
  if (raw === null) return { ok: true, value: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return refuse('not-object')
  const names = Object.keys(raw)
  if (names.length > MAX_SLOTS) return refuse('too-many-slots', String(names.length))
  const value = {}
  for (const name of names) {
    if (name.length === 0 || name.length > MAX_SLOT_NAME) return refuse('slot-bad-name', name.slice(0, 32))
    const parsed = parseSlot(name, raw[name])
    if (!parsed.ok) return parsed
    value[name] = parsed.value
  }
  return { ok: true, value }
}
