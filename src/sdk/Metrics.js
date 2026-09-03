// Metrics.js: a real Prometheus text-exposition-format registry, zero external dependencies (Prometheus's
// wire format is plain text -- `# HELP`/`# TYPE` comment lines + `metric_name{label="value"} number` data
// lines, https://prometheus.io/docs/instrumenting/exposition_formats/ -- no client library needed to emit
// it correctly). Confirmed via grep this session: zero prior Prometheus/metrics-endpoint surface exists
// anywhere in the repo, this is genuinely greenfield.
//
// Deliberately NOT a general-purpose metrics client library (no push gateway, no exemplars, no OpenMetrics
// extensions) -- just the minimal counter/gauge/histogram primitives this project's own /metrics route
// (ServerAPI.js) needs to expose real, already-measured server internals: TickHandler.js's own per-phase
// tick timing (mv/phys/snap, reusing its existing profileSum*/profileCount accumulators rather than
// re-measuring), SnapshotEncoder.js's real per-call output byte length (counted at TickHandler.js's single
// packSnapshot choke point, the one function every outgoing snapshot payload -- shared-cell, per-viewer
// delta, and legacy broadcast branches alike -- passes through), RoomDirectory.js's getStatus() (already
// designed by its own doc comment as "the shape a later Prometheus /metrics endpoint would poll"), and
// Node's own GC pause durations via perf_hooks (matching the discipline the collider-streamer-fresh-
// territory-tick-stall investigation already used via a one-off --trace-gc run, but wired here as a live
// always-on counter instead of a diagnostic-only invocation).

// node:perf_hooks is a Node-only builtin with no browser equivalent -- this module is dual-imported
// (TickHandler.js is loaded by both the real Node server.js path AND, via src/sdk/WorkerEntry.js, the
// browser module-Worker singleplayer/host path). A STATIC top-level `import ... from 'node:perf_hooks'`
// is resolved eagerly during module-graph construction, before any runtime isNode check could run --
// live-reproduced as a hard crash: a browser module Worker cannot resolve the bare `node:` specifier at
// all (CORS-blocked as a foreign origin), which kills the WHOLE module graph and fires Worker.onerror
// with an opaque, detail-free Event (no message/filename), taking down every singleplayer/host boot via
// client/BrowserServer.js's `this._worker.onerror = reject` (this is what produced the reported bare
// "Connection failed: Event" console log, root-caused in the p2p-mesh-wireweave-bridge-connect-fails
// investigation). Fixed the same way World.js's getJolt() forks its own Node-only import: detect isNode
// at runtime and only dynamically `await import('node:perf_hooks')` on that branch -- a dynamic import
// is not eagerly resolved during graph construction, so the browser/Worker branch never attempts it.
const _isNode = typeof process !== 'undefined' && process.versions?.node
let PerformanceObserver = null, perfConstants = null
if (_isNode) {
  const _ph = await import('node:perf_hooks')
  PerformanceObserver = _ph.PerformanceObserver
  perfConstants = _ph.constants
}

// Prometheus histograms are cumulative-bucket ("le" = less-than-or-equal) by spec -- each bucket's count
// includes every observation <= its boundary, culminating in a final +Inf bucket equal to the total count.
// Buckets chosen for millisecond-scale tick/snapshot timings at a 60Hz-200Hz tick budget (1000/60≈16.7ms,
// 1000/200=5ms) -- fine granularity below budget, coarse above it (an overrun is already visible as a
// TickHandler console.warn; the histogram's job here is the DISTRIBUTION, not overrun detection).
const TICK_MS_BUCKETS = [0.5, 1, 2, 5, 10, 16.7, 25, 50, 100, 250, 500]
// Snapshot payload sizes: msgpackr-packed, quantized/delta-encoded (see SnapshotEncoder.js) -- typically
// tens of bytes (empty-delta keepalive) to a few KB (dense keyframe). Bucketed log-ish across that range.
const SNAP_BYTES_BUCKETS = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384]

