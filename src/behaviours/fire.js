import { latticeFor } from '../terrain/PlacementChart.js'
import { VEG } from '../terrain/VegPlacement.js'
import { createFireLattice } from '../shared/fire/fireLattice.js'
import { createFireKernel, FIRE_EVENT, FIRE_STATE } from '../shared/fire/fireKernel.js'
import { createFireTimeline } from '../shared/fire/fireTimeline.js'
import { encodeFireEvent, decodeFireEvent, FIRE_WIRE_TYPE, FIRE_SEQ_RANGE, FIRE_MAX_ROWS_PER_MESSAGE, FIRE_MAX_EXTINGUISH_RADIUS_CELLS, FIRE_MAX_IGNITE_RADIUS_CELLS, FIRE_MAX_WIND_COMPONENT, FIRE_MAX_BYTE } from '../shared/fire/fireWire.js'
import { decodeFireKeyframe, createKeyframeEncoder, keyframeFromBase64 } from '../shared/fire/fireKeyframe.js'
import { resolveFireSpec, describeValue, isVec3 } from './fireSpec.js'
import { createFirebreakFuel } from './fireTerrain.js'
import { createFireGameplay } from './fireGameplay.js'
import { createFireWeather } from './fireWeather.js'
import { createFireStageMap } from '../shared/fire/fireStageMap.js'

export { FIRE_STATE }
export { DEFAULT_FIRE, DEFAULT_FIRE_CLASSES, DEFAULT_FIRE_GAMEPLAY, DEFAULT_FIRE_WEATHER, resolveFireSpec } from './fireSpec.js'

