import { makeHeight } from './height-gen.js'
import { createAnchorField } from './anchor-field.js'
import * as g from './glsl-rt.js'
import { SHAPE_UNIFORM_DEFAULTS } from './terrain-defaults.js'
import { assertHashVersion, carveChord2, HASH_VERSION_FLOAT } from './tsl/height-spec.js'
import { compileHeightSpec } from './tsl/ops-jsgen.js'

export const HEIGHT_UNIFORM_DEFAULTS = {
  hasHpf: 1,
  ...SHAPE_UNIFORM_DEFAULTS,
  uVsCheap: 0.0,
  uOctMax: 12, uInciseRidgeOcts: 4, uBroadLowOcts: 2, uPeakOcts: 3,
  uNoUnroll: 64,
  uDetailFbmOcts: 3,
}

export function createHeightSampler(opts = {}) {
  if (opts.sculpt) throw new TypeError('createHeightSampler: the CPU height mirror cannot evaluate a sculpt override (it is a GPU texture fetch), so a sampler built with one would silently disagree with the rendered ground -- plumb the sculpt field through the spec instead of passing it here')
  const radius = opts.radius || 6360
  const reliefScale = opts.reliefScale != null ? opts.reliefScale : radius / 63600000
  const hpfTexRes = opts.hpfTexRes || 128
  const BAKE_MAX_LEVEL = Math.round(Math.log2(hpfTexRes))
  const af = opts.anchorField || createAnchorField({ seed: opts.seed })
  const U = { ...HEIGHT_UNIFORM_DEFAULTS, defRadius: radius, ...(opts.uniforms || {}) }

  const RES = hpfTexRes
  const _faceBuf = new Array(6).fill(null)
  function _bakeFace(face) {
    const buf = new Float32Array(RES * RES * 4)
    for (let y = 0; y < RES; y++) {
      const fv = y / (RES - 1)
      for (let x = 0; x < RES; x++) {
        const fu = x / (RES - 1)
        const s = af.sampleUV(face, fu, fv, BAKE_MAX_LEVEL)
        const o = (y * RES + x) * 4
        buf[o] = s.seaBias; buf[o + 1] = s.elevAmp; buf[o + 2] = s.temp; buf[o + 3] = s.humidity
      }
    }
    _faceBuf[face] = buf
    return buf
  }
  const _quintic = (t) => t * t * t * (t * (t * 6 - 15) + 10)
  const hpfSample = (dir) => {
    const d = g.normalize(dir)
    const { face, fu, fv } = af.dirToFaceUV(d)
    const buf = _faceBuf[face] || _bakeFace(face)
    const denom = RES - 1
    const tx = fu * denom, ty = fv * denom
    let x0 = Math.floor(tx), y0 = Math.floor(ty)
    const wx = _quintic(tx - x0), wy = _quintic(ty - y0)
    if (x0 < 0) x0 = 0; else if (x0 > denom) x0 = denom
    if (y0 < 0) y0 = 0; else if (y0 > denom) y0 = denom
    const x1 = x0 < denom ? x0 + 1 : denom, y1 = y0 < denom ? y0 + 1 : denom
    const out = [0, 0, 0, 0]
    for (let c = 0; c < 4; c++) {
      const o00 = ((y0 * RES + x0) * 4) + c, o10 = ((y0 * RES + x1) * 4) + c
      const o01 = ((y1 * RES + x0) * 4) + c, o11 = ((y1 * RES + x1) * 4) + c
      const a = buf[o00] + wx * (buf[o10] - buf[o00])
      const b = buf[o01] + wx * (buf[o11] - buf[o01])
      out[c] = a + wy * (b - a)
    }
    return out
  }
  const hashVersion = assertHashVersion(opts.hashVersion ?? HASH_VERSION_FLOAT)
  const H = makeHeight(U, hpfSample)
  const hpfFace = (face) => _faceBuf[face] || _bakeFace(face)
  const specParams = { hpfRes: RES, landBias: U.uLandBias, beachShelfM: U.uBeachShelfM, reliefScale: 0 }
  const compile = (carves) => compileHeightSpec({ hashVersion, carves, params: specParams, hpfFace, hpfRes: RES }).composeHeight
  const requestedCarves = opts.carves || []
  if (requestedCarves.length && hashVersion === HASH_VERSION_FLOAT) throw new RangeError('createHeightSampler: terrain carves need hashVersion 2 (the legacy GLSL terrain has no carve term)')
  const naturalHeight = hashVersion === HASH_VERSION_FLOAT ? null : compile([])
  const carves = requestedCarves.map((c) => resolveCarve(c, radius, naturalHeight))
  const composeSpecHeight = naturalHeight && (carves.length ? compile(carves) : naturalHeight)

  function heightAt(dir) {
    const d = g.normalize(dir)
    return (composeSpecHeight ? composeSpecHeight(d[0], d[1], d[2]) : H.composeHeight(d, [0, 0], 100)) * reliefScale
  }
  function surfacePoint(dir) { const d = g.normalize(dir); return g.mul(d, radius + heightAt(d)) }

  return { heightAt, surfacePoint, radius, anchorField: af, uniforms: U, hashVersion, carves, _fns: H }
}

function resolveCarve(c, radius, naturalHeight) {
  const l = Math.hypot(c.dir[0], c.dir[1], c.dir[2])
  if (!(l > 0) || !(c.innerM >= 0) || !(c.outerM > c.innerM)) throw new RangeError(`terrain carve needs a non-zero dir and 0 <= innerM < outerM, got ${JSON.stringify(c)}`)
  const dir = [c.dir[0] / l, c.dir[1] / l, c.dir[2] / l]
  return { dir, innerChord2: carveChord2(c.innerM, radius), outerChord2: carveChord2(c.outerM, radius), targetH: naturalHeight(dir[0], dir[1], dir[2]) }
}
