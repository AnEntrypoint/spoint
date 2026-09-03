// OcclusionQueryBudget -- one shared per-frame GPU occlusion-query issue budget arbiter across every
// consumer that opens a raw WebGL2 occlusion query this frame: TerrainOcclusion.js (own raw-GL
// issuer, default 32/frame), SceneOcclusion.js (streaming-gltf's vendored OcclusionQueryTier, default
// 16/frame), and ModelPoolAdapter's internal ModelPool occlusion tier (a THIRD independent
// OcclusionQueryTier instance inside packages/streaming-gltf, default 32/frame via
// occlusionMinCandidates config -- see client/ModelPoolAdapter.js). Uncoordinated, these three could
// issue up to ~80 raw beginQuery/drawElements/endQuery driver round-trips in the SAME frame, each a
// real GPU command-submission cost concentrated on ANGLE/D3D11 (SceneOcclusion.js's own comment:
// "GPU command execution measured ~92% saturated when its budget was halved" -- the three budgets
// already interact through the same GPU, just never through a shared ceiling).
//
// This module does NOT issue queries itself -- it only decides each consumer's maxQueriesPerFrame
// for the CURRENT frame. GPU-TIME-DRIVEN (not candidate-count-driven, see below for why that was
// replaced): reportFrameTime(ms) feeds the real per-frame cost (client/core/FrameMetrics.js's
// window.__perf.lastMs -- the only GPU-time estimate this client has; there is no
// EXT_disjoint_timer_query GPU timer anywhere in the codebase, confirmed via codesearch, so frame
// wall-clock time is the intended proxy: AGENTS.md's own perf doctrine already establishes "RUNTIME
// FPS is VERTEX-SHADER-bound (96% VS+raster)" for this renderer, meaning frame time closely tracks
// real GPU cost here). The total combined budget scales UP as frame time rises above a slow-frame
// threshold (a slow frame benefits more from aggressive occlusion culling -- the queries' own GPU
// cost is worth paying because they cut MORE real draw-call/vertex cost than they add), and queries
// are SKIPPED ENTIRELY (every consumer allocated 0) below a fast-frame threshold, since occlusion
// queries themselves cost real GPU time (beginQuery/drawElements/endQuery driver round-trips) that is
// pure waste on a frame with nothing to save -- spending GPU time to decide what to cull is only
// worthwhile when the frame is expensive enough that culling more aggressively could pay for itself.
//
// PRIOR DESIGN (candidate-count-proportional) and why it was replaced: the total budget was a fixed
// constant (opts.totalBudget, default 64) split proportionally by each consumer's live candidate
// count, with zero connection to how expensive the frame actually was. A frame already running at
// 3ms (300+ fps headroom) issued exactly as many queries as a frame running at 25ms (40fps, real
// budget pressure) -- the query cost was invariant to whether it was needed at all. This module now
// answers "is culling worth its own GPU cost THIS frame" from the frame's real measured cost, not
// from candidate volume alone (candidate count still decides the PER-CONSUMER split of whatever
// total is granted -- see splitByCandidates below -- since a consumer with zero live candidates still
// gets nothing useful from a query issued for it, but candidate count no longer decides IF queries
// run or the overall ceiling).
//
// Caller wiring (per consumer, once per frame, BEFORE that consumer's own runQueries/runOcclusionQueries):
//   budget.reportFrameTime(window.__perf.lastMs)   // or any other real per-frame ms source
//   budget.apply('terrain', terrainOcclusion.setMaxQueriesPerFrame)
//   budget.apply('scene', n => sceneOcclusion.setMaxQueriesPerFrame(n))   // see SceneOcclusion.js wiring below
//   budget.apply('modelPool', n => modelPoolAdapter.setOcclusionQueryBudget(n))
// and once per frame AFTER every consumer's own getStats() has run:
//   budget.reportCandidates('terrain', terrainOcclusion.getStats().candidates)
//   budget.reportCandidates('scene', sceneOcclusion.getStats().candidates)
//   budget.reportCandidates('modelPool', modelPoolAdapter.getStats().candidates)
//
// Wired live in client/core/RenderGraph.nodes.js's 'visibility-commit' node (reportFrameTime from
// ctx.perfLastMs, apply() called immediately before each consumer's own query pass, reportCandidates
// called immediately after via each consumer's getStats()).

