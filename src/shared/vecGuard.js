// vecOK is a pure predicate (never throws) for hot paths; vec(n) throws a TypeError at the assignment site
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
