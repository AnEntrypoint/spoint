export const DEFAULT_KEY_BINDINGS = Object.freeze({
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  jump: ['Space'],
  interact: ['KeyE'],
})

export const DEFAULT_PAD_BINDINGS = Object.freeze({
  jump: [0],
  interact: [2],
})

export const KEY_BINDINGS_STORAGE_KEY = 'spoint.keybindings'

const PAD_BUTTON_MAX = 31

export class KeyBindingError extends Error {
  constructor(reasonCode, detail) {
    super(`[keybindings] ${reasonCode}: ${detail}`)
    this.name = 'KeyBindingError'
    this.reasonCode = reasonCode
  }
}

function cloneTable(table) {
  const out = {}
  for (const action of Object.keys(table)) out[action] = table[action].slice()
  return out
}

function checkAction(table, action) {
  if (!Object.prototype.hasOwnProperty.call(table, action)) {
    throw new KeyBindingError('unknown-action', String(action))
  }
}

function checkKeyCodes(codes) {
  if (!Array.isArray(codes) || codes.length === 0) throw new KeyBindingError('bad-keys', 'need a non-empty array')
  for (const code of codes) {
    if (typeof code !== 'string' || code === '') throw new KeyBindingError('bad-keys', String(code))
  }
}

function checkPadButtons(buttons) {
  if (!Array.isArray(buttons) || buttons.length === 0) throw new KeyBindingError('bad-pad', 'need a non-empty array')
  for (const b of buttons) {
    if (!Number.isInteger(b) || b < 0 || b > PAD_BUTTON_MAX) throw new KeyBindingError('bad-pad', String(b))
  }
}

function parseStored(raw, defaults) {
  const parsed = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new KeyBindingError('bad-record', 'not an object')
  const keys = cloneTable(defaults.keys)
  const pad = cloneTable(defaults.pad)
  for (const action of Object.keys(parsed.keys ?? {})) {
    checkAction(keys, action)
    checkKeyCodes(parsed.keys[action])
    keys[action] = parsed.keys[action].slice()
  }
  for (const action of Object.keys(parsed.pad ?? {})) {
    checkAction(pad, action)
    checkPadButtons(parsed.pad[action])
    pad[action] = parsed.pad[action].slice()
  }
  return { keys, pad }
}

export function createKeyBindings({ storage = null, defaults = { keys: DEFAULT_KEY_BINDINGS, pad: DEFAULT_PAD_BINDINGS } } = {}) {
  const base = { keys: cloneTable(defaults.keys), pad: cloneTable(defaults.pad) }
  let state = { keys: cloneTable(base.keys), pad: cloneTable(base.pad) }
  const raw = storage ? storage.getItem(KEY_BINDINGS_STORAGE_KEY) : null
  if (raw) state = parseStored(raw, base)

  function conflictOf(table, action, values) {
    for (const other of Object.keys(table)) {
      if (other === action) continue
      if (table[other].some((v) => values.includes(v))) return other
    }
    return null
  }

  return {
    keysFor(action) {
      checkAction(state.keys, action)
      return state.keys[action].slice()
    },
    padFor(action) {
      checkAction(state.pad, action)
      return state.pad[action].slice()
    },
    actionForKey(code) {
      for (const action of Object.keys(state.keys)) if (state.keys[action].includes(code)) return action
      return null
    },
    actionForPad(button) {
      for (const action of Object.keys(state.pad)) if (state.pad[action].includes(button)) return action
      return null
    },
    rebindKeys(action, codes) {
      checkAction(state.keys, action)
      checkKeyCodes(codes)
      const clash = conflictOf(state.keys, action, codes)
      if (clash) throw new KeyBindingError('conflict', `${codes.join(',')} already bound to ${clash}`)
      state.keys[action] = codes.slice()
      return this.keysFor(action)
    },
    rebindPad(action, buttons) {
      checkAction(state.pad, action)
      checkPadButtons(buttons)
      const clash = conflictOf(state.pad, action, buttons)
      if (clash) throw new KeyBindingError('conflict', `${buttons.join(',')} already bound to ${clash}`)
      state.pad[action] = buttons.slice()
      return this.padFor(action)
    },
    resetAll() {
      state = { keys: cloneTable(base.keys), pad: cloneTable(base.pad) }
    },
    snapshot() {
      return { keys: cloneTable(state.keys), pad: cloneTable(state.pad) }
    },
    save() {
      if (!storage) return false
      storage.setItem(KEY_BINDINGS_STORAGE_KEY, JSON.stringify(state))
      return true
    },
  }
}
