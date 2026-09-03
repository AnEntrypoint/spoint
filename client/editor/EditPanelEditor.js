import { h, applyDiff } from 'anentrypoint-design'
import { showToast } from './EditPanelDOM.js'
import { Btn, Toolbar } from './wm/ui.js'

function _fallback(code, container, onSave) {
  const ta = document.createElement('textarea')
  ta.value = code
  ta.className = 'ds-code-fallback'
  ta.style.cssText = 'width:100%;flex:1;background:var(--panel-0, #1e1e1e);color:var(--panel-text, #d4d4d4);font:12px/1.5 var(--ff-mono, monospace);border:none;padding:12px;box-sizing:border-box;resize:none;outline:none'
  ta.addEventListener('keydown', e => { if ((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();onSave(ta.value)} })
  container.appendChild(ta)
  return { getValue: ()=>ta.value }
}

let _sdkTypingsPromise = null
// The ctx.* SDK surface (src/apps/AppContext.js) has no autocomplete without this -- an app author
// gets zero hint of what methods exist (ctx.world.spawn vs ctx.spawnEntity, etc) and has to read
// source or guess. addExtraLib feeds Monaco's JS language service a real ambient .d.ts so ctx.
// autocompletes like any typed API, even though app files themselves stay plain .js.
function _loadSdkTypings() {
  if (_sdkTypingsPromise) return _sdkTypingsPromise
  _sdkTypingsPromise = fetch('/editor/sdk-typings.d.ts').then(r => r.ok ? r.text() : '').catch(() => '')
  return _sdkTypingsPromise
}

function _monaco(code, container, onSave) {
  return new Promise(res => {
    const mk = () => {
      window.monaco.languages.typescript.javascriptDefaults.setCompilerOptions({ allowNonTsExtensions: true, checkJs: false })
      _loadSdkTypings().then(src => { if (src) window.monaco.languages.typescript.javascriptDefaults.addExtraLib(src, 'file:///sdk-typings.d.ts') })
      const ed = window.monaco.editor.create(container, { value:code, language:'javascript', theme:'vs-dark', fontSize:12, minimap:{enabled:false}, automaticLayout:true, scrollBeyondLastLine:false })
      ed.addCommand(window.monaco.KeyMod.CtrlCmd|window.monaco.KeyCode.KeyS, ()=>onSave(ed.getValue()))
      res(ed)
    }
    if (window.monaco) { mk(); return }
    if (typeof window.require === 'undefined') {
      const s = document.createElement('script')
      s.src = '/node_modules/monaco-editor/min/vs/loader.js'
      s.onload = () => { window.require.config({paths:{vs:'/node_modules/monaco-editor/min/vs'}}); window.require(['vs/editor/editor.main'], mk) }
      s.onerror = () => res(_fallback(code, container, onSave))
      document.head.appendChild(s)
    } else { res(_fallback(code, container, onSave)) }
  })
}

export function renderEditorPane(pane, curApp, curFile, pendingCode, onSave, onBack) {
  pane.innerHTML = ''
  pane.classList.add('ds-ep-panel')
  pane.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0'

  let edRef = null
  let alive = true
  pane._editorPaneDispose = () => {
    alive = false
    if (edRef) { edRef.dispose?.(); edRef = null }
  }
  const doSave = () => {
    if (!edRef) { showToast('Editor not ready', 'error'); return }
    try { onSave(edRef.getValue()); showToast('Saved apps/' + curApp + '/' + curFile) }
    catch (e) { showToast('Save failed: ' + e.message, 'error') }
  }

  const toolbarHost = document.createElement('div')
  pane.appendChild(toolbarHost)
  applyDiff(toolbarHost, [
    Toolbar({
      leading: [
        Btn({ ghost: true, onClick: (e) => { e.preventDefault(); onBack?.() }, children: ['Back'] })
      ],
      children: [h('span', { class: 'ds-ep-propfield-label', style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, 'apps/' + curApp + '/' + curFile)],
      trailing: [
        Btn({ primary: true, onClick: (e) => { e.preventDefault(); doSave() }, children: ['Save (Ctrl+S)'] })
      ]
    })
  ])

  const c = document.createElement('div')
  c.className = 'ds-ep-panel-body flush'
  c.style.cssText = 'flex:1;min-height:0;position:relative'
  pane.appendChild(c)
  _monaco(pendingCode||'', c, (v) => {
    try { onSave(v); showToast('Saved apps/' + curApp + '/' + curFile) }
    catch (e) { showToast('Save failed: ' + e.message, 'error') }
  }).then(ed => {
    // Pane may be torn down before Monaco's lazy load resolves; dispose the orphan instead of leaking it.
    if (!alive) { ed?.dispose?.(); return }
    edRef = ed
  })
}
