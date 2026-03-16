export function drag(label, value, onChange) {
  const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;margin:2px 0'
  const lbl = document.createElement('span'); lbl.textContent = label + ':'; lbl.style.cssText = 'width:30px;color:#aaa;flex-shrink:0'
  const inp = document.createElement('input'); inp.type = 'text'; inp.value = typeof value === 'number' ? value.toFixed(3) : value
  inp.style.cssText = 'flex:1;background:#252530;border:none;color:#fff;padding:2px 4px;border-radius:3px;cursor:ew-resize;font:inherit'
  let d = false, sx = 0, sv = 0
  inp.addEventListener('mousedown', e => { if (document.activeElement === inp) return; d = true; sx = e.clientX; sv = parseFloat(inp.value) || 0; e.preventDefault() })
  window.addEventListener('mousemove', e => { if (!d) return; const v = sv + (e.clientX - sx) * 0.01; inp.value = v.toFixed(3); onChange(v) })
  window.addEventListener('mouseup', () => { d = false })
  inp.addEventListener('change', () => onChange(parseFloat(inp.value) || 0))
  row.appendChild(lbl); row.appendChild(inp); return row
}

export function v3(label, vals, key, getEntity, getOnChange) {
  const g = document.createElement('div'); g.style.marginBottom = '4px'
  const h = document.createElement('div'); h.textContent = label; h.style.cssText = 'color:#888;font-size:10px;text-transform:uppercase;margin-bottom:2px'; g.appendChild(h)
  ;['x', 'y', 'z'].forEach((ax, i) => g.appendChild(drag(ax, vals[i] || 0, v => {
    const entity = getEntity(), onChange = getOnChange()
    if (!entity || !onChange) return
    const c = entity[key] ? [...entity[key]] : [0, 0, 0]; c[i] = v; onChange(key, c)
  })))
  return g
}

export function node(n, depth, getSelId, onEntitySelect, rerender) {
  const wrap = document.createElement('div')
  const row = document.createElement('div'); row.style.cssText = `display:flex;align-items:center;padding:4px;cursor:pointer;border-radius:3px;padding-left:${8 + depth * 12}px;min-height:30px`
  row.style.background = n.id === getSelId() ? '#335' : 'transparent'
  const lbl = document.createElement('span'); lbl.textContent = n.label || n.appName || n.id; lbl.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
  const pos = n.position ? `(${n.position.map(v => v.toFixed(1)).join(', ')})` : ''
  const tag = document.createElement('span'); tag.textContent = (n.appName ? n.appName + ' ' : '') + pos; tag.style.cssText = 'color:#555;font-size:10px;flex-shrink:0;margin-left:4px;white-space:nowrap'
  row.appendChild(lbl); row.appendChild(tag)
  row.addEventListener('click', () => { if (onEntitySelect) onEntitySelect(n.id); rerender() })
  row.addEventListener('mouseenter', () => { if (n.id !== getSelId()) row.style.background = '#1e1e2e' })
  row.addEventListener('mouseleave', () => { row.style.background = n.id === getSelId() ? '#335' : 'transparent' })
  wrap.appendChild(row)
  if (n.children?.length) { const cw = document.createElement('div'); for (const c of n.children) cw.appendChild(node(c, depth + 1, getSelId, onEntitySelect, rerender)); wrap.appendChild(cw) }
  return wrap
}

export function propField(f, getEntity, getOnChange) {
  const entity = getEntity(), onChange = getOnChange()
  const key = f.key, lbl = f.label || f.key, val = entity?.custom?.[key] ?? f.default ?? (f.type === 'number' ? 0 : '')
  const emit = v => { if (onChange) onChange('custom.' + key, v) }
  if (f.type === 'number') return drag(lbl, val, emit)
  const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;margin:2px 0;gap:4px'
  const l = document.createElement('span'); l.textContent = lbl + ':'; l.style.cssText = 'color:#aaa;flex-shrink:0;min-width:60px'; row.appendChild(l)
  if (f.type === 'color') { const i = document.createElement('input'); i.type = 'color'; i.value = val || '#fff'; i.style.cssText = 'flex:1;border:none;height:32px;cursor:pointer'; i.addEventListener('change', () => emit(i.value)); row.appendChild(i) }
  else if (f.type === 'checkbox') { const i = document.createElement('input'); i.type = 'checkbox'; i.checked = !!val; i.addEventListener('change', () => emit(i.checked)); row.insertBefore(i, row.firstChild) }
  else if (f.type === 'select' && f.options) { const s = document.createElement('select'); s.style.cssText = 'flex:1;background:#252530;color:#fff;border:none;padding:2px;font:inherit'; for (const o of f.options) { const op = document.createElement('option'); op.value = o; op.textContent = o; if (val === o) op.selected = true; s.appendChild(op) }; s.addEventListener('change', () => emit(s.value)); row.appendChild(s) }
  else { const i = document.createElement('input'); i.type = 'text'; i.value = val; i.style.cssText = 'flex:1;background:#252530;border:none;color:#fff;padding:2px 4px;border-radius:3px;font:inherit'; i.addEventListener('change', () => emit(i.value)); row.appendChild(i) }
  return row
}
