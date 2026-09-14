import { timingSafeTokenEqual } from './authCompare.js'
import { renderMetrics } from './Metrics.js'
import { collectBenchmark } from './PublicBenchmark.js'
import { validateMessage, KIND_PLACE, KIND_UPDATE, KIND_REMOVE, KIND_CLEAR } from './FreddieBridge.js'

const DEBUG_LOG_BUCKET_CAPACITY = 20
const DEBUG_LOG_BUCKET_REFILL_PER_SEC = 5
const _debugLogBuckets = new Map()

function isLoopbackAddress(remote) {
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

function debugLogRateLimited(ip) {
  const now = Date.now()
  let b = _debugLogBuckets.get(ip)
  if (!b) { b = { tokens: DEBUG_LOG_BUCKET_CAPACITY, lastRefillMs: now }; _debugLogBuckets.set(ip, b) }
  const elapsedSec = (now - b.lastRefillMs) / 1000
  if (elapsedSec > 0) {
    b.tokens = Math.min(DEBUG_LOG_BUCKET_CAPACITY, b.tokens + elapsedSec * DEBUG_LOG_BUCKET_REFILL_PER_SEC)
    b.lastRefillMs = now
  }
  if (b.tokens < 1) return true
  b.tokens -= 1
  return false
}

const CLIENT_ERROR_BUCKET_CAPACITY = 5
const CLIENT_ERROR_BUCKET_REFILL_PER_SEC = 0.2
const _clientErrorBuckets = new Map()

function clientErrorRateLimited(ip) {
  const now = Date.now()
  let b = _clientErrorBuckets.get(ip)
  if (!b) { b = { tokens: CLIENT_ERROR_BUCKET_CAPACITY, lastRefillMs: now }; _clientErrorBuckets.set(ip, b) }
  const elapsedSec = (now - b.lastRefillMs) / 1000
  if (elapsedSec > 0) {
    b.tokens = Math.min(CLIENT_ERROR_BUCKET_CAPACITY, b.tokens + elapsedSec * CLIENT_ERROR_BUCKET_REFILL_PER_SEC)
    b.lastRefillMs = now
  }
  if (b.tokens < 1) return true
  b.tokens -= 1
  return false
}

export function handleUploadModel(req, res, uploadHandler) {
  const _tok = process.env.EDITOR_TOKEN
  if (_tok && !timingSafeTokenEqual(req.headers['x-editor-token'], _tok)) { res.writeHead(403); res.end('forbidden'); return }
  uploadHandler(req, res)
}

export function handleDebugLog(req, res) {
  const _remote = req.socket?.remoteAddress || ''
  const _isLoopback = isLoopbackAddress(_remote)
  if (!_isLoopback) {
    const _tok = process.env.EDITOR_TOKEN
    if (!_tok || !timingSafeTokenEqual(req.headers['x-editor-token'], _tok)) { res.writeHead(403); res.end('forbidden'); return }
  }
  if (debugLogRateLimited(_remote)) { res.writeHead(429); res.end('rate limited'); return }
  const _DEBUG_LOG_MAX = 256 * 1024
  let _len = 0, _over = false
  const chunks = []
  req.on('data', d => {
    if (_over) return
    _len += d.length
    if (_len > _DEBUG_LOG_MAX) { _over = true; res.writeHead(413); res.end('payload too large'); req.destroy(); return }
    chunks.push(d)
  })
  req.on('end', () => { if (_over) return; try { const d = JSON.parse(Buffer.concat(chunks).toString()); console.log('[browser]', ...d) } catch(_) {}; res.writeHead(200); res.end() })
}

export function handleClientError(req, res) {
  const _remote = req.socket?.remoteAddress || ''
  if (clientErrorRateLimited(_remote)) { res.writeHead(429); res.end('rate limited'); return }
  const _CLIENT_ERROR_MAX = 16 * 1024
  let _len = 0, _over = false
  const chunks = []
  req.on('data', d => {
    if (_over) return
    _len += d.length
    if (_len > _CLIENT_ERROR_MAX) { _over = true; res.writeHead(413); res.end('payload too large'); req.destroy(); return }
    chunks.push(d)
  })
  req.on('end', () => {
    if (_over) return
    try {
      const report = JSON.parse(Buffer.concat(chunks).toString())
      console.error(`[client-error] ${report.kind || 'error'}: ${String(report.message || '').slice(0, 500)}`,
        { url: report.url, ua: report.ua, stack: String(report.stack || '').slice(0, 2000), renderControls: report.renderControls, deviceTier: report.deviceTier, remote: _remote })
    } catch (_) { }
    res.writeHead(200); res.end()
  })
}

export function handleDebugServer(req, res, ctx) {
  const remote = req.socket?.remoteAddress || ''
  if (!isLoopbackAddress(remote)) { res.writeHead(403); res.end('forbidden'); return }
  const { tickSystem, playerManager, appRuntime, connections, sessions } = ctx
  const data = JSON.stringify({
    tick: tickSystem.currentTick,
    tickRate: ctx.tickRate,
    players: playerManager.getPlayerCount(),
    entities: appRuntime.entities.size,
    connections: connections.getAllStats(),
    sessions: sessions.getActiveCount(),
    heap: process.memoryUsage()
  })
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(data)
}

export function handleMetrics(req, res, ctx) {
  const remote = req.socket?.remoteAddress || ''
  if (!isLoopbackAddress(remote)) { res.writeHead(403); res.end('forbidden'); return }
  const { tickSystem, playerManager, appRuntime, sessions } = ctx
  const body = renderMetrics({
    tick: tickSystem.currentTick,
    tickRate: ctx.tickRate,
    players: playerManager.getPlayerCount(),
    entities: appRuntime.entities.size,
    sessionCount: sessions.getActiveCount(),
    uptimeSec: process.uptime(),
    memoryUsage: () => process.memoryUsage(),
    tickTiming: typeof ctx.tickHandlerFn?.getMetrics === 'function' ? ctx.tickHandlerFn.getMetrics() : null,
    rooms: typeof ctx.roomDirectory?.getStatus === 'function' ? ctx.roomDirectory.getStatus() : undefined,
  })
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' }); res.end(body)
}

export function handleBenchmark(req, res, ctx) {
  try {
    const data = collectBenchmark(ctx)
    const json = JSON.stringify(data)
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(json)
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'benchmark collection failed', detail: err.message }))
  }
}

