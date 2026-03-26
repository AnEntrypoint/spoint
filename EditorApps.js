import { renderEditorPane } from './EditPanelEditor.js'

const S = {
  root: 'display:flex;flex-direction:column;height:100%;min-height:0',
  row: 'display:flex;gap:6px;margin:8px 8px 4px',
  fi: 'flex:1;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);color:#fff;padding:6px 8px;border-radius:8px;font:inherit',
  nb: 'background:rgba(34,51,34,0.8);color:#8f8;border:none;padding:6px 10px;border-radius:8px;cursor:pointer;font:inherit;flex-shrink:0',
  list: 'flex:1;overflow-y:auto;padding:0 8px 8px',
  appRow: 'padding:8px;cursor:pointer;border-radius:8px;display:flex;align-items:center;gap:6px;min-height:40px',
  placeBtn: 'background:rgba(34,51,85,0.8);color:#adf;border:none;padding:4px 8px;border-radius:6px;cursor:pointer;font:inherit;flex-shrink:0',
  fileRow: 'padding:5px 8px;cursor:pointer;border-radius:6px;color:rgba(255,255,255,0.7);display:flex;align-items:center'
}

export function createEditorApps(container, { onPlace, onSave, onGetSource, onGetAppFiles, onCreateApp } = {}) {
  let _apps = [], _filt = '', _expApp = null, _appFiles = {}, _curApp = null, _curFile = null, _pendingCode = null

  function render() {
    container.innerHTML = ''
    if (_curApp && _curFile) {
      renderEditorPane(container, _curApp, _curFile, _pendingCode,
        v => onSave?.(_curApp, _curFile, v),
        () => { _curApp = _curFile = _pendingCode = null; render() })
      _pendingCode = null; return
    }
    container.style.cssText = S.root
    const nr = document.createElement('div'); nr.style.cssText = S.row
    const fi = document.createElement('input'); fi.type = 'text'; fi.placeholder = 'Filter apps...'; fi.value = _filt; fi.style.cssText = S.fi
    fi.addEventListener('input', () => { _filt = fi.value.toLowerCase(); render() })
    const nb = document.createElement('button'); nb.textContent = '+ New'; nb.style.cssText = S.nb
    nb.addEventListener('click', () => { const n = prompt('App name (lowercase, hyphens only):'); if (n && /^[a-z0-9-]+$/.test(n)) onCreateApp?.(n) })
    nr.appendChild(fi); nr.appendChild(nb); container.appendChild(nr)
    const list = document.createElement('div'); list.style.cssText = S.list
    const filtered = _apps.filter(a => a.name.toLowerCase().includes(_filt) || (a.description||'').toLowerCase().includes(_filt))
    if (!filtered.length) { const e = document.createElement('div'); e.textContent = _apps.length ? 'No match' : 'Loading...'; e.style.color = 'rgba(255,255,255,0.25)'; list.appendChild(e) }
    for (const app of filtered) {
      const isExp = _expApp === app.name
      const wrap = document.createElement('div'); wrap.style.marginBottom = '2px'
      const row = document.createElement('div'); row.style.cssText = S.appRow; if (isExp) row.style.background = 'rgba(255,255,255,0.04)'
      row.addEventListener('mouseenter', () => { if (!isExp) row.style.background = 'rgba(255,255,255,0.04)' })
      row.addEventListener('mouseleave', () => { if (!isExp) row.style.background = 'transparent' })
      const arrow = document.createElement('span'); arrow.textContent = isExp ? '▾' : '▸'; arrow.style.cssText = 'color:rgba(255,255,255,0.3);flex-shrink:0;width:12px'
      const info = document.createElement('div'); info.style.cssText = 'flex:1;min-width:0'
      const nm = document.createElement('div'); nm.textContent = app.name + (app.hasEditorProps ? ' ✦' : ''); nm.style.cssText = 'color:#adf;font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      info.appendChild(nm)
      if (app.description) { const d = document.createElement('div'); d.textContent = app.description; d.style.cssText = 'color:rgba(255,255,255,0.3);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; info.appendChild(d) }
      const pb = document.createElement('button'); pb.textContent = 'Place'; pb.style.cssText = S.placeBtn
      pb.addEventListener('click', e => { e.stopPropagation(); onPlace?.(app.name) })
      row.appendChild(arrow); row.appendChild(info); row.appendChild(pb)
      row.addEventListener('click', () => { _expApp = isExp ? null : app.name; if (!isExp && onGetAppFiles) onGetAppFiles(app.name); render() })
      wrap.appendChild(row)
      if (isExp) {
        const fl = document.createElement('div'); fl.style.cssText = 'background:rgba(0,0,0,0.3);border-radius:0 0 8px 8px;padding:4px 0 4px 20px'
        const files = _appFiles[app.name]
        if (!files) { const lo = document.createElement('div'); lo.textContent = 'Loading files...'; lo.style.color = 'rgba(255,255,255,0.3)'; fl.appendChild(lo) }
        else for (const f of files) {
          const fr = document.createElement('div'); fr.style.cssText = S.fileRow; fr.textContent = f
          fr.addEventListener('mouseenter', () => fr.style.background = 'rgba(255,255,255,0.05)')
          fr.addEventListener('mouseleave', () => fr.style.background = 'transparent')
          fr.addEventListener('click', () => onGetSource?.(app.name, f))
          fl.appendChild(fr)
        }
        wrap.appendChild(fl)
      }
      list.appendChild(wrap)
    }
    container.appendChild(list)
  }

  return {
    render,
    setApps(apps) { _apps = apps || []; render() },
    setAppFiles(name, files) { _appFiles[name] = files || []; render() },
    openCode(app, file, code) { _curApp = app; _curFile = file; _pendingCode = code; render() }
  }
}
