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

const _hotSwapvecGuard = (next) => {
  vecOK = next.vecOK
  vec = next.vec
  vec3 = next.vec3
  vec4 = next.vec4
  num = next.num
  nonNeg = next.nonNeg
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapvecGuard)
