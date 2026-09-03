import { h, applyDiff } from 'anentrypoint-design'
import { Btn, Toolbar, EmptyState } from './wm/ui.js'

// Parses window.__renderGraph.toMermaid() output back into {nodeIds, edges:[{from,to,key}]} --
// toMermaid() is RenderGraph.js's own edge/id source (see NODE CONTRACT comment there), so this
// stays correct by construction instead of re-deriving reads/writes independently.
function parseMermaid(text) {
  const nodeIds = [], edges = []
  for (const line of (text || '').split('\n')) {
    const nodeM = line.match(/^\s*(\S+)\["(\S+?)(?: \(disabled\))?"\]\s*$/)
    if (nodeM) { nodeIds.push(nodeM[1]); continue }
    const edgeM = line.match(/^\s*(\S+)\s+--\s+(.*?)\s+-->\s+(\S+)\s*$/)
    if (edgeM) edges.push({ from: edgeM[1], to: edgeM[3], key: edgeM[2] })
  }
  return { nodeIds, edges }
}

function layoutNodes(nodeIds, edges, disabledSet) {
  // Simple layered layout: layer = 1 + max(layer of any predecessor), independent of any single
  // real coordinate system -- enough to read dependency direction left-to-right at a glance.
  const layer = new Map(nodeIds.map(id => [id, 0]))
  const preds = new Map(nodeIds.map(id => [id, []]))
  for (const e of edges) if (preds.has(e.to)) preds.get(e.to).push(e.from)
  let changed = true, guard = 0
  while (changed && guard++ < nodeIds.length + 4) {
    changed = false
    for (const id of nodeIds) {
      const ps = preds.get(id) || []
      const want = ps.length ? Math.max(...ps.map(p => (layer.get(p) || 0) + 1)) : layer.get(id)
      if (want > layer.get(id)) { layer.set(id, want); changed = true }
    }
  }
  const perLayer = new Map()
  const nodes = nodeIds.map(id => {
    const l = layer.get(id) || 0
    const row = perLayer.get(l) || 0
    perLayer.set(l, row + 1)
    return { id, label: id, layer: l, row, disabled: disabledSet.has(id) }
  })
  const COL_W = 300, ROW_H = 150, PAD = 24
  for (const n of nodes) { n.x = PAD + n.layer * (260 + COL_W - 260); n.y = PAD + n.row * ROW_H }
  return nodes
}

function nodeCard(n, sel, stat, dead) {
  const stroke = dead ? 'var(--warn,#c33)' : (sel ? 'var(--accent)' : 'var(--rule)')
  const opacity = n.disabled || (stat && stat.skips > 0 && stat.runs === 0) ? '0.4' : '1'
  const ms = stat ? stat.ms.toFixed(2) : '0.00'
  const ema = stat ? stat.ema.toFixed(2) : '0.00'
  const calls = stat ? stat.calls : 0
  const tris = stat ? stat.tris : 0
  const runs = stat ? stat.runs : 0
  const skips = stat ? stat.skips : 0
  const errors = stat ? stat.errors : 0
  const statusWord = n.disabled ? 'DISABLED' : (errors > 0 ? 'ERROR' : (dead ? 'DEAD' : (skips > runs ? 'SKIPPING' : 'OK')))
  const statusColor = n.disabled ? 'var(--panel-text-3)' : (errors > 0 || dead ? 'var(--warn,#c33)' : (skips > runs ? 'var(--panel-text-3)' : 'var(--accent)'))
  return '<g class="rg-node" data-id="' + n.id + '" transform="translate(' + n.x + ',' + n.y + ')" style="cursor:pointer;opacity:' + opacity + '">'
    + '<rect width="260" height="128" rx="14" fill="var(--panel-1)" stroke="' + stroke + '" stroke-width="' + (sel || dead ? 2 : 1) + '"' + (dead ? ' stroke-dasharray="5,3"' : '') + '/>'
    + '<rect width="260" height="30" rx="14" fill="var(--panel-1)" opacity="0.6"/>'
    + '<rect y="22" width="260" height="8" fill="var(--panel-1)" opacity="0.6"/>'
    + '<text x="12" y="20" font-family="var(--ff-mono, monospace)" font-size="11" fill="var(--panel-text)" font-weight="600">' + n.label + '</text>'
    + '<text x="248" y="20" font-family="var(--ff-mono, monospace)" font-size="8" fill="' + statusColor + '" font-weight="700" text-anchor="end" letter-spacing="1">' + statusWord + '</text>'
    + '<text x="12" y="48" font-family="var(--ff-mono, monospace)" font-size="9" fill="var(--accent)">ms ' + ms + ' (ema ' + ema + ')</text>'
    + '<text x="12" y="64" font-family="var(--ff-mono, monospace)" font-size="9" fill="var(--panel-text-2)">calls +' + calls + '  tris +' + tris + '</text>'
    + '<text x="12" y="80" font-family="var(--ff-mono, monospace)" font-size="9" fill="var(--panel-text-3)">runs ' + runs + '  skips ' + skips + (errors ? '  errors ' + errors : '') + '</text>'
    + '<text x="12" y="98" font-family="var(--ff-mono, monospace)" font-size="9" fill="var(--panel-text-3)">' + (dead ? 'writes have no reader/target' : (n.disabled ? 'click to enable' : 'click to disable')) + '</text>'
    + '</g>'
}

