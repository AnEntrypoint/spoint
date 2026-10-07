import { defineHeightSpec, OCTAVE_ROTATION_COS, OCTAVE_ROTATION_SIN } from './height-spec.js'

const isVec = Array.isArray
const INLINE_MAX_BODY_STMTS = 32
const isPlainOperand = (v) => /^-?[A-Za-z_$][\w$]*$/.test(v) || /^-?[\d.]+$/.test(v)

function literal(n) {
  if (!Number.isFinite(n)) throw new RangeError(`jsgen: non-finite literal ${n}`)
  const s = Object.is(n, -0) ? '-0' : String(n)
  return n < 0 || Object.is(n, -0) ? `(${s})` : s
}

function createCodegen(params) {
  let tempId = 0
  let block = []
  const functions = new Map()
  const generating = new Set()
  let probeNested = null
  const scalar = (v) => (typeof v === 'number' ? literal(v) : v)
  const bind = (expr) => { const name = `t${tempId++}`; block.push(`const ${name}=${expr};`); return name }
  const lanes = (a, b) => (isVec(a) ? a.length : isVec(b) ? b.length : 0)
  const lane = (v, i) => (isVec(v) ? v[i] : scalar(v))
  const map1 = (f) => (a) => (isVec(a) ? a.map((x) => bind(f(x))) : bind(f(scalar(a))))
  const map2 = (f) => (a, b) => {
    const n = lanes(a, b)
    if (n === 0) return bind(f(scalar(a), scalar(b)))
    return Array.from({ length: n }, (_, i) => bind(f(lane(a, i), lane(b, i))))
  }
  const map3 = (f) => (a, b, c) => {
    const n = Math.max(lanes(a, b), isVec(c) ? c.length : 0)
    if (n === 0) return bind(f(scalar(a), scalar(b), scalar(c)))
    return Array.from({ length: n }, (_, i) => bind(f(lane(a, i), lane(b, i), lane(c, i))))
  }
  const add = map2((a, b) => `${a}+${b}`), sub = map2((a, b) => `${a}-${b}`), mul = map2((a, b) => `${a}*${b}`)
  const dot = (a, b) => { let s = bind(`${a[0]}*${b[0]}`); for (let i = 1; i < a.length; i++) s = bind(`${s}+${bind(`${a[i]}*${b[i]}`)}`); return s }
  const withBlock = (emit) => { const saved = block; block = []; const result = emit(); const body = block; block = saved; return { result, body } }

  const ops = {
    v3: (x, y, z) => [scalar(x), scalar(y), scalar(z)],
    x: (v) => v[0], y: (v) => v[1], z: (v) => v[2],
    swz: (v, s) => [...s].map((c) => v['xyzw'.indexOf(c)]),
    add, sub, mul, div: map2((a, b) => `${a}/${b}`), neg: map1((a) => `-${a}`),
    floor: map1((a) => `Math.floor(${a})`), fract: map1((a) => `${a}-Math.floor(${a})`), abs: map1((a) => `Math.abs(${a})`),
    pow: map2((a, b) => `Math.pow(${a},${b})`), max: map2((a, b) => `Math.max(${a},${b})`), min: map2((a, b) => `Math.min(${a},${b})`),
    clamp: map3((x, lo, hi) => `Math.min(Math.max(${x},${lo}),${hi})`),
    mix: (a, b, t) => add(a, mul(sub(b, a), t)),
    dot,
    normalize: (a) => { const l = bind(`Math.sqrt(${dot(a, a)})||1`); return a.map((x) => bind(`${x}/${l}`)) },
    sin: map1((a) => `Math.sin(${a})`), cos: map1((a) => `Math.cos(${a})`),
    gt: (a, b) => bind(`${scalar(a)}>${scalar(b)}`), lt: (a, b) => bind(`${scalar(a)}<${scalar(b)}`), ge: (a, b) => bind(`${scalar(a)}>=${scalar(b)}`),
    and: (a, b) => bind(`${a}&&${b}`), not: (a) => bind(`!${a}`),
    sel: (c, a, b) => (isVec(a) || isVec(b) ? Array.from({ length: lanes(a, b) }, (_, i) => bind(`${c}?${lane(a, i)}:${lane(b, i)}`)) : bind(`${c}?${scalar(a)}:${scalar(b)}`)),
    let: (x) => x,
    u32: (x) => bind(`(${scalar(x)}|0)>>>0`),
    umul: (a, b) => bind(`Math.imul(${scalar(a)},${scalar(b)})>>>0`),
    uxor: (a, b) => bind(`(${scalar(a)}^${scalar(b)})>>>0`),
    ushr: (a, n) => bind(`${scalar(a)}>>>${n}`),
    ufloat: (a) => a,
    octaveRotation: (i) => [bind(`ROT_COS[${i}]`), bind(`ROT_SIN[${i}]`)],
    carve: (i) => [[bind(`CARVE[${i}].dir[0]`), bind(`CARVE[${i}].dir[1]`), bind(`CARVE[${i}].dir[2]`)], bind(`CARVE[${i}].innerChord2`), bind(`CARVE[${i}].outerChord2`), bind(`CARVE[${i}].targetH`)],
    param: (name) => { const v = params[name]; if (typeof v !== 'number') throw new TypeError(`jsgen: param ${name} must be a number, got ${v}`); return literal(v) },
    hpfTexel: (face, x, y) => {
      const buf = bind(`HPF(${scalar(face)})`), o = bind(`(${scalar(y)}*HPF_RES+${scalar(x)})*4`)
      return [0, 1, 2, 3].map((c) => bind(`${buf}[${o}+${c}]`))
    },
    fold: (count, init, body) => {
      const idx = `i${tempId++}`
      const state = init.map((v) => (isVec(v) ? v.map((c) => { const n = `s${tempId++}`; block.push(`let ${n}=${c};`); return n }) : (() => { const n = `s${tempId++}`; block.push(`let ${n}=${scalar(v)};`); return n })()))
      const { result: next, body: loopBody } = withBlock(() => body(idx, state))
      const assigns = []
      next.forEach((v, k) => { if (isVec(v)) v.forEach((c, j) => assigns.push(`${state[k][j]}=${c};`)); else assigns.push(`${state[k]}=${scalar(v)};`) })
      block.push(`for(let ${idx}=0;${idx}<${count};${idx}++){${loopBody.join('')}${assigns.join('')}}`)
      return state
    },
    fn: (name, inputs, type, impl) => {
      if (type !== 'float' || inputs.length !== 1 || inputs[0][1] !== 'vec3') throw new TypeError(`jsgen: fn ${name} must be (vec3) -> float`)
      if (probeNested) probeNested.push(name)
      const args = ['a', 'b', 'c'].map((s) => `${name}_${s}`)
      if (generating.has(name)) return (p) => bind(`${name}(${p.map(scalar).join(',')})`)
      generating.add(name)
      const outerNested = probeNested
      const nested = []
      probeNested = nested
      const { result: probeResult, body: probeBody } = withBlock(() => impl(args))
      probeNested = outerNested
      generating.delete(name)
      const leafBody = nested.length === 0 && probeBody.length <= INLINE_MAX_BODY_STMTS
      return (p) => {
        if (!leafBody) {
          if (!functions.has(name)) functions.set(name, `function ${name}(${args.join(',')}){${probeBody.join('')}return ${scalar(probeResult)};}`)
          return bind(`${name}(${p.map(scalar).join(',')})`)
        }
        const callArgs = p.map((v) => (isPlainOperand(v) ? v : bind(scalar(v))))
        const { result, body } = withBlock(() => impl(callArgs))
        for (let i = 0; i < body.length; i++) block.push(body[i])
        return isPlainOperand(result) ? result : bind(scalar(result))
      }
    },
  }
  function build(emit) {
    const { result, body } = withBlock(() => emit(['dx', 'dy', 'dz']))
    return { functions: [...functions.values()].join('\n'), body: `${body.join('')}return ${scalar(result)};` }
  }
  return { ops, build }
}

