// editor-layers-panel: named-layer grouping on top of SceneHierarchy.js's existing per-entity
// _locked/_hiddenInEditor sets. A layer is a client-side-only (like lock/hidden) named group with
// its own visibility/lock toggle that cascades to every member entity's individual flags -- the
// per-entity flags remain the single source of truth SceneHierarchy/editor.js/app.js already read,
// so this module never introduces a second competing lock/hidden mechanism, only a bulk-apply layer
// on top of it. Entity->layer assignment persists server-side via the existing generic custom.*
// EDITOR_UPDATE merge (src/sdk/EditorHandlers.js's EDITOR_UPDATE handler already does
// entity.custom={...entity.custom,...changes.custom} for ANY custom key with zero server-code
// changes needed) under custom._layer, following the same convention custom._interactable/
// custom._collider already use -- no new message type required.
const DEFAULT_LAYER = 'Default'

export function createLayerRegistry({ setLocked, setHidden, isLocked, isHidden, sendLayerUpdate } = {}) {
  // name -> { visible: bool, locked: bool } -- layer-wide toggle state, independent of any one
  // member's individual flag (a layer toggle cascades OUT to members; it doesn't read them back in,
  // matching how a real-time multi-select "Lock (3)" toast already works one level up).
  const _layers = new Map([[DEFAULT_LAYER, { visible: true, locked: false }]])
  // entityId -> layer name. Entities with no explicit assignment are DEFAULT_LAYER (mirrors every
  // other custom.* field's own "absent means default" convention elsewhere in this codebase).
  const _memberLayer = new Map()

  function ensureLayer(name) {
    if (!name || typeof name !== 'string') throw new Error('createLayer: name required')
    if (!_layers.has(name)) _layers.set(name, { visible: true, locked: false })
    return _layers.get(name)
  }

  function deleteLayer(name) {
    if (name === DEFAULT_LAYER) return false // Default is not removable, same as most DCC tools' base layer
    if (!_layers.has(name)) return false
    // Members fall back to Default rather than becoming orphaned/unassigned.
    for (const [id, layer] of _memberLayer) if (layer === name) _memberLayer.set(id, DEFAULT_LAYER)
    _layers.delete(name)
    return true
  }

  function renameLayer(oldName, newName) {
    if (oldName === DEFAULT_LAYER || !_layers.has(oldName) || !newName || _layers.has(newName)) return false
    const state = _layers.get(oldName)
    _layers.delete(oldName)
    _layers.set(newName, state)
    for (const [id, layer] of _memberLayer) if (layer === oldName) _memberLayer.set(id, newName)
    return true
  }

  function assign(entityId, layerName) {
    ensureLayer(layerName)
    _memberLayer.set(entityId, layerName)
    sendLayerUpdate?.(entityId, layerName)
    // A newly-assigned member inherits the layer's current visibility/lock immediately, so it
    // doesn't sit in a hidden layer while still rendering, or vice versa.
    const state = _layers.get(layerName)
    setHidden?.(entityId, !state.visible)
    setLocked?.(entityId, state.locked)
  }

  function layerOf(entityId) {
    return _memberLayer.get(entityId) || DEFAULT_LAYER
  }

  function membersOf(layerName) {
    const out = []
    for (const [id, layer] of _memberLayer) if (layer === layerName) out.push(id)
    return out
  }

  function setLayerVisible(layerName, visible) {
    const state = ensureLayer(layerName)
    state.visible = !!visible
    for (const id of membersOf(layerName)) setHidden?.(id, !state.visible)
  }

  function setLayerLocked(layerName, locked) {
    const state = ensureLayer(layerName)
    state.locked = !!locked
    for (const id of membersOf(layerName)) setLocked?.(id, state.locked)
  }

  function selectByLayer(layerName) {
    return membersOf(layerName)
  }

  // Hydrates _memberLayer from live entity state (e.g. after a SCENE_GRAPH refresh) by reading each
  // entity's custom._layer -- keeps this registry's assignment map in sync with the actual
  // server-persisted source of truth instead of drifting from it across a reconnect/reload.
  function hydrateFromEntities(entities) {
    for (const e of entities || []) {
      const layer = e?.custom?._layer
      if (layer && typeof layer === 'string') { ensureLayer(layer); _memberLayer.set(e.id, layer) }
    }
  }

  return {
    DEFAULT_LAYER,
    ensureLayer, deleteLayer, renameLayer,
    assign, layerOf, membersOf,
    setLayerVisible, setLayerLocked, selectByLayer,
    hydrateFromEntities,
    get layerNames() { return [..._layers.keys()] },
    getLayerState(name) { return _layers.get(name) || null },
  }
}
