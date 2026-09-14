const isArr = Array.isArray
const _fr = Math.fround

function _flat(args, n) {
  const out = []
  for (const a of args) { if (isArr(a)) { for (const c of a) out.push(c) } else out.push(a) }
  if (out.length === 1) { while (out.length < n) out.push(out[0]) }
  return out.length === n ? out : out.slice(0, n)
}
export const vec3 = (...a) => {
  const l = a.length
  if (l === 3) { const x = a[0], y = a[1], z = a[2]; if (!isArr(x) && !isArr(y) && !isArr(z)) return [x, y, z] }
  else if (l === 1) { const x = a[0]; if (!isArr(x)) return [x, x, x]; if (x.length === 3) return [x[0], x[1], x[2]] }
  return _flat(a, 3)
}
export const vec2 = (...a) => _flat(a, 2)
export const vec4 = (...a) => _flat(a, 4)
export const ivec2 = (...a) => _flat(a, 2).map(Math.trunc)
export const ivec3 = (...a) => {
  if (a.length === 1) { const x = a[0]
    if (isArr(x) && x.length === 3) return [Math.trunc(x[0]), Math.trunc(x[1]), Math.trunc(x[2])]
  }
  return _flat(a, 3).map(Math.trunc)
}
export const uvec2 = (...a) => _flat(a, 2).map(v => v >>> 0)
export const uvec3 = (...a) => _flat(a, 3).map(v => v >>> 0)

function _bin(a, b, f) {
  const av = isArr(a), bv = isArr(b)
  if (!av && !bv) return _fr(f(a, b))
  if (av && bv) { const o = new Array(a.length); for (let i = 0; i < a.length; i++) o[i] = _fr(f(a[i], b[i])); return o }
  if (av) { const o = new Array(a.length); for (let i = 0; i < a.length; i++) o[i] = _fr(f(a[i], b)); return o }
  const o = new Array(b.length); for (let i = 0; i < b.length; i++) o[i] = _fr(f(a, b[i])); return o
}
export const add = (a, b) => {
  const av = isArr(a), bv = isArr(b)
  if (!av && !bv) return _fr(a + b)
  if (av && bv) { const n = a.length
    if (n === 3) return [_fr(a[0] + b[0]), _fr(a[1] + b[1]), _fr(a[2] + b[2])]
    const o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a[i] + b[i]); return o }
  if (av) { const n = a.length
    if (n === 3) return [_fr(a[0] + b), _fr(a[1] + b), _fr(a[2] + b)]
    const o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a[i] + b); return o }
  const n = b.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a + b[i]); return o
}
export const sub = (a, b) => {
  const av = isArr(a), bv = isArr(b)
  if (!av && !bv) return _fr(a - b)
  if (av && bv) { const n = a.length
    if (n === 3) return [_fr(a[0] - b[0]), _fr(a[1] - b[1]), _fr(a[2] - b[2])]
    const o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a[i] - b[i]); return o }
  if (av) { const n = a.length
    if (n === 3) return [_fr(a[0] - b), _fr(a[1] - b), _fr(a[2] - b)]
    const o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a[i] - b); return o }
  const n = b.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a - b[i]); return o
}
export const mul = (a, b) => {
  const av = isArr(a), bv = isArr(b)
  if (!av && !bv) return _fr(a * b)
  if (av && bv) { const n = a.length
    if (n === 3) return [_fr(a[0] * b[0]), _fr(a[1] * b[1]), _fr(a[2] * b[2])]
    const o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a[i] * b[i]); return o }
  if (av) { const n = a.length
    if (n === 3) return [_fr(a[0] * b), _fr(a[1] * b), _fr(a[2] * b)]
    const o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a[i] * b); return o }
  const n = b.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a * b[i]); return o
}
export const div = (a, b) => {
  const av = isArr(a), bv = isArr(b)
  if (!av && !bv) return _fr(a / b)
  if (av && bv) { const n = a.length
    if (n === 3) return [_fr(a[0] / b[0]), _fr(a[1] / b[1]), _fr(a[2] / b[2])]
    const o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a[i] / b[i]); return o }
  if (av) { const n = a.length
    if (n === 3) return [_fr(a[0] / b), _fr(a[1] / b), _fr(a[2] / b)]
    const o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a[i] / b); return o }
  const n = b.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a / b[i]); return o
}
export const neg = (a) => isArr(a) ? a.map(x => -x) : -a

