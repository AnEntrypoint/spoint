export function createInspector() {
  const panel = document.createElement('div')
  panel.style.cssText = 'position:fixed;top:12px;right:12px;width:230px;background:rgba(20,20,20,0.92);color:#eee;font:12px/1.5 monospace;padding:10px;border-radius:6px;z-index:9999;display:none;user-select:none;max-height:90vh;overflow-y:auto'
  document.body.appendChild(panel)

  let _onChange = null, _onEditCode = null, _entity = null, _editorProps = []

  function makeRow(lbl, el) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;margin:2px 0;gap:4px'
    const l = document.createElement('span'); l.textContent = lbl + ':'; l.style.cssText = 'color:#aaa;flex-shrink:0;min-width:50px'
    row.appendChild(l); row.appendChild(el); return row
  }

  function dragField(label, value, onChange) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;margin:2px 0'
    const lbl = document.createElement('span'); lbl.textContent = label + ':'; lbl.style.cssText = 'width:30px;color:#aaa;flex-shrink:0'
    const inp = document.createElement('input'); inp.type = 'text'
    inp.value = typeof value === 'number' ? value.toFixed(3) : value
    inp.style.cssText = 'flex:1;background:#333;border:none;color:#fff;padding:1px 4px;border-radius:3px;cursor:ew-resize;font:inherit'
    let dragging = false, startX = 0, startVal = 0
    inp.addEventListener('mousedown', e => { if (document.activeElement === inp) return; dragging = true; startX = e.clientX; startVal = parseFloat(inp.value) || 0; e.preventDefault() })
    window.addEventListener('mousemove', e => { if (!dragging) return; const v = startVal + (e.clientX - startX) * 0.01; inp.value = v.toFixed(3); onChange(v) })
    window.addEventListener('mouseup', () => { dragging = false })
    inp.addEventListener('change', () => onChange(parseFloat(inp.value) || 0))
    row.appendChild(lbl); row.appendChild(inp); return { row, inp }
  }

  function makeVec3Group(label, vals, key) {
    const grp = document.createElement('div'); grp.style.marginBottom = '4px'
    const hdr = document.createElement('div'); hdr.textContent = label; hdr.style.cssText = 'color:#888;font-size:10px;text-transform:uppercase;margin-bottom:2px'; grp.appendChild(hdr)
    const axes = ['x','y','z'], inputs = {}
    axes.forEach((ax, i) => {
      const { row, inp } = dragField(ax, vals[i] || 0, v => { if (!_entity || !_onChange) return; const cur = _entity[key] ? [..._entity[key]] : [0,0,0]; cur[i] = v; _onChange(key, cur) })
      inputs[ax] = inp; grp.appendChild(row)
    })
    grp.update = vs => axes.forEach((ax, i) => { inputs[ax].value = (vs[i]||0).toFixed(3) })
    return grp
  }

  function makeBodyTypeRow() {
    const wrap = document.createElement('div'); wrap.style.cssText = 'margin-bottom:6px'
    const lbl = document.createElement('div'); lbl.textContent = 'Body Type'; lbl.style.cssText = 'color:#888;font-size:10px;text-transform:uppercase;margin-bottom:2px'; wrap.appendChild(lbl)
    const btnRow = document.createElement('div'); btnRow.style.cssText = 'display:flex;gap:4px'
    const current = _entity?.bodyType || 'static'
    for (const bt of ['static','dynamic','kinematic']) {
      const btn = document.createElement('button'); btn.textContent = bt
      btn.style.cssText = `flex:1;background:${current===bt?'#556':'#333'};color:#fff;border:none;padding:3px 0;border-radius:3px;cursor:pointer;font:inherit;min-height:24px`
      btn.addEventListener('click', () => { if (_onChange) _onChange('bodyType', bt); wrap.querySelectorAll('button').forEach(b=>b.style.background='#333'); btn.style.background='#556' })
      btnRow.appendChild(btn)
    }
    wrap.appendChild(btnRow); return wrap
  }

  function makePropField(f) {
    const key = f.key, lbl = f.label || f.key, val = _entity?.custom?.[key] ?? f.default ?? (f.type==='number'?0:'')
    const emit = v => { if (_onChange) _onChange('custom.'+key, v) }
    if (f.type === 'number') return dragField(lbl, val, emit).row
    if (f.type === 'color') { const inp = document.createElement('input'); inp.type='color'; inp.value=val||'#ffffff'; inp.style.cssText='flex:1;background:#333;border:none;height:24px;cursor:pointer'; inp.addEventListener('change',()=>emit(inp.value)); return makeRow(lbl,inp) }
    if (f.type === 'checkbox') { const inp = document.createElement('input'); inp.type='checkbox'; inp.checked=!!val; inp.addEventListener('change',()=>emit(inp.checked)); const r=makeRow(lbl,inp); r.insertBefore(inp,r.firstChild); return r }
    if (f.type === 'select' && f.options) { const sel = document.createElement('select'); sel.style.cssText='flex:1;background:#333;color:#fff;border:none;padding:2px;font:inherit'; for (const o of f.options){const op=document.createElement('option');op.value=o;op.textContent=o;if(val===o)op.selected=true;sel.appendChild(op)} sel.addEventListener('change',()=>emit(sel.value)); return makeRow(lbl,sel) }
    const inp = document.createElement('input'); inp.type='text'; inp.value=val; inp.style.cssText='flex:1;background:#333;border:none;color:#fff;padding:1px 4px;border-radius:3px;font:inherit'; inp.addEventListener('change',()=>emit(inp.value)); return makeRow(lbl,inp)
  }

  function build() {
    panel.innerHTML = ''; if (!_entity) return
    const title = document.createElement('div'); title.textContent = _entity.id; title.style.cssText = 'font-size:10px;color:#666;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; panel.appendChild(title)
    const collRow = document.createElement('div'); collRow.style.marginBottom = '6px'
    const cLbl = document.createElement('span'); cLbl.textContent = 'Collider: '; cLbl.style.color = '#aaa'
    const cSel = document.createElement('select'); cSel.style.cssText = 'background:#333;color:#fff;border:none;padding:2px;font:inherit'
    for (const opt of ['none','box','sphere','convex','trimesh']) { const o = document.createElement('option'); o.value=opt; o.textContent=opt; if ((_entity.custom?._collider||'none')===opt) o.selected=true; cSel.appendChild(o) }
    cSel.addEventListener('change', () => { if (_onChange) _onChange('collider', cSel.value) })
    collRow.appendChild(cLbl); collRow.appendChild(cSel); panel.appendChild(collRow)
    panel.appendChild(makeBodyTypeRow())
    panel.appendChild(makeVec3Group('Position', _entity.position||[0,0,0], 'position'))
    panel.appendChild(makeVec3Group('Rotation (deg)', quatToEulerDeg(_entity.rotation||[0,0,0,1]), '_rotEuler'))
    panel.appendChild(makeVec3Group('Scale', _entity.scale||[1,1,1], 'scale'))
    if (_editorProps.length > 0) {
      const hdr = document.createElement('div'); hdr.textContent='App Props'; hdr.style.cssText='color:#888;font-size:10px;text-transform:uppercase;margin:6px 0 2px'; panel.appendChild(hdr)
      for (const f of _editorProps) panel.appendChild(makePropField(f))
    }
    if (_entity._appName) {
      const btn = document.createElement('button'); btn.textContent='Edit Code'
      btn.style.cssText = 'margin-top:8px;width:100%;background:#335;color:#adf;border:none;padding:6px;border-radius:3px;cursor:pointer;font:inherit;min-height:30px'
      btn.addEventListener('click', () => { if (_onEditCode) _onEditCode(_entity._appName) }); panel.appendChild(btn)
    }
  }

  function quatToEulerDeg([x,y,z,w]) {
    const ex = Math.atan2(2*(w*x+y*z), 1-2*(x*x+y*y)) * 180/Math.PI
    const sinp = 2*(w*y-z*x)
    const ey = (Math.abs(sinp)>=1 ? Math.sign(sinp)*90 : Math.asin(sinp)*180/Math.PI)
    const ez = Math.atan2(2*(w*z+x*y), 1-2*(y*y+z*z)) * 180/Math.PI
    return [ex,ey,ez]
  }

  return {
    show(entity, editorProps) { _entity=entity; _editorProps=editorProps||[]; panel.style.display='block'; build() },
    hide() { panel.style.display='none'; _entity=null },
    update(entity) { _entity=entity; build() },
    setEditorProps(props) { _editorProps=props||[]; if (_entity) build() },
    onChange(fn) { _onChange=fn },
    onEditCode(fn) { _onEditCode=fn },
    get visible() { return panel.style.display!=='none' }
  }
}
