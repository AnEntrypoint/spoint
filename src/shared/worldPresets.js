import tps from '../presets/tps.js'
import arena from '../presets/arena.js'
import planet from '../presets/planet.js'
import platformer from '../presets/platformer.js'
import rts from '../presets/rts.js'

export let WORLD_PRESETS = Object.freeze({ tps, arena, planet, platformer, rts })

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

function mergeSlice(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? structuredClone(base) : over
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(over)) out[k] = mergeSlice(base[k], v)
  return out
}

function mergeEntities(base = [], over = []) {
  const byId = new Map(over.filter(e => e?.id !== undefined).map(e => [e.id, e]))
  const kept = base.filter(e => !byId.has(e?.id)).map(e => structuredClone(e))
  return [...kept, ...over]
}

function mergeWorld(base, over) {
  const out = mergeSlice(base, over)
  if (base.entities || over.entities) out.entities = mergeEntities(base.entities, over.entities)
  return out
}

export function expandWorldPresets(worldDef) {
  if (!isPlainObject(worldDef) || worldDef.presets === undefined) return worldDef
  const { presets, ...own } = worldDef
  if (!Array.isArray(presets)) throw new TypeError(`world presets must be an array of preset names, got ${JSON.stringify(presets)}`)
  if (new Set(presets).size !== presets.length) throw new TypeError(`world presets must not repeat a name, got ${JSON.stringify(presets)}`)
  let merged = {}
  for (const name of presets) {
    const preset = Object.hasOwn(WORLD_PRESETS, name) ? WORLD_PRESETS[name] : null
    if (!preset) throw new TypeError(`unknown world preset ${JSON.stringify(name)} (known: ${Object.keys(WORLD_PRESETS).join(', ')})`)
    const params = own[name]
    if (typeof preset === 'function') {
      if (params !== undefined && !isPlainObject(params)) throw new TypeError(`world preset ${name} parameters must be an object, got ${JSON.stringify(params)}`)
      merged = mergeWorld(merged, preset(params ?? {}))
      delete own[name]
    } else {
      if (params !== undefined) throw new TypeError(`world preset ${name} takes no parameters, but the world sets a ${name} key`)
      merged = mergeWorld(merged, preset)
    }
  }
  return mergeWorld(merged, own)
}

// --- hot swap -----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapWorldPresets = (next) => {
  expandWorldPresets = next.expandWorldPresets
  WORLD_PRESETS = next.WORLD_PRESETS
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapWorldPresets)
