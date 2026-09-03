import { components as C, h, applyDiff } from 'anentrypoint-design'
import { showToast, showConfirm } from './EditPanelDOM.js'
import { getSharedWM, promptText, SearchInput, EmptyState } from './wm/ui.js'

let _menuHost = null
function _ensureMenuHost() {
  if (_menuHost && _menuHost.isConnected) return _menuHost
  _menuHost = document.createElement('div')
  _menuHost.className = 'ds-247420'
  document.body.appendChild(_menuHost)
  return _menuHost
}
function closeContextMenu() { if (_menuHost) applyDiff(_menuHost, []) }
function openContextMenu(x, y, items) {
  const host = _ensureMenuHost()
  applyDiff(host, [
    C.ContextMenu({
      anchor: { x, y },
      onClose: closeContextMenu,
      items: items.map(it => it.separator ? { separator: true } : {
        label: it.label,
        danger: it.danger,
        onSelect: () => { try { it.onSelect() } catch (e) { showToast('Action failed: ' + e.message, 'error') } }
      })
    })
  ])
}

function attachContextMenu(el, getItems) {
  return C.useContextMenu(el, null, ({ x, y }) => openContextMenu(x, y, getItems()))
}

// Shared node classification, reused by both the tree-row icon glyph and the search `type:` scope filter.
function classifyNode(node) {
  if (node.model) return 'model'
  if (node.custom && node.custom.mesh) return 'primitive'
  if (node._appName || node.appName) return 'app'
  return 'other'
}
const _typeGlyph = { model: 'M', primitive: 'P', app: 'A', other: 'o' }

function nodeMatchesQuery(node, q) {
  const id = (node.id || '').toLowerCase(), app = (node._appName || node.appName || node.label || '').toLowerCase()
  let typeFilter = null
  const m = /^type:(\w+)\s*/.exec(q)
  if (m) { typeFilter = m[1]; q = q.slice(m[0].length) }
  if (typeFilter && classifyNode(node) !== typeFilter) return false
  if (!q) return true
  return id.includes(q) || app.includes(q)
}
function subtreeMatchesQuery(node, q) {
  if (!q) return true
  if (nodeMatchesQuery(node, q)) return true
  return (node.children || []).some(child => subtreeMatchesQuery(child, q))
}
function flattenTree(nodes, depth, q, seen, expanded, out) {
  for (const node of nodes || []) {
    if (q && !subtreeMatchesQuery(node, q)) continue
    if (!seen.has(node.id)) { seen.add(node.id); expanded.add(node.id) }
    const kids = node.children || []
    const hasKids = kids.length > 0
    const isExpanded = q ? true : expanded.has(node.id)
    out.push({ node, depth, hasKids, expanded: isExpanded })
    if (hasKids && isExpanded) flattenTree(kids, depth + 1, q, seen, expanded, out)
  }
  return out
}

// Drop an id from a batch drag if it is an ancestor of another id in the same batch -- reparenting an ancestor
// under its own descendant target (or moving it while the descendant also moves) is structurally impossible.
function isAncestorOf(parentOf, candidateId, descendantId) {
  let p = parentOf.get(descendantId)
  while (p != null) { if (p === candidateId) return true; p = parentOf.get(p) }
  return false
}
function dedupeNonAncestors(parentOf, ids) {
  if (ids.length < 2) return ids
  return ids.filter(id => !ids.some(other => other !== id && isAncestorOf(parentOf, id, other)))
}

function indexParents(nodes, parentId, parentOf) {
  for (const n of nodes || []) { parentOf.set(n.id, parentId); indexParents(n.children, n.id, parentOf) }
}

