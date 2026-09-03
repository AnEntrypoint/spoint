// TweakPanel.js -- a live RenderControls knob editor DOM panel, the spoint-client representative
// panel for the offscreencanvas-worker-hud-dom-proxy PRD row's own acceptance bar: "one representative
// panel (e.g. tweak-panel.js, since it already reads/writes several RenderControls knobs) as the
// live-verified proof". Modeled on packages/mapspinner/src/tweak-panel.js's live-overlay concept (a
// small collapsible slider/checkbox list writing window.__<key> globals) but built against
// HudControlProxy.js's get/set/subscribe contract instead of touching window.__<key> or
// RenderControls directly -- so the SAME panel code works whether its proxy is
// createLocalControlProxy() (main thread today) or createRemoteControlProxy(worker) (a future
// worker-hosted render loop), per this row's own "same call-site code, not a special-case worker
// path" requirement.
//
// Deliberately small: a handful of real, already-registered RenderControls knobs spanning every
// syncable type (boolean/number/string), NOT a port of mapspinner's ~90-row panel (that panel tunes
// a completely different SDK's window.__ namespace and is out of scope here, see this row's own
// witness notes). Enough to prove get/set/subscribe round-trips correctly for a real DOM control.

const PANEL_KNOBS = [
  { key: 'dprAuto', label: 'Auto DPR', type: 'boolean' },
  { key: 'fsr1', label: 'FSR1 upscale', type: 'boolean' },
  { key: 'fsr1Sharpness', label: 'FSR1 sharpness', type: 'number', min: 0, max: 1, step: 0.05 },
  { key: 'toneMappingMode', label: 'Tonemap', type: 'string', options: ['ACESFilmic', 'AgX', 'Neutral', 'Linear'] },
  { key: 'splitFactor', label: 'LOD density', type: 'number', min: 0.05, max: 1, step: 0.01 },
]

// Build the panel DOM against a given proxy ({get,set,subscribe}, from HudControlProxy.js).
// Returns {root, destroy()}. Does not append to document.body itself -- caller mounts it (keeps
// this testable/composable without a forced singleton DOM id, unlike the mapspinner demo panel).
export function createTweakPanel(proxy, opts = {}) {
  if (!proxy || typeof proxy.get !== 'function' || typeof proxy.set !== 'function' || typeof proxy.subscribe !== 'function') {
    throw new Error('createTweakPanel: proxy must expose get/set/subscribe (see HudControlProxy.js)')
  }
  const knobs = opts.knobs || PANEL_KNOBS
  const unsubscribers = []

  const root = document.createElement('div')
  root.className = 'tweak-panel'
  root.id = opts.id || 'spoint-tweak-panel'
  root.style.cssText = 'font:11px monospace;background:rgba(12,16,20,0.94);color:#cfe;' +
    'padding:6px 8px;border:1px solid #2a3a44;width:260px'

  const title = document.createElement('div')
  title.textContent = proxy.isRemote ? 'Tweaks (worker-hosted)' : 'Tweaks (main thread)'
  title.style.cssText = 'color:#9fd;font-weight:bold;margin-bottom:4px'
  root.appendChild(title)

  for (const knob of knobs) {
    const row = document.createElement('div')
    row.className = 'tweak-row'
    row.dataset.key = knob.key
    row.style.cssText = 'display:flex;align-items:center;gap:4px;margin:2px 0'

    const lab = document.createElement('span')
    lab.textContent = knob.label
    lab.style.cssText = 'flex:0 0 110px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis'
    row.appendChild(lab)

    let input
    const current = proxy.get(knob.key)

    if (knob.type === 'boolean') {
      input = document.createElement('input')
      input.type = 'checkbox'
      input.checked = !!current
      input.onchange = () => proxy.set(knob.key, input.checked)
    } else if (knob.type === 'string' && knob.options) {
      input = document.createElement('select')
      for (const opt of knob.options) {
        const o = document.createElement('option')
        o.value = opt; o.textContent = opt
        if (opt === current) o.selected = true
        input.appendChild(o)
      }
      input.onchange = () => proxy.set(knob.key, input.value)
    } else { // number
      input = document.createElement('input')
      input.type = 'range'
      input.min = knob.min ?? 0
      input.max = knob.max ?? 1
      input.step = knob.step ?? 0.01
      input.value = current != null ? current : (knob.min ?? 0)
      input.oninput = () => proxy.set(knob.key, +input.value)
    }
    input.className = 'tweak-input'
    row.appendChild(input)
    root.appendChild(row)

    // Keep the control in sync with externally-originated changes (another panel, a server push, or
    // -- on the remote backend -- the round-trip echo of this panel's own set() call) via the proxy's
    // subscribe(), never a direct window.__<key> read: this is the entire point of routing through
    // the proxy instead of reading RenderControls/window globals inline in this file.
    const unsub = proxy.subscribe(knob.key, (v) => {
      if (knob.type === 'boolean') { if (input.checked !== !!v) input.checked = !!v }
      else if (input.value !== String(v)) input.value = v
    })
    unsubscribers.push(unsub)
  }

  function destroy() {
    for (const fn of unsubscribers) fn()
    unsubscribers.length = 0
    if (root.parentNode) root.parentNode.removeChild(root)
  }

  return { root, destroy }
}
