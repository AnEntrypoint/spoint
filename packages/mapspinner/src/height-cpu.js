import { makeHeight } from './height-gen.js'
import { createAnchorField } from './anchor-field.js'
import * as g from './glsl-rt.js'
import { RELIEF_DESIGN_RADIUS_M, SHAPE_UNIFORM_DEFAULTS } from './terrain-defaults.js'
import { assertHashVersion, carveChord2, HASH_VERSION_FLOAT } from './tsl/height-spec.js'
import { compileHeightSpec } from './tsl/ops-jsgen.js'
import { hpfFaceSampler } from './hpf-lattice.js'

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
  const reliefScale = opts.reliefScale != null ? opts.reliefScale : radius / RELIEF_DESIGN_RADIUS_M
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
  const _faceSamp = new Array(6).fill(null)
  const _faceSampler = (face) => _faceSamp[face] || (_faceSamp[face] = hpfFaceSampler(_faceBuf[face] || _bakeFace(face), RES))
  const hpfSample = (dir) => {
    const d = g.normalize(dir)
    const { face, fu, fv } = af.dirToFaceUV(d)
    return _faceSampler(face)(fu, fv, [0, 0, 0, 0])
  }
  const hashVersion = assertHashVersion(opts.hashVersion ?? HASH_VERSION_FLOAT)
  const H = makeHeight(U, hpfSample)
  const hpfFace = (face) => _faceBuf[face] || _bakeFace(face)
  const specParams = { hpfRes: RES, landBias: U.uLandBias, beachShelfM: U.uBeachShelfM, reliefScale: 0 }
  // The v1 float hash is only reproducible at the precision the GPU runs it in: its lattice
  // coordinates are integers (so both precisions hold them exactly) but fract(p*0.1031) does not,
  // and the domain warp turns that difference into metres of ground. The v2 integer hash is bit
  // exact in either precision, so it keeps the exact f64 path the shipped bakes were computed on.
  const precision = opts.precision ?? (hashVersion === HASH_VERSION_FLOAT ? 'f32' : 'f64')
  const compile = (carves) => compileHeightSpec({ hashVersion, carves, precision, params: specParams, hpfFace, hpfRes: RES }).composeHeight
  const requestedCarves = opts.carves || []
  if (requestedCarves.length && hashVersion === HASH_VERSION_FLOAT) throw new RangeError('createHeightSampler: terrain carves need hashVersion 2 (the legacy GLSL terrain has no carve term)')
  const naturalHeight = compile([])
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
