import {
  Fn, Loop, float, int, uint, ivec2, vec3, select, textureLoad,
  floor, fract, abs, pow, max, min, clamp, mix, dot, normalize, sin, cos,
} from 'three/tsl'

const node = (x) => (typeof x === 'number' ? float(x) : x)

export function createTslOps({ params, hpfTexture, loopBoundDelta }) {
  return {
    v3: (x, y, z) => vec3(node(x), node(y), node(z)),
    x: (v) => v.x, y: (v) => v.y, z: (v) => v.z,
    swz: (v, s) => v[s],
    add: (a, b) => node(a).add(b),
    sub: (a, b) => node(a).sub(b),
    mul: (a, b) => node(a).mul(b),
    div: (a, b) => node(a).div(b),
    neg: (a) => node(a).negate(),
    floor, fract, abs,
    pow: (a, b) => pow(node(a), node(b)),
    max: (a, b) => max(node(a), node(b)),
    min: (a, b) => min(node(a), node(b)),
    clamp: (x, lo, hi) => clamp(node(x), node(lo), node(hi)),
    mix: (a, b, t) => mix(node(a), node(b), node(t)),
    dot, normalize, sin, cos,
    gt: (a, b) => node(a).greaterThan(b),
    lt: (a, b) => node(a).lessThan(b),
    ge: (a, b) => node(a).greaterThanEqual(b),
    and: (a, b) => a.and(b),
    not: (a) => a.not(),
    sel: (c, a, b) => select(c, node(a), node(b)),
    let: (x) => node(x).toVar(),
    u32: (x) => uint(int(x)),
    umul: (a, b) => a.mul(typeof b === 'number' ? uint(b) : b),
    uxor: (a, b) => a.bitXor(b),
    ushr: (a, n) => a.shiftRight(uint(n)),
    ufloat: (a) => float(a),
    fold: (count, init, body) => {
      const state = init.map((v) => node(v).toVar())
      Loop({ start: int(0), end: int(count).add(loopBoundDelta), type: 'int', condition: '<' }, ({ i }) => {
        const next = body(float(i), state).map((v) => node(v).toVar())
        for (let k = 0; k < state.length; k++) state[k].assign(next[k])
      })
      return state
    },
    fn: (name, inputs, type, impl) => {
      const f = Fn((args) => impl(...args)).setLayout({ name, type, inputs: inputs.map(([n, t]) => ({ name: n, type: t })) })
      return (...a) => f(...a)
    },
    param: (name) => params[name],
    hpfTexel: (face, x, y) => textureLoad(hpfTexture, ivec2(int(x), int(node(face).mul(params.hpfRes).add(y))), int(0)),
  }
}
