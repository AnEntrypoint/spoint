const _isNode = typeof process !== 'undefined' && process.versions?.node
let PerformanceObserver = null, perfConstants = null
if (_isNode) {
  const _ph = await import('node:perf_hooks')
  PerformanceObserver = _ph.PerformanceObserver
  perfConstants = _ph.constants
}

const TICK_MS_BUCKETS = [0.5, 1, 2, 5, 10, 16.7, 25, 50, 100, 250, 500]
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

function createHistogram(name, help, boundaries) {
  const n = boundaries.length
  const counts = new Float64Array(n)
  let sum = 0, count = 0
  return {
    name, help, type: 'histogram',
    observe(value) {
      sum += value; count++
      let i = 0
      while (i < n && value > boundaries[i]) i++
      if (i < n) counts[i]++
    },
    reset() { counts.fill(0); sum = 0; count = 0 },
    renderBody(labels) {
      const l = labels || {}
      const lines = []
      let cum = 0
      for (let i = 0; i < n; i++) { cum += counts[i]; lines.push(`${name}_bucket${formatLabels({ ...l, le: boundaries[i] })} ${cum}`) }
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

const GC_KIND_NAMES = perfConstants ? {
  [perfConstants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
  [perfConstants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
  [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
  [perfConstants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
} : {}

function createGcTracker() {
  const durationHist = createHistogram('spoint_gc_pause_ms', 'Node GC pause duration in milliseconds, from perf_hooks PerformanceObserver(\'gc\') entries', TICK_MS_BUCKETS)
  const countByKind = new Map()
  let observer = null
  let installError = null
  if (!PerformanceObserver) {
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

const _snapshotBytesHist = createHistogram('spoint_snapshot_bytes', 'Encoded+packed snapshot payload size in bytes, per SnapshotEncoder.js packSnapshot() call (every outgoing snapshot, all send branches)', SNAP_BYTES_BUCKETS)
const _snapshotBytesTotal = createCounter('spoint_snapshot_bytes_total', 'Cumulative bytes sent across all packed snapshot payloads')
const _gc = createGcTracker()
const _tickPhaseSamples = new Map()
const _tickPhaseByName = Object.create(null)

export function recordSnapshotBytes(byteLength) {
  _snapshotBytesHist.observe(byteLength)
  _snapshotBytesTotal.inc(byteLength)
}

export function recordTickPhase(phase, ms) {
  let h = _tickPhaseByName[phase]
  if (h === undefined) {
    h = createHistogram('spoint_tick_phase_ms', 'Per-tick phase duration in milliseconds', TICK_MS_BUCKETS)
    _tickPhaseSamples.set(phase, h); _tickPhaseByName[phase] = h
  }
  h.observe(ms)
}

export function gcTracker() { return _gc }

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
