const _HAS_HEAP = typeof performance !== 'undefined' && !!performance.memory
export function createPerfTracker() {
  const N = 240, ring = new Float32Array(N), sortBuf = new Float32Array(N)
  let idx = 0, count = 0, lastMs = 0, drawCalls = 0, tris = 0, players = 0, entities = 0
  const _sessionSamples = []
  const heapRing = _HAS_HEAP ? new Float32Array(N) : null
  let heapIdx = 0, heapCount = 0, lastHeap = _HAS_HEAP ? performance.memory.usedJSHeapSize : 0
  const perf = {
    get lastMs() { return lastMs },
    sample(ms, renderer, np, ne) {
      lastMs = ms; ring[idx] = ms; idx = (idx + 1) % N; if (count < N) count++
      const ri = renderer.info.render; drawCalls = ri.calls; tris = ri.triangles; players = np; entities = ne
      if (_sessionSamples.length < 10000) _sessionSamples.push(ms)
      if (_HAS_HEAP) {
        const cur = performance.memory.usedJSHeapSize
        const delta = cur - lastHeap; lastHeap = cur
        heapRing[heapIdx] = delta > 0 ? delta : 0
        heapIdx = (heapIdx + 1) % N; if (heapCount < N) heapCount++
      }
    },
    stats() {
      if (count === 0) return { count: 0 }
      for (let i = 0; i < count; i++) sortBuf[i] = ring[i]
      const a = sortBuf.subarray(0, count); a.sort()
      let sum = 0; for (let i = 0; i < count; i++) sum += a[i]
      const pct = p => a[Math.min(count - 1, Math.floor(p * count))]
      const avg = sum / count
      const out = { count, avgMs: +avg.toFixed(3), fps: +(1000 / avg).toFixed(1), p50Ms: +pct(0.5).toFixed(3), p95Ms: +pct(0.95).toFixed(3), p99Ms: +pct(0.99).toFixed(3), maxMs: +a[count - 1].toFixed(3), drawCalls, triangles: tris, players, entities }
      if (_HAS_HEAP && heapCount > 0) {
        let hsum = 0, hmax = 0
        for (let i = 0; i < heapCount; i++) { const v = heapRing[i]; hsum += v; if (v > hmax) hmax = v }
        const avgBytesPerFrame = hsum / heapCount
        out.gc = {
          avgBytesPerFrame: Math.round(avgBytesPerFrame),
          maxBytesPerFrame: Math.round(hmax),
          avgBytesPerSec: Math.round(avgBytesPerFrame * (1000 / avg)),
        }
      }
      return out
    },
    exportSession() {
      if (_sessionSamples.length === 0) return null
      const s = new Float64Array(_sessionSamples); s.sort()
      const sum = s.reduce((a, b) => a + b, 0)
      const pct = p => s[Math.min(s.length - 1, Math.floor(p * s.length))]
      return {
        duration: +(s.length / 60).toFixed(1),
        samples: s.length,
        avgMs: +(sum / s.length).toFixed(3),
        fps: +(1000 / (sum / s.length)).toFixed(1),
        minMs: +s[0].toFixed(3),
        p50Ms: +pct(0.5).toFixed(3),
        p95Ms: +pct(0.95).toFixed(3),
        p99Ms: +pct(0.99).toFixed(3),
        maxMs: +s[s.length - 1].toFixed(3)
      }
    },
    reset() { idx = 0; count = 0; _sessionSamples.length = 0; heapIdx = 0; heapCount = 0; if (_HAS_HEAP) lastHeap = performance.memory.usedJSHeapSize }
  }
  if (typeof window !== 'undefined') window.__perf = perf
  return perf
}

