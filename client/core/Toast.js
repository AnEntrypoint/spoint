import { components as C, h, applyDiff } from 'anentrypoint-design'

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
