// QualityPresets -- four named render-quality presets (Low/Medium/High/Ultra), each a concrete
// set of values for the knobs RenderControls.js already documents (shadows, DPR, fog, vegetation,
// rocks, grass, occlusion), plus a couple of live-renderer settings RenderControls doesn't own
// (renderer.shadowMap.enabled, renderer.setPixelRatio) that a preset also needs to touch.
//
// WHY A SEPARATE MODULE, NOT MORE RenderControls ENTRIES: RenderControls.js is a discovery
// registry for individual knobs ("what can I tweak"); a preset is a curated BUNDLE of knob values
// plus a couple of imperative renderer calls, applied together and persisted as one choice. Keeping
// the two separate means RenderControls stays a pure catalog (no apply-a-bundle logic) and this
// module stays a pure bundle-definition + apply/persist surface.
//
// Persistence: the chosen preset NAME is written to localStorage (key below) whenever setPreset()
// is called by the user (explicit choice). autoApplyPersisted() is the boot-time entry point: if a
// name was saved, it re-applies that preset; otherwise it picks an initial preset from cheap device
// heuristics (see chooseInitialPreset) and applies it WITHOUT persisting (so a later real device
// heuristic improvement, or the user's own first explicit choice, still wins over a stale guess).
//
// APPLY CONTRACT: apply(name, { renderer } = {}) sets every window.__<key> knob for the preset via
// RenderControls.set, plus (when a renderer is passed) renderer.shadowMap.enabled and
// renderer.setPixelRatio(dpr) directly -- these two are real live-object calls, not knobs a future
// frame merely reads, so they must be applied immediately rather than deferred to a knob read.

import { RenderControls } from './RenderControls.js'

const STORAGE_KEY = 'spoint.qualityPreset'
const DEFAULT_PRESET = 'Medium'

// Each preset is a set of RenderControls knob values (see RenderControls.js CONTROLS for docs on
// each key) plus the two renderer-level fields (shadowsEnabled, dpr) applied directly.
// Resolution (dpr / dprAuto) is never auto-reduced by any preset, on any device tier -- a user's
// display renders at its own native pixel ratio unconditionally. Only non-resolution quality knobs
// (shadows, fog distance, vegetation) vary by preset/device.
const PRESETS = {
  Low: {
    shadowsEnabled: false,
    dpr: null,           // null => leave device pixel ratio as-is, never capped
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
    // Lower exposure on low-tier: replaces the old ad-hoc isLowEndGpu 0.8 override that used to
    // live in client/app.js -- same value, now preset-driven so it composes with an explicit user
    // preset choice instead of silently fighting it (see AGENTS.md-documented history of exactly
    // this class of "two device-tier opinions drifting" bug).
    toneMappingExposure: 0.8,
  },
  Medium: {
    shadowsEnabled: true,
    dpr: null,          // null => leave device pixel ratio as-is
    dprAuto: false,
    fogFar: 200,
    vegWind: true,
    vegAllOff: false,
    vegHideFar: null,
    grassWind: true,
    halfResWater: false,
    thc: false,
    // ssao/bloom OFF by default on every tier (2026-08-10): live user-witnessed the half-res SSAO
    // upsample producing a persistent dark ground-level smear/ghosting artifact anchored to nearby
    // geometry silhouettes (confirmed via the live ?debugpanel=1 toggle A/B -- disabling ssao alone
    // removed it). Both remain fully wired, live-toggleable RenderControls knobs (window.__renderControls
    // .set('ssao', true) / the debug panel checkbox) for whoever fixes the underlying half-res-upsample
    // artifact next -- this only flips the SHIPPED default, not the feature.
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

let _rendererHandle = null   // captured on first apply()/init() call that passes one, reused by later setPreset() calls that omit it
let _current = null

function _clampDpr(v) {
  const cap = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1
  return v == null ? cap : Math.max(0.5, Math.min(cap, v))
}

// Applies one preset's values onto RenderControls knobs + (if a renderer handle is known) the
// live renderer. Does NOT persist -- callers that want persistence call setPreset() instead.
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
  // toneMappingExposure's set() auto-applies to the bound renderer immediately (see
  // RenderControls.bindTonemapping/applyToneMapping) -- no separate renderer.* call needed here,
  // unlike shadowsEnabled/dpr below which RenderControls does not own.
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

// Explicit user choice: applies AND persists to localStorage.
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

// Cheap device-capability heuristic for the FIRST-RUN default (no persisted choice yet). Mirrors
// the isLowEndGpu heuristic already used at client/app.js boot (deviceInfo.gpuTier/memoryMB/
// hardwareConcurrency from MobileControls.js's detectDevice()), plus a mobile/touch check and
// devicePixelRatio, so the two call sites agree rather than drifting into two device-tier opinions.
// deviceInfo is OPTIONAL: when provided (from detectDevice()) it is authoritative for
// gpuTier/memoryMB/hardwareConcurrency/isMobile; when omitted this reads navigator/window directly
// (still fully consistent with detectDevice()'s own field derivations) so the module works standalone.
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

// Boot-time entry point. If a preset was persisted, re-apply it (a real user choice always wins).
// Otherwise pick+apply an initial preset from device heuristics WITHOUT persisting it, so it never
// shadows a future improved heuristic or the user's own first explicit pick.
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
