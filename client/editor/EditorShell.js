import { components as C, h, applyDiff } from 'anentrypoint-design'
import { createSceneHierarchy } from './SceneHierarchy.js'
import { createLayerRegistry } from './LayerRegistry.js'
import { createEditorInspector } from './EditorInspector.js'
import { createEditorApps } from './EditorApps.js'
import { createEditorFsBrowse } from './EditorFsBrowse.js'
import { createHookFlowViewer } from './HookFlowViewer.js'
import { createRenderGraphViewer } from './RenderGraphViewer.js'
import { createProcgenPanel } from './ProcgenPanel.js'
import { createEditorEventLog } from './EditorEventLog.js'
import { createWorldValidator } from './WorldValidator.js'
import { createWaypointTimeline } from 'game-editor-kit'
import { createEventChainPanel } from './EventChainPanel.js'
import { showToast, setSceneEntityIds } from './EditPanelDOM.js'
import { ASSET_HOST } from './AssetManifest.js'
import { createWindowController } from './wm/WindowController.js'
import { setSharedWM } from './wm/ui.js'
import { ADD_PRIMITIVES, buildAddMenuItems, buildPropCategoryItems, buildCategoryMenuItems, loadRecent, recordRecent, filterMenuItems, promptName, _ensureWmCSS, _ensureEditorResponsiveCSS, TABS, EDITOR_SHORTCUTS } from './EditorShellMenus.js'
import { MSG } from '/src/protocol/MessageTypes.js'

