// In-game settings menu: mouse sensitivity, invert-Y, FOV, master/SFX/music volume, quality
// preset, DPR-auto toggle. Plain DOM (not webjsx/ui-root), same doctrine as ConnectionStatus.js's
// toast host and PeerHostUI.js's cards -- renders reliably regardless of ui-root diff churn, and
// this menu needs many native form controls (range/select/checkbox) a diff-vnode host adds nothing
// for. Values persist to localStorage under one namespaced key and are re-applied on createSettingsMenu()
// construction, so a reload keeps the player's choices without them re-opening the menu.
//
// Deps (all optional -- a missing dep just skips that control's live effect, the UI still renders
// and persists the value for when the dep IS available):
//   getCam()      -> the camera controller from core/camera.js (applyConfig({mouseSensitivity,invertY,fov}))
//   getRenderer() -> the THREE.WebGLRenderer (for DPR-auto handoff to QualityPresets.apply)
//   AudioMixer    -> { setVolume(category, v), getVolume(category) } from apps/_lib/audio.js
//   QualityPresets-> the module export from core/QualityPresets.js (setPreset/names/current)

import { QualityPresets } from '../core/QualityPresets.js'
import { AudioMixer } from '../../apps/_lib/audio.js'
import { getCacheStats, clearCache } from '../ModelCache.js'

const STORAGE_KEY = 'spoint.settings'

const DEFAULTS = {
  mouseSensitivity: 0.002,
  invertY: false,
  fov: 75,
  masterVolume: 1,
  sfxVolume: 1,
  musicVolume: 1,
  qualityPreset: 'Medium',
  dprAuto: false,
  fontScale: 100,
  colorblindMode: 'normal',
  reducedMotion: false,
  gamepadEnabled: true,
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed : {}
  } catch (_) { return {} }
}

function saveValues(values) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(values)) } catch (e) { console.warn('[settings] localStorage write failed:', e?.message || e) }
}

function ensureStyles() {
  if (document.getElementById('settings-menu-style')) return
  const style = document.createElement('style')
  style.id = 'settings-menu-style'
  style.textContent = `
#settings-menu-overlay {
  position: fixed; inset: 0; z-index: 10800;
  display: none; align-items: center; justify-content: center;
  background: color-mix(in oklab, #000 55%, transparent);
  font: 13px var(--ff-mono, monospace);
}
#settings-menu-overlay.open { display: flex; }
#settings-menu-panel {
  width: min(420px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  overflow-y: auto;
  background: color-mix(in oklab, var(--panel-1, #050b12) 92%, transparent);
  border: 1px solid var(--rule, rgba(0,210,255,0.3));
  border-radius: 8px;
  color: var(--panel-text, #fff);
  padding: 16px 18px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
}
#settings-menu-panel h2 { margin: 0 0 12px; font-size: 15px; letter-spacing: 0.5px; }
#settings-menu-panel .sm-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 0; border-bottom: 1px solid color-mix(in oklab, var(--rule, #2a3a44) 60%, transparent); }
#settings-menu-panel .sm-row:last-of-type { border-bottom: none; }
#settings-menu-panel .sm-label { color: var(--panel-text-3, rgba(255,255,255,0.7)); flex: none; min-width: 130px; }
#settings-menu-panel .sm-control { flex: 1; display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
#settings-menu-panel input[type="range"] { flex: 1; accent-color: var(--accent, #00d2ff); }
#settings-menu-panel .sm-val { width: 42px; text-align: right; color: var(--accent, #00d2ff); font-variant-numeric: tabular-nums; }
#settings-menu-panel select { background: var(--panel-0, #0a141c); color: var(--panel-text, #fff); border: 1px solid var(--rule, rgba(0,210,255,0.3)); border-radius: 4px; padding: 3px 6px; }
#settings-menu-panel input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent, #00d2ff); }
#settings-menu-panel .sm-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
#settings-menu-panel button { background: var(--panel-0, #0a141c); color: var(--panel-text, #fff); border: 1px solid var(--rule, rgba(0,210,255,0.3)); border-radius: 5px; padding: 6px 14px; cursor: pointer; font: inherit; }
#settings-menu-panel button:hover { border-color: var(--accent, #00d2ff); }
#settings-menu-panel button.sm-primary { background: var(--accent, #00d2ff); color: #001318; border-color: var(--accent, #00d2ff); font-weight: 600; }
#settings-menu-panel h3 { margin: 16px 0 6px; font-size: 12px; letter-spacing: 0.5px; color: var(--panel-text-3, rgba(255,255,255,0.7)); text-transform: uppercase; }
#settings-menu-panel .sm-cache-block { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; }
#settings-menu-panel .sm-cache-summary { display: flex; justify-content: space-between; font-size: 12px; color: var(--panel-text-3, rgba(255,255,255,0.7)); }
#settings-menu-panel .sm-cache-bar { position: relative; height: 8px; border-radius: 4px; background: color-mix(in oklab, var(--rule, #2a3a44) 70%, transparent); overflow: hidden; }
#settings-menu-panel .sm-cache-bar-fill { position: absolute; inset: 0 auto 0 0; height: 100%; background: var(--accent, #00d2ff); border-radius: 4px; transition: width 0.2s ease, background 0.2s ease; }
#settings-menu-panel .sm-cache-bar-fill.sm-cache-over { background: #ff5a4e; }
#settings-menu-panel .sm-cache-actions { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 2px; }
#settings-menu-panel .sm-cache-status { font-size: 11px; color: var(--panel-text-3, rgba(255,255,255,0.7)); flex: 1; }
#settings-menu-panel button.sm-danger:hover { border-color: #ff5a4e; color: #ff5a4e; }
`
  document.head.appendChild(style)
}

