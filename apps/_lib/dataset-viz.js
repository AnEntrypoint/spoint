import { computeLayout } from '../../src/sdk/FreddieBridge.js'

export function createDatasetViz(spec, ctx) {
  const layout = spec.layout || 'grid'
  const config = spec.config || {}
  const spacing = config.spacing ?? 1
  const sizeRange = config.sizeRange || [0.1, 1]
  const colorRange = config.colorRange || [0, 1]
  const colorLow = config.colorLow ?? 0x3366ff
  const colorHigh = config.colorHigh ?? 0xff3333

  let _childIds = []

  function _mapColor(value) {
    const t = colorRange[1] === colorRange[0] ? 0.5 : Math.max(0, Math.min(1, (value - colorRange[0]) / (colorRange[1] - colorRange[0])))
    const r0 = (colorLow >> 16) & 0xff, g0 = (colorLow >> 8) & 0xff, b0 = colorLow & 0xff
    const r1 = (colorHigh >> 16) & 0xff, g1 = (colorHigh >> 8) & 0xff, b1 = colorHigh & 0xff
    const r = Math.round(r0 + (r1 - r0) * t)
    const g = Math.round(g0 + (g1 - g0) * t)
    const b = Math.round(b0 + (b1 - b0) * t)
    return (r << 16) | (g << 8) | b
  }

  function _mapSize(value) {
    const t = colorRange[1] === colorRange[0] ? 0.5 : Math.max(0, Math.min(1, (value - colorRange[0]) / (colorRange[1] - colorRange[0])))
    const s = sizeRange[0] + (sizeRange[1] - sizeRange[0]) * t
    return [s, s, s]
  }

  function spawn() {
    clear()
    const items = spec.items || []
    const positions = computeLayout(items, layout, { spacing })
    const ids = []
    for (const item of items) {
      const pos = item.position || positions.get(item.id) || [0, 0, 0]
      const color = item.color ?? _mapColor(item.value ?? 0)
      const scale = _mapSize(item.value ?? 0)
      const childId = ctx.world.spawnChild(ctx.entity.id, {
        position: pos,
        scale,
        custom: {
          mesh: 'box',
          color,
          roughness: 0.5,
          metalness: 0.1,
          label: item.label || item.id,
          _freddieDatasetItem: true,
        },
      })
      ids.push(childId)
    }
    _childIds = ids
    return ids
  }

  function clear() {
    for (const id of _childIds) {
      ctx.world.destroyEntity(id)
    }
    _childIds = []
  }

  function update(items) {
    spec.items = items
    spawn()
  }

  function getChildIds() {
    return [..._childIds]
  }

  return { spawn, clear, update, getChildIds }
}