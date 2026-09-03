// Raw WebGL2 occlusion-query culling for mapspinner's terrain quadtree leaves (mapspinner has no THREE dependency, so this runs host-side).
// The predicate must stay a pure read of last-resolved verdicts; query issue must happen in runQueries() AFTER renderer.render() -- issuing queries inside planet-orchestrator's per-leaf predicate (the original design) unbinds GL state and clears depth before the predicate runs, making every query return 0 samples and permanently cache an empty (invisible) planet.
// Query boxes are absolute mapspinner ECEF positions multiplied by window.__lastVP (mapspinner's translate(-eye)-folded viewProj); depth comparability with three-drawn models requires app.js to sync camera near/far/fov to window.__planetNearFar every frame before render.
//
// Verdict policy (hide streak, eyeAtIssue distance expiry, rebuild-staleness fail-open) now lives in
// the shared client/core/OcclusionPolicy.js -- see cull-verdict-policy-module. unhideStreak:1
// reproduces this consumer's ORIGINAL immediate-un-hide-on-first-visible-resolve behavior exactly
// (this module's own prior comment called that "damps oscillation" -- true against a hide-side
// oscillator; SceneOcclusion.js's symmetric unhideStreak:2 targets a DIFFERENT oscillator, resolve
// noise under query-budget starvation, which is less of a concern here since TerrainOcclusion issues
// against a smaller, less-starved candidate set). Kept as a DELIBERATE per-consumer config
// difference, not an oversight -- terrain tiles are the candidate set most sensitive to any
// hide-side delay (a late-hiding tile draws an extra frame of already-occluded geometry, cheap; a
// late-UNhide is what pops visibly), so immediate un-hide is preserved rather than "fixed" to match
// SceneOcclusion without a live regression witness first.
import { createOcclusionPolicy } from './OcclusionPolicy.js'