export function createVsyncMonitor() {
  const REFRESH_MEDIAN_WINDOW = 120
  const deltas = new Float32Array(REFRESH_MEDIAN_WINDOW)
  let idx = 0, filled = 0
  let lastTs = -1
  const SIXTY_HZ_INTERVAL_MS = 16.6667
  const MAX_PLAUSIBLE_PRESENT_GAP_MS = 250
  let inferredIntervalMs = SIXTY_HZ_INTERVAL_MS
  const sortBuf = new Float32Array(REFRESH_MEDIAN_WINDOW)
  let missStreak = 0, maxMissStreak = 0
  let missCount = 0, frameCount = 0
  const MISS_THRESHOLD = 1.5
  const JS_SHORT_FACTOR = 0.85
  const _recentMisses = []
  const _vsyncMirror = { refreshIntervalMs: 0, refreshHz: 0, lastDeltaMs: 0, isMiss: false, isCompositorStall: false, missedFrames: 0, missCount: 0, missStreak: 0, maxMissStreak: 0, frameCount: 0, missRate: 0, recent: () => _recentMisses.slice() }
  const _vsyncResult = { isMiss: false, isCompositorStall: false, deltaMs: 0, expectedMs: 0, missedFrames: 0 }
  const MAX_RECENT = 20

  function _median() {
    if (filled === 0) return inferredIntervalMs
    for (let i = 0; i < filled; i++) sortBuf[i] = deltas[i]
    const a = sortBuf.subarray(0, filled); a.sort()
    return a[Math.floor(filled / 2)]
  }

  function tick(ts, jsMs) {
    frameCount++
    if (lastTs < 0) { lastTs = ts; return { isMiss: false, deltaMs: 0, expectedMs: inferredIntervalMs, missedFrames: 0 } }
    const deltaMs = ts - lastTs
    lastTs = ts
    if (deltaMs > 0 && deltaMs < MAX_PLAUSIBLE_PRESENT_GAP_MS) {
      deltas[idx] = deltaMs; idx = (idx + 1) % REFRESH_MEDIAN_WINDOW; if (filled < REFRESH_MEDIAN_WINDOW) filled++
      inferredIntervalMs = _median()
    }
    const expectedMs = inferredIntervalMs
    const isMiss = deltaMs > expectedMs * MISS_THRESHOLD
    const missedFrames = isMiss ? Math.max(1, Math.round(deltaMs / expectedMs) - 1) : 0
    const jsWasShort = typeof jsMs === 'number' && jsMs < expectedMs * JS_SHORT_FACTOR
    const isCompositorStall = isMiss && jsWasShort
    if (isMiss) {
      missCount++; missStreak++
      if (missStreak > maxMissStreak) maxMissStreak = missStreak
      _recentMisses.push({ frame: frameCount, deltaMs: +deltaMs.toFixed(2), expectedMs: +expectedMs.toFixed(2), jsMs: typeof jsMs === 'number' ? +jsMs.toFixed(2) : null, compositorStall: isCompositorStall, missedFrames })
      if (_recentMisses.length > MAX_RECENT) _recentMisses.shift()
    } else missStreak = 0
    if (typeof window !== 'undefined') {
      const v = _vsyncMirror
      v.refreshIntervalMs = expectedMs; v.refreshHz = 1000 / expectedMs; v.lastDeltaMs = deltaMs
      v.isMiss = isMiss; v.isCompositorStall = isCompositorStall; v.missedFrames = missedFrames
      v.missCount = missCount; v.missStreak = missStreak; v.maxMissStreak = maxMissStreak; v.frameCount = frameCount
      v.missRate = frameCount > 0 ? missCount / frameCount : 0
      if (window.__vsync !== v) window.__vsync = v
    }
    _vsyncResult.isMiss = isMiss; _vsyncResult.isCompositorStall = isCompositorStall; _vsyncResult.deltaMs = deltaMs; _vsyncResult.expectedMs = expectedMs; _vsyncResult.missedFrames = missedFrames
    return _vsyncResult
  }
  function reset() { idx = 0; filled = 0; lastTs = -1; missStreak = 0; maxMissStreak = 0; missCount = 0; frameCount = 0; _recentMisses.length = 0 }
  return { tick, reset }
}

export function createDprController() {
  const deviceMax = (typeof window !== 'undefined') ? Math.min(window.devicePixelRatio || 1, 2) : 1
  let scale = 1, applied = -1, acc = 0, n = 0
  const FRAME_BUDGET_144HZ_MS = 6.94
  const FRAMES_PER_WINDOW = 45
  const LOWER_ABOVE_BUDGET = 1.15, RAISE_BELOW_BUDGET = 0.80
  const MIN = 0.40, MAX = 1.0, STEP = 0.08
  function tick(renderer, ms) {
    if (typeof window === 'undefined' || !window.__dprAuto || window.__dprOff) return
    acc += ms; n++
    if (n < FRAMES_PER_WINDOW) return
    const avg = acc / n; acc = 0; n = 0
    if (avg > FRAME_BUDGET_144HZ_MS * LOWER_ABOVE_BUDGET && scale > MIN) scale = Math.max(MIN, scale - STEP)
    else if (avg < FRAME_BUDGET_144HZ_MS * RAISE_BELOW_BUDGET && scale < MAX) scale = Math.min(MAX, scale + STEP)
    const want = +(deviceMax * scale).toFixed(3)
    if (want !== applied) { try { renderer.setPixelRatio(want); applied = want } catch (_) {} }
    if (typeof window !== 'undefined') window.__dpr = { scale: +scale.toFixed(2), applied, deviceMax, avgMs: +avg.toFixed(2) }
  }
  return { tick }
}