function escapeLabelValue(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function formatLabels(labels) {
  if (!labels || Object.keys(labels).length === 0) return ''
  const parts = []
  for (const k in labels) parts.push(`${k}="${escapeLabelValue(labels[k])}"`)
  return `{${parts.join(',')}}`
}

// Histogram: a plain object of {buckets (cumulative counts keyed by boundary), sum, count} -- observe()
// walks the fixed boundary list once per call (boundary counts <= ~11, negligible next to the tick-rate
// hot path work this instruments; called at most once per outgoing snapshot / once per tick, never
// per-entity or per-byte). le="+Inf" is always emitted last, equal to `count`, per the Prometheus spec.
function createHistogram(name, help, boundaries) {
  const buckets = boundaries.map(le => ({ le, count: 0 }))
  let sum = 0, count = 0
  return {
    name, help, type: 'histogram',
    observe(value) {
      sum += value; count++
      for (const b of buckets) if (value <= b.le) b.count++
    },
    reset() { for (const b of buckets) b.count = 0; sum = 0; count = 0 },
    // renderBody: the bucket/sum/count data lines only, no `# HELP`/`# TYPE` header -- used when multiple
    // label-value series of the SAME metric name are rendered together (Prometheus requires exactly one
    // header per metric name, not one per series; see renderMetrics' _tickPhaseSamples loop).
    renderBody(labels) {
      const l = labels || {}
      const lines = []
      for (const b of buckets) lines.push(`${name}_bucket${formatLabels({ ...l, le: b.le })} ${b.count}`)
      lines.push(`${name}_bucket${formatLabels({ ...l, le: '+Inf' })} ${count}`)
      lines.push(`${name}_sum${formatLabels(l)} ${sum}`)
      lines.push(`${name}_count${formatLabels(l)} ${count}`)
      return lines.join('\n')
    },
    render(labels) {
      return `# HELP ${name} ${help}\n# TYPE ${name} histogram\n${this.renderBody(labels)}`
    },
  }
}

function createCounter(name, help) {
  let value = 0
  return {
    name, help, type: 'counter',
    inc(n = 1) { value += n },
    get value() { return value },
    render(labels) {
      return `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name}${formatLabels(labels)} ${value}`
    },
  }
}

// GC-pause tracking: a real, always-on perf_hooks.PerformanceObserver('gc') subscription, matching the
// spirit of the collider-streamer-fresh-territory-tick-stall investigation's --trace-gc discipline but as a
// live counter rather than a one-off diagnostic run. kindNames maps perf_hooks' numeric GC-kind constant
// (entry.kind) to a human-readable label (minor/major/incremental/weakcb) so a scrape distinguishes a cheap
// scavenge from an expensive full mark-sweep, matching Node's own perf_hooks.constants naming.
// perfConstants is null in a browser/Worker context (see the dynamic-import fork above) -- guard the
// GC_KIND_NAMES lookup table build the same way, or this top-level literal throws on module load there.
const GC_KIND_NAMES = perfConstants ? {
  [perfConstants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
  [perfConstants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
  [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
  [perfConstants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
} : {}

function createGcTracker() {
  const durationHist = createHistogram('spoint_gc_pause_ms', 'Node GC pause duration in milliseconds, from perf_hooks PerformanceObserver(\'gc\') entries', TICK_MS_BUCKETS)
  const countByKind = new Map() // kindLabel -> count
  let observer = null
  let installError = null
  if (!PerformanceObserver) {
    // Browser/Worker context: no perf_hooks at all -- degrade to the same always-empty-but-well-formed
    // metric shape the Node-side try/catch below already falls back to on any other install failure.
    installError = 'node:perf_hooks unavailable (non-Node runtime)'
  } else {
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        durationHist.observe(entry.duration)
        const kindLabel = GC_KIND_NAMES[entry.kind] || `unknown_${entry.kind}`
        countByKind.set(kindLabel, (countByKind.get(kindLabel) || 0) + 1)
      }
    })
    observer.observe({ entryTypes: ['gc'], buffered: false })
  } catch (e) {
    // perf_hooks GC instrumentation can be unavailable on some Node builds/flags -- degrade to an
    // always-empty-but-well-formed metric rather than throwing and taking the whole /metrics route down.
    installError = e?.message || String(e)
  }
  }
  return {
    durationHist,
    countByKind,
    installError,
    disconnect() { try { observer?.disconnect() } catch (_) {} },
    render() {
      const lines = [durationHist.render()]
      lines.push('# HELP spoint_gc_events_total Count of Node GC events observed, by kind', '# TYPE spoint_gc_events_total counter')
      if (countByKind.size === 0) {
        lines.push('spoint_gc_events_total{kind="none"} 0')
      } else {
        for (const [kind, n] of countByKind) lines.push(`spoint_gc_events_total{kind="${kind}"} ${n}`)
      }
      return lines.join('\n')
    },
  }
}

// Module-level singletons: the process has exactly one Node GC to observe and (per the existing
// one-server-two-client-modes-same-origin AGENTS.md caveat) exactly one live server per process in normal
// operation, so a module-level registry mirrors the existing _packWrapper/_packPayload module-level-state
// convention in TickHandler.js rather than threading a metrics object through every constructor.
const _snapshotBytesHist = createHistogram('spoint_snapshot_bytes', 'Encoded+packed snapshot payload size in bytes, per SnapshotEncoder.js packSnapshot() call (every outgoing snapshot, all send branches)', SNAP_BYTES_BUCKETS)
const _snapshotBytesTotal = createCounter('spoint_snapshot_bytes_total', 'Cumulative bytes sent across all packed snapshot payloads')
const _gc = createGcTracker()
// phase label -> its own histogram instance (Prometheus multi-label-value histograms need distinct
// per-label-value bucket state, not one shared histogram with the label attached only at render time).
const _tickPhaseSamples = new Map()

/** Called from TickHandler.js's packSnapshot() -- the single choke point every outgoing snapshot payload (shared-cell, per-viewer delta, legacy broadcast) passes through. */
export function recordSnapshotBytes(byteLength) {
  _snapshotBytesHist.observe(byteLength)
  _snapshotBytesTotal.inc(byteLength)
}

/** Called from TickHandler.js's onTick() once per tick with the phase's real measured duration (ms) and a phase label (mv/phys/snap/total). */
export function recordTickPhase(phase, ms) {
  if (!_tickPhaseSamples.has(phase)) _tickPhaseSamples.set(phase, createHistogram('spoint_tick_phase_ms', 'Per-tick phase duration in milliseconds', TICK_MS_BUCKETS))
  _tickPhaseSamples.get(phase).observe(ms)
}

export function gcTracker() { return _gc }

/**
 * Renders the full Prometheus text-exposition body. `sources` supplies the live, already-computed values
 * this module has no way to observe itself (tick/player/entity counts, RoomDirectory.getStatus() rows) --
 * this function is a pure formatter over data the caller already has, not a second measurement pass.
 *
 * sources: {
 *   tick, tickRate, players, entities, connections, sessionCount, uptimeSec, memoryUsage: () => process.memoryUsage(),
 *   rooms: [{ roomId, worldName, port, uptimeMs, tick, players, entities }] (RoomDirectory.getStatus() shape, optional),
 * }
 */
export function renderMetrics(sources = {}) {
  const lines = []
  const g = (name, help, value) => lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`)

  if (sources.tick != null) g('spoint_tick', 'Current server tick number', sources.tick)
  if (sources.tickRate != null) g('spoint_tick_rate_hz', 'Configured simulation tick rate in Hz', sources.tickRate)
  if (sources.players != null) g('spoint_players', 'Currently connected player count', sources.players)
  if (sources.entities != null) g('spoint_entities', 'Live AppRuntime entity count (appRuntime.entities.size)', sources.entities)
  if (sources.sessionCount != null) g('spoint_sessions', 'Active session count', sources.sessionCount)
  if (sources.uptimeSec != null) g('spoint_uptime_seconds', 'Process uptime in seconds', sources.uptimeSec)

  if (typeof sources.memoryUsage === 'function') {
    const mem = sources.memoryUsage()
    g('spoint_process_heap_used_bytes', 'process.memoryUsage().heapUsed', mem.heapUsed)
    g('spoint_process_heap_total_bytes', 'process.memoryUsage().heapTotal', mem.heapTotal)
    g('spoint_process_rss_bytes', 'process.memoryUsage().rss', mem.rss)
    g('spoint_process_external_bytes', 'process.memoryUsage().external', mem.external)
    g('spoint_process_arraybuffers_bytes', 'process.memoryUsage().arrayBuffers', mem.arrayBuffers || 0)
  }

  // Tick phase timing: sourced from TickHandler.js's own EMA/sum accumulators (profileSum/profileSumMv/
  // profileSumPhys/profileSumSnap/profileCount, already computed unconditionally every tick regardless of
  // the _PROFILE console-log gate -- see onTick.getMetrics() in TickHandler.js) rather than re-measuring.
  if (sources.tickTiming) {
    const t = sources.tickTiming
    lines.push('# HELP spoint_tick_phase_avg_ms Average per-tick phase duration in milliseconds, over the current profiling window', '# TYPE spoint_tick_phase_avg_ms gauge')
    lines.push(`spoint_tick_phase_avg_ms{phase="total"} ${t.avgTotalMs.toFixed(4)}`)
    lines.push(`spoint_tick_phase_avg_ms{phase="mv"} ${t.avgMvMs.toFixed(4)}`)
    lines.push(`spoint_tick_phase_avg_ms{phase="phys"} ${t.avgPhysMs.toFixed(4)}`)
    lines.push(`spoint_tick_phase_avg_ms{phase="snap"} ${t.avgSnapMs.toFixed(4)}`)
    g('spoint_tick_phase_sample_count', 'Number of ticks accumulated into the current spoint_tick_phase_avg_ms window', t.sampleCount)
  }

  lines.push(_snapshotBytesHist.render(), _snapshotBytesTotal.render(), _gc.render())

  // Per-tick-phase duration histograms, one real histogram instance per phase label (mv/phys/snap/total),
  // fed by TickHandler.js's onTick() via recordTickPhase -- distinct data from the tickTiming averages
  // above (this is the full distribution, not just a rolling mean). Prometheus requires exactly one
  // `# HELP`/`# TYPE` header per metric NAME (not per label-value series), so the header is emitted once
  // and each phase's bucket/sum/count lines are appended under it via renderBody (no header).
  if (_tickPhaseSamples.size > 0) {
    lines.push('# HELP spoint_tick_phase_ms Per-tick phase duration in milliseconds, full distribution by phase label', '# TYPE spoint_tick_phase_ms histogram')
    for (const [phase, hist] of _tickPhaseSamples) lines.push(hist.renderBody({ phase }))
  }

  if (Array.isArray(sources.rooms)) {
    lines.push('# HELP spoint_room_tick Per-room current tick number (RoomDirectory.getStatus())', '# TYPE spoint_room_tick gauge')
    for (const r of sources.rooms) lines.push(`spoint_room_tick{room_id="${escapeLabelValue(r.roomId)}",world="${escapeLabelValue(r.worldName)}"} ${r.tick}`)
    lines.push('# HELP spoint_room_players Per-room connected player count', '# TYPE spoint_room_players gauge')
    for (const r of sources.rooms) lines.push(`spoint_room_players{room_id="${escapeLabelValue(r.roomId)}",world="${escapeLabelValue(r.worldName)}"} ${r.players}`)
    lines.push('# HELP spoint_room_entities Per-room live entity count', '# TYPE spoint_room_entities gauge')
    for (const r of sources.rooms) lines.push(`spoint_room_entities{room_id="${escapeLabelValue(r.roomId)}",world="${escapeLabelValue(r.worldName)}"} ${r.entities}`)
    lines.push('# HELP spoint_room_uptime_seconds Per-room uptime in seconds since boot', '# TYPE spoint_room_uptime_seconds gauge')
    for (const r of sources.rooms) lines.push(`spoint_room_uptime_seconds{room_id="${escapeLabelValue(r.roomId)}",world="${escapeLabelValue(r.worldName)}"} ${(r.uptimeMs / 1000).toFixed(3)}`)
  }

  return lines.join('\n') + '\n'
}

export { createHistogram, createCounter, TICK_MS_BUCKETS, SNAP_BYTES_BUCKETS }
