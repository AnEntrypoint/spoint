// glsl-rt.js -- a tiny GLSL runtime for JS. The GLSL->JS transpiler (gen-height.mjs)
// emits calls against these helpers so the terrain HEIGHT functions (the single
// source of truth in terrain.glsl) run unchanged in pure JS for headless physics
// sampling. THREE-FREE, no DOM/Node globals -> loads in Node + a Web Worker.
//
// Vectors are plain JS arrays (length 2/3/4); scalars are numbers. GLSL has no
// operator overloading in JS, so the transpiler rewrites `a + b` etc. into add()/
// sub()/mul()/div() (each handles vec-vec componentwise, vec-scalar, scalar-vec,
// scalar-scalar). Swizzles (`.xyz`) become sw(v,'xyz'); a bare `.x/.y/.z/.w`
// becomes v[0..3]. Builtins (floor/fract/mix/smoothstep/...) are componentwise on
// vectors exactly like GLSL. This is intentionally small + dependency-light so it
// is trivially auditable and matches GLSL semantics 1:1.

const isArr = Array.isArray
// FLOAT32 PARITY: the GPU evaluates terrain.glsl in float32 (GLSL highp single); this JS runtime would
// otherwise accumulate the many-octave fractal in float64 (double) and diverge from the rendered surface
// by metres (the CPU physics collider + veg/grass placement float/sink vs the GPU terrain). Rounding every
// scalar op result to float32 (Math.fround) makes the per-statement accumulation track the GPU's single
// precision -- the dominant divergence source is the octave SUM, captured by frounding the _bin/_u op
// results below. (Per-op fround is a close heuristic, not bit-exact across GPU vendors/FMA; measured to
// cut the anchor gap ~2.5m -> ~0.1-0.7m. Frounding the dot/normalize accumulators too OVERSHOT, so they
// are intentionally left in f64 -- the GPU uses wider intermediates there.)
const _fr = Math.fround

// ---- constructors (GLSL flexible args: vec3(x), vec3(x,y,z), vec3(v2,z), vec3(v4))
function _flat(args, n) {
  const out = []
  for (const a of args) { if (isArr(a)) { for (const c of a) out.push(c) } else out.push(a) }
  if (out.length === 1) { while (out.length < n) out.push(out[0]) }      // vecN(scalar) -> splat
  return out.length === n ? out : out.slice(0, n)
}
// vec3 is the hottest constructor (every snoise3 builds many); fast-path the two
// dominant call shapes -- vec3(x,y,z) scalars and vec3(scalar) splat -- and fall
// back to _flat for vec/mixed args. Same result as _flat(a,3).
export const vec3 = (...a) => {
  const l = a.length
  if (l === 3) { const x = a[0], y = a[1], z = a[2]; if (!isArr(x) && !isArr(y) && !isArr(z)) return [x, y, z] }
  else if (l === 1) { const x = a[0]; if (!isArr(x)) return [x, x, x] }
  return _flat(a, 3)
}
export const vec2 = (...a) => _flat(a, 2)
export const vec4 = (...a) => _flat(a, 4)
// integer/uint vec aliases: truncate to int (Math.trunc) for correctness with ivec3(floor(...)) etc.
export const ivec2 = (...a) => _flat(a, 2).map(Math.trunc)
export const ivec3 = (...a) => _flat(a, 3).map(Math.trunc)
export const uvec2 = (...a) => _flat(a, 2).map(v => v >>> 0)
export const uvec3 = (...a) => _flat(a, 3).map(v => v >>> 0)

// ---- componentwise binary arithmetic (vec/vec, vec/scalar, scalar/vec, scalar/scalar)
function _bin(a, b, f) {
  const av = isArr(a), bv = isArr(b)
  if (!av && !bv) return _fr(f(a, b))
  if (av && bv) { const o = new Array(a.length); for (let i = 0; i < a.length; i++) o[i] = _fr(f(a[i], b[i])); return o }
  if (av) { const o = new Array(a.length); for (let i = 0; i < a.length; i++) o[i] = _fr(f(a[i], b)); return o }
  const o = new Array(b.length); for (let i = 0; i < b.length; i++) o[i] = _fr(f(a, b[i])); return o
}
// add/sub/mul/div are the inner-loop arithmetic; inline each (no closure call per
// element) since they dominate the fractal octave loops. Identical result to
// _bin(a,b,op): per-element Math.fround, full vec/vec, vec/scalar, scalar/vec, scalar/scalar.
export const add = (a, b) => {
  const av = isArr(a), bv = isArr(b)
  if (!av && !bv) return _fr(a + b)
  if (av && bv) { const n = a.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a[i] + b[i]); return o }
  if (av) { const n = a.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a[i] + b); return o }
  const n = b.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a + b[i]); return o
}
export const sub = (a, b) => {
  const av = isArr(a), bv = isArr(b)
  if (!av && !bv) return _fr(a - b)
  if (av && bv) { const n = a.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a[i] - b[i]); return o }
  if (av) { const n = a.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a[i] - b); return o }
  const n = b.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a - b[i]); return o
}
export const mul = (a, b) => {
  const av = isArr(a), bv = isArr(b)
  if (!av && !bv) return _fr(a * b)
  if (av && bv) { const n = a.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a[i] * b[i]); return o }
  if (av) { const n = a.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a[i] * b); return o }
  const n = b.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a * b[i]); return o
}
export const div = (a, b) => {
  const av = isArr(a), bv = isArr(b)
  if (!av && !bv) return _fr(a / b)
  if (av && bv) { const n = a.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a[i] / b[i]); return o }
  if (av) { const n = a.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a[i] / b); return o }
  const n = b.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(a / b[i]); return o
}
export const neg = (a) => isArr(a) ? a.map(x => -x) : -a

