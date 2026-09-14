import { createOcclusionPolicy } from './OcclusionPolicy.js'

const STILL_CAMERA_MAX_STEP_SQ = 0.01
const STILL_CAMERA_ISSUE_EVERY_N_FRAMES = 4

export function createTerrainOcclusion(gl, opts = {}) {
  const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext
  const minCandidates = opts.minCandidates ?? 32
  const maxElev = opts.maxElev ?? 200
  const _policy = createOcclusionPolicy({
    hideStreak: 2,
    unhideStreak: 1,
    enableEyeExpiry: true,
    expireMinM: 3,
    expireSizeMult: 1.5,
    staleResolveFrames: Infinity,
    rebuildStopQueryFrames: 8,
    rebuildFailOpenFrames: 16,
  })
  const records = new Map()
  const stats = { queried: 0, occluded: 0, resolved: 0, flips: 0, failOpens: 0, anomalyTrips: 0, supported: isWebGL2, candidateCount: 0 }
  let _boxProgram = null, _boxVao = null
  let _frameCounter = 0
  let maxQueriesPerFrame = opts.maxQueriesPerFrame ?? 32
  function setMaxQueriesPerFrame(n) { if (Number.isFinite(n) && n >= 0) maxQueriesPerFrame = n }
  function getMaxQueriesPerFrame() { return maxQueriesPerFrame }
  let _rrCursor = 0
  const _issueCandidates = []

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

  function runQueries(viewProjRel) {
    _frameCounter++
    if (!isWebGL2 || !viewProjRel) return
    if (records.size < minCandidates) { _evict(); stats.candidateCount = records.size; return }
    _ensureBoxGeometry()
    if (!_boxProgram) return
    const eyeNow = (typeof window !== 'undefined' && window.__lastGLCam && window.__lastGLCam.eye) || null
    let camStill = false
    if (eyeNow) {
      const dx = eyeNow[0] - _lastEye[0], dy = eyeNow[1] - _lastEye[1], dz = eyeNow[2] - _lastEye[2]
      camStill = (dx*dx + dy*dy + dz*dz) < STILL_CAMERA_MAX_STEP_SQ
      _lastEye[0] = eyeNow[0]; _lastEye[1] = eyeNow[1]; _lastEye[2] = eyeNow[2]
    }
    gl.useProgram(_boxProgram.prog)
    gl.bindVertexArray(_boxVao)
    gl.colorMask(false, false, false, false)
    gl.depthMask(false)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LESS)
    gl.disable(gl.CULL_FACE)
    _issueCandidates.length = 0
    for (const rec of records.values()) {
      if (rec.pending && rec.query) {
        if (_policy.checkEyeExpiry(rec, eyeNow, rec.size)) { stats.failOpens++; rec._lastFailOpenFrame = _frameCounter }
        if (gl.getQueryParameter(rec.query, gl.QUERY_RESULT_AVAILABLE)) {
          let occludedThisResolve = gl.getQueryParameter(rec.query, gl.QUERY_RESULT) === 0
          rec.pending = false
          stats.resolved++
          if (occludedThisResolve && _policy.eyeMovedPastExpiry(rec, eyeNow, rec.size)) occludedThisResolve = false
          rec._resolves = (rec._resolves || 0) + 1
          const result = _policy.advance(rec, rec._resolves, occludedThisResolve)
          if (result.flipped) stats.flips++
          if (rec.hidden) stats.occluded++
        }
        continue
      }
      const framesSinceSeen = _frameCounter - rec.lastSeenFrame
      if (framesSinceSeen > 8) {
        const rb = _policy.checkRebuildStaleness(rec, framesSinceSeen)
        if (rb.failOpen) { stats.failOpens++; rec._lastFailOpenFrame = _frameCounter }
        continue
      }
      if (!rec.center) continue
      if (camStill && _frameCounter % STILL_CAMERA_ISSUE_EVERY_N_FRAMES !== 0) continue
      _issueCandidates.push(rec)
    }
    const n = _issueCandidates.length
    if (_rrCursor >= n) _rrCursor = 0
    let idx = _rrCursor
    let issued = 0
    for (let examined = 0; examined < n && issued < maxQueriesPerFrame; examined++, idx = (idx + 1) % n) {
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

  function clearVerdicts() {
    for (const rec of records.values()) { _policy.resetRecord(rec); rec.pending = false }
  }

  const _liftedCenter = [0, 0, 0]
  const _lastEye = [0, 0, 0]
  const _mvpScratchM = new Float32Array(16)
  const _mvpScratchOut = new Float32Array(16)

  function _evict() {
    for (const [key, rec] of records) {
      if (_frameCounter - rec.lastSeenFrame > 240) { try { rec.query && gl.deleteQuery(rec.query) } catch (_) {}; records.delete(key) }
    }
  }

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
    let oldestPendingFrames = 0
    for (const rec of records.values()) if (rec.hidden && rec.staleFrames > oldestPendingFrames) oldestPendingFrames = rec.staleFrames
    return { ...stats, candidateCount: records.size, candidates: records.size, queriedThisFrame: stats.queried, oldestPendingFrames }
  }

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

  function snapshotOccludedKeys() {
    const out = new Set()
    for (const [key, rec] of records) if (rec.hidden) out.add(key)
    return out
  }

  function getCandidateCount() { return records.size }
  return { runQueries, clearVerdicts, makePredicate, getStats, getCandidateCount, dispose, supported, snapshotOccludedKeys, setMaxQueriesPerFrame, getMaxQueriesPerFrame, getDebugBoxes }
}
