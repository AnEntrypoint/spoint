export function createCodeEditor({ onSave }) {
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:10000;display:none;flex-direction:column'
  document.body.appendChild(overlay)

  const toolbar = document.createElement('div')
  toolbar.style.cssText = 'display:flex;align-items:center;padding:8px 12px;background:#1a1a2e;gap:8px;flex-shrink:0'

  const titleEl = document.createElement('span')
  titleEl.style.cssText = 'color:#adf;font:13px monospace;flex:1'
  toolbar.appendChild(titleEl)

  const saveBtn = document.createElement('button')
  saveBtn.textContent = 'Save (Ctrl+S)'
  saveBtn.style.cssText = 'background:#336;color:#adf;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font:13px monospace;min-height:32px'

  const closeBtn = document.createElement('button')
  closeBtn.textContent = 'Close (Esc)'
  closeBtn.style.cssText = 'background:#333;color:#aaa;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font:13px monospace;min-height:32px'

  toolbar.appendChild(saveBtn); toolbar.appendChild(closeBtn)
  overlay.appendChild(toolbar)

  const editorContainer = document.createElement('div')
  editorContainer.style.cssText = 'flex:1;min-height:0;position:relative'
  overlay.appendChild(editorContainer)

  let monacoEditor = null, textarea = null
  let currentAppName = null

  function getValue() {
    if (monacoEditor) return monacoEditor.getValue()
    if (textarea) return textarea.value
    return ''
  }

  function setValue(code) {
    if (monacoEditor) { monacoEditor.setValue(code); return }
    if (textarea) { textarea.value = code; return }
    _pendingCode = code
  }

  let _pendingCode = null

  function initMonaco(code) {
    if (typeof window.require === 'undefined') {
      const script = document.createElement('script')
      script.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs/loader.js'
      script.onload = () => {
        window.require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs' } })
        window.require(['vs/editor/editor.main'], () => {
          monacoEditor = window.monaco.editor.create(editorContainer, {
            value: code, language: 'javascript', theme: 'vs-dark',
            fontSize: 13, minimap: { enabled: false }, automaticLayout: true,
            scrollBeyondLastLine: false
          })
          monacoEditor.addCommand(window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.KeyS, () => doSave())
        })
      }
      script.onerror = () => fallbackTextarea(code)
      document.head.appendChild(script)
    } else if (window.monaco) {
      monacoEditor = window.monaco.editor.create(editorContainer, {
        value: code, language: 'javascript', theme: 'vs-dark',
        fontSize: 13, minimap: { enabled: false }, automaticLayout: true,
        scrollBeyondLastLine: false
      })
      monacoEditor.addCommand(window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.KeyS, () => doSave())
    } else {
      fallbackTextarea(code)
    }
  }

  function fallbackTextarea(code) {
    textarea = document.createElement('textarea')
    textarea.value = code
    textarea.style.cssText = 'width:100%;height:100%;background:#1e1e1e;color:#d4d4d4;font:13px/1.5 monospace;border:none;padding:12px;box-sizing:border-box;resize:none;outline:none'
    textarea.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); doSave() } })
    editorContainer.appendChild(textarea)
  }

  function doSave() {
    if (onSave) onSave(currentAppName, getValue())
  }

  function open(appName, code) {
    currentAppName = appName
    titleEl.textContent = 'apps/' + appName + '/index.js'
    overlay.style.display = 'flex'
    if (!monacoEditor && !textarea) {
      initMonaco(code)
    } else {
      setValue(code)
    }
  }

  function close() {
    overlay.style.display = 'none'
  }

  saveBtn.addEventListener('click', doSave)
  closeBtn.addEventListener('click', close)
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.style.display !== 'none') close() })

  return { open, close }
}
