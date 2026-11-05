export class TouchSurfaceSpecError extends Error {
  constructor(reasonCode, detail) {
    super(`[touch-surface] ${reasonCode}: ${detail}`)
    this.name = 'TouchSurfaceSpecError'
    this.reasonCode = reasonCode
  }
}

export const TOUCH_SURFACE_KINDS = Object.freeze(['stick', 'button', 'pad', 'orientation'])
export const TOUCH_SURFACE_ANCHORS = Object.freeze(['left', 'right'])

const isUnitNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
const isPositiveNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0

const FIELD_RULES = {
  id: [isNonEmptyString, 'nonEmptyString'],
  kind: [(v) => TOUCH_SURFACE_KINDS.includes(v), `one of ${TOUCH_SURFACE_KINDS.join('|')}`],
  anchor: [(v) => TOUCH_SURFACE_ANCHORS.includes(v), `one of ${TOUCH_SURFACE_ANCHORS.join('|')}`],
  x: [isUnitNumber, 'number in [0,1]'],
  y: [isUnitNumber, 'number in [0,1]'],
  size: [isPositiveNumber, 'positive finite number'],
  action: [isNonEmptyString, 'nonEmptyString'],
}

export function parseTouchSurfaces(spec) {
  if (spec === null || typeof spec !== 'object' || !Array.isArray(spec.surfaces)) {
    throw new TouchSurfaceSpecError('no-surfaces-array', 'spec.surfaces must be an array')
  }
  const seen = new Set()
  return spec.surfaces.map((raw, index) => {
    if (raw === null || typeof raw !== 'object') {
      throw new TouchSurfaceSpecError('surface-not-object', `surfaces[${index}]`)
    }
    for (const [field, [ok, expected]] of Object.entries(FIELD_RULES)) {
      if (!ok(raw[field])) {
        throw new TouchSurfaceSpecError('bad-field', `surfaces[${index}].${field} must be ${expected}`)
      }
    }
    if (seen.has(raw.id)) {
      throw new TouchSurfaceSpecError('duplicate-id', `surfaces[${index}].id ${raw.id}`)
    }
    seen.add(raw.id)
    return Object.freeze({ id: raw.id, kind: raw.kind, anchor: raw.anchor, x: raw.x, y: raw.y, size: raw.size, action: raw.action })
  })
}
