// PerfOverlay.js — per-app tick cost / per-entity draw contribution profiling overlay.
// Reads from the live frame graph timing (window.__renderGraph.stats()) and TickHandler's
// per-phase timers (window.__tickProfile) to show a compact overlay that can be toggled
// via the command palette or the debug modes dropdown.
//
// Renders as a small DOM overlay in the top-right of the viewport (below the editor toolbar).
// Clicking an entity row selects it in the editor.
//
// Integration:
//   - client/app.js: PerfOverlay.install({ onSelectEntity })

let _root = null, _visible = false, _interval = null, _onSelectEntity = null
const UPDATE_INTERVAL_MS = 500

function _createRoot() {
  if (_root && _root.isConnected) return _root
  _root = document.createElement('div')
  _root.className = 'ds-ep-perf-overlay'
  _root.style.cssText = 'position:fixed;top:36px;right:8px;z-index:9100;background:rgba(0,0,0,0.85);color:#eee;font:11px var(--ff-mono,monospace);padding:8px;border-radius:6px;min-width:240px;max-height:60vh;overflow-y:auto;pointer-events:all;border:1px solid rgba(255,255,255,0.1)'
  document.body.appendChild(_root)
  return _root
}

function _readFrameStats() {
  const stats = { fps: 0, tickMs: 0, tickPhases: {}, drawMs: 0, drawNodes: [] }

  // Read from window.__renderGraph (RenderGraph stats)
  try {
    const rg = window.__renderGraph
    if (rg && rg.stats) {
      const s = rg.stats()
      if (s) {
        stats.drawMs = s.totalMs || 0
        stats.drawNodes = (s.nodes || []).map(n => ({
          id: n.id || n.name,
          ms: n.ms || n.elapsed || 0,
          calls: n.calls || 1
        }))
      }
    }
  } catch (_) {}

  // Read from window.__tickProfile (TickHandler phase timers)
  try {
    const tp = window.__tickProfile
    if (tp) {
      stats.tickMs = tp.total || 0
      if (tp.phases) {
        for (const [k, v] of Object.entries(tp.phases)) {
          stats.tickPhases[k] = typeof v === 'number' ? v : (v.ms || 0)
        }
      }
    }
  } catch (_) {}

  // Read fps from window.__fps or the editor's setFps
  try {
    const fps = window.__fps || window.__app?.fps || 0
    stats.fps = fps | 0
  } catch (_) {}

  return stats
}

function _readAppTimings() {
  // Read per-app tick costs from window.__appProfile if available
  try {
    const ap = window.__appProfile
    if (ap && ap.apps) return ap.apps
  } catch (_) {}
  return []
}

function _render() {
  if (!_visible || !_root) return
  const stats = _readFrameStats()
  const appTimings = _readAppTimings()

  let html = '<div style="font-weight:700;margin-bottom:4px;display:flex;gap:12px">'
  html += `<span>${stats.fps} fps</span>`
  html += `<span>tick ${stats.tickMs.toFixed(2)}ms</span>`
  html += `<span>draw ${stats.drawMs.toFixed(2)}ms</span>`
  html += '</div>'

  // Tick phases
  if (Object.keys(stats.tickPhases).length) {
    html += '<div style="margin-bottom:4px;color:rgba(255,255,255,0.6)">Tick phases:</div>'
    const phases = Object.entries(stats.tickPhases).sort((a, b) => b[1] - a[1])
    for (const [name, ms] of phases) {
      if (ms < 0.01) continue
      html += `<div style="display:flex;justify-content:space-between;padding:1px 4px"><span>${name}</span><span>${ms.toFixed(2)}ms</span></div>`
    }
  }

  // Draw nodes (top 10 by time)
  if (stats.drawNodes.length) {
    html += '<div style="margin:4px 0;color:rgba(255,255,255,0.6)">Render nodes:</div>'
    const sorted = stats.drawNodes.sort((a, b) => b.ms - a.ms).slice(0, 10)
    for (const n of sorted) {
      if (n.ms < 0.01) continue
      html += `<div style="display:flex;justify-content:space-between;padding:1px 4px"><span>${n.id}</span><span>${n.ms.toFixed(2)}ms</span></div>`
    }
  }

  // App timings
  if (appTimings.length) {
    html += '<div style="margin:4px 0;color:rgba(255,255,255,0.6)">App tick costs:</div>'
    const sorted = appTimings.sort((a, b) => (b.ms || 0) - (a.ms || 0)).slice(0, 10)
    for (const a of sorted) {
      html += `<div style="display:flex;justify-content:space-between;padding:1px 4px;cursor:pointer" data-entity-id="${a.id || ''}"><span>${a.name || a.id || '?'}</span><span>${(a.ms || 0).toFixed(2)}ms</span></div>`
    }
  }

  _root.innerHTML = html

  // Wire click-to-select on entity rows
  _root.querySelectorAll('[data-entity-id]').forEach(el => {
    const eid = el.getAttribute('data-entity-id')
    if (eid && _onSelectEntity) {
      el.addEventListener('click', () => _onSelectEntity(eid))
      el.style.cssText = el.style.cssText + ';cursor:pointer'
      el.addEventListener('mouseenter', () => { el.style.background = 'rgba(100,120,255,0.2)' })
      el.addEventListener('mouseleave', () => { el.style.background = '' })
    }
  })
}

export const PerfOverlay = {
  get visible() { return _visible },

  show() {
    _visible = true
    _createRoot()
    _root.style.display = 'block'
    _render()
    if (!_interval) _interval = setInterval(_render, UPDATE_INTERVAL_MS)
  },

  hide() {
    _visible = false
    if (_root) _root.style.display = 'none'
    if (_interval) { clearInterval(_interval); _interval = null }
  },

  toggle() {
    if (_visible) this.hide(); else this.show()
  },

  install({ onSelectEntity }) {
    _onSelectEntity = onSelectEntity || null
    _createRoot()
    _root.style.display = 'none'
  },

  dispose() {
    this.hide()
    if (_root && _root.parentNode) _root.parentNode.removeChild(_root)
    _root = null
  }
}