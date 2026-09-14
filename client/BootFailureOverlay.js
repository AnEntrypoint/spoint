import { QualityPresets } from './core/QualityPresets.js'

function _shadowCascadeCountForBoot(deviceInfo) {
  const explicit = typeof window !== 'undefined' ? window.__shadowCascades : undefined
  if (Number.isFinite(explicit)) return Math.max(1, Math.min(3, Math.round(explicit)))
  const presetName = QualityPresets.getPersisted() || QualityPresets.chooseInitialPreset(deviceInfo)
  const byTier = { Low: 1, Medium: 1, High: 2, Ultra: 3 }
  return byTier[presetName] || 1
}

let _bootFailureShown = false
function _showBootFailureOverlay(title, detail) {
  if (_bootFailureShown) return
  _bootFailureShown = true
  try {
    const o = document.createElement('div')
    o.setAttribute('role', 'alert')
    o.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px;background:#0b0e14;color:#e6e6e6;font:16px/1.5 system-ui,sans-serif;text-align:center'
    const titleEl = document.createElement('div')
    titleEl.style.cssText = 'font-size:22px;font-weight:600;margin-bottom:12px'
    titleEl.textContent = title
    const detailEl = document.createElement('div')
    detailEl.style.cssText = 'max-width:640px;white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,monospace;opacity:0.85;margin-top:8px;text-align:left'
    detailEl.textContent = detail || ''
    const wrap = document.createElement('div')
    wrap.style.cssText = 'max-width:640px'
    wrap.appendChild(titleEl)
    wrap.appendChild(detailEl)
    o.appendChild(wrap)
    document.body.appendChild(o)
    const ls = document.getElementById('loading-screen') || document.querySelector('.loading-screen')
    if (ls) ls.style.display = 'none'
  } catch (_) { }
}

export { _shadowCascadeCountForBoot, _showBootFailureOverlay }