const _u = (a, f) => { if (!isArr(a)) return _fr(f(a)); const n = a.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(f(a[i])); return o }
export const floor = (a) => {
  if (!isArr(a)) return _fr(Math.floor(a))
  const n = a.length
  if (n === 3) return [_fr(Math.floor(a[0])), _fr(Math.floor(a[1])), _fr(Math.floor(a[2]))]
  const o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(Math.floor(a[i])); return o
}
export const ceil = (a) => _u(a, Math.ceil)
export const absf = (a) => {
  if (!isArr(a)) return _fr(Math.abs(a))
  const n = a.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(Math.abs(a[i])); return o
}
export { absf as abs }
export const fract = (a) => {
  if (!isArr(a)) return _fr(a - Math.floor(a))
  const n = a.length
  if (n === 3) return [_fr(a[0] - Math.floor(a[0])), _fr(a[1] - Math.floor(a[1])), _fr(a[2] - Math.floor(a[2]))]
  const o = new Array(n); for (let i = 0; i < n; i++) { const x = a[i]; o[i] = _fr(x - Math.floor(x)) } return o
}
export const sign = (a) => _u(a, Math.sign)
export const sqrt = (a) => _u(a, Math.sqrt)
export const sinf = (a) => _u(a, Math.sin); export { sinf as sin }
export const cosf = (a) => _u(a, Math.cos); export { cosf as cos }
export const tanf = (a) => _u(a, Math.tan); export { tanf as tan }
export const expf = (a) => _u(a, Math.exp); export { expf as exp }
export const tanh = (a) => _u(a, Math.tanh)
export const powf = (a, b) => _bin(a, b, (x, y) => Math.pow(x, y)); export { powf as pow }
export const minf = (a, b) => _bin(a, b, (x, y) => Math.min(x, y)); export { minf as min }
export const maxf = (a, b) => _bin(a, b, (x, y) => Math.max(x, y)); export { maxf as max }
export const modf = (a, b) => _bin(a, b, (x, y) => x - y * Math.floor(x / y)); export { modf as mod }
export const clamp = (x, lo, hi) => {
  if (isArr(x)) { const o = new Array(x.length); for (let i = 0; i < x.length; i++) { const l = isArr(lo) ? lo[i] : lo, h = isArr(hi) ? hi[i] : hi; o[i] = Math.min(Math.max(x[i], l), h) } return o }
  return Math.min(Math.max(x, isArr(lo) ? lo[0] : lo), isArr(hi) ? hi[0] : hi)
}
export const mix = (a, b, t) => {
  if (!isArr(a) && !isArr(b) && !isArr(t)) return _fr(a + _fr(_fr(b - a) * t))
  return add(a, mul(sub(b, a), t))
}
export function smoothstep(e0, e1, x) {
  const f = (a, b, v) => { let t = (v - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t) }
  if (isArr(x)) { const o = new Array(x.length); for (let i = 0; i < x.length; i++) o[i] = f(isArr(e0) ? e0[i] : e0, isArr(e1) ? e1[i] : e1, x[i]); return o }
  return f(isArr(e0) ? e0[0] : e0, isArr(e1) ? e1[0] : e1, x)
}
export const step = (edge, x) => _bin(edge, x, (e, v) => v < e ? 0 : 1)

export const dot = (a, b) => {
  let s = 0
  if (a.length === 3) { s += a[0] * b[0]; s += a[1] * b[1]; s += a[2] * b[2]; return s }
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
export const length = (a) => isArr(a) ? Math.sqrt(dot(a, a)) : Math.abs(a)
export const distance = (a, b) => length(sub(a, b))
export const normalize = (a) => {
  const l = length(a) || 1
  if (!isArr(a)) return a / l
  const n = a.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = a[i] / l; return o
}
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

const _SI = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3, s: 0, t: 1, p: 2, q: 3 }
export function sw(v, sel) {
  if (sel.length === 1) {
    switch (sel) {
      case 'x': case 'r': case 's': return v[0]
      case 'y': case 'g': case 't': return v[1]
      case 'z': case 'b': case 'p': return v[2]
      default: return v[3]
    }
  }
  const o = new Array(sel.length); for (let i = 0; i < sel.length; i++) o[i] = v[_SI[sel[i]]]; return o
}

export const mat3 = (...a) => a.slice(0, 9)
export const mat3mul = (m, v) => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
]

export const float = (x) => +x
export const int = (x) => Math.trunc(x)

export const u = (x) => x >>> 0
export const umul = (a, b) => Math.imul(a >>> 0, b >>> 0) >>> 0
export const uadd = (a, b) => ((a >>> 0) + (b >>> 0)) >>> 0
export const uxor = (a, b) => ((a >>> 0) ^ (b >>> 0)) >>> 0
export const ushr = (a, n) => (a >>> 0) >>> n
export const ushl = (a, n) => ((a >>> 0) << n) >>> 0