function edgePath(a, b) {
  const x1 = a.x + 260, y1 = a.y + 64, x2 = b.x, y2 = b.y + 64
  const midX = (x1 + x2) / 2
  return 'M ' + x1 + ' ' + y1 + ' C ' + midX + ' ' + y1 + ', ' + midX + ' ' + y2 + ', ' + x2 + ' ' + y2
}

function edgeSvg(nodesById, e) {
  const a = nodesById.get(e.from), b = nodesById.get(e.to)
  if (!a || !b) return ''
  const midX = (a.x + 260 + b.x) / 2, midY = (a.y + b.y) / 2 + 64
  return '<path d="' + edgePath(a, b) + '" fill="none" stroke="var(--rule)" stroke-width="1.5" marker-end="url(#rg-arrow)"/>'
    + '<text x="' + midX + '" y="' + (midY - 4) + '" font-family="var(--ff-mono, monospace)" font-size="8" fill="var(--panel-text-3)" text-anchor="middle">' + e.key + '</text>'
}

function mapspinnerSubNodes(passes, baseX, baseY) {
  // Read-only descriptive sub-list -- mapspinner's internal passes are not independently
  // controllable RenderGraph nodes, so these never get click/disable wiring.
  return passes.map((p, i) => {
    const x = baseX, y = baseY + i * 74
    return '<g class="rg-sub-node" transform="translate(' + x + ',' + y + ')">'
      + '<rect width="320" height="64" rx="10" fill="var(--panel-1)" stroke="var(--rule)" stroke-width="1" stroke-dasharray="3,3" opacity="0.85"/>'
      + '<text x="10" y="16" font-family="var(--ff-mono, monospace)" font-size="10" fill="var(--panel-text-2)" font-weight="600">' + p.id + '</text>'
      + '<text x="310" y="16" font-family="var(--ff-mono, monospace)" font-size="7" fill="var(--panel-text-3)" text-anchor="end" letter-spacing="1">MAPSPINNER</text>'
      + '<text x="10" y="30" font-family="var(--ff-mono, monospace)" font-size="8" fill="var(--panel-text-3)">' + (p.purpose || '').slice(0, 58) + '</text>'
      + '<text x="10" y="44" font-family="var(--ff-mono, monospace)" font-size="7" fill="var(--panel-text-3)">reads: ' + (p.reads || []).join(', ').slice(0, 56) + '</text>'
      + '<text x="10" y="56" font-family="var(--ff-mono, monospace)" font-size="7" fill="var(--panel-text-3)">writes: ' + (p.writes || []).join(', ').slice(0, 55) + '</text>'
      + '</g>'
  }).join('')
}

