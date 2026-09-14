import { h, applyDiff } from 'anentrypoint-design'
import { Btn, Toolbar, SearchInput } from './wm/ui.js'

export function createEditorEventLog(container, { onQuery } = {}) {
  let _events = [], _filter = '', _pollId = null

  container.classList.add('ds-ed-col', 'ds-ed-eventlog')

  function _render() {
    const vis = _filter
      ? _events.filter(e => (e.type||'').includes(_filter) || (e.meta?.sourceEntity||'').includes(_filter))
      : _events

    const items = vis.slice(-200).map((ev, i) => ({
      key: 'ev' + (ev.tick ?? i) + '-' + i,
      title: String(ev.type ?? ''),
      sub: [
        ev.tick != null ? 'tick ' + ev.tick : '',
        ev.meta?.sourceEntity ? 'ent ' + ev.meta.sourceEntity : '',
        ev.meta?.sourceApp ? 'app ' + ev.meta.sourceApp : ''
      ].filter(Boolean).join(' - ')
    }))

    const bar = Toolbar({ children: [
      h('div', { class: 'ds-ed-bar-grow' },
        SearchInput({ value: _filter, placeholder: 'filter type or entity...', onInput: v => { _filter = (v || '').toLowerCase(); _render() } })
      ),
      Btn({ ghost: true, onClick: (e) => { e.preventDefault(); _events = []; _render() }, children: ['Clear'] })
    ] })

    const body = h('div', { class: 'ds-ep-eventlog', style: 'flex:1;min-height:0;overflow-y:auto' },
      items.length === 0
        ? h('div', { key: '_empty', class: 'ds-ep-panel-body', style: 'display:flex;align-items:center;justify-content:center;text-align:center;color:var(--panel-text-3)' },
            _events.length ? 'No matching events' : 'No events recorded')
        : items.map(it => h('div', { key: it.key, class: 'ds-ep-eventrow' },
            h('span', { class: 'ds-ep-eventrow-type' }, it.title),
            it.sub ? h('span', { class: 'ds-ep-eventrow-sub' }, it.sub) : null
          ))
    )

    applyDiff(container, [
      h('div', { class: 'ds-ep-panel' }, bar, h('div', { class: 'ds-ep-panel-body flush', style: 'display:flex;flex-direction:column' }, body))
    ])
  }

  _render()

  return {
    start() { if (_pollId) return; onQuery?.(); _pollId = setInterval(() => onQuery?.(), 2000) },
    stop() { if (_pollId) { clearInterval(_pollId); _pollId = null } },
    updateEvents(events) { if (!Array.isArray(events)) return; _events = events; _render() }
  }
}
