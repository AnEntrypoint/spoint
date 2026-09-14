import { validateEnvelope } from './SharedEventEnvelope.js'

const MAX_REPLAY_STEP_DELAY_MS = 30000

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
    _sorted = [...envelopes].sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts
      return (a.id || '').localeCompare(b.id || '')
    })
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
      _replayBurst()
      return
    }

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
    }, Math.min(delayMs, MAX_REPLAY_STEP_DELAY_MS))
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
      try { onFinished() } catch (_) { }
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

  function pause() {
    _paused = true
    if (_timer) { clearTimeout(_timer); _timer = null }
  }

  function resume() {
    if (!_running) return
    _paused = false
    _scheduleNext()
  }

  function stop() {
    _cleanup()
    if (_resolve) {
      _resolve({ envelopesProcessed: _index, totalEnvelopes: _sortEnvelopes().length, stopped: true })
      _resolve = null
    }
  }

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