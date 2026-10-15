export function vecOK(v, n) {
  return Array.isArray(v) && v.length === n &&
    !v.some(x => typeof x !== 'number' || !Number.isFinite(x))
}

export let vec = (n) => (v, name) => {
  if (!vecOK(v, n)) throw new TypeError(`entity.${name} must be a length-${n} array of finite numbers`)
  return v
}

export let vec3 = vec(3)
export let vec4 = vec(4)

export function num(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${name} must be a finite number`)
  return v
}

export function nonNeg(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new TypeError(`${name} must be a non-negative finite number`)
  return v
}

// --- hot swap ----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapvecGuard = (next) => {
  vecOK = next.vecOK
  vec = next.vec
  vec3 = next.vec3
  vec4 = next.vec4
  num = next.num
  nonNeg = next.nonNeg
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapvecGuard)