export function createEditPanel({ onPlace, onPlaceModel, onSave, onSaveWorld, onListWorlds, onGizmoModeChange, onGizmoSpaceChange, onPivotModeChange, onEntitySelect, onGetSource, onGetAppFiles, onDestroyEntity, onCreateApp, onSnapChange, onEventLogQuery, onReparent, onRename, onDuplicate, onLockChange, onHiddenChange, onScatterArm, onAlign, onDistribute, onGroup, isSingleplayer, onFsListTree, onFsGetSource, onFsSave, onFsMkdir, onFsDelete, onFsRename, onJumpToHistory, onAddWaypoint, onReorderWaypoints, onToggleMinimapOverlay, onWireCreate, floatingOrigin, onEdgeRemove, onPlaceBatch, onPlaytestStart, onPlaytestStop, onCommandPalette, onDebugModeChange, onOpenP2PRoom, onOpenFreddieChat, onLayerAssign } = {}) {
  const overlay = document.createElement('div')
  overlay.className = 'ds-247420 ep-overlay'
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9000;pointer-events:none;display:none;color:var(--panel-text);font:12px/1.4 var(--ff-mono, monospace);padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);box-sizing:border-box'
  document.body.appendChild(overlay)
  _ensureEditorResponsiveCSS()
  _ensureWmCSS()
  // wmRoot is a sibling of overlay, not a child: overlay's applyDiff reconciles its child list exactly and would silently remove wmRoot.
  const wmRoot = document.createElement('div')
  wmRoot.className = 'wm-root'
  wmRoot.style.cssText = 'position:fixed;inset:0;display:none'
  document.body.appendChild(wmRoot)
  const wm = createWindowController({ root: wmRoot, storageKeyPrefix: 'ds-editor-wm-' })
  setSharedWM(wm)

  // Slots for imperative child components
  const hierarchyHost = document.createElement('div')
  hierarchyHost.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0'
  const hierAppMount = document.createElement('div')
  hierAppMount.className = 'ds-ep-panel-section'
  hierAppMount.style.cssText = 'max-height:50%;display:flex;flex-direction:column'

  const tabBodies = {}
  for (const t of TABS) {
    const body = document.createElement('div')
    body.style.cssText = 'flex:1;min-height:0;overflow:hidden;display:none;flex-direction:column'
    tabBodies[t] = body
  }

  const mkSplit = () => {
    const main = document.createElement('div')
    main.style.cssText = 'flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column'
    const appMount = document.createElement('div')
    appMount.className = 'ds-ep-panel-section'
    appMount.style.cssText = 'max-height:40%'
    return { main, appMount }
  }

  const insp = mkSplit(); tabBodies.Inspector.append(insp.main, insp.appMount)
  // Kit mount: a plain DOM seam at the top of the inspector pane where the
  // design repo's game-editor-kit components (ResetButton) are mounted from
  // app.js. No UI is rendered here -- the element only hosts kit output.
  const inspectorKitMount = document.createElement('div')
  insp.main.prepend(inspectorKitMount)
  const appsTab = mkSplit(); tabBodies.Apps.append(appsTab.main, appsTab.appMount)
  const evTab = mkSplit(); tabBodies.Events.append(evTab.main, evTab.appMount)

  // Stable host for the Tabs component (webjsx-diffed each render) so the wm
  // window body -- appended to the DOM exactly once by WindowController, outside
  // webjsx's own diff cycle -- keeps working across every render() call.
  const inspectorTabsHost = document.createElement('div')
  inspectorTabsHost.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column'

  let _tab = 'Inspector'
  let _gizmoMode = 'translate'
  // 'world' (default) uses fixed world axes for translate/scale drags; 'local' rotates them by the
  // selected entity's own orientation. Mirrors editor.js's own _gizmoSpace default so the toolbar
  // never opens out of sync with the real drag behavior.
  let _gizmoSpace = 'world'
  // Multi-select pivot mode: 'active' (default, back-compat) pivots the whole batch drag off the
  // primary selected entity; 'centroid' places the gizmo at the selection's geometric center;
  // 'individual' rotates/scales each selected entity about its own origin.
  let _pivotMode = 'active'
  let _snapOn = false, _snapSz = 0.25
  let _minimapOverlayOn = false
  const snapPresets = [0.1, 0.25, 0.5, 1.0, 2.0, 5.0]
  let _dirty = false
  let _playtesting = false
  let _debugMode = 'none' // 'none' | 'wireframe' | 'unlit' | 'overdraw' | 'lightcomplexity'

  // Lazy: the RenderGraph inspector must cost zero while never opened (no host DOM, no poll
  // interval) -- only createRenderGraphViewer (which starts render()-ing once, still zero-poll
  // until start()) on first open.
  let _renderGraphHost = null, _renderGraphViewer = null
  let _p2pHost = null, _p2pPanel = null
  let _freddieChatHost = null, _freddieChatPanel = null
  function _ensureRenderGraphViewer() {
    if (_renderGraphViewer) return
    _renderGraphHost = document.createElement('div')
    _renderGraphHost.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;height:100%'
    _renderGraphViewer = createRenderGraphViewer(_renderGraphHost)
  }

  // Same lazy-cost-zero-until-opened shape as the RenderGraph inspector above: zero host DOM, and
  // the lint itself is on-demand (Validate World button inside the panel), never auto-run on open.
  let _validatorHost = null, _validatorPanel = null
  function _ensureWorldValidator() {
    if (_validatorPanel) return
    _validatorHost = document.createElement('div')
    _validatorHost.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;height:100%'
    _validatorPanel = createWorldValidator(_validatorHost, {
      // Reuses the exact same select-entity path SceneHierarchy/HookFlow already call -- clicking a
      // lint row focuses/selects the offending entity in the viewport via the real onEntitySelect wiring.
      onSelect: id => { onEntitySelect?.(id); hierarchy.setSelected(id) }
    })
    _validatorPanel.updateEntities(_entities)
    _validatorPanel.updateKnownApps(_knownApps)
  }

  // Same lazy-cost-zero-until-opened shape as the RenderGraph/WorldValidator windows above: no host DOM,
  // no generator run, until the Procgen window is opened at least once (procedural-content-editor-toolbar-integration).
  let _procgenHost = null, _procgenPanel = null
  function _ensureProcgenPanel() {
    if (_procgenPanel) return
    _procgenHost = document.createElement('div')
    _procgenHost.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;height:100%'
    _procgenPanel = createProcgenPanel(_procgenHost, { onPlaceBatch: (plan) => onPlaceBatch?.(plan) })
  }

  // P2P Room panel: wireweave host/join room management (flagship-demo-wireweave-p2p-room)
  function _ensureP2PRoomPanel() {
    if (_p2pPanel) return
    _p2pHost = document.createElement('div')
    _p2pHost.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;height:100%'
    import('../editor/P2PRoomPanel.js').then(m => {
      _p2pPanel = m.createP2PRoomPanel({
        onRoomCreated: ({ roomId, joinUrl }) => {
          onOpenP2PRoom?.({ roomId, joinUrl })
        }
      })
      _p2pHost.appendChild(_p2pPanel.host)
    })
  }

  // Freddie chat panel: freddie agent chat UI (flagship-demo-freddie-spoint-bridge)
  function _ensureFreddieChatPanel() {
    if (_freddieChatPanel) return
    _freddieChatHost = document.createElement('div')
    _freddieChatHost.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;height:100%'
    import('../editor/FreddieChatPanel.js').then(m => {
      _freddieChatPanel = m.createFreddieChatPanel({
        agentId: 'freddie-editor',
        onSendMessage: (msg) => {
          // Forward freddie bridge messages to the server or external handler
          onOpenFreddieChat?.({ type: 'send', message: msg })
        }
      })
      _freddieChatHost.appendChild(_freddieChatPanel.host)
    })
  }

  // Same lazy-cost-zero-until-opened shape as the RenderGraph/WorldValidator windows above: no host DOM until
  // the Waypoint Timeline window is opened at least once. moving-platform-keyframe-timeline-followup first
  // slice: a live list/timeline view over the existing apps/waypoint custom._waypoint+order data model
  // (add/remove/reorder), not a new data model of its own -- see WaypointTimeline.js's own header comment.
  let _waypointHost = null, _waypointPanel = null
  function _ensureWaypointTimeline() {
    if (_waypointPanel) return
    _waypointHost = document.createElement('div')
    _waypointHost.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;height:100%'
    _waypointPanel = createWaypointTimeline(_waypointHost, {
      onSelect: id => { onEntitySelect?.(id); hierarchy.setSelected(id) },
      onAdd: (nextOrder) => onAddWaypoint?.(nextOrder),
      onRemove: id => onDestroyEntity?.(id),
      onReorder: (delta) => onReorderWaypoints?.(delta)
    })
    _waypointPanel.updateEntities(_entities)
  }

  // Same lazy-cost-zero-until-opened shape as the RenderGraph inspector above: no host DOM, no
  // LIST_FS_TREE request, until the maker actually opens the FS Browse window.
  let _fsBrowseHost = null, _fsBrowsePanel = null
  function _ensureFsBrowsePanel() {
    if (_fsBrowsePanel) return
    _fsBrowseHost = document.createElement('div')
    _fsBrowseHost.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;height:100%'
    _fsBrowsePanel = createEditorFsBrowse(_fsBrowseHost, {
      onListTree: () => onFsListTree?.(),
      onGetSource: (path) => onFsGetSource?.(path),
      onSave: (path, source, baseMtimeMs) => onFsSave?.(path, source, baseMtimeMs),
      onMkdir: (path) => onFsMkdir?.(path),
      onDelete: (path) => onFsDelete?.(path),
      onRename: (path, newPath) => onFsRename?.(path, newPath)
    })
  }

  // Same lazy-cost-zero-until-opened shape as the RenderGraph/FS Browse hosts above: no host DOM until
  // the History window is opened at least once. _renderHistoryBody is defined inside shellView (below,
  // closes over onJumpToHistory) so this only allocates the persistent element the wm body attaches to.
  let _historyHost = null
  function _ensureHistoryHost() {
    if (_historyHost) return
    _historyHost = document.createElement('div')
    _historyHost.style.cssText = 'padding:8px;overflow-y:auto;height:100%;font:12px var(--ff-mono,monospace)'
  }
  // History window body (editor-undo-transactionality-multiselect-batch-inspector): a live, clickable
  // list of every named transaction currently on EditHistory's undo/redo stacks -- newest first, each
  // row shows the human-readable name (e.g. "box-1 position" or "3 entities scale") and how long ago it
  // landed. Clicking a row calls onJumpToHistory(txnId), which replays undo()/redo() the minimum number
  // of steps to land exactly on that transaction's post-commit state (see EditHistory.jumpTo). The
  // currently-live top-of-undo-stack entry (depth 0, state 'done') is highlighted so a maker can see
  // "you are here" at a glance, matching the row's own "history panel ... jump to that undo state" ask.
  // Outer-scope (not inside shellView, which is re-created every render): updateHistory() below calls
  // this directly from outside shellView's closure to live-refresh an already-open window.
  function _renderHistoryBody(body) {
    const rows = _historyEntries
    applyDiff(body, [
      rows.length
        ? h('ul', { style: 'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px' },
            ...rows.map(r => {
              const isCurrent = r.state === 'done' && r.depth === 0
              const ageS = Math.max(0, Math.round((Date.now() - r.at) / 1000))
              const ageLabel = ageS < 60 ? ageS + 's ago' : Math.round(ageS / 60) + 'm ago'
              return h('li', {
                class: 'ds-ep-history-row' + (isCurrent ? ' current' : '') + (r.state === 'undone' ? ' undone' : ''),
                title: 'Jump to state right after this transaction',
                style: 'display:flex;align-items:center;gap:8px;padding:5px 8px;cursor:pointer;border-radius:4px;' +
                  (isCurrent ? 'background:var(--accent-bg,rgba(80,160,255,0.16));font-weight:600;' : '') +
                  (r.state === 'undone' ? 'opacity:0.55;text-decoration:line-through;' : ''),
                onclick: () => onJumpToHistory?.(r.txnId)
              },
                h('span', { style: 'flex:0 0 auto;width:14px;text-align:center' }, isCurrent ? '▸' : ''),
                h('span', { style: 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, r.name + (r.count > 1 ? ' (×' + r.count + ')' : '')),
                h('span', { style: 'flex:0 0 auto;font-size:10px;opacity:0.6' }, ageLabel)
              )
            })
          )
        : h('div', { style: 'padding:16px;text-align:center;opacity:0.5' }, 'No edits yet this session')
    ])
  }

  function shellView() {
    const brand = C.Brand({ name: 'spoint' })
    const sep = () => h('div', { style: 'width:1px;height:18px;background:var(--rule);margin:0 4px' })
    const groupLabel = (txt) => h('span', { style: 'font:8px/1 var(--ff-mono, monospace);text-transform:uppercase;letter-spacing:0.12em;color:var(--panel-text-3)' }, txt)

    const saveWorldLabel = _dirty ? 'Save World *' : 'Save World'
    // Singleplayer has no server fs: the world def downloads as .js instead, must be manually moved into apps/world/.
    const saveWorldTitle = isSingleplayer
      ? 'Download the current scene as a .js file (singleplayer has no server filesystem -- move it into apps/world/ to reload it later)'
      : 'Save the current scene as a reloadable world'
    const saveWorldPromptLabel = isSingleplayer ? 'World name (will download a .js file)' : 'World name'
    const saveWorldBtn = C.Btn
      ? C.Btn({ primary: true, dense: true, title: saveWorldTitle, onClick: async (e) => {
          e.preventDefault()
          const name = await promptName(wm, { title: isSingleplayer ? 'Download World' : 'Save World', label: saveWorldPromptLabel, placeholder: 'my-game' })
          if (name) onSaveWorld?.(name)
        }, children: [saveWorldLabel] })
      : h('button', { onclick: async () => { const n = await promptName(wm, { title: isSingleplayer ? 'Download World' : 'Save World', label: saveWorldPromptLabel, placeholder: 'my-game' }); if (n) onSaveWorld?.(n) } }, saveWorldLabel)

    const loadWorldBtn = C.Btn
      ? C.Btn({ dense: true, title: 'Load a different world', onClick: async (e) => { e.preventDefault(); await openLoadWorldDialog() }, children: ['Load World'] })
      : h('button', { onclick: async () => { await openLoadWorldDialog() } }, 'Load World')

    async function openLoadWorldDialog() {
      const worlds = await onListWorlds?.() || []
      const winId = 'load-world'
      const body = document.createElement('div')
      body.style.cssText = 'display:flex;flex-direction:column;overflow-y:auto;height:100%'
      if (worlds.length) {
        for (const w of worlds) {
          const row = document.createElement('div')
          row.style.cssText = 'padding:6px 4px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.08)'
          row.setAttribute('role', 'button')
          row.setAttribute('tabindex', '0')
          row.setAttribute('aria-label', 'Load world ' + w)
          const name = document.createElement('div')
          name.textContent = w
          row.appendChild(name)
          // sandbox.js (apps/world/sandbox.js) ships with entities:[] -- the genuine blank-canvas
          // starting point for a new maker, otherwise indistinguishable from any other saved world
          // in this flat name list.
          if (w === 'sandbox') {
            const hint = document.createElement('div')
            hint.textContent = 'Empty starting point -- no placed entities, add everything from scratch'
            hint.style.cssText = 'color:rgba(255,255,255,0.45);font-size:11px;margin-top:2px'
            row.appendChild(hint)
          }
          const activateRow = () => {
            wm.close(winId)
            const params = new URLSearchParams(location.search)
            params.set('world', w)
            location.href = location.pathname + '?' + params.toString()
          }
          row.addEventListener('click', activateRow)
          row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateRow() }
          })
          body.appendChild(row)
        }
      } else {
        const empty = document.createElement('div')
        empty.style.cssText = 'color:rgba(255,255,255,0.4);font:12px monospace;padding:8px'
        empty.textContent = 'No saved worlds found (or running in a filesystem-less singleplayer session -- edit the ?world= URL param manually)'
        body.appendChild(empty)
      }
      wm.open({ id: winId, title: 'Load World', x: (window.innerWidth - 340) / 2, y: (window.innerHeight - 320) / 2, w: 340, h: 320, body })
    }

    const topbar = C.Toolbar({
      leading: [brand, sep(), saveWorldBtn, loadWorldBtn, sep()],
      children: [
        h('span', { style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;pointer-events:all' },
          groupLabel('Add'), C.Btn
            ? C.Btn({ dense: true, title: 'Add a prop or primitive', onClick: (e) => { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); openAddMenu(r.left, r.bottom) }, children: ['Add'] })
            : h('button', { onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); openAddMenu(r.left, r.bottom) } }, 'Add'),
          groupLabel('Gizmo'), C.IconButtonGroup({
            items: [{ id: 'translate', label: 'Move' }, { id: 'rotate', label: 'Rotate' }, { id: 'scale', label: 'Scale' }],
            value: _gizmoMode,
            onChange: (id) => { _gizmoMode = id; onGizmoModeChange?.(id); render() }
          }),
          // editor-gizmo-local-world-toggle: world (fixed X/Y/Z) vs local (rotated by the selected
          // entity's own orientation) drag axes. Also bound to the 'Y' key (unused before this,
          // see EDITOR_SHORTCUTS below) since Blender/Unity both keyboard-bind this same toggle.
          groupLabel('Space'), C.IconButtonGroup({
            items: [{ id: 'world', label: 'World' }, { id: 'local', label: 'Local' }],
            value: _gizmoSpace,
            onChange: (id) => { _gizmoSpace = id; onGizmoSpaceChange?.(id); render() }
          }),
          // editor-multiselect-pivot-options: only meaningful with 2+ entities selected, but stays
          // always-visible/always-enabled (same convention as Align/Distribute/Group above) rather
          // than computing selection count here.
          groupLabel('Pivot'), C.IconButtonGroup({
            items: [{ id: 'active', label: 'Active' }, { id: 'centroid', label: 'Centroid' }, { id: 'individual', label: 'Individual' }],
            value: _pivotMode,
            onChange: (id) => { _pivotMode = id; onPivotModeChange?.(id); render() }
          }),
          groupLabel('Grid'), C.IconButtonGroup({
            items: [{ id: 'snap', label: 'SNAP' }],
            value: _snapOn ? 'snap' : null,
            onChange: () => { _snapOn = !_snapOn; onSnapChange?.(_snapOn, _snapSz); render() }
          }),
          C.IconButtonGroup({
            items: snapPresets.map(sz => ({ id: String(sz), label: String(sz) })),
            value: String(_snapSz),
            onChange: (id) => { _snapSz = parseFloat(id); if (_snapOn) onSnapChange?.(_snapOn, _snapSz); render() },
            dense: true
          }),
          // editor-align-distribute: align-to-primary and even-spacing tools for the current
          // multi-select set. Both no-op (onAlign/onDistribute themselves report via showToast)
          // when fewer than 2 entities are selected -- the buttons stay always-visible/always-enabled
          // rather than computing selection count here, since EditorShell doesn't own selection state.
          groupLabel('Align'), C.IconButtonGroup({
            items: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }, { id: 'z', label: 'Z' }],
            value: null,
            onChange: (axis) => onAlign?.(axis)
          }),
          groupLabel('Distribute'), C.IconButtonGroup({
            items: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }, { id: 'z', label: 'Z' }],
            value: null,
            onChange: (axis) => onDistribute?.(axis)
          }),
          // group-parent: bundles the current multi-selection under one new empty parent entity
          // (GROUP_ENTITIES, 0xa3). No-ops with a toast (server-side) below 2 selected -- same
          // always-visible/always-enabled convention as Align/Distribute above.
          groupLabel('Group'), C.Btn
            ? C.Btn({ dense: true, title: 'Group selected entities under a new parent', onClick: (e) => { e.preventDefault(); onGroup?.() }, children: ['Group'] })
            : h('button', { onclick: (e) => { onGroup?.() } }, 'Group'),
          // Playtest: in-editor play/pause/eject with snapshot-and-rollback
          groupLabel('Play'), C.Btn
            ? C.Btn({ dense: true, title: _playtesting ? 'Stop playtest and restore world state' : 'Playtest in-editor (snapshot world, possess camera)', onClick: (e) => { e.preventDefault(); if (_playtesting) { _playtesting = false; onPlaytestStop?.(); } else { _playtesting = true; onPlaytestStart?.(); } render() }, children: [_playtesting ? '■ Stop' : '▶ Play'] })
            : h('button', { onclick: () => { if (_playtesting) { _playtesting = false; onPlaytestStop?.(); } else { _playtesting = true; onPlaytestStart?.(); } render() } }, _playtesting ? 'Stop' : 'Play'),
          // Debug view modes dropdown
          groupLabel('View'), C.Btn
            ? C.Btn({ dense: true, title: 'Viewport debug render mode', onClick: (e) => { e.preventDefault(); const menu = [{ label: 'Normal', onSelect: () => { _debugMode = 'none'; onDebugModeChange?.('none'); render() } }, { label: 'Wireframe', onSelect: () => { _debugMode = 'wireframe'; onDebugModeChange?.('wireframe'); render() } }, { label: 'Unlit', onSelect: () => { _debugMode = 'unlit'; onDebugModeChange?.('unlit'); render() } }, { label: 'Overdraw', onSelect: () => { _debugMode = 'overdraw'; onDebugModeChange?.('overdraw'); render() } }, { label: 'Light Complexity', onSelect: () => { _debugMode = 'lightcomplexity'; onDebugModeChange?.('lightcomplexity'); render() } }]; const host = document.createElement('div'); host.className = 'ds-247420'; document.body.appendChild(host); applyDiff(host, [C.ContextMenu({ anchor: { x: e.clientX, y: e.clientY }, onClose: () => { host.remove() }, items: menu })]) }, children: ['View: ' + (_debugMode === 'none' ? 'Normal' : _debugMode)] })
            : h('button', { onclick: () => { /* debug mode toggle */ } }, 'View'),
          // Command palette trigger
          C.Btn
            ? C.Btn({ dense: true, title: 'Command palette (Ctrl+Shift+P)', onClick: (e) => { e.preventDefault(); onCommandPalette?.() }, children: ['⌘'] })
            : h('button', { onclick: () => onCommandPalette?.() }, '⌘')
        )
      ]
    })

    applyDiff(inspectorTabsHost, [
      C.Tabs({
        items: TABS.map(id => ({ id, label: id })),
        active: _tab,
        onChange: (id) => _switchTab(id),
        children: TABS.map(t => h('div', {
          ref: (el) => { if (el && !el.contains(tabBodies[t])) el.appendChild(tabBodies[t]) },
          style: 'display:' + (t === _tab ? 'flex' : 'none') + ';flex:1;min-height:0;flex-direction:column'
        }))
      })
    ])

    // wm.open() no-ops on an already-open id, safe to call every render().
    if (!hierarchyHost._dsWmMounted) { hierarchyHost._dsWmMounted = true; hierarchyHost.append(hierAppMount) }
    wm.open({ id: 'scene', title: 'Scene', x: 12, y: 12, w: 320, h: 420, body: hierarchyHost })
    wm.open({ id: 'inspector', title: 'Inspector', x: window.innerWidth - 352, y: 12, w: 340, h: 460, body: inspectorTabsHost })

    const main = h('div', { class: 'ds-ep-stage' },
      h('div', { class: 'ep-viewport-pane', style: 'position:absolute;inset:0;pointer-events:none' })
    )

    const p2pBtn = onOpenP2PRoom ? (C.Btn
      ? C.Btn({ ghost: true, dense: true, title: 'Host or join a P2P room via wireweave', onClick: (e) => { e.preventDefault(); openP2PRoomWindow() }, children: ['P2P Room'] })
      : h('button', { onclick: () => openP2PRoomWindow() }, 'P2P Room')) : null
    const freddieBtn = onOpenFreddieChat ? (C.Btn
      ? C.Btn({ ghost: true, dense: true, title: 'Freddie agent chat panel', onClick: (e) => { e.preventDefault(); openFreddieChatWindow() }, children: ['Freddie'] })
      : h('button', { onclick: () => openFreddieChatWindow() }, 'Freddie')) : null
    const helpBtn = C.Btn
      ? C.Btn({ ghost: true, dense: true, title: 'Keyboard shortcuts', onClick: (e) => { e.preventDefault(); openShortcutsWindow() }, children: ['Shortcuts'] })
      : h('button', { onclick: () => openShortcutsWindow() }, 'Shortcuts')
    const renderGraphBtn = C.Btn
      ? C.Btn({ ghost: true, dense: true, title: 'RenderGraph inspector (live per-node timing, dependency edges, bisect toggles)', onClick: (e) => { e.preventDefault(); openRenderGraphWindow() }, children: ['RenderGraph'] })
      : h('button', { onclick: () => openRenderGraphWindow() }, 'RenderGraph')
    const fsBrowseBtn = C.Btn
      ? C.Btn({ ghost: true, dense: true, title: 'Browse the full apps/ tree: create/edit/rename/delete files and folders', onClick: (e) => { e.preventDefault(); openFsBrowseWindow() }, children: ['FS Browse'] })
      : h('button', { onclick: () => openFsBrowseWindow() }, 'FS Browse')
    const validateBtn = C.Btn
      ? C.Btn({ ghost: true, dense: true, title: 'Lint the currently-loaded world for common authoring mistakes', onClick: (e) => { e.preventDefault(); openWorldValidatorWindow() }, children: ['Validate World'] })
      : h('button', { onclick: () => openWorldValidatorWindow() }, 'Validate World')
    const waypointsBtn = C.Btn
      ? C.Btn({ ghost: true, dense: true, title: 'Waypoint path timeline: add/remove/reorder the waypoint entities apps/waypoint + apps/_lib/path.js read', onClick: (e) => { e.preventDefault(); openWaypointTimelineWindow() }, children: ['Waypoints'] })
      : h('button', { onclick: () => openWaypointTimelineWindow() }, 'Waypoints')
    const procgenBtn = C.Btn
      ? C.Btn({ ghost: true, dense: true, title: 'Procedural content generators (WFC grid layout, L-system tree, noise terrain): preview + place into the world', onClick: (e) => { e.preventDefault(); openProcgenWindow() }, children: ['Procgen'] })
      : h('button', { onclick: () => openProcgenWindow() }, 'Procgen')
    // Minimap reference overlay (minimap-hud-editor-ui-integration): toggles a ground-plane textured
    // with the same baked top-down PNG the HUD widget uses, for level-design orientation. Scene-mesh
    // ownership stays in editor.js (same pattern as gizmoGroup/radiusGizmoGroup) -- this button is a
    // pure UI affordance, calling back to whatever the app.js wiring provided; toggles its own pressed
    // look via _minimapOverlayOn so the button state stays in sync even though the mesh itself lives
    // outside this module.
    const minimapBtn = onToggleMinimapOverlay ? (C.Btn
      ? C.Btn({ ghost: true, dense: true, title: 'Toggle baked minimap ground-plane reference overlay (level-design orientation)', onClick: (e) => { e.preventDefault(); _minimapOverlayOn = !!onToggleMinimapOverlay(); render() }, children: [_minimapOverlayOn ? '✓ Minimap' : 'Minimap'] })
      : h('button', { onclick: () => { _minimapOverlayOn = !!onToggleMinimapOverlay(); render() } }, _minimapOverlayOn ? '✓ Minimap' : 'Minimap')) : null
    const historyBtn = C.Btn
      ? C.Btn({ ghost: true, dense: true, title: 'Named edit history: click any entry to jump to that undo state', onClick: (e) => { e.preventDefault(); openHistoryWindow() }, children: ['History (' + _historyEntries.filter(r => r.state === 'done').length + ')'] })
      : h('button', { onclick: () => openHistoryWindow() }, 'History')
    // Dense single-line info strip (entity count / selection count / fps) -- verified+adjusted per
    // editor-status-bar-info-density: prior memory reported an oversized ~68px bar with thin info content;
    // this packs all three counters into one row alongside the existing status text/cam-coords/buttons rather
    // than adding a second row, keeping the bar's height to a single line of text regardless of viewport size.
    const _selCount = hierarchy.selectionCount
    const infoStrip = h('div', {
      class: 'ds-ep-statusbar-info', style: 'display:flex;gap:10px;font:11px var(--ff-mono,monospace);color:var(--panel-text-2,var(--fg-2));white-space:nowrap;align-items:center'
    },
      h('span', { class: 'ds-ep-info-entities' }, `${_entities.length} entities`),
      h('span', { class: 'ds-ep-info-sel' }, `${_selCount} sel`),
      h('span', { class: 'ds-ep-info-fps' }, `${_fps} fps`)
    )
    const status = h('div', { class: 'ds-ep-statusbar', style: 'pointer-events:all;display:flex;align-items:center;gap:12px;min-height:0;line-height:1.2;padding:2px 8px' },
      h('div', { class: 'ds-ep-statusbar-left' }, _statusLeft || 'Ready'),
      infoStrip,
      // Per-frame camera coords are written directly via setCamCoords (textContent), not through render, to avoid diff thrash.
      h('div', { class: 'ds-ep-cam-coords', style: 'font:11px var(--ff-mono,monospace);color:var(--panel-text-2,var(--fg-2));white-space:nowrap' }, _camCoords),
      // Bookmarks affordance: save/recall live in editor.js's keydown handler (owns `camera`
      // directly); this button just surfaces the scheme via the same shortcuts window rather
      // than wiring a redundant cross-module callback for a feature already keyboard-driven.
      C.Btn
        ? C.Btn({ ghost: true, dense: true, title: 'Camera bookmarks: Ctrl+Alt+1..9 to save, Alt+1..9 to recall', onClick: (e) => { e.preventDefault(); openShortcutsWindow() }, children: ['Bookmarks'] })
        : h('button', { onclick: () => openShortcutsWindow() }, 'Bookmarks'),
      h('div', { class: 'ds-ep-statusbar-right', style: 'display:flex;gap:6px;margin-left:auto' }, ...(p2pBtn ? [p2pBtn] : []), ...(freddieBtn ? [freddieBtn] : []), ...(minimapBtn ? [minimapBtn] : []), historyBtn, validateBtn, waypointsBtn, procgenBtn, fsBrowseBtn, renderGraphBtn, helpBtn)
    )

    function openShortcutsWindow() {
      const groups = {}
      for (const s of EDITOR_SHORTCUTS) (groups[s.scope] = groups[s.scope] || []).push(s)
      const body = document.createElement('div')
      body.style.cssText = 'padding:12px;overflow-y:auto;height:100%;font:12px var(--ff-mono,monospace)'
      for (const [scope, rows] of Object.entries(groups)) {
        const section = document.createElement('section')
        const h3 = document.createElement('h3')
        h3.textContent = scope
        h3.style.cssText = 'margin:12px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--panel-text-3,var(--fg-3))'
        section.appendChild(h3)
        const ul = document.createElement('ul')
        ul.style.cssText = 'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px'
        for (const r of rows) {
          const li = document.createElement('li')
          li.style.cssText = 'display:flex;align-items:center;gap:8px'
          const kbd = document.createElement('kbd')
          kbd.textContent = r.combo
          kbd.style.cssText = 'background:var(--panel-3,var(--bg-3));border-radius:var(--r-1,4px);padding:2px 6px;font:11px var(--ff-mono,monospace)'
          const label = document.createElement('span')
          label.textContent = r.label || ''
          label.style.color = 'var(--panel-text-2,var(--fg-2))'
          li.append(kbd, label)
          ul.appendChild(li)
        }
        section.appendChild(ul)
        body.appendChild(section)
      }
      wm.open({ id: 'shortcuts', title: 'Keyboard shortcuts', x: (window.innerWidth - 380) / 2, y: (window.innerHeight - 420) / 2, w: 380, h: 420, body })
    }

    function openHistoryWindow() {
      // Stable host (same lazy-persistent-body shape as RenderGraph/FS Browse above): wm.open() on an
      // already-open id just focuses and returns the EXISTING handle without touching body, so a NEW
      // element passed on a re-open would never actually get attached -- _historyHost must be created
      // once and mutated in place via applyDiff on every call (open OR a live onChange re-render).
      _ensureHistoryHost()
      _renderHistoryBody(_historyHost)
      wm.open({ id: 'history', title: 'History', x: (window.innerWidth - 340) / 2, y: (window.innerHeight - 420) / 2, w: 340, h: 420, body: _historyHost })
    }

    function openRenderGraphWindow() {
      // renderGraphHost + renderGraphViewer are created lazily once (module-scope closure below),
      // reused across opens -- wm.open() no-ops on an already-open id so re-clicking just focuses it.
      _ensureRenderGraphViewer()
      const already = wm.getWindow('rendergraph')
      wm.open({
        id: 'rendergraph', title: 'RenderGraph', x: (window.innerWidth - 900) / 2, y: (window.innerHeight - 560) / 2, w: 900, h: 560,
        body: _renderGraphHost,
        onClose: () => { _renderGraphViewer?.stop() }
      })
      if (!already) _renderGraphViewer?.start()
    }

    function openFsBrowseWindow() {
      _ensureFsBrowsePanel()
      const already = wm.getWindow('fsbrowse')
      wm.open({ id: 'fsbrowse', title: 'FS Browse (apps/)', x: (window.innerWidth - 480) / 2, y: (window.innerHeight - 520) / 2, w: 480, h: 520, body: _fsBrowseHost })
      // Fresh tree on every open, not just the first: an external agent may have created/deleted
      // files while this window was closed, and FS_TREE_CHANGED pushes are only listened to while
      // the panel object exists -- an explicit re-list on open covers the "closed the whole time" gap.
      onFsListTree?.()
    }

    function openWorldValidatorWindow() {
      _ensureWorldValidator()
      wm.open({ id: 'worldvalidator', title: 'Validate World', x: (window.innerWidth - 460) / 2, y: (window.innerHeight - 440) / 2, w: 460, h: 440, body: _validatorHost })
    }

    function openWaypointTimelineWindow() {
      _ensureWaypointTimeline()
      wm.open({ id: 'waypointtimeline', title: 'Waypoints', x: (window.innerWidth - 420) / 2, y: (window.innerHeight - 440) / 2, w: 420, h: 440, body: _waypointHost })
      // Fresh list on every open, same discipline as FS Browse above -- entities may have changed
      // (waypoints placed/deleted via the normal Add menu / Delete key) while this window was closed.
      _waypointPanel?.updateEntities(_entities)
    }

    function openProcgenWindow() {
      _ensureProcgenPanel()
      wm.open({ id: 'procgen', title: 'Procgen', x: (window.innerWidth - 380) / 2, y: (window.innerHeight - 560) / 2, w: 380, h: 560, body: _procgenHost })
    }

    function openP2PRoomWindow() {
      _ensureP2PRoomPanel()
      wm.open({ id: 'p2proom', title: 'P2P Room', x: (window.innerWidth - 380) / 2, y: (window.innerHeight - 480) / 2, w: 380, h: 480, body: _p2pHost })
    }

    function openFreddieChatWindow() {
      _ensureFreddieChatPanel()
      wm.open({ id: 'freddiechat', title: 'Freddie Chat', x: (window.innerWidth - 360) / 2, y: (window.innerHeight - 440) / 2, w: 360, h: 440, body: _freddieChatHost })
    }

    return h('div', { style: 'display:contents' }, C.AppShell({ topbar, main, status }))
  }

  function render() {
    applyDiff(overlay, [shellView()])
    for (const t of TABS) tabBodies[t].style.display = (t === _tab ? 'flex' : 'none')
  }

  const hierarchy = createSceneHierarchy(hierarchyHost, {
    onSelect: id => { onEntitySelect?.(id) },
    onFocus: id => { onEntitySelect?.(id) },
    onDelete: id => onDestroyEntity?.(id),
    onReparent: (childId, parentId) => onReparent?.(childId, parentId),
    onRename: (id, label) => onRename?.(id, label),
    onDuplicate: id => onDuplicate?.(id),
    onLockChange: ids => onLockChange?.(ids),
    onHiddenChange: ids => onHiddenChange?.(ids),
    onSaveSelectionAsPrefab: (ids, prefabName) => {
    }
  })

  // editor-layers-panel: cascading layer-wide visibility/lock on top of SceneHierarchy's own
  // per-entity lock/hidden sets (see LayerRegistry.js's own header comment for the full design).
  // Assignment persists server-side via the generic custom._layer EDITOR_UPDATE merge; sync back
  // on every scene-graph refresh (updateScene call site below) so a reconnect/reload doesn't
  // silently drop layer membership.
  const layers = createLayerRegistry({
    setLocked: (id, v) => hierarchy.setLocked(id, v),
    setHidden: (id, v) => hierarchy.setHiddenInEditor(id, v),
    sendLayerUpdate: (id, layerName) => onLayerAssign?.(id, layerName)
  })

  const inspector = createEditorInspector(insp.main, {
    onDestroyEntity: id => onDestroyEntity?.(id),
    onEditCode: name => _switchTab('Apps'),
    onRename: (id, label) => onRename?.(id, label)
  })
  inspector.onEditorChange((key, val) => _onChange?.(key, val))

  const appsPanel = createEditorApps(appsTab.main, {
    onPlace, onSave, onGetSource, onGetAppFiles, onCreateApp,
    getSelectedEntities: () => {
      const ids = hierarchy.selectedIds || []
      return _entities.filter(e => ids.includes(e.id))
    }
  })
  const hfViewer = createHookFlowViewer(tabBodies.HookFlow)
  hfViewer.onNodeClick(id => { onEntitySelect?.(id); hierarchy.setSelected(id) })
  hfViewer.onWireCreate((fromId, toId, channel) => onWireCreate?.(fromId, toId, channel))
  hfViewer.onEdgeRemove((fromId, toId) => onEdgeRemove?.(fromId, toId))
  const evLog = createEditorEventLog(evTab.main, { onQuery: () => onEventLogQuery?.() })
  const eventChainPanel = createEventChainPanel(tabBodies.EventChains, {
    onChainChange: (spec) => { _onChange?.('eventChains', spec) },
    getEntities: () => _entities,
    getApps: () => _knownApps
  })

  let _onChange = null, _entities = [], _knownApps = [], _onTabChange = null, _statusLeft = 'Ready', _camCoords = '', _fps = 0
  // Named-transaction history panel (editor-undo-transactionality): the live list from EditHistory.list(),
  // pushed in by app.js's editHistory.onChange -> editPanel.updateHistory(list). Re-rendered on every
  // change while the History window is open; when closed, updateHistory just updates the cached array so
  // the NEXT open shows current state without needing a fresh push.
  let _historyEntries = []

  function _switchTab(t) {
    if (!TABS.includes(t)) return
    _tab = t
    render()
    if (t === 'HookFlow') hfViewer.updateGraph(_entities)
    if (t === 'EventChains') eventChainPanel.updateEntitiesAndApps(_entities, _knownApps)
    // HookFlow's live-signal wire pulses need the same event-log poll Events already runs -- both tabs
    // share one evLog.start()/stop() cadence (2s interval, see EditorEventLog.js), evLog.updateEvents just
    // also forwards to hfViewer below so switching tabs never double-polls the server.
    if (t === 'Events' || t === 'HookFlow') evLog.start(); else evLog.stop()
    if (_onTabChange) try { _onTabChange(t) } catch (_) {}
  }

  render()

  let _vpMenuHost = null
  function _vpHost() {
    if (_vpMenuHost && _vpMenuHost.isConnected) return _vpMenuHost
    _vpMenuHost = document.createElement('div'); _vpMenuHost.className = 'ds-247420'
    document.body.appendChild(_vpMenuHost)
    return _vpMenuHost
  }
  function openAddMenu(x, y, placePos) {
    const host = _vpHost()
    let _recent = loadRecent()
    let _query = ''
    let _highlight = -1
    let _flatItems = []   // last-rendered selectable items (recent + filtered base), for keyboard nav
    let _keyHandler = null
    let _searchBox = null   // real <input> overlaid above the ContextMenu's own DOM
    const close = () => {
      if (_keyHandler) { document.removeEventListener('keydown', _keyHandler, true); _keyHandler = null }
      if (_searchBox) { _searchBox.remove(); _searchBox = null }
      applyDiff(host, [])
    }
    // editor-multi-place-drag: when armed, an Add-menu selection doesn't place a single copy --
    // it arms the viewport's scatter-drag mode (see editor.js armScatterPlace) so the NEXT
    // empty-space drag places a copy every ~2 world units of travel, ground-following via
    // the same raycastHitPoint used for snap-to-surface.
    let _scatterOn = false
    const scatterState = { get on() { return _scatterOn }, toggle: () => { _scatterOn = !_scatterOn; repaint(buildAddMenuItems(place, openPropSubmenu, scatterState)) } }
    // placePos (optional [x,y,z] world point, e.g. the viewport-context-menu's raycast-under-cursor position)
    // overrides the caller's own default (viewport-center) placement position for both apps and prop models.
    // Both callers of this already supply AUTHORITATIVE placePos (app.js's _viewportCenterPlacePos/
    // _vpMenuPlacePos both convert through floatingOrigin.toAuthoritative). The scatter-place `hit` below
    // is different: editor.js's armScatterPlace feeds it a RAW render-space raycastHitPoint per drag-step
    // (see editor.js's own _scatterActive loop) -- convert it the same way here, or scatter-placing past
    // the first floating-origin rebase drops every copy near the render-space origin instead of along
    // the actual drag path (editor-inspector-gizmo-position-display-write-floating-origin).
    const _scatterHitAuth = (hit) => { if (!floatingOrigin) return [hit.x, hit.y, hit.z]; const a = floatingOrigin.toAuthoritative(hit); return [a.x, a.y, a.z] }
    const place = (id) => {
      _recent = recordRecent({ key: id, label: (ADD_PRIMITIVES.find(p => p.id === id) || {}).label || id, kind: 'primitive', value: id }, _recent)
      close()
      if (_scatterOn && onScatterArm) { onScatterArm(hit => onPlace?.(id, _scatterHitAuth(hit))); showToast('Scatter-place armed: drag in viewport') }
      else { onPlace?.(id, placePos); showToast('Placed ' + id.replace('-static', '')) }
    }
    const placeModel = (url, name) => {
      _recent = recordRecent({ key: url, label: name || url, kind: 'prop', value: url }, _recent)
      close()
      if (_scatterOn && onScatterArm) { onScatterArm(hit => onPlaceModel?.(url, _scatterHitAuth(hit))); showToast('Scatter-place armed: drag in viewport') }
      else { onPlaceModel?.(url, placePos); showToast('Placed prop') }
    }
    let _lastBaseItems = []
    // Composes recent-section + filtered base items into the final ContextMenu item list, and
    // tracks the flat selectable subset (_flatItems) for arrow-key navigation. The search INPUT
    // itself is a real DOM node positioned above the menu (see repaint), not a ContextMenu item --
    // the kit's ContextMenu item shape ({label, onSelect, disabled}) has no documented custom-render
    // hook, so composing a fabricated one would be unverified API surface.
    function _composeMenuItems(baseItems) {
      const recentItems = (!_query && _recent.length)
        ? [{ label: '★ Recent', disabled: true }, ...
            _recent.map(r => ({ label: r.label, onSelect: () => r.kind === 'primitive' ? place(r.value) : placeModel(r.value, r.label) }))]
        : []
      const filteredBase = filterMenuItems(baseItems, _query)
      const selectable = [...recentItems.filter(it => !it.disabled), ...filteredBase.filter(it => !it.disabled)]
      _flatItems = selectable
      const highlighted = _highlight >= 0 && _highlight < selectable.length ? selectable[_highlight] : null
      const tag = (it) => it === highlighted ? { ...it, label: '▸ ' + it.label } : it
      return [...recentItems.map(tag), ...(recentItems.length && filteredBase.length ? [{ label: '───', disabled: true }] : []), ...filteredBase.map(tag)]
    }
    // Deferred to a macrotask: re-rendering this host synchronously from onSelect races the kit's outside-click-close listener.
    const repaint = (baseItems) => setTimeout(() => {
      if (!host.isConnected) return
      _lastBaseItems = baseItems
      const rendered = _composeMenuItems(baseItems)
      applyDiff(host, [C.ContextMenu({ anchor: { x, y: y + 28 }, onClose: close, items: rendered })])
      _ensureSearchBox()
      _decorateThumbnails(rendered)
    }, 0)
    // editor-place-menu-thumbnails: ContextMenu (anentrypoint-design, CDN-loaded, minified bundle)
    // exposes no documented per-item icon/custom-render hook -- its item contract is strictly
    // {label, onSelect, disabled} (see the _composeMenuItems comment above, verified against the
    // live kit bundle: no icon/thumb/image field referenced anywhere in dist/247420.js's ContextMenu
    // renderer). Rather than fabricate an unverified API surface on a black-box component, this
    // decorates the ALREADY-RENDERED DOM rows after applyDiff, the same sidecar-DOM pattern already
    // used for the search box above. Matches rows to their source item by exact label text (labels
    // are unique per repaint: model names, or the '< Back' row which never carries a thumb).
    function _decorateThumbnails(items) {
      const byLabel = new Map()
      for (const it of items) if (it._thumb) byLabel.set(it.label.replace(/^▸ /, ''), it._thumb)
      if (!byLabel.size) return
      const rows = host.querySelectorAll('[role="menuitem"], .ds-cm-item, li, button')
      rows.forEach(row => {
        const text = (row.textContent || '').trim().replace(/^▸ /, '')
        const thumbUrl = byLabel.get(text)
        if (!thumbUrl || row.querySelector('.ds-ep-add-thumb')) return
        const img = document.createElement('img')
        img.className = 'ds-ep-add-thumb'
        img.src = thumbUrl
        img.alt = ''
        img.style.cssText = 'width:20px;height:20px;object-fit:cover;border-radius:2px;margin-right:6px;vertical-align:middle;background:rgba(255,255,255,0.06)'
        // Graceful fallback: a 404/broken thumb (e.g. CI ktx-fallback gap, see AGENTS.md
        // sillos-scramble-hypothesis-disproven for a precedent of benign asset-pipeline gaps)
        // just removes the broken image rather than showing a broken-image glyph.
        img.addEventListener('error', () => img.remove(), { once: true })
        row.insertBefore(img, row.firstChild)
      })
    }
    // The filter input lives outside applyDiff's managed subtree (a sibling appended once, moved/
    // refocused on each repaint) so typing never gets clobbered by the ContextMenu's own re-render.
    function _ensureSearchBox() {
      if (_searchBox && _searchBox.isConnected) { _searchBox.style.left = x + 'px'; _searchBox.style.top = y + 'px'; return }
      _searchBox = document.createElement('input')
      _searchBox.type = 'text'
      _searchBox.placeholder = 'Filter...'
      _searchBox.value = _query
      _searchBox.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:220px;box-sizing:border-box;z-index:9200;font:12px var(--ff-mono,monospace);padding:4px 6px;background:var(--panel-2,#1a1a1a);color:var(--panel-text,#eee);border:1px solid var(--rule,#444);border-radius:4px`
      _searchBox.addEventListener('input', () => { _query = _searchBox.value; _highlight = -1; repaint(_lastBaseItems) })
      // Keep this input from stealing focus back after arrow/enter navigation clicks a menu row.
      _searchBox.addEventListener('keydown', (e) => { if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) e.preventDefault() })
      document.body.appendChild(_searchBox)
      setTimeout(() => { if (_searchBox && _searchBox.isConnected) _searchBox.focus() }, 0)
    }
    const openPropSubmenu = () => {
      _query = ''; _highlight = -1
      repaint([{ label: 'Loading catalog...', disabled: true }])
      buildPropCategoryItems((cat, models) => {
        repaint(buildCategoryMenuItems(models, (url) => {
          const m = models.find(mm => ASSET_HOST + mm.path === url)
          placeModel(url, m ? m.name : url)
        }, openPropSubmenu))
      }).then(items => { if (host.isConnected) repaint(items) })
    }
    // Arrow-key nav (up/down move _highlight through the flat selectable list), Enter places
    // the highlighted row, Escape closes. Capture phase so it runs before the kit's own
    // outside-click/keydown handling; only active while this menu's host is connected.
    _keyHandler = (e) => {
      if (!host.isConnected) return
      if (e.key === 'ArrowDown') { e.preventDefault(); _highlight = Math.min(_highlight + 1, _flatItems.length - 1); repaint(_lastBaseItems) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); _highlight = Math.max(_highlight - 1, 0); repaint(_lastBaseItems) }
      else if (e.key === 'Enter') { e.preventDefault(); const it = _flatItems[_highlight]; if (it && it.onSelect) it.onSelect() }
      else if (e.key === 'Escape') { e.preventDefault(); close() }
    }
    document.addEventListener('keydown', _keyHandler, true)
    repaint(buildAddMenuItems(place, openPropSubmenu, scatterState))
  }

  return {
    layers,
    show() { overlay.style.display = 'block'; wmRoot.style.display = 'block' },
    hide() { overlay.style.display = 'none'; wmRoot.style.display = 'none'; evLog.stop(); _renderGraphViewer?.stop(); _p2pPanel?.destroy(); _freddieChatPanel?.clear(); if (_vpMenuHost) applyDiff(_vpMenuHost, []) },
    openViewportMenu: openAddMenu,
    toggle() { const v = overlay.style.display === 'none' ? 'block' : 'none'; overlay.style.display = v; wmRoot.style.display = v },
    updateApps(apps) { appsPanel.setApps(apps); _knownApps = apps || []; _validatorPanel?.updateKnownApps(_knownApps); hfViewer.updateApps(_knownApps); eventChainPanel?.updateEntitiesAndApps(_entities, _knownApps) },
    updateScene(entities) { _entities = entities || []; setSceneEntityIds(_entities.map(e => e.id)); hierarchy.updateEntities(entities); layers.hydrateFromEntities(_entities); hfViewer.updateGraph(_entities); _validatorPanel?.updateEntities(_entities); _waypointPanel?.updateEntities(_entities); eventChainPanel?.updateEntitiesAndApps(_entities, _knownApps); render() },
    // extraEntities (editor-undo-transactionality-multiselect-batch-inspector): the REAL field data
    // (position/rotation/scale/custom/_appName) for every extra-selected entity, not just their bare
    // ids -- the batch inspector needs it to compute shared-vs-mixed values across the selection.
    // Optional/back-compat: any call site still passing only 3 args gets extraIds with no data,
    // and the inspector's multi-select view degrades to delta-only bulk-edit (its pre-existing shape).
    showEntity(entity, eProps, extraIds, extraEntities) {
      inspector.showEntity(entity, eProps, extraIds, extraEntities); hierarchy.setSelected(entity?.id || null); _waypointPanel?.setSelected(entity?.id || null)
      overlay.classList.toggle('has-selection', !!entity)
      if (entity) { const w = wm.getWindow('inspector'); if (w) { w.setMinimized(false); wm.focus('inspector') } }
      _statusLeft = entity ? (extraIds && extraIds.length ? (1 + extraIds.length) + ' entities selected' : 'sel: ' + entity.id) : 'Ready'; render()
    },
    setStatus(msg) { _statusLeft = msg || 'Ready'; render() },
    setCamCoords(x, y, z) {
      _camCoords = `cam ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`
      const el = overlay.querySelector('.ds-ep-cam-coords')
      if (el) el.textContent = _camCoords
    },
    // Direct-DOM-write like setCamCoords (no render()) so a ~1Hz fps update doesn't diff-thrash the whole status bar.
    setFps(fps) {
      _fps = fps | 0
      const el = overlay.querySelector('.ds-ep-info-fps')
      if (el) el.textContent = `${_fps} fps`
    },
    toast(msg, kind) { showToast(msg, kind) },
    setGizmoMode(mode) { if (mode && mode !== _gizmoMode) { _gizmoMode = mode; render() } },
    setGizmoSpace(space) { const v = space === 'local' ? 'local' : 'world'; if (v !== _gizmoSpace) { _gizmoSpace = v; render() } },
    get gizmoSpace() { return _gizmoSpace },
    setPivotMode(mode) { const v = ['active', 'centroid', 'individual'].includes(mode) ? mode : 'active'; if (v !== _pivotMode) { _pivotMode = v; render() } },
    get pivotMode() { return _pivotMode },
    toggleSnap() { _snapOn = !_snapOn; onSnapChange?.(_snapOn, _snapSz); render() },
    setDirty(v) { if (_dirty !== !!v) { _dirty = !!v; render() } },
    get dirty() { return _dirty },
    get snapOn() { return _snapOn },
    updateAppFiles(name, files) { appsPanel.setAppFiles(name, files) },
    openCode(app, file, code) { appsPanel.openCode(app, file, code); _switchTab('Apps') },
    // FS Browse window bundle -- all no-ops until the window has been opened at least once
    // (panel created lazily by _ensureFsBrowsePanel), matching the RenderGraph zero-cost-until-open shape.
    updateFsTree(tree, error) { _fsBrowsePanel?.setTree(tree, error) },
    setFsSource(path, source, mtimeMs, binary, conflict, diskSource, error) { _fsBrowsePanel?.setSource(path, source, mtimeMs, binary, conflict, diskSource, error) },
    onFsOpResult(op, ok, error) { _fsBrowsePanel?.onOpResult(op, ok, error) },
    onFsTreeChanged() { _fsBrowsePanel?.onTreeChanged() },
    onEditorChange(fn) { _onChange = fn },
    onTabChange(fn) { _onTabChange = fn },
    // "?" keydown handler (app.js) toggles this: opens the shortcuts window if closed, closes it if
    // already open -- same list the toolbar "Shortcuts"/"Bookmarks" buttons open, single source (EDITOR_SHORTCUTS).
    toggleShortcutsHelp() { const w = wm.getWindow('shortcuts'); if (w) wm.close('shortcuts'); else openShortcutsWindow() },
    updateEventLog(events) { evLog.updateEvents(events); hfViewer.updateEvents(events) },
    // Named-transaction history (editor-undo-transactionality-multiselect-batch-inspector): pushed by
    // app.js's editHistory.onChange with EditHistory.list()'s live array. Cheap when the window is
    // closed (just caches the array + refreshes the toolbar button's count via render()); repaints the
    // window body directly only when it's actually open, matching setFps's direct-write-no-full-render
    // shape for the common (window closed) case while staying live for the common (window open) case too.
    updateHistory(entries) { _historyEntries = entries || []; if (_historyHost && wm.getWindow('history')) _renderHistoryBody(_historyHost); render() },
    get visible() { return overlay.style.display !== 'none' },
    get selectedEntity() { return inspector.selectedEntity },
    get currentTab() { return _tab },
    // Client-side-only lock/hidden-in-editor state, read by app.js (pick-gating passthrough + editor-overlay
    // visibility override) without app.js needing to reach into SceneHierarchy directly.
    isLocked(id) { return hierarchy.isLocked(id) },
    isHiddenInEditor(id) { return hierarchy.isHiddenInEditor(id) },
    get hiddenInEditorIds() { return hierarchy.hiddenInEditorIds },
    get playtesting() { return _playtesting },
    setPlaytesting(v) { _playtesting = !!v; render() },
    get debugMode() { return _debugMode },
    setDebugMode(v) { _debugMode = v || 'none'; render() },
    inspectorAppMount: insp.appMount,
    inspectorKitMount,
    appsAppMount: appsTab.appMount, eventsAppMount: evTab.appMount, hierarchyAppMount: hierAppMount,
    get wm() { return wm }
  }
}
