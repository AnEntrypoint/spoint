import { RenderControls } from './RenderControls.js'

const STORAGE_KEY = 'spoint.qualityPreset'
const DEFAULT_PRESET = 'Medium'

const PRESETS = {
  Low: {
    shadowsEnabled: false,
    dpr: null,
    dprAuto: false,
    fogFar: 100,
    vegWind: false,
    vegAllOff: false,
    vegHideFar: null,
    grassWind: false,
    halfResWater: false,
    thc: false,
    ssao: false,
    bloom: false,
    ssr: false,
    toneMappingExposure: 0.8,
  },
  Medium: {
    shadowsEnabled: true,
    dpr: null,
    dprAuto: false,
    fogFar: 200,
    vegWind: true,
    vegAllOff: false,
    vegHideFar: null,
    grassWind: true,
    halfResWater: false,
    thc: false,
    ssao: false,
    bloom: false,
    ssr: false,
    toneMappingExposure: 1.0,
  },
  High: {
    shadowsEnabled: true,
    dpr: null,
    dprAuto: false,
    fogFar: 300,
    vegWind: true,
    vegAllOff: false,
    vegHideFar: null,
    grassWind: true,
    halfResWater: false,
    thc: false,
    ssao: false,
    bloom: false,
    ssr: false,
    toneMappingExposure: 1.0,
  },
  Ultra: {
    shadowsEnabled: true,
    dpr: null,
    dprAuto: false,
    fogFar: 500,
    vegWind: true,
    vegAllOff: false,
    vegHideFar: null,
    grassWind: true,
    halfResWater: false,
    thc: false,
    ssao: false,
    bloom: false,
    ssr: true,
    toneMappingExposure: 1.0,
  },
}

const PRESET_NAMES = Object.keys(PRESETS)

let _rendererHandle = null
let _current = null

function _clampDpr(v) {
  const cap = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1
  return v == null ? cap : Math.max(0.5, Math.min(cap, v))
}

function apply(name, opts = {}) {
  const preset = PRESETS[name]
  if (!preset) { console.warn(`[quality-presets] unknown preset '${name}'. Valid: ${PRESET_NAMES.join(', ')}`); return false }
  const renderer = opts.renderer || _rendererHandle
  if (renderer) _rendererHandle = renderer

  RenderControls.set('dprAuto', preset.dprAuto)
  RenderControls.set('fogFar', preset.fogFar)
  RenderControls.set('vegWind', preset.vegWind)
  RenderControls.set('vegAllOff', preset.vegAllOff)
  RenderControls.set('vegHideFar', preset.vegHideFar)
  RenderControls.set('grassWind', preset.grassWind)
  RenderControls.set('halfResWater', preset.halfResWater)
  RenderControls.set('thc', preset.thc)
  RenderControls.set('ssao', preset.ssao)
  RenderControls.set('bloom', preset.bloom)
  RenderControls.set('ssr', preset.ssr)
  if (preset.toneMappingExposure !== undefined) RenderControls.set('toneMappingExposure', preset.toneMappingExposure)

  if (renderer) {
    renderer.shadowMap.enabled = preset.shadowsEnabled
    const dpr = _clampDpr(preset.dpr)
    try { renderer.setPixelRatio(dpr) } catch (e) { console.warn('[quality-presets] setPixelRatio failed:', e?.message || e) }
    if (typeof window !== 'undefined') window.__dpr = dpr
  }

  _current = name
  if (typeof window !== 'undefined') window.__qualityPreset = name
  return true
}

function setPreset(name, opts = {}) {
  const ok = apply(name, opts)
  if (ok) {
    try { localStorage.setItem(STORAGE_KEY, name) } catch (e) { console.warn('[quality-presets] localStorage write failed:', e?.message || e) }
  }
  return ok
}

function getPersisted() {
  try { const v = localStorage.getItem(STORAGE_KEY); return PRESETS[v] ? v : null } catch (_) { return null }
}

function chooseInitialPreset(deviceInfo) {
  const isMobile = deviceInfo ? !!deviceInfo.isMobile
    : (typeof navigator !== 'undefined' && /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent))
  const hardwareConcurrency = deviceInfo ? deviceInfo.hardwareConcurrency
    : (typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || -1) : -1)
  const gpuTier = deviceInfo ? deviceInfo.gpuTier : 'unknown'
  const memoryMB = deviceInfo ? deviceInfo.memoryMB
    : (typeof navigator !== 'undefined' && navigator.deviceMemory ? navigator.deviceMemory * 1024 : -1)
  const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1

  const isLowEnd = gpuTier === 'low' || (memoryMB > 0 && memoryMB < 2048) || (hardwareConcurrency > 0 && hardwareConcurrency < 4)
  const isHighEnd = gpuTier === 'medium' && !isMobile && hardwareConcurrency >= 8 && (memoryMB <= 0 || memoryMB >= 8192)

  if (isMobile || isLowEnd) return 'Low'
  if (isHighEnd && dpr >= 1.5) return 'Ultra'
  if (hardwareConcurrency >= 6 || dpr >= 1.5) return 'High'
  return DEFAULT_PRESET
}

function autoApplyPersisted(opts = {}) {
  const saved = getPersisted()
  if (saved) { apply(saved, opts); return { name: saved, wasPersisted: true } }
  const name = chooseInitialPreset(opts.deviceInfo)
  apply(name, opts)
  return { name, wasPersisted: false }
}

export const QualityPresets = {
  names: PRESET_NAMES,
  presets: PRESETS,
  get current() { return _current },
  apply,
  setPreset,
  getPersisted,
  chooseInitialPreset,
  autoApplyPersisted,
}

export function installQualityPresets() {
  if (typeof window !== 'undefined') window.__qualityPresets = QualityPresets
  return QualityPresets
}