export function createOcclusionQueryBudget(opts = {}) {
  // Below this per-frame cost (ms), occlusion queries are skipped ENTIRELY (every consumer gets 0
  // for this frame) -- the frame already has enough headroom that the GPU time occlusion queries
  // themselves cost is not worth spending; there is nothing meaningfully expensive left to cull away.
  // Default 6ms ~= 166fps-equivalent frame budget, comfortably faster than typical 60fps (16.6ms) or
  // even the codebase's own 144fps target (6.94ms, see FrameMetrics.js's createDprController TARGET)
  // -- a frame already this fast is not GPU-bound on draw cost, so occlusion culling has nothing to
  // buy back.
  const fastFrameSkipMs = opts.fastFrameSkipMs ?? 6
  // Frame cost (ms) at/above which the total budget reaches its MAXIMUM (maxTotalBudget below).
  // Default 20ms ~= 50fps-equivalent -- a frame this slow has real draw-call/vertex cost to cull
  // away, so spending more GPU time on more aggressive occlusion queries is worth it.
  const slowFrameMs = opts.slowFrameMs ?? 20
  // Total combined issue budget across every registered consumer at/above slowFrameMs. Default 96
  // (up from the old flat 64): a genuinely slow frame is exactly the regime where paying more query
  // cost to cull more aggressively earns its keep.
  const maxTotalBudget = opts.maxTotalBudget ?? 96
  // Total combined issue budget floor once queries are running at all (just above fastFrameSkipMs).
  // Default 24: roughly a third of maxTotalBudget -- queries ramp in gently rather than jumping
  // straight from 0 to a large budget the instant the frame crosses the skip threshold.
  const minTotalBudget = opts.minTotalBudget ?? 24
  // Per-consumer floor: even a candidate-starved consumer keeps this many queries/frame (while
  // queries are running at all -- see fastFrameSkipMs) so a just-appeared candidate set isn't stuck
  // at 0 issue rate until the next proportional recompute.
  const perConsumerFloor = opts.perConsumerFloor ?? 4

  const _consumers = new Map()   // name -> { candidates: number, lastAllocated: number }
  let _lastFrameMs = 0
  let _lastTotalBudget = 0

  function _ensure(name) {
    let c = _consumers.get(name)
    if (!c) { c = { candidates: 0, lastAllocated: 0 }; _consumers.set(name, c) }
    return c
  }

  // Report this consumer's candidate count for THIS frame (called after its own runQueries/getStats
  // resolves candidate count) -- feeds next frame's proportional split of whatever total budget the
  // frame-time gate grants.
  function reportCandidates(name, count) {
    _ensure(name).candidates = Number.isFinite(count) && count > 0 ? count : 0
  }

  // Report the real measured cost of the last completed frame (ms) -- the GPU-time estimate this
  // arbiter scales from. Call once per frame with a real value (e.g. window.__perf.lastMs from
  // FrameMetrics.js's createPerfTracker) before apply() for any consumer. A non-finite/negative value
  // is ignored (keeps the last known-good reading rather than collapsing the budget to the
  // fail-open/fail-skip default on a single bad sample).
  function reportFrameTime(ms) {
    if (Number.isFinite(ms) && ms >= 0) _lastFrameMs = ms
  }

  // Total combined budget for the CURRENT frame, derived from the last-reported frame time:
  //   < fastFrameSkipMs        -> 0 (queries skipped entirely this frame)
  //   fastFrameSkipMs..slowFrameMs -> linear ramp minTotalBudget..maxTotalBudget
  //   >= slowFrameMs            -> maxTotalBudget (capped, no unbounded growth on an extreme stall)
  function _computeTotalBudget() {
    if (_lastFrameMs < fastFrameSkipMs) return 0
    if (_lastFrameMs >= slowFrameMs) return maxTotalBudget
    const span = slowFrameMs - fastFrameSkipMs
    const t = span > 0 ? (_lastFrameMs - fastFrameSkipMs) / span : 1
    return Math.round(minTotalBudget + (maxTotalBudget - minTotalBudget) * t)
  }

  // Compute and apply this frame's allocation for one consumer, calling `setBudgetFn(n)` with the
  // resulting integer budget. The TOTAL available this frame comes from _computeTotalBudget() (real
  // GPU-time-derived, see above); that total is then split across registered consumers proportional
  // to each one's last-reported candidate count, floored per-consumer, capped so the SUM across all
  // registered consumers never exceeds the frame's total (floors are honored first, remaining budget
  // above the floor sum is split proportionally by candidate share among consumers that have
  // candidates). When the frame-time gate yields 0 (fast frame), every consumer gets 0 regardless of
  // candidate count -- the skip is unconditional, not just a floor reduction.
  function apply(name, setBudgetFn) {
    const self = _ensure(name)
    const totalBudget = _computeTotalBudget()
    _lastTotalBudget = totalBudget
    let allocated
    if (totalBudget <= 0) {
      allocated = 0
    } else {
      const names = [..._consumers.keys()]
      const totalCandidates = names.reduce((sum, n) => sum + _consumers.get(n).candidates, 0)
      const floorSum = names.length * perConsumerFloor
      const remaining = Math.max(0, totalBudget - floorSum)
      if (totalCandidates <= 0) {
        allocated = Math.min(perConsumerFloor, totalBudget)
      } else {
        const share = self.candidates / totalCandidates
        allocated = perConsumerFloor + Math.round(remaining * share)
      }
      // Never allocate more than this frame's total to a single consumer even if it's the only one
      // registered (e.g. mid-boot before siblings register) -- keeps a lone early consumer from
      // claiming the entire ceiling and then having to be clawed back once siblings appear.
      allocated = Math.min(allocated, totalBudget)
    }
    self.lastAllocated = allocated
    if (typeof setBudgetFn === 'function') setBudgetFn(allocated)
    return allocated
  }

  function getStats() {
    const per = {}
    let sumAllocated = 0, sumCandidates = 0
    for (const [name, c] of _consumers) {
      per[name] = { candidates: c.candidates, allocated: c.lastAllocated }
      sumAllocated += c.lastAllocated
      sumCandidates += c.candidates
    }
    return {
      frameMs: _lastFrameMs,
      totalBudget: _lastTotalBudget,
      maxTotalBudget, minTotalBudget, fastFrameSkipMs, slowFrameMs,
      perConsumerFloor, consumers: per, sumAllocated, sumCandidates,
      skipped: _lastTotalBudget <= 0,
    }
  }

  function unregister(name) { _consumers.delete(name) }

  return { reportCandidates, reportFrameTime, apply, getStats, unregister }
}
