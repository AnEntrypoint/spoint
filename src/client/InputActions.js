const MOUSE_BUTTONS = new Set(['left', 'right', 'middle', 'mouse4', 'mouse5', 'wheelUp', 'wheelDown'])
const GAMEPAD_BUTTONS = new Set(['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'start', 'select', 'l3', 'r3',
  'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight'])
const GAMEPAD_INDEXED = /^Gamepad:Button\d+$/
const ACTIVE_ON = new Set(['keydown', 'hold', 'keyup'])
const GESTURES = new Set(['tap', 'double-tap', 'hold', 'press'])
const ACTION_FIELDS = new Set(['keys', 'mouse', 'gamepad', 'modifiers', 'activeOn', 'touch', 'active'])
const TOUCH_FIELDS = new Set(['button', 'label', 'slot', 'gesture'])

export class InputActionError extends Error {
  constructor(reasonCode, detail) {
    super(`[input-actions] ${reasonCode}: ${detail}`)
    this.name = 'InputActionError'
    this.reasonCode = reasonCode
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0

function refuseUnknownFields(where, record, allowed) {
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) throw new InputActionError('unknown-field', `${where}.${field}`)
  }
}

function stringList(where, value) {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) throw new InputActionError('bad-list', where)
  return value
}

function compileTouch(where, touch) {
  if (!isPlainObject(touch)) throw new InputActionError('bad-touch', where)
  refuseUnknownFields(where, touch, TOUCH_FIELDS)
  if (touch.button !== undefined && typeof touch.button !== 'boolean') throw new InputActionError('bad-touch-button', where)
  if (touch.label !== undefined && !isNonEmptyString(touch.label)) throw new InputActionError('bad-touch-label', where)
  if (touch.slot !== undefined && ![1, 2, 3, 4].includes(touch.slot)) throw new InputActionError('bad-touch-slot', where)
  if (touch.gesture !== undefined && !GESTURES.has(touch.gesture)) throw new InputActionError('bad-touch-gesture', where)
  return Object.freeze({ button: touch.button === true, label: touch.label ?? null, slot: touch.slot ?? null, gesture: touch.gesture ?? 'tap' })
}

function compileAction(name, def) {
  if (!isNonEmptyString(name)) throw new InputActionError('bad-name', String(name))
  const where = `actions.${name}`
  if (!isPlainObject(def)) throw new InputActionError('bad-action', where)
  refuseUnknownFields(where, def, ACTION_FIELDS)
  if (def.keys !== undefined) stringList(`${where}.keys`, def.keys)
  if (def.mouse !== undefined && !MOUSE_BUTTONS.has(def.mouse)) throw new InputActionError('bad-mouse', where)
  if (def.gamepad !== undefined && !GAMEPAD_BUTTONS.has(def.gamepad) && !GAMEPAD_INDEXED.test(def.gamepad)) {
    throw new InputActionError('bad-gamepad', where)
  }
  if (def.modifiers !== undefined) stringList(`${where}.modifiers`, def.modifiers)
  if (def.activeOn !== undefined && !ACTIVE_ON.has(def.activeOn)) throw new InputActionError('bad-active-on', where)
  if (def.active !== undefined && !isNonEmptyString(def.active)) throw new InputActionError('bad-active', where)
  const touch = def.touch === undefined ? null : compileTouch(`${where}.touch`, def.touch)
  const bound = (def.keys?.length ?? 0) + (def.mouse ? 1 : 0) + (def.gamepad ? 1 : 0) + (touch ? 1 : 0)
  if (bound === 0) throw new InputActionError('unbound-action', where)
  return {
    name,
    keys: def.keys ?? [],
    mouse: def.mouse ?? null,
    gamepad: def.gamepad ?? null,
    modifiers: def.modifiers ?? [],
    activeOn: def.activeOn ?? 'keydown',
    touch,
  }
}

function addTo(map, key, name) {
  const names = map.get(key)
  if (names) names.push(name)
  else map.set(key, [name])
}

export function compileInputActions(actions) {
  if (!isPlainObject(actions)) throw new InputActionError('bad-actions', 'actions must be a plain object')
  const compiled = Object.keys(actions).map((name) => compileAction(name, actions[name]))
  const byKey = new Map(), byMouse = new Map(), byGamepad = new Map(), byTouchSlot = new Map()
  for (const action of compiled) {
    for (const code of action.keys) addTo(byKey, code, action.name)
    if (action.mouse) addTo(byMouse, action.mouse, action.name)
    if (action.gamepad) addTo(byGamepad, action.gamepad, action.name)
    if (action.touch?.slot != null) {
      if (byTouchSlot.has(action.touch.slot)) throw new InputActionError('touch-slot-taken', `slot ${action.touch.slot}`)
      byTouchSlot.set(action.touch.slot, action.name)
    }
  }
  return Object.freeze({ actions: compiled, byKey, byMouse, byGamepad, byTouchSlot })
}

export function actionsFor(compiled, source, code) {
  const table = source === 'key' ? compiled.byKey : source === 'mouse' ? compiled.byMouse : compiled.byGamepad
  return table.get(code) ?? []
}

export function touchActionsFor(compiled, slot) {
  const name = compiled.byTouchSlot.get(slot)
  return name === undefined ? [] : [name]
}
