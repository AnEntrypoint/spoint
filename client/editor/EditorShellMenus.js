// Add-menu / prop-category / recent-items / shortcuts-cheatsheet helpers for EditorShell.js's
// createEditPanel: stateless (module-level RECENT_KEY/RECENT_MAX localStorage cache aside) menu-item
// builders, name-prompt validation, and one-time CSS injection. Split out as EditorShell.js's largest
// self-contained block -- none of these touch createEditPanel's own closure state, only their own
// params/module-level caches/constants.

import { ASSET_HOST, fetchAssetManifest } from './AssetManifest.js'
import { promptText } from './wm/ui.js'

const ADD_PRIMITIVES = [
  { id: 'box-static', label: 'Box' },
  { id: 'sphere-static', label: 'Sphere' },
  { id: 'capsule-static', label: 'Capsule' },
  { id: 'cylinder-static', label: 'Cylinder' }
]

function buildAddMenuItems(place, openPropSubmenu, scatterState) {
  const scatterLabel = scatterState && scatterState.on
    ? '✓ Scatter mode (drag to place many)'
    : 'Scatter mode (drag to place many)'
  return [
    ...(scatterState ? [{ label: scatterLabel, onSelect: () => scatterState.toggle() }] : []),
    { label: 'Prop...', onSelect: () => openPropSubmenu() },
    ...ADD_PRIMITIVES.map(p => ({ label: p.label, onSelect: () => place(p.id) }))
  ]
}

async function buildPropCategoryItems(onOpenCategory) {
  try {
    const manifest = await fetchAssetManifest()
    const cats = Object.keys(manifest).sort()
    // editor-place-menu-thumbnails: category glyph is a graceful fallback differentiator for the
    // category-list level (no per-category thumbnail exists in the manifest -- categories are just
    // string keys grouping models, see AssetManifest.js/manifest.json shape). Real per-MODEL thumb
    // images (manifest[cat][i].thumb, a live gh-pages-hosted PNG, confirmed present on every entry)
    // are wired at the model-row level in buildCategoryMenuItems below.
    return cats.length
      ? cats.map(cat => ({ label: `${_categoryGlyph(cat)} ${cat} (${(manifest[cat] || []).length})`, onSelect: () => onOpenCategory(cat, manifest[cat] || []) }))
      : [{ label: '(no props in catalog)', disabled: true }]
  } catch (e) {
    return [{ label: 'Catalog error: ' + e.message, disabled: true }]
  }
}

// Coarse category->glyph map (text-only fallback differentiator; the manifest has no per-category
// icon/image field, only per-model `thumb`). Deliberately small and approximate -- any unmatched
// category still gets the neutral default glyph rather than nothing.
const _CATEGORY_GLYPHS = [
  [/kitchen|appliance|fridge|oven|stove|dish/i, '\u{1F373}'],
  [/bath|shower|toilet|sink/i, '\u{1F6BF}'],
  [/car|vehicle|truck|van|bus/i, '\u{1F697}'],
  [/tree|plant|foliage|flower|grass/i, '\u{1F333}'],
  [/rock|stone|boulder/i, '\u{1FAA8}'],
  [/chair|couch|sofa|table|desk|furniture|cabinet/i, '\u{1FA91}'],
  [/light|lamp/i, '\u{1F4A1}'],
  [/weapon|gun/i, '\u{1F52B}'],
  [/airport|container|industrial|barrel|dumpster/i, '\u{1F3ED}'],
  [/office/i, '\u{1F5C4}️']
]
function _categoryGlyph(cat) {
  for (const [re, glyph] of _CATEGORY_GLYPHS) if (re.test(cat)) return glyph
  return '\u{1F4E6}' // generic package/prop glyph default
}

function buildCategoryMenuItems(models, onPlaceModel, onBack) {
  // _thumb carries the real manifest thumbnail URL (or null) through to the post-render DOM
  // decoration pass in openAddMenu -- ContextMenu's item shape ({label,onSelect,disabled}) has no
  // documented custom-render/icon hook (see openAddMenu's own comment), so the extra _thumb key
  // rides along unused by the kit and is read back out by label-text matching after applyDiff.
  const items = models.map(m => ({ label: m.name, onSelect: () => onPlaceModel(ASSET_HOST + m.path), _thumb: m.thumb ? ASSET_HOST + m.thumb : null }))
  return [{ label: '< Back', onSelect: onBack }, ...items]
}

// --- Add-menu recent-items tracking (editor-add-menu-recent) ---------------------------------
// localStorage-persisted, keyed by asset url (props) or primitive kind ('box-static' etc).
// Pure functions (recordRecent/loadRecent) so the list/dedupe/cap logic is exec_js-testable
// independent of any DOM/menu wiring.
const RECENT_KEY = 'ds-editor-add-menu-recent'
const RECENT_MAX = 8
function loadRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter(r => r && r.key && r.label) : []
  } catch (_) { return [] }
}
function recordRecent(entry, existing) {
  // entry: {key, label, kind:'primitive'|'prop', value}. Most-recent-first, deduped by key, capped at RECENT_MAX.
  const list = (existing || loadRecent()).filter(r => r.key !== entry.key)
  list.unshift(entry)
  const capped = list.slice(0, RECENT_MAX)
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(capped)) } catch (_) {}
  return capped
}

