import { createElement as h } from 'webjsx'
import { showToast } from '../EditPanelDOM.js'

let _sharedWM = null
export function setSharedWM(wm) { _sharedWM = wm }
export function getSharedWM() { return _sharedWM }

let _cssInjected = false
export function ensureUiCSS() {
  if (_cssInjected) return
  _cssInjected = true
  const style = document.createElement('style')
  style.id = 'ds-wm-ui'
  style.textContent = [
    '.ds-ep-wm-btn{background:var(--panel-3,var(--bg-3));color:var(--panel-text-2,var(--fg-2));border:none;border-radius:var(--r-1,4px);padding:6px 12px;font:12px var(--ff-mono,monospace);cursor:pointer}',
    '.ds-ep-wm-btn:hover{background:var(--panel-hover,var(--bg-2));color:var(--panel-text,var(--fg))}',
    '.ds-ep-wm-btn-primary{background:var(--accent);color:var(--accent-fg,var(--bg))}',
    '.ds-ep-wm-btn-primary:hover{background:var(--accent-bright,var(--accent))}',
    '.ds-ep-wm-btn-danger{background:var(--warn,#c33);color:var(--on-color,#fff)}',
    '.ds-ep-wm-btn-danger:hover{filter:brightness(1.15)}',
    '.ds-ep-wm-btn.ghost{background:transparent}',
    '.ds-ep-wm-btn.dense{padding:3px 8px;font-size:11px}',
    '.ds-ui-input{width:100%;box-sizing:border-box;background:var(--panel-1,var(--bg-2));color:var(--panel-text,var(--fg));border:1px solid var(--rule);border-radius:var(--r-1,4px);padding:6px 8px;font:12px var(--ff-mono,monospace)}',
    '.ds-ui-input::placeholder{color:var(--panel-text-3,var(--fg-3))}',
    '.ds-ui-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 6px}',
    '.ds-ui-empty{display:flex;align-items:center;justify-content:center;text-align:center;color:var(--panel-text-3,var(--fg-3));font:12px var(--ff-mono,monospace);padding:16px;flex:1}'
  ].join('\n')
  document.head.appendChild(style)
}

export function Btn({ ghost, dense, primary, danger, title, onClick, key, children = [] } = {}) {
  ensureUiCSS()
  const cls = 'ds-ep-wm-btn' + (primary ? ' ds-ep-wm-btn-primary' : '') + (danger ? ' ds-ep-wm-btn-danger' : '') + (ghost ? ' ghost' : '') + (dense ? ' dense' : '')
  const label = title || children.filter(c => typeof c === 'string').join(' ') || undefined
  // key (procedural-content-editor-toolbar-browser-witness): forwarded straight to webjsx's own h()
  // props object exactly like every raw h(...) call already does (see WaypointTimeline.js's row Btns) --
  // without it, a list of sibling Btn()s with no stable identity (e.g. ProcgenPanel.js's generator
  // picker) makes applyDiff's keyed-reconciliation path read `undefined.key` on a re-render and throw,
  // since Btn() never had a way to pass one through to the underlying button vnode.
  return h('button', { type: 'button', key, class: cls, title: title || undefined, 'aria-label': label, onclick: onClick }, ...children)
}

export function Toolbar({ leading = [], children = [], trailing = [] } = {}) {
  ensureUiCSS()
  const kids = [].concat(leading || [], children || [], trailing || [])
  return h('div', { class: 'ds-ui-toolbar', role: 'toolbar' }, ...kids)
}

export function SearchInput({ value = '', placeholder = '', onInput } = {}) {
  ensureUiCSS()
  return h('input', {
    type: 'search', class: 'ds-ui-input', placeholder, value,
    oninput: (e) => onInput?.(e.target.value)
  })
}

export function EmptyState({ text = '' } = {}) {
  ensureUiCSS()
  return h('div', { class: 'ds-ui-empty' }, text)
}

// validate(raw) returns {ok:true, value} or {ok:false, error}; omit for trimmed pass-through.
export function promptText(wm, { title, label, placeholder, initial = '', confirmLabel = 'Save', validate } = {}) {
  ensureUiCSS()
  return new Promise(resolve => {
    let resolved = false
    const winId = 'prompt-' + Math.random().toString(36).slice(2, 8)
    const close = (v) => {
      if (resolved) return
      resolved = true
      wm.close(winId)
      resolve(v)
    }
    const body = document.createElement('div')
    body.style.cssText = 'display:flex;flex-direction:column;gap:10px;padding:12px'
    const input = document.createElement('input')
    input.type = 'text'
    input.value = initial
    input.placeholder = placeholder || 'name'
    input.className = 'ds-ui-input'
    const submit = () => {
      let v = (input.value || '').trim()
      if (validate) {
        const r = validate(v)
        if (!r || r.ok === false) { showToast((r && r.error) || ((label || 'Value') + ' invalid'), 'error'); return }
        v = r.value
      }
      if (v == null || v === '') { showToast((label || 'Value') + ' required', 'error'); return }
      close(v)
    }
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit() } else if (e.key === 'Escape') { e.preventDefault(); close(null) } })
    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px'
    const cancelBtn = document.createElement('button')
    cancelBtn.textContent = 'Cancel'
    cancelBtn.className = 'ds-ep-wm-btn'
    cancelBtn.addEventListener('click', () => close(null))
    const okBtn = document.createElement('button')
    okBtn.textContent = confirmLabel
    okBtn.className = 'ds-ep-wm-btn ds-ep-wm-btn-primary'
    okBtn.addEventListener('click', submit)
    actions.append(cancelBtn, okBtn)
    body.append(input, actions)
    wm.open({ id: winId, title: title || 'Name', x: (window.innerWidth - 320) / 2, y: (window.innerHeight - 140) / 2, w: 320, h: 140, body, onClose: () => close(null) })
    setTimeout(() => input.focus(), 0)
  })
}

