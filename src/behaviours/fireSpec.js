import { FIRE_MAX_WIND_COMPONENT, FIRE_MAX_BYTE } from '../shared/fire/fireWire.js'
import { createWindField } from '../shared/fire/fireWind.js'

export const DEFAULT_FIRE = Object.freeze({
  stepTicks: 30,
  cellsPerFireCell: 2,
  maxActiveCells: 65536,
  softActiveCells: 32768,
  maxTiles: 4096,
  regrowSteps: 1200,
  regrowFuelFraction: 1,
  windowSteps: 4,
  leadTicks: 6,
  checksumEverySteps: 20,
  keyframeSliceMs: 1,
})

export const DEFAULT_FIRE_CLASSES = Object.freeze({
  grass: Object.freeze({ fuel: 9000, burnRate: 3000, igniteHeat: 100, heatOut: 500, spotChance: 0, spotHeat: 0, smoke: 40, damage: 8 }),
  shrub: Object.freeze({ fuel: 24000, burnRate: 3000, igniteHeat: 180, heatOut: 800, spotChance: 40, spotHeat: 400, smoke: 90, damage: 12 }),
  forest: Object.freeze({ fuel: 60000, burnRate: 3000, igniteHeat: 600, heatOut: 1200, spotChance: 120, spotHeat: 700, smoke: 160, damage: 18 }),
})

const U16 = v => Number.isInteger(v) && v >= 0 && v <= 65535
const POSITIVE_U16 = v => Number.isInteger(v) && v >= 1 && v <= 65535
const CLASS_RULES = Object.freeze({
  fuel: { rule: 'an integer from 1 to 65535', test: POSITIVE_U16 },
  burnRate: { rule: 'an integer from 1 to 65535', test: POSITIVE_U16 },
  igniteHeat: { rule: 'an integer from 1 to 65535', test: POSITIVE_U16 },
  heatOut: { rule: 'an integer from 1 to 65535', test: POSITIVE_U16 },
  spotChance: { rule: 'an integer from 0 to 65535', test: U16 },
  spotHeat: { rule: 'an integer from 0 to 65535', test: U16 },
  smoke: { rule: 'an integer from 0 to 255', test: v => Number.isInteger(v) && v >= 0 && v <= 255 },
  damage: { rule: 'an integer from 0 to 65535 (health per second)', test: U16 },
})
const CONFIG_RULES = Object.freeze({
  stepTicks: { rule: 'an integer of at least 2', test: v => Number.isInteger(v) && v >= 2 },
  cellsPerFireCell: { rule: 'one of 1, 2, 4, 8', test: v => v === 1 || v === 2 || v === 4 || v === 8 },
  maxActiveCells: { rule: 'an integer from 1 to 4194304', test: v => Number.isInteger(v) && v >= 1 && v <= 4194304 },
  softActiveCells: { rule: 'an integer from 0 to 4194304', test: v => Number.isInteger(v) && v >= 0 && v <= 4194304 },
  maxTiles: { rule: 'an integer from 1 to 262144', test: v => Number.isInteger(v) && v >= 1 && v <= 262144 },
  regrowSteps: { rule: 'an integer from 1 to 1000000', test: v => Number.isInteger(v) && v >= 1 && v <= 1000000 },
  regrowFuelFraction: { rule: 'a number from 0 to 1', test: v => Number.isFinite(v) && v >= 0 && v <= 1 },
  windowSteps: { rule: 'an integer from 1 to 64', test: v => Number.isInteger(v) && v >= 1 && v <= 64 },
  leadTicks: { rule: 'an integer from 0 to 600', test: v => Number.isInteger(v) && v >= 0 && v <= 600 },
  checksumEverySteps: { rule: 'an integer of at least 1', test: v => Number.isInteger(v) && v >= 1 },
  keyframeSliceMs: { rule: 'a number from 0.05 to 20', test: v => Number.isFinite(v) && v >= 0.05 && v <= 20 },
})

function describeValue(v) { return typeof v === 'number' ? String(v) : JSON.stringify(v) }

