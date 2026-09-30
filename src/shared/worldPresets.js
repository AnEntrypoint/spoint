import tps from '../presets/tps.js'

export const WORLD_PRESETS = Object.freeze({ tps })

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

function mergeSlice(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? structuredClone(base) : over
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(over)) out[k] = mergeSlice(base[k], v)
  return out
}

export function expandWorldPresets(worldDef) {
  if (!isPlainObject(worldDef) || worldDef.presets === undefined) return worldDef
  const { presets, ...own } = worldDef
  if (!Array.isArray(presets)) throw new TypeError(`world presets must be an array of preset names, got ${JSON.stringify(presets)}`)
  let merged = {}
  for (const name of presets) {
    const preset = Object.hasOwn(WORLD_PRESETS, name) ? WORLD_PRESETS[name] : null
    if (!preset) throw new TypeError(`unknown world preset ${JSON.stringify(name)} (known: ${Object.keys(WORLD_PRESETS).join(', ')})`)
    merged = mergeSlice(merged, preset)
  }
  return mergeSlice(merged, own)
}
