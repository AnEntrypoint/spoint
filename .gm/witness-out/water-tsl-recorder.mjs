export const state = { ifSeq: 0, regions: [], counts: new Map(), order: [], composeHeight: 0 }

const regionOf = () => (state.regions.length ? state.regions.join('/') : 'root')

function rec(name) {
  const k = regionOf() + '|' + name
  state.counts.set(k, (state.counts.get(k) || 0) + 1)
  state.order.push(k)
}

const SWIZZLES = ['x', 'y', 'z', 'w', 'xy', 'xz', 'yz', 'zw', 'xyz', 'rgb', 'rgba', 'xyzw']
const METHODS = [
  'add', 'sub', 'mul', 'div', 'mod', 'negate', 'oneMinus', 'toVar',
  'greaterThan', 'lessThan', 'greaterThanEqual', 'lessThanEqual', 'equal', 'notEqual',
  'and', 'or', 'bitXor', 'bitAnd', 'dot', 'cross', 'normalize', 'length', 'abs',
  'max', 'min', 'clamp', 'mix', 'smoothstep', 'step', 'pow', 'exp', 'log', 'exp2',
  'sqrt', 'inverseSqrt', 'sin', 'cos', 'tan', 'atan', 'asin', 'acos', 'floor', 'ceil',
  'round', 'fract', 'sign', 'reflect', 'refract', 'select', 'toVec2', 'toVec3', 'toVec4',
  'onRenderUpdate', 'onFrameUpdate', 'onReference', 'toReadOnly', 'toStack', 'setName', 'label',
]

function node(tag, value) {
  const n = { __tag: tag, __v: value }
  for (const m of METHODS) {
    n[m] = function (...args) {
      rec(m)
      const a = args[0]
      let v
      if ((m === 'add' || m === 'sub' || m === 'mul') && n.__v !== undefined && a && a.__v !== undefined) {
        v = m === 'add' ? n.__v + a.__v : m === 'sub' ? n.__v - a.__v : n.__v * a.__v
      }
      return node(m, v)
    }
  }
  n.assign = function () { rec('assign'); return n }
  n.addAssign = function () { rec('addAssign'); return n }
  n.subAssign = function () { rec('subAssign'); return n }
  n.mulAssign = function () { rec('mulAssign'); return n }
  n.divAssign = function () { rec('divAssign'); return n }
  n.element = function () { rec('element'); return node('element') }
  for (const s of SWIZZLES) {
    Object.defineProperty(n, s, { get() { rec('swizzle:' + s); return node('swizzle') }, enumerable: true })
  }
  return n
}

export const __node = (tag) => node(tag)

export const float = (v) => node('float', typeof v === 'number' ? v : undefined)
export const int = (v) => node('int', typeof v === 'number' ? v : undefined)
export const uint = (v) => node('uint', typeof v === 'number' ? v : undefined)
export const bool = (v) => node('bool', typeof v === 'boolean' ? v : undefined)
export const vec2 = () => node('vec2')
export const vec3 = () => node('vec3')
export const vec4 = () => node('vec4')
export const ivec2 = () => node('ivec2')
export const uvec2 = () => node('uvec2')
export const mat2 = () => node('mat2')
export const mat3 = () => node('mat3')
export const mat4 = () => node('mat4')
export const uniform = (v) => { const n = node('uniform'); n.value = v; return n }
export const attribute = () => node('attribute')
export const varyingProperty = () => node('varying')
export const property = () => node('property')
export const screenUV = node('screenUV')
export const screenCoordinate = node('screenCoordinate')
export const instanceIndex = node('instanceIndex')
export const viewportSharedTexture = () => { rec('viewportSharedTexture'); return node('viewportSharedTexture') }
export const Discard = () => { rec('Discard'); return node('discard') }

export function Fn(body) {
  const f = function (...args) {
    rec('call:' + (f.__layoutName || 'anon'))
    return body(args)
  }
  f.setLayout = function (l) { f.__layoutName = l && l.name; return f }
  return f
}

export function If(cond, fn) {
  rec('If')
  const id = 'if' + (++state.ifSeq)
  state.regions.push(id + ':then')
  fn()
  state.regions.pop()
  const api = {
    ElseIf(c, f2) { state.regions.push(id + ':elseif'); f2(); state.regions.pop(); return api },
    Else(f2) { state.regions.push(id + ':else'); f2(); state.regions.pop(); return api },
  }
  return api
}

