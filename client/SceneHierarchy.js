import { createElement, applyDiff } from 'webjsx'
const h = createElement
const S = {
  root: 'display:flex;flex-direction:column;height:100%;min-height:0',
  hdr: 'padding:8px 8px 4px;font:9px/1 monospace;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:0.18em',
  srch: 'margin:4px 8px 6px;height:28px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:10px;color:#fff;padding:0 10px;font:12px/1 monospace;outline:none;box-sizing:border-box;width:calc(100% - 16px)',
  list: 'flex:1;overflow-y:auto;padding:2px 4px 4px',
  row: (s) => 'display:flex;align-items:center;padding:6px 10px;border-radius:10px;cursor:pointer;font:12px/1.4 monospace;font-weight:500;color:'+(s?'#a7f3d0':'rgba(255,255,255,0.62)')+';background:'+(s?'rgba(16,185,129,0.14)':'transparent'),
  tag: 'font:9px/1 monospace;color:rgba(255,255,255,0.28);margin-left:auto;flex-shrink:0;padding-left:8px'
}

export function createSceneHierarchy(container, { onSelect, onFocus, onDelete } = {}) {
  let _ents = [], _q = '', _sel = null

  function render() {
    const vis = _q ? _ents.filter(e => (e.id||'').toLowerCase().includes(_q) || (e._appName||'').toLowerCase().includes(_q)) : _ents
    applyDiff(container, h('div', { style: S.root },
      h('div', { style: S.hdr }, 'Scene'),
      h('input', { style: S.srch, type: 'text', placeholder: 'Search scene objects', value: _q,
        onInput: e => { _q = e.target.value.toLowerCase(); render() } }),
      h('div', { style: S.list },
        vis.length === 0
          ? h('div', { style: 'padding:16px;color:rgba(255,255,255,0.22);font:12px monospace;text-align:center' }, _ents.length ? 'No match' : 'No entities')
          : h('div', {},
            ...vis.map(e => h('div', { key: e.id, style: S.row(e.id === _sel),
              onClick: () => { _sel = e.id; onSelect?.(e.id); render() },
              onDblclick: () => onFocus?.(e.id),
              onContextmenu: ev => { ev.preventDefault(); if (confirm('Delete ' + e.id + '?')) onDelete?.(e.id) }
            }, h('span', {}, e.id), h('span', { style: S.tag }, e._appName || e.appName || '')))
          )
      )
    ))
  }

  render()
  return {
    updateEntities(ents) { _ents = ents || []; render() },
    setSelected(id) { _sel = id; render() },
    get selectedId() { return _sel }
  }
}