// ---- componentwise unary / GLSL math (scalar or vec)
const _u = (a, f) => { if (!isArr(a)) return _fr(f(a)); const n = a.length, o = new Array(n); for (let i = 0; i < n; i++) o[i] = _fr(f(a[i])); return o }
export const floor = (a) => _u(a, Math.floor)
export const ceil = (a) => _u(a, Math.ceil)
export const absf = (a) => _u(a, Math.abs)
export { absf as abs }
export const fract = (a) => _u(a, x => x - Math.floor(x))
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
// mix(a,b,t) = a + (b-a)*t, componentwise; a/b/t each scalar or vec (reuses the
// _bin-backed add/sub/mul so every scalar/vec combination is handled correctly).
export const mix = (a, b, t) => add(a, mul(sub(b, a), t))
export function smoothstep(e0, e1, x) {
  const f = (a, b, v) => { let t = (v - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t) }
  if (isArr(x)) { const o = new Array(x.length); for (let i = 0; i < x.length; i++) o[i] = f(isArr(e0) ? e0[i] : e0, isArr(e1) ? e1[i] : e1, x[i]); return o }
  return f(isArr(e0) ? e0[0] : e0, isArr(e1) ? e1[0] : e1, x)
}
export const step = (edge, x) => _bin(edge, x, (e, v) => v < e ? 0 : 1)

// ---- vector ops
export const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
export const length = (a) => isArr(a) ? Math.sqrt(dot(a, a)) : Math.abs(a)
export const distance = (a, b) => length(sub(a, b))
export const normalize = (a) => { const l = length(a) || 1; return isArr(a) ? a.map(x => x / l) : a / l }
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

// ---- swizzle read: sw([x,y,z],'xz') -> [x,z]; sw(v,'x') -> scalar
const _SI = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3, s: 0, t: 1, p: 2, q: 3 }
// single-char swizzle is the hot path (snoise3/h3 read .x/.y/.z thousands of times);
// switch on the char avoids a megamorphic keyed object load. Same mapping as _SI.
const _si1 = (c) => { switch (c) { case 'x': case 'r': case 's': return 0; case 'y': case 'g': case 't': return 1; case 'z': case 'b': case 'p': return 2; default: return 3 } }
export function sw(v, sel) {
  if (sel.length === 1) return v[_si1(sel)]
  const o = new Array(sel.length); for (let i = 0; i < sel.length; i++) o[i] = v[_SI[sel[i]]]; return o
}

// ---- mat3 (column-major, GLSL: mat3(c0x,c0y,c0z, c1x,c1y,c1z, c2x,c2y,c2z)) + mat3*vec3.
export const mat3 = (...a) => a.slice(0, 9)
export const mat3mul = (m, v) => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
]

// ---- scalar casts (GLSL float()/int()): float = identity, int = truncate-toward-zero.
export const float = (x) => +x
export const int = (x) => Math.trunc(x)

// ---- uint helpers (GLSL uint/uvec bit-ops) for vhash (micro-relief lattice hash).
// JS uint32 via >>>0 + Math.imul for wrap-around multiply (matches GLSL uint mul).
export const u = (x) => x >>> 0
export const umul = (a, b) => Math.imul(a >>> 0, b >>> 0) >>> 0
export const uadd = (a, b) => ((a >>> 0) + (b >>> 0)) >>> 0
export const uxor = (a, b) => ((a >>> 0) ^ (b >>> 0)) >>> 0
export const ushr = (a, n) => (a >>> 0) >>> n
export const ushl = (a, n) => ((a >>> 0) << n) >>> 0
