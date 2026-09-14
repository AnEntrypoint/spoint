const DEFAULT_LAYER = 'Default'

export function createLayerRegistry({ setLocked, setHidden, isLocked, isHidden, sendLayerUpdate } = {}) {
  const _layers = new Map([[DEFAULT_LAYER, { visible: true, locked: false }]])
  const _memberLayer = new Map()

  function ensureLayer(name) {
    if (!name || typeof name !== 'string') throw new Error('createLayer: name required')
    if (!_layers.has(name)) _layers.set(name, { visible: true, locked: false })
    return _layers.get(name)
  }

  function deleteLayer(name) {
    if (name === DEFAULT_LAYER) return false
    if (!_layers.has(name)) return false
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
