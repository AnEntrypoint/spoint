function refusal(code, message) {
  const err = new TypeError(`[touch-surfaces] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export const MAX_TOUCH_CHIPS = 4

export function resolveControls(document, draft) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw refusal('touch-document-invalid', 'document must be an object')
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw refusal('touch-draft-invalid', 'draft must be an object')
  const diagnostics = []
  const readList = (key) => {
    const value = document[key] === undefined ? [] : document[key]
    if (!Array.isArray(value)) {
      diagnostics.push(`${key}-not-array`)
      return []
    }
    return value.filter((item, i) => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) {
        diagnostics.push(`bad-${key}-${i}`)
        return false
      }
      return true
    })
  }
  const sticks = readList('sticks')
  const buttons = readList('buttons')
  const pads = readList('pads')
  const gestures = readList('gestures')
  let chips = [...sticks, ...buttons, ...pads]
  if (chips.length > MAX_TOUCH_CHIPS) {
    diagnostics.push(`chip-cap-exceeded:${chips.length}>${MAX_TOUCH_CHIPS}`)
    chips = chips.slice(0, MAX_TOUCH_CHIPS)
  }
  if (sticks.length === 0 && buttons.length === 0) {
    return { ok: false, reasonCode: 'touch-surface-unusable', fallback: draft, diagnostics, controls: null }
  }
  return {
    ok: true,
    reasonCode: null,
    fallback: null,
    diagnostics,
    controls: {
      sticks: chips.filter(c => sticks.includes(c)),
      buttons: chips.filter(c => buttons.includes(c)),
      pads: chips.filter(c => pads.includes(c)),
      gestures,
      style: document.style && typeof document.style === 'object' ? document.style : {},
      axes: Array.isArray(document.axes) ? document.axes.filter(a => typeof a === 'string') : ['touchActive', 'touchTwist'],
    },
    sendAction(id) { return { type: 'action', id } },
    sendAxis(id, value) { return { type: 'axis', id, value } },
  }
}
