import { components as C, h, applyDiff } from 'anentrypoint-design'
import { Btn, EmptyState } from './wm/ui.js'
import { propField, dragNumberVNode, showConfirm, showToast } from './EditPanelDOM.js'

// Strict relative-expression parse for numeric fields: '+5' / '-3' / '*2' / '/2' relative to the field's
// CURRENT value. Anything else (plain '10', '-10' with no operator prefix meaning, garbage) falls through to
// parseFloat as an absolute value, same as before this feature existed. No eval() -- fixed regex + switch only.
const EXPR_RE = /^([+\-*/])\s*(-?\d+\.?\d*)$/
function parseNumericExpr(raw, current) {
  const m = EXPR_RE.exec(String(raw).trim())
  if (!m) return null
  const op = m[1], n = parseFloat(m[2])
  if (!Number.isFinite(n)) return null
  const cur = typeof current === 'number' ? current : 0
  switch (op) {
    case '+': return cur + n
    case '-': return cur - n
    case '*': return cur * n
    case '/': return n === 0 ? cur : cur / n
  }
  return null
}

// Per-field copy/paste clipboard: a single in-memory numeric slot (module-level, survives across renders/entities
// within the session -- sessionStorage would also survive a reload but a plain var is enough for "copy here, paste
// there" within one editor session and avoids JSON-parsing untrusted storage on every paste).
let _numClipboard = null

// Collapsed-section state: module-level so it persists across render() calls within the session (re-render must
// not re-expand a section the user just collapsed), but does not need to survive a reload.
const _collapsedSections = {}

function sectionHeader(name, label, onToggle) {
  const collapsed = !!_collapsedSections[name]
  return h('div', {
    class: 'ds-ep-section-header',
    style: 'display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;padding:4px 2px;font-weight:600;opacity:0.85',
    onclick: (e) => { e.preventDefault(); _collapsedSections[name] = !_collapsedSections[name]; onToggle() }
  },
    h('span', { style: 'display:inline-block;transition:transform .1s;transform:rotate(' + (collapsed ? '-90deg' : '0deg') + ')' }, '▾'),
    h('span', {}, label)
  )
}

function q2e([x,y,z,w]) {
  return [
    Math.atan2(2*(w*x+y*z),1-2*(x*x+y*y))*180/Math.PI,
    (v=>Math.abs(v)>=1?Math.sign(v)*90:Math.asin(v)*180/Math.PI)(2*(w*y-z*x)),
    Math.atan2(2*(w*z+x*y),1-2*(y*y+z*z))*180/Math.PI
  ]
}

// Mixed-value sentinel: distinguishes "every selected entity agrees on undefined" from "the values
// differ" without colliding with a real stored value (undefined/null/0/'' are all valid custom.* values).
const MIXED = Symbol('mixed')

// Compares a field across [primary, ...extras] and returns either the single shared value or MIXED.
// getter(entity) -> the field's raw value on that entity (deep-equal via JSON.stringify -- every field
// this feeds is JSON-safe: numbers/strings/bools/plain-object custom values, never a class instance).
function _sharedValue(entities, getter) {
  const first = getter(entities[0])
  const firstKey = JSON.stringify(first)
  for (let i = 1; i < entities.length; i++) if (JSON.stringify(getter(entities[i])) !== firstKey) return MIXED
  return first
}

