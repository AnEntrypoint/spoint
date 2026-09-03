import { components as C, h, applyDiff } from 'anentrypoint-design'
import { showToast, showConfirm } from './EditPanelDOM.js'
import { getSharedWM, promptText, Btn, Toolbar, SearchInput, EmptyState } from './wm/ui.js'

export function createPrefabPanel(container, { onSave, onInstantiate, onDelete, getPrefabs, getSelectedEntities } = {}) {
  let _prefabs = [], _filt = '', _selectedIds = new Set()

  container.classList.add('ds-ep-panel')

  let _toolbarHost = null, _listHost = null
  function _ensureHosts() {
    if (_toolbarHost && _toolbarHost.isConnected) return
    container.innerHTML = ''
    _toolbarHost = document.createElement('div')
    _listHost = document.createElement('div')
    _listHost.className = 'ds-ep-tree'
    _listHost.style.cssText = 'flex:1;min-height:0;overflow-y:auto'
    container.append(_toolbarHost, _listHost)
    renderToolbar()
  }

  function renderToolbar() {
    const mkSearch = () => SearchInput({
      value: _filt,
      placeholder: 'Filter prefabs...',
      onInput: v => { _filt = (v || '').toLowerCase(); renderList() }
    })
    const mkSave = () => Btn({
      primary: true,
      dense: true,
      onClick: async (e) => {
        e.preventDefault()
        const selected = getSelectedEntities?.() || []
        if (!selected || selected.length === 0) {
          showToast('Select entities to save as prefab', 'error')
          return
        }
        try {
          const name = await promptPrefabName(_getExistingNames())
          if (!name) return
          const existing = _prefabs.find(p => p.name === name)
          if (existing) {
            const confirmed = await showConfirm({
              title: 'Overwrite Prefab?',
              message: `Prefab "${name}" already exists. Overwrite it?`,
              confirmLabel: 'Overwrite'
            })
            if (!confirmed) return
          }
          const metadata = {
            createdDate: existing?.metadata?.createdDate || new Date().toISOString(),
            modifiedDate: new Date().toISOString(),
            description: existing?.metadata?.description || '',
            entityCount: selected.length
          }
          onSave?.(name, selected, metadata)
          showToast(`Prefab "${name}" saved`)
          _refreshList()
        } catch (e) {
          showToast(`Failed to save prefab: ${e.message}`, 'error')
        }
      },
      children: ['Save Selection']
    })
    const toolbar = Toolbar({
      children: [
        h('div', { class: 'ds-ed-bar-grow' }, mkSearch()),
        mkSave()
      ]
    })
    applyDiff(_toolbarHost, [toolbar])
  }

  function _getExistingNames() {
    return (_prefabs || []).map(p => p.name)
  }

  function _refreshList() {
    _prefabs = getPrefabs?.() || []
    renderList()
  }

  function renderList() {
    _ensureHosts()
    if (!_prefabs || _prefabs.length === 0) {
      applyDiff(_listHost, [EmptyState({ text: 'No prefabs yet. Save a selection to create one.' })])
      return
    }
    const filtered = _prefabs.filter(p => !_filt || p.name.toLowerCase().includes(_filt))
    if (filtered.length === 0) {
      applyDiff(_listHost, [EmptyState({ text: 'No prefabs matching filter' })])
      return
    }
    const items = filtered.map(p => _prefabRow(p))
    applyDiff(_listHost, items)
  }

  function _prefabRow(prefab) {
    const item = document.createElement('div')
    item.className = 'ds-ep-tree-item'
    const row = document.createElement('div')
    row.className = 'ds-ep-tree-row'
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 6px'

    const icon = document.createElement('span')
    icon.style.cssText = 'display:inline-flex;width:20px;height:20px;align-items:center;justify-content:center;background:var(--accent,#0066ff);color:white;border-radius:3px;font-size:11px;font-weight:bold'
    icon.textContent = 'P'
    row.appendChild(icon)

    const nameDiv = document.createElement('div')
    nameDiv.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px'
    const nameLabel = document.createElement('span')
    nameLabel.style.cssText = 'font:12px var(--ff-mono,monospace);color:var(--panel-text,var(--fg));overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    nameLabel.textContent = prefab.name
    nameDiv.appendChild(nameLabel)

    const metaLabel = document.createElement('span')
    metaLabel.style.cssText = 'font:10px var(--ff-mono,monospace);color:var(--panel-text-3,var(--fg-3))'
    const meta = prefab.metadata || {}
    const count = prefab.entityCount || meta.entityCount || 0
    const date = meta.modifiedDate ? new Date(meta.modifiedDate).toLocaleDateString() : 'unknown'
    metaLabel.textContent = `${count} entities • ${date}`
    nameDiv.appendChild(metaLabel)
    row.appendChild(nameDiv)

    const btnWrap = document.createElement('div')
    btnWrap.style.cssText = 'display:flex;gap:4px'

    const instantiateBtn = document.createElement('button')
    instantiateBtn.className = 'ds-ep-wm-btn ds-ep-wm-btn-primary'
    instantiateBtn.style.cssText = 'font-size:11px;padding:3px 8px'
    instantiateBtn.textContent = 'Place'
    instantiateBtn.addEventListener('click', async (e) => {
      e.preventDefault()
      e.stopPropagation?.()
      try {
        await _handleInstantiate(prefab)
      } catch (e) {
        showToast(`Failed to instantiate: ${e.message}`, 'error')
      }
    })
    btnWrap.appendChild(instantiateBtn)

    const deleteBtn = document.createElement('button')
    deleteBtn.className = 'ds-ep-wm-btn ds-ep-wm-btn-danger'
    deleteBtn.style.cssText = 'font-size:11px;padding:3px 8px'
    deleteBtn.textContent = 'Delete'
    deleteBtn.addEventListener('click', async (e) => {
      e.preventDefault()
      e.stopPropagation?.()
      try {
        const confirmed = await showConfirm({
          title: 'Delete Prefab?',
          message: `Delete "${prefab.name}"? This cannot be undone.`,
          confirmLabel: 'Delete'
        })
        if (confirmed) {
          onDelete?.(prefab.name)
          showToast(`Prefab "${prefab.name}" deleted`)
          _refreshList()
        }
      } catch (e) {
        showToast(`Failed to delete: ${e.message}`, 'error')
      }
    })
    btnWrap.appendChild(deleteBtn)
    row.appendChild(btnWrap)
    item.appendChild(row)
    return item
  }

  async function _handleInstantiate(prefab) {
    const wm = getSharedWM()
    if (!wm) throw new Error('Window manager not available')

    return new Promise((resolve, reject) => {
      let resolved = false
      const winId = 'prefab-instantiate-' + Math.random().toString(36).slice(2, 8)
      const close = (v) => {
        if (resolved) return
        resolved = true
        wm.close(winId)
        if (v) resolve(v)
        else reject(new Error('Cancelled'))
      }

      const body = document.createElement('div')
      body.style.cssText = 'display:flex;flex-direction:column;gap:12px;padding:12px;max-height:500px;overflow-y:auto'

      const titleEl = document.createElement('div')
      titleEl.style.cssText = 'font:12px var(--ff-mono,monospace);color:var(--panel-text,var(--fg));font-weight:bold'
      titleEl.textContent = `Instantiate "${prefab.name}"`
      body.appendChild(titleEl)

      const posSection = document.createElement('div')
      posSection.style.cssText = 'display:flex;flex-direction:column;gap:6px'
      const posLabel = document.createElement('label')
      posLabel.style.cssText = 'font:11px var(--ff-mono,monospace);color:var(--panel-text-2,var(--fg-2))'
      posLabel.textContent = 'Position'
      posSection.appendChild(posLabel)

      const posInputs = document.createElement('div')
      posInputs.style.cssText = 'display:flex;gap:4px'
      const posFields = {}
      for (const axis of ['X', 'Y', 'Z']) {
        const input = document.createElement('input')
        input.type = 'number'
        input.placeholder = axis
        input.value = '0'
        input.className = 'ds-ui-input'
        input.style.cssText = 'flex:1;padding:4px'
        posInputs.appendChild(input)
        posFields[axis.toLowerCase()] = input
      }
      posSection.appendChild(posInputs)
      body.appendChild(posSection)

      const overrideSection = document.createElement('div')
      overrideSection.style.cssText = 'display:flex;flex-direction:column;gap:8px'
      const overrideLabel = document.createElement('label')
      overrideLabel.style.cssText = 'font:11px var(--ff-mono,monospace);color:var(--panel-text-2,var(--fg-2));font-weight:bold'
      overrideLabel.textContent = 'Entity Overrides'
      overrideSection.appendChild(overrideLabel)

      const selected = getSelectedEntities?.() || []
      const overrideFields = {}
      if (selected.length > 0) {
        for (const entity of selected) {
          const entDiv = document.createElement('div')
          entDiv.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:6px;background:var(--panel-2,var(--bg-3));border-radius:3px'

          const entLabel = document.createElement('span')
          entLabel.style.cssText = 'font:10px var(--ff-mono,monospace);color:var(--panel-text-3,var(--fg-3))'
          entLabel.textContent = entity.label || entity.id || '(unnamed)'
          entDiv.appendChild(entLabel)

          const fieldsDiv = document.createElement('div')
          fieldsDiv.style.cssText = 'display:flex;flex-direction:column;gap:3px'
          overrideFields[entity.id] = {}

          for (const prop of ['color', 'speed', 'scale']) {
            const propDiv = document.createElement('div')
            propDiv.style.cssText = 'display:flex;gap:4px;align-items:center'
            const propLabel = document.createElement('span')
            propLabel.style.cssText = 'font:10px var(--ff-mono,monospace);color:var(--panel-text-2,var(--fg-2));flex:0 0 45px'
            propLabel.textContent = prop
            propDiv.appendChild(propLabel)

            const propInput = document.createElement('input')
            propInput.type = prop === 'color' ? 'text' : 'number'
            propInput.placeholder = prop === 'color' ? '#ffffff' : (prop === 'speed' ? '1.0' : '1.0')
            propInput.className = 'ds-ui-input'
            propInput.style.cssText = 'flex:1;padding:3px;font-size:10px'
            propDiv.appendChild(propInput)
            fieldsDiv.appendChild(propDiv)

            overrideFields[entity.id][prop] = propInput
          }
          entDiv.appendChild(fieldsDiv)
          overrideSection.appendChild(entDiv)
        }
      }
      body.appendChild(overrideSection)

      const actions = document.createElement('div')
      actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px'
      const cancelBtn = document.createElement('button')
      cancelBtn.textContent = 'Cancel'
      cancelBtn.className = 'ds-ep-wm-btn'
      cancelBtn.addEventListener('click', () => close(null))
      const placeBtn = document.createElement('button')
      placeBtn.textContent = 'Instantiate'
      placeBtn.className = 'ds-ep-wm-btn ds-ep-wm-btn-primary'
      placeBtn.addEventListener('click', () => {
        const position = {
          x: parseFloat(posFields.x.value) || 0,
          y: parseFloat(posFields.y.value) || 0,
          z: parseFloat(posFields.z.value) || 0
        }
        const overrides = {}
        for (const entityId in overrideFields) {
          const fields = overrideFields[entityId]
          overrides[entityId] = {}
          if (fields.color.value) overrides[entityId].color = fields.color.value
          if (fields.speed.value) overrides[entityId].speed = parseFloat(fields.speed.value)
          if (fields.scale.value) overrides[entityId].scale = parseFloat(fields.scale.value)
        }
        close({ position, overrides })
      })
      actions.append(cancelBtn, placeBtn)
      body.appendChild(actions)

      wm.open({
        id: winId,
        title: 'Instantiate Prefab',
        x: (window.innerWidth - 400) / 2,
        y: (window.innerHeight - 500) / 2,
        w: 400,
        h: 500,
        body,
        onClose: () => close(null)
      })
      setTimeout(() => posFields.x.focus(), 0)
    }).then(result => {
      onInstantiate?.(prefab.name, result.position, result.overrides)
    })
  }

  _refreshList()

  return {
    update: _refreshList,
    refresh: _refreshList
  }
}

function promptPrefabName(existing = []) {
  const wm = getSharedWM()
  if (!wm) return Promise.resolve(null)
  return promptText(wm, {
    title: 'Save as Prefab',
    label: 'Prefab name',
    placeholder: 'prefab-name',
    confirmLabel: 'Save',
    validate: (raw) => {
      const name = raw.trim()
      if (!name) return { ok: false, error: 'Prefab name required' }
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) return { ok: false, error: 'Use letters, digits, hyphens, underscores only' }
      return { ok: true, value: name }
    }
  })
}
