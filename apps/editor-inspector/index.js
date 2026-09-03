export default {
    server: {
        setup() {}
    },
    client: {
        setup(ctx) {
            if (!ctx?.editor) return
            const { v3, drag, propField } = ctx.editor.fields
            ctx.editor.mountPanel({
                slot: 'inspector',
                label: 'App-mounted Inspector',
                render(container, { selectedId }) {
                    const head = document.createElement('div')
                    head.textContent = 'inspector (app)'
                    head.style.cssText = 'color:rgba(52,211,153,0.85);font:10px/1 monospace;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:6px'
                    container.appendChild(head)
                    if (!selectedId) {
                        const empty = document.createElement('div')
                        empty.textContent = 'No selection'
                        empty.style.cssText = 'color:rgba(255,255,255,0.35);font:11px monospace'
                        container.appendChild(empty)
                        return
                    }
                    const ent = ctx.editor.getEntity(selectedId)
                    if (!ent) return
                    const idEl = document.createElement('div')
                    idEl.textContent = ent.id + (ent._appName ? ' [' + ent._appName + ']' : '')
                    idEl.style.cssText = 'color:rgba(255,255,255,0.55);font:10px monospace;margin-bottom:6px'
                    container.appendChild(idEl)
                    const getEnt = () => ent
                    const onChange = (key, val) => {
                        const changes = key.startsWith('custom.') ? { custom: { [key.slice(7)]: val } } : { [key]: val }
                        ctx.editor.update(selectedId, changes)
                    }
                    const getCb = () => onChange
                    container.appendChild(v3('Position', ent.position || [0, 0, 0], 'position', getEnt, getCb))
                    container.appendChild(v3('Scale', ent.scale || [1, 1, 1], 'scale', getEnt, getCb))
                    const delBtn = document.createElement('button')
                    delBtn.textContent = 'Delete (via ctx.editor.destroy)'
                    delBtn.style.cssText = 'margin-top:8px;width:100%;background:rgba(82,34,34,0.4);color:#f88;border:1px solid rgba(120,60,60,0.5);padding:6px;border-radius:5px;cursor:pointer;font:11px monospace'
                    delBtn.addEventListener('click', () => ctx.editor.destroy(selectedId))
                    container.appendChild(delBtn)
                }
            })
        }
    }
}
