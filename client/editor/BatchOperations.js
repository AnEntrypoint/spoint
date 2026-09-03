export function createBatchOperations({ entities = {}, history, updateEntity, onGuideRender }) {
  const GRID_SNAP_DEFAULT = 0.5
  const PERFORMANCE_TARGET_MS = 10

  let gridSnapEnabled = false
  let gridSnapSize = GRID_SNAP_DEFAULT

  function _getSelectedIds(selectedId, extraIds = new Set()) {
    return [selectedId, ...extraIds]
  }

  function _getEntityPositions(ids) {
    const positions = {}
    for (const id of ids) {
      const entity = entities[id]
      if (entity) {
        positions[id] = entity.position ? [entity.position.x, entity.position.y, entity.position.z] : [0, 0, 0]
      }
    }
    return positions
  }

  function _getEntityBounds(ids) {
    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity
    let minZ = Infinity, maxZ = -Infinity

    for (const id of ids) {
      const entity = entities[id]
      if (!entity || !entity.position) continue
      const p = entity.position
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
    }

    return {
      minX, maxX, minY, maxY, minZ, maxZ,
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
      centerZ: (minZ + maxZ) / 2,
      width: maxX - minX,
      height: maxY - minY,
      depth: maxZ - minZ
    }
  }

  function _snapToGrid(value) {
    if (!gridSnapEnabled) return value
    return Math.round(value / gridSnapSize) * gridSnapSize
  }

  function _createHistoryRecord(id, before, after, kind) {
    return { entityId: id, before, after, kind }
  }

  function alignX(ids, alignment, guides = null) {
    const t0 = performance.now()
    const records = []
    const bounds = _getEntityBounds(ids)
    const positions = _getEntityPositions(ids)

    let targetX
    switch (alignment) {
      case 'left': targetX = bounds.minX; break
      case 'right': targetX = bounds.maxX; break
      case 'center': targetX = bounds.centerX; break
      default: return
    }
    targetX = _snapToGrid(targetX)

    for (const id of ids) {
      const entity = entities[id]
      if (!entity || !entity.position) continue
      const before = { position: { x: entity.position.x, y: entity.position.y, z: entity.position.z } }
      const after = { position: { x: targetX, y: entity.position.y, z: entity.position.z } }
      entity.position.x = targetX
      updateEntity(id, after)
      records.push(_createHistoryRecord(id, before, after, 'align-x'))
    }

    if (guides && onGuideRender) {
      onGuideRender({ type: 'line', x: targetX, axis: 'x', duration: 500 })
    }

    for (const record of records) history.push(record)
    const elapsed = performance.now() - t0
    return { success: true, elapsed, targetCount: ids.length }
  }

  function alignY(ids, alignment, guides = null) {
    const t0 = performance.now()
    const records = []
    const bounds = _getEntityBounds(ids)

    let targetY
    switch (alignment) {
      case 'top': targetY = bounds.maxY; break
      case 'bottom': targetY = bounds.minY; break
      case 'center': targetY = bounds.centerY; break
      default: return
    }
    targetY = _snapToGrid(targetY)

    for (const id of ids) {
      const entity = entities[id]
      if (!entity || !entity.position) continue
      const before = { position: { x: entity.position.x, y: entity.position.y, z: entity.position.z } }
      const after = { position: { x: entity.position.x, y: targetY, z: entity.position.z } }
      entity.position.y = targetY
      updateEntity(id, after)
      records.push(_createHistoryRecord(id, before, after, 'align-y'))
    }

    if (guides && onGuideRender) {
      onGuideRender({ type: 'line', y: targetY, axis: 'y', duration: 500 })
    }

    for (const record of records) history.push(record)
    const elapsed = performance.now() - t0
    return { success: true, elapsed, targetCount: ids.length }
  }

  function alignZ(ids, alignment, guides = null) {
    const t0 = performance.now()
    const records = []
    const bounds = _getEntityBounds(ids)

    let targetZ
    switch (alignment) {
      case 'front': targetZ = bounds.maxZ; break
      case 'back': targetZ = bounds.minZ; break
      case 'center': targetZ = bounds.centerZ; break
      default: return
    }
    targetZ = _snapToGrid(targetZ)

    for (const id of ids) {
      const entity = entities[id]
      if (!entity || !entity.position) continue
      const before = { position: { x: entity.position.x, y: entity.position.y, z: entity.position.z } }
      const after = { position: { x: entity.position.x, y: entity.position.y, z: targetZ } }
      entity.position.z = targetZ
      updateEntity(id, after)
      records.push(_createHistoryRecord(id, before, after, 'align-z'))
    }

    if (guides && onGuideRender) {
      onGuideRender({ type: 'line', z: targetZ, axis: 'z', duration: 500 })
    }

    for (const record of records) history.push(record)
    const elapsed = performance.now() - t0
    return { success: true, elapsed, targetCount: ids.length }
  }

  function distributeX(ids) {
    if (ids.length < 3) return { success: false, error: 'Need at least 3 entities' }
    const t0 = performance.now()
    const records = []
    const positions = _getEntityPositions(ids)
    const sorted = ids.sort((a, b) => (positions[a]?.[0] ?? 0) - (positions[b]?.[0] ?? 0))
    const bounds = _getEntityBounds(sorted)
    const spacing = bounds.width / (sorted.length - 1)

    for (let i = 0; i < sorted.length; i++) {
      const id = sorted[i]
      const entity = entities[id]
      if (!entity || !entity.position) continue
      const targetX = _snapToGrid(bounds.minX + spacing * i)
      const before = { position: { x: entity.position.x, y: entity.position.y, z: entity.position.z } }
      const after = { position: { x: targetX, y: entity.position.y, z: entity.position.z } }
      entity.position.x = targetX
      updateEntity(id, after)
      records.push(_createHistoryRecord(id, before, after, 'distribute-x'))
    }

    for (const record of records) history.push(record)
    const elapsed = performance.now() - t0
    return { success: true, elapsed, targetCount: ids.length, spacing }
  }

  function distributeY(ids) {
    if (ids.length < 3) return { success: false, error: 'Need at least 3 entities' }
    const t0 = performance.now()
    const records = []
    const positions = _getEntityPositions(ids)
    const sorted = ids.sort((a, b) => (positions[a]?.[1] ?? 0) - (positions[b]?.[1] ?? 0))
    const bounds = _getEntityBounds(sorted)
    const spacing = bounds.height / (sorted.length - 1)

    for (let i = 0; i < sorted.length; i++) {
      const id = sorted[i]
      const entity = entities[id]
      if (!entity || !entity.position) continue
      const targetY = _snapToGrid(bounds.minY + spacing * i)
      const before = { position: { x: entity.position.x, y: entity.position.y, z: entity.position.z } }
      const after = { position: { x: entity.position.x, y: targetY, z: entity.position.z } }
      entity.position.y = targetY
      updateEntity(id, after)
      records.push(_createHistoryRecord(id, before, after, 'distribute-y'))
    }

    for (const record of records) history.push(record)
    const elapsed = performance.now() - t0
    return { success: true, elapsed, targetCount: ids.length, spacing }
  }

  function distributeZ(ids) {
    if (ids.length < 3) return { success: false, error: 'Need at least 3 entities' }
    const t0 = performance.now()
    const records = []
    const positions = _getEntityPositions(ids)
    const sorted = ids.sort((a, b) => (positions[a]?.[2] ?? 0) - (positions[b]?.[2] ?? 0))
    const bounds = _getEntityBounds(sorted)
    const spacing = bounds.depth / (sorted.length - 1)

    for (let i = 0; i < sorted.length; i++) {
      const id = sorted[i]
      const entity = entities[id]
      if (!entity || !entity.position) continue
      const targetZ = _snapToGrid(bounds.minZ + spacing * i)
      const before = { position: { x: entity.position.x, y: entity.position.y, z: entity.position.z } }
      const after = { position: { x: entity.position.x, y: entity.position.y, z: targetZ } }
      entity.position.z = targetZ
      updateEntity(id, after)
      records.push(_createHistoryRecord(id, before, after, 'distribute-z'))
    }

    for (const record of records) history.push(record)
    const elapsed = performance.now() - t0
    return { success: true, elapsed, targetCount: ids.length, spacing }
  }

  function matchScale(ids) {
    if (ids.length < 2) return { success: false, error: 'Need at least 2 entities' }
    const t0 = performance.now()
    const records = []
    const primary = entities[ids[0]]
    if (!primary || !primary.scale) return { success: false, error: 'Primary entity missing scale' }

    const targetScale = { x: primary.scale.x, y: primary.scale.y, z: primary.scale.z }

    for (let i = 1; i < ids.length; i++) {
      const id = ids[i]
      const entity = entities[id]
      if (!entity || !entity.scale) continue
      const before = { scale: { x: entity.scale.x, y: entity.scale.y, z: entity.scale.z } }
      const after = { scale: targetScale }
      entity.scale.x = targetScale.x; entity.scale.y = targetScale.y; entity.scale.z = targetScale.z
      updateEntity(id, after)
      records.push(_createHistoryRecord(id, before, after, 'match-scale'))
    }

    for (const record of records) history.push(record)
    const elapsed = performance.now() - t0
    return { success: true, elapsed, targetCount: ids.length - 1 }
  }

  function matchRotation(ids) {
    if (ids.length < 2) return { success: false, error: 'Need at least 2 entities' }
    const t0 = performance.now()
    const records = []
    const primary = entities[ids[0]]
    if (!primary || !primary.quaternion) return { success: false, error: 'Primary entity missing rotation' }

    const targetQuaternion = { x: primary.quaternion.x, y: primary.quaternion.y, z: primary.quaternion.z, w: primary.quaternion.w }

    for (let i = 1; i < ids.length; i++) {
      const id = ids[i]
      const entity = entities[id]
      if (!entity || !entity.quaternion) continue
      const before = { quaternion: { x: entity.quaternion.x, y: entity.quaternion.y, z: entity.quaternion.z, w: entity.quaternion.w } }
      const after = { quaternion: targetQuaternion }
      entity.quaternion.x = targetQuaternion.x
      entity.quaternion.y = targetQuaternion.y
      entity.quaternion.z = targetQuaternion.z
      entity.quaternion.w = targetQuaternion.w
      updateEntity(id, after)
      records.push(_createHistoryRecord(id, before, after, 'match-rotation'))
    }

    for (const record of records) history.push(record)
    const elapsed = performance.now() - t0
    return { success: true, elapsed, targetCount: ids.length - 1 }
  }

  function setGridSnap(enabled, snapSize = GRID_SNAP_DEFAULT) {
    gridSnapEnabled = enabled
    gridSnapSize = snapSize
    return { gridSnapEnabled, gridSnapSize }
  }

  return {
    alignX,
    alignY,
    alignZ,
    distributeX,
    distributeY,
    distributeZ,
    matchScale,
    matchRotation,
    setGridSnap,
    getGridSnap: () => ({ gridSnapEnabled, gridSnapSize })
  }
}
