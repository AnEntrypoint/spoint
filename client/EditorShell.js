import { createSceneHierarchy } from './SceneHierarchy.js'
import { createEditorInspector } from './EditorInspector.js'
import { createEditorApps } from './EditorApps.js'
import { createHookFlowViewer } from './HookFlowViewer.js'
import { MSG } from '/src/protocol/MessageTypes.js'

const D = {
  overlay: 'position:fixed;inset:0;z-index:9000;pointer-events:none;display:none;font:12px/1.4 monospace',
  top: 'position:absolute;top:0;left:0;right:0;height:40px;background:#050c0a;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:8px;padding:0 12px;pointer-events:all;z-index:2;user-select:none',
  left: 'position:absolute;top:40px;left:0;bottom:24px;width:250px;background:#050c0a;border-right:1px solid rgba(255,255,255,0.06);display:flex;flex-direction:column;pointer-events:all;overflow:hidden',
  right: 'position:absolute;top:40px;right:0;bottom:24px;width:300px;background:#050c0a;border-left:1px solid rgba(255,255,255,0.06);display:flex;flex-direction:column;pointer-events:all;overflow:hidden',
  bot: 'position:absolute;bottom:0;left:0;right:0;height:24px;background:rgba(5,12,10,0.9);border-top:1px solid rgba(255,255,255,0.05);display:flex;align-items:center;padding:0 12px;justify-content:space-between;pointer-events:all',
  tabs: 'display:flex;border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0',
  tab: (a) => 'flex:1;background:none;border:none;border-bottom:2px solid '+(a?'#10b981':'transparent')+';color:'+(a?'#34d399':'rgba(255,255,255,0.45)')+';padding:10px 0;cursor:pointer;font:11px/1 monospace;letter-spacing:0.05em',
  topBtn: 'background:none;border:none;color:rgba(255,255,255,0.6);cursor:pointer;font:11px monospace;padding:4px 8px;border-radius:6px',
  grp: 'display:flex;align-items:center;gap:1px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);border-radius:8px;overflow:hidden;margin-right:4px',
  grpLbl: 'padding:0 7px;font:8px/1 monospace;color:rgba(255,255,255,0.28);text-transform:uppercase;letter-spacing:0.1em;border-right:1px solid rgba(255,255,255,0.06)',
  grpBtn: (a) => 'width:28px;height:28px;background:'+(a?'rgba(16,185,129,0.18)':'none')+';border:none;color:'+(a?'#34d399':'rgba(255,255,255,0.55)')+';cursor:pointer;font:10px monospace',
  statusTxt: 'font:10px/1 monospace;color:rgba(255,255,255,0.45);white-space:nowrap',
  hints: 'font:10px/1 monospace;color:rgba(255,255,255,0.25);white-space:nowrap'
}

const TABS = ['Inspector','Apps','HookFlow']