export function createRenderGraphViewer(container) {
  let _sel = null, _tx = 0, _ty = 0, _sc = 1, _drag = false, _dx = 0, _dy = 0
  let _pollId = null
  let _lastNodes = [], _lastEdges = [], _lastStats = {}, _lastCulling = null, _lastPasses = null, _lastFrameId = 0
  let _lastDeadPasses = [], _lastAliasHazards = []

  container.classList.add('ds-ep-panel')

  const _onWindowMouseUp = () => { if (_drag) { _drag = false; render() } }
  window.addEventListener('mouseup', _onWindowMouseUp)

  function _poll() {
    const rg = typeof window !== 'undefined' ? window.__renderGraph : null
    if (!rg) { render(); return }
    const { nodeIds, edges } = parseMermaid(rg.toMermaid())
    const disabledSet = new Set(rg.disabledIds ? rg.disabledIds() : [])
    _lastNodes = layoutNodes(nodeIds, edges, disabledSet)
    _lastEdges = edges
    _lastStats = rg.stats ? rg.stats() : {}
    _lastFrameId = rg.frameId || 0
    _lastDeadPasses = rg.deadPasses ? rg.deadPasses() : []
    _lastAliasHazards = rg.aliasHazards ? rg.aliasHazards() : []
    _lastCulling = (typeof window.__culling !== 'undefined' && window.__culling && window.__culling.aggregate) ? window.__culling.aggregate() : null
    _lastPasses = (typeof globalThis.__mapspinnerPassManifest === 'function') ? globalThis.__mapspinnerPassManifest() : null
    render()
  }

  function _toggleNode(id) {
    const rg = window.__renderGraph
    if (!rg) return
    const disabledSet = new Set(rg.disabledIds ? rg.disabledIds() : [])
    if (disabledSet.has(id)) rg.enable(id)
    else rg.disable(id)
    _poll()
  }

  function render() {
    const nodesById = new Map(_lastNodes.map(n => [n.id, n]))
    const maxLayerX = _lastNodes.length ? Math.max(...(_lastNodes.map(n => n.x))) : 0
    const subBaseX = maxLayerX + 260 + 60
    const subBaseY = 24

    const deadSet = new Set(_lastDeadPasses)
    const nodeSvg = _lastNodes.map(n => nodeCard(n, n.id === _sel, _lastStats[n.id], deadSet.has(n.id))).join('')
    const edgeSvgStr = _lastEdges.map(e => edgeSvg(nodesById, e)).join('')
    const subSvg = _lastPasses ? mapspinnerSubNodes(_lastPasses, subBaseX, subBaseY) : ''
    const subHeaderSvg = _lastPasses
      ? '<text x="' + subBaseX + '" y="' + (subBaseY - 8) + '" font-family="var(--ff-mono, monospace)" font-size="9" fill="var(--panel-text-3)" letter-spacing="1">MAPSPINNER PASSES (read-only)</text>'
      : ''

    const profiling = typeof window !== 'undefined' && window.__renderGraph ? window.__renderGraph.profiling : false
    const rg = typeof window !== 'undefined' ? window.__renderGraph : null

    const toolbarChildren = [
      Btn({ ghost: true, dense: true, onClick: (e) => { e.preventDefault(); _tx = 0; _ty = 0; _sc = 1; render() }, children: ['Reset view'] }),
      Btn({
        ghost: true, dense: true,
        onClick: (e) => { e.preventDefault(); if (rg) { rg.setProfiling(!profiling); _poll() } },
        children: [profiling ? 'Profiling: ON' : 'Profiling: OFF']
      }),
      h('div', { class: 'ds-ed-bar-grow' }),
      h('span', { class: 'ds-ed-files-loading' }, rg ? (_lastNodes.length + ' nodes, frame ' + _lastFrameId) : 'window.__renderGraph not found')
    ]
    const toolbar = Toolbar({ children: toolbarChildren })

    const emptyOverlay = !rg
      ? h('div', { style: 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;pointer-events:none' },
          EmptyState({ text: 'window.__renderGraph is not present on this page' }))
      : null

    const defs = '<defs><marker id="rg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--rule)"/></marker></defs>'

    const stage = h('div', { class: 'ds-hf-stage', style: 'position:relative' },
      emptyOverlay,
      h('svg', { class: 'ds-hf-svg' + (_drag ? ' is-dragging' : ''), xmlns: 'http://www.w3.org/2000/svg',
        onmousedown: e => { if (e.target.closest?.('.rg-node')) return; _drag = true; _dx = e.clientX - _tx; _dy = e.clientY - _ty; render() },
        onmousemove: e => { if (!_drag) return; _tx = e.clientX - _dx; _ty = e.clientY - _dy; render() },
        onmouseup: () => { _drag = false; render() },
        onwheel: e => { e.preventDefault(); const f = e.deltaY > 0 ? 0.88 : 1.14; _sc = Math.min(4, Math.max(0.1, _sc * f)); render() },
        onclick: e => { const n = e.target.closest?.('.rg-node'); if (n) { _sel = n.dataset.id; _toggleNode(_sel) } },
        dangerouslySetInnerHTML: { __html: defs + '<g transform="translate(' + _tx + ',' + _ty + ') scale(' + _sc + ')">' + nodeSvg + edgeSvgStr + subHeaderSvg + subSvg + '</g>' }
      })
    )

    let cullingVNode = null
    if (_lastCulling) {
      const t = _lastCulling.totals || {}
      cullingVNode = h('div', { style: 'padding:6px 10px;border-top:1px solid var(--rule);font:10px var(--ff-mono,monospace);color:var(--panel-text-2);display:flex;gap:14px;flex-wrap:wrap' },
        h('span', null, 'culling: candidates ' + (t.candidates || 0)),
        h('span', null, 'occluded ' + (t.occluded || 0)),
        h('span', null, 'failOpens ' + (t.failOpens || 0)),
        h('span', null, 'anomalyTrips ' + (t.anomalyTrips || 0))
      )
    }

    // Resource-graph health strip: real construction-time diagnostics (dead-pass writes with zero
    // reader/target consumers; render-target write pairs sharing a physical target with no ordering
    // edge between them) surfaced directly from RenderGraph.js's resourceGraph()/deadPasses()/
    // aliasHazards() -- the "auto-cull dead passes, alias render targets" half of this row, made
    // visible in the SAME inspector rather than only a boot-time console.warn.
    let resourceHealthVNode = null
    if ((_lastDeadPasses && _lastDeadPasses.length) || (_lastAliasHazards && _lastAliasHazards.length)) {
      const healthChildren = []
      if (_lastDeadPasses && _lastDeadPasses.length) healthChildren.push(h('span', null, 'dead passes: ' + _lastDeadPasses.join(', ')))
      if (_lastAliasHazards && _lastAliasHazards.length) {
        healthChildren.push(h('span', null, 'alias hazards: ' + _lastAliasHazards.map(hz => hz.target + '(' + hz.a.key + '/' + hz.b.key + ')').join(', ')))
      }
      resourceHealthVNode = h('div', { style: 'padding:6px 10px;border-top:1px solid var(--rule);font:10px var(--ff-mono,monospace);color:var(--warn,#c33);display:flex;gap:14px;flex-wrap:wrap' }, healthChildren)
    }

    applyDiff(container, [
      toolbar,
      h('div', { class: 'ds-ep-panel-body flush', style: 'display:flex;flex-direction:column' }, [stage, cullingVNode, resourceHealthVNode].filter(Boolean))
    ])
  }

  render()

  return {
    // Poll only while the owning window is open -- zero cost when closed (no interval, no reads).
    start() { if (_pollId) return; _poll(); _pollId = setInterval(_poll, 500) },
    stop() { if (_pollId) { clearInterval(_pollId); _pollId = null } },
    destroy() { this.stop(); window.removeEventListener('mouseup', _onWindowMouseUp) }
  }
}
