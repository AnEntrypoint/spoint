/**
 * MarketplaceBrowser.js -- In-client marketplace browser panel for the spoint editor.
 *
 * This is the FIRST SLICE of plugin-marketplace-in-client-browser: a panel that
 * fetches the registry index, renders a searchable list of app/skill names and
 * descriptions, and shows app details (manifest). Install flow is deferred to a
 * sibling row (marketplace-browser-install-flow).
 *
 * Mount it from an app's client.setup() via ctx.editor.mountPanel():
 *   ctx.editor.mountPanel({ slot: 'inspector', label: 'Marketplace', render: createMarketplaceBrowser({ registryUrl }) })
 *
 * Or import directly in the editor shell:
 *   import { createMarketplaceBrowser } from './MarketplaceBrowser.js'
 */

import { h } from 'anentrypoint-design'
import { getSharedWM, Btn, Toolbar, SearchInput, EmptyState } from './wm/ui.js'

/**
 * Create a marketplace browser panel.
 *
 * @param {object} opts
 * @param {string} [opts.registryUrl='http://localhost:3100'] - registry server URL
 * @returns {function} render(container) - call with a DOM container when mounted
 */
export function createMarketplaceBrowser(opts = {}) {
  const registryUrl = opts.registryUrl || 'http://localhost:3100'

  let _entries = []
  let _search = ''
  let _selected = null
  let _loading = false
  let _error = null
  let _filterKind = 'all' // 'all' | 'app' | 'skill'

  /** Fetch the registry index */
  async function fetchIndex() {
    _loading = true
    _error = null
    _entries = []
    render()
    try {
      const res = await fetch(`${registryUrl}/index`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      _entries = await res.json()
    } catch (err) {
      _error = err.message
    } finally {
      _loading = false
      render()
    }
  }

  /** Fetch a single manifest */
  async function fetchManifest(name) {
    _selected = null
    render()
    try {
      const res = await fetch(`${registryUrl}/manifest/${encodeURIComponent(name)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      _selected = await res.json()
    } catch (err) {
      _error = err.message
    } finally {
      render()
    }
  }

  /** Filtered and sorted entries */
  function filteredEntries() {
    let list = _entries
    if (_search) {
      const q = _search.toLowerCase()
      list = list.filter(e =>
        e.name.toLowerCase().includes(q) ||
        (e.title && e.title.toLowerCase().includes(q)) ||
        (e.description && e.description.toLowerCase().includes(q))
      )
    }
    if (_filterKind !== 'all') {
      list = list.filter(e => (_filterKind === 'skill' ? e.kind === 'skill' : !e.kind || e.kind === 'app'))
    }
    return list.sort((a, b) => a.name.localeCompare(b.name))
  }

  let _container = null

  function render() {
    if (!_container) return
    _container.innerHTML = ''

    // Toolbar
    const toolbar = document.createElement('div')
    toolbar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 0;flex-shrink:0'
    toolbar.innerHTML = ''

    const searchInput = document.createElement('input')
    searchInput.type = 'text'
    searchInput.placeholder = 'Search apps & skills...'
    searchInput.value = _search
    searchInput.style.cssText = 'flex:1;min-width:0;padding:4px 8px;border:1px solid var(--ds-border);border-radius:4px;background:var(--ds-bg-input);color:var(--ds-text);font-size:12px'
    searchInput.addEventListener('input', () => { _search = searchInput.value; render() })

    const kindSelect = document.createElement('select')
    kindSelect.style.cssText = 'padding:4px 6px;border:1px solid var(--ds-border);border-radius:4px;background:var(--ds-bg-input);color:var(--ds-text);font-size:12px'
    for (const [val, label] of [['all', 'All'], ['app', 'Apps'], ['skill', 'Skills']]) {
      const opt = document.createElement('option')
      opt.value = val
      opt.textContent = label
      if (val === _filterKind) opt.selected = true
      kindSelect.appendChild(opt)
    }
    kindSelect.addEventListener('change', () => { _filterKind = kindSelect.value; render() })

    const refreshBtn = document.createElement('button')
    refreshBtn.textContent = '↻'
    refreshBtn.title = 'Refresh'
    refreshBtn.style.cssText = 'padding:4px 8px;border:1px solid var(--ds-border);border-radius:4px;background:var(--ds-bg-input);color:var(--ds-text);cursor:pointer;font-size:12px'
    refreshBtn.addEventListener('click', fetchIndex)

    toolbar.append(searchInput, kindSelect, refreshBtn)
    _container.appendChild(toolbar)

    // Content area
    const content = document.createElement('div')
    content.style.cssText = 'flex:1;min-height:0;overflow-y:auto'

    if (_loading) {
      content.textContent = 'Loading...'
    } else if (_error) {
      const errDiv = document.createElement('div')
      errDiv.style.cssText = 'color:var(--ds-red);padding:8px'
      errDiv.textContent = `Error: ${_error}`
      content.appendChild(errDiv)
    } else if (_selected) {
      renderDetail(content)
    } else if (_entries.length === 0) {
      const empty = document.createElement('div')
      empty.style.cssText = 'padding:16px;text-align:center;color:var(--ds-text-muted)'
      empty.textContent = 'No apps found. Click ↻ to refresh.'
      content.appendChild(empty)
    } else {
      renderList(content)
    }

    _container.appendChild(content)
  }

  function renderList(container) {
    const list = filteredEntries()
    if (list.length === 0) {
      const empty = document.createElement('div')
      empty.style.cssText = 'padding:16px;text-align:center;color:var(--ds-text-muted)'
      empty.textContent = 'No matching apps.'
      container.appendChild(empty)
      return
    }

    for (const entry of list) {
      const item = document.createElement('div')
      item.style.cssText = 'padding:6px 8px;cursor:pointer;border-bottom:1px solid var(--ds-border);font-size:12px'
      item.addEventListener('click', () => fetchManifest(entry.name))

      const title = document.createElement('div')
      title.style.cssText = 'font-weight:600'
      title.textContent = entry.title || entry.name

      const meta = document.createElement('div')
      meta.style.cssText = 'color:var(--ds-text-muted);font-size:11px'
      const kind = entry.kind === 'skill' ? 'Skill' : 'App'
      meta.textContent = `${kind} · ${entry.version || '?'} · ${entry.author?.name || 'unknown'}`

      const desc = document.createElement('div')
      desc.style.cssText = 'color:var(--ds-text-muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      desc.textContent = entry.description || ''

      if (entry.tags && entry.tags.length > 0) {
        const tags = document.createElement('div')
        tags.style.cssText = 'margin-top:3px;display:flex;gap:3px;flex-wrap:wrap'
        for (const tag of entry.tags.slice(0, 5)) {
          const t = document.createElement('span')
          t.style.cssText = 'padding:1px 5px;border-radius:3px;background:var(--ds-bg-hover);font-size:10px;color:var(--ds-text-muted)'
          t.textContent = tag
          tags.appendChild(t)
        }
        item.appendChild(tags)
      }

      item.append(title, meta, desc)
      container.appendChild(item)
    }
  }

  function renderDetail(container) {
    const m = _selected
    const back = document.createElement('button')
    back.textContent = '← Back'
    back.style.cssText = 'padding:4px 8px;border:1px solid var(--ds-border);border-radius:4px;background:var(--ds-bg-input);color:var(--ds-text);cursor:pointer;font-size:12px;margin-bottom:8px'
    back.addEventListener('click', () => { _selected = null; render() })
    container.appendChild(back)

    const title = document.createElement('h3')
    title.style.cssText = 'margin:0 0 4px'
    title.textContent = `${m.title || m.name} ${m.version || ''}`

    const kind = document.createElement('div')
    kind.style.cssText = 'font-size:11px;color:var(--ds-text-muted);margin-bottom:8px'
    kind.textContent = `Kind: ${m.kind === 'skill' ? 'Freddie Skill' : 'Spoint App'}`

    const desc = document.createElement('p')
    desc.style.cssText = 'font-size:12px;color:var(--ds-text-muted)'
    desc.textContent = m.description || 'No description'

    const author = document.createElement('div')
    author.style.cssText = 'font-size:11px;color:var(--ds-text-muted);margin-top:4px'
    author.textContent = `Author: ${m.author?.name || 'unknown'} · License: ${m.license || '?'}`

    container.append(title, kind, desc, author)

    // Skill-specific details
    if (m.kind === 'skill' && m.skill) {
      const skillDiv = document.createElement('div')
      skillDiv.style.cssText = 'margin-top:8px;padding:8px;background:var(--ds-bg-hover);border-radius:4px;font-size:11px'

      if (m.skill.hooks?.length) {
        const hooks = document.createElement('div')
        hooks.textContent = `Hooks: ${m.skill.hooks.join(', ')}`
        skillDiv.appendChild(hooks)
      }
      if (m.skill.triggers?.length) {
        const triggers = document.createElement('div')
        triggers.textContent = `Triggers: ${m.skill.triggers.join(', ')}`
        skillDiv.appendChild(triggers)
      }
      if (m.skill.allowedTools?.length) {
        const tools = document.createElement('div')
        tools.textContent = `Tools: ${m.skill.allowedTools.join(', ')}`
        skillDiv.appendChild(tools)
      }

      container.appendChild(skillDiv)
    }

    // Tags
    if (m.tags && m.tags.length > 0) {
      const tagsDiv = document.createElement('div')
      tagsDiv.style.cssText = 'margin-top:8px;display:flex;gap:4px;flex-wrap:wrap'
      for (const tag of m.tags) {
        const t = document.createElement('span')
        t.style.cssText = 'padding:2px 6px;border-radius:3px;background:var(--ds-bg-input);font-size:10px'
        t.textContent = tag
        tagsDiv.appendChild(t)
      }
      container.appendChild(tagsDiv)
    }

    // Dependencies
    if (m.dependencies && Object.keys(m.dependencies).length > 0) {
      const depsDiv = document.createElement('div')
      depsDiv.style.cssText = 'margin-top:8px;font-size:11px'
      depsDiv.innerHTML = '<strong>Dependencies:</strong>'
      const depsList = document.createElement('ul')
      depsList.style.cssText = 'margin:2px 0 0 16px;padding:0'
      for (const [pkg, ver] of Object.entries(m.dependencies)) {
        const li = document.createElement('li')
        li.textContent = `${pkg} ${ver}`
        depsList.appendChild(li)
      }
      depsDiv.appendChild(depsList)
      container.appendChild(depsDiv)
    }
  }

  // Initial fetch
  fetchIndex()

  // Return the render function for mountPanel
  return (container) => {
    _container = container
    if (container) {
      container.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden'
    }
    render()
  }
}