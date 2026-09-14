import { h, applyDiff } from 'anentrypoint-design'
import { Btn, Toolbar, EmptyState, promptChannel, getSharedWM } from './wm/ui.js'

function targetsOf(custom) {
  if (!custom) return []
  if (Array.isArray(custom.targets)) return custom.targets.filter(t => t != null).map(String)
  if (custom.target != null) return [String(custom.target)]
  return []
}
function buildGraph(entities) {
  const nodes = entities
    .filter(e => e && e.id)
    .map((e, i) => ({ id: e.id, label: e.id,
      kind: e._appName || e.appName || (e.model ? 'model' : e.custom ? 'primitive' : 'entity'),
      targets: targetsOf(e.custom),
      channel: e.custom?.channel || null,
      x: (i % 3) * 340 + 24, y: Math.floor(i / 3) * 180 + 24 }))
  const ids = new Set(nodes.map(n => n.id))
  const edges = []
  for (const n of nodes) for (const to of n.targets) if (ids.has(to)) edges.push({ from: n.id, to, channel: n.channel })
  return { nodes, edges }
}

function nodeCard(n, sel, wiring, dropTarget) {
  const stroke = dropTarget ? 'var(--accent)' : (sel ? 'var(--accent)' : 'var(--rule)')
  const dash = dropTarget ? ' stroke-dasharray="5 3"' : ''
  const anchorFill = wiring ? 'var(--accent)' : 'var(--panel-text-3)'
  return '<g class="hf-node" data-id="' + n.id + '" transform="translate(' + n.x + ',' + n.y + ')" style="cursor:pointer">'
    + '<rect width="300" height="96" rx="14" fill="var(--panel-1)" stroke="' + stroke + '" stroke-width="' + (dropTarget ? 3 : (sel ? 2 : 1)) + '"' + dash + '/>'
    + '<rect width="300" height="36" rx="14" fill="var(--panel-1)" opacity="0.6"/>'
    + '<rect y="26" width="300" height="10" fill="var(--panel-1)" opacity="0.6"/>'
    + '<text x="14" y="23" font-family="var(--ff-mono, monospace)" font-size="11" fill="var(--panel-text)" font-weight="600">' + n.label + '</text>'
    + '<text x="286" y="23" font-family="var(--ff-mono, monospace)" font-size="8" fill="var(--panel-text-3)" font-weight="700" text-anchor="end" letter-spacing="1">' + (n.kind||'').toUpperCase().slice(0,14) + '</text>'
    + '<text x="14" y="58" font-family="var(--ff-mono, monospace)" font-size="9" fill="var(--accent)">- setup</text>'
    + '<text x="80" y="58" font-family="var(--ff-mono, monospace)" font-size="9" fill="var(--panel-text-2)">- update</text>'
    + '<text x="158" y="58" font-family="var(--ff-mono, monospace)" font-size="9" fill="var(--panel-text-2)">- onInteract</text>'
    + '<text x="14" y="78" font-family="var(--ff-mono, monospace)" font-size="9" fill="var(--panel-text-3)">- onEditorUpdate</text>'
    + '<circle class="hf-wire-handle" data-id="' + n.id + '" cx="300" cy="48" r="7" fill="' + anchorFill + '" stroke="var(--panel-1)" stroke-width="2" style="cursor:crosshair"/>'
    + '</g>'
}

function edgePath(e, nodesById, pulse) {
  const a = nodesById.get(e.from), b = nodesById.get(e.to)
  if (!a || !b) return ''
  const aRight = a.x + 300, bRight = b.x + 300
  const leftToRight = b.x >= a.x
  const x1 = leftToRight ? aRight : a.x, y1 = a.y + 48
  const x2 = leftToRight ? b.x : bRight, y2 = b.y + 48
  const mx = (x1 + x2) / 2
  const d = 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2
  const stroke = pulse ? 'var(--accent)' : 'var(--panel-text-3)'
  const width = pulse ? 3 : 1.5
  const dash = pulse ? '' : ' stroke-dasharray="4 4"'
  const markerId = pulse ? 'hf-arrow-live' : 'hf-arrow'
  const label = e.channel
    ? '<text x="' + mx + '" y="' + ((y1 + y2) / 2 - 6) + '" text-anchor="middle" font-family="var(--ff-mono, monospace)" font-size="9" fill="' + stroke + '">' + e.channel + '</text>'
    : ''
  const dot = pulse
    ? '<circle r="4" fill="var(--accent)"><animateMotion dur="0.6s" repeatCount="1" path="' + d + '"/></circle>'
    : ''
  return '<g class="hf-edge" data-edge="' + e.from + '->' + e.to + '" style="cursor:pointer">'
    + '<title>Click to remove this wire</title>'
    + '<path d="' + d + '" fill="none" stroke="transparent" stroke-width="16"/>'
    + '<path d="' + d + '" fill="none" stroke="' + stroke + '" stroke-width="' + width + '"' + dash + ' marker-end="url(#' + markerId + ')" style="pointer-events:none"/>'
    + label + dot + '</g>'
}

