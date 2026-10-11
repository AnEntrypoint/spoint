export function brushPrecondition(requires, holds) {
  if (holds.length !== requires.length) throw new Error('[terrain] brush contract: ' + holds.length + ' checks for ' + requires.length + ' clauses')
  for (let i = 0; i < requires.length; i++) {
    if (holds[i]) continue
    return { rejected: true, requires, violates: requires[i], touched: 0 }
  }
  return null
}

export function brushApplied(strokes, touched, stroke) {
  if (!Number.isInteger(touched) || touched < 0) throw new Error('[terrain] brush postcondition: touched ' + touched + ' is not a whole non-negative cell count')
  if (touched > 0) {
    if (!stroke) throw new Error('[terrain] brush postcondition: ' + touched + ' cells touched with no stroke to record')
    strokes.push(stroke)
  }
  return { rejected: false, requires: null, violates: null, touched }
}

export const STRENGTH_REQUIRES = Object.freeze(['strength clamps above zero'])
