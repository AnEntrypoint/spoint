import { components as C, h, applyDiff } from 'anentrypoint-design'
import { getSharedWM, promptText, Btn, Toolbar, SearchInput } from './wm/ui.js'
import { renderEditorPane } from './EditPanelEditor.js'
import { showToast } from './EditPanelDOM.js'
import { createPrefabPanel } from './PrefabPanel.js'

function _makeAppDraggable(el, appName) {
  if (!el || el._dsAppDrag || typeof C.useDraggable !== 'function') return
  el._dsAppDrag = true
  const handle = C.useDraggable(el, { data: { appName }, kind: 'place-app' })
  el._dsAppDragDestroy = handle.destroy
}

export function getAppCategory(app) {
  const name = (typeof app === 'string' ? app : app?.name || '').toLowerCase()
  if (name.startsWith('agent-') || name.startsWith('fsm-') || name === 'goblin' || name.startsWith('npc') || name === 'combat-bot') {
    return 'Agents & FSM'
  }
  if (name.includes('spawner') || name.startsWith('spawn-') || name.startsWith('item-') || name === 'pickup' || name === 'collectible' || name === 'gold-coin' || name === 'weapon-spawn') {
    return 'Spawners & Items'
  }
  if (name.startsWith('editor-events') || name.startsWith('trigger-') || name.startsWith('checkpoint-') || name.startsWith('respawn-') || name.startsWith('capture-') || name.startsWith('shrinking-') || name === 'waypoint') {
    return 'Zones & Triggers'
  }
  if (name.startsWith('editor-')) {
    return 'Editor Tools'
  }
  if (name.startsWith('box-') || name.startsWith('prop-') || name === 'placed-model' || name === 'tower' || name.startsWith('destructible-') || name === 'moving-platform' || name.startsWith('fluid') || name.startsWith('softbody-')) {
    return 'Physics & Props'
  }
  if (name === 'tps-game' || name.startsWith('rpg-') || name.startsWith('tutorial') || name === 'deathrun' || name.startsWith('matrix-') || name === 'ecs-demo' || name === 'example-progression') {
    return 'Demos & Games'
  }
  return 'General'
}

const CATEGORY_ORDER = ['Agents & FSM', 'Spawners & Items', 'Zones & Triggers', 'Physics & Props', 'Demos & Games', 'Editor Tools', 'General']

function promptNewAppName(existing = []) {
  const wm = getSharedWM()
  if (!wm) return Promise.resolve(null)
  return promptText(wm, {
    title: 'New app', label: 'App name', placeholder: 'app-name', confirmLabel: 'Create',
    validate: (raw) => {
      const name = raw.toLowerCase()
      if (!name) return { ok: false, error: 'App name required' }
      if (!/^[a-z0-9-]+$/.test(name)) return { ok: false, error: 'Use lowercase letters, digits, and hyphens only' }
      if (existing.includes(name)) return { ok: false, error: 'App "' + name + '" already exists' }
      return { ok: true, value: name }
    }
  })
}