export function createTerrainVdrsController() {
  let scale = 1, appliedOn = false, appliedScale = -1, acc = 0, n = 0
  const FRAME_BUDGET_144HZ_MS = 6.94
  const FRAMES_PER_WINDOW = 45
  const LOWER_ABOVE_BUDGET = 1.15, RAISE_BELOW_BUDGET = 0.80
  const MIN = 0.5, MAX = 1.0, STEP = 0.1
  function tick(ms) {
    if (typeof window === 'undefined' || !window.__vdrsAuto || window.__vdrsOff) return
    acc += ms; n++
    if (n < FRAMES_PER_WINDOW) return
    const avg = acc / n; acc = 0; n = 0
    if (avg > FRAME_BUDGET_144HZ_MS * LOWER_ABOVE_BUDGET && scale > MIN) scale = Math.max(MIN, scale - STEP)
    else if (avg < FRAME_BUDGET_144HZ_MS * RAISE_BELOW_BUDGET && scale < MAX) scale = Math.min(MAX, scale + STEP)
    const on = scale < 0.999
    if (on !== appliedOn) { window.__vdrs = on; appliedOn = on }
    const wantScale = +scale.toFixed(3)
    if (on && wantScale !== appliedScale) { window.__vdrsScale = wantScale; appliedScale = wantScale }
    window.__terrainVdrs = { scale: +scale.toFixed(2), on, avgMs: +avg.toFixed(2) }
  }
  return { tick }
}

export function createFogController() {
  const SLOW_FRAME_MS = 8.0
  const FAST_FRAME_MS = 6.0
  const FRAMES_PER_WINDOW = 60
  const WINDOWS_BEFORE_STEP = 3
  const FOG_FAR_MIN = 120, FOG_FAR_DEFAULT = 200, FOG_STEP = 8
  let accumulatedMs = 0, framesInWindow = 0, slowStreak = 0, fastStreak = 0
  let trackedFog = null, nearToFarRatio = 0, perfFar = Infinity
  const ceilingMultipliers = new Map()
  function setCeilMultiplier(source, factor) {
    if (typeof source !== 'string' || !source) return
    if (!Number.isFinite(factor) || factor <= 0) { ceilingMultipliers.delete(source); return }
    ceilingMultipliers.set(source, Math.min(1, factor))
  }
  function combinedMultiplier() {
    let m = 1
    for (const f of ceilingMultipliers.values()) m *= f
    return m
  }
  function configFar() {
    return (typeof window !== 'undefined' && Number.isFinite(window.__fogFar)) ? window.__fogFar : FOG_FAR_DEFAULT
  }
  function adoptFog(fog) {
    trackedFog = fog
    const ratio = fog.near / fog.far
    const bandIsValid = ratio >= 0 && ratio < 1
    if (!bandIsValid) console.error('[fog] configured near', fog.near, 'is not below far', fog.far, '-- linear fog would paint every object in the fog colour; starting fog at the camera instead')
    nearToFarRatio = bandIsValid ? ratio : 0
    perfFar = Infinity
  }
  function applyBand(fog, far) {
    fog.far = far
    fog.near = far * nearToFarRatio
  }
  const fogMirror = { near: 0, far: 0, ceil: 0, baseCeil: 0, mult: 1, perfFar: 0, avgMs: 0 }
  function publishMirror(fog, ceil, baseCeil, mult, avgMs) {
    const f = fogMirror
    f.near = fog.near; f.far = fog.far; f.ceil = ceil; f.baseCeil = baseCeil; f.mult = mult; f.perfFar = perfFar; f.avgMs = avgMs
    if (window.__fogState !== f) window.__fogState = f
  }
  function tick(scene, ms) {
    if (typeof window === 'undefined' || window.__fogAdaptOff) return
    const fog = scene && scene.fog
    if (!fog || fog.isFog !== true) return
    if (fog !== trackedFog) adoptFog(fog)
    const baseCeil = configFar()
    const mult = combinedMultiplier()
    const ceil = Math.max(FOG_FAR_MIN, baseCeil * mult)
    perfFar = Math.min(Math.max(perfFar, FOG_FAR_MIN), Math.max(FOG_FAR_MIN, baseCeil))
    applyBand(fog, Math.min(perfFar, ceil))
    accumulatedMs += ms; framesInWindow++
    if (framesInWindow < FRAMES_PER_WINDOW) { publishMirror(fog, ceil, baseCeil, mult, accumulatedMs / framesInWindow); return }
    const avg = accumulatedMs / framesInWindow; accumulatedMs = 0; framesInWindow = 0
    if (avg > SLOW_FRAME_MS) {
      slowStreak++; fastStreak = 0
      if (slowStreak >= WINDOWS_BEFORE_STEP) { perfFar = Math.max(FOG_FAR_MIN, fog.far - FOG_STEP); slowStreak = 0 }
    } else if (avg < FAST_FRAME_MS) {
      fastStreak++; slowStreak = 0
      if (fastStreak >= WINDOWS_BEFORE_STEP) { perfFar = Math.min(baseCeil, perfFar + FOG_STEP); fastStreak = 0 }
    } else { slowStreak = 0; fastStreak = 0 }
    applyBand(fog, Math.min(perfFar, ceil))
    publishMirror(fog, ceil, baseCeil, mult, avg)
  }
  return { tick, setCeilMultiplier }
}