export function createEditorInspector(container, { onDestroyEntity, onEditCode, onRename } = {}) {
  let _entity = null, _eProps = [], _onChange = null, _extraIds = [], _extraEntities = []
  // Cache Euler triple: near gimbal lock, q2e's atan2/asin decomposition is non-unique, so a plain re-render could jump X/Z off the user's last-typed value.
  let _eulerCacheId = null, _eulerCacheQuat = null, _eulerCacheDeg = null

  container.classList.add('ds-ep-panel')
  container.style.cssText = 'flex:1;min-height:0'

  function render() {
    if (!_entity) {
      applyDiff(container, [
        h('div', { class: 'ds-ep-panel-body', style: 'display:flex;align-items:center;justify-content:center;text-align:center' },
          EmptyState({ text: 'Click an object in the scene to edit it — its transform, collider, and app settings appear here. Use Add to place a new one.' })
        )
      ])
      return
    }

    // Multi-select mode: N entities selected (primary _entity plus _extraIds riding along). Two families
    // of field here: (1) position/rotation/scale bulk-edit as a RELATIVE DELTA (unchanged from before this
    // row -- selected entities usually start at different transforms, so a delta preserves each entity's
    // own offset from the others, matching "move the group" not "teleport everyone to one spot"); (2)
    // SHARED fields (custom.* props + collider) as an ABSOLUTE overwrite with a real mixed-value indicator
    // -- these are per-entity-type props where "the same value on every selected entity" is the actual ask
    // (paint the group one color, swap every member's collider), computed across [primary, ...extraEntities].
    if (_extraIds && _extraIds.length > 0) {
      const n = 1 + _extraIds.length
      const allEntities = [_entity, ..._extraEntities]
      // extraEntities may lag extraIds by one render tick (showEntity(ids) can arrive before the real data
      // fetch resolves) -- fall back to delta-only transform editing (the pre-existing behavior) rather than
      // computing shared fields against a data set that doesn't actually match the current selection count.
      const haveFullData = _extraEntities.length === _extraIds.length
      const bulkVec = (label, key) => {
        const axes = ['x','y','z']
        return h('label', { class: 'ds-ep-propfield block' },
          h('span', { class: 'ds-ep-propfield-label' }, label + ' (Δ)'),
          h('span', { class: 'ds-ep-propfield-value' },
            h('span', { class: 'ds-ep-vec3' },
              axes.map((ax, i) => h('span', { style: 'display:flex;align-items:center;gap:1px;min-width:0;flex:1' },
                dragNumberVNode(0, v => _onChange?.('_bulkDelta', { key, axis: i, delta: v }), ax)
              ))
            )
          )
        )
      }
      const bulkRotVec = (label) => {
        const axes = ['x','y','z']
        return h('label', { class: 'ds-ep-propfield block' },
          h('span', { class: 'ds-ep-propfield-label' }, label + ' (Δ deg)'),
          h('span', { class: 'ds-ep-propfield-value' },
            h('span', { class: 'ds-ep-vec3' },
              axes.map((ax, i) => h('span', { style: 'display:flex;align-items:center;gap:1px;min-width:0;flex:1' },
                dragNumberVNode(0, v => _onChange?.('_bulkDeltaEuler', { axis: i, delta: v }), ax)
              ))
            )
          )
        )
      }
      // Shared/mixed custom.* fields: the union of custom keys across every selected entity (not just the
      // primary's), so a field only the 2nd entity has still shows up -- with 'undefined on N of M' folded
      // into the mixed-value comparison naturally (JSON.stringify(undefined) !== JSON.stringify(realValue)).
      const customKeys = haveFullData
        ? [...new Set(allEntities.flatMap(e => Object.keys(e.custom || {})))].sort()
        : []
      // A fresh vnode per call (not a single shared reused object) -- applyDiff/webjsx reconciles by
      // identity in some kits, and this badge can appear at multiple field rows in the same render pass.
      const mixedBadge = () => h('span', { class: 'ds-ep-mixed-badge', title: 'Selected entities have different values for this field', style: 'font-size:9px;padding:1px 5px;border-radius:8px;background:rgba(255,180,60,0.18);color:#e0a030;margin-left:4px' }, 'mixed')
      const sharedField = (label, key, getter, renderInput) => {
        const shared = _sharedValue(allEntities, getter)
        const isMixed = shared === MIXED
        return h('label', { class: 'ds-ep-propfield block' },
          h('span', { class: 'ds-ep-propfield-label', style: 'display:flex;align-items:center' }, label, isMixed ? mixedBadge() : null),
          h('span', { class: 'ds-ep-propfield-value' }, renderInput(isMixed ? '' : shared, isMixed))
        )
      }
      const sharedCustomField = (key) => {
        // Reuses the same input widgets propField renders for a single entity, but on emit routes through
        // _bulkSet (absolute overwrite to every selected entity, one transaction) instead of a single-entity
        // custom.* write. type is inferred from whichever selected entity actually has a value for this key
        // (string/number/boolean at minimum -- vec3/color/select need real editorProp metadata this generic
        // batch view doesn't have, so those stay a plain text/number field here; still correctly mixed-aware).
        const sample = allEntities.map(e => e.custom?.[key]).find(v => v !== undefined)
        const isBool = typeof sample === 'boolean'
        const isNum = typeof sample === 'number'
        return sharedField(key, 'custom.' + key, (e) => e.custom?.[key], (val, isMixed) => {
          if (isBool) return h('input', { type: 'checkbox', class: 'ds-input-check', checked: !isMixed && !!val, onchange: e => _onChange?.('_bulkSet', { key: 'custom.' + key, value: e.target.checked }) })
          if (isNum) return dragNumberVNode(isMixed ? 0 : (val || 0), v => _onChange?.('_bulkSet', { key: 'custom.' + key, value: v }))
          return h('input', { class: 'ds-input-bare', value: isMixed ? '' : String(val ?? ''), placeholder: isMixed ? '(mixed)' : '', style: 'flex:1;min-width:0', onchange: e => _onChange?.('_bulkSet', { key: 'custom.' + key, value: e.target.value }) })
        })
      }
      // Collider: shared across selection like a custom.* field, but it's a distinct top-level concept
      // (custom._collider / .collider.type) with its own IconButtonGroup, same as the single-entity view.
      const COLLIDER_HINT_MULTI = { box: 'Bounding-box', sphere: 'Bounding-sphere', capsule: 'Capsule', trimesh: 'Exact geometry (static)', convex: 'Convex hull', none: 'No collision' }
      const anyPhysical = haveFullData && allEntities.some(e => e.model || e._appName === 'placed-model' || e.custom?.mesh || e.bodyType)
      const colliderGetter = (e) => e.custom?._collider || e.collider?.type || 'box'
      const colliderShared = anyPhysical ? _sharedValue(allEntities, colliderGetter) : null
      const colliderField = anyPhysical ? h('label', { class: 'ds-ep-propfield block' },
        h('span', { class: 'ds-ep-propfield-label', style: 'display:flex;align-items:center' }, 'Collider', colliderShared === MIXED ? mixedBadge() : null),
        h('span', { class: 'ds-ep-propfield-value' },
          C.IconButtonGroup({
            items: ['box','sphere','capsule','trimesh','convex','none'].map(id => ({ id, label: id, title: COLLIDER_HINT_MULTI[id] })),
            value: colliderShared === MIXED ? '' : colliderShared,
            onChange: (id) => _onChange?.('_bulkSet', { key: 'collider', value: id })
          })
        )
      ) : null
      applyDiff(container, [
        h('div', { class: 'ds-ep-panel-head' }, n + ' entities selected'),
        h('div', { class: 'ds-ep-panel-body' }, C.PropertyGrid({ children: [
          h('div', { style: 'padding:6px 2px;opacity:0.7;font-size:11px' }, 'Bulk edit applies a relative offset to each selected entity\'s own current value.'),
          bulkVec('Position', 'position'),
          bulkRotVec('Rotation'),
          bulkVec('Scale', 'scale'),
          ...(colliderField ? [colliderField] : []),
          ...(customKeys.length ? [
            h('div', { style: 'padding:8px 2px 2px;opacity:0.7;font-size:11px;border-top:1px solid rgba(255,255,255,0.08);margin-top:4px' }, 'Shared fields -- editing applies to all ' + n + ' selected entities as one undo step.'),
            ...customKeys.map(k => sharedCustomField(k))
          ] : (haveFullData ? [] : [h('div', { style: 'padding:6px 2px;opacity:0.5;font-size:10px' }, 'Loading selection data…')]))
        ] }))
      ])
      return
    }

    // Update _entity[key] in place immediately, or consecutive axis edits in the same render read a stale pre-edit vec.
    const writeVec = (key, i, v) => {
      const c = _entity[key] ? [..._entity[key]] : [0,0,0]; c[i] = v
      _entity[key] = c
      _onChange?.(key, c)
    }
    const writeEuler = (i, v) => {
      const deg = _eulerCacheDeg ? [..._eulerCacheDeg] : q2e(_entity.rotation || [0,0,0,1])
      deg[i] = v
      _eulerCacheDeg = deg
      _eulerCacheQuat = null
      _onChange?.('_rotEuler', deg)
    }
    // Uniform-scale lock: when true, editing one scale axis proportionally scales the other two by the same
    // ratio (newVal / oldVal on the edited axis). Guarded against a zero reference axis (ratio undefined -> skip
    // the other axes, only the edited one changes) so a degenerate 0-scale entity can't divide-by-zero into NaN/Inf.
    const scaleLockKey = '_scaleLinked'
    const writeScale = (i, v) => {
      const cur = _entity.scale ? [..._entity.scale] : [1,1,1]
      const locked = !!_entity[scaleLockKey]
      if (locked && Number.isFinite(cur[i]) && cur[i] !== 0) {
        const ratio = v / cur[i]
        const c = cur.map((val, j) => j === i ? v : val * ratio)
        _entity.scale = c
        _onChange?.('scale', c)
      } else {
        writeVec('scale', i, v)
      }
    }
    // Numeric expression support: dragNumberVNode's opts.allowExpr(rawString) is called on every typed commit,
    // BEFORE its own absolute-number parse. Returning a finite number here wins; returning null falls through to
    // dragNumberVNode's normal parseFloat path, so plain "10"/"-10" behave exactly as before this feature existed.
    // `getCurrent` reads the LIVE value (not the closed-over vals[i]) so consecutive same-render edits compose.
    const exprOpts = (getCurrent) => ({ allowExpr: (raw) => parseNumericExpr(raw, getCurrent()) })
    const copyCell = (label, getVal) => ({
      oncontextmenu: (e) => {
        e.preventDefault()
        _numClipboard = getVal()
        showToast('Copied ' + label + ': ' + _numClipboard)
      }
    })
    const pasteBtn = (label, apply) => h('button', {
      class: 'ds-ep-cell-paste', title: 'Paste ' + label + ' (' + (_numClipboard ?? '—') + ')',
      style: 'font-size:9px;line-height:1;padding:1px 3px;opacity:0.6;cursor:pointer;flex:0 0 auto',
      disabled: _numClipboard === null,
      onclick: (e) => { e.preventDefault(); if (_numClipboard !== null) apply(_numClipboard) }
    }, 'P')
    const vecField = (label, vals, key, writer) => {
      const write = writer || ((i, v) => writeVec(key, i, v))
      const axes = ['x','y','z']
      return h('label', { class: 'ds-ep-propfield block' },
        h('span', { class: 'ds-ep-propfield-label' }, label),
        h('span', { class: 'ds-ep-propfield-value' },
          h('span', { class: 'ds-ep-vec3' },
            axes.map((ax, i) => h('span', { style: 'display:flex;align-items:center;gap:1px;min-width:0;flex:1', ...copyCell(label + '.' + ax, () => (_entity[key] || vals)[i] ?? 0) },
              dragNumberVNode(vals[i] || 0, v => write(i, v), ax, exprOpts(() => (_entity[key] || vals)[i] ?? 0)),
              pasteBtn(ax, (val) => write(i, val))
            ))
          )
        )
      )
    }

    const BODY_TYPE_HINT = { static: 'Fixed in place, unaffected by physics', dynamic: 'Falls under gravity, pushed by other bodies', kinematic: 'Moves under script control, not affected by forces' }
    const bodyTypeField = h('label', { class: 'ds-ep-propfield block' },
      h('span', { class: 'ds-ep-propfield-label' }, 'Body Type'),
      h('span', { class: 'ds-ep-propfield-value' },
        C.IconButtonGroup({
          items: ['static','dynamic','kinematic'].map(id => ({ id, label: id, title: BODY_TYPE_HINT[id] })),
          value: _entity.bodyType || 'static',
          onChange: async (id) => {
            // Confirm leaving static: physics can immediately drop/fling the prop.
            if (id !== 'static' && (_entity.bodyType || 'static') === 'static') {
              const ok = await showConfirm({ title: 'Change body type', message: 'Switch to "' + id + '"? ' + BODY_TYPE_HINT[id] + '.', confirmLabel: 'Switch' })
              if (!ok) return
            }
            _onChange?.('bodyType', id); render()
          }
        })
      )
    )

    const rot = _entity.rotation || [0,0,0,1]
    if (_eulerCacheId !== _entity.id) { _eulerCacheId = _entity.id; _eulerCacheQuat = null; _eulerCacheDeg = null }
    const quatChanged = !_eulerCacheQuat || rot.some((v,i) => Math.abs(v - _eulerCacheQuat[i]) > 1e-6)
    if (!_eulerCacheDeg || quatChanged) { _eulerCacheDeg = q2e(rot); _eulerCacheQuat = [...rot] }
    const rotAxes = ['x','y','z']
    const rotationField = h('label', { class: 'ds-ep-propfield block' },
      h('span', { class: 'ds-ep-propfield-label' }, 'Rotation (deg)'),
      h('span', { class: 'ds-ep-propfield-value' },
        h('span', { class: 'ds-ep-vec3' },
          rotAxes.map((ax, i) => h('span', { style: 'display:flex;align-items:center;gap:1px;min-width:0;flex:1', ...copyCell('rotation.' + ax, () => _eulerCacheDeg[i] || 0) },
            dragNumberVNode(_eulerCacheDeg[i] || 0, v => writeEuler(i, v), ax, exprOpts(() => _eulerCacheDeg[i] || 0)),
            pasteBtn(ax, (val) => writeEuler(i, val))
          ))
        )
      )
    )

    const COLLIDER_HINT = { box: 'Bounding-box approximation, cheap', sphere: 'Bounding-sphere approximation, cheapest', capsule: 'Vertical capsule, good for character-like props', trimesh: 'Exact model geometry (static only), most accurate', convex: 'Convex hull of the model geometry, works for dynamic bodies', none: 'No collision' }
    // Show the collider picker for ANY physical entity, not just models: a placed primitive (custom.mesh set) or
    // any entity with a bodyType needs to pick its collider too. Gating to models left primitives colliderless in
    // the inspector. Value seeds from custom._collider (what the server rebuilds from) first.
    const isPhysical = _entity.model || _entity._appName === 'placed-model' || _entity.appName === 'placed-model' || _entity.custom?.mesh || _entity.bodyType
    const colliderField = isPhysical ? h('label', { class: 'ds-ep-propfield block' },
      h('span', { class: 'ds-ep-propfield-label' }, 'Collider'),
      h('span', { class: 'ds-ep-propfield-value' },
        C.IconButtonGroup({
          items: ['box','sphere','capsule','trimesh','convex','none'].map(id => ({ id, label: id, title: COLLIDER_HINT[id] })),
          value: _entity.custom?._collider || _entity.collider?.type || 'box',
          onChange: (id) => { _onChange?.('collider', id); showToast('Collider rebuilding: ' + id) }
        })
      )
    ) : null

    // Scale link/lock: a small toggle button placed next to the Scale row's label. When locked, editing one
    // axis proportionally scales the other two (writeScale above); the button itself just flips the flag stored
    // on the entity (survives across renders/re-selection the same way bodyType/collider do).
    const scaleLocked = !!_entity[scaleLockKey]
    const scaleLinkBtn = h('button', {
      class: 'ds-ep-scale-link', title: scaleLocked ? 'Uniform scale locked (click to unlock)' : 'Lock uniform scale',
      style: 'font-size:10px;line-height:1;padding:2px 5px;margin-left:4px;cursor:pointer;flex:0 0 auto;' + (scaleLocked ? 'opacity:1;font-weight:700' : 'opacity:0.5'),
      onclick: (e) => { e.preventDefault(); _entity[scaleLockKey] = !scaleLocked; render() }
    }, scaleLocked ? '🔒' : '🔓')
    const scaleField = h('div', { style: 'display:flex;align-items:center' },
      h('div', { style: 'flex:1;min-width:0' }, vecField('Scale', _entity.scale || [1,1,1], 'scale', writeScale)),
      scaleLinkBtn
    )

    const transformSection = _collapsedSections.transform ? null : h('div', { class: 'ds-ep-section-body' }, [
      vecField('Position', _entity.position || [0,0,0], 'position'),
      rotationField,
      scaleField
    ])
    const colliderSection = (!colliderField || _collapsedSections.collider) ? null : h('div', { class: 'ds-ep-section-body' }, [colliderField])

    const grid = C.PropertyGrid({ children: [
      bodyTypeField,
      sectionHeader('transform', 'Transform', render),
      transformSection,
      ...(colliderField ? [sectionHeader('collider', 'Collider', render), colliderSection] : [])
    ].filter(Boolean) })

    // Stable id so applyDiff reconciles this host instead of rebuilding it (which dropped drag/focus state).
    const propsHostId = 'editor-inspector-app-props'
    const propsSectionHeader = _eProps.length ? sectionHeader('appProps', 'App Props', render) : null
    const propsHost = _eProps.length
      ? h('div', { id: propsHostId, class: 'ds-ep-panel-section', style: 'padding:6px 8px;display:' + (_collapsedSections.appProps ? 'none' : 'block') })
      : null

    const editBtn = _entity._appName
      ? Btn({ primary: true, dense: true, onClick: (e) => { e.preventDefault(); onEditCode?.(_entity._appName) }, children: ['Edit Code'] })
      : null

    const delBtn = Btn({
      danger: true, dense: true,
      onClick: async (e) => {
        e.preventDefault()
        if (!onDestroyEntity || !_entity) return
        const id = _entity.id
        const ok = await showConfirm({
          title: 'Delete entity',
          message: 'Permanently delete ' + id + '?',
          confirmLabel: 'Delete', destructive: true
        })
        if (!ok) return
        try { onDestroyEntity(id); _entity = null; render(); showToast('Deleted ' + id) }
        catch (err) { showToast('Delete failed: ' + err.message, 'error') }
      },
      children: ['Delete Entity']
    })

    // Editable name: seeded from the entity's label (custom.label) falling back to its id. Committing routes
    // through onRename -> the existing server SET_LABEL (0x96) path, so a maker can name entities (killfeed,
    // save keys, hierarchy readability) without leaving the inspector. Blank commit reverts to the id.
    const nameHead = onRename
      ? h('input', {
          class: 'ds-input-bare', value: _entity.custom?.label || _entity.id,
          title: _entity.id, style: 'flex:1;min-width:0;font:inherit;background:transparent',
          onchange: (e) => { const v = e.target.value.trim(); onRename(_entity.id, v || _entity.id); if (!v) e.target.value = _entity.id }
        })
      : h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, _entity.id)
    applyDiff(container, [
      h('div', { class: 'ds-ep-panel-head' }, nameHead),
      h('div', { class: 'ds-ep-panel-body' }, grid),
      propsSectionHeader,
      propsHost,
      h('div', { class: 'ds-ep-actionbar' }, [editBtn, delBtn].filter(Boolean))
    ].filter(Boolean))

    if (_eProps.length) {
      const host = container.querySelector('#' + propsHostId)
      // Keep collapsed/expanded display in sync even when the sig-gated rebuild below is skipped (a toggle
      // click alone doesn't change the entity/prop-key sig, so it must be applied unconditionally here).
      if (host) host.style.display = _collapsedSections.appProps ? 'none' : 'block'
      // Only rebuild content when entity id/prop keys change, or a drag-triggered re-render duplicates fields and steals focus.
      const sig = (_entity?.id || '') + '|' + _eProps.map(f => f.key || f.name || '').join(',')
      if (host && host.dataset.sig !== sig) {
        host.dataset.sig = sig
        host.replaceChildren()
        const getEnt = () => _entity, getCb = () => _onChange
        for (const f of _eProps) host.appendChild(propField(f, getEnt, getCb))
      }
    }
  }

  render()

  return {
    showEntity(entity, eProps, extraIds, extraEntities) { _entity = entity; _eProps = eProps || []; _extraIds = extraIds || []; _extraEntities = extraEntities || []; render() },
    onEditorChange(cb) { _onChange = cb },
    clearEntity() { _entity = null; render() },
    get selectedEntity() { return _entity }
  }
}
