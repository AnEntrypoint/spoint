import { generateEventId } from './SharedEventEnvelope.js'

let _counter = 0

function _nextId() {
  _counter = (_counter + 1) & 0x7fffffff
  return `${Date.now().toString(36)}-${_counter.toString(36)}`
}

export function createTracer(opts = {}) {
  const sampleRate = opts.sampleRate ?? 1.0
  const onSpan = opts.onSpan || null
  const _spans = new Map()
  const _traces = new Map()

  function _shouldSample() {
    return sampleRate >= 1.0 || Math.random() < sampleRate
  }

  function start(source, kind, data = {}, context = null) {
    const sampling = _shouldSample()
    const spanId = _nextId()
    const traceId = context?.traceId || _nextId()
    const parentSpanId = context?.parentSpanId || null
    const startTime = Date.now()
    const startHr = typeof process !== 'undefined' && process.hrtime ? process.hrtime.bigint() : BigInt(startTime * 1_000_000)

    const span = {
      id: spanId,
      traceId,
      parentSpanId,
      source,
      kind,
      startTime,
      startHr,
      endTime: null,
      endHr: null,
      durationMs: null,
      data: { ...data },
      tags: {},
      error: null,
      sampled: sampling,
    }

    _spans.set(spanId, span)

    if (!_traces.has(traceId)) _traces.set(traceId, { traceId, spans: [] })
    _traces.get(traceId).spans.push(span)

    return {
      get id() { return spanId },
      get traceId() { return traceId },
      get sampled() { return sampling },

      end() {
        if (span.endTime != null) return
        span.endTime = Date.now()
        span.endHr = typeof process !== 'undefined' && process.hrtime
          ? process.hrtime.bigint()
          : BigInt(span.endTime * 1_000_000)
        span.durationMs = Number(span.endHr - span.startHr) / 1_000_000
        if (onSpan) {
          try { onSpan(span) } catch (_) { }
        }
      },

      tag(key, value) {
        span.tags[key] = value
      },

      tags(tagMap) {
        Object.assign(span.tags, tagMap)
      },

      error(err) {
        span.error = err?.message || String(err)
      },

      context() {
        return { traceId, spanId, parentSpanId }
      },
    }
  }

  function inject(payload, spanCtx) {
    if (!payload) return
    payload._trace = spanCtx
  }

  function extract(payload) {
    return payload?._trace || null
  }

  function getTrace(traceId) {
    return _traces.get(traceId) || null
  }

  function exportTraces() {
    const result = []
    for (const [, trace] of _traces) {
      const completed = trace.spans.filter(s => s.endTime != null)
      if (completed.length === 0) continue
      result.push({
        traceId: trace.traceId,
        spans: completed.map(s => ({
          id: s.id,
          parentSpanId: s.parentSpanId,
          traceId: s.traceId,
          source: s.source,
          kind: s.kind,
          startTime: s.startTime,
          durationMs: s.durationMs,
          data: s.data,
          tags: s.tags,
          error: s.error,
          sampled: s.sampled,
        })),
      })
    }
    return result
  }

  function reset() {
    _spans.clear()
    _traces.clear()
  }

  function stats() {
    let active = 0, completed = 0, total = 0
    for (const [, span] of _spans) {
      total++
      if (span.endTime != null) completed++
      else active++
    }
    return { activeSpans: active, completedSpans: completed, totalSpans: total, completedTraces: _traces.size }
  }

  return { start, inject, extract, getTrace, exportTraces, reset, stats }
}

export function traceFromEnvelopes(envelopes) {
  const spans = []
  const traces = new Map()

  for (const env of envelopes) {
    const ctx = env.payload?._trace
    if (!ctx) continue
    spans.push({
      id: ctx.spanId,
      traceId: ctx.traceId,
      parentSpanId: ctx.parentSpanId,
      source: env.source,
      kind: env.kind,
      ts: env.ts,
      payload: env.payload,
    })
  }

  for (const span of spans) {
    if (!traces.has(span.traceId)) traces.set(span.traceId, { traceId: span.traceId, spans: [], root: null })
    traces.get(span.traceId).spans.push(span)
  }

  for (const [, trace] of traces) {
    const byId = new Map()
    for (const s of trace.spans) byId.set(s.id, s)
    for (const s of trace.spans) {
      if (s.parentSpanId && byId.has(s.parentSpanId)) {
        const parent = byId.get(s.parentSpanId)
        if (!parent.children) parent.children = []
        parent.children.push(s)
      } else if (!s.parentSpanId) {
        trace.root = s
      }
    }
  }

  return { traces, spans }
}