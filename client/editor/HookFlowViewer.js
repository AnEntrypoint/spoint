import { h, applyDiff } from 'anentrypoint-design'
import { Btn, Toolbar, EmptyState, promptChannel, getSharedWM } from './wm/ui.js'

// Node-graph wire edges: a trigger/action entity wires to one or more target entities by storing their ids
// in its own editorProps-authored custom.targets array (editor-node-graph-wire-multi-target-per-source).
// The LEGACY shape is a single custom.target scalar (still authored by the entity-reference editorProp field
// -- that field stays single-select for now, editing only the first target; see targetsOf's normalize-on-read
// below), so an old world/save file or an Inspector-tab edit keeps working unchanged. apps/button,
// apps/trigger-volume, and any future action-emitting app all share this convention -- see AGENTS.md
// editor-engine-prep-fieldtypes-placeable-apps-2026-07-12c. custom.channel (default varies per app) is the
// bus channel EVERY wire from this source fires on (one channel per source entity, not per-edge -- matches
// how apps/button/apps/trigger-volume actually emit: one ctx.bus.emit(channel,...) call per press/enter, the
// `target` field rides along purely as event metadata, see AGENTS.md's audit log 2026-07-21c), carried along
// purely for the on-hover/edge label -- matching is done by (sourceEntity,channel) against the live event log
// in updateEvents, not by re-deriving a default here.
function targetsOf(custom) {
  if (!custom) return []
  if (Array.isArray(custom.targets)) return custom.targets.filter(t => t != null).map(String)
  if (custom.target != null) return [String(custom.target)]
  return []
}
function buildGraph(entities) {
  // Include every entity, not just app-spawned: many carry no appName and were previously filtered to nothing.
  const nodes = entities
    .filter(e => e && e.id)
    .map((e, i) => ({ id: e.id, label: e.id,
      kind: e._appName || e.appName || (e.model ? 'model' : e.custom ? 'primitive' : 'entity'),
      targets: targetsOf(e.custom),
      channel: e.custom?.channel || null,
      x: (i % 3) * 340 + 24, y: Math.floor(i / 3) * 180 + 24 }))
  const ids = new Set(nodes.map(n => n.id))
  // One edge per (source, target) pair -- a source with N targets draws N edges, all sharing that source's
  // single channel label (see the header comment: channel is per-source, not per-edge).
  const edges = []
  for (const n of nodes) for (const to of n.targets) if (ids.has(to)) edges.push({ from: n.id, to, channel: n.channel })
  return { nodes, edges }
}

// Drag-to-wire anchor: a small circle at the node card's right-center edge (the same point edgePath's
// `aRight, y1 = a.y+48` bezier already originates FROM for an outgoing wire, so a drawn wire visually
// starts exactly where the rubber-band line during drag did). `wiring` true means this card is the
// current drag source, drawn with the live accent color so the maker sees which anchor is "hot".
// `dropTarget` true means the cursor is currently hovering this card as a drop target mid-drag --
// highlighted with a dashed accent ring so the maker gets live feedback on which card would receive
// the wire on mouseup, matching the drag-and-drop affordance convention used by SceneHierarchy's own
// drag-reparent row highlight (hierarchy-sibling-drop-and-virtualization).
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

