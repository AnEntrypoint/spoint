import { generateEventId, validateEnvelope } from './SharedEventEnvelope.js'
import { createWriteStream } from 'node:fs'
import { appendFile } from 'node:fs/promises'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const LEVEL_NAMES = { 10: 'DEBUG', 20: 'INFO', 30: 'WARN', 40: 'ERROR' }

export function createEnvelopeLogger(opts = {}) {
  const level = LEVELS[opts.level] ?? LEVELS.info
  const format = opts.format || 'line'
  const flushIntervalMs = opts.flushIntervalMs ?? 5000
  const bufferSize = opts.bufferSize ?? 256

  let _buffer = []
  let _flushTimer = null
  let _closed = false

  const _sourceIncludes = opts.includeSources?.length ? opts.includeSources : null
  const _sourceExcludes = opts.excludeSources?.length ? opts.excludeSources : null
  const _kindIncludes = opts.includeKinds?.length ? opts.includeKinds : null
  const _kindExcludes = opts.excludeKinds?.length ? opts.excludeKinds : null

  function _passesFilter(source, kind) {
    if (_sourceIncludes && !_sourceIncludes.some(p => source.startsWith(p))) return false
    if (_sourceExcludes && _sourceExcludes.some(p => source.startsWith(p))) return false
    if (_kindIncludes && !_kindIncludes.some(p => kind.startsWith(p))) return false
    if (_kindExcludes && _kindExcludes.some(p => kind.startsWith(p))) return false
    return true
  }

  function _formatTimestamp(ts) {
    const d = new Date(ts)
    return d.toISOString()
  }

  function _formatLine(entry) {
    const lvl = LEVEL_NAMES[entry._level] || 'INFO'
    const ts = _formatTimestamp(entry.ts)
    switch (format) {
      case 'json':
        return JSON.stringify({ ...entry, _level: undefined, _levelName: lvl })
      case 'pretty':
        return `[${ts}] ${lvl.padEnd(5)} ${entry.source} | ${entry.kind}\n  id: ${entry.id}\n  payload: ${JSON.stringify(entry.payload)}`
      case 'line':
      default:
        return `[${ts}] ${lvl.padEnd(5)} ${entry.source} | ${entry.kind} | ${entry.id} | ${JSON.stringify(entry.payload)}`
    }
  }

  async function _flush() {
    if (_buffer.length === 0) return
    const lines = _buffer.splice(0)
    if (opts.onLog) {
      for (const line of lines) {
        try { opts.onLog(line) } catch (_) { }
      }
    }
    if (opts.filePath && !_closed) {
      try {
        await appendFile(opts.filePath, lines.join('\n') + '\n', 'utf8')
      } catch (_) { }
    }
  }

  function _scheduleFlush() {
    if (_flushTimer) clearTimeout(_flushTimer)
    if (_closed) return
    _flushTimer = setTimeout(() => {
      _flushTimer = null
      _flush().catch(() => {})
      _scheduleFlush()
    }, flushIntervalMs)
  }

  _scheduleFlush()

  function log(envelope, severity = 'info') {
    const sv = LEVELS[severity] ?? LEVELS.info
    if (sv < level) return
    const validation = validateEnvelope(envelope)
    if (!validation.valid) {
      console.warn(`[EnvelopeLogger] invalid envelope: ${validation.errors.join(', ')}`)
      return
    }
    if (!_passesFilter(envelope.source, envelope.kind)) return
    const entry = { ...envelope, _level: sv }
    const line = _formatLine(entry)
    if (format !== 'json' && format !== 'pretty') {
      const consoleFn = sv >= LEVELS.error ? console.error : sv >= LEVELS.warn ? console.warn : console.log
      consoleFn(line)
    }
    _buffer.push(line)
    if (_buffer.length >= bufferSize) _flush().catch(() => {})
  }

  function _logAt(severity, source, kind, payload) {
    log({
      id: generateEventId(),
      ts: Date.now(),
      source,
      kind,
      payload,
    }, severity)
  }

  function debug(source, kind, payload) { _logAt('debug', source, kind, payload) }
  function info(source, kind, payload) { _logAt('info', source, kind, payload) }
  function warn(source, kind, payload) { _logAt('warn', source, kind, payload) }
  function error(source, kind, payload) { _logAt('error', source, kind, payload) }

  async function flush() {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null }
    await _flush()
  }

  async function close() {
    _closed = true
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null }
    await _flush()
  }

  return { log, debug, info, warn, error, flush, close }
}

export function scopedLogger(logger, scope) {
  function _scopedSource(suffix) {
    return scope + (suffix ? ':' + suffix : '')
  }
  return {
    log: (envelope, severity) => logger.log({ ...envelope, source: _scopedSource(envelope.source) }, severity),
    debug: (source, kind, payload) => logger.debug(_scopedSource(source), kind, payload),
    info: (source, kind, payload) => logger.info(_scopedSource(source), kind, payload),
    warn: (source, kind, payload) => logger.warn(_scopedSource(source), kind, payload),
    error: (source, kind, payload) => logger.error(_scopedSource(source), kind, payload),
    flush: () => logger.flush(),
    close: () => logger.close(),
  }
}