import { latticeFor } from '../terrain/PlacementChart.js'
import { VEG } from '../terrain/VegPlacement.js'
import { createFireLattice } from '../shared/fire/fireLattice.js'
import { createFireKernel, FIRE_EVENT, FIRE_STATE } from '../shared/fire/fireKernel.js'
import { createFireTimeline } from '../shared/fire/fireTimeline.js'
import { encodeFireEvent, decodeFireEvent, FIRE_WIRE_TYPE, FIRE_SEQ_RANGE, FIRE_MAX_ROWS_PER_MESSAGE, FIRE_MAX_EXTINGUISH_RADIUS_CELLS, FIRE_MAX_IGNITE_RADIUS_CELLS, FIRE_MAX_WIND_COMPONENT, FIRE_MAX_BYTE } from '../shared/fire/fireWire.js'
import { resolveFireSpec, describeValue, isVec3 } from './fireSpec.js'
import { createFirebreakFuel } from './fireTerrain.js'
import { createFireGameplay } from './fireGameplay.js'
import { createFireWeather } from './fireWeather.js'

export { FIRE_STATE }
export { DEFAULT_FIRE, DEFAULT_FIRE_CLASSES, DEFAULT_FIRE_GAMEPLAY, DEFAULT_FIRE_WEATHER, resolveFireSpec } from './fireSpec.js'

