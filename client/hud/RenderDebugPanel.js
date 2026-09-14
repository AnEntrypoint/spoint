function ensureStyle() {
  if (document.getElementById('render-debug-panel-style')) return
  const s = document.createElement('style')
  s.id = 'render-debug-panel-style'
  s.textContent = `
    .rdp-card{position:fixed;top:max(8px,env(safe-area-inset-top));right:max(8px,env(safe-area-inset-right));z-index:1000;width:min(280px,calc(100vw - 16px));pointer-events:all;display:flex;flex-direction:column;gap:4px;padding:10px;background:rgba(10,12,18,0.92);border:1px solid rgba(255,255,255,0.15);border-radius:8px;font:12px/1.5 ui-monospace,monospace;color:#e6e6e6}
    .rdp-card .rdp-h{font-size:13px;font-weight:600;margin-bottom:4px}
    .rdp-card label{display:flex;align-items:center;gap:6px;cursor:pointer;padding:2px 0}
    .rdp-card input{cursor:pointer}
  `
  document.head.appendChild(s)
}

function _toggles(renderControls) {
  return [
    {
      label: 'Sun shadow (hostShadowOff)',
      get: () => !(typeof window !== 'undefined' && window.__hostShadowOff),
      set: (on) => { window.__hostShadowOff = !on },
    },
    {
      label: 'SSAO',
      get: () => !!renderControls?.get('ssao'),
      set: (on) => renderControls?.set('ssao', on),
    },
    {
      label: 'Decal system (bullet holes/tracers)',
      get: () => !(typeof window !== 'undefined' && window.__decalsOff),
      set: (on) => {
        window.__decalsOff = !on
        const ds = window.__app?.decals
        if (ds && ds._pool) { for (const d of ds._pool) if (d.mesh) d.mesh.visible = on && d.mesh.visible }
      },
    },
    {
      label: 'Grass decals (scorch/trample overlay)',
      get: () => !(typeof window !== 'undefined' && window.__grassDecalsOff),
      set: (on) => { window.__grassDecalsOff = !on },
    },
    {
      label: 'Shadow cascades: force to 1',
      get: () => (window.__shadowPipeline?.cascadeCount ?? 1) <= 1,
      set: (on) => {
        if (!on) return
        const sp = window.__shadowPipeline
        if (sp && sp.lights) for (let i = 1; i < sp.lights.length; i++) sp.lights[i].castShadow = false
      },
    },
    {
      label: 'Player VAT crowd render',
      get: () => !(typeof window !== 'undefined' && window.__playerVatOff),
      set: (on) => { window.__playerVatOff = !on },
    },
  ]
}

export function createRenderDebugPanel(uiRoot, renderControls) {
  ensureStyle()
  const card = document.createElement('div')
  card.className = 'rdp-card'
  uiRoot.appendChild(card)

  const toggles = _toggles(renderControls)
  const title = document.createElement('div')
  title.className = 'rdp-h'
  title.textContent = 'Render Debug Toggles'
  card.appendChild(title)

  const hint = document.createElement('div')
  hint.style.cssText = 'color:#999;font-size:11px;margin-bottom:6px'
  hint.textContent = 'Uncheck one at a time to find what causes the ground-mark artifact.'
  card.appendChild(hint)

  for (const t of toggles) {
    const label = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = t.get()
    input.addEventListener('change', () => t.set(input.checked))
    label.appendChild(input)
    label.appendChild(document.createTextNode(t.label))
    card.appendChild(label)
  }

  return {
    node: card,
    destroy() { card.remove() },
  }
}