function rejectInvalidFields(values, rules, label) {
  for (const [field, { rule, test }] of Object.entries(rules)) {
    if (values[field] === undefined || test(values[field])) continue
    throw new TypeError(`[fire] ${label}.${field} must be ${rule}, got ${describeValue(values[field])}`)
  }
}

function isVec3(v) { return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) }

function resolveWindField(f) {
  if (f === undefined || f === null) return null
  if (typeof f !== 'object' || Array.isArray(f)) throw new TypeError('[fire] spec.windField must be an object')
  const amplitude = f.amplitude ?? 4
  const periodSteps = f.periodSteps ?? 20
  if (!(Number.isInteger(amplitude) && amplitude >= 1 && amplitude <= FIRE_MAX_WIND_COMPONENT)) throw new TypeError(`[fire] spec.windField.amplitude must be an integer from 1 to ${FIRE_MAX_WIND_COMPONENT}, got ${describeValue(amplitude)}`)
  if (!(Number.isInteger(periodSteps) && periodSteps >= 1)) throw new TypeError(`[fire] spec.windField.periodSteps must be an integer of at least 1, got ${describeValue(periodSteps)}`)
  if (f.seed !== undefined && !Number.isInteger(f.seed)) throw new TypeError(`[fire] spec.windField.seed must be an integer, got ${describeValue(f.seed)}`)
  return createWindField({ seed: f.seed ?? 1, amplitude, periodSteps })
}

