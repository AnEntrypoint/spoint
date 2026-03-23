export function createEditorEventLog(container, { onQuery } = {}) {
  let _events = [], _filter = '', _pollId = null, _autoScroll = true

  const S = {
    root: 'display:flex;flex-direction:column;height:100%;font:11px/1.5 monospace;color:rgba(255,255,255,0.75)',
    bar: 'display:flex;gap:6px;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0',
    input: 'flex:1;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.8);padding:3px 7px;border-radius:4px;font:11px monospace;outline:none',
    clr: 'background:none;border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.5);cursor:pointer;padding:2px 8px;border-radius:4px;font:10px monospace',
    tbl: 'flex:1;overflow-y:auto;padding:4px 0',
    hdr: 'display:grid;grid-template-columns:50px 90px 90px 1fr;gap:0;padding:3px 8px;color:rgba(255,255,255,0.3);border-bottom:1px solid rgba(255,255,255,0.05);font:9px/1.4 monospace;text-transform:uppercase;letter-spacing:0.08em;flex-shrink:0',
    row: (i) => 'display:grid;grid-template-columns:50px 90px 90px 1fr;gap:0;padding:2px 8px;background:' + (i%2 ? 'rgba(255,255,255,0.02)' : 'none'),
    cell: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
    empty: 'padding:24px 16px;color:rgba(255,255,255,0.25);text-align:center'
  }

  const root = document.createElement('div'); root.style.cssText = S.root

  const bar = document.createElement('div'); bar.style.cssText = S.bar
  const filterInput = document.createElement('input'); filterInput.style.cssText = S.input; filterInput.placeholder = 'filter type or entity…'
  filterInput.addEventListener('input', () => { _filter = filterInput.value.toLowerCase(); _render() })
  const clrBtn = document.createElement('button'); clrBtn.textContent = 'Clear'; clrBtn.style.cssText = S.clr
  clrBtn.addEventListener('click', () => { _events = []; _render() })
  bar.append(filterInput, clrBtn)

  const hdr = document.createElement('div'); hdr.style.cssText = S.hdr
  for (const col of ['Tick','Type','Entity','App']) { const c=document.createElement('span');c.textContent=col;c.style.cssText=S.cell;hdr.appendChild(c) }

  const tbl = document.createElement('div'); tbl.style.cssText = S.tbl
  tbl.addEventListener('scroll', () => { _autoScroll = tbl.scrollTop + tbl.clientHeight >= tbl.scrollHeight - 20 })

  root.append(bar, hdr, tbl)
  container.appendChild(root)

  function _render() {
    const vis = _filter ? _events.filter(e => (e.type||'').includes(_filter) || (e.meta?.sourceEntity||'').includes(_filter)) : _events
    if (vis.length === 0) { tbl.innerHTML = ''; const e=document.createElement('div');e.style.cssText=S.empty;e.textContent=_events.length?'No matching events':'No events recorded';tbl.appendChild(e); return }
    const frag = document.createDocumentFragment()
    vis.slice(-200).forEach((ev, i) => {
      const row = document.createElement('div'); row.style.cssText = S.row(i)
      for (const val of [ev.tick??'', ev.type??'', ev.meta?.sourceEntity??'', ev.meta?.sourceApp??'']) {
        const c = document.createElement('span'); c.textContent = val; c.style.cssText = S.cell; c.title = String(val); row.appendChild(c)
      }
      frag.appendChild(row)
    })
    tbl.innerHTML = ''; tbl.appendChild(frag)
    if (_autoScroll) tbl.scrollTop = tbl.scrollHeight
  }

  _render()

  return {
    start() { if (_pollId) return; onQuery?.(); _pollId = setInterval(() => onQuery?.(), 2000) },
    stop() { if (_pollId) { clearInterval(_pollId); _pollId = null } },
    updateEvents(events) { if (!Array.isArray(events)) return; _events = events; _render() }
  }
}
