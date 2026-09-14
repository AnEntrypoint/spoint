import { components as C, h, applyDiff } from 'anentrypoint-design'
import { getSharedWM, confirmWindow } from './wm/ui.js'

let _sceneEntityIds = []
export function setSceneEntityIds(ids) { _sceneEntityIds = Array.isArray(ids) ? ids : [] }
export function getSceneEntityIds() { return _sceneEntityIds }

function _targetsOfCustom(custom) {
  if (!custom) return []
  if (Array.isArray(custom.targets)) return custom.targets.filter(t => t != null).map(String)
  if (custom.target != null) return [String(custom.target)]
  return []
}

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
  const _step = (typeof opts.step === 'number' && opts.step > 0) ? opts.step : 0.01
  const _clamp = (v) => {
    if (typeof opts.min === 'number' && v < opts.min) v = opts.min
    if (typeof opts.max === 'number' && v > opts.max) v = opts.max
    return v
  }
  const emit = (v) => onChange(_clamp(v))
  const initial = typeof value === 'number' ? value.toFixed(3) : String(value)
  const attachScrub = (el) => {
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
      child = dragNumberVNode(val, emit, undefined, { min: f.min, max: f.max, step: f.step })
    } else if (f.type === 'vec3') {
      const arr = Array.isArray(val) ? val : (Array.isArray(f.default) ? f.default : [0, 0, 0])
      const writeAxis = (i, v) => { const c = [arr[0] || 0, arr[1] || 0, arr[2] || 0]; c[i] = v; emit(c) }
      child = h('span', { class: 'ds-ep-vec3', style: 'display:flex;gap:2px;flex:1;min-width:0' },
        dragNumberVNode(arr[0] || 0, v => writeAxis(0, v), 'x'),
        dragNumberVNode(arr[1] || 0, v => writeAxis(1, v), 'y'),
        dragNumberVNode(arr[2] || 0, v => writeAxis(2, v), 'z')
      )
    } else if (f.type === 'entity') {
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
              } catch (_) { }
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
      child = C.Select({
        value: String(val ?? ''),
        options: f.options.map(o => (o && typeof o === 'object') ? { value: String(o.value), label: String(o.label ?? o.value) } : { value: o, label: o }),
        onChange: v => emit(v)
      })
    } else if (f.type === 'textarea') {
      child = h('textarea', { class: 'ds-input-bare', rows: String(f.rows || 4), style: 'flex:1;min-width:0;resize:vertical;font-family:inherit',
        oninput: e => emit(e.target.value) }, String(val ?? ''))
    } else if (f.type === 'list') {
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
    const hasCustomOverride = f.type === 'entity'
      ? _targetsOfCustom(getEntity()?.custom).length > 0
      : (getEntity()?.custom?.[key] !== undefined && getEntity().custom[key] !== f.default)
    const resetBtn = hasCustomOverride
      ? h('button', { class: 'ds-input-bare', title: 'Reset to default', style: 'cursor:pointer;padding:0 4px;opacity:0.6', onclick: () => { const cb = getOnChange(); if (cb) cb('custom.targets', []) } }, 'x')
      : null
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