export function createSettingsMenu({ getCam = () => null, getRenderer = () => null } = {}) {
  ensureStyles()

  const values = { ...DEFAULTS, ...loadSaved() }
  let onCloseCb = null
  let _cacheSectionCancel = null

  const overlay = document.createElement('div')
  overlay.id = 'settings-menu-overlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', 'Settings')
  const panel = document.createElement('div')
  panel.id = 'settings-menu-panel'
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  // Clicking the dim backdrop (not the panel itself) closes, matching standard modal convention.
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close() })

  function _row(labelText, controlEl) {
    const row = document.createElement('div')
    row.className = 'sm-row'
    const label = document.createElement('span')
    label.className = 'sm-label'
    label.textContent = labelText
    const control = document.createElement('span')
    control.className = 'sm-control'
    control.appendChild(controlEl)
    row.appendChild(label); row.appendChild(control)
    return row
  }

  function _range(min, max, step, value, onInput) {
    const wrap = document.createElement('span')
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1'
    const input = document.createElement('input')
    input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value)
    const out = document.createElement('span')
    out.className = 'sm-val'
    out.textContent = String(value)
    input.addEventListener('input', () => {
      const v = parseFloat(input.value)
      out.textContent = step < 1 ? v.toFixed(2) : String(v)
      onInput(v)
    })
    wrap.appendChild(input); wrap.appendChild(out)
    return wrap
  }

  function _checkbox(checked, onChange) {
    const input = document.createElement('input')
    input.type = 'checkbox'; input.checked = !!checked
    input.addEventListener('change', () => onChange(input.checked))
    return input
  }

  function _select(options, value, onChange) {
    const sel = document.createElement('select')
    for (const opt of options) {
      const o = document.createElement('option')
      o.value = opt; o.textContent = opt
      if (opt === value) o.selected = true
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => onChange(sel.value))
    return sel
  }

  function _formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '0 MB'
    const mb = n / (1024 * 1024)
    if (mb < 1000) return `${mb.toFixed(1)} MB`
    return `${(mb / 1024).toFixed(2)} GB`
  }

  function _persist() { saveValues(values) }

  function _applyMouseSensitivity(v) { values.mouseSensitivity = v; _persist(); const cam = getCam(); if (cam) cam.applyConfig({ mouseSensitivity: v }) }
  function _applyInvertY(v) { values.invertY = v; _persist(); const cam = getCam(); if (cam) cam.applyConfig({ invertY: v }) }
  function _applyFov(v) { values.fov = v; _persist(); const cam = getCam(); if (cam) cam.applyConfig({ fov: v }) }
  function _applyMasterVolume(v) { values.masterVolume = v; _persist(); AudioMixer.setVolume('master', v) }
  function _applySfxVolume(v) { values.sfxVolume = v; _persist(); AudioMixer.setVolume('sfx', v) }
  function _applyMusicVolume(v) { values.musicVolume = v; _persist(); AudioMixer.setVolume('music', v) }
  function _applyQualityPreset(name) { values.qualityPreset = name; _persist(); QualityPresets.setPreset(name, { renderer: getRenderer() }) }
  function _applyDprAuto(v) {
    values.dprAuto = v; _persist()
    if (typeof window !== 'undefined') { window.__dprAuto = v; window.__dprOff = !v }
  }
  function _applyFontScale(v) { values.fontScale = v; _persist(); if (typeof window !== 'undefined' && window.__a11y) window.__a11y.setFontScale(v) }
  function _applyColorblindMode(mode) { values.colorblindMode = mode; _persist(); if (typeof window !== 'undefined' && window.__colorblindFilter) window.__colorblindFilter.setMode(mode) }
  function _applyReducedMotion(v) { values.reducedMotion = v; _persist(); if (typeof window !== 'undefined' && window.__a11y) window.__a11y.setReducedMotion(v) }
  function _applyGamepadEnabled(v) { values.gamepadEnabled = v; _persist(); if (typeof window !== 'undefined' && window.__gamepadController) { if (v) window.__gamepadController.enable(); else window.__gamepadController.disable() } }

  // Apply every persisted/default value immediately at construction (mirrors QualityPresets'
  // autoApplyPersisted contract: a saved setting is re-applied on load without the player having
  // to reopen the menu). Quality preset itself is intentionally NOT re-applied here -- boot already
  // calls QualityPresets.autoApplyPersisted() once with the real renderer at the right point in
  // boot sequence; re-applying here would just be a redundant second apply with the same renderer.
  function applyAllOnLoad() {
    const cam = getCam()
    if (cam) cam.applyConfig({ mouseSensitivity: values.mouseSensitivity, invertY: values.invertY, fov: values.fov })
    AudioMixer.setVolume('master', values.masterVolume)
    AudioMixer.setVolume('sfx', values.sfxVolume)
    AudioMixer.setVolume('music', values.musicVolume)
    if (typeof window !== 'undefined') { window.__dprAuto = values.dprAuto; window.__dprOff = !values.dprAuto }
  }

  // _buildCacheSection() -> { el, cancel }. Cache-size budget visibility/control: reads
  // ModelCache.js's existing LRU manifest (getCacheStats, the same source of truth the silent
  // SOFT_CAP/HARD_CAP eviction already enforces against) and renders a usage bar + entry count +
  // a manual "Clear Cache" action (clearCache, reusing the existing dbDelete/manifest primitives --
  // no parallel accounting). Async by nature (IndexedDB read) so it renders a loading placeholder
  // synchronously then fills in once the real stats resolve; `cancel()` flips the `cancelled` guard
  // so a stale in-flight refresh from a torn-down/rebuilt panel can never write into detached DOM.
  function _buildCacheSection() {
    const h3 = document.createElement('h3')
    h3.textContent = 'Storage'

    const block = document.createElement('div')
    block.className = 'sm-cache-block'

    const summary = document.createElement('div')
    summary.className = 'sm-cache-summary'
    const summaryLeft = document.createElement('span')
    summaryLeft.textContent = 'Asset cache'
    const summaryRight = document.createElement('span')
    summaryRight.textContent = 'Loading...'
    summary.appendChild(summaryLeft); summary.appendChild(summaryRight)

    const bar = document.createElement('div')
    bar.className = 'sm-cache-bar'
    const barFill = document.createElement('div')
    barFill.className = 'sm-cache-bar-fill'
    barFill.style.width = '0%'
    bar.appendChild(barFill)

    const actions = document.createElement('div')
    actions.className = 'sm-cache-actions'
    const status = document.createElement('span')
    status.className = 'sm-cache-status'
    status.textContent = ''
    const clearBtn = document.createElement('button')
    clearBtn.className = 'sm-danger'
    clearBtn.textContent = 'Clear Cache'
    actions.appendChild(status); actions.appendChild(clearBtn)

    block.appendChild(summary); block.appendChild(bar); block.appendChild(actions)

    let cancelled = false
    let statusClearTimer = null

    // refresh(opts.preserveStatus) -> re-reads getCacheStats() and repaints the summary/bar.
    // preserveStatus defaults false (the initial load and any background poll have no status
    // message to protect); the post-clear handler below passes true so its own "Cleared N items"
    // confirmation survives the refresh() it immediately triggers, instead of being wiped by this
    // function's own reset on the very next microtask (the bug a first pass here shipped with).
    async function refresh({ preserveStatus = false } = {}) {
      if (!preserveStatus) status.textContent = ''
      clearBtn.disabled = false
      let stats
      try { stats = await getCacheStats() } catch { stats = null }
      if (cancelled) return
      if (!stats) {
        summaryRight.textContent = 'unavailable'
        return
      }
      const { totalBytes, entryCount, softCap, hardCap } = stats
      summaryRight.textContent = `${_formatBytes(totalBytes)} / ${_formatBytes(softCap)} (${entryCount} item${entryCount === 1 ? '' : 's'})`
      const pct = hardCap > 0 ? Math.min(100, (totalBytes / hardCap) * 100) : 0
      barFill.style.width = `${pct}%`
      barFill.classList.toggle('sm-cache-over', totalBytes > softCap)
    }

    clearBtn.addEventListener('click', async () => {
      if (statusClearTimer) { clearTimeout(statusClearTimer); statusClearTimer = null }
      clearBtn.disabled = true
      status.textContent = 'Clearing...'
      let result
      try { result = await clearCache() } catch { result = null }
      if (cancelled) return
      status.textContent = result ? `Cleared ${result.cleared} item${result.cleared === 1 ? '' : 's'}` : 'Clear failed'
      await refresh({ preserveStatus: true })
      if (cancelled) return
      statusClearTimer = setTimeout(() => { if (!cancelled) status.textContent = '' }, 4000)
    })

    refresh()

    const frag = document.createDocumentFragment()
    frag.appendChild(h3)
    frag.appendChild(block)
    return {
      el: frag,
      cancel: () => { cancelled = true; if (statusClearTimer) { clearTimeout(statusClearTimer); statusClearTimer = null } },
    }
  }

  function render() {
    if (_cacheSectionCancel) { _cacheSectionCancel(); _cacheSectionCancel = null }
    panel.innerHTML = ''
    const h2 = document.createElement('h2')
    h2.textContent = 'Settings'
    panel.appendChild(h2)

    panel.appendChild(_row('Mouse Sensitivity', _range(0.0005, 0.006, 0.0005, values.mouseSensitivity, _applyMouseSensitivity)))
    panel.appendChild(_row('Invert Y', _checkbox(values.invertY, _applyInvertY)))
    panel.appendChild(_row('Field of View', _range(50, 110, 1, values.fov, _applyFov)))
    panel.appendChild(_row('Master Volume', _range(0, 1, 0.01, values.masterVolume, _applyMasterVolume)))
    panel.appendChild(_row('SFX Volume', _range(0, 1, 0.01, values.sfxVolume, _applySfxVolume)))
    panel.appendChild(_row('Music Volume', _range(0, 1, 0.01, values.musicVolume, _applyMusicVolume)))
    panel.appendChild(_row('Quality Preset', _select(QualityPresets.names, values.qualityPreset, _applyQualityPreset)))
    panel.appendChild(_row('Auto Resolution', _checkbox(values.dprAuto, _applyDprAuto)))

    // Accessibility section
    const a11yH3 = document.createElement('h3')
    a11yH3.textContent = 'Accessibility'
    panel.appendChild(a11yH3)

    panel.appendChild(_row('Font Scale', _range(80, 120, 5, values.fontScale, _applyFontScale)))
    panel.appendChild(_row('Colorblind Mode', _select(['normal', 'deuteranopia', 'protanopia', 'tritanopia'], values.colorblindMode, _applyColorblindMode)))
    panel.appendChild(_row('Reduced Motion', _checkbox(values.reducedMotion, _applyReducedMotion)))
    panel.appendChild(_row('Gamepad Support', _checkbox(values.gamepadEnabled, _applyGamepadEnabled)))

    const cacheSection = _buildCacheSection()
    _cacheSectionCancel = cacheSection.cancel
    panel.appendChild(cacheSection.el)

    const footer = document.createElement('div')
    footer.className = 'sm-footer'
    const closeBtn = document.createElement('button')
    closeBtn.className = 'sm-primary'
    closeBtn.textContent = 'Close'
    closeBtn.addEventListener('click', close)
    footer.appendChild(closeBtn)
    panel.appendChild(footer)
  }

  function open() {
    render()
    overlay.classList.add('open')
  }
  function close() {
    overlay.classList.remove('open')
    if (onCloseCb) onCloseCb()
  }
  function toggle() { if (overlay.classList.contains('open')) close(); else open() }

  applyAllOnLoad()

  return {
    open, close, toggle,
    get isOpen() { return overlay.classList.contains('open') },
    onClose: cb => { onCloseCb = cb },
    getValues: () => ({ ...values }),
    destroy() { if (_cacheSectionCancel) _cacheSectionCancel(); overlay.remove() },
  }
}
