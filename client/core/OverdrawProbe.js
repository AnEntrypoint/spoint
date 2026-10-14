import * as THREE from 'three'
import { MeshBasicNodeMaterial, QuadMesh } from 'three/webgpu'
import { Fn, texture, uv, vec3, vec4, float, clamp, mix, uniform } from 'three/tsl'
import { RenderControls } from './RenderControls.js'

const OVERDRAW_KEY = 'overdraw'
const STATS_KEY = 'overdrawStats'
const VIEW_CEILING_DEFAULT = 8
const MAX_BUCKET = 4096
const HISTOGRAM_BUCKETS = [
  { name: '1', lo: 0, hi: 1 },
  { name: '2', lo: 1, hi: 2 },
  { name: '3', lo: 2, hi: 3 },
  { name: '4', lo: 3, hi: 4 },
  { name: '5-8', lo: 4, hi: 8 },
  { name: '9-16', lo: 8, hi: 16 },
  { name: '17-32', lo: 16, hi: 32 },
  { name: '33+', lo: 32, hi: Infinity },
]

function buildHeatNode(accumTexture, ceilingUniform) {
  return Fn(() => {
    const level = clamp(texture(accumTexture, uv()).r.div(ceilingUniform), float(0), float(1))
    const lowRamp = clamp(level.mul(2.0), 0.0, 1.0)
    const highRamp = clamp(level.mul(2.0).sub(1.0), 0.0, 1.0)
    const cold = mix(vec3(0.04, 0.09, 0.55), vec3(0.10, 0.85, 0.20), lowRamp)
    const hot = mix(vec3(0.10, 0.85, 0.20), vec3(1.00, 0.12, 0.05), highRamp)
    return vec4(mix(cold, hot, highRamp), 1.0)
  })()
}

function readChannel(buffer, index) {
  const raw = buffer[index]
  if (buffer instanceof Uint16Array) return THREE.DataUtils.fromHalfFloat(raw)
  return raw
}

function percentileFromBuckets(buckets, total, frac) {
  if (!(total > 0)) return null
  const want = total * frac
  let seen = 0
  for (let v = 0; v < buckets.length; v++) {
    seen += buckets[v]
    if (seen >= want) return v
  }
  return buckets.length - 1
}

