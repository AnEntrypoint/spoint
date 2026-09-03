import { components as C, h, applyDiff } from 'anentrypoint-design'
import { getSharedWM, confirmWindow } from './wm/ui.js'

// Live scene entity-id list, set by EditorShell.updateScene, read by the 'entity'-type editorProp so a
// game-maker can wire button->door / spawn->wave / zone->team by picking another placed entity from a
// dropdown (no code). Kept module-level (not threaded through every propField call) so the picker stays
// current as entities come and go without re-plumbing the inspector each scene tick.
let _sceneEntityIds = []
export function setSceneEntityIds(ids) { _sceneEntityIds = Array.isArray(ids) ? ids : [] }
export function getSceneEntityIds() { return _sceneEntityIds }

// Multi-target sync (editor-node-graph-wire-inspector-field-multi-target-sync): the entity-reference
// editorProp field must agree with HookFlowViewer's own targetsOf() normalize-on-read (custom.targets
// array takes precedence over the legacy custom.target scalar when both exist -- see that file's header
// comment and AGENTS.md's 2026-07-21c audit entry). Duplicated here (not imported) since HookFlowViewer.js
// doesn't export it and the two files have no existing shared-util module; keep both in sync by hand if
// the shape ever changes again.
function _targetsOfCustom(custom) {
  if (!custom) return []
  if (Array.isArray(custom.targets)) return custom.targets.filter(t => t != null).map(String)
  if (custom.target != null) return [String(custom.target)]
  return []
}

// Recent color swatches (editor-color-picker-eyedropper): last N picked colors, localStorage-persisted,
// same pattern as the Add-menu's Recent list. Shared across all color propFields in one editor session.
const RECENT_COLORS_KEY = 'ds-editor-recent-colors'
const RECENT_COLORS_CAP = 6
function _loadRecentColors() {
  try {
    const raw = localStorage.getItem(RECENT_COLORS_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.slice(0, RECENT_COLORS_CAP) : []
  } catch (_) { return [] }
}
function _pushRecentColor(hex) {
  if (!hex) return
  const cur = _loadRecentColors().filter(c => c !== hex)
  cur.unshift(hex)
  const next = cur.slice(0, RECENT_COLORS_CAP)
  try { localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(next)) } catch (_) {}
  return next
}

let _toastHost = null
function _ensureToastHost() {
  if (_toastHost && _toastHost.isConnected) return _toastHost
  _toastHost = document.createElement('div')
  _toastHost.id = 'ds-toast-host'
  _toastHost.className = 'ds-247420 ds-ep-toast-host'
  document.body.appendChild(_toastHost)
  _ensureToastHistoryButton()
  return _toastHost
}

let _toastHistoryBtn = null
function _ensureToastHistoryButton() {
  if (_toastHistoryBtn && _toastHistoryBtn.isConnected) return
  _toastHistoryBtn = document.createElement('button')
  _toastHistoryBtn.textContent = '[hist]'
  _toastHistoryBtn.title = 'Recent notifications'
  _toastHistoryBtn.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:9999;background:rgba(18,20,26,0.86);color:#e8eaf0;border:1px solid rgba(255,255,255,0.15);border-radius:5px;padding:3px 7px;font:11px monospace;cursor:pointer;opacity:0.6'
  _toastHistoryBtn.addEventListener('mouseenter', () => { _toastHistoryBtn.style.opacity = '1' })
  _toastHistoryBtn.addEventListener('mouseleave', () => { _toastHistoryBtn.style.opacity = '0.6' })
  _toastHistoryBtn.addEventListener('click', () => {
    const host = document.createElement('div')
    host.id = 'ds-toast-history-host'
    document.body.appendChild(host)
    const items = getToastHistory().slice().reverse()
    applyDiff(host, [
      C.Dialog({
        title: 'Recent notifications', open: true, dismissible: true,
        onClose: () => { applyDiff(host, []); host.remove() },
        children: items.length
          ? items.map(t => h('div', { style: 'padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.08);font:12px monospace;color:' + (t.kind === 'error' ? '#f88' : t.kind === 'success' ? '#8f8' : '#ccc') }, t.message))
          : [h('div', { style: 'color:rgba(255,255,255,0.4);font:12px monospace' }, 'No notifications yet')]
      })
    ])
  })
  document.body.appendChild(_toastHistoryBtn)
}

const _toastHistory = []
const TOAST_HISTORY_CAP = 20
export function getToastHistory() { return _toastHistory.slice() }

