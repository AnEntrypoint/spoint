import * as g from '../glsl-rt.js'

const isArr = Array.isArray
const identity = (x) => x

function roundedVectorOps(r) {
  const map1 = (f) => (a) => (isArr(a) ? a.map((x) => r(f(x))) : r(f(a)))
  const map2 = (f) => (a, b) => {
    if (!isArr(a) && !isArr(b)) return r(f(a, b))
    const n = isArr(a) ? a.length : b.length
    const o = new Array(n)
    for (let i = 0; i < n; i++) o[i] = r(f(isArr(a) ? a[i] : a, isArr(b) ? b[i] : b))
    return o
  }
  const map3 = (f) => (a, b, c) => {
    if (!isArr(a) && !isArr(b) && !isArr(c)) return r(f(a, b, c))
    const n = [a, b, c].find(isArr).length
    const o = new Array(n)
    for (let i = 0; i < n; i++) o[i] = r(f(isArr(a) ? a[i] : a, isArr(b) ? b[i] : b, isArr(c) ? c[i] : c))
    return o
  }
  const add = map2((a, b) => a + b), sub = map2((a, b) => a - b), mul = map2((a, b) => a * b)
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s = r(s + r(a[i] * b[i])); return s }
  return {
    add, sub, mul, div: map2((a, b) => a / b), neg: map1((a) => -a),
    floor: map1(Math.floor), fract: map1((a) => a - Math.floor(a)), abs: map1(Math.abs),
    pow: map2(Math.pow), max: map2(Math.max), min: map2(Math.min),
    clamp: map3((x, lo, hi) => Math.min(Math.max(x, lo), hi)),
    mix: (a, b, t) => add(a, mul(sub(b, a), t)),
    dot,
    normalize: (a) => { const l = r(Math.sqrt(dot(a, a))) || 1; return a.map((x) => r(x / l)) },
    sin: map1(Math.sin), cos: map1(Math.cos),
  }
}

const GLSL_RT_OPS = {
  add: g.add, sub: g.sub, mul: g.mul, div: g.div, neg: g.neg,
  floor: g.floor, fract: g.fract, abs: g.abs, pow: g.pow, max: g.max, min: g.min,
  clamp: g.clamp, mix: g.mix, dot: g.dot, normalize: g.normalize, sin: g.sin, cos: g.cos,
}

export const JS_PRECISIONS = {
  'glsl-rt': GLSL_RT_OPS,
  f64: roundedVectorOps(identity),
  f32: roundedVectorOps(Math.fround),
}

export function createJsOps(params, hpfTexel, { precision = 'glsl-rt' } = {}) {
  const arith = JS_PRECISIONS[precision]
  if (!arith) throw new RangeError(`createJsOps: precision must be one of ${Object.keys(JS_PRECISIONS).join(', ')}, got ${precision}`)
  return {
    ...arith,
    v3: (x, y, z) => [x, y, z],
    x: (v) => v[0], y: (v) => v[1], z: (v) => v[2],
    swz: g.sw,
    gt: (a, b) => a > b, lt: (a, b) => a < b, ge: (a, b) => a >= b,
    and: (a, b) => a && b, not: (a) => !a,
    sel: (c, a, b) => (c ? a : b),
    let: (x) => x,
    u32: (x) => (x | 0) >>> 0,
    umul: (a, b) => Math.imul(a, b) >>> 0,
    uxor: (a, b) => (a ^ b) >>> 0,
    ushr: (a, n) => a >>> n,
    ufloat: (a) => a,
    fold: (count, init, body) => {
      let s = init
      for (let i = 0; i < count; i++) s = body(i, s)
      return s
    },
    fn: (name, inputs, type, impl) => impl,
    param: (name) => params[name],
    hpfTexel: (face, x, y) => hpfTexel(face, x, y),
  }
}

export function createHpfTexelReader(hpfData, hpfRes) {
  return (face, x, y) => {
    const o = ((face * hpfRes + y) * hpfRes + x) * 4
    return [hpfData[o], hpfData[o + 1], hpfData[o + 2], hpfData[o + 3]]
  }
}

export function bakeHpfTexels(anchorField, hpfRes) {
  const bakeMaxLevel = Math.round(Math.log2(hpfRes))
  const out = new Float32Array(6 * hpfRes * hpfRes * 4)
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < hpfRes; y++) {
      const fv = y / (hpfRes - 1)
      for (let x = 0; x < hpfRes; x++) {
        const s = anchorField.sampleUV(face, x / (hpfRes - 1), fv, bakeMaxLevel)
        const o = ((face * hpfRes + y) * hpfRes + x) * 4
        out[o] = s.seaBias; out[o + 1] = s.elevAmp; out[o + 2] = s.temp; out[o + 3] = s.humidity
      }
    }
  }
  return out
}
