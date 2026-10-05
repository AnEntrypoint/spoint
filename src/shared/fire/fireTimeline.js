const DEFAULT_WINDOW_STEPS = 8

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
  const stats = { rewinds: 0, replayedTicks: 0, beyondWindow: 0, lateEvents: 0 }

  function oldestEntry() { return snapshots.values().next().value }

  function trimSnapshots() {
    while (snapshots.size > windowSteps + 1) snapshots.delete(snapshots.keys().next().value)
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

  function advanceTo(targetTick) {
    while (simTick < targetTick) {
      const t = simTick + 1
      if (keepSnapshots && kernel.atBoundary(t)) {
        snapshots.set(t, { snap: kernel.snapshot(), prev: lastBoundary })
        lastBoundary = t
        trimSnapshots()
      }
      kernel.tick(t)
      simTick = t
      if (!keepSnapshots) pruneLog(kernel.stepStart)
    }
  }

  function snapshotAtOrAfter(tick) {
    let best = -1
    for (const t of snapshots.keys()) if (t >= tick && (best < 0 || t < best)) best = t
    return best
  }

  function restoreEntry(boundaryTick) {
    const { snap, prev } = snapshots.get(boundaryTick)
    kernel.restore(snap)
    const queued = new Set(snap.pending.map(e => e.id))
    for (const ev of log) if (ev.tick > prev && !queued.has(ev.id)) kernel.queueEvent({ ...ev })
    for (const t of [...snapshots.keys()]) if (t >= boundaryTick) snapshots.delete(t)
    lastBoundary = prev
    simTick = boundaryTick - 1
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
    if (!keepSnapshots) return { ok: false, reason: 'rewind-disabled', id: ev.id }
    const boundary = snapshotAtOrAfter(ev.tick)
    if (boundary < 0) { addToLog(ev); kernel.queueEvent({ ...ev }); return { ok: true, rewound: false, id: ev.id } }
    if (ev.tick <= oldestEntry().prev) { stats.beyondWindow++; return { ok: false, reason: 'beyond-window', id: ev.id } }
    addToLog(ev)
    const resumeAt = simTick
    restoreEntry(boundary)
    replayThrough(resumeAt)
    return { ok: true, rewound: true, id: ev.id }
  }

  function rewindTo(tick, discardLater = false) {
    if (!keepSnapshots) return { ok: false, reason: 'rewind-disabled' }
    let best = -1
    for (const t of snapshots.keys()) if (t <= tick && t > best) best = t
    if (best < 0) return { ok: false, reason: 'beyond-window' }
    if (discardLater) {
      const kept = log.filter(e => e.tick <= tick)
      logIds.clear()
      for (const e of kept) logIds.add(e.id)
      log = kept
    }
    restoreEntry(best)
    replayThrough(tick)
    return { ok: true }
  }

  function startAt(tick) {
    if (simTick !== 0 || log.length !== 0 || snapshots.size !== 0) throw new Error('[fireTimeline] startAt only applies to an empty timeline')
    simTick = tick
    lastBoundary = tick
  }

  function adopt(snapshot, tick) {
    kernel.restore(snapshot)
    snapshots.clear()
    logIds.clear()
    log = []
    simTick = tick
    lastBoundary = tick
  }

  return {
    submit, advanceTo, rewindTo, adopt, startAt,
    checksum: () => kernel.checksum(),
    keyframe: () => ({ tick: simTick, snapshot: kernel.snapshot() }),
    get tick() { return simTick },
    get log() { return log },
    get stats() { return stats },
    get snapshotTicks() { return [...snapshots.keys()] },
    get kernel() { return kernel },
  }
}
