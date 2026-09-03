export default {
    server: { setup() {} },
    client: {
        setup(ctx) {
            if (!ctx?.editor) return
            let _filter = ''
            let _lastArg = null
            let _container = null
            let _pollId = null
            function paint() {
                if (!_container || !_lastArg) return
                const events = _lastArg.events || []
                _container.innerHTML = ''
                const root = document.createElement('div')
                root.style.cssText = 'display:flex;flex-direction:column;height:100%;font:11px monospace'
                const hdr = document.createElement('div')
                hdr.textContent = 'events (app, filtered)'
                hdr.style.cssText = 'padding:8px;font:9px/1 monospace;color:rgba(52,211,153,0.8);text-transform:uppercase;letter-spacing:0.12em;border-bottom:1px solid rgba(255,255,255,0.06)'
                root.appendChild(hdr)
                const bar = document.createElement('div')
                bar.style.cssText = 'display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,0.06)'
                const inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = 'filter type or entity'; inp.value = _filter
                inp.style.cssText = 'flex:1;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#fff;padding:3px 6px;border-radius:4px;font:11px monospace;outline:none'
                inp.addEventListener('input', e => { _filter = e.target.value.toLowerCase(); paint(); inp.focus() })
                bar.appendChild(inp)
                root.appendChild(bar)
                const list = document.createElement('div')
                list.style.cssText = 'flex:1;overflow-y:auto;padding:4px 0'
                const vis = _filter ? events.filter(e => (e.type || '').includes(_filter) || (e.meta?.sourceEntity || '').includes(_filter)) : events
                if (!vis.length) {
                    const empty = document.createElement('div')
                    empty.textContent = events.length ? 'No matching events' : 'No events recorded'
                    empty.style.cssText = 'padding:16px;color:rgba(255,255,255,0.25);text-align:center;font:11px monospace'
                    list.appendChild(empty)
                } else {
                    vis.slice(-100).forEach((ev, i) => {
                        const row = document.createElement('div')
                        row.style.cssText = 'display:grid;grid-template-columns:50px 90px 1fr;gap:6px;padding:2px 8px;background:' + (i % 2 ? 'rgba(255,255,255,0.02)' : 'none')
                        const cells = [ev.tick ?? '', ev.type ?? '', ev.meta?.sourceEntity ?? '']
                        for (const v of cells) {
                            const c = document.createElement('span'); c.textContent = v; c.title = String(v)
                            c.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
                            row.appendChild(c)
                        }
                        list.appendChild(row)
                    })
                }
                root.appendChild(list)
                _container.appendChild(root)
            }
            ctx.editor.mountPanel({
                slot: 'events',
                label: 'Events (app)',
                render(container, arg) { _container = container; _lastArg = arg; paint() }
            })
            ctx.editor.onTabChange(name => {
                if (name === 'Events') {
                    if (!_pollId) { ctx.editor.requestEvents(); _pollId = setInterval(() => ctx.editor.requestEvents(), 2000) }
                } else if (_pollId) { clearInterval(_pollId); _pollId = null }
            })
        }
    }
}