export function defineFire(spec = {}, appCtx = null, frameOf = null, weatherOf = null) {
  if (!appCtx || !appCtx.time) throw new TypeError('[fire] appCtx is required')
  const resolved = resolveFireSpec(spec)
  const { config } = resolved
  let world = null
  let outbox = []
  let lastChecksumStep = 0
  const cellScratch = { face: 0, I: 0, J: 0 }
  const weatherEmits = { rain: -1, moisture: -1 }
  const weather = resolved.weather
    ? createFireWeather({ config: resolved.weather, readWeather: resolved.weather.source ?? weatherOf ?? (() => null), stepTicks: config.stepTicks })
    : null

  function planetFrame() { return typeof frameOf === 'function' ? frameOf() : frameOf }

  function terrainAccessors() {
    const bind = name => (typeof appCtx[name] === 'function' ? (x, z) => appCtx[name](x, z) : null)
    return { heightAt: bind('terrainHeightAt'), seaLevelAt: bind('seaLevelAt'), kindAt: bind('terrainKindAt') }
  }

  function ensureWorld() {
    if (world) return world
    const frame = planetFrame()
    const radius = resolved.radius ?? frame?.radius
    if (!(radius > 0)) throw new TypeError('[fire] needs a planet radius: define the terrain first, or pass spec.radius')
    const lattice = createFireLattice(latticeFor({ radius }, VEG), config.cellsPerFireCell)
    const fuelClassAt = resolved.firebreaks && frame
      ? createFirebreakFuel({ baseClassAt: resolved.fuelClassAt, breaks: resolved.firebreaks, frame, lattice, terrain: terrainAccessors() })
      : resolved.fuelClassAt
    const kernel = createFireKernel({
      lattice, fuelClassAt, classes: resolved.classes, seed: resolved.seed, stepTicks: config.stepTicks,
      maxTiles: config.maxTiles, softActiveCells: config.softActiveCells, maxActiveCells: config.maxActiveCells,
      regrowSteps: config.regrowSteps, regrowFuelFraction: config.regrowFuelFraction,
    })
    const timeline = createFireTimeline({ kernel, windowSteps: config.windowSteps, keepSnapshots: resolved.rewind })
    world = { lattice, kernel, timeline }
    timeline.startAt(appCtx.time.tick)
    if (resolved.role === 'authority') {
      const rain = weather ? weather.rain : resolved.rain, moisture = weather ? weather.moisture : resolved.moisture
      if (resolved.wind.some(c => c !== 0)) emit({ kind: FIRE_EVENT.WIND, wx: resolved.wind[0], wy: resolved.wind[1], wz: resolved.wind[2] })
      if (moisture !== 0) emit({ kind: FIRE_EVENT.MOISTURE, value: moisture })
      if (rain !== 0) emit({ kind: FIRE_EVENT.RAIN, value: rain })
      if (weather) weather.markEmitted(rain, moisture)
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

  function checkCell(lattice, face, I, J, what) {
    if (!Number.isInteger(face) || face < 0 || face >= lattice.faceCount || !Number.isInteger(I) || !Number.isInteger(J) || I < 0 || J < 0 || I >= lattice.cellsPerFace || J >= lattice.cellsPerFace) throw new RangeError(`[fire] ${what}(${face}, ${I}, ${J}) is outside the lattice`)
  }

  function checkByte(value, what) {
    if (!Number.isInteger(value) || value < 0 || value > FIRE_MAX_BYTE) throw new RangeError(`[fire] ${what} must be an integer from 0 to ${FIRE_MAX_BYTE}, got ${describeValue(value)}`)
  }

  function syncWeather(simTick) {
    if (!weather || resolved.role !== 'authority') return
    const emits = weather.step(simTick, weatherEmits)
    if (emits === null || !world) return
    if (emits.rain >= 0) emit({ kind: FIRE_EVENT.RAIN, value: emits.rain })
    if (emits.moisture >= 0) emit({ kind: FIRE_EVENT.MOISTURE, value: emits.moisture })
    weather.markEmitted(emits.rain >= 0 ? emits.rain : weather.emittedRain, emits.moisture >= 0 ? emits.moisture : weather.emittedMoisture)
  }

  const gameplay = resolved.gameplay ? createFireGameplay({ appCtx, gameplay: resolved.gameplay, getWorld: () => world, cellOfPosition, frameOf: planetFrame }) : null

  const fire = {
    get world() { return ensureWorld() },
    get activeCount() { return world ? world.kernel.activeCount : 0 },
    get stats() { return world ? world.kernel.stats : null },
    get simTick() { return world ? world.timeline.tick : 0 },
    get names() { return resolved.names },
    get weather() { return weather },
    get gameplay() { return gameplay },

    igniteCell(face, I, J, source = 0) {
      const { lattice } = ensureWorld()
      checkCell(lattice, face, I, J, 'igniteCell')
      checkByte(source, 'ignition source')
      const ev = emit({ kind: FIRE_EVENT.IGNITE, face, I, J, source })
      if (typeof spec.onIgnite === 'function') spec.onIgnite(appCtx, ev)
      return ev.id
    },

    ignite(position, source = 0) {
      const c = cellOfPosition(position)
      return fire.igniteCell(c.face, c.I, c.J, source)
    },

    igniteArea(position, radiusM, source = 0) {
      if (!Number.isFinite(radiusM) || radiusM < 0) throw new RangeError(`[fire] igniteArea radius must be a non-negative number of metres, got ${describeValue(radiusM)}`)
      checkByte(source, 'ignition source')
      const c = cellOfPosition(position)
      const { lattice } = world
      const ev = emit({ kind: FIRE_EVENT.IGNITE_AREA, face: c.face, I: c.I, J: c.J, radius: Math.min(FIRE_MAX_IGNITE_RADIUS_CELLS, Math.ceil(radiusM / lattice.cellM)), source })
      if (typeof spec.onIgnite === 'function') spec.onIgnite(appCtx, ev)
      return ev.id
    },

    extinguishCell(face, I, J, radiusCells = 1) {
      const { lattice } = ensureWorld()
      if (!Number.isInteger(radiusCells) || radiusCells < 0 || radiusCells > FIRE_MAX_EXTINGUISH_RADIUS_CELLS) throw new RangeError(`[fire] extinguish radius must be 0..${FIRE_MAX_EXTINGUISH_RADIUS_CELLS} cells, got ${describeValue(radiusCells)}`)
      checkCell(lattice, face, I, J, 'extinguishCell')
      const ev = emit({ kind: FIRE_EVENT.EXTINGUISH, face, I, J, radius: radiusCells })
      if (typeof spec.onExtinguish === 'function') spec.onExtinguish(appCtx, ev)
      return ev.id
    },

    extinguish(position, radiusMetres = 8) {
      if (!Number.isFinite(radiusMetres) || radiusMetres < 0) throw new RangeError(`[fire] extinguish radius must be a non-negative number of metres, got ${describeValue(radiusMetres)}`)
      const c = cellOfPosition(position)
      return fire.extinguishCell(c.face, c.I, c.J, Math.min(FIRE_MAX_EXTINGUISH_RADIUS_CELLS, Math.ceil(radiusMetres / world.lattice.cellM)))
    },

    explode(position, { radiusM = 10, igniteRadiusM = radiusM * 0.5, damage = 60, source = 0 } = {}) {
      if (!gameplay) throw new TypeError('[fire] explode needs spec.gameplay')
      if (!Number.isFinite(radiusM) || radiusM <= 0 || !Number.isFinite(damage) || damage < 0) throw new RangeError('[fire] explode needs a positive radiusM and a non-negative damage')
      const id = fire.igniteArea(position, igniteRadiusM, source)
      gameplay.blast(position, radiusM, damage)
      return id
    },

    incendiaryHit({ radiusM = 0 } = {}) {
      return (ctx, hit) => { if (radiusM > 0) fire.igniteArea(hit.position, radiusM, hit.shooterId & FIRE_MAX_BYTE); else fire.ignite(hit.position, hit.shooterId & FIRE_MAX_BYTE) }
    },

    setWind(vector) {
      if (!(isVec3(vector) && vector.every(c => Number.isInteger(c) && Math.abs(c) <= FIRE_MAX_WIND_COMPONENT))) throw new TypeError(`[fire] wind must be [x, y, z] integers within +-${FIRE_MAX_WIND_COMPONENT}`)
      ensureWorld()
      return emit({ kind: FIRE_EVENT.WIND, wx: vector[0], wy: vector[1], wz: vector[2] }).id
    },

    setMoisture(value) { checkByte(value, 'moisture'); ensureWorld(); return emit({ kind: FIRE_EVENT.MOISTURE, value }).id },

    setRain(value) { checkByte(value, 'rain'); ensureWorld(); return emit({ kind: FIRE_EVENT.RAIN, value }).id },

    stateAt(position) {
      if (!world || (world.kernel.activeCount === 0 && world.kernel.scarCount === 0)) return FIRE_STATE.UNBURNT
      const c = cellOfPosition(position)
      return world.kernel.stateCodeAt(c.face, c.I, c.J)
    },

    isTrunkCharred(trunkId) {
      if (!world || (world.kernel.activeCount === 0 && world.kernel.scarCount === 0)) return false
      const c = world.lattice.cellOfPlacementId(trunkId)
      return world.kernel.stateCodeAt(c.face, c.I, c.J) === FIRE_STATE.BURNT
    },

    isBurning(id) { return gameplay ? gameplay.isBurning(id) : false },
    smokeDepth(origin, direction, distance) { return gameplay ? gameplay.smokeDepth(origin, direction, distance) : 0 },
    rayBlocked(origin, direction, distance) { return gameplay ? gameplay.rayBlocked(origin, direction, distance) : false },

    applyRemote(payload) {
      if (!payload || payload.type !== FIRE_WIRE_TYPE) throw new TypeError(`[fire] remote payload must be a { type: '${FIRE_WIRE_TYPE}' } message`)
      const { lattice, timeline } = ensureWorld()
      let rewound = 0, rejected = 0, firstReason = null
      let checksum = null
      if (payload.c !== undefined) {
        if (!Array.isArray(payload.c) || payload.c.length !== 2 || !Number.isSafeInteger(payload.c[0]) || !Number.isSafeInteger(payload.c[1])) throw new TypeError(`[fire] malformed checksum row ${JSON.stringify(payload.c)}`)
        checksum = { tick: payload.c[0], hash: payload.c[1] }
      }
      const rows = payload.e ?? []
      if (!Array.isArray(rows) || rows.length > FIRE_MAX_ROWS_PER_MESSAGE) throw new TypeError(`[fire] a fire message carries at most ${FIRE_MAX_ROWS_PER_MESSAGE} rows`)
      const events = rows.map(row => decodeFireEvent(lattice, row))
      for (const ev of events) {
        const r = timeline.submit(ev)
        if (r.rewound) rewound++
        if (!r.ok) { rejected++; firstReason ??= r.reason }
      }
      return { ok: rejected === 0, rejected, reason: firstReason, rewound, checksum }
    },

    checksum() { return ensureWorld().timeline.checksum() },

    rewindTo(tick) { return ensureWorld().timeline.rewindTo(tick) },

    tick(dt) {
      const simTick = appCtx.time.tick
      syncWeather(simTick)
      if (!world) return
      const { kernel, timeline } = world
      timeline.advanceTo(simTick)
      if (gameplay && resolved.role === 'authority') gameplay.tickDamage(simTick, dt)
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

    destroy() { world = null; outbox = []; lastChecksumStep = 0 },
  }
  return fire
}

export default defineFire