export function createTerrainOcclusion(gl, opts = {}) {
  const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext
  const minCandidates = opts.minCandidates ?? 32
  // Query box must be lifted radially by half the elevation envelope and sized to cover [sea level..maxElev] -- centering at sea level (mapspinner's worldCenter) lets a tile's box sit entirely behind its own drawn surface, self-occluding and causing a flicker oscillator.
  const maxElev = opts.maxElev ?? 200
  const _policy = createOcclusionPolicy({
    hideStreak: 2,
    unhideStreak: 1,        // reproduces this consumer's original immediate-un-hide -- see file header
    enableEyeExpiry: true,  // this consumer tracks per-record eyeAtIssue+size, unlike SceneOcclusion
    expireMinM: 3,
    expireSizeMult: 1.5,
    staleResolveFrames: Infinity,   // rebuild-staleness (below) is this consumer's equivalent fail-open; resolve-staleness stays off to avoid double-firing two fail-opens on the same record
    rebuildStopQueryFrames: 8,
    rebuildFailOpenFrames: 16,
  })
  const records = new Map()   // "face,level,tx,ty" -> { query, pending, occluded [alias of .hidden], occludedStreak [alias of .streak], lastSeenFrame, center, size }
  const stats = { queried: 0, occluded: 0, resolved: 0, flips: 0, failOpens: 0, anomalyTrips: 0, supported: isWebGL2, candidateCount: 0 }
  let _boxProgram = null, _boxVao = null
  let _frameCounter = 0
  // Per-frame query-issue budget: each beginQuery/drawElements/endQuery is a real driver round-trip
  // (notably costly on ANGLE/D3D11). A moving camera used to issue+draw one query for EVERY candidate
  // EVERY frame (~250-400 real draws/frame, invisible to renderer.info since these are raw-GL calls
  // outside three's render loop) -- mirrors the round-robin budget pattern in streaming-gltf's
  // OcclusionQueryTier (consumed by SceneOcclusion.js). Verdicts are sticky between refreshes (the
  // resolve pass below is UNBOUNDED and runs for every record every frame), and the existing
  // eyeAtIssue/staleness fail-open logic already covers a verdict going stale between refreshes, so
  // capping only the ISSUE (not resolve) rate just slows refresh cadence under budget, never pops.
  // Mutable (not const): cull-shared-query-budget's arbiter adjusts this live across frames,
  // proportionally to this consumer's candidate count vs the other two issuers (SceneOcclusion,
  // ModelPool) sharing the same GPU. Plain object property, not a closure-captured const, so an
  // external arbiter can set it directly (setMaxQueriesPerFrame below).
  let MAX_QUERIES_PER_FRAME = opts.maxQueriesPerFrame ?? 32
  function setMaxQueriesPerFrame(n) { if (Number.isFinite(n) && n >= 0) MAX_QUERIES_PER_FRAME = n }
  function getMaxQueriesPerFrame() { return MAX_QUERIES_PER_FRAME }
  let _rrCursor = 0
  const _issueCandidates = []   // reused scratch array of records eligible for a fresh query issue this frame

  function _ensureBoxGeometry() {
    if (_boxProgram) return
    const vs = gl.createShader(gl.VERTEX_SHADER)
    gl.shaderSource(vs, `#version 300 es
      uniform mat4 uMvp;
      layout(location=0) in vec3 aPos;
      void main(){ gl_Position = uMvp * vec4(aPos, 1.0); }`)
    gl.compileShader(vs)
    const fs = gl.createShader(gl.FRAGMENT_SHADER)
    gl.shaderSource(fs, `#version 300 es
      precision mediump float;
      out vec4 o;
      void main(){ o = vec4(0.0); }`)
    gl.compileShader(fs)
    const prog = gl.createProgram()
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[terrain-occlusion] box program link failed:', gl.getProgramInfoLog(prog))
      return
    }
    _boxProgram = { prog, uMvp: gl.getUniformLocation(prog, 'uMvp') }
    const cube = new Float32Array([-1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1])
    const idx = new Uint16Array([0,1,2, 0,2,3, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 2,3,7, 2,7,6, 1,2,6, 1,6,5, 0,3,7, 0,7,4])
    const vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, cube, gl.STATIC_DRAW)
    const ibo = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW)
    _boxVao = gl.createVertexArray()
    gl.bindVertexArray(_boxVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo)
    gl.bindVertexArray(null)
  }

  function supported() { return isWebGL2 }

  // Called once per candidate leaf during a quadtree rebuild. Must stay a pure read (never touch GL) -- see file header.
  function makePredicate() {
    return (face, level, tx, ty, worldCenter, worldSize) => {
      const key = `${face},${level},${tx},${ty}`
      let rec = records.get(key)
      if (!rec) { rec = _policy.ensureRecord({ query: null, pending: false, center: null, size: 1 }); records.set(key, rec) }
      rec.lastSeenFrame = _frameCounter
      rec.center = worldCenter
      rec.size = worldSize
      return rec.hidden
    }
  }

  // Must be called AFTER renderer.render(scene,camera), while depth holds this frame's content. viewProjRel = window.__lastVP. Caller must renderer.resetState() afterwards (raw GL state mutated here).
  function runQueries(viewProjRel) {
    _frameCounter++
    if (!isWebGL2 || !viewProjRel) return
    if (records.size < minCandidates) { _evict(); stats.candidateCount = records.size; return }
    _ensureBoxGeometry()
    if (!_boxProgram) return
    // A hidden verdict is only valid for the pose its query was issued from; track eye motion so a stale verdict during camera motion fails open instead of culling a now-visible tile.
    const eyeNow = (typeof window !== 'undefined' && window.__lastGLCam && window.__lastGLCam.eye) || null
    let camStill = false
    if (eyeNow) {
      const dx = eyeNow[0] - _lastEye[0], dy = eyeNow[1] - _lastEye[1], dz = eyeNow[2] - _lastEye[2]
      camStill = (dx*dx + dy*dy + dz*dz) < 0.01   // < 0.1m since last frame
      _lastEye[0] = eyeNow[0]; _lastEye[1] = eyeNow[1]; _lastEye[2] = eyeNow[2]
    }
    // Expiry distance scales with each record's own halfSize (min-floored) -- a fixed distance would expire small near tiles too late and large far tiles too early.
    gl.useProgram(_boxProgram.prog)
    gl.bindVertexArray(_boxVao)
    gl.colorMask(false, false, false, false)
    gl.depthMask(false)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LESS)
    gl.disable(gl.CULL_FACE)   // index winding is ad-hoc; query needs any front-of-depth fragment
    // Pass 1 (unbounded, cheap): resolve pass, eyeAtIssue-expiry fail-open, and rebuild-staleness fail-open
    // must run for EVERY record EVERY frame regardless of the issue budget below -- these are all
    // getQueryParameter polls / arithmetic, no draw calls, and hysteresis/expiry correctness depends on
    // them never being skipped just because a record falls outside this frame's round-robin window.
    // Collects the subset of records actually eligible for a fresh query issue this frame into
    // _issueCandidates, so pass 2 can round-robin a bounded budget across only that eligible set.
    _issueCandidates.length = 0
    for (const rec of records.values()) {
      if (rec.pending && rec.query) {
        // fail open early if the eye already moved past this record's expiry distance, rather than waiting on a query result describing a stale viewpoint
        if (_policy.checkEyeExpiry(rec, eyeNow, rec.size)) { stats.failOpens++; rec._lastFailOpenFrame = _frameCounter }
        if (gl.getQueryParameter(rec.query, gl.QUERY_RESULT_AVAILABLE)) {
          let occludedThisResolve = gl.getQueryParameter(rec.query, gl.QUERY_RESULT) === 0
          rec.pending = false
          stats.resolved++
          // discard a fresh occluded verdict whose eyeAtIssue is already stale -- same expiry distance
          // as the pending-verdict checkEyeExpiry, single-sourced from the policy config (was a
          // re-hardcoded copy of Math.max(3, size*1.5) that silently ignored expireMinM/expireSizeMult)
          if (occludedThisResolve && _policy.eyeMovedPastExpiry(rec, eyeNow, rec.size)) occludedThisResolve = false
          // hysteresis (OcclusionPolicy: hideStreak=2, unhideStreak=1 -- immediate un-cull, see file header)
          rec._resolves = (rec._resolves || 0) + 1
          const result = _policy.advance(rec, rec._resolves, occludedThisResolve)
          if (result.flipped) stats.flips++
          if (rec.hidden) stats.occluded++
        }
        continue
      }
      // records unseen by a recent rebuild stop getting queries; fail open past a rebuild's legitimate cadence rather than staying frozen-culled until the 240-frame evict
      const framesSinceSeen = _frameCounter - rec.lastSeenFrame
      if (framesSinceSeen > 8) {
        const rb = _policy.checkRebuildStaleness(rec, framesSinceSeen)
        if (rb.failOpen) { stats.failOpens++; rec._lastFailOpenFrame = _frameCounter }
        continue
      }
      if (!rec.center) continue
      // Issue throttle only applies to a still camera (its verdicts aren't being consumed every frame); a moving camera must get fresh queries every frame or verdicts go stale mid-motion.
      if (camStill && _frameCounter % 4 !== 0) continue
      _issueCandidates.push(rec)
    }
    // Pass 2 (budget-capped, round-robin): only the actual beginQuery/drawElements/endQuery submission is
    // rate-limited. Cursor persists across frames so every eligible record still gets refreshed, just
    // spread over ceil(N/budget) frames instead of every frame -- matches OcclusionQueryTier's pattern.
    const n = _issueCandidates.length
    if (_rrCursor >= n) _rrCursor = 0
    let idx = _rrCursor
    let issued = 0
    for (let examined = 0; examined < n && issued < MAX_QUERIES_PER_FRAME; examined++, idx = (idx + 1) % n) {
      const rec = _issueCandidates[idx]
      const c = rec.center
      const len = Math.sqrt(c[0]*c[0] + c[1]*c[1] + c[2]*c[2]) || 1
      const lift = maxElev * 0.5
      _liftedCenter[0] = c[0] * (1 + lift / len)
      _liftedCenter[1] = c[1] * (1 + lift / len)
      _liftedCenter[2] = c[2] * (1 + lift / len)
      const halfSize = Math.max(rec.size, lift * 1.5)
      const mvp = _buildBoxMvp(viewProjRel, _liftedCenter, halfSize)
      if (!mvp) continue
      if (!rec.query) rec.query = gl.createQuery()
      gl.uniformMatrix4fv(_boxProgram.uMvp, false, mvp)
      gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, rec.query)
      gl.drawElements(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0)
      gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE)
      rec.pending = true
      if (eyeNow) { if (!rec.eyeAtIssue) rec.eyeAtIssue = [0,0,0]; rec.eyeAtIssue[0] = eyeNow[0]; rec.eyeAtIssue[1] = eyeNow[1]; rec.eyeAtIssue[2] = eyeNow[2] }
      stats.queried++
      issued++
    }
    _rrCursor = n > 0 ? idx : 0
    gl.bindVertexArray(null)
    gl.colorMask(true, true, true, true)
    gl.depthMask(true)
    _evict()
    stats.candidateCount = records.size
  }

  // Must never be able to strand the planet at zero quads: TerrainBackdrop calls this when a rebuild keeps 0 quads, resetting all verdicts fail-open.
  function clearVerdicts() {
    for (const rec of records.values()) { _policy.resetRecord(rec); rec.pending = false }
  }

  const _liftedCenter = [0, 0, 0]
  const _lastEye = [0, 0, 0]
  // Module-scope scratch for _buildBoxMvp -- was 2 fresh Float32Array(16) allocations per candidate per
  // frame (up to ~400/frame while moving). Safe as shared mutable scratch: _buildBoxMvp is called
  // synchronously once per candidate inside the single-threaded issue loop below, and its only caller
  // consumes the returned array immediately via gl.uniformMatrix4fv in the same iteration -- no retention
  // across calls, no reentrancy (this module has no async/concurrent call path into _buildBoxMvp).
  const _mvpScratchM = new Float32Array(16)
  const _mvpScratchOut = new Float32Array(16)

  function _evict() {
    for (const [key, rec] of records) {
      if (_frameCounter - rec.lastSeenFrame > 240) { try { rec.query && gl.deleteQuery(rec.query) } catch (_) {}; records.delete(key) }
    }
  }

  // Folds a world AABB (center + half-extent) into a clip-space MVP for the box geometry's unit cube.
  function _buildBoxMvp(viewProjRel, center, halfSize) {
    if (!viewProjRel || !center) return null
    const s = halfSize || 1
    const m = _mvpScratchM
    m.fill(0)
    m[0]=s; m[5]=s; m[10]=s; m[15]=1
    m[12]=center[0]; m[13]=center[1]; m[14]=center[2]
    const out = _mvpScratchOut
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += viewProjRel[k*4+r] * m[c*4+k]
      out[c*4+r] = sum
    }
    return out
  }

  function getStats() {
    // Uniform shape (cull-stats-uniform-shape): {candidates, queriedThisFrame, resolved, occluded, failOpens, anomalyTrips, flips, oldestPendingFrames}.
    let oldestPendingFrames = 0
    for (const rec of records.values()) if (rec.hidden && rec.staleFrames > oldestPendingFrames) oldestPendingFrames = rec.staleFrames
    return { ...stats, candidateCount: records.size, candidates: records.size, queriedThisFrame: stats.queried, oldestPendingFrames }
  }

  // cull-query-box-visualizer: candidate boxes for OcclusionQueryVisualizer, in the SAME
  // translate(-eye)-folded space window.__lastVP/window.__lastGLCam already use (see file header --
  // this is the space three's camera renders in this frame, so no extra transform is needed by the
  // visualizer). center/size mirror exactly what runQueries() feeds _buildBoxMvp, so a drawn box here
  // is pixel-for-pixel the same box the real query tested against depth.
  function getDebugBoxes() {
    const out = []
    for (const [key, rec] of records) {
      if (!rec.center) continue
      let state
      if (rec._lastFailOpenFrame === _frameCounter) state = 'failed-open'
      else if (rec.pending) state = 'pending'
      else if (rec.hidden) state = 'occluded'
      else state = 'visible'
      out.push({ key, center: rec.center, size: rec.size || 1, state })
    }
    return out
  }

  function dispose() {
    for (const rec of records.values()) { try { rec.query && gl.deleteQuery(rec.query) } catch (_) {} }
    records.clear()
    if (_boxVao) try { gl.deleteVertexArray(_boxVao) } catch (_) {}
    if (_boxProgram) try { gl.deleteProgram(_boxProgram.prog) } catch (_) {}
    _boxProgram = null; _boxVao = null
  }

  // Render-DAG visibility-resolve node reads this: a pure snapshot of currently-occluded leaf keys,
  // same records Map the predicate itself reads, exposed read-only so a DAG node never needs its own
  // occlusion-query plumbing to know what's hidden this frame.
  function snapshotOccludedKeys() {
    const out = new Set()
    for (const [key, rec] of records) if (rec.hidden) out.add(key)
    return out
  }

  return { runQueries, clearVerdicts, makePredicate, getStats, dispose, supported, snapshotOccludedKeys, setMaxQueriesPerFrame, getMaxQueriesPerFrame, getDebugBoxes }
}
