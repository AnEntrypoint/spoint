export function createEditPanel({ onPlace, onSave, onEntitySelect, onGetSource }) {
  const panel = document.createElement('div')
  panel.style.cssText = 'position:fixed;top:0;left:0;width:320px;height:100vh;background:rgba(14,14,20,0.96);color:#eee;font:12px/1.5 monospace;z-index:9000;display:none;flex-direction:column;user-select:none;border-right:1px solid #222'
  document.body.appendChild(panel)
  const hint = document.createElement('div')
  hint.textContent = '[P] Edit'; hint.style.cssText = 'position:fixed;bottom:12px;left:12px;color:#444;font:11px monospace;z-index:8999;pointer-events:none'
  document.body.appendChild(hint)

  let _tab='scene',_apps=[],_filt='',_entity=null,_eProps=[],_monacoEd=null,_ta=null,_curApp=null,_entities=[],_selId=null,_onChange=null

  const tabs=document.createElement('div'); tabs.style.cssText='display:flex;border-bottom:1px solid #333;flex-shrink:0'; panel.appendChild(tabs)
  const panes={}
  for(const id of ['scene','apps','code']){
    const btn=document.createElement('button'); btn.textContent=id[0].toUpperCase()+id.slice(1)
    btn.style.cssText='flex:1;background:none;color:#888;border:none;padding:10px 0;cursor:pointer;font:inherit;min-height:44px;border-bottom:2px solid transparent'
    btn.addEventListener('click',()=>_switchTab(id)); tabs.appendChild(btn)
    const pane=document.createElement('div'); pane.style.cssText='flex:1;overflow-y:auto;display:none;flex-direction:column;min-height:0'; panel.appendChild(pane)
    panes[id]={btn,pane}
  }

  function _switchTab(id){
    _tab=id
    for(const[k,{btn,pane}]of Object.entries(panes)){const a=k===id;btn.style.color=a?'#adf':'#888';btn.style.borderBottomColor=a?'#adf':'transparent';pane.style.display=a?'flex':'none'}
    if(id==='scene')_rScene(); if(id==='apps')_rApps()
  }

  function _drag(label,value,onChange){
    const row=document.createElement('div');row.style.cssText='display:flex;align-items:center;margin:2px 0'
    const lbl=document.createElement('span');lbl.textContent=label+':';lbl.style.cssText='width:30px;color:#aaa;flex-shrink:0'
    const inp=document.createElement('input');inp.type='text';inp.value=typeof value==='number'?value.toFixed(3):value
    inp.style.cssText='flex:1;background:#252530;border:none;color:#fff;padding:2px 4px;border-radius:3px;cursor:ew-resize;font:inherit'
    let d=false,sx=0,sv=0
    inp.addEventListener('mousedown',e=>{if(document.activeElement===inp)return;d=true;sx=e.clientX;sv=parseFloat(inp.value)||0;e.preventDefault()})
    window.addEventListener('mousemove',e=>{if(!d)return;const v=sv+(e.clientX-sx)*0.01;inp.value=v.toFixed(3);onChange(v)})
    window.addEventListener('mouseup',()=>{d=false})
    inp.addEventListener('change',()=>onChange(parseFloat(inp.value)||0))
    row.appendChild(lbl);row.appendChild(inp);return row
  }

  function _v3(label,vals,key){
    const g=document.createElement('div');g.style.marginBottom='4px'
    const h=document.createElement('div');h.textContent=label;h.style.cssText='color:#888;font-size:10px;text-transform:uppercase;margin-bottom:2px';g.appendChild(h)
    ;['x','y','z'].forEach((ax,i)=>g.appendChild(_drag(ax,vals[i]||0,v=>{if(!_entity||!_onChange)return;const c=_entity[key]?[..._entity[key]]:[0,0,0];c[i]=v;_onChange(key,c)})))
    return g
  }

  function _q2e([x,y,z,w]){
    return [Math.atan2(2*(w*x+y*z),1-2*(x*x+y*y))*180/Math.PI,(v=>Math.abs(v)>=1?Math.sign(v)*90:Math.asin(v)*180/Math.PI)(2*(w*y-z*x)),Math.atan2(2*(w*z+x*y),1-2*(y*y+z*z))*180/Math.PI]
  }

  function _rScene(){
    const pane=panes.scene.pane; pane.innerHTML=''
    const tree=document.createElement('div');tree.style.cssText='padding:6px;border-bottom:1px solid #222;overflow-y:auto;max-height:40vh'
    if(!_entities.length){const e=document.createElement('div');e.textContent='No entities';e.style.color='#555';tree.appendChild(e)}
    for(const n of _entities)tree.appendChild(_node(n,0))
    pane.appendChild(tree); if(_entity)_rProps(pane)
  }

  function _node(node,depth){
    const wrap=document.createElement('div')
    const row=document.createElement('div');row.style.cssText=`display:flex;align-items:center;padding:4px;cursor:pointer;border-radius:3px;padding-left:${8+depth*12}px;min-height:30px`
    row.style.background=node.id===_selId?'#335':'transparent'
    const lbl=document.createElement('span');lbl.textContent=node.label||node.appName||node.id;lbl.style.cssText='flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    const tag=document.createElement('span');tag.textContent=node.appName||'';tag.style.cssText='color:#555;font-size:10px;flex-shrink:0;margin-left:4px'
    row.appendChild(lbl);row.appendChild(tag)
    row.addEventListener('click',()=>{_selId=node.id;if(onEntitySelect)onEntitySelect(node.id);_rScene()})
    row.addEventListener('mouseenter',()=>{if(node.id!==_selId)row.style.background='#1e1e2e'})
    row.addEventListener('mouseleave',()=>{row.style.background=node.id===_selId?'#335':'transparent'})
    wrap.appendChild(row)
    if(node.children?.length){const cw=document.createElement('div');for(const c of node.children)cw.appendChild(_node(c,depth+1));wrap.appendChild(cw)}
    return wrap
  }

  function _rProps(pane){
    if(!_entity)return
    const props=document.createElement('div');props.style.cssText='padding:8px;flex:1;overflow-y:auto'
    const title=document.createElement('div');title.textContent=_entity.id;title.style.cssText='color:#555;font-size:10px;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';props.appendChild(title)
    const bw=document.createElement('div');bw.style.marginBottom='6px'
    const bl=document.createElement('div');bl.textContent='Body Type';bl.style.cssText='color:#888;font-size:10px;text-transform:uppercase;margin-bottom:2px';bw.appendChild(bl)
    const br=document.createElement('div');br.style.cssText='display:flex;gap:4px'
    for(const bt of ['static','dynamic','kinematic']){
      const btn=document.createElement('button');btn.textContent=bt
      btn.style.cssText=`flex:1;background:${(_entity.bodyType||'static')===bt?'#334466':'#252530'};color:#fff;border:none;padding:4px 0;border-radius:3px;cursor:pointer;font:inherit;min-height:32px`
      btn.addEventListener('click',()=>{if(_onChange)_onChange('bodyType',bt);br.querySelectorAll('button').forEach(b=>b.style.background='#252530');btn.style.background='#334466'})
      br.appendChild(btn)
    }
    bw.appendChild(br);props.appendChild(bw)
    props.appendChild(_v3('Position',_entity.position||[0,0,0],'position'))
    props.appendChild(_v3('Rotation (deg)',_q2e(_entity.rotation||[0,0,0,1]),'_rotEuler'))
    props.appendChild(_v3('Scale',_entity.scale||[1,1,1],'scale'))
    if(_eProps.length){const eh=document.createElement('div');eh.textContent='App Props';eh.style.cssText='color:#888;font-size:10px;text-transform:uppercase;margin:6px 0 2px';props.appendChild(eh);for(const f of _eProps)props.appendChild(_propField(f))}
    if(_entity._appName){const btn=document.createElement('button');btn.textContent='Edit Code';btn.style.cssText='margin-top:8px;width:100%;background:#223355;color:#adf;border:none;padding:8px;border-radius:3px;cursor:pointer;font:inherit;min-height:44px';btn.addEventListener('click',()=>{if(onGetSource)onGetSource(_entity._appName)});props.appendChild(btn)}
    pane.appendChild(props)
  }

  function _propField(f){
    const key=f.key,lbl=f.label||f.key,val=_entity?.custom?.[key]??f.default??(f.type==='number'?0:'')
    const emit=v=>{if(_onChange)_onChange('custom.'+key,v)}
    if(f.type==='number')return _drag(lbl,val,emit)
    const row=document.createElement('div');row.style.cssText='display:flex;align-items:center;margin:2px 0;gap:4px'
    const l=document.createElement('span');l.textContent=lbl+':';l.style.cssText='color:#aaa;flex-shrink:0;min-width:60px';row.appendChild(l)
    if(f.type==='color'){const i=document.createElement('input');i.type='color';i.value=val||'#fff';i.style.cssText='flex:1;border:none;height:32px;cursor:pointer';i.addEventListener('change',()=>emit(i.value));row.appendChild(i)}
    else if(f.type==='checkbox'){const i=document.createElement('input');i.type='checkbox';i.checked=!!val;i.addEventListener('change',()=>emit(i.checked));row.insertBefore(i,row.firstChild)}
    else if(f.type==='select'&&f.options){const s=document.createElement('select');s.style.cssText='flex:1;background:#252530;color:#fff;border:none;padding:2px;font:inherit';for(const o of f.options){const op=document.createElement('option');op.value=o;op.textContent=o;if(val===o)op.selected=true;s.appendChild(op)};s.addEventListener('change',()=>emit(s.value));row.appendChild(s)}
    else{const i=document.createElement('input');i.type='text';i.value=val;i.style.cssText='flex:1;background:#252530;border:none;color:#fff;padding:2px 4px;border-radius:3px;font:inherit';i.addEventListener('change',()=>emit(i.value));row.appendChild(i)}
    return row
  }

  function _rApps(){
    const pane=panes.apps.pane; pane.innerHTML=''
    const fi=document.createElement('input');fi.type='text';fi.placeholder='Filter apps...';fi.value=_filt
    fi.style.cssText='margin:8px;background:#252530;border:none;color:#fff;padding:6px 8px;border-radius:3px;font:inherit;box-sizing:border-box;width:calc(100% - 16px)'
    fi.addEventListener('input',()=>{_filt=fi.value.toLowerCase();_rApps()});pane.appendChild(fi)
    const list=document.createElement('div');list.style.cssText='flex:1;overflow-y:auto;padding:0 8px 8px'
    const filtered=_apps.filter(a=>a.name.toLowerCase().includes(_filt)||(a.description||'').toLowerCase().includes(_filt))
    if(!filtered.length){const e=document.createElement('div');e.textContent=_apps.length?'No match':'Loading...';e.style.color='#555';list.appendChild(e)}
    for(const app of filtered){
      const row=document.createElement('div');row.style.cssText='padding:8px;cursor:pointer;border-radius:3px;margin-bottom:2px;min-height:44px;display:flex;flex-direction:column;justify-content:center'
      row.addEventListener('mouseenter',()=>row.style.background='#1e1e2e');row.addEventListener('mouseleave',()=>row.style.background='transparent')
      row.addEventListener('click',()=>{if(onPlace)onPlace(app.name)})
      const name=document.createElement('div');name.textContent=app.name+(app.hasEditorProps?' *':'');name.style.cssText='color:#adf;font-weight:bold';row.appendChild(name)
      if(app.description){const d=document.createElement('div');d.textContent=app.description;d.style.cssText='color:#666;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';row.appendChild(d)}
      list.appendChild(row)
    }
    pane.appendChild(list)
  }

  function _initEditor(code,container){
    const mk=(c)=>{ _monacoEd=window.monaco.editor.create(container,{value:c,language:'javascript',theme:'vs-dark',fontSize:12,minimap:{enabled:false},automaticLayout:true,scrollBeyondLastLine:false}); _monacoEd.addCommand(window.monaco.KeyMod.CtrlCmd|window.monaco.KeyCode.KeyS,()=>_doSave()) }
    if(typeof window.require==='undefined'){const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs/loader.js';s.onload=()=>{window.require.config({paths:{vs:'https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs'}});window.require(['vs/editor/editor.main'],()=>mk(code))};s.onerror=()=>_fb(code,container);document.head.appendChild(s)}
    else if(window.monaco)mk(code); else _fb(code,container)
  }

  function _fb(code,container){ _ta=document.createElement('textarea');_ta.value=code;_ta.style.cssText='width:100%;flex:1;background:#1e1e1e;color:#d4d4d4;font:12px/1.5 monospace;border:none;padding:12px;box-sizing:border-box;resize:none;outline:none';_ta.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();_doSave()}});container.appendChild(_ta) }

  function _doSave(){ const val=_monacoEd?_monacoEd.getValue():_ta?_ta.value:''; if(onSave&&_curApp)onSave(_curApp,val) }

  return {
    show(){ panel.style.display='flex'; _switchTab(_tab) },
    hide(){ panel.style.display='none' },
    toggle(){ panel.style.display==='none'?(panel.style.display='flex',_switchTab(_tab)):panel.style.display='none' },
    updateApps(apps){ _apps=apps||[]; if(_tab==='apps')_rApps() },
    updateScene(entities){ _entities=entities||[]; if(_tab==='scene')_rScene() },
    showEntity(entity,editorProps){ _entity=entity;_eProps=editorProps||[];_selId=entity?.id; if(_tab==='scene')_rScene() },
    openCode(appName,code){
      _curApp=appName; _monacoEd=null; _ta=null
      const pane=panes.code.pane; pane.innerHTML=''
      const bar=document.createElement('div');bar.style.cssText='display:flex;align-items:center;padding:6px 8px;background:#111;flex-shrink:0;gap:6px'
      const title=document.createElement('span');title.textContent='apps/'+appName+'/index.js';title.style.cssText='flex:1;color:#adf;font-size:11px';bar.appendChild(title)
      const sb=document.createElement('button');sb.textContent='Save (Ctrl+S)';sb.style.cssText='background:#223355;color:#adf;border:none;padding:6px 12px;border-radius:3px;cursor:pointer;font:inherit;min-height:32px';sb.addEventListener('click',_doSave);bar.appendChild(sb)
      pane.appendChild(bar)
      const c=document.createElement('div');c.style.cssText='flex:1;min-height:0;position:relative';pane.appendChild(c)
      _initEditor(code,c); _switchTab('code')
    },
    onEditorChange(fn){ _onChange=fn },
    get visible(){ return panel.style.display!=='none' }
  }
}