export function resolveFireSpec(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new TypeError('[fire] spec must be an object')
  const config = { ...DEFAULT_FIRE }
  for (const key of Object.keys(DEFAULT_FIRE)) if (spec[key] !== undefined) config[key] = spec[key]
  rejectInvalidFields(config, CONFIG_RULES, 'spec')
  if (config.softActiveCells > config.maxActiveCells) throw new TypeError(`[fire] spec.softActiveCells (${config.softActiveCells}) must not exceed spec.maxActiveCells (${config.maxActiveCells})`)
  const classDefs = spec.classes === undefined ? DEFAULT_FIRE_CLASSES : spec.classes
  if (classDefs === null || typeof classDefs !== 'object' || Array.isArray(classDefs)) throw new TypeError('[fire] spec.classes must be an object mapping fuel class names to their data')
  const names = Object.keys(classDefs)
  if (names.length === 0 || names.length > 254) throw new TypeError('[fire] spec.classes must name between 1 and 254 fuel classes')
  const classes = [{}]
  for (const name of names) {
    const def = classDefs[name]
    if (def === null || typeof def !== 'object') throw new TypeError(`[fire] spec.classes.${name} must be an object`)
    for (const field of ['fuel', 'burnRate', 'igniteHeat', 'heatOut']) if (def[field] === undefined) throw new TypeError(`[fire] spec.classes.${name}.${field} is required`)
    rejectInvalidFields(def, CLASS_RULES, `spec.classes.${name}`)
    const burnSteps = Math.ceil(def.fuel / def.burnRate)
    if (config.regrowSteps <= burnSteps) throw new TypeError(`[fire] spec.regrowSteps (${config.regrowSteps}) must exceed the ${burnSteps} steps spec.classes.${name} burns for`)
    classes.push({ fuel: def.fuel, burnRate: def.burnRate, igniteHeat: def.igniteHeat, heatOut: def.heatOut, spotChance: def.spotChance ?? 0, spotHeat: def.spotHeat ?? 0, smoke: def.smoke ?? 0, damage: def.damage ?? 0 })
  }
  const classIndex = new Map(names.map((name, i) => [name, i + 1]))
  const fuel = spec.fuel ?? {}
  if (fuel === null || typeof fuel !== 'object') throw new TypeError('[fire] spec.fuel must be an object')
  if (fuel.default !== undefined && !classIndex.has(fuel.default)) throw new TypeError(`[fire] spec.fuel.default must name a class in spec.classes, got ${describeValue(fuel.default)}`)
  if (fuel.classAt !== undefined && typeof fuel.classAt !== 'function') throw new TypeError('[fire] spec.fuel.classAt must be a function (face, I, J) -> class name or null')
  const defaultClass = classIndex.get(fuel.default ?? names[0])
  const classAt = fuel.classAt
  const fuelClassAt = classAt
    ? (face, I, J) => { const name = classAt(face, I, J); return name == null ? 0 : (classIndex.get(name) ?? 0) }
    : () => defaultClass
  if (spec.seed !== undefined && !Number.isInteger(spec.seed)) throw new TypeError(`[fire] spec.seed must be an integer, got ${describeValue(spec.seed)}`)
  if (spec.wind !== undefined && !(isVec3(spec.wind) && spec.wind.every(c => Number.isInteger(c) && Math.abs(c) <= FIRE_MAX_WIND_COMPONENT))) throw new TypeError(`[fire] spec.wind must be [x, y, z] integers within +-${FIRE_MAX_WIND_COMPONENT}`)
  for (const field of ['moisture', 'rain']) if (spec[field] !== undefined && !(Number.isInteger(spec[field]) && spec[field] >= 0 && spec[field] <= FIRE_MAX_BYTE)) throw new TypeError(`[fire] spec.${field} must be an integer from 0 to ${FIRE_MAX_BYTE}, got ${describeValue(spec[field])}`)
  if (spec.radius !== undefined && !(Number.isFinite(spec.radius) && spec.radius > 0)) throw new TypeError(`[fire] spec.radius must be a positive planet radius in metres, got ${describeValue(spec.radius)}`)
  if (spec.rewind !== undefined && typeof spec.rewind !== 'boolean') throw new TypeError(`[fire] spec.rewind must be a boolean, got ${describeValue(spec.rewind)}`)
  if (spec.role !== undefined && spec.role !== 'authority' && spec.role !== 'mirror') throw new TypeError(`[fire] spec.role must be 'authority' or 'mirror', got ${describeValue(spec.role)}`)
  const gameplay = resolveGameplay(spec.gameplay)
  const weather = resolveWeather(spec.weather)
  const firebreaks = resolveFirebreaks(spec.firebreaks)
  const windField = resolveWindField(spec.windField)
  for (const k of ['onIgnite', 'onExtinguish']) if (spec[k] !== undefined && typeof spec[k] !== 'function') throw new TypeError(`[fire] spec.${k} must be a function`)
  return { config, classes, names, fuelClassAt, seed: spec.seed ?? 1, wind: spec.wind ?? [0, 0, 0], windField, moisture: spec.moisture ?? 0, rain: spec.rain ?? 0, radius: spec.radius ?? null, role: spec.role ?? 'authority', gameplay, weather, firebreaks, rewind: spec.rewind ?? (spec.role === 'mirror') }
}

export { describeValue, isVec3 }

const GAMEPLAY_RULES = Object.freeze({
  damageEveryTicks: { rule: 'an integer from 1 to 600', test: v => Number.isInteger(v) && v >= 1 && v <= 600 },
  burnStatusSeconds: { rule: 'a number from 0 to 120', test: v => Number.isFinite(v) && v >= 0 && v <= 120 },
  statusDamagePerSec: { rule: 'a number from 0 to 1000', test: v => Number.isFinite(v) && v >= 0 && v <= 1000 },
  smokeBlockDepth: { rule: 'a positive number', test: v => Number.isFinite(v) && v > 0 },
  smokeHeightM: { rule: 'a positive number', test: v => Number.isFinite(v) && v > 0 },
  eyeHeightM: { rule: 'a number from 0 to 10', test: v => Number.isFinite(v) && v >= 0 && v <= 10 },
  explosionImpulse: { rule: 'a number of at least 0', test: v => Number.isFinite(v) && v >= 0 },
})
export const DEFAULT_FIRE_GAMEPLAY = Object.freeze({ damageEveryTicks: 15, burnStatusSeconds: 4, statusDamagePerSec: 5, smokeBlockDepth: 1, smokeHeightM: 30, eyeHeightM: 1.6, explosionImpulse: 12 })

