function createLivePreview({ getSelectedEntity, getMesh, onChange, onRevert }) {
  let _enabled = true
  let _previewStates = new Map()

  function _captureState(entity, mesh) {
    if (!entity || !mesh) return null
    return {
      entityId: entity.id,
      position: entity.position ? [...entity.position] : null,
      rotation: entity.rotation ? [...entity.rotation] : null,
      scale: entity.scale ? [...entity.scale] : null,
      custom: entity.custom ? JSON.parse(JSON.stringify(entity.custom)) : {},
      meshPosition: mesh.position.toArray(),
      meshRotation: mesh.quaternion.toArray(),
      meshScale: mesh.scale.toArray()
    }
  }

  function _selectEntity(entity) {
    if (!entity) {
      _previewStates.clear()
      return
    }
    const mesh = getMesh(entity.id)
    const state = _captureState(entity, mesh)
    if (state) _previewStates.set(entity.id, state)
  }

  function reset() {
    const entity = getSelectedEntity()
    if (!entity) return false
    const mesh = getMesh(entity.id)
    if (!mesh) return false
    const original = _previewStates.get(entity.id)
    if (!original) return false

    entity.position = original.position
    entity.rotation = original.rotation
    entity.scale = original.scale
    entity.custom = JSON.parse(JSON.stringify(original.custom))

    if (original.meshPosition) mesh.position.fromArray(original.meshPosition)
    if (original.meshRotation) mesh.quaternion.fromArray(original.meshRotation)
    if (original.meshScale) mesh.scale.fromArray(original.meshScale)

    onRevert?.(entity)
    return true
  }

  function toggle() {
    _enabled = !_enabled
    return _enabled
  }

  return {
    selectEntity: _selectEntity,
    reset,
    toggle,
    get enabled() { return _enabled },
    set enabled(v) { _enabled = !!v }
  }
}

export { createLivePreview }
