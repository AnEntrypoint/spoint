export function createInspector() {
  const panel = document.createElement('div')
  panel.style.cssText = 'position:fixed;top:12px;right:12px;width:220px;background:rgba(20,20,20,0.92);color:#eee;font:12px/1.5 monospace;padding:10px;border-radius:6px;z-index:9999;display:none;user-select:none'
  document.body.appendChild(panel)

  let _onChange = null
  let _entity = null
  let _extraFields = []

  function dragField(label, value, onChange) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;margin:2px 0'
    const lbl = document.createElement('span')
    lbl.textContent = label + ':'
    lbl.style.cssText = 'width:30px;color:#aaa;flex-shrink:0'
    const inp = document.createElement('input')
    inp.type = 'text'
    inp.value = typeof value === 'number' ? value.toFixed(3) : value
    inp.style.cssText = 'flex:1;background:#333;border:none;color:#fff;padding:1px 4px;border-radius:3px;cursor:ew-resize;font:inherit'
    let dragging = false, startX = 0, startVal = 0
    inp.addEventListener('mousedown', e => {
      if (document.activeElement === inp) return
      dragging = true; startX = e.clientX; startVal = parseFloat(inp.value) || 0
      e.preventDefault()
    })
    window.addEventListener('mousemove', e => {
      if (!dragging) return
      const v = startVal + (e.clientX - startX) * 0.01
      inp.value = v.toFixed(3)
      onChange(v)
    })
    window.addEventListener('mouseup', () => { dragging = false })
    inp.addEventListener('change', () => { onChange(parseFloat(inp.value) || 0) })
    row.appendChild(lbl); row.appendChild(inp)
    return { row, inp }
  }

  function makeVec3Group(label, vals, key) {
    const grp = document.createElement('div')
    grp.style.marginBottom = '4px'
    const hdr = document.createElement('div')
    hdr.textContent = label
    hdr.style.cssText = 'color:#888;font-size:10px;text-transform:uppercase;margin-bottom:2px'
    grp.appendChild(hdr)
    const axes = ['x', 'y', 'z']
    const inputs = {}
    axes.forEach((ax, i) => {
      const { row, inp } = dragField(ax, vals[i] || 0, v => {
        if (!_entity || !_onChange) return
        const cur = _entity[key] ? [..._entity[key]] : [0, 0, 0]
        cur[i] = v
        _onChange(key, cur)
      })
      inputs[ax] = inp
      grp.appendChild(row)
    })
    grp.update = (vals) => axes.forEach((ax, i) => { inputs[ax].value = (vals[i] || 0).toFixed(3) })
    return grp
  }

  function build() {
    panel.innerHTML = ''
    if (!_entity) return

    const title = document.createElement('div')
    title.textContent = _entity.id
    title.style.cssText = 'font-size:10px;color:#666;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    panel.appendChild(title)

    const collRow = document.createElement('div')
    collRow.style.marginBottom = '6px'
    const collLbl = document.createElement('span')
    collLbl.textContent = 'Collider: '
    collLbl.style.color = '#aaa'
    const sel = document.createElement('select')
    sel.style.cssText = 'background:#333;color:#fff;border:none;padding:2px;font:inherit'
    for (const opt of ['none', 'box', 'sphere', 'convex', 'trimesh']) {
      const o = document.createElement('option')
      o.value = opt; o.textContent = opt
      if ((_entity.custom?._collider || 'none') === opt) o.selected = true
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => {
      if (_onChange) _onChange('collider', sel.value)
    })
    collRow.appendChild(collLbl); collRow.appendChild(sel)
    panel.appendChild(collRow)

    const posGrp = makeVec3Group('Position', _entity.position || [0,0,0], 'position')
    panel.appendChild(posGrp)

    const rot = _entity.rotation || [0,0,0,1]
    const euler = quatToEulerDeg(rot)
    const rotGrp = makeVec3Group('Rotation (deg)', euler, '_rotEuler')
    panel._rotGrp = rotGrp
    panel.appendChild(rotGrp)

    const scaleGrp = makeVec3Group('Scale', _entity.scale || [1,1,1], 'scale')
    panel.appendChild(scaleGrp)

    for (const f of _extraFields) {
      const { row } = dragField(f.label, _entity.custom?.[f.key] ?? f.default ?? 0, v => {
        if (_onChange) _onChange('custom.' + f.key, v)
      })
      panel.appendChild(row)
    }
  }

  function quatToEulerDeg([x, y, z, w]) {
    const sinr = 2*(w*x+y*z), cosr = 1-2*(x*x+y*y)
    const ex = Math.atan2(sinr, cosr) * 180/Math.PI
    const sinp = 2*(w*y-z*x)
    const ey = Math.abs(sinp)>=1 ? Math.sign(sinp)*90 : Math.asin(sinp)*180/Math.PI
    const siny = 2*(w*z+x*y), cosy = 1-2*(y*y+z*z)
    const ez = Math.atan2(siny, cosy) * 180/Math.PI
    return [ex, ey, ez]
  }

  return {
    show(entity) {
      _entity = entity
      panel.style.display = 'block'
      build()
    },
    hide() { panel.style.display = 'none'; _entity = null },
    update(entity) { _entity = entity; build() },
    setSchema(fields) { _extraFields = fields; if (_entity) build() },
    onChange(fn) { _onChange = fn },
    get visible() { return panel.style.display !== 'none' }
  }
}
