import { latticeFor } from '../terrain/PlacementChart.js'
import { VEG } from '../terrain/VegPlacement.js'
import { createFireLattice } from '../shared/fire/fireLattice.js'
import { createFireKernel, FIRE_EVENT, FIRE_STATE } from '../shared/fire/fireKernel.js'
import { createFireTimeline } from '../shared/fire/fireTimeline.js'
import { encodeFireEvent, decodeFireEvent, FIRE_WIRE_TYPE, FIRE_SEQ_RANGE, FIRE_MAX_EXTINGUISH_RADIUS_CELLS, FIRE_MAX_WIND_COMPONENT, FIRE_MAX_BYTE } from '../shared/fire/fireWire.js'

export { FIRE_STATE }

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
})

export const DEFAULT_FIRE_CLASSES = Object.freeze({
  grass: Object.freeze({ fuel: 9000, burnRate: 3000, igniteHeat: 100, heatOut: 500, spotChance: 0, spotHeat: 0 }),
  shrub: Object.freeze({ fuel: 24000, burnRate: 3000, igniteHeat: 180, heatOut: 800, spotChance: 40, spotHeat: 400 }),
  forest: Object.freeze({ fuel: 60000, burnRate: 3000, igniteHeat: 600, heatOut: 1200, spotChance: 120, spotHeat: 700 }),
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
})

function describeValue(v) { return typeof v === 'number' ? String(v) : JSON.stringify(v) }

function rejectInvalidFields(values, rules, label) {
  for (const [field, { rule, test }] of Object.entries(rules)) {
    if (values[field] === undefined || test(values[field])) continue
    throw new TypeError(`[fire] ${label}.${field} must be ${rule}, got ${describeValue(values[field])}`)
  }
}

function isVec3(v) { return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) }

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
    classes.push({ fuel: def.fuel, burnRate: def.burnRate, igniteHeat: def.igniteHeat, heatOut: def.heatOut, spotChance: def.spotChance ?? 0, spotHeat: def.spotHeat ?? 0 })
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
  for (const k of ['onIgnite', 'onExtinguish']) if (spec[k] !== undefined && typeof spec[k] !== 'function') throw new TypeError(`[fire] spec.${k} must be a function`)
  return { config, classes, names, fuelClassAt, seed: spec.seed ?? 1, wind: spec.wind ?? [0, 0, 0], moisture: spec.moisture ?? 0, rain: spec.rain ?? 0, radius: spec.radius ?? null, role: spec.role ?? 'authority', rewind: spec.rewind ?? (spec.role === 'mirror') }
}

