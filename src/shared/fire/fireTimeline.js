import { validateFireSnapshot } from './fireKeyframe.js'

const DEFAULT_WINDOW_STEPS = 8

const RESTORE_COUNTERS = ['tileCount', 'activeCount', 'activeTileCount', 'scarCount', 'stepIndex', 'stepStart']

function compareEvents(a, b) { return a.tick - b.tick || a.id - b.id }

export function createFireTimeline({ kernel, windowSteps = DEFAULT_WINDOW_STEPS, keepSnapshots = true }) {
  if (!kernel || typeof kernel.restore !== 'function') throw new TypeError('[fireTimeline] kernel is required')
  if (!Number.isInteger(windowSteps) || windowSteps < 1) throw new RangeError(`[fireTimeline] windowSteps must be a positive integer, got ${windowSteps}`)
  const snapshots = new Map()
  const logIds = new Set()
  let log = []
  let simTick = 0
  let lastBoundary = 0
  let nextId = 1
  let genesis = null
  let genesisTick = -1
  const stats = { rewinds: 0, replayedTicks: 0, beyondWindow: 0, lateEvents: 0, restoreFailures: 0 }

  function oldestEntry() { return snapshots.values().next().value }

  function dropEntry(t) {
    const entry = snapshots.get(t)
    if (entry === undefined) return
    snapshots.delete(t)
    if (entry.delta !== undefined) kernel.releaseDelta(entry.delta)
  }

  function trimSnapshots() {
    while (snapshots.size > windowSteps + 1) { dropEntry(snapshots.keys().next().value); genesis = null; genesisTick = -1 }
    if (genesis !== null) return
    pruneLog(snapshots.size > 0 ? oldestEntry().prev : simTick)
  }

  function pruneLog(throughTick) {
    let keepFrom = 0
    while (keepFrom < log.length && log[keepFrom].tick <= throughTick) logIds.delete(log[keepFrom++].id)
    if (keepFrom > 0) log = log.slice(keepFrom)
  }

  function addToLog(ev) {
    let i = log.length
    log.push(ev)
    while (i > 0 && compareEvents(log[i - 1], ev) > 0) { log[i] = log[i - 1]; i-- }
    log[i] = ev
    logIds.add(ev.id)
  }

  function dropFromLog(ev) {
    const at = log.indexOf(ev)
    if (at >= 0) log.splice(at, 1)
    logIds.delete(ev.id)
  }

  function resetLog(rows) {
    log = rows
    logIds.clear()
    for (const e of rows) logIds.add(e.id)
  }

  function advanceTo(targetTick) {
    while (simTick < targetTick) {
      const t = simTick + 1
      if (keepSnapshots && kernel.atBoundary(t)) {
        snapshots.set(t, { delta: kernel.takeDelta(), prev: lastBoundary, counters: countersNow() })
        lastBoundary = t
        trimSnapshots()
      }
      kernel.tick(t)
      simTick = t
      if (!keepSnapshots) pruneLog(kernel.stepStart)
    }
  }

  function latestAtOrBefore(tick) {
    let best = -1
    for (const t of snapshots.keys()) if (t <= tick && t > best) best = t
    if (best < 0 && genesis !== null && genesisTick <= tick) best = genesisTick
    return best
  }

  function entryAt(boundaryTick) { return boundaryTick === genesisTick && genesis !== null ? genesis : snapshots.get(boundaryTick) }

  function oldestPrev() { return genesis === null ? (snapshots.size > 0 ? oldestEntry().prev : -1) : genesis.prev }

  function entryPendingAt(entry) { return entry.delta !== undefined ? entry.delta.pending : entry.snap.pending }

  function restoreFailure(reason, detail) {
    stats.restoreFailures++
    return { ok: false, reason, detail, rewound: false, restored: false }
  }

  function countersNow() {
    const out = {}
    for (const field of RESTORE_COUNTERS) out[field] = kernel[field]
    return out
  }

  function countersAgainst(expected) {
    if (expected === null || expected === undefined) return `[fireTimeline] the restored boundary carries no recorded counters, so the restore cannot be verified`
    for (const field of RESTORE_COUNTERS) {
      const want = expected[field]
      if (!Number.isInteger(want)) continue
      const got = kernel[field]
      if (got !== want) return `[fireTimeline] the restore left the kernel holding ${field} ${got}, the boundary it was asked to restore to declares ${want}`
    }
    return null
  }

  function restoreSnapshotEntry(entry) {
    const checked = validateFireSnapshot(entry.snap, { cellsPerFace: kernel.cellsPerFace, cellCapacity: kernel.cellCapacity })
    if (!checked.ok) return restoreFailure(`snapshot-${checked.reason}`, checked.detail)
    kernel.restore(entry.snap)
    const mismatch = countersAgainst(entry.snap)
    if (mismatch !== null) return restoreFailure('snapshot-restore-unverified', mismatch)
    return null
  }

  function restoreDeltaEntry(entry, pending, boundaryTick) {
    const undos = []
    const keys = [...snapshots.keys()]
    for (let i = keys.length - 1; i >= 0; i--) {
      if (keys[i] <= boundaryTick) break
      const later = snapshots.get(keys[i])
      if (later === undefined || later.delta === undefined) return restoreFailure('missing-delta', `[fireTimeline] the boundary snapshot at tick ${keys[i]} carries no delta, so the walk back to tick ${boundaryTick} cannot undo the ${keys[i] - boundaryTick} tick(s) it covers`)
      undos.push(later.delta)
    }
    kernel.undoOpenStep()
    for (const d of undos) kernel.undoDelta(d)
    kernel.markRestored(pending)
    const mismatch = countersAgainst(entry.counters)
    if (mismatch !== null) return restoreFailure('delta-restore-unverified', mismatch)
    return null
  }

  function restoreEntry(boundaryTick) {
    const entry = entryAt(boundaryTick)
    if (entry === undefined || entry === null) return restoreFailure('missing-entry', `[fireTimeline] no boundary snapshot and no genesis sits at tick ${boundaryTick}, so there is no state there to restore`)
    const pending = entryPendingAt(entry)
    const queued = new Set(pending.map(e => e.id))
    const failed = entry.delta !== undefined
      ? restoreDeltaEntry(entry, pending, boundaryTick)
      : restoreSnapshotEntry(entry)
    if (failed !== null) return failed
    for (const ev of log) if (ev.tick > entry.prev && !queued.has(ev.id)) kernel.queueEvent({ ...ev })
    for (const t of [...snapshots.keys()]) if (t >= boundaryTick) dropEntry(t)
    lastBoundary = entry.prev
    simTick = boundaryTick - 1
    return { ok: true, rewound: true, restored: true, boundaryTick, pending: pending.length }
  }

  function replayThrough(resumeAt) {
    stats.rewinds++
    stats.replayedTicks += resumeAt - simTick
    advanceTo(resumeAt)
  }

  function submit(event) {
    const ev = { ...event }
    if (ev.id === undefined) ev.id = nextId
    nextId = Math.max(nextId, ev.id + 1)
    if (logIds.has(ev.id)) return { ok: true, duplicate: true, rewound: false }
    if (ev.tick > simTick) { addToLog(ev); kernel.queueEvent({ ...ev }); return { ok: true, rewound: false, id: ev.id } }
    stats.lateEvents++
    if (!keepSnapshots) return { ok: false, reason: 'rewind-disabled', restored: false, id: ev.id }
    const boundary = latestAtOrBefore(ev.tick)
    if (boundary < 0) { stats.beyondWindow++; return { ok: false, reason: 'beyond-window', restored: false, id: ev.id } }
    if (ev.tick <= oldestPrev()) { stats.beyondWindow++; return { ok: false, reason: 'beyond-window', restored: false, id: ev.id } }
    addToLog(ev)
    const resumeAt = simTick
    const restored = restoreEntry(boundary)
    if (!restored.ok) { dropFromLog(ev); return { ...restored, id: ev.id } }
    replayThrough(resumeAt)
    return { ok: true, rewound: true, id: ev.id }
  }

  function rewindTo(tick, discardLater = false) {
    if (!keepSnapshots) return { ok: false, reason: 'rewind-disabled', restored: false }
    const best = latestAtOrBefore(tick + 1)
    if (best < 0) return { ok: false, reason: 'beyond-window', restored: false }
    const heldLog = log
    if (discardLater !== false && discardLater !== undefined && discardLater !== 0) {
      const reemitFrom = discardLater === true ? -Infinity : discardLater
      resetLog(log.filter(e => e.tick <= tick || (e.at !== undefined && e.at < reemitFrom)))
    }
    const restored = restoreEntry(best)
    if (!restored.ok) { resetLog(heldLog); return restored }
    replayThrough(tick)
    return { ok: true, rewound: true, restored: true, boundaryTick: best }
  }

  function startAt(tick) {
    if (simTick !== 0 || log.length !== 0 || snapshots.size !== 0) throw new Error('[fireTimeline] startAt only applies to an empty timeline')
    simTick = tick
    lastBoundary = tick
    if (keepSnapshots) { genesis = { snap: kernel.snapshot(), prev: tick }; genesisTick = tick + 1 }
  }

  function adopt(snapshot, tick) {
    const checked = validateFireSnapshot(snapshot, { cellsPerFace: kernel.cellsPerFace, cellCapacity: kernel.cellCapacity })
    if (!checked.ok) return restoreFailure(`snapshot-${checked.reason}`, checked.detail)
    kernel.restore(snapshot)
    const mismatch = countersAgainst(snapshot)
    if (mismatch !== null) return restoreFailure('snapshot-restore-unverified', mismatch)
    for (const t of [...snapshots.keys()]) dropEntry(t)
    resetLog([])
    for (const ev of snapshot.pending) {
      addToLog({ ...ev })
      nextId = Math.max(nextId, ev.id + 1)
    }
    simTick = tick
    lastBoundary = tick
    if (keepSnapshots) { genesis = { snap: kernel.snapshot(), prev: tick }; genesisTick = tick + 1 }
    return { ok: true, restored: true, adopted: true, tick }
  }

  return {
    submit, advanceTo, rewindTo, adopt, startAt,
    checksum: () => kernel.checksum(),
    keyframe: () => ({ tick: simTick, snapshot: kernel.snapshot() }),
    get tick() { return simTick },
    get startTick() { return genesis === null ? (oldestEntry() ? oldestEntry().prev : 0) : genesis.prev },
    get log() { return log },
    get stats() { return stats },
    get snapshotTicks() { return [...snapshots.keys()] },
    get kernel() { return kernel },
  }
}
