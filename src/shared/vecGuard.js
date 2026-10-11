export function vecOK(v, n) {
  return Array.isArray(v) && v.length === n &&
    !v.some(x => typeof x !== 'number' || !Number.isFinite(x))
}

export const vec = (n) => (v, name) => {
  if (!vecOK(v, n)) throw new TypeError(`entity.${name} must be a length-${n} array of finite numbers`)
  return v
}

export const vec3 = vec(3)
export const vec4 = vec(4)

export function num(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${name} must be a finite number`)
  return v
}

export function nonNeg(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new TypeError(`${name} must be a non-negative finite number`)
  return v
}
