import { createFieldLayers } from './FieldLayers.js'

export const TERRAIN_FIELD_NAMES = Object.freeze(['terrain:height', 'terrain:water', 'terrain:natural-mask'])
export const FIELD_LAYER_NAMES = Object.freeze(['PLAYER', 'CREATOR'])

function refusal(code, message) {
  const err = new RangeError(`[field-paint] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function createFieldPaint({ cellSize, chunkCells }) {
  const fields = new Map(TERRAIN_FIELD_NAMES.map(name => [name, new Map(FIELD_LAYER_NAMES.map(layer => [layer, createFieldLayers({ cellSize, chunkCells })]))]))
  const history = []

  function layerOf(name, layer) {
    const layers = fields.get(name)
    if (!layers) throw refusal('field-unknown', `field "${name}" is not one of ${TERRAIN_FIELD_NAMES.join(', ')}`)
    const grid = layers.get(layer)
    if (!grid) throw refusal('layer-unknown', `layer "${layer}" is not one of ${FIELD_LAYER_NAMES.join(', ')}`)
    return grid
  }

  function stroke({ field, layer, center, radius, fn }) {
    const grid = layerOf(field, layer)
    if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) throw refusal('center-invalid', 'center must be [x, z] of finite numbers')
    if (!(radius > 0)) throw refusal('radius-invalid', 'radius must be a positive number')
    if (typeof fn !== 'function') throw refusal('stroke-fn-invalid', 'fn must be a function of (p, inset, current)')
    const cells = []
    for (let x = center[0] - radius; x <= center[0] + radius; x += cellSize) {
      for (let z = center[1] - radius; z <= center[1] + radius; z += cellSize) {
        const d = Math.hypot(x - center[0], z - center[1])
        if (d > radius) continue
        const current = grid.readField(x, z)
        const delta = fn([x, z], 1 - d / radius, current) - current
        if (delta === 0) continue
        grid.paint(x, z, delta)
        cells.push({ x, z, delta })
      }
    }
    history.push({ field, layer, cells })
    return cells.length
  }

  function undo() {
    const last = history.pop()
    if (!last) return false
    const grid = layerOf(last.field, last.layer)
    for (const c of last.cells) grid.paint(c.x, c.z, -c.delta)
    return true
  }

  function read(field, x, z) {
    let sum = 0
    for (const layer of FIELD_LAYER_NAMES) sum += layerOf(field, layer).readField(x, z)
    return sum
  }

  function chunkObject(field, layer, kx, kz) {
    const grid = layerOf(field, layer)
    const key = `${kx},${kz}`
    return { cellSize, chunkCells, key, painted: grid.paintedChunks().includes(key), version: grid.changes(0).at }
  }

  return Object.freeze({ stroke, undo, read, chunkObject, fieldNames: TERRAIN_FIELD_NAMES, layerNames: FIELD_LAYER_NAMES })
}
