import { h, applyDiff } from 'anentrypoint-design'
import { Btn, Toolbar, EmptyState } from './wm/ui.js'

// world-lint: absurd coordinate magnitude past this radius is treated as "outside any reasonable
// playable bounds" -- real spoint worlds place gameplay entities within a few hundred/thousand
// units of the origin (terrain streams around the player, not the far reaches of float precision).
// 50000 is generous headroom above every real placed-entity magnitude seen in shipped world defs
// while still catching a genuine authoring slip (a dropped zero, a raw un-normalized GPS/ECEF value).
const OUT_OF_BOUNDS_RADIUS = 50000

const SPAWN_APP_NAMES = new Set(['spawn-point', 'respawn-zone'])

// Real, structural lint checks -- every one reads only fields genuinely present on the live
// SCENE_GRAPH entity tree (id/appName/label/position/children) or the live known-app registry
// (APP_LIST), both already flowing into EditorShell for the Hierarchy/HookFlow/Inspector panels.
// No synthetic/fabricated fields.
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

  // 1) Absurd coordinate magnitude -- entity is real, has a real position vector, and at least one
  // axis exceeds the reasonable-playable-bounds radius.
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

  // 2) Missing spawn points -- zero entities in the whole tree carry an app name of spawn-point or
  // respawn-zone. A world with no way to spawn a player is a real, checkable authoring mistake.
  const hasSpawn = flat.some(({ node }) => SPAWN_APP_NAMES.has(node.appName))
  if (!hasSpawn) {
    findings.push({
      id: null, severity: 'warn', check: 'missing-spawn',
      message: 'No spawn-point or respawn-zone entity found in this world -- players have nowhere authored to spawn'
    })
  }

  // 3) Duplicate entity ids -- getSceneGraph() is keyed off a server-side Map so same-parent
  // collisions can't happen, but the tree is walked recursively (children arrays) and nothing
  // stops the same id reappearing in two different branches if a future data source or a bugged
  // reparent ever produces that; check the real flattened id set defensively rather than assume
  // the invariant always holds upstream.
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

  // 4) Missing/unresolvable app name -- entity declares an appName that isn't in the live known-app
  // registry (APP_LIST, the same list EditorApps.js's Add-app picker and the placeableApps menu use).
  // Only checked when the caller actually has a real registry to check against (knownAppNames is a
  // live Set fed from the server's own APP_LIST reply, never fabricated).
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
    // Fed the same live entity tree EditorShell already tracks (SCENE_GRAPH-derived _entities) and
    // the live known-app-name registry (APP_LIST-derived), so a lint pass never runs on stale or
    // fabricated data -- re-running Validate World after either updates picks up the current state.
    updateEntities(entities) { _entities = entities || []; if (_findings !== null) _run() },
    updateKnownApps(apps) { _knownAppNames = new Set((apps || []).map(a => a.name).filter(Boolean)); if (_findings !== null) _run() },
    get findingCount() { return _findings === null ? null : _findings.length }
  }
}

// Exported for direct exec_js/console witnessing independent of the DOM panel shell.
export { lintWorld, OUT_OF_BOUNDS_RADIUS, SPAWN_APP_NAMES }
