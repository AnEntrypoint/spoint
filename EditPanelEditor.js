function _fallback(code, container, onSave) {
  const ta = document.createElement('textarea')
  ta.value = code
  ta.style.cssText = 'width:100%;flex:1;background:#1e1e1e;color:#d4d4d4;font:12px/1.5 monospace;border:none;padding:12px;box-sizing:border-box;resize:none;outline:none'
  ta.addEventListener('keydown', e => { if ((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();onSave(ta.value)} })
  container.appendChild(ta)
  return { getValue: ()=>ta.value }
}

function _monaco(code, container, onSave) {
  return new Promise(res => {
    const mk = () => {
      const ed = window.monaco.editor.create(container, { value:code, language:'javascript', theme:'vs-dark', fontSize:12, minimap:{enabled:false}, automaticLayout:true, scrollBeyondLastLine:false })
      ed.addCommand(window.monaco.KeyMod.CtrlCmd|window.monaco.KeyCode.KeyS, ()=>onSave(ed.getValue()))
      res(ed)
    }
    if (window.monaco) { mk(); return }
    if (typeof window.require === 'undefined') {
      const s = document.createElement('script')
      s.src = '/spoint/node_modules/monaco-editor/min/vs/loader.js'
      s.onload = () => { window.require.config({paths:{vs:'/spoint/node_modules/monaco-editor/min/vs'}}); window.require(['vs/editor/editor.main'], mk) }
      s.onerror = () => res(_fallback(code, container, onSave))
      document.head.appendChild(s)
    } else { res(_fallback(code, container, onSave)) }
  })
}

export function renderEditorPane(pane, curApp, curFile, pendingCode, onSave, onBack) {
  pane.innerHTML = ''
  const bar = document.createElement('div')
  bar.style.cssText = 'display:flex;align-items:center;padding:6px 8px;background:#111;flex-shrink:0;gap:6px'
  const back = document.createElement('button')
  back.textContent = '←'; back.style.cssText = 'background:#252530;color:#adf;border:none;padding:6px 10px;border-radius:3px;cursor:pointer;font:inherit;min-height:32px'
  back.addEventListener('click', onBack)
  const title = document.createElement('span')
  title.textContent = 'apps/'+curApp+'/'+curFile; title.style.cssText = 'flex:1;color:#adf;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
  const sb = document.createElement('button')
  sb.textContent = 'Save (Ctrl+S)'; sb.style.cssText = 'background:#223355;color:#adf;border:none;padding:6px 12px;border-radius:3px;cursor:pointer;font:inherit;min-height:32px;flex-shrink:0'
  let edRef = null
  sb.addEventListener('click', () => { if (edRef) onSave(edRef.getValue()) })
  bar.appendChild(back); bar.appendChild(title); bar.appendChild(sb); pane.appendChild(bar)
  const c = document.createElement('div')
  c.style.cssText = 'flex:1;min-height:0;position:relative'; pane.appendChild(c)
  _monaco(pendingCode||'', c, onSave).then(ed => { edRef = ed; sb.addEventListener('click', ()=>onSave(ed.getValue()), {once:true}) })
}
