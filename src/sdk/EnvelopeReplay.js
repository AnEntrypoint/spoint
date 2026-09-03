/**
 * EnvelopeReplay.js -- Replay engine for recorded SharedEventEnvelope streams.
 *
 * Cross-repo observability: replay a recorded stream of envelopes for debugging,
 * testing, or trace reconstruction. Works identically across spoint, thebird,
 * freddie, and wireweave -- only depends on the envelope shape.
 *
 * Features:
 *  - Replay envelopes in time order (respecting timestamps)
 *  - Speed control: 1x (real-time), 2x, 10x, 100x, or instant
 *  - Seek: jump to a specific timestamp or envelope index
 *  - Filtering: include/exclude by source, kind, or time range
 *  - Callback: onEnvelope(envelope) called for each replayed envelope
 *  - Completion: promise that resolves when replay finishes
 *  - Pause/resume/stop
 *
 * Usage:
 *   import { createReplay } from './EnvelopeReplay.js'
 *   const replay = createReplay(envelopes, {
 *     speed: 10,
 *     onEnvelope: (env) => console.log(env.kind),
 *   })
 *   await replay.start()
 *   // Or with tracing:
 *   import { traceFromEnvelopes } from './EnvelopeTracer.js'
 *   const { traces } = traceFromEnvelopes(envelopes)
 */

import { validateEnvelope } from './SharedEventEnvelope.js'

/**
 * Create a replay engine for a stream of envelopes.
 *
 * @param {object[]} envelopes - array of envelope objects (must have ts field)
 * @param {object} opts
 * @param {number} [opts.speed=1] - replay speed multiplier (0 = instant)
 * @param {function} [opts.onEnvelope] - called for each replayed envelope
 * @param {function} [opts.onFinished] - called when replay completes
 * @param {function} [opts.onError] - called on invalid envelopes (default: console.warn)
 * @param {string[]} [opts.includeSources] - only replay envelopes whose source starts with one of these
 * @param {string[]} [opts.excludeSources] - skip envelopes whose source starts with one of these
 * @param {string[]} [opts.includeKinds] - only replay envelopes whose kind starts with one of these
 * @param {string[]} [opts.excludeKinds] - skip envelopes whose kind starts with one of these
 * @param {number} [opts.startTs] - only replay envelopes with ts >= this
 * @param {number} [opts.endTs] - only replay envelopes with ts <= this
 * @param {number} [opts.startIndex] - start replaying from this index in the sorted array
 * @returns {object} replay controller
 */
