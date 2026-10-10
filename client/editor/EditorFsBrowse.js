import { createElement as h, applyDiff } from 'webjsx'
import { showToast, showConfirm } from './EditPanelDOM.js'
import { Btn, Toolbar, SearchInput, promptText, getSharedWM } from './wm/ui.js'

function fmtSize(n) {
  if (n == null || n < 0) return '(error)'
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' K'
  return (n / 1048576).toFixed(1) + ' M'
}
function norm(p) { return String(p || '').replace(/^\/+|\/+$/g, '') }
function join(a, b) { a = norm(a); b = norm(b); return a ? (b ? a + '/' + b : a) : b }
function parent(p) { p = norm(p); const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i) }
function base(p) { p = norm(p); const i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1) }

function splitAppPath(path) {
  const p = norm(path)
  const i = p.indexOf('/')
  if (i < 0) return { appName: p, file: 'index.js' }
  return { appName: p.slice(0, i), file: p.slice(i + 1) }
}

export function fsSaveBase(pendingSave) {
  return pendingSave ? { mtimeMs: Number.isFinite(pendingSave.mtimeMs) ? pendingSave.mtimeMs : null } : null
}

function findNode(tree, path) {
  const parts = norm(path).split('/').filter(Boolean)
  let level = tree, node = null
  for (const part of parts) {
    node = (level || []).find(n => n.name === part)
    if (!node) return null
    level = node.children
  }
  return node
}

function dirEntries(tree, dir) {
  const d = norm(dir)
  if (!d) return (tree || []).slice().sort((a, b) => (a.type === b.type) ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1))
  const node = findNode(tree, d)
  if (!node || node.type !== 'dir') return []
  return (node.children || []).slice().sort((a, b) => (a.type === b.type) ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1))
}

export function fsSourceResultOf(payload) {
  const p = payload || {}
  if (p.conflict) {
    if (typeof p.diskSource === 'string') return { kind: 'conflict', diskSource: p.diskSource, mtimeMs: p.mtimeMs }
    return { kind: 'error', error: 'file changed on disk since it was loaded -- reload it (the on-disk source is unreadable)' }
  }
  if (p.binary) return { kind: 'binary' }
  if (p.error != null) return { kind: 'error', error: String(p.error) }
  if (typeof p.source === 'string') return { kind: 'text', source: p.source, mtimeMs: p.mtimeMs }
  return { kind: 'error', error: 'no source returned for this file' }
}