export function Loop(opts, body) {
  rec('Loop')
  const s = opts && opts.start ? opts.start.__v : undefined
  const e = opts && opts.end ? opts.end.__v : undefined
  const iters = Number.isFinite(s) && Number.isFinite(e) ? Math.max(0, e - s) : 1
  const depth = state.regions.length + 1
  for (let i = 0; i < iters; i++) {
    state.regions.push('loop' + depth)
    body({ i: node('i', Number.isFinite(s) ? s + i : undefined) })
    state.regions.pop()
  }
}

export const select = () => { rec('select'); return node('select') }
export const mix = () => { rec('mix'); return node('mix') }
export const smoothstep = () => { rec('smoothstep'); return node('smoothstep') }
export const clamp = () => { rec('clamp'); return node('clamp') }
export const step = () => { rec('step'); return node('step') }
export const pow = () => { rec('pow'); return node('pow') }
export const exp = () => { rec('exp'); return node('exp') }
export const log = () => { rec('log'); return node('log') }
export const sqrt = () => { rec('sqrt'); return node('sqrt') }
export const sin = () => { rec('sin'); return node('sin') }
export const cos = () => { rec('cos'); return node('cos') }
export const tan = () => { rec('tan'); return node('tan') }
export const atan = () => { rec('atan'); return node('atan') }
export const abs = () => { rec('abs'); return node('abs') }
export const max = () => { rec('max'); return node('max') }
export const min = () => { rec('min'); return node('min') }
export const normalize = () => { rec('normalize'); return node('normalize') }
export const cross = () => { rec('cross'); return node('cross') }
export const dot = () => { rec('dot'); return node('dot') }
export const length = () => { rec('length'); return node('length') }
export const reflect = () => { rec('reflect'); return node('reflect') }
export const floor = () => { rec('floor'); return node('floor') }
export const fract = () => { rec('fract'); return node('fract') }
export const negate = () => { rec('negate'); return node('negate') }
export const oneMinus = () => { rec('oneMinus'); return node('oneMinus') }
export const acesFilmicToneMapping = () => { rec('acesFilmicToneMapping'); return node('acesFilmicToneMapping') }
export const reinhardToneMapping = () => { rec('reinhardToneMapping'); return node('reinhardToneMapping') }
export const linearToneMapping = () => { rec('linearToneMapping'); return node('linearToneMapping') }
export const sRGBTransferOETF = () => { rec('sRGBTransferOETF'); return node('sRGBTransferOETF') }
export const luminance = () => { rec('luminance'); return node('luminance') }

export class Vector2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y }
  set(x, y) { this.x = x; this.y = y; return this }
  copy(v) { this.x = v.x; this.y = v.y; return this }
  normalize() { return this }
  clone() { return new Vector2(this.x, this.y) }
}
export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this }
  normalize() { return this }
  clone() { return new Vector3(this.x, this.y, this.z) }
}
export class Vector4 {
  constructor(x = 0, y = 0, z = 0, w = 0) { this.x = x; this.y = y; this.z = z; this.w = w }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; this.w = v.w; return this }
  clone() { return new Vector4(this.x, this.y, this.z, this.w) }
}
export class Sphere {
  constructor(center, radius) { this.center = center; this.radius = radius }
}
export class BufferAttribute {
  constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.needsUpdate = false }
  clearUpdateRanges() {}
  addUpdateRange() {}
}
export class InstancedBufferAttribute extends BufferAttribute {}
export class InstancedBufferGeometry {
  constructor() { this.attributes = {}; this.instanceCount = 0 }
  setAttribute(name, a) { this.attributes[name] = a; return this }
  setIndex(a) { this.index = a; return this }
  dispose() { this.disposed = true }
}
export class Mesh {
  constructor(geometry, material) { this.geometry = geometry; this.material = material; this.visible = true }
}
export class MeshBasicNodeMaterial {
  constructor() { this.transparent = false; this.depthWrite = true; this.depthTest = true }
  dispose() { this.disposed = true }
}
export const DoubleSide = 2
export const FrontSide = 0
export const BackSide = 1
