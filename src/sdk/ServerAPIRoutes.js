// HTTP route handlers for ServerAPI.js's start(): /upload-model, /debug-log, /client-error,
// /debug/server, /metrics, /benchmark, /freddie/viz. Split out because start()'s httpHandler
// closure was the single largest contiguous block in ServerAPI.js -- each handler here is a pure
// function of (req, res, ctx-derived state), no shared closure with the rest of ServerAPI.js beyond
// what's passed in explicitly.

import { timingSafeTokenEqual } from './authCompare.js'
import { renderMetrics } from './Metrics.js'
import { collectBenchmark } from './PublicBenchmark.js'
import { validateMessage, KIND_PLACE, KIND_UPDATE, KIND_REMOVE, KIND_CLEAR } from './FreddieBridge.js'

// Per-IP token bucket for /debug-log: caps sustained log-line volume from any single origin even after
// the loopback/EDITOR_TOKEN gate passes, so a single misbehaving/malicious client on an allowed origin
// can't still spam the server console / consume CPU by hammering the endpoint at wire speed.
const DEBUG_LOG_BUCKET_CAPACITY = 20 // burst allowance, lines
const DEBUG_LOG_BUCKET_REFILL_PER_SEC = 5 // steady-state cap, lines/sec
const _debugLogBuckets = new Map() // ip -> { tokens, lastRefillMs }

function debugLogRateLimited(ip) {
  const now = Date.now()
  let b = _debugLogBuckets.get(ip)
  if (!b) { b = { tokens: DEBUG_LOG_BUCKET_CAPACITY, lastRefillMs: now }; _debugLogBuckets.set(ip, b) }
  const elapsedSec = (now - b.lastRefillMs) / 1000
  if (elapsedSec > 0) {
    b.tokens = Math.min(DEBUG_LOG_BUCKET_CAPACITY, b.tokens + elapsedSec * DEBUG_LOG_BUCKET_REFILL_PER_SEC)
    b.lastRefillMs = now
  }
  if (b.tokens < 1) return true // no tokens left -> rate limited
  b.tokens -= 1
  return false
}

// Per-IP token bucket for /client-error: same shape as debugLogRateLimited above, but this
// endpoint is PUBLIC (real deployed players, not loopback-only dev tooling) so the bucket is the
// only defense against a hostile or buggy client flooding the server with crash reports -- tighter
// than the debug-log bucket since a real crash storm (e.g. every connected player hitting the same
// bug at once) should still log a representative sample, not every single occurrence.
const CLIENT_ERROR_BUCKET_CAPACITY = 5
const CLIENT_ERROR_BUCKET_REFILL_PER_SEC = 0.2 // 1 report per 5s steady-state per IP
const _clientErrorBuckets = new Map() // ip -> { tokens, lastRefillMs }

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
  // gated: loopback origin is always allowed (local dev console passthrough); a non-loopback
  // origin must present a valid X-Editor-Token when EDITOR_TOKEN is configured, and is refused
  // outright when it isn't (an unset EDITOR_TOKEN must not leave this endpoint open to the world).
  const _remote = req.socket?.remoteAddress || ''
  const _isLoopback = _remote === '127.0.0.1' || _remote === '::1' || _remote === '::ffff:127.0.0.1'
  if (!_isLoopback) {
    const _tok = process.env.EDITOR_TOKEN
    if (!_tok || !timingSafeTokenEqual(req.headers['x-editor-token'], _tok)) { res.writeHead(403); res.end('forbidden'); return }
  }
  // token-bucket rate limit per-IP: caps sustained lines/sec even from an already-authorized origin
  if (debugLogRateLimited(_remote)) { res.writeHead(429); res.end('rate limited'); return }
  // size-capped: unbounded body buffering here let any origin exhaust server memory
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
  // PUBLIC, opt-in-only-on-the-CLIENT-side endpoint (client/core/ErrorTelemetry.js) --
  // unlike /debug-log and /upload-model above, this is intentionally reachable from any
  // real deployed player, not loopback/EDITOR_TOKEN-gated, since the whole point is to
  // hear from crashes on machines the operator has no console access to. The gate here is
  // purely anti-abuse (rate limit + size cap), not an identity/auth check -- the payload
  // itself carries no PII by construction (see ErrorTelemetry.js's schema comment).
  const _remote = req.socket?.remoteAddress || ''
  if (clientErrorRateLimited(_remote)) { res.writeHead(429); res.end('rate limited'); return }
  const _CLIENT_ERROR_MAX = 16 * 1024 // payload is a small structured JSON object, not a log dump
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
      // Structured, one-line-per-report console surface (an operator greps/aggregates
      // this today; a real dashboard/store is explicitly out of scope for this first
      // slice -- see the sibling PRD row filed for that). kind/message/stack/url/ua/ts
      // are the ErrorTelemetry.js schema fields; renderControls/deviceTier are attached
      // objects, logged inline so `console.log`'s default object formatting keeps them
      // inspectable rather than flattened into an unreadable string.
      console.error(`[client-error] ${report.kind || 'error'}: ${String(report.message || '').slice(0, 500)}`,
        { url: report.url, ua: report.ua, stack: String(report.stack || '').slice(0, 2000), renderControls: report.renderControls, deviceTier: report.deviceTier, remote: _remote })
    } catch (_) { /* malformed payload from a hostile/buggy client -- drop silently, still 200 so sendBeacon doesn't retry-storm */ }
    res.writeHead(200); res.end()
  })
}

