export function createAppBrowser({ onPlace }) {
  const panel = document.createElement('div')
  panel.style.cssText = 'position:fixed;bottom:60px;left:12px;width:220px;background:rgba(20,20,20,0.92);color:#eee;font:12px/1.5 monospace;padding:8px;border-radius:6px;z-index:9000;display:none;max-height:50vh;overflow:hidden;display:none;flex-direction:column'
  document.body.appendChild(panel)

  const hdr = document.createElement('div')
  hdr.textContent = 'App Browser'
  hdr.style.cssText = 'color:#666;font-size:10px;text-transform:uppercase;margin-bottom:6px;flex-shrink:0;letter-spacing:0.5px'
  panel.appendChild(hdr)

  const filterInput = document.createElement('input')
  filterInput.type = 'text'
  filterInput.placeholder = 'Filter apps...'
  filterInput.style.cssText = 'width:100%;background:#333;border:none;color:#fff;padding:4px 6px;border-radius:3px;font:inherit;margin-bottom:6px;box-sizing:border-box;flex-shrink:0'
  panel.appendChild(filterInput)

  const list = document.createElement('div')
  list.style.cssText = 'overflow-y:auto;flex:1'
  panel.appendChild(list)

  let _apps = [], _filter = ''

  filterInput.addEventListener('input', () => { _filter = filterInput.value.toLowerCase(); render() })

  function render() {
    list.innerHTML = ''
    const filtered = _apps.filter(a => a.name.toLowerCase().includes(_filter) || (a.description || '').toLowerCase().includes(_filter))
    if (filtered.length === 0) {
      const empty = document.createElement('div')
      empty.textContent = _apps.length === 0 ? 'Loading...' : 'No match'
      empty.style.color = '#555'
      list.appendChild(empty)
      return
    }
    for (const app of filtered) {
      const row = document.createElement('div')
      row.style.cssText = 'padding:6px 8px;cursor:pointer;border-radius:3px;margin-bottom:2px;min-height:44px;display:flex;flex-direction:column;justify-content:center'
      row.addEventListener('mouseenter', () => row.style.background = '#2a2a3a')
      row.addEventListener('mouseleave', () => row.style.background = 'transparent')
      row.addEventListener('click', () => { if (onPlace) onPlace(app.name) })

      const name = document.createElement('div')
      name.textContent = app.name + (app.hasEditorProps ? ' *' : '')
      name.style.cssText = 'color:#adf;font-weight:bold'
      row.appendChild(name)

      if (app.description) {
        const desc = document.createElement('div')
        desc.textContent = app.description
        desc.style.cssText = 'color:#777;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
        row.appendChild(desc)
      }

      list.appendChild(row)
    }
  }

  return {
    show() { panel.style.display = 'flex'; render() },
    hide() { panel.style.display = 'none' },
    toggle() { panel.style.display = panel.style.display === 'none' ? 'flex' : 'none'; if (panel.style.display !== 'none') render() },
    update(apps) { _apps = apps || []; if (panel.style.display !== 'none') render() },
    get visible() { return panel.style.display !== 'none' }
  }
}
