import { hash3, rand } from './VegPlacement.js'

export class DecorationConfigError extends Error {
  constructor(reasonCode, detail) {
    super(`[decoration] ${reasonCode}: ${detail}`)
    this.name = 'DecorationConfigError'
    this.reasonCode = reasonCode
  }
}

function unitInterval(value, where) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new DecorationConfigError('badDensity', `${where} must be a finite number in [0, 1]`)
  }
  return value
}

function optionalRange(value, where) {
  if (value === undefined) return null
  if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite) || value[0] > value[1]) {
    throw new DecorationConfigError('badRange', `${where} must be [min, max] with min <= max`)
  }
  return Object.freeze([value[0], value[1]])
}

function optionalBudget(value, where) {
  if (value === undefined) return Infinity
  if (!Number.isInteger(value) || value < 0) {
    throw new DecorationConfigError('badBudget', `${where} must be a non-negative integer`)
  }
  return value
}

function flag(value, where) {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new DecorationConfigError('badFlag', `${where} must be a boolean`)
  return value
}

function itemsPerM2Of(value, where) {
  if (value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new DecorationConfigError('badDensity', `${where} must be a finite number >= 0`)
  }
  return value
}

function itemOf(value, where) {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object') throw new DecorationConfigError('badItem', `${where} must be an object`)
  if (value.kind === 'sprite') {
    if (typeof value.sprite !== 'string' || value.sprite.length === 0) throw new DecorationConfigError('badItem', `${where}.sprite must name a sprite`)
    return Object.freeze({ kind: 'sprite', ref: value.sprite })
  }
  if (value.kind === 'scripted') {
    if (typeof value.script !== 'string' || value.script.length === 0) throw new DecorationConfigError('badItem', `${where}.script must name a script`)
    return Object.freeze({ kind: 'scripted', ref: value.script })
  }
  throw new DecorationConfigError('badItem', `${where}.kind must be sprite or scripted`)
}

function saltOf(id) {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0
  return h
}

export function parseDecorationDef(def) {
  if (def === null || typeof def !== 'object') {
    throw new DecorationConfigError('badLayer', 'decorations must be an object')
  }
  const layers = new Map()
  for (const [id, spec] of Object.entries(def.layers ?? {})) {
    if (spec === null || typeof spec !== 'object') {
      throw new DecorationConfigError('badLayer', `layers.${id} must be an object`)
    }
    const constraints = spec.constraints ?? {}
    layers.set(id, Object.freeze({
      id,
      salt: saltOf(id),
      density: spec.itemsPerM2 === undefined ? unitInterval(spec.density, `layers.${id}.density`) : 0,
      slopeRange: optionalRange(constraints.slopeRange, `layers.${id}.constraints.slopeRange`),
      heightRange: optionalRange(constraints.heightRange, `layers.${id}.constraints.heightRange`),
      budget: optionalBudget(spec.budget, `layers.${id}.budget`),
      itemsPerM2: itemsPerM2Of(spec.itemsPerM2, `layers.${id}.itemsPerM2`),
      paintedOnly: flag(spec.paintedOnly, `layers.${id}.paintedOnly`),
      item: itemOf(spec.item, `layers.${id}.item`),
      avoidWater: flag(spec.avoidWater, `layers.${id}.avoidWater`),
      maxWaterDepth: itemsPerM2Of(spec.maxWaterDepth, `layers.${id}.maxWaterDepth`) ?? 0,
    }))
  }
  const bindings = new Map()
  for (const [material, ids] of Object.entries(def.bindings ?? {})) {
    if (!Array.isArray(ids)) {
      throw new DecorationConfigError('badBinding', `bindings.${material} must be an array of layer ids`)
    }
    for (const id of ids) {
      if (!layers.has(id)) throw new DecorationConfigError('unknownLayer', `bindings.${material} names ${id}`)
    }
    bindings.set(material, Object.freeze(ids.map((id) => layers.get(id))))
  }
  return Object.freeze({ layers, bindings })
}

function inRange(range, value) {
  return range === null || (value >= range[0] && value <= range[1])
}

export function acceptsCell(layer, cell) {
  if (!inRange(layer.slopeRange, cell.slope) || !inRange(layer.heightRange, cell.height)) return false
  if (layer.paintedOnly && cell.painted !== true) return false
  if (layer.avoidWater) {
    if (!Number.isFinite(cell.waterDepth)) throw new DecorationConfigError('noWaterDepth', `layer ${layer.id} avoids water but the cell has no waterDepth`)
    if (cell.waterDepth > layer.maxWaterDepth) return false
  }
  const chance = layer.itemsPerM2 === null ? layer.density : Math.min(1, layer.itemsPerM2 * cell.area)
  return rand(hash3(cell.seed, cell.ix, cell.iz), layer.salt) < chance
}

export function decorateCells(decor, cells) {
  const placed = []
  const used = new Map()
  for (const cell of cells) {
    for (const layer of decor.bindings.get(cell.material) ?? []) {
      const count = used.get(layer.id) ?? 0
      if (count >= layer.budget || !acceptsCell(layer, cell)) continue
      used.set(layer.id, count + 1)
      placed.push({ layer: layer.id, ix: cell.ix, iz: cell.iz })
    }
  }
  return placed
}