export function handleDebugServer(req, res, ctx) {
  // loopback-only: leaks tick/player/entity/session counts + process memory internals
  const remote = req.socket?.remoteAddress || ''
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') { res.writeHead(403); res.end('forbidden'); return }
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
  // server-scale-prometheus-metrics-endpoint-dashboard: same loopback-only gate as /debug/server
  // immediately above -- this leaks the identical class of operational internals (tick/player/
  // entity counts, process memory), just reformatted for Prometheus scrape instead of a one-shot
  // JSON GET. A Prometheus server itself is expected to run co-located (or reached via an
  // operator-controlled reverse-proxy/tunnel that terminates on loopback), matching how every
  // other loopback-gated route in this file is already meant to be consumed.
  const remote = req.socket?.remoteAddress || ''
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') { res.writeHead(403); res.end('forbidden'); return }
  const { tickSystem, playerManager, appRuntime, sessions } = ctx
  const body = renderMetrics({
    tick: tickSystem.currentTick,
    tickRate: ctx.tickRate,
    players: playerManager.getPlayerCount(),
    entities: appRuntime.entities.size,
    sessionCount: sessions.getActiveCount(),
    uptimeSec: process.uptime(),
    memoryUsage: () => process.memoryUsage(),
    // TickHandler.js's onTick.getMetrics() -- see ctx.tickHandlerFn (server.js/WorkerEntry.js
    // setTickHandler), a stable alias reload-swappable handlerState.fn is mirrored onto so this
    // route never reaches into reload-internal plumbing directly. Absent (fresh boot before the
    // first tick, or a handler build that predates this alias) degrades to no tickTiming section
    // rather than throwing -- /metrics must stay a safe, always-200 operational surface.
    tickTiming: typeof ctx.tickHandlerFn?.getMetrics === 'function' ? ctx.tickHandlerFn.getMetrics() : null,
    // RoomDirectory (src/sdk/RoomDirectory.js) is a standalone, opt-in multi-room primitive not
    // constructed by every boot path -- its own getStatus() doc comment already names this route
    // as its intended consumer, so a caller that DOES wire one up onto ctx.roomDirectory gets
    // per-room rows for free with zero further ServerAPI.js changes; every other boot path simply
    // omits the rooms section (Array.isArray guard in renderMetrics).
    rooms: typeof ctx.roomDirectory?.getStatus === 'function' ? ctx.roomDirectory.getStatus() : undefined,
  })
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' }); res.end(body)
}

export function handleBenchmark(req, res, ctx) {
  // Public benchmark endpoint (see PRD rows ugc-platform + ugc-public-benchmark-dashboard):
  // exposes standardized server performance data as JSON with CORS headers so a static HTML
  // dashboard page (client/benchmark.html) can consume it from any origin. Deliberately UN-gated
  // (no loopback/EDITOR_TOKEN check) -- this is a public brag surface, not an operational secret.
  // The data shape is deliberately high-level (tick stats, player counts, memory, build info) and
  // carries zero PII, internal IPs, auth tokens, or player-identifying data.
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
  // FreddieBridge viz endpoint: accepts FreddieBridge messages (JSON), validates them,
  // and creates/updates/destroys entities in the live world. EDITOR_TOKEN-gated when
  // configured (same discipline as /upload-model above); an unset EDITOR_TOKEN leaves
  // this endpoint open (dev default). Rate-limited by body size for safety.
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
    // Accept a single message or an array of messages
    const messages = Array.isArray(body) ? body : [body]
    const results = []
    for (const msg of messages) {
      const v = validateMessage(msg)
      if (!v.valid) { results.push({ id: msg.id, ok: false, error: 'validation failed', detail: v.errors }); continue }
      try {
        if (msg.kind === KIND_PLACE) {
          const p = msg.payload
          const entityId = p.entityId
          // Remove existing entity with same id if present (idempotent place)
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
          // Remove all entities created by this source
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