// Above VIRTUALIZE_THRESHOLD, only viewport+overscan rows render as real TreeItems; the rest become 2 sized spacer divs.
function sliceVirtualWindow(rows, scrollTop, viewportH, rowHeight, overscan) {
  const visibleCount = Math.max(1, Math.ceil((viewportH || 400) / rowHeight))
  const startIdx = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const endIdx = Math.min(rows.length, startIdx + visibleCount + overscan * 2)
  return {
    spacerTop: startIdx * rowHeight,
    spacerBottom: (rows.length - endIdx) * rowHeight,
    renderedRows: rows.slice(startIdx, endIdx)
  }
}

export function createSceneHierarchy(container, { onSelect, onFocus, onDelete, onDuplicate, onRename, onReparent, onLockChange, onHiddenChange, onSaveSelectionAsPrefab } = {}) {
  let _ents = [], _q = '', _sel = null
  const _expanded = new Set()
  const _seen = new Set()
  // Extra ids ctrl/shift-clicked alongside the single primary _sel; when non-empty, Delete/Duplicate act on the full set.
  const _multiSel = new Set()
  // Client-side-only (not persisted, not sent to server): entities locked against viewport gizmo-pick/drag,
  // and entities hidden from the editor's own view (independent of gameplay visibility). Both remain toggleable
  // and the entity remains selectable directly from this hierarchy panel regardless of either flag.
  const _locked = new Set()
  const _hiddenInEditor = new Set()

  container.classList.add('ds-ep-panel')
  container.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0'

  const _menuTeardowns = []
  function clearItemMenus() { while (_menuTeardowns.length) { try { _menuTeardowns.pop()() } catch (_) {} } }

  function promptRename(id) {
    const wm = getSharedWM()
    if (!wm) return Promise.resolve(null)
    return promptText(wm, { title: 'Rename entity', label: 'Name', initial: id, confirmLabel: 'Rename' })
  }

  function _bulkIds(node) {
    const all = new Set(_multiSel); if (_sel) all.add(_sel)
    return all.has(node.id) && all.size > 1 ? [...all] : [node.id]
  }

  function nodeMenuItems(node) {
    const hasParent = !!_parentOf.get(node.id)
    const ids = _bulkIds(node)
    const many = ids.length > 1
    const isLocked = _locked.has(node.id)
    const isHidden = _hiddenInEditor.has(node.id)
    return [
      { label: 'Focus', disabled: many, onSelect: () => onFocus?.(node.id) },
      { label: 'Rename', disabled: many, onSelect: async () => {
          const next = await promptRename(node.id)
          if (next && next !== node.id) { onRename?.(node.id, next); showToast('Renamed to ' + next) }
        } },
      { label: many ? `Duplicate (${ids.length})` : 'Duplicate', onSelect: () => { ids.forEach(id => onDuplicate?.(id)); showToast(many ? `Duplicated ${ids.length} entities` : 'Duplicated ' + node.id) } },
      ...(onReparent ? [{ label: 'Unparent', disabled: many || !hasParent, onSelect: () => { if (hasParent) { onReparent(node.id, null); showToast('Unparented ' + node.id) } } }] : []),
      { separator: true },
      { label: many ? (isLocked ? `Unlock (${ids.length})` : `Lock (${ids.length})`) : (isLocked ? 'Unlock' : 'Lock'), onSelect: () => {
          const next = !isLocked
          ids.forEach(id => { if (next) _locked.add(id); else _locked.delete(id) })
          onLockChange?.([..._locked])
          showToast((next ? 'Locked ' : 'Unlocked ') + (many ? ids.length + ' entities' : node.id))
          render()
        } },
      { label: many ? (isHidden ? `Show in editor (${ids.length})` : `Hide in editor (${ids.length})`) : (isHidden ? 'Show in editor' : 'Hide in editor'), onSelect: () => {
          const next = !isHidden
          ids.forEach(id => { if (next) _hiddenInEditor.add(id); else _hiddenInEditor.delete(id) })
          onHiddenChange?.([..._hiddenInEditor])
          showToast((next ? 'Hidden ' : 'Shown ') + (many ? ids.length + ' entities' : node.id))
          render()
        } },
      { separator: true },
      ...(onSaveSelectionAsPrefab ? [{ label: many ? `Save as Prefab (${ids.length})` : 'Save as Prefab', onSelect: async () => {
          const prefabName = await promptText(getSharedWM(), { title: 'Save as Prefab', label: 'Prefab name', placeholder: 'prefab-name', confirmLabel: 'Save', validate: (raw) => {
            const name = raw.toLowerCase()
            if (!name) return { ok: false, error: 'Prefab name required' }
            if (!/^[a-z0-9-]+$/.test(name)) return { ok: false, error: 'Use lowercase letters, digits, and hyphens only' }
            return { ok: true, value: name }
          } })
          if (prefabName) { onSaveSelectionAsPrefab?.(ids, prefabName); showToast('Saved prefab: ' + prefabName) }
        } }] : []),
      { separator: true },
      { label: many ? `Delete (${ids.length})` : 'Delete', danger: true, onSelect: async () => {
          const ok = await showConfirm({ title: many ? `Delete ${ids.length} entities` : 'Delete entity', message: many ? `Permanently delete ${ids.length} selected entities?` : 'Permanently delete ' + node.id + '?', confirmLabel: 'Delete', destructive: true })
          if (ok) { ids.forEach(id => onDelete?.(id)); _multiSel.clear(); showToast(many ? `Deleted ${ids.length} entities` : 'Deleted ' + node.id) }
        } }
    ]
  }

  function attachRowKebab(el, node) {
    if (el.querySelector('[data-kebab]')) return
    const kebab = document.createElement('button')
    kebab.setAttribute('data-kebab', '')
    kebab.textContent = '...'
    kebab.title = 'More actions'
    kebab.style.cssText = 'position:absolute;right:4px;top:50%;transform:translateY(-50%);background:transparent;border:none;color:rgba(255,255,255,0.4);cursor:pointer;font:11px monospace;padding:2px 6px;opacity:0;transition:opacity 0.1s'
    kebab.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation()
      const rect = kebab.getBoundingClientRect()
      openContextMenu(rect.left, rect.bottom, nodeMenuItems(node))
    })
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
    el.appendChild(kebab)
    el.addEventListener('mouseenter', () => { kebab.style.opacity = '1' })
    el.addEventListener('mouseleave', () => { kebab.style.opacity = '0' })
  }

  // Top/bottom third of a row = sibling-of-target reparent; middle third = child. children is an
  // unordered Set server-side, so this only picks the parent, not sibling order.
  function attachRowDragDrop(el, node, id) {
    // If this row is part of the current multi-selection, drag the whole set as one batch; otherwise single-id drag (existing behavior).
    const _dragIds = _bulkIds(node)
    const drag = C.useDraggable(el, { data: _dragIds.length > 1 ? { id, ids: _dragIds } : { id }, kind: 'scene-node' })
    let _indicator = null
    const _clearIndicator = () => { if (_indicator) { _indicator.remove(); _indicator = null } }
    const _showIndicator = (edge) => {
      _clearIndicator()
      _indicator = document.createElement('div')
      _indicator.className = 'ds-ep-tree-drop-indicator'
      _indicator.style.cssText = `position:absolute;left:0;right:0;height:2px;background:var(--accent,#4af);pointer-events:none;z-index:10;${edge === 'top' ? 'top:-1px' : 'bottom:-1px'}`
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
      el.appendChild(_indicator)
    }
    const drop = C.useDropTarget(el, {
      accepts: ['scene-node'],
      onDragOver: (payload) => {
        const clientY = payload?.pointerEvent?.clientY
        if (clientY == null) { _clearIndicator(); return }
        const r = el.getBoundingClientRect()
        const frac = (clientY - r.top) / r.height
        if (frac < 0.25) _showIndicator('top')
        else if (frac > 0.75) _showIndicator('bottom')
        else _clearIndicator()
      },
      onDragLeave: _clearIndicator,
      onDrop: ({ data, pointerEvent }) => {
        _clearIndicator()
        if (!data?.id) return
        const dragIds = dedupeNonAncestors(_parentOf, data.ids && data.ids.length > 1 ? data.ids : [data.id])
        if (dragIds.includes(id)) return
        const r = el.getBoundingClientRect()
        const frac = pointerEvent ? (pointerEvent.clientY - r.top) / r.height : 0.5
        if (frac < 0.25 || frac > 0.75) {
          const siblingParent = _parentOf.get(id) || null
          dragIds.forEach(dragId => onReparent(dragId, siblingParent))
          showToast((dragIds.length > 1 ? `Moved ${dragIds.length} entities` : 'Moved ' + dragIds[0]) + ' to ' + (siblingParent ? 'be a sibling of ' + id : 'root'))
        } else {
          dragIds.forEach(dragId => onReparent(dragId, id))
          showToast((dragIds.length > 1 ? `Reparented ${dragIds.length} entities` : 'Reparented ' + dragIds[0]) + ' -> ' + id)
        }
      }
    })
    _menuTeardowns.push(() => { drag.destroy(); drop.destroy(); _clearIndicator() })
  }

  function attachRowBehaviors(rows) {
    clearItemMenus()
    const els = container.querySelectorAll('.ds-ep-tree-item[data-eid]')
    els.forEach((el) => {
      const id = el.getAttribute('data-eid')
      const row = rows.find(r => r.node.id === id); if (!row) return
      const node = row.node
      el.style.outline = _multiSel.has(id) ? '1px solid rgba(120,170,255,0.5)' : ''
      // Guard: applyDiff may reuse the same DOM node across renders, so manual (non-vdom) listeners must attach only once or they accumulate.
      if (!el._dsRowBehaviorsBound) {
        el._dsRowBehaviorsBound = true
        el.addEventListener('dblclick', el._dsOnDblClick = () => onFocus?.(id))
        // mousedown multi-select is now handled by the capture-phase delegate on the container
        // (immune to vdom node replacement between mousedown and click).
      }
      _menuTeardowns.push(attachContextMenu(el, () => nodeMenuItems(node)))
      attachRowKebab(el, node)
      if (onReparent && typeof C.useDraggable === 'function') attachRowDragDrop(el, node, id)
    })
  }

  // Above VIRTUALIZE_THRESHOLD, only viewport+overscan rows render as real TreeItems; the rest become 2 sized spacer divs.
  const VIRTUALIZE_THRESHOLD = 60
  const ROW_HEIGHT = 28   // must match kit TreeItem's rendered row height
  const OVERSCAN = 8
  let _scrollTop = 0, _viewportH = 0

  function _rowEl(row) {
    const { node, depth, hasKids, expanded } = row
    const _label = node.label || node._appName || node.appName || node.id
    const _appTag = node._appName || node.appName || ''
    const _glyph = node.light ? 'L' : _typeGlyph[classifyNode(node)]
    const _flags = (_locked.has(node.id) ? ' 🔒' : '') + (_hiddenInEditor.has(node.id) ? ' 👁‍🗨' : '')
    return C.TreeItem({
      label: '[' + _glyph + '] ' + _label + _flags,
      tag: _appTag && _appTag !== _label ? _appTag : '',
      selected: node.id === _sel,
      depth, expanded, hasChildren: hasKids,
      // No-op during search: subtrees render force-expanded then, so toggling would silently corrupt _expanded for after the search clears.
      onToggle: () => { if (_q) return; if (_expanded.has(node.id)) _expanded.delete(node.id); else _expanded.add(node.id); render() },
      onSelect: () => { _sel = node.id; onSelect?.(node.id); render() }
    })
  }

  function bindPanelBodyRef(el, virtualized) {
    if (!el) return
    _viewportH = el.clientHeight
    if (virtualized && !el._dsScrollListener) {
      el._dsScrollListener = true
      el.addEventListener('scroll', () => { _scrollTop = el.scrollTop; _viewportH = el.clientHeight; render() }, { passive: true })
    }
    if (el._dsRootDrop || !onReparent || typeof C.useDropTarget !== 'function') return
    el._dsRootDrop = true
    const d = C.useDropTarget(el, { accepts: ['scene-node'], onDrop: ({ data }) => {
      if (!data?.id) return
      const dragIds = dedupeNonAncestors(_parentOf, data.ids && data.ids.length > 1 ? data.ids : [data.id]).filter(id => _parentOf.get(id))
      if (!dragIds.length) return
      dragIds.forEach(id => onReparent(id, null))
      showToast(dragIds.length > 1 ? `Unparented ${dragIds.length} entities` : 'Unparented ' + dragIds[0])
    } })
    el._dsRootDropDestroy = d.destroy
  }

  let _lastRows = []
  function render() {
    const rows = flattenTree(_ents, 0, _q, _seen, _expanded, [])
    _lastRows = rows

    const virtualized = rows.length > VIRTUALIZE_THRESHOLD
    let treeChildren, spacerTop = 0, spacerBottom = 0, renderedRows = rows
    if (virtualized) {
      ;({ spacerTop, spacerBottom, renderedRows } = sliceVirtualWindow(rows, _scrollTop, _viewportH, ROW_HEIGHT, OVERSCAN))
      treeChildren = renderedRows.map(_rowEl)
    } else {
      treeChildren = rows.map(_rowEl)
    }

    const body = rows.length === 0
      ? h('div', { class: 'ds-ep-panel-body', style: 'display:flex;align-items:center;justify-content:center;text-align:center' },
          EmptyState({ text: _ents.length ? 'No match' : 'No entities -- right-click the viewport or use Create to place one' }))
      : h('div', {
          class: 'ds-ep-panel-body flush', style: 'flex:1;min-height:0;overflow-y:auto',
          // Drop onto the panel background (not a row) = unparent to root.
          ref: (el) => bindPanelBodyRef(el, virtualized)
        },
          virtualized
            ? h('div', null,
                h('div', { style: `height:${spacerTop}px;flex:0 0 auto` }),
                C.TreeView({ children: treeChildren }),
                h('div', { style: `height:${spacerBottom}px;flex:0 0 auto` }))
            : C.TreeView({ children: treeChildren })
        )

    applyDiff(container, [
      h('div', { class: 'ds-ep-panel-body', style: 'flex:0 0 auto;overflow:visible' },
        SearchInput({ value: _q, placeholder: 'Search scene objects', onInput: (v) => { _q = (v || '').toLowerCase(); render() } })
      ),
      body
    ])

    // Tag rows with entity id so behaviors re-bind after diff; aligned against renderedRows, not full rows, when virtualized.
    const treeEls = container.querySelectorAll('.ds-ep-tree-item')
    treeEls.forEach((el, i) => { if (renderedRows[i]) el.setAttribute('data-eid', renderedRows[i].node.id) })
    if (renderedRows.length) attachRowBehaviors(renderedRows)
  }

  const _parentOf = new Map()

  container.tabIndex = 0

  // Capture-phase delegated multi-select handler, immune to vdom node replacement between
  // mousedown and mouseup (applyDiff re-renders the entire tree, which can swap the DOM node
  // under an in-progress pointer interaction -- see the row
  // scene-hierarchy-click-races-vdom-rerender-lost-click). The capture phase fires on the
  // STABLE container before the event reaches any individual row element, so the data-eid
  // lookup always succeeds regardless of whether the row was re-rendered mid-click.
  function onContainerMouseDown(e) {
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
      if (_multiSel.size) { _multiSel.clear(); render() }
      return
    }
    const item = e.target.closest('.ds-ep-tree-item[data-eid]')
    if (!item) return
    const id = item.getAttribute('data-eid')
    if (_multiSel.has(id)) _multiSel.delete(id); else _multiSel.add(id)
    render()
  }

  function onContainerClick(e) {
    const item = e.target.closest('.ds-ep-tree-item[data-eid]')
    if (!item) return
    const id = item.getAttribute('data-eid')
    // Don't handle clicks on the kebab button, expand/collapse toggles, or other controls
    // inside the tree item -- those have their own handlers.
    if (e.target.closest('[data-kebab], .ds-ep-tree-toggle')) return
    _sel = id
    onSelect?.(id)
    render()
  }

  function onContainerKeyDown(e) {
    if (!_lastRows.length) return
    const idx = _sel ? _lastRows.findIndex(r => r.node.id === _sel) : -1
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = _lastRows[Math.min(_lastRows.length - 1, idx + 1)]
      if (next) { _sel = next.node.id; onSelect?.(_sel); render() }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const prev = _lastRows[Math.max(0, idx - 1)]
      if (prev) { _sel = prev.node.id; onSelect?.(_sel); render() }
    } else if (e.key === 'ArrowRight') {
      if (idx < 0) return
      e.preventDefault()
      const row = _lastRows[idx]
      if (row.hasKids && !_expanded.has(row.node.id)) { _expanded.add(row.node.id); render() }
    } else if (e.key === 'ArrowLeft') {
      if (idx < 0) return
      e.preventDefault()
      const row = _lastRows[idx]
      if (row.hasKids && _expanded.has(row.node.id)) { _expanded.delete(row.node.id); render() }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (idx < 0 || !onDelete) return
      e.preventDefault()
      const id = _lastRows[idx].node.id
      showConfirm({ title: 'Delete entity', message: 'Permanently delete ' + id + '?', confirmLabel: 'Delete', destructive: true }).then(ok => {
        if (ok) { onDelete(id); showToast('Deleted ' + id) }
      })
    }
  }

  container.addEventListener('mousedown', onContainerMouseDown, true)
  container.addEventListener('click', onContainerClick, true)
  container.addEventListener('keydown', onContainerKeyDown)

  render()
  return {
    updateEntities(ents) { _ents = ents || []; _parentOf.clear(); indexParents(_ents, null, _parentOf); render() },
    setSelected(id) { _sel = id; render() },
    get selectedId() { return _sel },
    // Client-side-only lock/hidden-in-editor sets, read by editor.js (pick-gating) and app.js (editor-overlay
    // visibility override). Never sent to the server, never persisted -- purely a local composing convenience.
    isLocked(id) { return _locked.has(id) },
    isHiddenInEditor(id) { return _hiddenInEditor.has(id) },
    get lockedIds() { return [..._locked] },
    get hiddenInEditorIds() { return [..._hiddenInEditor] },
    // editor-layers-panel: direct programmatic set (not toggle) for LayerRegistry's cascading
    // layer-wide visibility/lock apply -- the existing context-menu toggle methods above only flip
    // relative to current per-entity state, which isn't what a layer-wide "make every member locked"
    // operation needs (a member already locked individually shouldn't unlock on a layer-lock call).
    setLocked(id, v) { if (v) _locked.add(id); else _locked.delete(id); onLockChange?.([..._locked]); render() },
    setHiddenInEditor(id, v) { if (v) _hiddenInEditor.add(id); else _hiddenInEditor.delete(id); onHiddenChange?.([..._hiddenInEditor]); render() },
    // Dense status-bar feed: 0 when nothing selected, 1 for a single selection, N when multi-selected.
    get selectionCount() {
      if (!_multiSel.size) return _sel ? 1 : 0
      const all = new Set(_multiSel); if (_sel) all.add(_sel)
      return all.size
    },
    get selectedIds() {
      if (!_multiSel.size && !_sel) return []
      const all = new Set(_multiSel); if (_sel) all.add(_sel)
      return [...all]
    }
  }
}
