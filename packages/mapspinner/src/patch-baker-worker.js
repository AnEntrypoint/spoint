import { createPatchBaker } from './patch-baker.js'

const POLL_INTERVAL_MS = 2
const BAKE_PROGRAM_RETRY_MS = 50
const STALLED_READBACK_MS = 20000
const BAKE_PROGRAM_DEADLINE_MS = 180000

let bakerReady = null
let failed = false
const queue = []
let issued = 0
let pumpTimer = 0
let lastProgressAt = 0
let firstQueuedAt = 0
let everIssued = false
const stats = { baked: 0, maxPollMs: 0, pollMs: 0 }

const tileKey = (face, ox, oy, l, level) => face + ':' + ox + ':' + oy + ':' + l + ':' + level

function schedulePump(ms) { if (!pumpTimer && !failed) pumpTimer = setTimeout(pump, ms) }

function fail(reason) {
  failed = true
  queue.length = 0
  self.postMessage({ type: 'failed', reason })
}

function pump() {
  pumpTimer = 0
  const g = self
  const now = performance.now()
  for (;;) {
    const done = g.__thcBakePollAsync()
    if (!done) break
    issued--; stats.baked++; lastProgressAt = performance.now()
    self.postMessage({ type: 'tile', key: tileKey(done.face, done.ox, done.oy, done.l, done.level), heights: done.heights }, [done.heights.buffer])
  }
  const dt = performance.now() - now
  stats.pollMs += dt; if (dt > stats.maxPollMs) stats.maxPollMs = dt
  if (issued > 0 && now - lastProgressAt > STALLED_READBACK_MS) { fail('readback fences unsignalled for ' + STALLED_READBACK_MS + ' ms (context lost?)'); return }
  if (!everIssued && queue.length && now - firstQueuedAt > BAKE_PROGRAM_DEADLINE_MS) { fail('bake program never became ready within ' + BAKE_PROGRAM_DEADLINE_MS + ' ms'); return }
  let issuedNow = 0
  while (queue.length) {
    const m = queue[0]
    if (!g.__thcBakeIssueAsync(m.face, m.ox, m.oy, m.l, m.level, true)) break
    queue.shift()
    if (issued === 0) lastProgressAt = performance.now()
    issued++; issuedNow++; everIssued = true
  }
  if (issuedNow) g.__thcBakeFlush()
  if (issued > 0) schedulePump(POLL_INTERVAL_MS)
  else if (queue.length) schedulePump(BAKE_PROGRAM_RETRY_MS)
}

self.onmessage = async (e) => {
  const m = e.data
  if (m.type === 'init') {
    bakerReady = createPatchBaker(m.opts).catch((err) => { console.warn('[patch-baker-worker] init failed:', err && err.message || err); return null })
    const baker = await bakerReady
    const asyncReadback = typeof self.__thcBakeIssueAsync === 'function' && typeof self.__thcBakePollAsync === 'function'
    self.postMessage({ type: 'ready', ok: !!baker && asyncReadback, res: baker ? baker.res : 0 })
    return
  }
  if (m.type === 'bake') {
    const baker = bakerReady && await bakerReady
    if (!baker || failed) { self.postMessage({ type: 'tile', key: m.key, heights: null }); return }
    if (!queue.length && !everIssued) firstQueuedAt = performance.now()
    queue.push(m)
    schedulePump(0)
    return
  }
  if (m.type === 'stats') self.postMessage({ type: 'stats', stats: { ...stats, queued: queue.length, issued, failed } })
}