export function createEditorApps(container, { onPlace, onSave, onGetSource, onGetAppFiles, onCreateApp, onSavePrefab, onInstantiatePrefab, onGetPrefabs, getSelectedEntities } = {}) {
  let _apps = [], _filt = '', _expApp = null, _appFiles = {}, _curApp = null, _curFile = null, _pendingCode = null
  let _prefabPanel = null, _showPrefabs = false
  let _collapsedCategories = new Set()

  container.classList.add('ds-ep-panel')

  // App list built imperatively, not via webjsx diff: the reconciler drops a tree-item's 2nd (file-list) child on re-render.
  let _toolbarHost = null, _listHost = null
  function _ensureHosts() {
    if (_toolbarHost && _toolbarHost.isConnected) return
    container.innerHTML = ''
    _toolbarHost = document.createElement('div')
    _listHost = document.createElement('div')
    _listHost.className = 'ds-ep-tree'
    _listHost.style.cssText = 'flex:1;min-height:0;overflow-y:auto'
    container.append(_toolbarHost, _listHost)
    // Container starts detached; repaint toolbar on every host recreation or it gets silently dropped.
    renderToolbar()
  }

  function renderToolbar() {
    const mkSearch = () => SearchInput({ value: _filt, placeholder: 'Filter apps...', onInput: v => { _filt = (v||'').toLowerCase(); renderList() } })
    const mkNew = () => Btn({ primary: true, dense: true, onClick: async (e) => {
      e.preventDefault()
      const n = await promptNewAppName(_apps.map(a => a.name))
      if (n) { onCreateApp?.(n); showToast('Created app ' + n) }
    }, children: ['New'] })
    const mkPrefabs = () => Btn({ dense: true, onClick: (e) => {
      e.preventDefault()
      _showPrefabs = !_showPrefabs
      render()
    }, children: ['Prefabs'] })
    const toolbar = Toolbar({ children: [ h('div', { class: 'ds-ed-bar-grow' }, mkSearch()), mkPrefabs(), mkNew() ] })
    applyDiff(_toolbarHost, [toolbar])
  }

  function _appRow(app) {
    const item = document.createElement('div')
    item.className = 'ds-ep-tree-item' + (_expApp === app.name ? ' selected' : '')
    item.setAttribute('data-app-drag', app.name)
    item.title = 'Drag onto the viewport to place'
    _makeAppDraggable(item, app.name)

    const row = document.createElement('div')
    row.className = 'ds-ep-tree-row'
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    row.setAttribute('aria-label', (_expApp === app.name ? 'Collapse ' : 'Expand ') + app.name)
    const isExp = _expApp === app.name

    const twist = document.createElement('span')
    twist.className = 'ds-ep-tree-twist' + (isExp ? ' open' : '')
    twist.textContent = '>'
    const label = document.createElement('span')
    label.className = 'ds-ep-tree-label'
    label.style.cssText = 'flex:1;min-width:0'
    label.textContent = app.name + (app.hasEditorProps ? ' *' : '')
    row.append(twist, label)
    if (app.description) {
      const tag = document.createElement('span')
      tag.className = 'ds-ep-tree-tag'; tag.title = app.description; tag.textContent = app.description
      row.appendChild(tag)
    }
    const placeWrap = document.createElement('span')
    placeWrap.setAttribute('data-place-btn', ''); placeWrap.className = 'ds-ep-tree-rowbtn'
    applyDiff(placeWrap, [Btn({ ghost: true, dense: true, onClick: (e) => { e.preventDefault(); e.stopPropagation?.(); onPlace?.(app.name) }, children: ['Place'] })])
    row.appendChild(placeWrap)

    const _toggleRow = () => {
      _expApp = isExp ? null : app.name
      if (!isExp && onGetAppFiles) onGetAppFiles(app.name)
      renderList()
    }
    row.addEventListener('click', (ev) => {
      if (ev && ev.target && ev.target.closest && ev.target.closest('[data-place-btn]')) return
      _toggleRow()
    })
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); _toggleRow() }
    })
    item.appendChild(row)

    if (isExp) {
      const exp = document.createElement('div')
      exp.className = 'ds-ep-tree-children'
      exp.style.cssText = 'padding-left:18px'

      // Event Wiring / Bus Channels
      const listens = app.channels || []
      const emits = app.emitsChannels || []
      if (listens.length > 0 || emits.length > 0) {
        const evBox = document.createElement('div')
        evBox.style.cssText = 'font:11px var(--ff-mono, monospace);margin:4px 0 6px;padding:4px 8px;background:var(--ds-bg-1, rgba(255,255,255,0.04));border-radius:4px'
        if (listens.length > 0) {
          const inDiv = document.createElement('div')
          inDiv.style.cssText = 'color:var(--ds-accent-fg, #70a0ff);margin-bottom:2px'
          inDiv.textContent = 'Subscribes: ' + listens.join(', ')
          evBox.appendChild(inDiv)
        }
        if (emits.length > 0) {
          const outDiv = document.createElement('div')
          outDiv.style.cssText = 'color:var(--ds-success-fg, #4eb87b)'
          outDiv.textContent = 'Emits: ' + emits.join(', ')
          evBox.appendChild(outDiv)
        }
        exp.appendChild(evBox)
      }

      const files = _appFiles[app.name]
      if (!files) {
        const hint = document.createElement('div')
        hint.className = 'ds-ep-propfield-hint'; hint.style.cssText = 'padding:4px 8px'; hint.textContent = 'Loading files...'
        exp.appendChild(hint)
      } else if (!files.length) {
        const hint = document.createElement('div')
        hint.className = 'ds-ep-propfield-hint'; hint.style.cssText = 'padding:4px 8px'; hint.textContent = 'No files'
        exp.appendChild(hint)
      } else {
        for (const f of files) {
          const fr = document.createElement('div')
          fr.className = 'ds-ep-tree-row'
          fr.setAttribute('role', 'button')
          fr.tabIndex = 0
          fr.setAttribute('aria-label', 'Open file ' + f)
          const fl = document.createElement('span'); fl.className = 'ds-ep-tree-label'; fl.textContent = f
          fr.appendChild(fl)
          const _openFile = () => onGetSource?.(app.name, f)
          fr.addEventListener('click', _openFile)
          fr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); _openFile() } })
          exp.appendChild(fr)
        }
      }
      item.appendChild(exp)
    }
    return item
  }

  function _categoryHeader(categoryName, count, isCollapsed) {
    const catRow = document.createElement('div')
    catRow.className = 'ds-ep-tree-category-header'
    catRow.style.cssText = 'display:flex;align-items:center;padding:5px 8px;font:11px var(--ff-mono, monospace);font-weight:600;color:var(--ds-fg-2, #a0a0a0);background:var(--ds-bg-2, rgba(255,255,255,0.03));border-bottom:1px solid var(--ds-border, rgba(255,255,255,0.06));cursor:pointer;user-select:none;margin-top:4px'
    catRow.setAttribute('role', 'button')
    catRow.tabIndex = 0

    const twist = document.createElement('span')
    twist.className = 'ds-ep-tree-twist' + (!isCollapsed ? ' open' : '')
    twist.style.cssText = 'margin-right:6px;font-size:10px'
    twist.textContent = !isCollapsed ? 'v' : '>'

    const title = document.createElement('span')
    title.style.cssText = 'flex:1;min-width:0'
    title.textContent = categoryName

    const badge = document.createElement('span')
    badge.style.cssText = 'font-size:10px;opacity:0.6;margin-left:6px'
    badge.textContent = `(${count})`

    catRow.append(twist, title, badge)

    const toggle = () => {
      if (_collapsedCategories.has(categoryName)) _collapsedCategories.delete(categoryName)
      else _collapsedCategories.add(categoryName)
      renderList()
    }
    catRow.addEventListener('click', toggle)
    catRow.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } })

    return catRow
  }

  function renderList() {
    _ensureHosts()
    const filtered = _apps.filter(a => {
      if (!_filt) return true
      const cat = getAppCategory(a).toLowerCase()
      const chans = (a.channels || []).join(' ').toLowerCase()
      const emits = (a.emitsChannels || []).join(' ').toLowerCase()
      return a.name.toLowerCase().includes(_filt) || (a.description||'').toLowerCase().includes(_filt) || cat.includes(_filt) || chans.includes(_filt) || emits.includes(_filt)
    })
    _listHost.replaceChildren()
    if (!filtered.length) {
      const empty = document.createElement('div')
      empty.className = 'ds-ep-panel-body'
      empty.style.cssText = 'display:flex;align-items:center;justify-content:center;text-align:center;color:var(--panel-text-3)'
      empty.textContent = _apps.length ? 'No match' : 'Loading...'
      _listHost.appendChild(empty)
      return
    }

    // Group filtered apps by category
    const groups = new Map()
    for (const app of filtered) {
      const cat = getAppCategory(app)
      if (!groups.has(cat)) groups.set(cat, [])
      groups.get(cat).push(app)
    }

    // Sort categories according to CATEGORY_ORDER
    const orderedCategories = CATEGORY_ORDER.filter(c => groups.has(c)).concat(
      [...groups.keys()].filter(c => !CATEGORY_ORDER.includes(c)).sort()
    )

    for (const catName of orderedCategories) {
      const catApps = groups.get(catName)
      const isCollapsed = _filt ? false : _collapsedCategories.has(catName)
      _listHost.appendChild(_categoryHeader(catName, catApps.length, isCollapsed))
      if (!isCollapsed) {
        for (const app of catApps) {
          _listHost.appendChild(_appRow(app))
        }
      }
    }
  }

  function render() {
    // Must dispose the Monaco pane before wiping container, or its lazy-load liveness guard checks a stale flip.
    container._editorPaneDispose?.()
    if (_curApp && _curFile) {
      container.innerHTML = ''
      _toolbarHost = _listHost = null
      renderEditorPane(container, _curApp, _curFile, _pendingCode,
        v => onSave?.(_curApp, _curFile, v),
        () => { _curApp = _curFile = _pendingCode = null; render() })
      _pendingCode = null
      return
    }
    if (_showPrefabs) {
      container.innerHTML = ''
      _toolbarHost = _listHost = null
      if (!_prefabPanel) {
        const panelContainer = document.createElement('div')
        container.appendChild(panelContainer)
        _prefabPanel = createPrefabPanel(panelContainer, {
          onSave: onSavePrefab,
          onInstantiate: onInstantiatePrefab,
          onDelete: (name) => {},
          getPrefabs: onGetPrefabs,
          getSelectedEntities: getSelectedEntities
        })
      }
      return
    }
    _ensureHosts()
    renderToolbar()
    renderList()
  }

  render()

  return {
    render,
    setApps(apps) { _apps = apps || []; if (!(_curApp && _curFile) && !_showPrefabs) renderList() },
    setAppFiles(name, files) { _appFiles[name] = files || []; if (!(_curApp && _curFile) && !_showPrefabs) renderList() },
    openCode(app, file, code) { _curApp = app; _curFile = file; _pendingCode = code; render() },
    refreshPrefabs() { if (_prefabPanel) _prefabPanel.refresh?.() }
  }
}

