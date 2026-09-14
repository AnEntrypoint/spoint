import { h, applyDiff } from 'anentrypoint-design'
import { Btn, Toolbar, EmptyState } from './wm/ui.js'

const OUT_OF_BOUNDS_RADIUS = 50000

const SPAWN_APP_NAMES = new Set(['spawn-point', 'respawn-zone'])

function _flatten(nodes, depth, parentId, out) {
  for (const n of nodes || []) {
    if (!n || !n.id) continue
    out.push({ node: n, depth, parentId })
    if (n.children && n.children.length) _flatten(n.children, depth + 1, n.id, out)
  }
  return out
}

function lintWorld(entities, knownAppNames) {
  const flat = _flatten(entities, 0, null, [])
  const findings = []

  for (const { node } of flat) {
    const p = node.position
    if (!Array.isArray(p) || p.length < 3) continue
    const mag = Math.max(Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]))
    if (Number.isFinite(mag) && mag > OUT_OF_BOUNDS_RADIUS) {
      findings.push({
        id: node.id, severity: 'error', check: 'out-of-bounds',
        message: `${node.id} is at [${p.map(v => v.toFixed(0)).join(', ')}] -- ${mag.toFixed(0)}u from origin, past the ${OUT_OF_BOUNDS_RADIUS}u reasonable-playable-bounds radius`
      })
    }
  }

  const hasSpawn = flat.some(({ node }) => SPAWN_APP_NAMES.has(node.appName))
  if (!hasSpawn) {
    findings.push({
      id: null, severity: 'warn', check: 'missing-spawn',
      message: 'No spawn-point or respawn-zone entity found in this world -- players have nowhere authored to spawn'
    })
  }

  const seenIds = new Map()
  for (const { node } of flat) {
    if (seenIds.has(node.id)) {
      const first = seenIds.get(node.id)
      findings.push({
        id: node.id, severity: 'error', check: 'duplicate-id',
        message: `Entity id "${node.id}" appears more than once in the scene tree (first seen under parent ${first.parentId ?? '(root)'}, again under ${flat.find(f => f.node === node).parentId ?? '(root)'})`
      })
    } else {
      seenIds.set(node.id, flat.find(f => f.node === node))
    }
  }

  if (knownAppNames && knownAppNames.size) {
    for (const { node } of flat) {
      if (node.appName && !knownAppNames.has(node.appName)) {
        findings.push({
          id: node.id, severity: 'error', check: 'unresolvable-app',
          message: `${node.id} references app "${node.appName}" which is not in the server's known-app list -- likely renamed, deleted, or never registered`
        })
      }
    }
  }

  return findings
}

const _SEVERITY_GLYPH = { error: '✕', warn: '!' }
const _SEVERITY_COLOR = { error: 'var(--danger, #e5484d)', warn: 'var(--warn, #f5a623)' }

export function createWorldValidator(container, { onSelect } = {}) {
  let _entities = [], _knownAppNames = new Set(), _findings = null, _sel = null

  container.classList.add('ds-ep-panel')

  function _run() {
    _findings = lintWorld(_entities, _knownAppNames)
    _sel = null
    render()
  }

  function render() {
    const ran = _findings !== null
    const errorCount = ran ? _findings.filter(f => f.severity === 'error').length : 0
    const warnCount = ran ? _findings.filter(f => f.severity === 'warn').length : 0

    const summary = ran
      ? h('span', { class: 'ds-ed-files-loading' }, `${_findings.length} issue${_findings.length === 1 ? '' : 's'} (${errorCount} error${errorCount === 1 ? '' : 's'}, ${warnCount} warning${warnCount === 1 ? '' : 's'})`)
      : h('span', { class: 'ds-ed-files-loading' }, `${_entities.length} entities loaded`)

    const toolbar = Toolbar({ children: [
      Btn({ primary: true, dense: true, title: 'Lint the currently-loaded world for common authoring mistakes', onClick: (e) => { e.preventDefault(); _run() }, children: ['Validate World'] }),
      h('div', { class: 'ds-ed-bar-grow' }),
      summary
    ] })

    let body
    if (!ran) {
      body = h('div', { style: 'display:flex;align-items:center;justify-content:center;text-align:center;flex:1' },
        EmptyState({ text: 'Click "Validate World" to lint the currently-loaded world' }))
    } else if (_findings.length === 0) {
      body = h('div', { style: 'display:flex;align-items:center;justify-content:center;text-align:center;flex:1' },
        EmptyState({ text: 'No issues found -- clean world' }))
    } else {
      body = h('div', { style: 'flex:1;min-height:0;overflow-y:auto' },
        ..._findings.map((f, i) => h('div', {
          key: 'wv' + i,
          class: 'ds-ep-eventrow',
          style: 'cursor:' + (f.id ? 'pointer' : 'default') + ';display:flex;gap:8px;align-items:flex-start;padding:6px 8px;border-bottom:1px solid var(--rule)' + (f.id && f.id === _sel ? ';background:color-mix(in oklab, var(--accent) 15%, transparent)' : ''),
          onclick: () => { if (!f.id) return; _sel = f.id; onSelect?.(f.id); render() }
        },
          h('span', { style: `color:${_SEVERITY_COLOR[f.severity] || 'inherit'};font-weight:700;flex:0 0 auto` }, _SEVERITY_GLYPH[f.severity] || '?'),
          h('div', { style: 'display:flex;flex-direction:column;gap:2px;min-width:0' },
            h('span', { class: 'ds-ep-eventrow-type' }, f.id ? f.id : '(world)'),
            h('span', { class: 'ds-ep-eventrow-sub' }, f.message)
          )
        ))
      )
    }

    applyDiff(container, [
      h('div', { class: 'ds-ep-panel' }, toolbar, h('div', { class: 'ds-ep-panel-body flush', style: 'display:flex;flex-direction:column;flex:1;min-height:0' }, body))
    ])
  }

  render()

  return {
    updateEntities(entities) { _entities = entities || []; if (_findings !== null) _run() },
    updateKnownApps(apps) { _knownAppNames = new Set((apps || []).map(a => a.name).filter(Boolean)); if (_findings !== null) _run() },
    get findingCount() { return _findings === null ? null : _findings.length }
  }
}

export { lintWorld, OUT_OF_BOUNDS_RADIUS, SPAWN_APP_NAMES }