// --- Add-menu substring filter (editor-add-menu-search) --------------------------------------
// Pure: filters a flat item list by substring match on label, case-insensitive.
function filterMenuItems(items, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return items
  return items.filter(it => !it.disabled && (it.label || '').toLowerCase().includes(q))
}

function promptName(wm, { title, label, placeholder, initial = '' } = {}) {
  return promptText(wm, {
    title, label, placeholder, initial,
    validate: (raw) => {
      const name = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
      return name ? { ok: true, value: name } : { ok: false, error: (label || 'Name') + ' required' }
    }
  })
}

const TABS = ['Inspector', 'Apps', 'HookFlow', 'Events', 'EventChains']

const EDITOR_SHORTCUTS = [
  { combo: 'G / W', scope: 'gizmo', label: 'Translate (move) gizmo' },
  { combo: 'R / E', scope: 'gizmo', label: 'Rotate gizmo' },
  // Alt+S not bare S: bare WASDC drives the fly-camera, would collide with a plain letter shortcut.
  { combo: 'Alt+S', scope: 'gizmo', label: 'Scale gizmo' },
  { combo: 'F', scope: 'gizmo', label: 'Frame / focus selected entity' },
  { combo: 'Delete', scope: 'edit', label: 'Delete selected entity' },
  { combo: 'mod+Z', scope: 'history', label: 'Undo' },
  { combo: 'mod+Y', scope: 'history', label: 'Redo' },
  { combo: 'P', scope: 'editor', label: 'Toggle editor' },
  { combo: 'Alt+C', scope: 'debug', label: 'Toggle collider debug wireframe' },
  { combo: 'M', scope: 'nav', label: 'Open lobby' },
  { combo: 'X', scope: 'gizmo', label: 'Toggle snap-to-grid' },
  { combo: 'Y', scope: 'gizmo', label: 'Toggle gizmo space (world / local)' },
  { combo: 'Alt+P', scope: 'gizmo', label: 'Cycle multi-select pivot mode (active / centroid / individual)' },
  { combo: 'Alt+1..9', scope: 'camera', label: 'Recall camera bookmark N' },
  { combo: 'Ctrl+Alt+1..9', scope: 'camera', label: 'Save camera bookmark N' },
  { combo: 'Shift/Ctrl+click', scope: 'select', label: 'Add or remove an entity from multi-select' },
  { combo: 'Shift/Ctrl+drag (empty space)', scope: 'select', label: 'Marquee box-select entities in view' },
  { combo: 'Ctrl+drag Y-axis', scope: 'gizmo', label: 'Snap-to-surface while moving (raycasts down, grid-snap off)' },
  { combo: 'mod+C', scope: 'edit', label: 'Copy selected entity (transform + custom props)' },
  { combo: 'mod+V', scope: 'edit', label: 'Paste onto the currently-selected entity' },
  { combo: 'Arrow keys', scope: 'gizmo', label: 'Nudge selected entity on X/Z (grid step or 0.25)' },
  { combo: 'PageUp / PageDown', scope: 'gizmo', label: 'Nudge selected entity on Y' },
  { combo: '?', scope: 'editor', label: 'Toggle this shortcuts cheat-sheet' }
]

let _wmCssInjected = false
function _ensureWmCSS() {
  if (_wmCssInjected) return
  _wmCssInjected = true
  // Absolute server path, not import.meta.url-relative: import.meta.url of a bundled
  // app.js resolves to the bundle's own URL (not this source file's real location),
  // which would silently mis-resolve these hrefs to /wm/*.css instead of
  // /editor/wm/*.css once client/app.js is bundled by scripts/bundle-client.mjs. The
  // editor/ directory is a fixed, server-mounted path (client/editor/wm/*.css), so an
  // absolute reference is both bundling-safe and simpler than a relative one.
  for (const href of ['/editor/wm/os-token-bridge.css', '/editor/wm/wm.css']) {
    const l = document.createElement('link')
    l.rel = 'stylesheet'
    l.href = href
    document.head.appendChild(l)
  }
}

let _editorRespInjected = false
function _ensureEditorResponsiveCSS() {
  if (_editorRespInjected) return
  _editorRespInjected = true
  const style = document.createElement('style')
  style.id = 'ds-editor-responsive'
  style.textContent = [
    '.ep-overlay .app-main{padding:0!important}',
    '.ep-overlay .app,.ep-overlay .app-shell{height:100%}',
    '.ep-overlay .app-main>*{flex:1;min-height:0}',
    '.ep-overlay .ds-ep-toolbar{flex-wrap:wrap;row-gap:4px;column-gap:6px}',
    '@media (pointer:coarse){.ep-overlay .ds-ep-tab,.ep-overlay .ds-ep-toolbar button,.ep-overlay .wm-btn,.ep-overlay .ds-ep-tree-row{min-height:44px}}',
    '.ds-ep-history-row:hover{background:var(--panel-2,rgba(255,255,255,0.06))}',
    '.ds-ep-history-row.current:hover{background:var(--accent-bg,rgba(80,160,255,0.24))}'
  ].join('\n')
  document.head.appendChild(style)
}

export {
  ADD_PRIMITIVES, buildAddMenuItems, buildPropCategoryItems, buildCategoryMenuItems,
  loadRecent, recordRecent, filterMenuItems, promptName,
  _ensureWmCSS, _ensureEditorResponsiveCSS, TABS, EDITOR_SHORTCUTS
}