export function defineFire(spec = {}, appCtx = null, frameOf = null) {
  if (!appCtx || !appCtx.time) throw new TypeError('[fire] appCtx is required')
  const resolved = resolveFireSpec(spec)
  const { config } = resolved
  let world = null
  let outbox = []
  let lastChecksumStep = 0
  const cellScratch = { face: 0, I: 0, J: 0 }

  function planetFrame() { return typeof frameOf === 'function' ? frameOf() : frameOf }

  function ensureWorld() {
    if (world) return world
    const frame = planetFrame()
    const radius = resolved.radius ?? frame?.radius
    if (!(radius > 0)) throw new TypeError('[fire] needs a planet radius: define the terrain first, or pass spec.radius')
    const lattice = createFireLattice(latticeFor({ radius }, VEG), config.cellsPerFireCell)
    const kernel = createFireKernel({
      lattice, fuelClassAt: resolved.fuelClassAt, classes: resolved.classes, seed: resolved.seed, stepTicks: config.stepTicks,
      maxTiles: config.maxTiles, softActiveCells: config.softActiveCells, maxActiveCells: config.maxActiveCells,
      regrowSteps: config.regrowSteps, regrowFuelFraction: config.regrowFuelFraction,
    })
    const timeline = createFireTimeline({ kernel, windowSteps: config.windowSteps, keepSnapshots: resolved.rewind })
    world = { lattice, kernel, timeline }
    const startTick = appCtx.time.tick
    timeline.advanceTo(startTick)
    if (resolved.role === 'authority') {
      if (resolved.wind.some(c => c !== 0)) emit({ kind: FIRE_EVENT.WIND, wx: resolved.wind[0], wy: resolved.wind[1], wz: resolved.wind[2] })
      if (resolved.moisture !== 0) emit({ kind: FIRE_EVENT.MOISTURE, value: resolved.moisture })
      if (resolved.rain !== 0) emit({ kind: FIRE_EVENT.RAIN, value: resolved.rain })
    }
    return world
  }

  function emit(partial) {
    if (resolved.role !== 'authority') throw new TypeError("[fire] a spec.role 'mirror' only applies events received from the authority; it cannot originate them")
    const { timeline, lattice } = world
    const tick = Math.max(appCtx.time.tick, timeline.tick) + config.leadTicks
    let seq = 0
    for (const e of timeline.log) if (e.tick === tick) seq++
    if (seq >= FIRE_SEQ_RANGE) throw new RangeError(`[fire] more than ${FIRE_SEQ_RANGE} fire events scheduled for tick ${tick}`)
    const ev = { ...partial, tick, seq, id: tick * FIRE_SEQ_RANGE + seq }
    timeline.submit(ev)
    outbox.push(encodeFireEvent(lattice, ev))
    return ev
  }

  function cellOfPosition(position) {
    const frame = planetFrame()
    if (!frame || typeof frame.localToDir !== 'function') throw new TypeError('[fire] positions need the terrain planet frame; use igniteCell(face, I, J) before terrain is ready')
    if (!isVec3(position)) throw new TypeError(`[fire] position must be [x, y, z] finite numbers, got ${describeValue(position)}`)
    const d = frame.localToDir(position[0], position[2], position[1])
    return ensureWorld().lattice.cellOfDir(d[0], d[1], d[2], cellScratch)
  }

  const fire = {
    get world() { return ensureWorld() },
    get activeCount() { return world ? world.kernel.activeCount : 0 },
    get stats() { return world ? world.kernel.stats : null },
    get simTick() { return world ? world.timeline.tick : 0 },
    get names() { return resolved.names },

    igniteCell(face, I, J, source = 0) {
      const { lattice } = ensureWorld()
      if (!Number.isInteger(face) || face < 0 || face >= lattice.faceCount || !Number.isInteger(I) || !Number.isInteger(J) || I < 0 || J < 0 || I >= lattice.cellsPerFace || J >= lattice.cellsPerFace) throw new RangeError(`[fire] igniteCell(${face}, ${I}, ${J}) is outside the lattice`)
      if (!Number.isInteger(source) || source < 0 || source > FIRE_MAX_BYTE) throw new RangeError(`[fire] ignition source must be an integer from 0 to ${FIRE_MAX_BYTE}, got ${describeValue(source)}`)
      const ev = emit({ kind: FIRE_EVENT.IGNITE, face, I, J, source })
      if (typeof spec.onIgnite === 'function') spec.onIgnite(appCtx, ev)
      return ev.id
    },

    ignite(position, source = 0) {
      const c = cellOfPosition(position)
      return fire.igniteCell(c.face, c.I, c.J, source)
    },

    extinguishCell(face, I, J, radiusCells = 1) {
      const { lattice } = ensureWorld()
      if (!Number.isInteger(radiusCells) || radiusCells < 0 || radiusCells > FIRE_MAX_EXTINGUISH_RADIUS_CELLS) throw new RangeError(`[fire] extinguish radius must be 0..${FIRE_MAX_EXTINGUISH_RADIUS_CELLS} cells, got ${describeValue(radiusCells)}`)
      if (!Number.isInteger(face) || face < 0 || face >= lattice.faceCount || !Number.isInteger(I) || !Number.isInteger(J) || I < 0 || J < 0 || I >= lattice.cellsPerFace || J >= lattice.cellsPerFace) throw new RangeError(`[fire] extinguishCell(${face}, ${I}, ${J}) is outside the lattice`)
      const ev = emit({ kind: FIRE_EVENT.EXTINGUISH, face, I, J, radius: radiusCells })
      if (typeof spec.onExtinguish === 'function') spec.onExtinguish(appCtx, ev)
      return ev.id
    },

    extinguish(position, radiusMetres = 8) {
      if (!Number.isFinite(radiusMetres) || radiusMetres < 0) throw new RangeError(`[fire] extinguish radius must be a non-negative number of metres, got ${describeValue(radiusMetres)}`)
      const c = cellOfPosition(position)
      return fire.extinguishCell(c.face, c.I, c.J, Math.min(FIRE_MAX_EXTINGUISH_RADIUS_CELLS, Math.ceil(radiusMetres / ensureWorld().lattice.cellM)))
    },

    setWind(vector) {
      if (!(isVec3(vector) && vector.every(c => Number.isInteger(c) && Math.abs(c) <= FIRE_MAX_WIND_COMPONENT))) throw new TypeError(`[fire] wind must be [x, y, z] integers within +-${FIRE_MAX_WIND_COMPONENT}`)
      ensureWorld()
      return emit({ kind: FIRE_EVENT.WIND, wx: vector[0], wy: vector[1], wz: vector[2] }).id
    },

    setMoisture(value) {
      if (!Number.isInteger(value) || value < 0 || value > FIRE_MAX_BYTE) throw new RangeError(`[fire] moisture must be an integer from 0 to ${FIRE_MAX_BYTE}, got ${describeValue(value)}`)
      ensureWorld()
      return emit({ kind: FIRE_EVENT.MOISTURE, value }).id
    },

    setRain(value) {
      if (!Number.isInteger(value) || value < 0 || value > FIRE_MAX_BYTE) throw new RangeError(`[fire] rain must be an integer from 0 to ${FIRE_MAX_BYTE}, got ${describeValue(value)}`)
      ensureWorld()
      return emit({ kind: FIRE_EVENT.RAIN, value }).id
    },

    stateAt(position) {
      if (!world || (world.kernel.activeCount === 0 && world.kernel.scarCount === 0)) return FIRE_STATE.UNBURNT
      const w = world
      const c = cellOfPosition(position)
      return w.kernel.stateCodeAt(c.face, c.I, c.J)
    },

    applyRemote(payload) {
      if (!payload || payload.type !== FIRE_WIRE_TYPE) throw new TypeError(`[fire] remote payload must be a { type: '${FIRE_WIRE_TYPE}' } message`)
      const { lattice, timeline } = ensureWorld()
      let rewound = 0
      if (payload.c !== undefined) {
        if (!Array.isArray(payload.c) || payload.c.length !== 2 || !Number.isSafeInteger(payload.c[0]) || !Number.isSafeInteger(payload.c[1])) throw new TypeError(`[fire] malformed checksum row ${JSON.stringify(payload.c)}`)
        return { ok: true, checksum: { tick: payload.c[0], hash: payload.c[1] } }
      }
      for (const row of payload.e ?? []) {
        const r = timeline.submit(decodeFireEvent(lattice, row))
        if (r.rewound) rewound++
        if (!r.ok) return { ok: false, reason: r.reason }
      }
      return { ok: true, rewound }
    },

    checksum() { return ensureWorld().timeline.checksum() },

    rewindTo(tick) { return ensureWorld().timeline.rewindTo(tick) },

    tick(dt) {
      if (!world) return
      const { kernel, timeline } = world
      timeline.advanceTo(appCtx.time.tick)
      if (resolved.role !== 'authority') return
      if (outbox.length > 0) {
        const rows = outbox
        outbox = []
        appCtx.players.broadcast({ type: FIRE_WIRE_TYPE, e: rows })
      }
      if (kernel.stepIndex - lastChecksumStep >= config.checksumEverySteps && kernel.activeCount > 0) {
        lastChecksumStep = kernel.stepIndex
        appCtx.players.broadcast({ type: FIRE_WIRE_TYPE, c: [timeline.tick, timeline.checksum()] })
      }
    },

    destroy() { world = null; outbox = [] },
  }
  return fire
}

export default defineFire
