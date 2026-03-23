import { drag, v3, propField } from './EditPanelDOM.js'

const S = {
  root: 'flex:1;overflow-y:auto;padding:8px;font:12px/1.4 monospace',
  id: 'color:rgba(255,255,255,0.35);font-size:10px;margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 0',
  label: 'color:rgba(255,255,255,0.4);font-size:10px;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:3px;margin-top:8px',
  btns: 'display:flex;gap:3px;margin-bottom:4px',
  btn: (a) => 'flex:1;background:'+(a?'rgba(51,68,102,0.8)':'rgba(255,255,255,0.05)')+';border:1px solid rgba(255,255,255,0.08);color:#fff;padding:5px 0;border-radius:6px;cursor:pointer;font:11px monospace',
  editBtn: 'margin-top:10px;width:100%;background:rgba(34,51,85,0.8);color:#adf;border:none;padding:8px;border-radius:6px;cursor:pointer;font:12px monospace',
  delBtn: 'margin-top:5px;width:100%;background:rgba(51,17,17,0.8);color:#f88;border:1px solid rgba(82,34,34,0.8);padding:8px;border-radius:6px;cursor:pointer;font:12px monospace'
}

function q2e([x,y,z,w]) {
  return [Math.atan2(2*(w*x+y*z),1-2*(x*x+y*y))*180/Math.PI,(v=>Math.abs(v)>=1?Math.sign(v)*90:Math.asin(v)*180/Math.PI)(2*(w*y-z*x)),Math.atan2(2*(w*z+x*y),1-2*(y*y+z*z))*180/Math.PI]
}

export function createEditorInspector(container, { onDestroyEntity, onEditCode } = {}) {
  let _entity = null, _eProps = [], _onChange = null

  function render() {
    container.innerHTML = ''
    if (!_entity) { container.style.cssText = S.root; container.textContent = 'Select an entity'; return }
    container.style.cssText = S.root

    const idEl = document.createElement('div'); idEl.textContent = _entity.id; idEl.style.cssText = S.id; container.appendChild(idEl)

    const btLabel = document.createElement('div'); btLabel.textContent = 'Body Type'; btLabel.style.cssText = S.label; container.appendChild(btLabel)
    const btRow = document.createElement('div'); btRow.style.cssText = S.btns
    for (const bt of ['static','dynamic','kinematic']) {
      const b = document.createElement('button'); b.textContent = bt; b.style.cssText = S.btn((_entity.bodyType||'static')===bt)
      b.addEventListener('click', () => { _onChange?.('bodyType', bt); render() }); btRow.appendChild(b)
    }
    container.appendChild(btRow)

    const getEnt = () => _entity, getCb = () => _onChange
    container.appendChild(v3('Position', _entity.position || [0,0,0], 'position', getEnt, getCb))
    container.appendChild(v3('Rotation (deg)', q2e(_entity.rotation || [0,0,0,1]), '_rotEuler', getEnt, getCb))
    container.appendChild(v3('Scale', _entity.scale || [1,1,1], 'scale', getEnt, getCb))

    if (_eProps.length) {
      const ph = document.createElement('div'); ph.textContent = 'App Props'; ph.style.cssText = S.label; container.appendChild(ph)
      for (const f of _eProps) container.appendChild(propField(f, getEnt, getCb))
    }

    if (_entity._appName) {
      const eb = document.createElement('button'); eb.textContent = 'Edit Code'; eb.style.cssText = S.editBtn
      eb.addEventListener('click', () => onEditCode?.(_entity._appName)); container.appendChild(eb)
    }

    const db = document.createElement('button'); db.textContent = 'Delete Entity'; db.style.cssText = S.delBtn
    db.addEventListener('click', () => { if (onDestroyEntity && _entity) { onDestroyEntity(_entity.id); _entity = null; render() } })
    container.appendChild(db)
  }

  return {
    showEntity(entity, eProps) { _entity = entity; _eProps = eProps || []; render() },
    onEditorChange(cb) { _onChange = cb },
    clearEntity() { _entity = null; render() },
    get selectedEntity() { return _entity }
  }
}
