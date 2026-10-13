import { ensureStyle } from './ensureStyle.js'

// Pure renderers for the governor readout, kept out of createRenderDebugPanel so the "why did the
// picture change" text is witnessable in Node without a DOM.
export function leafPhrase(leafOffM) {
  return Number.isFinite(leafOffM) && leafOffM > 0
    ? `leaves off beyond ${leafOffM}m (near and mid trees keep theirs)`
    : 'leaves everywhere'
}

export function governorStatusLine(state) {
  if (!state) return 'governor: off (window.__qualityGovernorState is absent)'
  const avg = Number.isFinite(state.avgMs) ? `${state.avgMs.toFixed(1)}ms` : '-'
  const budget = Number.isFinite(state.budgetMs) ? `${state.budgetMs}ms` : '-'
  const ml = state.knobs && Number.isFinite(state.knobs.maxLevel) ? ` maxLevel ${state.knobs.maxLevel}` : ''
  const flags = [state.atFloor ? 'at floor' : null, state.inBand ? 'in band' : null].filter(Boolean).join(', ')
  return `tier ${state.tier}/${state.maxTier} · avg ${avg} of ${budget} · ${leafPhrase(state.leafOffM)}${ml}${flags ? ' · ' + flags : ''}`
}

export function governorCauseLine(state) {
  if (!state) return 'no governor state: nothing is shedding quality'
  if (state.tier === 0) return `no shed (step ${state.steps}): the booted snapshot is in force, ${leafPhrase(state.leafOffM)}`
  const why = state.shedCause === 'hitch' && Number.isFinite(state.overrunMs) && state.overrunMs > 0
    ? `a ${state.overrunMs.toFixed(1)}ms frame tripped the ${state.hitchAboveMs}ms hitch latch`
    : state.shedCause === 'excursion'
      ? `${Number.isFinite(state.shedExcursions) ? state.shedExcursions : state.excursionTripCount} of the last ${state.excursionWindowFrames} frame(s) ran over the ${state.excursionAboveMs}ms budget`
      : `the 30-frame window read avg ${state.avgMs}ms / p95 ${state.winP95Ms}ms over a ${state.budgetMs}ms budget`
  return `shed ${state.steps} step(s) because ${why}; ${leafPhrase(state.leafOffM)}`
}

const CSS = `
    .rdp-card{position:fixed;top:max(8px,env(safe-area-inset-top));right:max(8px,env(safe-area-inset-right));z-index:1000;width:min(280px,calc(100vw - 16px));pointer-events:all;display:flex;flex-direction:column;gap:4px;padding:10px;background:rgba(10,12,18,0.92);border:1px solid rgba(255,255,255,0.15);border-radius:8px;font:12px/1.5 ui-monospace,monospace;color:#e6e6e6}
    .rdp-card .rdp-h{font-size:13px;font-weight:600;margin-bottom:4px}
    .rdp-card label{display:flex;align-items:center;gap:6px;cursor:pointer;padding:2px 0}
    .rdp-card input{cursor:pointer}
`

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
      get: () => !renderControls?.get('grassDecalsOff'),
      set: (on) => renderControls?.set('grassDecalsOff', !on),
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
    {
      label: 'Quality governor (sheds quality to hold the frame budget)',
      get: () => !(typeof window !== 'undefined' && window.__qualityGovernorOff),
      set: (on) => {
        if (typeof window === 'undefined') return
        window.__qualityGovernorOff = !on
        const rc = window.__renderControls
        if (rc && typeof rc.set === 'function') rc.set('qualityGovernorOff', !on)
      },
    },
  ]
}

export function createRenderDebugPanel(uiRoot, renderControls) {
  ensureStyle('render-debug-panel-style', CSS)
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

  // Why the picture changed. The governor's tier/knob state used to exist only as a window global,
  // so a tier 3 leaf strip was invisible as a cause -- the user saw degraded trees and no reason.
  const govHead = document.createElement('div')
  govHead.className = 'rdp-h'
  govHead.style.cssText = 'margin-top:8px'
  govHead.textContent = 'Quality governor'
  card.appendChild(govHead)
  const govOut = document.createElement('div')
  govOut.style.cssText = 'color:#9fd;white-space:pre-wrap;font-size:11px;margin-bottom:6px'
  card.appendChild(govOut)
  const paintGovernor = () => {
    const st = (typeof window !== 'undefined') ? window.__qualityGovernorState : null
    govOut.textContent = `${governorStatusLine(st)}${String.fromCharCode(10)}${governorCauseLine(st)}`
  }
  paintGovernor()
  const govTimer = setInterval(paintGovernor, 250)

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
    destroy() { clearInterval(govTimer); card.remove() },
  }
}
