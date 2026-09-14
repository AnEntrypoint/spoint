import { TERRAIN_DEFAULTS as TD } from './terrain-defaults.js'

const FACE_FRAME = [
  { c: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }, { c: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { c: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] }, { c: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { c: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, { c: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
]
const _dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

export function dirToFace(dir, R) {
  let bf = 0, bd = -Infinity
  for (let i = 0; i < 6; i++) { const d = _dot(dir, FACE_FRAME[i].c); if (d > bd) { bd = d; bf = i } }
  const F = FACE_FRAME[bf]
  const cc = _dot(dir, F.c), cu = _dot(dir, F.u), cv = _dot(dir, F.v)
  const k = (4 / Math.PI) * R
  return { face: bf, ox: k * Math.atan(cu / cc), oy: k * Math.atan(cv / cc) }
}

export function makeDirToFaceMemo(R) {
  const k = (4 / Math.PI) * R
  let lastFace = -1
  return function dirToFaceMemo(dir) {
    if (lastFace >= 0) {
      const F = FACE_FRAME[lastFace]
      const cc = _dot(dir, F.c)
      const lastFaceProvablyWins = cc > Math.SQRT1_2
      if (lastFaceProvablyWins) {
        const cu = _dot(dir, F.u), cv = _dot(dir, F.v)
        return { face: lastFace, ox: k * Math.atan(cu / cc), oy: k * Math.atan(cv / cc) }
      }
    }
    let bf = 0, bd = -Infinity
    for (let i = 0; i < 6; i++) { const d = _dot(dir, FACE_FRAME[i].c); if (d > bd) { bd = d; bf = i } }
    lastFace = bf
    const F = FACE_FRAME[bf]
    const cc = _dot(dir, F.c), cu = _dot(dir, F.u), cv = _dot(dir, F.v)
    return { face: bf, ox: k * Math.atan(cu / cc), oy: k * Math.atan(cv / cc) }
  }
}

export function applyThermalErosion(heights, res, opts = {}) {
  const talusM = opts.talusM ?? 0.6
  const iterations = opts.iterations ?? 20
  const carryFrac = opts.carryFrac ?? 0.5
  const out = new Float32Array(heights)
  const scratch = new Float32Array(res * res)
  for (let iter = 0; iter < iterations; iter++) {
    scratch.set(out)
    for (let z = 0; z < res; z++) {
      for (let x = 0; x < res; x++) {
        const i = z * res + x
        const hi = scratch[i]
        let lowestJ = -1, lowestH = hi, lowestDist = 0
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue
            const nx = x + dx, nz = z + dz
            if (nx < 0 || nx >= res || nz < 0 || nz >= res) continue
            const j = nz * res + nx
            const hj = scratch[j]
            if (hj < lowestH) { lowestH = hj; lowestJ = j; lowestDist = Math.sqrt(dx * dx + dz * dz) }
          }
        }
        if (lowestJ < 0) continue
        const drop = hi - lowestH
        if (drop <= talusM * lowestDist) continue
        const excess = drop - talusM * lowestDist
        const move = excess * carryFrac * 0.5
        out[i] -= move
        out[lowestJ] += move
      }
    }
  }
  return out
}

export async function createPatchBaker(opts = {}) {
  const warn = (m) => { try { console.warn('[PatchBaker] unavailable: ' + m) } catch (_) {} }
  if (typeof OffscreenCanvas === 'undefined') { warn('no OffscreenCanvas (dedicated Node?)'); return null }
  let gl
  try {
    const oc = new OffscreenCanvas(8, 8)
    gl = oc.getContext('webgl2', { antialias: false, depth: false })
    if (!gl) { warn('no webgl2 context'); return null }
    if (!gl.getExtension('EXT_color_buffer_float') || !gl.getExtension('OES_texture_float_linear')) { warn('no float-buffer extensions'); return null }
  } catch (e) { warn('gl init threw: ' + (e && e.message)); return null }
  const _isNode = typeof process !== 'undefined' && process.versions?.node
  let initMapspinnerPlanet
  try { ({ initMapspinnerPlanet } = await import('./planet-orchestrator.js')) }
  catch (e) { warn('orchestrator import threw: ' + (e && e.message)); return null }
  let planet
  try { planet = await initMapspinnerPlanet(gl, { radius: opts.radius, gridMeshSize: TD.gridMeshSize, reliefScale: opts.reliefScale, hpfSeed: opts.seed, bakeOnly: true }) }
  catch (e) { warn('initMapspinnerPlanet threw: ' + (e && e.message)); return null }
  const g = (typeof self !== 'undefined') ? self : (typeof window !== 'undefined' ? window : globalThis)
  if (typeof g.__thcEnsureBake === 'function') g.__thcEnsureBake()
  for (let k = 0; k < 20 && typeof g.__thcBakeReadback !== 'function'; k++) await new Promise(r => setTimeout(r, 100))
  if (typeof g.__thcBakeReadback !== 'function') { warn('__thcBakeReadback never appeared after init'); return null }
  await new Promise(r => setTimeout(r, 200))
  let res = 130
  function bakeTile(face, ox, oy, l, level = 0) {
    for (let k = 0; k < 12; k++) {
      const r = g.__thcBakeReadback(face | 0, ox, oy, l, level)
      if (r && r.heights) {
        res = r.res
        return opts.erosion ? applyThermalErosion(r.heights, r.res, opts.erosion === true ? {} : opts.erosion) : r.heights
      }
    }
    return null
  }
  const _asyncInFlight = new Set()
  const _asyncDone = new Map()
  const _ASYNC_DONE_MAX = 8
  function bakeTileAsync(face, ox, oy, l, level = 0, deferFlush = false) {
    if (typeof g.__thcBakeIssueAsync !== 'function' || typeof g.__thcBakePollAsync !== 'function') {
      const r = g.__thcBakeReadback(face | 0, ox, oy, l, level)
      if (r && r.heights) { res = r.res; return r.heights }
      return null
    }
    const key = face + ':' + ox + ':' + oy + ':' + l + ':' + level
    if (_asyncDone.has(key)) { const h = _asyncDone.get(key); _asyncDone.delete(key); return h }
    let result = null
    for (let guard = 0; guard < 8; guard++) {
      const done = g.__thcBakePollAsync()
      if (!done) break
      res = done.res
      const doneKey = done.face + ':' + done.ox + ':' + done.oy + ':' + done.l + ':' + done.level
      _asyncInFlight.delete(doneKey)
      if (doneKey === key) { result = done.heights; continue }
      _asyncDone.set(doneKey, done.heights)
      if (_asyncDone.size > _ASYNC_DONE_MAX) _asyncDone.delete(_asyncDone.keys().next().value)
    }
    if (result) {
      if (deferFlush) { _asyncDone.set(key, result); if (_asyncDone.size > _ASYNC_DONE_MAX) _asyncDone.delete(_asyncDone.keys().next().value); return null }
      return result
    }
    if (!_asyncInFlight.has(key)) { if (g.__thcBakeIssueAsync(face | 0, ox, oy, l, level, deferFlush)) { _asyncInFlight.add(key); return deferFlush ? false : null } }
    return null
  }
  function flushBakes() { if (typeof g.__thcBakeFlush === 'function') g.__thcBakeFlush() }
  const _dirToFaceMemo = makeDirToFaceMemo(opts.radius)
  return { bakeTile, bakeTileAsync, flushBakes, dirToFace: _dirToFaceMemo, res, planet }
}

export function createPatchHeightFn({ baker, frame, maxLevel = TD.maxLevel, offsetY = 0, fallbackFn, blocking = true }) {
  if (!baker) return null
  const R = frame.radius, res = baker.res, gridMeshSize = TD.gridMeshSize
  const finestLeaf = 2 * R / Math.pow(2, maxLevel)
  const visualSpacing = finestLeaf / (gridMeshSize - 1)
  const patchSpan = Math.max(8, visualSpacing * (res - 1))
  const cache = new Map(); const PATCH_CACHE_MAX = 384
  const _bakeFn = blocking ? baker.bakeTile : (baker.bakeTileAsync || baker.bakeTile)
  const PKEY_BIG = 1 << 23, PKEY_OFF = PKEY_BIG >> 1
  const _patchKey = (face, pi, pj) => (face * PKEY_BIG + (pj + PKEY_OFF)) * PKEY_BIG + (pi + PKEY_OFF)
  let _lastFace = -1, _lastPi = 0, _lastPj = 0, _lastPatch = null
  function patchFor(face, ox, oy) {
    const pi = Math.floor(ox / patchSpan), pj = Math.floor(oy / patchSpan)
    if (_lastPatch !== null && face === _lastFace && pi === _lastPi && pj === _lastPj) return _lastPatch
    const key = _patchKey(face, pi, pj)
    let p = cache.get(key)
    if (!p) {
      const heights = _bakeFn(face, pi * patchSpan, pj * patchSpan, patchSpan, 0)
      if (!heights) return null
      p = { heights, ox: pi * patchSpan, oy: pj * patchSpan }
      cache.set(key, p); if (cache.size > PATCH_CACHE_MAX) cache.delete(cache.keys().next().value)
    }
    _lastFace = face; _lastPi = pi; _lastPj = pj; _lastPatch = p
    return p
  }
  function patchHeightAtDir(d) {
    const { face, ox, oy } = baker.dirToFace(d)
    const p = patchFor(face, ox, oy)
    if (!p) return null
    const fx = (ox - p.ox) / patchSpan * (res - 1), fy = (oy - p.oy) / patchSpan * (res - 1)
    const ix = Math.max(0, Math.min(res - 2, Math.floor(fx))), iz = Math.max(0, Math.min(res - 2, Math.floor(fy)))
    const tx = fx - ix, tz = fy - iz, h = p.heights
    const h00 = h[iz * res + ix], h10 = h[iz * res + ix + 1], h01 = h[(iz + 1) * res + ix], h11 = h[(iz + 1) * res + ix + 1]
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
  }
  function heightFnOrNull(x, z) {
    const y = frame.solveSurfaceY(x, z, patchHeightAtDir)
    return y == null ? null : y + offsetY
  }
  function heightFn(x, z) {
    const y = heightFnOrNull(x, z)
    if (y != null) return y
    return fallbackFn ? fallbackFn(x, z) : frame.groundHeightLocal(x, z)
  }
  function prefetchAround(x, z) {
    const d = frame.localToDir(x, z)
    const { face, ox, oy } = baker.dirToFace(d)
    const pi0 = Math.floor(ox / patchSpan), pj0 = Math.floor(oy / patchSpan)
    let issued = 0
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue
        const pi = pi0 + di, pj = pj0 + dj
        const key = _patchKey(face, pi, pj)
        if (cache.has(key)) continue
        if (typeof baker.bakeTileAsync === 'function' && baker.bakeTileAsync(face, pi * patchSpan, pj * patchSpan, patchSpan, 0, true) === false) issued++
      }
    }
    if (issued > 0 && typeof baker.flushBakes === 'function') baker.flushBakes()
  }
  return { heightFn, heightFnOrNull, prefetchAround, patchSpan, res, spacing: visualSpacing, maxLevel }
}
