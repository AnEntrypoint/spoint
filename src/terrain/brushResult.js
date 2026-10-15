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

export let STRENGTH_REQUIRES = Object.freeze(['strength clamps above zero'])

// --- hot swap -----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapBrushResult = (next) => {
  brushPrecondition = next.brushPrecondition
  brushApplied = next.brushApplied
  STRENGTH_REQUIRES = next.STRENGTH_REQUIRES
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapBrushResult)