function resolveGameplay(g) {
  if (g === undefined) return null
  if (g === null || typeof g !== 'object' || Array.isArray(g)) throw new TypeError('[fire] spec.gameplay must be an object')
  const out = { ...DEFAULT_FIRE_GAMEPLAY }
  for (const k of Object.keys(DEFAULT_FIRE_GAMEPLAY)) if (g[k] !== undefined) out[k] = g[k]
  rejectInvalidFields(out, GAMEPLAY_RULES, 'spec.gameplay')
  if (g.targets !== undefined && typeof g.targets !== 'function') throw new TypeError('[fire] spec.gameplay.targets must be a function (appCtx) -> [{ id, position, holder, entity? }]')
  out.targets = g.targets ?? null
  return out
}

const WEATHER_RULES = Object.freeze({
  rainPerIntensity: { rule: 'an integer from 0 to 255', test: v => Number.isInteger(v) && v >= 0 && v <= 255 },
  snowRainFraction: { rule: 'a number from 0 to 1', test: v => Number.isFinite(v) && v >= 0 && v <= 1 },
  wetPerStep: { rule: 'an integer from 0 to 255', test: v => Number.isInteger(v) && v >= 0 && v <= 255 },
  dryPerStep: { rule: 'an integer from 0 to 255', test: v => Number.isInteger(v) && v >= 0 && v <= 255 },
  maxMoisture: { rule: 'an integer from 0 to 255', test: v => Number.isInteger(v) && v >= 0 && v <= 255 },
  hysteresis: { rule: 'an integer from 1 to 255', test: v => Number.isInteger(v) && v >= 1 && v <= 255 },
})
export const DEFAULT_FIRE_WEATHER = Object.freeze({ rainPerIntensity: 200, snowRainFraction: 0.25, wetPerStep: 8, dryPerStep: 1, maxMoisture: 200, hysteresis: 8 })

function resolveWeather(w) {
  if (w === undefined) return null
  if (w === null || typeof w !== 'object' || Array.isArray(w)) throw new TypeError('[fire] spec.weather must be an object')
  const out = { ...DEFAULT_FIRE_WEATHER }
  for (const k of Object.keys(DEFAULT_FIRE_WEATHER)) if (w[k] !== undefined) out[k] = w[k]
  rejectInvalidFields(out, WEATHER_RULES, 'spec.weather')
  if (w.source !== undefined && typeof w.source !== 'function') throw new TypeError('[fire] spec.weather.source must be a function () -> { type, intensity } | null')
  out.source = w.source ?? null
  return out
}

function resolveFirebreaks(b) {
  if (b === undefined) return null
  if (b === null || typeof b !== 'object' || Array.isArray(b)) throw new TypeError('[fire] spec.firebreaks must be an object')
  const kinds = b.kinds ?? ['road', 'river']
  if (!Array.isArray(kinds) || !kinds.every(k => typeof k === 'string')) throw new TypeError('[fire] spec.firebreaks.kinds must be an array of terrain kind names')
  const cleared = b.cleared ?? []
  if (!Array.isArray(cleared) || !cleared.every(c => c && Array.isArray(c.center) && c.center.length === 2 && c.center.every(Number.isFinite) && Number.isFinite(c.radiusM) && c.radiusM > 0)) throw new TypeError('[fire] spec.firebreaks.cleared must be [{ center: [x, z], radiusM }]')
  for (const k of ['rock', 'heightAt', 'seaLevelAt', 'kindAt']) if (b[k] !== undefined && typeof b[k] !== 'function') throw new TypeError(`[fire] spec.firebreaks.${k} must be a function`)
  return { water: b.water !== false, kinds: new Set(kinds), cleared: cleared.map(c => ({ center: [...c.center], radiusM: c.radiusM })), rock: b.rock ?? null, heightAt: b.heightAt ?? null, seaLevelAt: b.seaLevelAt ?? null, kindAt: b.kindAt ?? null }
}