// opts.action: { label, onClick } -- optional action button (e.g. Retry) rendered inline in the
// toast; clicking it invokes onClick() and dismisses the toast immediately. When present, ms is
// treated as a minimum -- an actionable toast should stay long enough to actually be clicked, so
// it does not auto-dismiss before ms unless the user acts on it first, and is not swept by the
// (unrelated) auto-dismiss timer of a later toast.
export function showToast(message, kind = 'info', ms = 2400, opts = {}) {
  const host = _ensureToastHost()
  const el = document.createElement('div')
  el.className = 'ds-ep-toast'
  if (kind === 'error') el.classList.add('kind-error')
  else if (kind === 'success') el.classList.add('kind-success')
  else if (kind === 'warn') el.classList.add('kind-warn')
  el.setAttribute('role', 'status')
  const textSpan = document.createElement('span')
  textSpan.textContent = String(message)
  el.appendChild(textSpan)
  const action = opts && opts.action
  if (action && typeof action.onClick === 'function') {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = action.label || 'Retry'
    btn.style.cssText = 'margin-left:10px;background:transparent;border:1px solid currentColor;border-radius:4px;color:inherit;font:inherit;padding:2px 8px;cursor:pointer'
    btn.addEventListener('click', () => {
      try { action.onClick() } finally { el.classList.add('leaving'); setTimeout(() => el.remove(), 220) }
    })
    el.appendChild(btn)
  }
  host.appendChild(el)
  _toastHistory.push({ message: String(message), kind, time: (typeof performance !== 'undefined' ? performance.now() : 0) })
  if (_toastHistory.length > TOAST_HISTORY_CAP) _toastHistory.shift()
  setTimeout(() => { if (el.isConnected) { el.classList.add('leaving'); setTimeout(() => el.remove(), 220) } }, action ? Math.max(ms, 8000) : ms)
}

export function showConfirm(opts = {}) {
  const wm = getSharedWM()
  if (wm) return confirmWindow(wm, opts)
  const { title = 'confirm', message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', destructive = false } = opts
  return new Promise(resolve => {
    const host = document.createElement('div')
    host.id = 'ds-confirm-host'
    document.body.appendChild(host)
    const close = (val) => { host.remove(); resolve(val) }
    applyDiff(host, [
      C.ConfirmDialog({
        title, message, confirmLabel, cancelLabel, destructive,
        onConfirm: () => close(true),
        onCancel:  () => close(false)
      })
    ])
  })
}

export function dragNumberVNode(value, onChange, axis, opts = {}) {
  // opts: {min, max, step} for a bounded/range editorProp -- keydown + scrub honor step, and every write clamps
  // to [min,max]. Omitted -> the historical free 0.01/1.0 behaviour, so existing call sites are unchanged.
  const _step = (typeof opts.step === 'number' && opts.step > 0) ? opts.step : 0.01
  const _clamp = (v) => {
    if (typeof opts.min === 'number' && v < opts.min) v = opts.min
    if (typeof opts.max === 'number' && v > opts.max) v = opts.max
    return v
  }
  const emit = (v) => onChange(_clamp(v))
  const initial = typeof value === 'number' ? value.toFixed(3) : String(value)
  const attachScrub = (el) => {
    // Re-render from an external value change would stomp mid-typed text with no focus check; restore it while focused.
    if (el && document.activeElement === el && el._dsUserTyping) { el.value = el._dsUserTyping; return }
    if (!el || el._dsScrub) return
    el._dsScrub = true
    el.addEventListener('input', () => { el._dsUserTyping = document.activeElement === el ? el.value : null })
    el.addEventListener('blur', () => { el._dsUserTyping = null })
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()
      const step = e.shiftKey ? Math.max(_step, 1) : _step
      const cur = parseFloat(el.value) || 0
      const next = _clamp(e.key === 'ArrowUp' ? cur + step : cur - step)
      el.value = next.toFixed(3); el._dsUserTyping = null
      emit(next)
    })
    if (typeof C.useNumberScrub === 'function') {
      const handle = C.useNumberScrub(el, {
        step: _step,
        getValue: () => parseFloat(el.value) || 0,
        onChange: (v) => { const c = _clamp(v); el.value = c.toFixed(3); emit(c) }
      })
      el._dsScrubDestroy = handle.destroy
      return
    }
    let d = false, sx = 0, sv = 0
    const move = (ev) => { if (!d) return; const v = _clamp(sv + (ev.clientX - sx) * _step); el.value = v.toFixed(3); emit(v) }
    const up = () => { d = false; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    el.addEventListener('mousedown', (e) => {
      if (document.activeElement === el) return
      d = true; sx = e.clientX; sv = parseFloat(el.value) || 0; e.preventDefault()
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
    })
  }
  // Do not use kit's `.row` class: its `!important` grid rule clips the input to min-content.
  return h('span', { class: 'ds-ep-vec3-cell', style: 'display:grid;width:100%;grid-template-columns:' + (axis ? '9px ' : '') + 'minmax(0,1fr);align-items:center;gap:2px;min-width:0' },
    axis ? h('span', { class: 'ds-ep-propfield-hint', style: 'text-align:center' }, axis) : null,
    h('input', {
      class: 'ds-input-bare',
      type: 'text',
      size: '1',
      value: initial,
      style: 'width:100%;min-width:0;box-sizing:border-box;text-align:center;cursor:ew-resize;touch-action:none',
      ref: attachScrub,
      onchange: (e) => {
        const raw = e.target.value
        // opts.allowExpr: let the caller (e.g. EditorInspector's relative +5/*2 parsing) see the raw typed
        // string first. It returns null for "not an expression" so we fall through to the normal absolute-
        // number parse below -- existing non-expr call sites are byte-identical to before this flag existed.
        if (opts.allowExpr) {
          const viaExpr = opts.allowExpr(raw)
          if (viaExpr !== null && viaExpr !== undefined && Number.isFinite(viaExpr)) {
            const c = _clamp(viaExpr)
            e.target.value = c.toFixed(3)
            onChange(c)
            return
          }
        }
        const parsed = parseFloat(raw)
        if (!Number.isFinite(parsed)) { e.target.value = initial; showToast('Invalid number, reverted', 'error'); return }
        const c = _clamp(parsed)
        if (c !== parsed) e.target.value = c.toFixed(3)
        onChange(c)
      }
    })
  )
}

