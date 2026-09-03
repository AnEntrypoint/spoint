export default {
    server: { setup() {} },
    client: {
        setup(ctx) {
            if (!ctx?.editor) return
            let _query = ''
            let _lastArg = null
            let _container = null
            function paint() {
                if (!_container || !_lastArg) return
                const { entities, selectedId } = _lastArg
                _container.innerHTML = ''
                const root = document.createElement('div')
                root.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0'
                const hdr = document.createElement('div')
                hdr.textContent = 'scene (app)'
                hdr.style.cssText = 'padding:8px 8px 4px;font:9px/1 monospace;color:rgba(52,211,153,0.8);text-transform:uppercase;letter-spacing:0.18em'
                root.appendChild(hdr)
                const inp = document.createElement('input')
                inp.type = 'text'
                inp.placeholder = 'filter...'
                inp.value = _query
                inp.style.cssText = 'margin:4px 8px 6px;height:24px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#fff;padding:0 8px;font:11px monospace;outline:none;box-sizing:border-box'
                inp.addEventListener('input', e => { _query = e.target.value.toLowerCase(); paint(); inp.focus() })
                root.appendChild(inp)
                const list = document.createElement('div')
                list.style.cssText = 'flex:1;overflow-y:auto;padding:0 4px 4px'
                const filtered = _query ? entities.filter(e => (e.id || '').toLowerCase().includes(_query) || (e.appName || e._appName || '').toLowerCase().includes(_query)) : entities
                if (!filtered.length) {
                    const empty = document.createElement('div')
                    empty.textContent = entities.length ? 'No match' : 'No entities'
                    empty.style.cssText = 'padding:12px;color:rgba(255,255,255,0.25);font:11px monospace;text-align:center'
                    list.appendChild(empty)
                } else {
                    for (const e of filtered) {
                        const row = document.createElement('div')
                        const isSel = e.id === selectedId
                        row.style.cssText = 'display:flex;padding:4px 8px;border-radius:6px;cursor:pointer;font:11px/1.4 monospace;color:' + (isSel ? '#a7f3d0' : 'rgba(255,255,255,0.55)') + ';background:' + (isSel ? 'rgba(16,185,129,0.14)' : 'transparent')
                        const idSpan = document.createElement('span'); idSpan.textContent = e.id; idSpan.style.flex = '1'
                        const tagSpan = document.createElement('span'); tagSpan.textContent = e.appName || e._appName || ''; tagSpan.style.cssText = 'font-size:9px;color:rgba(255,255,255,0.28)'
                        row.append(idSpan, tagSpan)
                        row.addEventListener('click', () => ctx.editor.select(e.id))
                        // contextmenu deletes directly (non-blocking) instead of window.confirm() to avoid blocking jank
                        row.addEventListener('dblclick', () => ctx.editor.select(e.id))
                        row.addEventListener('contextmenu', ev => { ev.preventDefault(); ctx.editor.destroy(e.id) })
                        list.appendChild(row)
                    }
                }
                root.appendChild(list)
                _container.appendChild(root)
            }
            ctx.editor.mountPanel({
                slot: 'hierarchy',
                label: 'Scene (app)',
                render(container, arg) { _container = container; _lastArg = arg; paint() }
            })
        }
    }
}