// Channel-picker dialog for HookFlow drag-to-wire (editor-node-graph-wire-channel-picker-multi-target):
// a maker who just drag-wired source->target has no discoverable list of which bus channel the target
// app actually listens on (custom.channel was previously free-text-only, guess-the-string). `channels`
// is the target app's statically-scraped ctx.bus.on(...)/once(...) literal-string channel names (server's
// LIST_APPS APP_LIST reply, EditorHandlers.js scrapeChannels) -- a <datalist> gives autocomplete over the
// REAL known channels while staying a plain text input, so an app with zero scraped channels (a template-
// literal/variable channel arg, or the non-Node/Worker singleplayer runtime which ships channels:[]) still
// lets the maker type any channel string by hand, same escape hatch promptText already gives every other
// free-text field in this file. Returns the trimmed channel string, or null on cancel (Escape/close/blank).
export function promptChannel(wm, { title = 'Wire channel', targetAppKind = '', channels = [], initial = '' } = {}) {
  ensureUiCSS()
  return new Promise(resolve => {
    let resolved = false
    const winId = 'wire-channel-' + Math.random().toString(36).slice(2, 8)
    const close = (v) => {
      if (resolved) return
      resolved = true
      wm.close(winId)
      resolve(v)
    }
    const body = document.createElement('div')
    body.style.cssText = 'display:flex;flex-direction:column;gap:10px;padding:12px'
    if (targetAppKind) {
      const hint = document.createElement('div')
      hint.style.cssText = 'font:11px var(--ff-mono,monospace);color:var(--panel-text-3,var(--fg-3))'
      hint.textContent = channels.length
        ? targetAppKind + ' listens on:'
        : targetAppKind + ' declares no static bus.on(...) channels -- type one by hand'
      body.append(hint)
    }
    const listId = winId + '-list'
    const input = document.createElement('input')
    input.type = 'text'
    input.value = initial || channels[0] || ''
    input.placeholder = 'e.g. trigger.enter'
    input.className = 'ds-ui-input'
    input.setAttribute('list', listId)
    const datalist = document.createElement('datalist')
    datalist.id = listId
    for (const ch of channels) { const opt = document.createElement('option'); opt.value = ch; datalist.append(opt) }
    const submit = () => {
      const v = (input.value || '').trim()
      if (!v) { showToast('Channel required', 'error'); return }
      close(v)
    }
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit() } else if (e.key === 'Escape') { e.preventDefault(); close(null) } })
    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px'
    const cancelBtn = document.createElement('button')
    cancelBtn.textContent = 'Cancel'
    cancelBtn.className = 'ds-ep-wm-btn'
    cancelBtn.addEventListener('click', () => close(null))
    const okBtn = document.createElement('button')
    okBtn.textContent = 'Wire'
    okBtn.className = 'ds-ep-wm-btn ds-ep-wm-btn-primary'
    okBtn.addEventListener('click', submit)
    actions.append(cancelBtn, okBtn)
    body.append(input, datalist, actions)
    wm.open({ id: winId, title, x: (window.innerWidth - 320) / 2, y: (window.innerHeight - 160) / 2, w: 320, h: 160, body, onClose: () => close(null) })
    setTimeout(() => input.focus(), 0)
  })
}

export function confirmWindow(wm, { title = 'confirm', message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', destructive = false } = {}) {
  ensureUiCSS()
  return new Promise(resolve => {
    let resolved = false
    const winId = 'confirm-' + Math.random().toString(36).slice(2, 8)
    const close = (v) => {
      if (resolved) return
      resolved = true
      wm.close(winId)
      resolve(v)
    }
    const body = document.createElement('div')
    body.style.cssText = 'display:flex;flex-direction:column;gap:12px;padding:12px'
    const msg = document.createElement('div')
    msg.style.cssText = 'font:12px var(--ff-mono,monospace);color:var(--panel-text,var(--fg));line-height:1.5'
    msg.textContent = message
    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px'
    const cancelBtn = document.createElement('button')
    cancelBtn.textContent = cancelLabel
    cancelBtn.className = 'ds-ep-wm-btn'
    cancelBtn.addEventListener('click', () => close(false))
    const okBtn = document.createElement('button')
    okBtn.textContent = confirmLabel
    okBtn.className = 'ds-ep-wm-btn ' + (destructive ? 'ds-ep-wm-btn-danger' : 'ds-ep-wm-btn-primary')
    okBtn.addEventListener('click', () => close(true))
    actions.append(cancelBtn, okBtn)
    body.append(msg, actions)
    wm.open({ id: winId, title, x: (window.innerWidth - 340) / 2, y: (window.innerHeight - 150) / 2, w: 340, h: 150, body, onClose: () => close(false) })
    setTimeout(() => okBtn.focus(), 0)
  })
}
