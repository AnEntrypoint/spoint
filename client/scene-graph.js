export function createSceneGraph({ onSelect }) {
  const panel = document.createElement('div')
  panel.style.cssText = 'position:fixed;top:12px;left:12px;width:200px;background:rgba(20,20,20,0.92);color:#eee;font:12px/1.5 monospace;padding:8px;border-radius:6px;z-index:9000;display:none;max-height:60vh;overflow-y:auto;user-select:none'
  document.body.appendChild(panel)

  let _entities = []
  let _selectedId = null

  function buildNode(node, depth) {
    const wrap = document.createElement('div')
    const row = document.createElement('div')
    row.style.cssText = `display:flex;align-items:center;padding:3px 4px;cursor:pointer;border-radius:3px;padding-left:${8 + depth * 12}px;min-height:24px`
    row.style.background = node.id === _selectedId ? '#335' : 'transparent'

    if (node.children && node.children.length > 0) {
      const arrow = document.createElement('span')
      arrow.textContent = '▾ '
      arrow.style.cssText = 'color:#888;flex-shrink:0'
      row.appendChild(arrow)
    }

    const label = document.createElement('span')
    label.textContent = node.label || node.appName || node.id
    label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    row.appendChild(label)

    const appTag = document.createElement('span')
    appTag.textContent = node.appName || ''
    appTag.style.cssText = 'color:#666;font-size:10px;flex-shrink:0;margin-left:4px'
    row.appendChild(appTag)

    row.addEventListener('click', () => {
      _selectedId = node.id
      if (onSelect) onSelect(node.id)
      render()
    })
    row.addEventListener('mouseenter', () => { if (node.id !== _selectedId) row.style.background = '#2a2a3a' })
    row.addEventListener('mouseleave', () => { row.style.background = node.id === _selectedId ? '#335' : 'transparent' })

    wrap.appendChild(row)

    if (node.children && node.children.length > 0) {
      const childWrap = document.createElement('div')
      for (const child of node.children) childWrap.appendChild(buildNode(child, depth + 1))
      wrap.appendChild(childWrap)
    }

    return wrap
  }

  function render() {
    panel.innerHTML = ''
    const hdr = document.createElement('div')
    hdr.textContent = 'Scene Graph'
    hdr.style.cssText = 'color:#666;font-size:10px;text-transform:uppercase;margin-bottom:6px;letter-spacing:0.5px'
    panel.appendChild(hdr)
    if (_entities.length === 0) {
      const empty = document.createElement('div')
      empty.textContent = 'No entities'
      empty.style.color = '#555'
      panel.appendChild(empty)
      return
    }
    for (const node of _entities) panel.appendChild(buildNode(node, 0))
  }

  return {
    show() { panel.style.display = 'block'; render() },
    hide() { panel.style.display = 'none' },
    toggle() { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; if (panel.style.display !== 'none') render() },
    update(entities) { _entities = entities || []; if (panel.style.display !== 'none') render() },
    setSelected(id) { _selectedId = id; if (panel.style.display !== 'none') render() },
    get visible() { return panel.style.display !== 'none' }
  }
}