export function handleFreddieViz(req, res, appRuntime) {
  const _tok = process.env.EDITOR_TOKEN
  if (_tok && !timingSafeTokenEqual(req.headers['x-editor-token'], _tok)) { res.writeHead(403); res.end('forbidden'); return }
  const _FREDDIE_MAX = 256 * 1024
  let _len = 0, _over = false
  const chunks = []
  req.on('data', d => {
    if (_over) return
    _len += d.length
    if (_len > _FREDDIE_MAX) { _over = true; res.writeHead(413); res.end('payload too large'); req.destroy(); return }
    chunks.push(d)
  })
  req.on('end', () => {
    if (_over) return
    let body
    try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch (_) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid JSON' })); return }
    const messages = Array.isArray(body) ? body : [body]
    const results = []
    for (const msg of messages) {
      const v = validateMessage(msg)
      if (!v.valid) { results.push({ id: msg.id, ok: false, error: 'validation failed', detail: v.errors }); continue }
      try {
        if (msg.kind === KIND_PLACE) {
          const p = msg.payload
          const entityId = p.entityId
          if (appRuntime.entities.has(entityId)) appRuntime.destroyEntity(entityId)
          const cfg = {
            position: p.position || [0, 0, 0],
            scale: p.scale || [1, 1, 1],
            custom: {
              mesh: p.primitive || 'box',
              color: p.color ?? 0xffffff,
              emissive: p.emissive ?? 0x000000,
              opacity: p.opacity ?? 1,
              label: p.label || null,
              _freddieSource: msg.source,
              _freddieId: entityId,
            },
            config: {},
          }
          if (p.primitive === 'model' && p.model) cfg.model = p.model
          appRuntime.spawnEntity(entityId, cfg)
          results.push({ id: msg.id, ok: true, entityId })
        } else if (msg.kind === KIND_UPDATE) {
          const p = msg.payload
          const e = appRuntime.entities.get(p.entityId)
          if (!e) { results.push({ id: msg.id, ok: false, error: 'entity not found', entityId: p.entityId }); continue }
          if (p.position) e.position = [...p.position]
          if (p.scale) e.scale = [...p.scale]
          if (e.custom) {
            if (p.color !== undefined) e.custom.color = p.color
            if (p.emissive !== undefined) e.custom.emissive = p.emissive
            if (p.opacity !== undefined) e.custom.opacity = p.opacity
            if (p.label !== undefined) e.custom.label = p.label
          }
          results.push({ id: msg.id, ok: true, entityId: p.entityId })
        } else if (msg.kind === KIND_REMOVE) {
          appRuntime.destroyEntity(msg.payload.entityId)
          results.push({ id: msg.id, ok: true, entityId: msg.payload.entityId })
        } else if (msg.kind === KIND_CLEAR) {
          const source = msg.source
          const toRemove = []
          for (const [id, e] of appRuntime.entities) {
            if (e.custom?._freddieSource === source) toRemove.push(id)
          }
          for (const id of toRemove) appRuntime.destroyEntity(id)
          results.push({ id: msg.id, ok: true, removed: toRemove.length })
        } else {
          results.push({ id: msg.id, ok: false, error: `unhandled kind: ${msg.kind}` })
        }
      } catch (e) {
        results.push({ id: msg.id, ok: false, error: e.message })
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(Array.isArray(body) ? results : results[0]))
  })
}