export function createEditPanel({ onPlace, onSave, onEntitySelect, onGetSource, onGetAppFiles, onDestroyEntity, onCreateApp } = {}) {
  const overlay = document.createElement('div'); overlay.style.cssText = D.overlay; document.body.appendChild(overlay)

  const topBar = document.createElement('div'); topBar.style.cssText = D.top
  const leftBar = document.createElement('div'); leftBar.style.cssText = D.left
  const rightBar = document.createElement('div'); rightBar.style.cssText = D.right
  const botBar = document.createElement('div'); botBar.style.cssText = D.bot
  overlay.append(topBar, leftBar, rightBar, botBar)

  const tabsEl = document.createElement('div'); tabsEl.style.cssText = D.tabs; rightBar.appendChild(tabsEl)
  const tabBodies = {}
  for (const t of TABS) {
    const btn = document.createElement('button'); btn.textContent = t; btn.style.cssText = D.tab(t === 'Inspector')
    btn.addEventListener('click', () => _switchTab(t)); tabsEl.appendChild(btn)
    const body = document.createElement('div'); body.style.cssText = 'flex:1;min-height:0;overflow:hidden;display:'+(t==='Inspector'?'flex':'none')+';flex-direction:column'
    rightBar.appendChild(body); tabBodies[t] = { btn, body }
  }

  const inspDiv = document.createElement('div'); inspDiv.style.cssText = 'flex:1;overflow-y:auto'; tabBodies.Inspector.body.appendChild(inspDiv)
  const appsDiv = tabBodies.Apps.body
  const hfDiv = tabBodies.HookFlow.body

  const hierarchy = createSceneHierarchy(leftBar, {
    onSelect: id => { onEntitySelect?.(id) },
    onFocus: id => { onEntitySelect?.(id) },
    onDelete: id => onDestroyEntity?.(id)
  })

  const inspector = createEditorInspector(inspDiv, {
    onDestroyEntity: id => onDestroyEntity?.(id),
    onEditCode: name => _switchTab('Apps')
  })
  inspector.onEditorChange((key, val) => _onChange?.(key, val))

  const appsPanel = createEditorApps(appsDiv, { onPlace, onSave, onGetSource, onGetAppFiles, onCreateApp })

  const hfViewer = createHookFlowViewer(hfDiv)
  hfViewer.onNodeClick(id => { onEntitySelect?.(id); hierarchy.setSelected(id) })

  let _tab = 'Inspector', _onChange = null, _selState = {}, _entities = []

  function _switchTab(t) {
    _tab = t
    for (const [name, { btn, body }] of Object.entries(tabBodies)) {
      btn.style.cssText = D.tab(name === t)
      body.style.display = name === t ? 'flex' : 'none'
      if (name === 'HookFlow' && name === t) hfViewer.updateGraph(_entities)
    }
  }

  _buildTopBar(); _buildBotBar()

  function _buildTopBar() {
    const logo = document.createElement('span'); logo.textContent = '◈ spoint editor'; logo.style.cssText = 'color:rgba(16,185,129,0.8);font:11px/1 monospace;font-weight:700;margin-right:8px'
    const sep = () => { const d = document.createElement('div'); d.style.cssText = 'width:1px;height:18px;background:rgba(255,255,255,0.07);margin:0 4px'; return d }
    const grp = (label, items) => {
      const g = document.createElement('div'); g.style.cssText = D.grp
      const l = document.createElement('span'); l.textContent = label; l.style.cssText = D.grpLbl; g.appendChild(l)
      for (const [icon, title, cb] of items) { const b = document.createElement('button'); b.textContent = icon; b.title = title; b.style.cssText = D.grpBtn(false); b.addEventListener('click', cb); g.appendChild(b) }
      return g
    }
    topBar.append(logo, sep(),
      grp('Create', [
        ['⬜','Box', () => {}], ['⬡','Sphere', () => {}], ['⬣','Cylinder', () => {}]
      ]),
      grp('Light', [
        ['✦','Point Light', () => {}], ['⊙','Spot Light', () => {}], ['☀','Directional', () => {}]
      ]),
      grp('Model', [
        ['↑','Import GLB', () => {}], ['⊕','Place App', () => {}]
      ])
    )
  }

  function _buildBotBar() {
    const left = document.createElement('span'); left.style.cssText = D.statusTxt; left.textContent = 'Ready'
    const right = document.createElement('span'); right.style.cssText = D.hints; right.textContent = '[G] Translate  [R] Rotate  [S] Scale  [F] Focus  [Del] Delete'
    botBar.append(left, right)
    overlay._statusLeft = left
  }

  return {
    show() { overlay.style.display = 'block' },
    hide() { overlay.style.display = 'none' },
    toggle() { overlay.style.display = overlay.style.display === 'none' ? 'block' : 'none' },
    updateApps(apps) { appsPanel.setApps(apps) },
    updateScene(entities) { _entities = entities || []; hierarchy.updateEntities(entities) },
    showEntity(entity, eProps) {
      inspector.showEntity(entity, eProps); hierarchy.setSelected(entity?.id || null)
      if (overlay._statusLeft) overlay._statusLeft.textContent = entity ? 'sel: ' + entity.id : 'Ready'
    },
    updateAppFiles(name, files) { appsPanel.setAppFiles(name, files) },
    openCode(app, file, code) { appsPanel.openCode(app, file, code); _switchTab('Apps') },
    onEditorChange(fn) { _onChange = fn },
    get visible() { return overlay.style.display !== 'none' },
    get selectedEntity() { return inspector.selectedEntity }
  }
}
