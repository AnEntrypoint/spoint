/**
 * EnvelopeTracer.js -- Tracing with span context propagation on top of SharedEventEnvelope.
 *
 * Cross-repo observability: a single tracer that creates spans, propagates trace context
 * via envelope metadata, and produces unified traces. Works identically across spoint,
 * thebird, freddie, and wireweave -- only depends on the envelope shape.
 *
 * Features:
 *  - Span lifecycle: start, end (with duration), tag, error
 *  - Trace context propagation: traceId + parentSpanId carried in envelope metadata
 *  - Span tree reconstruction from a stream of envelopes
 *  - Export: tree, flat list, or JSON-encodable trace object
 *  - Sampling: rate-based (0.0-1.0) for high-volume traces
 *
 * Trace context is carried in the envelope's payload as an optional `_trace` field:
 *   { traceId, spanId, parentSpanId }
 *
 * Usage:
 *   import { createTracer, traceFromEnvelopes } from './EnvelopeTracer.js'
 *   const tracer = createTracer({ sampleRate: 0.1 })
 *   const span = tracer.start('spoint:physics', 'step', { dt: 0.016 })
 *   // ... do work ...
 *   span.end()
 *   // To reconstruct a trace from recorded envelopes:
 *   const trace = traceFromEnvelopes(envelopes)
 */

import { generateEventId } from './SharedEventEnvelope.js'

let _counter = 0

function _nextId() {
  _counter = (_counter + 1) & 0x7fffffff
  return `${Date.now().toString(36)}-${_counter.toString(36)}`
}

/**
 * Create a tracer.
 *
 * @param {object} opts
 * @param {number} [opts.sampleRate=1.0] - fraction of traces to sample (0.0 = none, 1.0 = all)
 * @param {function} [opts.onSpan] - callback(span) for every completed span (for export/sink)
 * @returns {object} tracer
 */
export function createTracer(opts = {}) {
  const sampleRate = opts.sampleRate ?? 1.0
  const onSpan = opts.onSpan || null
  const _spans = new Map() // spanId -> span object
  const _traces = new Map() // traceId -> { traceId, spans:[] }

  function _shouldSample() {
    return sampleRate >= 1.0 || Math.random() < sampleRate
  }

  /**
   * Start a span. Returns a span handle.
   *
   * @param {string} source - e.g. "spoint:physics"
   * @param {string} kind - e.g. "step", "collision", "render"
   * @param {object} [data] - arbitrary span data (serializable)
   * @param {object} [context] - optional parent trace context { traceId, parentSpanId }
   * @returns {object} span handle with { id, traceId, end, tag, error, context }
   */
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

      /** End the span. */
      end() {
        if (span.endTime != null) return
        span.endTime = Date.now()
        span.endHr = typeof process !== 'undefined' && process.hrtime
          ? process.hrtime.bigint()
          : BigInt(span.endTime * 1_000_000)
        span.durationMs = Number(span.endHr - span.startHr) / 1_000_000
        if (onSpan) {
          try { onSpan(span) } catch (_) { /* sink errors must not take the tracer down */ }
        }
      },

      /** Tag the span with a key-value pair. */
      tag(key, value) {
        span.tags[key] = value
      },

      /** Set multiple tags at once. */
      tags(tagMap) {
        Object.assign(span.tags, tagMap)
      },

      /** Mark the span as errored. */
      error(err) {
        span.error = err?.message || String(err)
      },

      /**
       * Export the trace context for propagation to child spans.
       * Embed this in an envelope's payload._trace field.
       */
      context() {
        return { traceId, spanId, parentSpanId }
      },
    }
  }

  /**
   * Embed trace context into a payload object (mutates it).
   * The caller then passes this payload to the envelope.
   */
  function inject(payload, spanCtx) {
    if (!payload) return
    payload._trace = spanCtx
  }

  /**
   * Extract trace context from a payload (if present).
   * Returns { traceId, spanId, parentSpanId } or null.
   */
  function extract(payload) {
    return payload?._trace || null
  }

  /**
   * Get a completed trace by traceId.
   */
  function getTrace(traceId) {
    return _traces.get(traceId) || null
  }

  /**
   * Export all completed traces as JSON-encodable objects.
   * Only includes spans that have ended.
   */
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

  /**
   * Reset the tracer (clear all spans and traces).
   */
  function reset() {
    _spans.clear()
    _traces.clear()
  }

  /**
   * Return stats: { activeSpans, completedTraces, totalSpans }
   */
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

/**
 * Reconstruct a trace tree from a flat array of envelopes that carry trace context.
 * Each envelope is expected to have payload._trace = { traceId, spanId, parentSpanId }.
 *
 * This is the "replay" side of the tracing system: given a stream of recorded envelopes
 * (from EnvelopeReplay.js or a log file), reconstruct the full span tree.
 *
 * @param {object[]} envelopes - array of envelope objects with payload._trace
 * @returns {object} { traces: Map<traceId, tree>, spans: object[] }
 */
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

  // Group by traceId
  for (const span of spans) {
    if (!traces.has(span.traceId)) traces.set(span.traceId, { traceId: span.traceId, spans: [], root: null })
    traces.get(span.traceId).spans.push(span)
  }

  // Find root spans (no parentSpanId) and build trees
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