export function createReplay(envelopes, opts = {}) {
  const speed = opts.speed ?? 1
  const onEnvelope = opts.onEnvelope || null
  const onFinished = opts.onFinished || null
  const onError = opts.onError || ((msg) => console.warn(`[EnvelopeReplay] ${msg}`))

  const _sourceIncludes = opts.includeSources?.length ? opts.includeSources : null
  const _sourceExcludes = opts.excludeSources?.length ? opts.excludeSources : null
  const _kindIncludes = opts.includeKinds?.length ? opts.includeKinds : null
  const _kindExcludes = opts.excludeKinds?.length ? opts.excludeKinds : null
  const startTs = opts.startTs ?? null
  const endTs = opts.endTs ?? null

  let _sorted = null
  let _index = 0
  let _running = false
  let _paused = false
  let _timer = null
  let _resolve = null
  let _reject = null

  function _passesFilter(env) {
    if (_sourceIncludes && !_sourceIncludes.some(p => env.source.startsWith(p))) return false
    if (_sourceExcludes && _sourceExcludes.some(p => env.source.startsWith(p))) return false
    if (_kindIncludes && !_kindIncludes.some(p => env.kind.startsWith(p))) return false
    if (_kindExcludes && _kindExcludes.some(p => env.kind.startsWith(p))) return false
    if (startTs != null && env.ts < startTs) return false
    if (endTs != null && env.ts > endTs) return false
    return true
  }

  function _sortEnvelopes() {
    if (_sorted) return _sorted
    // Sort by ts ascending, tie-break by id
    _sorted = [...envelopes].sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts
      return (a.id || '').localeCompare(b.id || '')
    })
    // Apply start index
    if (opts.startIndex != null) _index = Math.max(0, Math.min(opts.startIndex, _sorted.length))
    return _sorted
  }

  function _nextValid() {
    const sorted = _sortEnvelopes()
    while (_index < sorted.length) {
      const env = sorted[_index]
      const validation = validateEnvelope(env)
      if (!validation.valid) {
        onError(`invalid envelope at index ${_index}: ${validation.errors.join(', ')}`)
        _index++
        continue
      }
      if (!_passesFilter(env)) {
        _index++
        continue
      }
      return env
    }
    return null
  }

  function _scheduleNext() {
    if (!_running || _paused) return
    const env = _nextValid()
    if (!env) {
      _finish()
      return
    }

    if (speed === 0) {
      // Instant mode: process all remaining envelopes synchronously
      _replayBurst()
      return
    }

    // Calculate delay: difference between this envelope's ts and the previous one's,
    // scaled by speed. For the first envelope, delay is 0.
    const sorted = _sortEnvelopes()
    const prev = _index > 0 ? sorted[_index - 1] : null
    const delayMs = prev ? Math.max(0, (env.ts - prev.ts) / speed) : 0

    _timer = setTimeout(() => {
      _timer = null
      _index++
      if (onEnvelope) {
        try { onEnvelope(env) } catch (e) { onError(`onEnvelope error: ${e.message}`) }
      }
      _scheduleNext()
    }, Math.min(delayMs, 30000)) // cap at 30s to prevent hanging
  }

  function _replayBurst() {
    let env
    while ((env = _nextValid()) != null) {
      _index++
      if (onEnvelope) {
        try { onEnvelope(env) } catch (e) { onError(`onEnvelope error: ${e.message}`) }
      }
    }
    _finish()
  }

  function _finish() {
    _running = false
    _paused = false
    if (_timer) { clearTimeout(_timer); _timer = null }
    if (onFinished) {
      try { onFinished() } catch (_) { /* don't let the callback break the promise */ }
    }
    if (_resolve) {
      _resolve({ envelopesProcessed: _index, totalEnvelopes: _sortEnvelopes().length })
      _resolve = null
    }
  }

  function _cleanup() {
    _running = false
    _paused = false
    if (_timer) { clearTimeout(_timer); _timer = null }
  }

  /**
   * Start replaying. Returns a promise that resolves when replay finishes
   * (or is stopped). The promise resolves with { envelopesProcessed, totalEnvelopes }.
   */
  function start() {
    if (_running) return Promise.resolve({ envelopesProcessed: _index, totalEnvelopes: _sortEnvelopes().length })
    _sortEnvelopes()
    _running = true
    _paused = false
    return new Promise((resolve, reject) => {
      _resolve = resolve
      _reject = reject
      _scheduleNext()
    })
  }

  /** Pause replay. */
  function pause() {
    _paused = true
    if (_timer) { clearTimeout(_timer); _timer = null }
  }

  /** Resume replay after pause. */
  function resume() {
    if (!_running) return
    _paused = false
    _scheduleNext()
  }

  /** Stop replay permanently. */
  function stop() {
    _cleanup()
    if (_resolve) {
      _resolve({ envelopesProcessed: _index, totalEnvelopes: _sortEnvelopes().length, stopped: true })
      _resolve = null
    }
  }

  /**
   * Seek to a specific timestamp. Replay will skip all envelopes with ts < targetTs.
   * If `restart` is true, also resets the replay to start from the first matching envelope.
   */
  function seek(targetTs, restart = false) {
    _cleanup()
    const sorted = _sortEnvelopes()
    _index = sorted.findIndex(e => e.ts >= targetTs)
    if (_index < 0) _index = sorted.length
    if (restart) {
      _running = true
      _paused = false
      _scheduleNext()
    }
  }

  /**
   * Seek to a specific envelope index in the sorted array.
   */
  function seekIndex(idx, restart = false) {
    _cleanup()
    const sorted = _sortEnvelopes()
    _index = Math.max(0, Math.min(idx, sorted.length))
    if (restart) {
      _running = true
      _paused = false
      _scheduleNext()
    }
  }

  /** Get the current state. */
  function state() {
    const sorted = _sortEnvelopes()
    const current = _index < sorted.length ? sorted[_index] : null
    return {
      running: _running,
      paused: _paused,
      index: _index,
      total: sorted.length,
      currentEnvelope: current,
      progress: sorted.length > 0 ? _index / sorted.length : 0,
    }
  }

  return { start, pause, resume, stop, seek, seekIndex, state }
}