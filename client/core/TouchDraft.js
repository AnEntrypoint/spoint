const STICK_ACTIONS = new Set(['move', 'look'])
const BUTTON_COLUMNS = 3

export function touchDraftFromBindings(bindings, layout, responsive) {
  if (!bindings || typeof bindings !== 'object') throw new TypeError('touchDraftFromBindings: bindings must be an object')
  if (!layout || !responsive) throw new TypeError('touchDraftFromBindings: layout and responsive sizes are required')
  const sticks = []
  const buttons = []
  for (const [action, binding] of Object.entries(bindings)) {
    if (!binding || typeof binding !== 'object') throw new TypeError(`touchDraftFromBindings: binding "${action}" must be an object`)
    const mode = binding.touch ?? (STICK_ACTIONS.has(action) ? 'stick' : binding.key ? 'button' : 'none')
    if (mode === 'none') continue
    if (mode === 'stick') {
      if (!STICK_ACTIONS.has(action)) throw new TypeError(`touchDraftFromBindings: "${action}" cannot be a stick`)
      sticks.push({ action, side: action === 'move' ? 'left' : 'right' })
    } else if (mode === 'button' || mode === 'drag') {
      buttons.push({ action, label: binding.label ?? action.toUpperCase(), mode })
    } else {
      throw new TypeError(`touchDraftFromBindings: binding "${action}" has unknown touch mode "${mode}"`)
    }
  }
  const size = responsive.buttonSize
  const spacing = responsive.spacing
  const cell = size + spacing
  const rows = Math.ceil(buttons.length / BUTTON_COLUMNS)
  const originX = layout.buttonsRightOffset
  const originY = layout.h - layout.buttonsBottomOffset - rows * cell
  const placed = buttons.map((b, i) => ({
    ...b,
    x: originX + (BUTTON_COLUMNS - 1 - (i % BUTTON_COLUMNS)) * cell,
    y: originY + Math.floor(i / BUTTON_COLUMNS) * cell,
    size,
  }))
  return { sticks, buttons: placed, radius: responsive.joystickRadius }
}