export function compileSnoise3({ hashVersion }) {
  const { ops, build } = createCodegen({})
  const spec = defineHeightSpec(ops, { hashVersion })
  const { functions, body } = build((dir) => spec.snoise3(dir))
  return new Function('ROT_COS', 'ROT_SIN', 'CARVE', 'HPF', 'HPF_RES', `${functions}\nreturn function snoise3(dx,dy,dz){${body}}`)(OCTAVE_ROTATION_COS, OCTAVE_ROTATION_SIN, [], null, 0)
}

export function compileHeightSpec({ hashVersion, carves = [], params, hpfFace, hpfRes }) {
  const { ops, build } = createCodegen(params)
  const spec = defineHeightSpec(ops, { hashVersion, carveCount: carves.length })
  if (spec.sculptHonoured) throw new TypeError('compileHeightSpec: this spec carries a sculpt term, which is a texture fetch the CPU mirror cannot evaluate -- a CPU height from it would silently disagree with the rendered ground whenever a sculpt override is active')
  const { functions, body } = build((dir) => spec.composeHeight(dir))
  const source = `${functions}\nreturn function composeHeight(dx,dy,dz){${body}}`
  const factory = new Function('ROT_COS', 'ROT_SIN', 'CARVE', 'HPF', 'HPF_RES', source)
  return { composeHeight: factory(OCTAVE_ROTATION_COS, OCTAVE_ROTATION_SIN, carves, hpfFace, hpfRes), source }
}