export function drag(label, value, onChange) {
  const row = document.createElement('div')
  row.className = 'row'
  row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0'
  applyDiff(row, [dragNumberVNode(value, onChange, label)])
  return row
}

export function v3(label, vals, key, getEntity, getOnChange) {
  const host = document.createElement('div')
  const writeAxis = (i, v) => {
    const entity = getEntity(), onChange = getOnChange()
    if (!entity || !onChange) return
    const c = entity[key] ? [...entity[key]] : [0, 0, 0]; c[i] = v; onChange(key, c)
  }
  const mount = () => {
    if (!host.isConnected) return queueMicrotask(mount)
    applyDiff(host, [
      C.PropertyField({ label, children: [
        h('span', { style: 'display:flex;flex-direction:column;gap:2px;width:100%' },
          dragNumberVNode(vals[0] || 0, v => writeAxis(0, v), 'x'),
          dragNumberVNode(vals[1] || 0, v => writeAxis(1, v), 'y'),
          dragNumberVNode(vals[2] || 0, v => writeAxis(2, v), 'z')
        )
      ] })
    ])
  }
  queueMicrotask(mount)
  return host
}

export function propField(f, getEntity, getOnChange) {
  if (!f) return document.createTextNode('')
  const host = document.createElement('div')
  const key = f.key, lbl = f.label || f.key
  const read = () => getEntity()?.custom?.[key] ?? f.default ?? (f.type === 'number' ? 0 : '')
  const emit = v => { const cb = getOnChange(); if (cb) cb('custom.' + key, v) }
  const mount = () => {
    if (!host.isConnected) return queueMicrotask(mount)
    const val = read()
    let child
    if (f.type === 'number' || f.type === 'range') {
      // 'range' is a bounded number: f.min/f.max/f.step drive clamp + step. 'number' with those set behaves identically.
      child = dragNumberVNode(val, emit, undefined, { min: f.min, max: f.max, step: f.step })
    } else if (f.type === 'vec3') {
      // Three x/y/z cells writing a 3-array (patrol target, spawn offset, size). Immutable per-axis write so
      // consecutive axis edits don't read a stale array; default to [0,0,0].
      const arr = Array.isArray(val) ? val : (Array.isArray(f.default) ? f.default : [0, 0, 0])
      const writeAxis = (i, v) => { const c = [arr[0] || 0, arr[1] || 0, arr[2] || 0]; c[i] = v; emit(c) }
      child = h('span', { class: 'ds-ep-vec3', style: 'display:flex;gap:2px;flex:1;min-width:0' },
        dragNumberVNode(arr[0] || 0, v => writeAxis(0, v), 'x'),
        dragNumberVNode(arr[1] || 0, v => writeAxis(1, v), 'y'),
        dragNumberVNode(arr[2] || 0, v => writeAxis(2, v), 'z')
      )
    } else if (f.type === 'entity') {
      // Entity-reference: pick one or more other placed entities by id to wire a relationship (button->door,
      // spawn->wave, zone->team). Reads via the SAME custom.targets-array-precedence rule HookFlowViewer's
      // own targetsOf() uses (see _targetsOfCustom above), so a HookFlow canvas wire-drag and an Inspector-tab
      // edit stay in sync instead of the Inspector silently editing a stale legacy custom.target scalar that
      // targetsOf() ignores whenever a custom.targets array also exists (the bug this field type used to have).
      // Every write here goes to custom.targets (array, even for a single target) -- never back to the legacy
      // custom.target scalar -- so HookFlow and Inspector always converge on the one array-shaped source of
      // truth after the first Inspector edit, matching how client/app.js's onWireCreate/onEdgeRemove already
      // write. Rendered as N rows (one per wired target) + an "add target" row, mirroring the existing 'list'
      // field's row/add-row UX below rather than depending on an unverified multi-select capability in the
      // vendored kit's C.Select.
      const targets = _targetsOfCustom(getEntity()?.custom)
      const selfId = getEntity()?.id
      const ids = getSceneEntityIds().filter(id => id !== selfId)
      const emitTargets = (next) => { const cb = getOnChange(); if (cb) cb('custom.targets', next) }
      const optionsFor = (currentValue) => {
        const opts = [{ value: '', label: '(none)' }, ...ids.filter(id => id === currentValue || !targets.includes(id)).map(id => ({ value: String(id), label: String(id) }))]
        if (currentValue && !opts.some(o => o.value === currentValue)) opts.push({ value: currentValue, label: currentValue + ' (offscene)' })
        return opts
      }
      const writeAt = (i, v) => {
        const next = targets.slice()
        if (!v) { next.splice(i, 1) } else { next[i] = v }
        emitTargets(next)
      }
      const removeAt = (i) => { const next = targets.slice(); next.splice(i, 1); emitTargets(next) }
      const addRow = () => {
        const remaining = ids.find(id => !targets.includes(id))
        if (remaining) emitTargets([...targets, remaining])
      }
      const canAddMore = ids.some(id => !targets.includes(id))
      child = h('span', { class: 'ds-ep-list', style: 'display:flex;flex-direction:column;gap:2px;flex:1;min-width:0' },
        ...(targets.length ? targets.map((t, i) => h('span', { style: 'display:flex;gap:2px;align-items:center' },
          C.Select({ value: t, options: optionsFor(t), onChange: v => writeAt(i, v || null) }),
          h('button', { class: 'ds-input-bare', title: 'Remove this target', style: 'cursor:pointer;padding:0 4px;opacity:0.6', onclick: () => removeAt(i) }, '−')
        )) : [C.Select({ value: '', options: optionsFor(''), onChange: v => { if (v) emitTargets([v]) } })]),
        canAddMore ? h('button', { class: 'ds-input-bare', style: 'cursor:pointer;opacity:0.7;align-self:flex-start', onclick: addRow }, '+ add target') : null
      )
    } else if (f.type === 'color') {
      const curColor = val || '#ffffff'
      const applyColor = (hex) => { _pushRecentColor(hex); emit(hex); mount() }
      // window.EyeDropper is a real, partially-supported browser API (Chromium-based only as of this
      // writing) -- feature-detect, never polyfill. Render nothing extra when unavailable rather than a
      // disabled dead button, per the row's own guidance ("should not render or should be disabled").
      const hasEyeDropper = typeof window !== 'undefined' && typeof window.EyeDropper === 'function'
      const eyedropBtn = hasEyeDropper
        ? h('button', {
            class: 'ds-input-bare', title: 'Pick a color from anywhere on screen',
            style: 'cursor:pointer;padding:0 4px;opacity:0.75;font-size:12px', type: 'button',
            onclick: async () => {
              try {
                const ed = new window.EyeDropper()
                const res = await ed.open()
                if (res && res.sRGBHex) applyColor(res.sRGBHex)
              } catch (_) { /* user cancelled the pick -- not an error */ }
            }
          }, '💧')
        : h('span', { title: 'Eyedropper not supported in this browser', style: 'opacity:0.25;padding:0 4px;font-size:12px' }, '💧')
      const recent = _loadRecentColors()
      const swatchRow = recent.length
        ? h('span', { style: 'display:flex;gap:3px;margin-top:3px;flex-wrap:wrap' },
            ...recent.map(hex => h('button', {
              class: 'ds-input-bare', title: hex, type: 'button',
              style: `width:14px;height:14px;padding:0;border-radius:3px;cursor:pointer;background:${hex};border:1px solid rgba(255,255,255,0.25)`,
              onclick: () => applyColor(hex)
            }))
          )
        : null
      child = h('span', { style: 'display:flex;flex-direction:column;min-width:0' },
        h('span', { style: 'display:flex;align-items:center;gap:4px' },
          h('input', { type: 'color', value: curColor, class: 'ds-input-color', onchange: e => applyColor(e.target.value) }),
          eyedropBtn
        ),
        swatchRow
      )
    } else if (f.type === 'checkbox') {
      child = h('input', { type: 'checkbox', class: 'ds-input-check', checked: !!val, onchange: e => emit(e.target.checked) })
    } else if (f.type === 'select' && f.options) {
      // Option may be a bare string (value===label) or {value,label} for a human-readable dropdown.
      child = C.Select({
        value: String(val ?? ''),
        options: f.options.map(o => (o && typeof o === 'object') ? { value: String(o.value), label: String(o.label ?? o.value) } : { value: o, label: o }),
        onChange: v => emit(v)
      })
    } else if (f.type === 'textarea') {
      // Multi-line free text (dialogue lines, a JSON blob, a question list). Stored as a raw string.
      child = h('textarea', { class: 'ds-input-bare', rows: String(f.rows || 4), style: 'flex:1;min-width:0;resize:vertical;font-family:inherit',
        oninput: e => emit(e.target.value) }, String(val ?? ''))
    } else if (f.type === 'list') {
      // Repeatable string rows (N waypoint names, N quiz answers, N spawn tags). Stored as a string[].
      const arr = Array.isArray(val) ? val : (Array.isArray(f.default) ? f.default : [])
      const writeAt = (i, v) => { const c = arr.slice(); c[i] = v; emit(c) }
      const removeAt = (i) => { const c = arr.slice(); c.splice(i, 1); emit(c) }
      const addRow = () => emit([...arr, ''])
      child = h('span', { class: 'ds-ep-list', style: 'display:flex;flex-direction:column;gap:2px;flex:1;min-width:0' },
        ...arr.map((item, i) => h('span', { style: 'display:flex;gap:2px' },
          h('input', { class: 'ds-input-bare', value: String(item ?? ''), style: 'flex:1;min-width:0', onchange: e => writeAt(i, e.target.value) }),
          h('button', { class: 'ds-input-bare', title: 'Remove', style: 'cursor:pointer;padding:0 4px;opacity:0.6', onclick: () => removeAt(i) }, '−')
        )),
        h('button', { class: 'ds-input-bare', style: 'cursor:pointer;opacity:0.7;align-self:flex-start', onclick: addRow }, '+ add')
      )
    } else {
      child = h('input', { class: 'ds-input-bare', value: String(val ?? ''), style: 'flex:1;min-width:0', onchange: e => emit(e.target.value) })
    }
    // Entity-reference fields track their override/reset state off the normalized targets array (which may
    // live under custom.targets, not custom[key]) rather than the generic custom[key]!==default check below.
    const hasCustomOverride = f.type === 'entity'
      ? _targetsOfCustom(getEntity()?.custom).length > 0
      : (getEntity()?.custom?.[key] !== undefined && getEntity().custom[key] !== f.default)
    const resetBtn = hasCustomOverride
      ? h('button', { class: 'ds-input-bare', title: 'Reset to default', style: 'cursor:pointer;padding:0 4px;opacity:0.6', onclick: () => { const cb = getOnChange(); if (cb) cb('custom.targets', []) } }, 'x')
      : null
    // f.help (optional) -> hover tooltip on the field label, so a maker learns what a prop
    // controls without reading the app source. The label also gets a subtle "?" cue when help exists.
    const labelAttrs = { class: 'ds-ep-propfield-label' }
    if (f.help) labelAttrs.title = f.help
    applyDiff(host, [
      h('label', { class: 'ds-ep-propfield' },
        h('span', labelAttrs, f.help ? lbl + ' ⓘ' : lbl),
        h('span', { class: 'ds-ep-propfield-value', style: 'display:flex;align-items:center;gap:4px' }, child, resetBtn)
      )
    ])
  }
  queueMicrotask(mount)
  return host
}
