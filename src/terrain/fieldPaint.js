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

  function stroke({ field, layer, center, radius, fn, place = [0, 0] }) {
    const grid = layerOf(field, layer)
    if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) throw refusal('center-invalid', 'center must be [x, z] of finite numbers')
    if (!Array.isArray(place) || place.length !== 2 || !place.every(Number.isFinite)) throw refusal('place-invalid', 'place must be [x, z] of finite numbers')
    const origin = [center[0] + place[0], center[1] + place[1]]
    if (!(radius > 0)) throw refusal('radius-invalid', 'radius must be a positive number')
    if (typeof fn !== 'function') throw refusal('stroke-fn-invalid', 'fn must be a function of (p, inset, current)')
    const cells = []
    for (let x = origin[0] - radius; x <= origin[0] + radius; x += cellSize) {
      for (let z = origin[1] - radius; z <= origin[1] + radius; z += cellSize) {
        const d = Math.hypot(x - origin[0], z - origin[1])
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

  function toJSON() {
    const out = {}
    for (const [name, layers] of fields) {
      out[name] = {}
      for (const [layer, grid] of layers) out[name][layer] = grid.exportRuntime()
    }
    return out
  }

  function fromJSON(doc) {
    if (doc === null || typeof doc !== 'object') throw refusal('paint-doc-invalid', 'paint document must be an object keyed by field name')
    for (const name of Object.keys(doc)) {
      if (!fields.has(name)) throw refusal('field-unknown', `saved field "${name}" is not one of ${TERRAIN_FIELD_NAMES.join(', ')}`)
      for (const layer of Object.keys(doc[name])) layerOf(name, layer).importRuntime(doc[name][layer])
    }
    return doc
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

  return Object.freeze({ stroke, undo, read, chunkObject, toJSON, fromJSON, fieldNames: TERRAIN_FIELD_NAMES, layerNames: FIELD_LAYER_NAMES })
}

export const PAINTED_HEIGHT_FIELD = 'terrain:height'
export const NATURAL_MASK_FIELD = 'terrain:natural-mask'

export function wrapHeightWithFieldPaint(paint, heightFn) {
  if (paint === null) return heightFn
  if (typeof paint.read !== 'function') throw refusal('paint-invalid', 'paint must be a createFieldPaint instance')
  return (x, z, yGuess) => heightFn(x, z, yGuess) + paint.read(PAINTED_HEIGHT_FIELD, x, z)
}

export function naturalMaskAt(paint, x, z) {
  if (typeof paint?.read !== 'function') throw refusal('paint-invalid', 'paint must be a createFieldPaint instance')
  return paint.read(NATURAL_MASK_FIELD, x, z)
}

export function createHostFieldPaint(terrainCfg) {
  const fp = terrainCfg?.fieldPaint
  if (fp === undefined) return createFieldPaint({ cellSize: 1, chunkCells: 64 })
  if (fp === null || typeof fp !== 'object') throw refusal('field-paint-config-invalid', 'terrain.fieldPaint must be an object with cellSize and chunkCells')
  const cellSize = fp.cellSize ?? 1
  const chunkCells = fp.chunkCells ?? 64
  if (typeof cellSize !== 'number' || !Number.isFinite(cellSize) || cellSize <= 0) throw refusal('field-paint-cell-size-invalid', 'terrain.fieldPaint.cellSize must be a positive finite number')
  if (!Number.isInteger(chunkCells) || chunkCells < 1) throw refusal('field-paint-chunk-cells-invalid', 'terrain.fieldPaint.chunkCells must be an integer of at least 1')
  return createFieldPaint({ cellSize, chunkCells })
}