// Edge path between two node cards' anchor points (right-center of `from` to left-center of `to`, or the
// reverse when the target sits to the left -- avoids the line drawing through both card bodies). `pulse`
// true means a real bus event fired on this exact (from,channel) pair within PULSE_MS; drawn thicker + the
// live accent color + a traveling dot so the maker sees the signal actually crossing the wire in play mode.
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
  // Traveling dot only while the pulse is live: an animateMotion re-triggered each render call (the pulse
  // window is short, ~600ms, so a stale animation finishing mid-flight without a live event is fine -- it
  // just means "signal recently crossed this wire", the honest semantics of a node-graph pulse indicator).
  const dot = pulse
    ? '<circle r="4" fill="var(--accent)"><animateMotion dur="0.6s" repeatCount="1" path="' + d + '"/></circle>'
    : ''
  // A wide, invisible hit-stroke under the visible path: the visible line is only 1.5-3px, too thin to
  // reliably click for the edge-removal affordance below -- this transparent 16px-wide twin catches the
  // click without changing the drawn appearance. data-edge carries "from->to" so the click handler can
  // remove exactly this (source,target) pair from the source's custom.targets array (multi-target-per-source:
  // click removes ONE wire, drag-to-a-new-card appends one, see _completeWireDrag/onEdgeRemove below).
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
  // edgeKey ('from|channel') -> timestamp of the last matching bus event, for the live-signal pulse.
  let _lastFire = new Map(), _pulseTimer = null
  // In-canvas drag-to-wire state: _wireFrom is the source node id once a mousedown lands on a
  // .hf-wire-handle anchor; _wireCursor is the live graph-local (post pan/zoom) cursor position driving
  // the rubber-band line; _wireOverId is whichever node card the cursor is currently over (drop-target
  // highlight). All three reset to null/false on mouseup or a window-level mouseup miss, same discipline
  // as the existing pan `_drag` flag below (dragging off the svg's edge must never leave state stuck).
  let _wireFrom = null, _wireCursor = null, _wireOverId = null, _onWireCreate = null, _onEdgeRemove = null
  // Channel-picker data source (editor-node-graph-wire-channel-picker-multi-target): the server's APP_LIST
  // reply (EditorHandlers.js LIST_APPS scrapeChannels), keyed by app name -> {channels, emitsChannels}.
  // Fed in via updateApps() the same way updateGraph feeds _ents; Node-runtime-only (Worker/singleplayer
  // ships channels:[] per app, an honest degrade -- promptChannel's free-text fallback covers that case).
  let _appsByName = new Map()

  container.classList.add('ds-ep-panel')

  // Graph-local point (post pan/zoom, matching node.x/node.y's own coordinate space) from a raw
  // clientX/clientY -- reads the CURRENT svg element fresh each call since applyDiff may have replaced
  // the DOM node since the last render (same reason onmousemove below can't cache an element reference).
  function _toGraphPoint(clientX, clientY) {
    const svg = container.querySelector('.ds-hf-svg')
    const rect = svg ? svg.getBoundingClientRect() : { left: 0, top: 0 }
    return { x: (clientX - rect.left - _tx) / _sc, y: (clientY - rect.top - _ty) / _sc }
  }

  // Mirror mouseup on window: releasing past the svg's edge would otherwise leave _drag (or an
  // in-progress wire-drag) stuck true/non-null.
  const _onWindowMouseUp = (e) => {
    if (_wireFrom != null) { _completeWireDrag(e); return }
    if (_drag) { _drag = false; render() }
  }
  window.addEventListener('mouseup', _onWindowMouseUp)

  // Shared mouseup-anywhere completion: fires onWireCreate only when the release lands on a DIFFERENT
  // real node card than the drag source (a release on empty canvas, back on the source itself, or past
  // the panel edge with no target under the cursor all just cancel the drag with no wire created --
  // matching the SceneHierarchy drag-reparent convention of a no-op cancel on an invalid drop).
  //
  // Channel-picker (editor-node-graph-wire-channel-picker-multi-target): a valid drop no longer commits
  // custom.target immediately -- it opens promptChannel (a wm dialog, requires getSharedWM() to have been
  // registered by EditorShell's setSharedWM) so the maker picks/types custom.channel in the SAME gesture,
  // surfacing the target app's real scraped bus.on(...) channel names instead of a blind guess. If no wm
  // is registered (getSharedWM() null -- e.g. this viewer instantiated standalone) the wire still commits
  // with channel:null, same as the pre-picker behavior, rather than silently dropping the wire the drag
  // gesture already committed to visually.
  //
  // Multi-target-per-source (editor-node-graph-wire-multi-target-per-source): dragging a NEW wire from an
  // already-wired source onto a DIFFERENT, not-yet-wired card always APPENDS -- this is the whole point of
  // the row (a button firing two doors needs two real drags, not two separate button entities). Re-dragging
  // onto a card that's ALREADY a target of this source is a no-op drag (the wire already exists; the
  // explicit removal affordance is a click on the drawn edge itself, see the onclick handler below and
  // edgePath's wide invisible hit-stroke) -- silent no-op rather than silently duplicating the same edge or
  // reopening a picker the maker didn't ask for.
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
    // Rubber-band line: only drawn while a wire-drag is in flight (_wireFrom set), from the source card's
    // right-center anchor (same point edgePath uses for a real edge, so the live preview and the eventual
    // drawn wire share one visual origin) to the live cursor position. Styled dashed + accent to read as
    // "not yet committed", distinct from a real pulse-lit edge.
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
    // DOM EmptyState overlay, not SVG text: offsetWidth is 0 while the tab is hidden, so a text x=W/2 clipped off-panel.
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
        // Wire-handle mousedown takes priority over pan-start: a handle sits ON TOP of its node card, so
        // without this check-order a handle drag would also arm the (unrelated) pan-on-empty-canvas path
        // above the shared window mouseup handler, or -- since handles are inside .hf-node -- get
        // swallowed entirely by the existing `if (e.target.closest('.hf-node')) return` early-out that
        // was written before handles existed (that early-out is what makes plain node-body mousedown NOT
        // start a pan-drag; a handle click must be distinguished from it here, not left to fall through).
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
          // A completed (or cancelled) wire-drag's mouseup lands right before this click event on the
          // same gesture -- _wireFrom is already null again by then, so no extra guard is needed here;
          // the existing click-to-select behavior on a plain node-body click is untouched.
          //
          // Edge-click-to-remove (multi-target-per-source explicit-removal affordance): checked BEFORE the
          // node-card check since edgePath's wide hit-stroke sits under the node cards in z-order but a
          // click landing exactly on a thin visible wire segment between two cards (not over either card
          // body) only ever matches .hf-edge, never .hf-node -- no ordering conflict in practice, but the
          // edge check is written first so it reads as the more specific match.
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

  // Schedules render() again just after the pulse window elapses so a fired edge un-highlights on its own
  // even with no further updateEvents/updateGraph call -- otherwise a wire lit at tab-switch time would
  // stay lit forever until the next unrelated re-render.
  function _schedulePulseClear() {
    if (_pulseTimer) return
    _pulseTimer = setTimeout(() => { _pulseTimer = null; render() }, PULSE_MS + 50)
  }

  render()
  return {
    updateGraph(ents) { _ents = ents || []; render() },
    // apps: the server's APP_LIST array ({name, description, hasEditorProps, channels, emitsChannels}),
    // the same array EditorShell already caches as _knownApps for the Apps-tab picker -- reindexed by
    // name here so _completeWireDrag's channel-picker can look up the DROP TARGET's app in O(1).
    updateApps(apps) { _appsByName = new Map((apps || []).filter(a => a && a.name).map(a => [a.name, a])) },
    onNodeClick(cb) { _onClick = cb },
    // Fires (fromId, toId, channel) once a real drag from one node card's wire-handle releases over a
    // DIFFERENT node card AND the channel-picker dialog is confirmed (channel may be null if no wm is
    // registered, see _completeWireDrag). The caller owns writing this to custom.target/custom.channel
    // (client/app.js's editPanel.onEditorChange consumer reads editor.selectedEntityId implicitly, which
    // the drag source is NOT guaranteed to be -- callers should use an explicit-id update path, e.g. the
    // editorAPI.update(id,changes) bundle, not editor.sendEditorUpdate's implicit-selection shape).
    onWireCreate(cb) { _onWireCreate = cb },
    // Fires (fromId, toId) when the maker clicks a drawn wire's edge -- the explicit removal affordance for
    // multi-target-per-source (drag-to-a-new-card appends, click-an-edge removes; see _completeWireDrag's
    // comment). The caller owns rewriting custom.targets to drop `toId` from `fromId`'s array.
    onEdgeRemove(cb) { _onEdgeRemove = cb },
    // Reads the shared EVENT_LOG_DATA stream (the same 'bus_event' records AppRuntime.js already logs for
    // every ctx.bus.emit -- see AGENTS.md's audit log 2026-07-21 entry / AppRuntime.js:56) and stamps
    // _lastFire[sourceEntity|channel] so render() can light up the matching wire. Cheap: only entries whose
    // (sourceEntity,channel) pair matches a currently-drawn edge move the needle; everything else is ignored.
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
