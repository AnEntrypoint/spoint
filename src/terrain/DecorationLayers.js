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
      density: unitInterval(spec.density, `layers.${id}.density`),
      slopeRange: optionalRange(constraints.slopeRange, `layers.${id}.constraints.slopeRange`),
      heightRange: optionalRange(constraints.heightRange, `layers.${id}.constraints.heightRange`),
      budget: optionalBudget(spec.budget, `layers.${id}.budget`),
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
  return rand(hash3(cell.seed, cell.ix, cell.iz), layer.salt) < layer.density
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
