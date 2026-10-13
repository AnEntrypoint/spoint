let _installed = false
let _renderer = null
let _origShadowRender = null
let _origRendererRender = null
let _lastPassMs = 0
let _passSamples = []
let _splitResult = null
let _splitArmed = false
let _splitInFlight = false
let _splitEveryN = 30
let _splitCounter = 0
let _handle = null

const MAX_SAMPLES = 240

// Three's two renderers ask for a shadow redraw in two different places, so the probe has two arms.
// The legacy one owns a renderer-level pass, WebGLShadowMap.render(lights, scene, camera), gated on
// renderer.shadowMap.needsUpdate. three's WebGPU Renderer.shadowMap is { enabled, transmitted, type
// } with no render and no needsUpdate: the pass is driven per light by ShadowNode.updateBefore out
// of light.shadow.needsUpdate, and it reaches the renderer as render(scene, light.shadow.camera).
// A probe that only ever looked for the renderer-level pass installed on neither's absence and
// returned nothing, so "no shadow cost" was indistinguishable from "no probe".
const ARM_RENDERER_PASS = 'renderer-shadow-pass'
const ARM_PER_LIGHT_PASS = 'per-light-shadow-pass'

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

function _recordPass(ms) {
  _lastPassMs = ms
  _passSamples.push(ms)
  if (_passSamples.length > MAX_SAMPLES) _passSamples.shift()
}

function _attachRendererPass(renderer, scene, camera, sunOrShadowPipeline) {
  const sm = renderer.shadowMap
  _origShadowRender = sm.render.bind(sm)
  sm.render = function (lights, s, c) {
    const wasNeedsUpdate = sm.needsUpdate
    const t0 = performance.now()
    _origShadowRender(lights, s, c)
    const didWork = sm.enabled && wasNeedsUpdate && Array.isArray(lights) && lights.length > 0
    if (!didWork) return
    _recordPass(performance.now() - t0)
    try { _maybeRunSplit(renderer, s, c, _resolveLights(sunOrShadowPipeline)) } catch (_) {}
  }
  return { attached: true, backend: ARM_RENDERER_PASS, splitSupported: true, reason: null }
}

// The pass this arm times is the one three issues per light it decided to redraw, told apart from
// the main pass by camera identity: ShadowNode.renderShadow calls render(scene, shadow.camera).
function _attachPerLightPass(renderer, lights) {
  const shadowCameras = new Set()
  for (const l of lights) {
    if (l && l.shadow && l.shadow.camera) shadowCameras.add(l.shadow.camera)
  }
  if (shadowCameras.size === 0) {
    return { attached: false, backend: null, splitSupported: false, reason: 'no cascade light carries a shadow camera, so a shadow pass cannot be told apart from the main pass' }
  }
  _origRendererRender = renderer.render.bind(renderer)
  renderer.render = function (s, c) {
    const isShadowPass = shadowCameras.has(c)
    const t0 = isShadowPass ? performance.now() : 0
    const out = _origRendererRender(s, c)
    if (isShadowPass) _recordPass(performance.now() - t0)
    return out
  }
  return { attached: true, backend: ARM_PER_LIGHT_PASS, splitSupported: false, reason: null }
}

function _refuse(reason) {
  return { attached: false, backend: null, splitSupported: false, reason }
}

function _makeHandle(scene, lights, arm) {
  const backend = arm.backend || 'unattached'
  return {
    attached: arm.attached,
    backend: arm.backend,
    reason: arm.reason,
    splitSupported: arm.splitSupported === true,
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
        attached: arm.attached,
        backend: arm.backend,
        lastPassMs: +_lastPassMs.toFixed(3),
        avgPassMs: avg, p95PassMs: p95, maxPassMs: max, samples: n,
        liveStaticCasters: staticObjs.length, liveDynamicCasters: dynamicObjs.length,
        cascadeCount: lights.length,
        split: _splitResult,
        armed: _splitArmed,
        splitSupported: arm.splitSupported === true,
      }
    },
    arm(everyN) {
      if (!arm.attached) {
        console.warn('[shadowCostProbe] arm() changed nothing: the probe is not attached (' + arm.reason + ')')
        return false
      }
      if (arm.splitSupported !== true) {
        console.warn('[shadowCostProbe] arm() changed nothing: the static-vs-dynamic split drives three extra passes through the renderer-level shadow pass, which the ' + backend + ' arm does not own')
        return false
      }
      _splitArmed = true; _splitCounter = 0
      if (Number.isFinite(everyN) && everyN > 0) _splitEveryN = everyN
      return true
    },
    disarm() { _splitArmed = false; _splitResult = null },
    reset() { _passSamples = []; _lastPassMs = 0 },
    isArmed() { return _splitArmed },
    isAttached() { return arm.attached },
  }
}

export function installShadowCostProbe(renderer, scene, camera, sunOrShadowPipeline) {
  if (_installed) return _handle
  const lights = _resolveLights(sunOrShadowPipeline)
  let arm
  if (!renderer || typeof renderer !== 'object') {
    arm = _refuse('no renderer was handed to the probe')
  } else if (renderer.shadowMap && typeof renderer.shadowMap.render === 'function') {
    arm = _attachRendererPass(renderer, scene, camera, sunOrShadowPipeline)
  } else if (typeof renderer.render === 'function') {
    arm = _attachPerLightPass(renderer, lights)
  } else {
    arm = _refuse('the renderer exposes neither a renderer-level shadowMap.render nor a render() to time, so no shadow pass can be attributed')
  }
  if (arm.attached) { _installed = true; _renderer = renderer }
  _handle = _makeHandle(scene, lights, arm)
  if (typeof window !== 'undefined') window.__shadowCost = _handle
  if (!arm.attached) console.warn('[shadowCostProbe] NOT ATTACHED: ' + arm.reason + ' -- stats() reports attached:false and no shadow cost may be quoted from this probe')
  return _handle
}

export function getShadowCostProbe() {
  return _handle
}
