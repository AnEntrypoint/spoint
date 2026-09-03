export default {
    server: { setup() {} },
    client: {
        setup(ctx) {
            if (!ctx?.editor) return
            let _container = null
            let _lastArg = null
            let _requested = false
            function paint() {
                if (!_container || !_lastArg) return
                const apps = _lastArg.apps || []
                _container.innerHTML = ''
                const root = document.createElement('div')
                root.style.cssText = 'display:flex;flex-direction:column;height:100%;font:11px monospace;padding:8px'
                const hdr = document.createElement('div')
                hdr.textContent = 'apps (app)'
                hdr.style.cssText = 'font:9px/1 monospace;color:rgba(52,211,153,0.8);text-transform:uppercase;letter-spacing:0.12em;margin-bottom:6px'
                root.appendChild(hdr)
                if (!apps.length) {
                    const e = document.createElement('div'); e.textContent = 'Loading apps...'
                    e.style.cssText = 'color:rgba(255,255,255,0.3)'
                    root.appendChild(e)
                } else {
                    for (const a of apps) {
                        const name = typeof a === 'string' ? a : (a?.name || a?.id || a?.app || String(a))
                        const row = document.createElement('div')
                        row.style.cssText = 'display:flex;gap:4px;padding:4px 0;align-items:center'
                        const nm = document.createElement('span'); nm.textContent = name
                        nm.style.cssText = 'flex:1;color:rgba(255,255,255,0.7)'
                        const place = document.createElement('button'); place.textContent = 'place'
                        place.style.cssText = 'background:rgba(34,51,85,0.6);color:#adf;border:1px solid rgba(60,120,200,0.4);padding:2px 8px;border-radius:4px;cursor:pointer;font:10px monospace'
                        place.addEventListener('click', () => ctx.editor.placeApp(name, [0, 1, 0]))
                        row.append(nm, place)
                        root.appendChild(row)
                    }
                }
                _container.appendChild(root)
            }
            ctx.editor.mountPanel({
                slot: 'apps',
                label: 'Apps (app)',
                render(container, arg) { _container = container; _lastArg = arg; paint() }
            })
            ctx.editor.onTabChange(name => { if (name === 'Apps') ctx.editor.requestApps() })
            ctx.editor.requestApps()
        }
    }
}