export function defineFire(spec = {}, appCtx = null, frameOf = null, weatherOf = null, trunkStreamerOf = null) {
  if (!appCtx || !appCtx.time) throw new TypeError('[fire] appCtx is required')
  const resolved = resolveFireSpec(spec)
  const { config } = resolved
  let world = null
  let outbox = []
  let lastChecksumStep = 0
  let trunkStreamer = null
  let trunkSerial = -1
  let trunkScars = 0
  let maxTick = -1
  const rollbackStats = { rewinds: 0, resimTicks: 0, droppedRows: 0 }
  const resyncStats = { rows: 0, compared: 0, missed: 0, mismatches: 0, firstMismatch: null, requestsReceived: 0, requestsSent: 0, adopted: 0, unanswered: 0 }
  const checksumHistory = new Map()
  const remoteChecksums = new Map()
  const recentEvents = []
  let keyframeCache = null
  let keyframeJob = null
  let eventDropSerial = 0
  const keyframeStats = { jobs: 0, slices: 0, ms: 0, worstSliceMs: 0, lastSliceMs: 0, dropped: 0, served: 0 }
  const CHECKSUM_HISTORY_LIMIT = 64
  const JOIN_EVENT_LIMIT = 1024
  const cellScratch = { face: 0, I: 0, J: 0 }
  const weatherEmits = { rain: -1, moisture: -1, wind: null }
  const weather = resolved.weather
    ? createFireWeather({ config: resolved.weather, readWeather: resolved.weather.source ?? weatherOf ?? (() => null), stepTicks: config.stepTicks, wind: resolved.wind })
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
      regrowSteps: config.regrowSteps, regrowFuelFraction: config.regrowFuelFraction, windAt: resolved.windField,
      undo: resolved.rewind,
    })
    const timeline = createFireTimeline({ kernel, windowSteps: config.windowSteps, keepSnapshots: resolved.rewind })
    world = { lattice, kernel, timeline }
    timeline.startAt(appCtx.time.tick)
    if (resolved.role === 'authority') {
      const rain = weather ? weather.rain : resolved.rain, moisture = weather ? weather.moisture : resolved.moisture
      if (resolved.wind.some(c => c !== 0)) emit({ kind: FIRE_EVENT.WIND, wx: resolved.wind[0], wy: resolved.wind[1], wz: resolved.wind[2] })
      if (moisture !== 0) emit({ kind: FIRE_EVENT.MOISTURE, value: moisture })
      if (rain !== 0) emit({ kind: FIRE_EVENT.RAIN, value: rain })
      if (weather) weather.markEmitted(rain, moisture, resolved.wind)
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
    const ev = { ...partial, tick, seq, at: appCtx.time.tick, id: tick * FIRE_SEQ_RANGE + seq }
    timeline.submit(ev)
    outbox.push(encodeFireEvent(lattice, ev))
    recentEvents.push(ev)
    if (recentEvents.length > JOIN_EVENT_LIMIT) { recentEvents.splice(0, recentEvents.length - JOIN_EVENT_LIMIT); eventDropSerial++ }
    return ev
  }

  function startKeyframeJob(row) {
    if (keyframeJob !== null || world === null) return
    const { kernel, timeline } = world
    if (kernel.tileCount === 0 && kernel.activeCount === 0) return
    const tick = timeline.tick
    keyframeJob = {
      tick,
      hash: row !== null && row !== undefined ? row[1] : timeline.checksum(),
      dropSerial: eventDropSerial,
      encoder: createKeyframeEncoder({ tick, snapshot: kernel.snapshot(), logOf: () => recentEvents.filter(e => e.tick > tick) }),
    }
    keyframeStats.jobs++
  }

  function finishKeyframeJob() {
    const job = keyframeJob
    keyframeJob = null
    if (job.dropSerial !== eventDropSerial) { keyframeStats.dropped++; return }
    keyframeCache = { tick: job.tick, hash: job.hash, bytes: job.encoder.bytes, b64: job.encoder.base64, msg: null }
  }

  function advanceKeyframeJob(budgetMs) {
    if (keyframeJob === null) return false
    const start = performance.now()
    const done = keyframeJob.encoder.advance(budgetMs)
    const ms = performance.now() - start
    keyframeStats.slices++
    keyframeStats.ms += ms
    keyframeStats.lastSliceMs = ms
    if (ms > keyframeStats.worstSliceMs) keyframeStats.worstSliceMs = ms
    if (!done) return false
    finishKeyframeJob()
    return true
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
    if (emits.wind !== null) emit({ kind: FIRE_EVENT.WIND, wx: emits.wind[0], wy: emits.wind[1], wz: emits.wind[2] })
    weather.markEmitted(emits.rain >= 0 ? emits.rain : weather.emittedRain, emits.moisture >= 0 ? emits.moisture : weather.emittedMoisture, emits.wind ?? weather.emittedWind)
  }

  function rememberChecksum(tick, hash) {
    checksumHistory.set(tick, hash)
    if (checksumHistory.size > CHECKSUM_HISTORY_LIMIT) checksumHistory.delete(checksumHistory.keys().next().value)
  }

  function compareRemoteChecksums(simTick) {
    if (remoteChecksums.size === 0) return
    for (const [tick, hash] of [...remoteChecksums]) {
      if (tick > simTick) continue
      remoteChecksums.delete(tick)
      const local = checksumHistory.get(tick)
      if (local === undefined) { resyncStats.missed++; continue }
      resyncStats.compared++
      if (local !== hash) {
        resyncStats.mismatches++
        resyncStats.firstMismatch ??= { tick, local, remote: hash }
      }
    }
  }

  function refreshTrunks() {
    const pending = trunkStreamer.refresh()
    if (pending) pending.then(null, err => console.error('[fire] trunk collider refresh failed and the ring is left partial:', err?.message || err))
  }

  function syncTrunks(kernel) {
    if (trunkStreamer === null) {
      const s = typeof trunkStreamerOf === 'function' ? trunkStreamerOf() : null
      if (!s || typeof s.setExclude !== 'function') return
      trunkStreamer = s
      s.setExclude(id => fire.isTrunkCharred(id))
    }
    if (kernel.changeSerial === trunkSerial) return
    trunkSerial = kernel.changeSerial
    trunkStreamer.sweepExcluded()
    if (kernel.scarCount < trunkScars) refreshTrunks()
    trunkScars = kernel.scarCount
  }

  const gameplay = resolved.gameplay ? createFireGameplay({ appCtx, gameplay: resolved.gameplay, getWorld: () => world, cellOfPosition, frameOf: planetFrame }) : null

  const fire = {
    get world() { return ensureWorld() },
    get activeCount() { return world ? world.kernel.activeCount : 0 },
    get wind() { return world ? world.kernel.wind : null },
    get stats() { return world ? world.kernel.stats : null },
    get rollbackStats() { return rollbackStats },
    get resyncStats() { return resyncStats },
    get needsResync() { return resyncStats.mismatches > 0 },
    get keyframeTick() { return keyframeCache === null ? null : keyframeCache.tick },
    get keyframePending() { return keyframeJob !== null },
    get keyframeStats() { return { ...keyframeStats } },
    get checksumHistory() { return [...checksumHistory.entries()] },
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

    stateAtLocal(x, z) {
      if (!world || (world.kernel.activeCount === 0 && world.kernel.scarCount === 0)) return FIRE_STATE.UNBURNT
      const frame = planetFrame()
      if (!frame || typeof frame.localToDir !== 'function') return FIRE_STATE.UNBURNT
      const d = frame.localToDir(x, z, 0)
      const c = ensureWorld().lattice.cellOfDir(d[0], d[1], d[2], cellScratch)
      return world.kernel.stateCodeAt(c.face, c.I, c.J)
    },

    isTrunkCharred(trunkId) {
      if (!world || (world.kernel.activeCount === 0 && world.kernel.scarCount === 0)) return false
      const c = world.lattice.cellOfPlacementId(trunkId)
      return world.kernel.stateCodeAt(c.face, c.I, c.J) === FIRE_STATE.BURNT
    },

    stageMap(options) { const w = ensureWorld(); return createFireStageMap({ kernel: w.kernel, lattice: w.lattice, ...options }) },

    isBurning(id) { return gameplay ? gameplay.isBurning(id) : false },
    smokeDepth(origin, direction, distance) { return gameplay ? gameplay.smokeDepth(origin, direction, distance) : 0 },
    rayBlocked(origin, direction, distance) { return gameplay ? gameplay.rayBlocked(origin, direction, distance) : false },

    sightBlocked(from, to) {
      if (!gameplay || !isVec3(from) || !isVec3(to)) return false
      const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2]
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (!(distance > 0)) return false
      const direction = [dx / distance, dy / distance, dz / distance]
      return gameplay.rayBlocked(from, direction, distance)
    },

    applyRemote(payload) {
      if (!payload || payload.type !== FIRE_WIRE_TYPE) throw new TypeError(`[fire] remote payload must be a { type: '${FIRE_WIRE_TYPE}' } message`)
      const { lattice, timeline } = ensureWorld()
      let rewound = 0, rejected = 0, firstReason = null
      let checksum = null
      let adopted = null
      if (payload.k !== undefined) {
        if (!Array.isArray(payload.k) || payload.k.length !== 3 || !Number.isSafeInteger(payload.k[0]) || typeof payload.k[1] !== 'number' || typeof payload.k[2] !== 'string') throw new TypeError(`[fire] malformed keyframe row ${JSON.stringify(payload.k)}`)
        const decoded = decodeFireKeyframe(keyframeFromBase64(payload.k[2]))
        if (decoded.tick !== payload.k[0]) throw new TypeError(`[fire] keyframe carries tick ${decoded.tick} but the message declares ${payload.k[0]}`)
        if (decoded.snapshot.cellsPerFace !== lattice.cellsPerFace) throw new RangeError(`[fire] the keyframe at tick ${decoded.tick} spans ${decoded.snapshot.cellsPerFace} cells per face, this world's fire lattice spans ${lattice.cellsPerFace}`)
        timeline.adopt(decoded.snapshot, decoded.tick)
        for (const ev of decoded.log) timeline.submit(ev)
        const local = timeline.checksum()
        if (local !== payload.k[1]) throw new RangeError(`[fire] the keyframe at tick ${decoded.tick} checksums to ${local} here, the authority sent ${payload.k[1]}`)
        checksumHistory.clear()
        remoteChecksums.clear()
        keyframeCache = null
        lastChecksumStep = world.kernel.stepIndex
        maxTick = Math.max(maxTick, decoded.tick)
        resyncStats.adopted++
        resyncStats.mismatches = 0
        resyncStats.firstMismatch = null
        adopted = { tick: decoded.tick, hash: local, bytes: payload.k[2].length }
      }
      if (payload.r !== undefined) {
        if (resolved.role !== 'authority') throw new TypeError("[fire] a spec.role 'mirror' cannot answer a resync request; only the authority holds the fire state")
        resyncStats.requestsReceived++
        const keyframe = fire.keyframeMessage()
        if (keyframe !== null) appCtx.players.broadcast(keyframe)
      }
      if (payload.c !== undefined) {
        if (!Array.isArray(payload.c) || payload.c.length !== 2 || !Number.isSafeInteger(payload.c[0]) || !Number.isSafeInteger(payload.c[1])) throw new TypeError(`[fire] malformed checksum row ${JSON.stringify(payload.c)}`)
        checksum = { tick: payload.c[0], hash: payload.c[1] }
        resyncStats.rows++
        remoteChecksums.set(checksum.tick, checksum.hash)
        if (remoteChecksums.size > CHECKSUM_HISTORY_LIMIT) remoteChecksums.delete(remoteChecksums.keys().next().value)
        compareRemoteChecksums(timeline.tick)
      }
      const rows = payload.e ?? []
      if (!Array.isArray(rows) || rows.length > FIRE_MAX_ROWS_PER_MESSAGE) throw new TypeError(`[fire] a fire message carries at most ${FIRE_MAX_ROWS_PER_MESSAGE} rows`)
      const events = rows.map(row => decodeFireEvent(lattice, row))
      for (const ev of events) {
        const r = timeline.submit(ev)
        if (r.rewound) rewound++
        if (!r.ok) { rejected++; firstReason ??= r.reason }
      }
      return { ok: rejected === 0, rejected, reason: firstReason, rewound, checksum, adopted }
    },

    checksum() { return ensureWorld().timeline.checksum() },

    keyframeMessage() {
      ensureWorld()
      if (keyframeCache === null && keyframeJob === null) startKeyframeJob(null)
      if (keyframeCache === null && keyframeJob !== null) {
        if (!advanceKeyframeJob(config.keyframeSliceMs)) { resyncStats.unanswered++; return null }
      }
      if (keyframeCache === null) { resyncStats.unanswered++; return null }
      if (keyframeCache.msg === null) keyframeCache.msg = { type: FIRE_WIRE_TYPE, k: [keyframeCache.tick, keyframeCache.hash, keyframeCache.b64] }
      keyframeStats.served++
      return keyframeCache.msg
    },

    requestResync() {
      const { timeline } = ensureWorld()
      resyncStats.requestsSent++
      return { type: FIRE_WIRE_TYPE, r: [timeline.tick] }
    },

    rewindTo(tick) { return ensureWorld().timeline.rewindTo(tick) },

    tick(dt) {
      const simTick = appCtx.time.tick
      const resim = simTick <= maxTick
      if (simTick > maxTick) maxTick = simTick
      if (world && simTick < world.timeline.tick) {
        if (!resolved.rewind) throw new TypeError(`[fire] the simulation rewound to tick ${simTick} but this fire was defined without rewind; pass rewind: true to run under a rollback netcode profile`)
        const target = Math.max(simTick - 1, world.timeline.startTick)
        const r = world.timeline.rewindTo(target, simTick)
        if (!r.ok) throw new RangeError(`[fire] the simulation rewound to tick ${simTick}, outside the ${config.windowSteps}-step rewind window (timeline at tick ${world.timeline.tick}, earliest restorable tick ${world.timeline.startTick})`)
        rollbackStats.rewinds++
      }
      if (resim) rollbackStats.resimTicks++
      syncWeather(simTick)
      if (!world) return
      const { kernel, timeline } = world
      timeline.advanceTo(simTick)
      syncTrunks(kernel)
      if (gameplay && resolved.role === 'authority') gameplay.tickDamage(simTick, dt)
      let checksumRow = null
      if (!resim && kernel.activeCount > 0 && kernel.stepIndex - lastChecksumStep >= config.checksumEverySteps) {
        lastChecksumStep = kernel.stepIndex
        checksumRow = [timeline.tick, timeline.checksum()]
        rememberChecksum(checksumRow[0], checksumRow[1])
      }
      compareRemoteChecksums(simTick)
      if (resolved.role !== 'authority') return
      if (checksumRow !== null || keyframeCache === null) startKeyframeJob(checksumRow)
      advanceKeyframeJob(config.keyframeSliceMs)
      if (outbox.length > 0) {
        const rows = outbox
        outbox = []
        if (resim) rollbackStats.droppedRows += rows.length
        else appCtx.players.broadcast({ type: FIRE_WIRE_TYPE, e: rows })
      }
      if (checksumRow !== null) appCtx.players.broadcast({ type: FIRE_WIRE_TYPE, c: checksumRow })
    },

    destroy() { world = null; outbox = []; lastChecksumStep = 0; maxTick = -1; keyframeCache = null; keyframeJob = null; recentEvents.length = 0; checksumHistory.clear(); remoteChecksums.clear() },
  }
  return fire
}

export default defineFire