export function createOverdrawProbe({ renderer, scene, camera, readIntervalMs = 1000 }) {
  let target = null
  let width = 0
  let height = 0
  let unitsPerFragment = null
  let calibratedAt = null
  let busy = false
  let lastReadMs = -Infinity
  let stats = null
  let passes = 0
  let reads = 0
  let errors = 0
  let lastError = null

  const ceilingUniform = uniform(VIEW_CEILING_DEFAULT)

  const accumulateMaterial = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false })
  accumulateMaterial.colorNode = vec4(1, 1, 1, 1)
  accumulateMaterial.opacityNode = float(1)
  accumulateMaterial.blending = THREE.CustomBlending
  accumulateMaterial.blendSrc = THREE.OneFactor
  accumulateMaterial.blendDst = THREE.OneFactor
  accumulateMaterial.blendEquation = THREE.AddEquation
  accumulateMaterial.blendSrcAlpha = THREE.OneFactor
  accumulateMaterial.blendDstAlpha = THREE.OneFactor
  accumulateMaterial.blendEquationAlpha = THREE.AddEquation
  accumulateMaterial.forceSinglePass = true
  accumulateMaterial.toneMapped = false
  accumulateMaterial.side = THREE.FrontSide

  const viewMaterial = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, transparent: true })
  const quad = new QuadMesh(accumulateMaterial)

  function isEnabled() {
    return RenderControls.get(OVERDRAW_KEY) === true
  }

  function disposeTarget() {
    if (!target) return
    target.dispose()
    target = null
    width = 0
    height = 0
    unitsPerFragment = null
    calibratedAt = null
  }

  function ensureTarget() {
    const size = new THREE.Vector2()
    renderer.getDrawingBufferSize(size)
    const w = Math.max(4, Math.floor(size.x))
    const h = Math.max(4, Math.floor(size.y))
    if (w <= 0 || h <= 0) return false
    if (target && w === width && h === height) return true
    disposeTarget()
    width = w
    height = h
    target = new THREE.RenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    })
    viewMaterial.colorNode = buildHeatNode(target.texture, ceilingUniform)
    viewMaterial.needsUpdate = true
    return true
  }

  function withTargetCleared(fn) {
    const prevTarget = renderer.getRenderTarget()
    const prevAutoClear = renderer.autoClear
    const prevClearColor = new THREE.Color()
    renderer.getClearColor(prevClearColor)
    const prevClearAlpha = renderer.getClearAlpha()
    renderer.setRenderTarget(target)
    renderer.autoClear = true
    renderer.setClearColor(0x000000, 0)
    try {
      fn()
    } finally {
      renderer.setRenderTarget(prevTarget)
      renderer.autoClear = prevAutoClear
      renderer.setClearColor(prevClearColor, prevClearAlpha)
    }
  }

  function renderAccumulate() {
    const prevOverride = scene.overrideMaterial
    withTargetCleared(() => {
      scene.overrideMaterial = accumulateMaterial
      try {
        renderer.render(scene, camera)
      } finally {
        scene.overrideMaterial = prevOverride
      }
    })
    passes++
  }

  async function calibrate() {
    withTargetCleared(() => {
      quad.material = accumulateMaterial
      quad.render(renderer)
    })
    const mid = await renderer.readRenderTargetPixelsAsync(target, width >> 1, height >> 1, 1, 1)
    const value = readChannel(mid, 0)
    if (Number.isFinite(value) && value > 0) {
      unitsPerFragment = value
      calibratedAt = Date.now()
    } else {
      unitsPerFragment = null
      calibratedAt = null
    }
    return unitsPerFragment
  }

  function reduce(buffer) {
    const pixels = width * height
    const stride = Math.max(1, Math.round(buffer.length / pixels))
    const buckets = new Int32Array(MAX_BUCKET + 1)
    const histogram = HISTOGRAM_BUCKETS.map(() => 0)
    let covered = 0
    let sum = 0
    let peak = 0
    let uncalibrated = 0
    for (let i = 0; i < pixels; i++) {
      const raw = readChannel(buffer, i * stride)
      if (!(raw > 0)) continue
      const fragments = unitsPerFragment ? raw / unitsPerFragment : NaN
      if (!Number.isFinite(fragments) || fragments <= 0) { uncalibrated++; continue }
      covered++
      sum += fragments
      const rounded = Math.round(fragments)
      if (rounded > peak) peak = rounded
      if (rounded <= MAX_BUCKET) buckets[rounded]++
      else buckets[MAX_BUCKET]++
      for (let b = 0; b < HISTOGRAM_BUCKETS.length; b++) {
        const band = HISTOGRAM_BUCKETS[b]
        if (fragments > band.lo && fragments <= band.hi) { histogram[b]++; break }
      }
    }
    const histogramOut = {}
    for (let b = 0; b < HISTOGRAM_BUCKETS.length; b++) histogramOut[HISTOGRAM_BUCKETS[b].name] = histogram[b]
    return {
      viewport: `${width}x${height}`,
      pixels,
      unitsPerFragment,
      calibratedAt,
      coveredPixels: covered,
      coveragePct: pixels ? +((covered / pixels) * 100).toFixed(3) : null,
      totalFragments: Math.round(sum),
      fragmentsPerCoveredPixel: covered ? +(sum / covered).toFixed(4) : null,
      fragmentsPerScreenPixel: pixels ? +(sum / pixels).toFixed(4) : null,
      maxFragmentsPerPixel: covered ? peak : null,
      p50FragmentsPerCoveredPixel: percentileFromBuckets(buckets, covered, 0.5),
      p95FragmentsPerCoveredPixel: percentileFromBuckets(buckets, covered, 0.95),
      p99FragmentsPerCoveredPixel: percentileFromBuckets(buckets, covered, 0.99),
      histogram: histogramOut,
      uncalibratedPixels: uncalibrated,
      passes,
      reads,
      errors,
      lastError,
    }
  }

  function publish(next) {
    stats = next
    if (typeof window !== 'undefined') window.__overdrawStats = next
    try { RenderControls.set(STATS_KEY, next) } catch (_) {}
    return next
  }

  async function sample() {
    if (busy) return stats
    if (!ensureTarget()) return null
    busy = true
    try {
      if (unitsPerFragment == null) {
        try { await calibrate() } catch (e) { errors++; lastError = String(e && e.message || e) }
      }
      if (unitsPerFragment == null) return null
      renderAccumulate()
      const buffer = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height)
      reads++
      return publish(reduce(buffer))
    } catch (e) {
      errors++
      lastError = String((e && e.message) || e)
      return null
    } finally {
      busy = false
    }
  }

  function composite() {
    if (!target || !stats) return false
    const prevAutoClear = renderer.autoClear
    renderer.autoClear = false
    quad.material = viewMaterial
    try {
      quad.render(renderer)
    } finally {
      renderer.autoClear = prevAutoClear
    }
    return true
  }

  function tick(nowMs) {
    if (!isEnabled()) return null
    if (nowMs - lastReadMs >= readIntervalMs) {
      lastReadMs = nowMs
      sample().catch(() => {})
    }
    composite()
    return stats
  }

  function dispose() {
    disposeTarget()
    accumulateMaterial.dispose()
    viewMaterial.dispose()
  }

  const api = {
    tick,
    sample,
    calibrate,
    composite,
    isEnabled,
    dispose,
    stats: () => stats,
    counters: () => ({ passes, reads, errors, lastError, unitsPerFragment, viewport: `${width}x${height}` }),
    setViewCeiling: (n) => { if (Number.isFinite(n) && n > 0) ceilingUniform.value = n },
    get accumulateMaterial() { return accumulateMaterial },
    get target() { ensureTarget(); return target },
    get THREE() { return THREE },
    OVERDRAW_KEY,
    STATS_KEY,
  }
  if (typeof window !== 'undefined') window.__overdrawProbe = api
  return api
}
