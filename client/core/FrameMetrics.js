// FrameMetrics -- the per-frame measurement/adaptation controllers, extracted from app.js so the
// frame loop reads as named ticks instead of ~95 lines of stats + hysteresis plumbing. Pure move:
// each controller closes over ZERO boot state (its methods take explicit args) and keeps writing its own
// window.__* debug mirror. None is a RenderGraph node -- they run in animate() AFTER renderGraph.run(),
// outside the graph. Matches the CullingHub/ShadowPipeline/RuntimeStats factory + window.__install pattern.
// The knobs (dprAuto/dprOff/dpr, fogFar/fogAdaptOff) are catalogued in RenderControls.js.

// Allocation-free ring-buffer frame-time tracker, read via window.__perf.stats().
//
// GC-pressure audit (gc-pressure-audit-offscreencanvas-frame-pacing): allocation-rate tracking is
// bolted on here rather than as a separate module because it needs to sample once per animate() tick,
// same call site as the existing ms sample -- a second per-frame hook would just be another allocation
// surface to audit. Sampling itself must stay allocation-free (same discipline as the ms ring above):
// a second Float32Array ring for heap-delta-per-frame, no per-sample object/array creation.
// performance.memory (Chrome/Chromium-only, non-standard but present in every real dev/CI target this
// repo runs against -- see RenderControls.js's existing BUILD-HEAP probe) is the only in-browser signal
// for actual JS heap growth; feature-detected once at tracker-creation, not per frame.
const _HAS_HEAP = typeof performance !== 'undefined' && !!performance.memory
export function createPerfTracker() {
  const N = 240, ring = new Float32Array(N), sortBuf = new Float32Array(N)
  let idx = 0, count = 0, lastMs = 0, drawCalls = 0, tris = 0, players = 0, entities = 0
  const _sessionSamples = []
  // Allocation-rate ring: heapRing[i] = (usedJSHeapSize delta since previous frame, bytes), clamped to
  // >=0 (a GC pause between frames drops usedJSHeapSize, which is a real free-not-alloc event, not a
  // negative allocation -- clamping avoids that from washing out the running average below zero).
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
          // bytes/sec at the CURRENT measured fps -- the actual GC-pressure figure (allocator work the
          // GC has to keep up with), not just a per-frame count that means nothing without frame rate.
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

// Vsync-miss detector -- distinct from a plain "long frame" flag. A long frame means JS work itself
// (render + sim + adapt, i.e. _perf.lastMs) was slow. A vsync MISS means the rAF-to-rAF PRESENT interval
// (the wall-clock gap between consecutive requestAnimationFrame timestamps) exceeded what the display's
// actual refresh interval allows, even though JS work was short -- the frame was ready in time but the
// compositor/GPU/driver failed to present it on the next vblank (a stall downstream of this code, not a
// CPU-bound one). Distinguishing the two matters because the fix differs: a long frame is addressed by
// cutting JS/draw-call cost (DPR/fog adaptation already do that); a vsync miss with short JS work points
// at GPU-side contention (another process, driver overhead, thermal throttle) no amount of JS-side
// cost-cutting touches.
//
// Refresh interval source: screen.refreshRate is not a standard/implemented browser API as of this
// writing (proposed Window Management API only, no stable ship), so this ALWAYS falls back to inferring
// the interval from a rolling median of recent rAF-to-rAF deltas -- the median (not mean) is deliberately
// robust to the very misses/drops this detector is trying to flag (a handful of large outlier deltas from
// real misses must not drag the assumed target interval upward and mask further misses). Re-inferred
// continuously (not just once at boot) since a display can genuinely change refresh rate (adaptive sync,
// external monitor swap) and a fixed boot-time constant would then misclassify every frame afterward.
export function createVsyncMonitor() {
  const N = 120                        // rolling window for the refresh-interval median
  const deltas = new Float32Array(N)
  let idx = 0, filled = 0
  let lastTs = -1
  let inferredIntervalMs = 16.6667    // seeded at 60Hz until enough samples accrue
  const sortBuf = new Float32Array(N)
  let missStreak = 0, maxMissStreak = 0
  let missCount = 0, frameCount = 0
  const MISS_THRESHOLD = 1.5          // present gap must exceed 1.5x the inferred interval to count as a miss
  const JS_SHORT_FACTOR = 0.85        // JS work must be UNDER 0.85x the inferred interval to blame the compositor, not this frame's own JS
  const _recentMisses = []            // ring of the last few miss events, for window.__vsync.recent()
  const _vsyncMirror = { refreshIntervalMs: 0, refreshHz: 0, lastDeltaMs: 0, isMiss: false, isCompositorStall: false, missedFrames: 0, missCount: 0, missStreak: 0, maxMissStreak: 0, frameCount: 0, missRate: 0, recent: () => _recentMisses.slice() }
  const _vsyncResult = { isMiss: false, isCompositorStall: false, deltaMs: 0, expectedMs: 0, missedFrames: 0 }
  const MAX_RECENT = 20

  function _median() {
    if (filled === 0) return inferredIntervalMs
    for (let i = 0; i < filled; i++) sortBuf[i] = deltas[i]
    const a = sortBuf.subarray(0, filled); a.sort()
    return a[Math.floor(filled / 2)]
  }

  // tick(ts, jsMs): ts = the requestAnimationFrame callback's own timestamp arg (rAF-to-rAF gap IS the
  // real present-to-present interval the browser observed); jsMs = this frame's measured JS work
  // (_perf.lastMs -- render + sim + adapt), used only to classify a miss as compositor-side vs CPU-side.
  function tick(ts, jsMs) {
    frameCount++
    if (lastTs < 0) { lastTs = ts; return { isMiss: false, deltaMs: 0, expectedMs: inferredIntervalMs, missedFrames: 0 } }
    const deltaMs = ts - lastTs
    lastTs = ts
    // Feed the rolling median BEFORE classifying this frame, but only with plausible deltas -- a tab
    // backgrounded/unthrottled rAF can produce multi-second gaps that would otherwise permanently poison
    // the inferred interval upward (matches the ring-buffer clamp style used elsewhere in this file).
    if (deltaMs > 0 && deltaMs < 250) {
      deltas[idx] = deltaMs; idx = (idx + 1) % N; if (filled < N) filled++
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
      // Debug mirror mutated in place (one persistent object, raw numbers): the old per-frame object
      // literal + closure + four toFixed()/re-parse round trips were pure allocation for a value only a
      // console/inspector reads.
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

// Adaptive dynamic-resolution controller. Default OFF: downscaling masks the real draw cost instead of
// fixing it; opt in via window.__dprAuto=true.
export function createDprController() {
  const deviceMax = (typeof window !== 'undefined') ? Math.min(window.devicePixelRatio || 1, 2) : 1
  let scale = 1, applied = -1, acc = 0, n = 0
  const TARGET = 6.94                 // 144fps frame budget (ms)
  const WIN = 45                      // frames per evaluation window
  const MIN = 0.40, MAX = 1.0, STEP = 0.08
  function tick(renderer, ms) {
    if (typeof window === 'undefined' || !window.__dprAuto || window.__dprOff) return
    acc += ms; n++
    if (n < WIN) return
    const avg = acc / n; acc = 0; n = 0
    // hysteresis: lower when clearly over budget, raise only when comfortably under
    if (avg > TARGET * 1.15 && scale > MIN) scale = Math.max(MIN, scale - STEP)
    else if (avg < TARGET * 0.80 && scale < MAX) scale = Math.min(MAX, scale + STEP)
    const want = +(deviceMax * scale).toFixed(3)
    if (want !== applied) { try { renderer.setPixelRatio(want); applied = want } catch (_) {} }
    if (typeof window !== 'undefined') window.__dpr = { scale: +scale.toFixed(2), applied, deviceMax, avgMs: +avg.toFixed(2) }
  }
  return { tick }
}

// Adaptive TERRAIN internal-render-resolution controller -- the genuine "render at N%, present at
// 100%" decouple (see true-upscale-decoupled-render-resolution PRD row, follow-up to FSR1.js).
//
// WHY THIS IS DIFFERENT FROM createDprController ABOVE: that controller's renderer.setPixelRatio(scale)
// shrinks the WHOLE canvas drawing buffer -- terrain, THREE scene, and (implicitly) the final presented
// image all drop together, then the browser bilinear-stretches the entire small buffer back up to CSS
// size (the blur FSR1.js softens). This controller instead drives mapspinner's OWN pre-existing viewport
// dynamic-resolution mechanism (gl-render.js's `_vdrsOn`/`ensureVdrsTargets` -- window.__vdrs=true routes
// terrain+water into a FIXED-SIZE offscreen FBO, renders into a flexed sub-viewport at __vdrsScale <1,
// then a fullscreen-quad LINEAR upscale blits that sub-rect back to the canvas at its ACTUAL size). The
// canvas itself, and therefore renderer.setPixelRatio/THREE's own draw resolution, never changes -- only
// the terrain pass (the dominant per-pixel cost: full-screen VS+FS fractal evaluation every frame, see
// mapspinner's AGENTS.md "RUNTIME FPS is VERTEX-SHADER-bound") renders fewer pixels while the final
// composited/presented frame stays full native resolution. This is the real AMD-reference FSR1 use case
// (render at e.g. 70% linear resolution, upscale the OUTPUT to 100%) applied to the one draw pass that
// already has a resolution-decoupled target to render into; THREE's own scene-color pass still draws
// straight into the (always-full-res) canvas -- extending that to a genuinely lower-res THREE render
// target too needs the bigger single-canvas-draw-contract change documented in FSR1.js/DepthComposite.js,
// scoped out of this first slice.
//
// Default OFF (window.__vdrsAuto, RenderControls 'vdrsAuto'): downscaling masks real draw cost instead of
// fixing it, same opt-in discipline as dprAuto. window.__vdrsOff force-disables regardless.
export function createTerrainVdrsController() {
  let scale = 1, appliedOn = false, appliedScale = -1, acc = 0, n = 0
  const TARGET = 6.94                 // 144fps frame budget (ms), same target as createDprController
  const WIN = 45                      // frames per evaluation window
  const MIN = 0.5, MAX = 1.0, STEP = 0.1   // mapspinner clamps __vdrsScale to [0.3,1.0] itself; stay inside that range
  function tick(ms) {
    if (typeof window === 'undefined' || !window.__vdrsAuto || window.__vdrsOff) return
    acc += ms; n++
    if (n < WIN) return
    const avg = acc / n; acc = 0; n = 0
    if (avg > TARGET * 1.15 && scale > MIN) scale = Math.max(MIN, scale - STEP)
    else if (avg < TARGET * 0.80 && scale < MAX) scale = Math.min(MAX, scale + STEP)
    const on = scale < 0.999
    if (on !== appliedOn) { window.__vdrs = on; appliedOn = on }
    const wantScale = +scale.toFixed(3)
    if (on && wantScale !== appliedScale) { window.__vdrsScale = wantScale; appliedScale = wantScale }
    window.__terrainVdrs = { scale: +scale.toFixed(2), on, avgMs: +avg.toFixed(2) }
  }
  return { tick }
}

// Adaptive fog: pulls fog.far in only under sustained slow frames (hysteresis-gated so a single jittery
// frame can't thrash it); a fast device never changes.
//
// TIME-OF-DAY / WEATHER RECONCILIATION (fog-controller-time-of-day-integration): this is the ONLY writer
// of scene.fog.far -- a dawn/dusk atmospheric-haze effect or a future rain/snow visibility drop must NOT
// become a second uncoordinated writer racing the perf adapter (that would thrash fog.far between two
// owners each assuming they're the only one moving it). Instead, external callers PROPOSE a ceiling
// multiplier via setCeilMultiplier(source, factor) -- e.g. the time-of-day render-graph node calls
// setCeilMultiplier('timeOfDay', 0.55) at dawn/dusk (denser real-world haze at low sun angles) and
// setCeilMultiplier('timeOfDay', 1.0) at noon; the not-yet-shipped weather system would call
// setCeilMultiplier('weather', 0.4) during active rain. Multiple sources compose multiplicatively (fog
// gets denser, never fights itself back open) and the EFFECTIVE ceiling is
// min(configFar(), configFar() * min(all registered multipliers)) -- this controller alone still owns
// every actual write to fog.far, so perf-adaptation and atmosphere/weather-driven density are always
// reconciled through the same hysteresis/step logic rather than stomping each other.
//
// A lowered ceiling must be respected even while frames are comfortably fast (the old code only ever
// pulled fog.far in during a SLOW streak, so a tightening ceiling proposed while the device was fast
// would just be ignored -- fog.far would sit above the new ceiling indefinitely). Below, the fast-path
// clamps fog.far down to the ceiling immediately when the ceiling has dropped under the current value
// (a ceiling tightening is a deliberate, already-hysteresis-free decision made upstream by the day-cycle
// clock's own smooth per-frame lerp -- no separate hysteresis needed for a monotonic external signal),
// then still steps back UP toward the (possibly time-of-day-limited) ceiling only under the normal
// fast-frame hysteresis gate, same as before.
export function createFogController() {
  const FOG_SLOW_MS = 8.0             // sustained avg above this -> pull fog in
  const FOG_FAST_MS = 6.0             // sustained avg below this -> push fog back out
  const FOG_SLOW_FRAMES = 60          // frames the slow/fast condition must hold
  const FOG_HYST = 3                  // consecutive qualifying windows before a step
  const FOG_FAR_MIN = 120, FOG_FAR_DEFAULT = 200, FOG_STEP = 8
  let acc = 0, n = 0, slowStreak = 0, fastStreak = 0
  const _ceilMultipliers = new Map() // source name -> factor in (0,1]
  function setCeilMultiplier(source, factor) {
    if (typeof source !== 'string' || !source) return
    if (!Number.isFinite(factor) || factor <= 0) { _ceilMultipliers.delete(source); return }
    _ceilMultipliers.set(source, Math.min(1, factor))
  }
  function _combinedMultiplier() {
    let m = 1
    for (const f of _ceilMultipliers.values()) m *= f
    return m
  }
  function configFar() {
    const v = (typeof window !== 'undefined' && Number.isFinite(window.__fogFar)) ? window.__fogFar : FOG_FAR_DEFAULT
    return v
  }
  const _fogMirror = { far: 0, ceil: 0, baseCeil: 0, mult: 1, avgMs: 0 }
  function tick(scene, ms) {
    if (typeof window === 'undefined' || window.__fogAdaptOff) return
    const fog = scene && scene.fog
    if (!fog || typeof fog.far !== 'number') return
    const baseCeil = configFar()
    const mult = _combinedMultiplier()
    const ceil = Math.max(FOG_FAR_MIN, baseCeil * mult)
    // Respect a tightened ceiling immediately regardless of frame-time streak state -- a time-of-day/
    // weather-driven ceiling drop is an atmospheric-density decision, not a perf one, so it should not
    // wait on FOG_HYST slow-frame windows to take effect.
    if (fog.far > ceil) fog.far = ceil
    acc += ms; n++
    // window.__fogState is the documented debug/discovery mirror (RenderControls.js `fogState` knob) --
    // it must reflect the CURRENT ceil/mult/far every tick, not just once every FOG_SLOW_FRAMES (60)
    // samples. On a slow device (high avgMs) waiting for that window can take several real seconds,
    // during which the mirror shows stale pre-tightening data even though fog.far itself was ALREADY
    // clamped above -- caught live while verifying the time-of-day reconciliation (a >100ms/frame run
    // left window.__fogState reporting mult:1 long after the real ceiling had already tightened).
    if (typeof window !== 'undefined') { const f = _fogMirror; f.far = fog.far; f.ceil = ceil; f.baseCeil = baseCeil; f.mult = mult; f.avgMs = n > 0 ? acc / n : 0; if (window.__fogState !== f) window.__fogState = f }
    if (n < FOG_SLOW_FRAMES) return
    const avg = acc / n; acc = 0; n = 0
    if (avg > FOG_SLOW_MS) {
      slowStreak++; fastStreak = 0
      if (slowStreak >= FOG_HYST && fog.far > FOG_FAR_MIN) { fog.far = Math.max(FOG_FAR_MIN, fog.far - FOG_STEP); slowStreak = 0 }
    } else if (avg < FOG_FAST_MS) {
      fastStreak++; slowStreak = 0
      if (fastStreak >= FOG_HYST && fog.far < ceil) { fog.far = Math.min(ceil, fog.far + FOG_STEP); fastStreak = 0 }
    } else { slowStreak = 0; fastStreak = 0 }
    if (typeof window !== 'undefined') { const f = _fogMirror; f.far = fog.far; f.ceil = ceil; f.baseCeil = baseCeil; f.mult = mult; f.avgMs = avg; if (window.__fogState !== f) window.__fogState = f }
  }
  return { tick, setCeilMultiplier }
}
