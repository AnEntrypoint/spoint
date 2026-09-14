let _installed = false
let _renderer = null
let _origShadowRender = null
let _lastPassMs = 0
let _passSamples = []
let _splitResult = null
let _splitArmed = false
let _splitInFlight = false
let _splitEveryN = 30
let _splitCounter = 0

const MAX_SAMPLES = 240

function _isDynamicCaster(o) {
  let cur = o
  while (cur) {
    if (cur.userData && cur.userData.isDynamicShadowCaster !== undefined) return !!cur.userData.isDynamicShadowCaster
    cur = cur.parent
  }
  return false
}

function _classify(scene) {
  let staticObjs = [], dynamicObjs = []
  scene.traverse(o => {
    if (!o.isMesh && !o.isInstancedMesh) return
    if (!o.castShadow) return
    if (_isDynamicCaster(o)) dynamicObjs.push(o)
    else staticObjs.push(o)
  })
  return { staticObjs, dynamicObjs }
}

function _setCastShadow(list, value, restore) {
  for (const o of list) { restore.push([o, o.castShadow]); o.castShadow = value }
}

function _restoreCastShadow(restore) {
  for (const [o, v] of restore) o.castShadow = v
}

function _timedMaskedPass(renderer, scene, camera, lights, mask) {
  const restore = []
  if (mask) _setCastShadow(mask, false, restore)
  for (const l of lights) l.shadow.needsUpdate = true
  renderer.shadowMap.needsUpdate = true
  const ir = renderer.info.render
  const calls0 = ir.calls, tris0 = ir.triangles
  ir.frame++
  const t0 = performance.now()
  try { _origShadowRender(lights, scene, camera) } catch (e) { if (typeof window !== 'undefined') window.__shadowCostProbeLastError = e && (e.stack || e.message || String(e)) }
  const ms = performance.now() - t0
  const calls = ir.calls - calls0, triangles = ir.triangles - tris0
  _restoreCastShadow(restore)
  renderer.shadowMap.needsUpdate = false
  return { ms, calls, triangles }
}

function _maybeRunSplit(renderer, scene, camera, lights) {
  if (!_splitArmed || _splitInFlight) return
  _splitCounter++
  if (_splitCounter < _splitEveryN) return
  _splitCounter = 0
  _splitInFlight = true
  try {
    const { staticObjs, dynamicObjs } = _classify(scene)
    if (staticObjs.length === 0 && dynamicObjs.length === 0) return
    const staticOnly = _timedMaskedPass(renderer, scene, camera, lights, dynamicObjs)
    const dynamicOnly = _timedMaskedPass(renderer, scene, camera, lights, staticObjs)
    const combined = _timedMaskedPass(renderer, scene, camera, lights, null)
    for (const l of lights) l.shadow.needsUpdate = true
    _splitResult = {
      staticMs: +staticOnly.ms.toFixed(3),
      dynamicMs: +dynamicOnly.ms.toFixed(3),
      combinedMs: +combined.ms.toFixed(3),
      staticObjects: staticObjs.length,
      dynamicObjects: dynamicObjs.length,
      staticShareOfCombined: combined.ms > 0 ? +((staticOnly.ms / combined.ms) * 100).toFixed(1) : null,
      dynamicShareOfCombined: combined.ms > 0 ? +((dynamicOnly.ms / combined.ms) * 100).toFixed(1) : null,
      staticCalls: staticOnly.calls, staticTriangles: staticOnly.triangles,
      dynamicCalls: dynamicOnly.calls, dynamicTriangles: dynamicOnly.triangles,
      combinedCalls: combined.calls, combinedTriangles: combined.triangles,
      cascadeCount: lights.length,
      ts: Date.now(),
    }
  } finally {
    _splitInFlight = false
  }
}

function _resolveLights(pipelineOrSun) {
  if (!pipelineOrSun) return []
  if (Array.isArray(pipelineOrSun.lights)) return pipelineOrSun.lights
  return [pipelineOrSun]
}

export function installShadowCostProbe(renderer, scene, camera, sunOrShadowPipeline) {
  if (_installed || !renderer || !renderer.shadowMap || typeof renderer.shadowMap.render !== 'function') return
  _installed = true
  _renderer = renderer
  const sm = renderer.shadowMap
  _origShadowRender = sm.render.bind(sm)
  sm.render = function (lights, s, c) {
    const wasNeedsUpdate = sm.needsUpdate
    const t0 = performance.now()
    _origShadowRender(lights, s, c)
    const didWork = sm.enabled && wasNeedsUpdate && Array.isArray(lights) && lights.length > 0
    if (didWork) {
      const ms = performance.now() - t0
      _lastPassMs = ms
      _passSamples.push(ms)
      if (_passSamples.length > MAX_SAMPLES) _passSamples.shift()
    }
    if (didWork) {
      try { _maybeRunSplit(renderer, s, c, _resolveLights(sunOrShadowPipeline)) } catch (_) {}
    }
  }
  if (typeof window !== 'undefined') {
    window.__shadowCost = {
      stats() {
        const n = _passSamples.length
        let avg = null, p95 = null, max = null
        if (n > 0) {
          const sorted = _passSamples.slice().sort((a, b) => a - b)
          avg = +(sorted.reduce((a, b) => a + b, 0) / n).toFixed(3)
          p95 = +sorted[Math.min(n - 1, Math.floor(0.95 * n))].toFixed(3)
          max = +sorted[n - 1].toFixed(3)
        }
        const { staticObjs, dynamicObjs } = scene ? _classify(scene) : { staticObjs: [], dynamicObjs: [] }
        return {
          lastPassMs: +_lastPassMs.toFixed(3),
          avgPassMs: avg, p95PassMs: p95, maxPassMs: max, samples: n,
          liveStaticCasters: staticObjs.length, liveDynamicCasters: dynamicObjs.length,
          cascadeCount: _resolveLights(sunOrShadowPipeline).length,
          split: _splitResult,
          armed: _splitArmed,
        }
      },
      arm(everyN) { _splitArmed = true; _splitCounter = 0; if (Number.isFinite(everyN) && everyN > 0) _splitEveryN = everyN },
      disarm() { _splitArmed = false; _splitResult = null },
      reset() { _passSamples = []; _lastPassMs = 0 },
      isArmed() { return _splitArmed },
    }
  }
  return window.__shadowCost
}