export function createEditorFsBrowse(container, { onListTree, onGetSource, onSave, onMkdir, onDelete, onRename } = {}) {
  let _state = { kind: 'loading' }
  let _cwd = '', _filt = '', _openFile = null, _pendingSave = null, _banner = null
  const _treeOf = () => (_state.kind === 'ready' ? _state.tree : null)

  container.classList.add('ds-ep-panel')
  container.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0'

  let _toolbarHost = null, _crumbsHost = null, _listHost = null
  function _ensureHosts() {
    if (_toolbarHost && _toolbarHost.isConnected) return
    container.innerHTML = ''
    _toolbarHost = document.createElement('div')
    _crumbsHost = document.createElement('div')
    _crumbsHost.className = 'ds-ep-fsb-crumbs'
    _crumbsHost.style.cssText = 'padding:2px 8px;font:11px var(--ff-mono,monospace);color:var(--panel-text-2,var(--fg-2));display:flex;gap:2px;flex-wrap:wrap'
    _listHost = document.createElement('div')
    _listHost.className = 'ds-ep-tree'
    _listHost.style.cssText = 'flex:1;min-height:0;overflow-y:auto'
    container.append(_toolbarHost, _crumbsHost, _listHost)
    renderToolbar()
  }

  function renderToolbar() {
    const mkSearch = () => SearchInput({ value: _filt, placeholder: 'Filter...', onInput: v => { _filt = (v || '').toLowerCase(); renderList() } })
    const up = Btn({ ghost: true, dense: true, title: 'Up a level', onClick: (e) => { e.preventDefault(); _cwd = parent(_cwd); _openFile = null; renderList() }, children: ['..'] })
    const mkFolder = Btn({ dense: true, onClick: async (e) => {
      e.preventDefault()
      const wm = getSharedWM()
      const name = wm ? await promptText(wm, { title: 'New folder', label: 'Folder name', placeholder: 'name' }) : prompt('New folder name')
      if (!name) return
      onMkdir?.(join(_cwd, name))
    }, children: ['+ Folder'] })
    const mkFile = Btn({ dense: true, onClick: async (e) => {
      e.preventDefault()
      const wm = getSharedWM()
      const name = wm ? await promptText(wm, { title: 'New file', label: 'File name', placeholder: 'name.js' }) : prompt('New file name')
      if (!name) return
      const path = join(_cwd, name)
      onSave?.(path, '', { mtimeMs: null })
    }, children: ['+ File'] })
    const refresh = Btn({ ghost: true, dense: true, title: 'Refresh tree', onClick: (e) => { e.preventDefault(); _state = { kind: 'loading' }; renderList(); onListTree?.() }, children: ['Refresh'] })
    const toolbar = Toolbar({ children: [ h('div', { class: 'ds-ed-bar-grow' }, mkSearch()), up, mkFolder, mkFile, refresh ] })
    applyDiff(_toolbarHost, [toolbar])
  }

  function renderCrumbs() {
    _crumbsHost.replaceChildren()
    const rootLink = document.createElement('a')
    rootLink.href = '#'; rootLink.textContent = 'apps/'; rootLink.style.cssText = 'cursor:pointer;color:var(--accent)'
    rootLink.addEventListener('click', (e) => { e.preventDefault(); _cwd = ''; _openFile = null; renderList() })
    _crumbsHost.appendChild(rootLink)
    const parts = norm(_cwd).split('/').filter(Boolean)
    let acc = ''
    for (const part of parts) {
      acc = join(acc, part)
      const here = acc
      const sep = document.createElement('span'); sep.textContent = '/'
      const a = document.createElement('a'); a.href = '#'; a.textContent = part; a.style.cssText = 'cursor:pointer;color:var(--accent)'
      a.addEventListener('click', (e) => { e.preventDefault(); _cwd = here; _openFile = null; renderList() })
      _crumbsHost.append(sep, a)
    }
  }

  async function openFile(path) {
    _openFile = path
    onGetSource?.(path)
    renderList()
  }

  function _row(entry, path) {
    const item = document.createElement('div')
    item.className = 'ds-ep-tree-row'
    item.setAttribute('role', 'button'); item.tabIndex = 0
    const activate = () => { if (entry.type === 'dir') { _cwd = path; renderList() } else openFile(path) }
    item.addEventListener('click', (ev) => { if (ev.target.closest('[data-fsb-act]')) return; activate() })
    item.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate() } })

    const twist = document.createElement('span')
    twist.className = 'ds-ep-tree-twist'
    twist.textContent = entry.type === 'dir' ? '\u{1F4C1}' : (entry.binary ? '\u{1F4E6}' : '\u{1F4C4}')
    twist.style.cssText = 'margin-right:4px'
    const label = document.createElement('span')
    label.className = 'ds-ep-tree-label'
    label.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    label.textContent = entry.name
    const size = document.createElement('span')
    size.style.cssText = 'color:var(--panel-text-3,var(--fg-3));font-size:10px;margin-right:6px'
    size.textContent = entry.type === 'file' ? fmtSize(entry.size) : ''
    item.append(twist, label, size)

    const acts = document.createElement('span')
    acts.setAttribute('data-fsb-act', '')
    acts.style.cssText = 'display:flex;gap:2px'
    const renameBtn = Btn({ ghost: true, dense: true, title: 'Rename', onClick: async (e) => {
      e.preventDefault()
      const wm = getSharedWM()
      const next = wm ? await promptText(wm, { title: 'Rename', label: 'New name', initial: entry.name }) : prompt('Rename to', entry.name)
      if (!next || next === entry.name) return
      onRename?.(path, join(parent(path), next))
    }, children: ['✎'] })
    const delBtn = Btn({ ghost: true, danger: true, dense: true, title: 'Delete', onClick: async (e) => {
      e.preventDefault()
      const ok = await showConfirm({ title: 'Delete', message: `Delete ${entry.type === 'dir' ? 'folder' : 'file'} "${entry.name}"? This cannot be undone.`, confirmLabel: 'Delete', destructive: true })
      if (!ok) return
      onDelete?.(path)
    }, children: ['✕'] })
    applyDiff(acts, [renameBtn, delBtn])
    item.appendChild(acts)
    return item
  }

  function doSave() {
    if (!_edRef) { showToast('Editor not ready', 'error'); return }
    const base = fsSaveBase(_pendingSave)
    if (!base) {
      showToast('apps/' + _openFile + ' was never loaded -- reloading it, then save again', 'error')
      onGetSource?.(_openFile)
      return
    }
    onSave?.(_openFile, _edRef.getValue(), base)
  }

  let _sourceKind = null
  function renderEditor() {
    _ensureHosts()
    container.innerHTML = ''
    const backBtn = Btn({ ghost: true, onClick: (e) => { e.preventDefault(); _openFile = null; _toolbarHost = null; render() }, children: ['Back'] })
    const labelNode = h('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px var(--ff-mono,monospace)' }, 'apps/' + _openFile)
    const node = findNode(_treeOf(), _openFile)
    if (_sourceKind === 'binary' || (node && node.binary)) {
      const barHost = document.createElement('div')
      barHost.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px'
      applyDiff(barHost, [backBtn, labelNode])
      const info = document.createElement('div')
      info.className = 'ds-ep-propfield-hint'
      info.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px'
      info.append(
        Object.assign(document.createElement('div'), { textContent: '\u{1F4E6} Binary file -- ' + fmtSize(node ? node.size : null) }),
        Object.assign(document.createElement('div'), { textContent: 'apps/' + _openFile, style: 'color:var(--panel-text-3,var(--fg-3));font-size:11px' })
      )
      container.append(barHost, info)
      return
    }
    const barHost = document.createElement('div')
    barHost.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px'
    const saveBtn = Btn({ primary: true, onClick: (e) => { e.preventDefault(); doSave() }, children: ['Save (Ctrl+S)'] })
    applyDiff(barHost, [backBtn, labelNode, saveBtn])
    container.appendChild(barHost)
    const c = document.createElement('div')
    c.className = 'ds-ep-panel-body flush'
    c.style.cssText = 'flex:1;min-height:0;position:relative'
    container.appendChild(c)
    const code = _pendingSave != null ? _pendingSave.source : ''
    _mountEditor(c, code)

  }

  let _edRef = null, _edAlive = false
  function _mountEditor(mountEl, code) {
    _edAlive = true
    container._editorPaneDispose = () => { _edAlive = false; if (_edRef) { _edRef.dispose?.(); _edRef = null } }
    const ta = document.createElement('textarea')
    ta.value = code || ''
    ta.spellcheck = false
    ta.style.cssText = 'width:100%;height:100%;box-sizing:border-box;background:var(--panel-0,#1e1e1e);color:var(--panel-text,#d4d4d4);font:12px/1.5 var(--ff-mono,monospace);border:none;padding:12px;resize:none;outline:none'
    ta.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); doSave() } })
    mountEl.appendChild(ta)
    if (window.monaco) {
      try {
        mountEl.removeChild(ta)
        const ed = window.monaco.editor.create(mountEl, { value: code || '', language: 'javascript', theme: 'vs-dark', fontSize: 12, minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false })
        ed.addCommand(window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.KeyS, () => doSave())
        _edRef = ed
        return
      } catch (_) { mountEl.appendChild(ta) }
    }
    _edRef = { getValue: () => ta.value, dispose: () => {} }
  }

  function renderList() {
    _ensureHosts()
    renderCrumbs()
    _listHost.replaceChildren()
    if (_state.kind !== 'ready') {
      const empty = document.createElement('div')
      empty.className = 'ds-ep-panel-body'
      empty.style.cssText = 'display:flex;align-items:center;justify-content:center;text-align:center;color:var(--panel-text-3)' + (_state.kind === 'loading' ? '' : ';padding:16px')
      empty.textContent = _state.kind === 'loading' ? 'Loading...' : _state.reason
      _listHost.appendChild(empty)
      return
    }
    let entries = dirEntries(_state.tree, _cwd)
    if (_filt) entries = entries.filter(e => e.name.toLowerCase().includes(_filt))
    if (!entries.length) {
      const empty = document.createElement('div')
      empty.className = 'ds-ep-propfield-hint'
      empty.style.cssText = 'padding:16px;text-align:center;color:var(--panel-text-3,var(--fg-3))'
      empty.textContent = '(empty folder -- use + Folder / + File above)'
      _listHost.appendChild(empty)
      return
    }
    for (const entry of entries) _listHost.appendChild(_row(entry, join(_cwd, entry.name)))
  }

  function _syncBanner() {
    const reason = (_openFile && _state.kind === 'unavailable') ? _state.reason : null
    if (_banner && _banner.parentNode !== container) _banner = null
    if (reason == null) {
      if (_banner) { _banner.remove(); _banner = null }
      return
    }
    if (!_banner) {
      _banner = document.createElement('div')
      _banner.className = 'ds-ep-propfield-hint'
      _banner.style.cssText = 'padding:6px 8px;color:var(--danger,#f7768e);font:11px var(--ff-mono,monospace)'
      container.prepend(_banner)
    }
    _banner.textContent = reason
  }

  function render() {
    container._editorPaneDispose?.()
    if (_openFile) { renderEditor(); _syncBanner(); return }
    _ensureHosts()
    renderToolbar()
    renderList()
    _syncBanner()
  }

  render()

  return {
    render,
    setTree(tree, error) {
      _state = error ? { kind: 'unavailable', reason: error } : { kind: 'ready', tree: tree || [] }
      if (_openFile) { _syncBanner(); return }
      renderList()
    },
    setSource(path, result) {
      if (path !== _openFile) return
      const r = result || { kind: 'error', error: 'no source returned for this file' }
      _sourceKind = r.kind
      switch (r.kind) {
        case 'binary':
          if (_openFile) render()
          return
        case 'conflict':
          showToast('Conflict: apps/' + path + ' changed on disk since it was loaded -- reload before saving again', 'error')
          _pendingSave = { source: r.diskSource, mtimeMs: r.mtimeMs }
          return
        case 'text':
          _pendingSave = { source: r.source, mtimeMs: r.mtimeMs }
          if (_openFile) render()
          return
        default:
          showToast(r.error || 'no source returned for this file', 'error')
      }
    },
    onOpResult(op, ok, error) {
      if (ok) { showToast(op + ' ok', 'success') }
      else showToast(op + ' failed: ' + (error || 'unknown'), 'error')
    },
    onTreeChanged() { onListTree?.() },
    get currentDir() { return _cwd },
    splitAppPath
  }
}