const EDGE_DEFS = '<defs>'
  + '<marker id="hf-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--panel-text-3)"/></marker>'
  + '<marker id="hf-arrow-live" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--accent)"/></marker>'
  + '</defs>'

const PULSE_MS = 600

export function createHookFlowViewer(container) {
  let _ents = [], _sel = null, _tx = 0, _ty = 0, _sc = 1, _drag = false, _dx = 0, _dy = 0, _onClick = null
  let _lastFire = new Map(), _pulseTimer = null
  let _wireFrom = null, _wireCursor = null, _wireOverId = null, _onWireCreate = null, _onEdgeRemove = null
  let _appsByName = new Map()

  container.classList.add('ds-ep-panel')

  function _toGraphPoint(clientX, clientY) {
    const svg = container.querySelector('.ds-hf-svg')
    const rect = svg ? svg.getBoundingClientRect() : { left: 0, top: 0 }
    return { x: (clientX - rect.left - _tx) / _sc, y: (clientY - rect.top - _ty) / _sc }
  }

  const _onWindowMouseUp = (e) => {
    if (_wireFrom != null) { _completeWireDrag(e); return }
    if (_drag) { _drag = false; render() }
  }
  window.addEventListener('mouseup', _onWindowMouseUp)

  function _completeWireDrag(e) {
    const from = _wireFrom
    const targetCard = e?.target?.closest?.('.hf-node')
    const to = targetCard ? targetCard.dataset.id : null
    _wireFrom = null; _wireCursor = null; _wireOverId = null
    render()
    if (!to || to === from) return
    const sourceEntity = (_ents || []).find(en => en && en.id === from)
    const existing = targetsOf(sourceEntity?.custom)
    if (existing.includes(to)) return
    const wm = getSharedWM()
    if (!wm) { _onWireCreate?.(from, to, null); return }
    const targetEntity = (_ents || []).find(en => en && en.id === to)
    const targetKind = targetEntity ? (targetEntity._appName || targetEntity.appName || '') : ''
    const appInfo = targetKind ? _appsByName.get(targetKind) : null
    const channels = appInfo?.channels || []
    const initial = sourceEntity?.custom?.channel || ''
    promptChannel(wm, { title: 'Wire ' + from + ' -> ' + to, targetAppKind: targetKind, channels, initial })
      .then(channel => { if (channel) _onWireCreate?.(from, to, channel) })
  }

  function render() {
    const { nodes, edges } = buildGraph(_ents)
    const nodesById = new Map(nodes.map(n => [n.id, n]))
    const now = Date.now()
    const edgesSvg = edges.map(e => {
      const fired = _lastFire.get(e.from + '|' + (e.channel || ''))
      const pulse = fired != null && (now - fired) < PULSE_MS
      return edgePath(e, nodesById, pulse)
    }).join('')
    let rubberBandSvg = ''
    if (_wireFrom != null && _wireCursor) {
      const src = nodesById.get(_wireFrom)
      if (src) {
        const x1 = src.x + 300, y1 = src.y + 48
        const x2 = _wireCursor.x, y2 = _wireCursor.y
        const mx = (x1 + x2) / 2
        rubberBandSvg = '<path d="M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2
          + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="6 4" pointer-events="none"/>'
      }
    }
    const inner = nodes.length === 0
      ? ''
      : EDGE_DEFS + edgesSvg + nodes.map(n => nodeCard(n, n.id === _sel, n.id === _wireFrom, n.id === _wireOverId && n.id !== _wireFrom)).join('') + rubberBandSvg

    const toolbarChildren = [
      Btn({ ghost: true, dense: true, onClick: (e) => { e.preventDefault(); _tx = 0; _ty = 0; _sc = 1; render() }, children: ['Reset view'] }),
      h('div', { class: 'ds-ed-bar-grow' }),
      h('span', { class: 'ds-ed-files-loading' }, nodes.length + ' app entities' + (edges.length ? ', ' + edges.length + ' wire' + (edges.length === 1 ? '' : 's') : ''))
    ]
    const toolbar = Toolbar({ children: toolbarChildren })

    const emptyOverlay = nodes.length === 0
      ? h('div', { style: 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;pointer-events:none' },
          EmptyState({ text: 'No app entities -- create one from the Apps tab' }))
      : null

    const stage = h('div', { class: 'ds-hf-stage', style: 'position:relative' },
      emptyOverlay,
      h('svg', { class: 'ds-hf-svg' + (_drag ? ' is-dragging' : '') + (_wireFrom != null ? ' is-wiring' : ''), xmlns: 'http://www.w3.org/2000/svg',
        onmousedown: e => {
          const handle = e.target.closest?.('.hf-wire-handle')
          if (handle) { e.preventDefault(); _wireFrom = handle.dataset.id; _wireCursor = _toGraphPoint(e.clientX, e.clientY); render(); return }
          if (e.target.closest?.('.hf-node')) return
          _drag=true; _dx=e.clientX-_tx; _dy=e.clientY-_ty; render()
        },
        onmousemove: e => {
          if (_wireFrom != null) {
            _wireCursor = _toGraphPoint(e.clientX, e.clientY)
            const overCard = e.target.closest?.('.hf-node')
            _wireOverId = overCard ? overCard.dataset.id : null
            render()
            return
          }
          if (!_drag) return
          _tx=e.clientX-_dx; _ty=e.clientY-_dy; render()
        },
        onmouseup: e => { if (_wireFrom != null) { _completeWireDrag(e); return } _drag=false; render() },
        onwheel: e => { e.preventDefault(); const f=e.deltaY>0?0.88:1.14; _sc=Math.min(4,Math.max(0.1,_sc*f)); render() },
        onclick: e => {
          const edge = e.target.closest?.('.hf-edge')
          if (edge) { const [from, to] = (edge.dataset.edge || '').split('->'); if (from && to) _onEdgeRemove?.(from, to); return }
          const n=e.target.closest?.('.hf-node'); if (n) { _sel=n.dataset.id; _onClick?.(_sel); render() }
        },
        dangerouslySetInnerHTML: { __html: '<g transform="translate('+_tx+','+_ty+') scale('+_sc+')">'+inner+'</g>' }
      })
    )

    let tableVNode = null
    if (nodes.length) {
      tableVNode = h('table', { style: 'width:100%;border-collapse:collapse;font:11px var(--ff-mono,monospace)' },
        h('thead', null, h('tr', null,
          h('th', { style: 'text-align:left;padding:4px 8px;color:var(--panel-text-3);font-weight:normal;border-bottom:1px solid var(--rule)' }, 'Entity'),
          h('th', { style: 'text-align:left;padding:4px 8px;color:var(--panel-text-3);font-weight:normal;border-bottom:1px solid var(--rule)' }, 'App')
        )),
        h('tbody', null, ...nodes.map(n =>
          h('tr', {
            key: n.id,
            style: 'cursor:pointer' + (n.id === _sel ? ';background:color-mix(in oklab, var(--accent) 15%, transparent)' : ''),
            onclick: () => { _sel = n.id; _onClick?.(_sel); render() }
          },
            h('td', { style: 'padding:4px 8px;border-bottom:1px solid var(--rule)' }, n.id),
            h('td', { style: 'padding:4px 8px;border-bottom:1px solid var(--rule);color:var(--panel-text-2)' }, n.kind || '')
          )
        ))
      )
    }

    applyDiff(container, [
      toolbar,
      h('div', { class: 'ds-ep-panel-body flush', style: 'display:flex;flex-direction:column' }, [stage, tableVNode].filter(Boolean))
    ])
  }

  function _schedulePulseClear() {
    if (_pulseTimer) return
    _pulseTimer = setTimeout(() => { _pulseTimer = null; render() }, PULSE_MS + 50)
  }

  render()
  return {
    updateGraph(ents) { _ents = ents || []; render() },
    updateApps(apps) { _appsByName = new Map((apps || []).filter(a => a && a.name).map(a => [a.name, a])) },
    onNodeClick(cb) { _onClick = cb },
    onWireCreate(cb) { _onWireCreate = cb },
    onEdgeRemove(cb) { _onEdgeRemove = cb },
    updateEvents(events) {
      if (!Array.isArray(events) || events.length === 0) return
      let changed = false
      for (const ev of events) {
        if (ev?.type !== 'bus_event') continue
        const src = ev.meta?.sourceEntity, ch = ev.data?.channel
        if (src == null) continue
        _lastFire.set(String(src) + '|' + (ch || ''), ev.timestamp || Date.now())
        changed = true
      }
      if (changed) { render(); _schedulePulseClear() }
    },
    destroy() { window.removeEventListener('mouseup', _onWindowMouseUp); if (_pulseTimer) { clearTimeout(_pulseTimer); _pulseTimer = null } }
  }
}
