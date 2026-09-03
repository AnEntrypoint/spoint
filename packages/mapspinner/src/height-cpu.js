// height-cpu.js -- pure-JS terrain HEIGHT sampler for headless consumers (e.g. a
// game server building a physics collider). It runs the GLSL composeHeight subset
// transpiled to JS (height-gen.js, generated from terrain.glsl -- the single
// source of truth) over the pure-JS anchor-field (the HPF), so the CPU surface
// matches the GPU-rendered surface. THREE-FREE, no DOM/GL/Node globals.
//
// Parity contract: the uniform DEFAULTS below mirror gl-render.js
// setComposeHeightUniforms / the render uniform set; the HPF is sampled with the
// SAME maxBandLevel the renderer bakes (log2(hpfTexRes)). scripts/gen-height.mjs
// must be re-run after any terrain.glsl height edit; pl-parity-test validates CPU
// == GPU sampleGroundM and fails loudly on drift.

import { makeHeight } from './height-gen.js'
import { createAnchorField } from './anchor-field.js'
import * as g from './glsl-rt.js'
import { SHAPE_UNIFORM_DEFAULTS } from './terrain-defaults.js'

// Renderer uniform defaults -- MUST mirror gl-render.js (setComposeHeightUniforms
// line ~450 + the render set line ~1089). Override per-field via opts.uniforms to
// match a host that dials window.__* levers.
export const HEIGHT_UNIFORM_DEFAULTS = {
  hasHpf: 1,
  // SHAPE levers come from the SDK canonical defaults (src/terrain-defaults.js) so the CPU height
  // path == the GPU _PROBE_ == the demo's blessed look in ONE place. SHAPE_UNIFORM_DEFAULTS carries:
  // uLandBias -800, uBeachShelfM 0 (->600m guard), canyonDepthMul 1.0, uDetailOverlay 50, uHiFreqCut
  // 0.95, uCarveWide 0, uMtnBandWide 0.1, uClimateRelief 0.65, uIsleWide 1.0, cliffAmt 3.0.
  ...SHAPE_UNIFORM_DEFAULTS,
  uVsCheap: 0.0,
  uOctMax: 12, uInciseRidgeOcts: 4, uBroadLowOcts: 2, uPeakOcts: 3,   // uBroadLowOcts 8->2 mirrors gl-render.js:467 (the high octaves only feed the 2400m-step mesa-flatness SLOPE gate, averaged out -> 0 elevation effect; A/B-confirmed)
  uNoUnroll: 64,   // FXC anti-unroll bound, mirrors gl-render setComposeHeightUniforms (value-neutral: 64 > every NoiseLayer numOct)
  uDetailFbmOcts: 3,
  // (vtxDetail / uVtxBaseOcts / uVtxErodeOcts dropped 2026-06-18 to restore the
  //  "mirror gl-render.js" parity contract -- gl-render removed those setters when
  //  vtxDisplace became a 0.0 stub; they were never read here either.)
}

/**
 * Create a headless (no GPU/DOM) CPU terrain-height sampler -- the server-side physics-collider
 * counterpart to the GPU terrain.glsl fractal, kept in exact parity via the transpiled
 * height-gen.js (see AGENTS.md project/cpu-gpu-height-parity-integer-hash).
 *
 * @param {Object} [opts]
 * @param {number} [opts.radius=6360] - Planet radius, same internal unit as createPlanet's config.radius.
 * @param {number} [opts.reliefScale] - Vertical relief scale; defaults to radius/63600000 (mirrors
 *   the GPU's uReliefScale convention) so CPU heights match the rendered surface at any radius.
 * @param {number} [opts.hpfTexRes=128] - Must match the renderer's HPF bake resolution (see
 *   planet-orchestrator's HPF_RES) or CPU/GPU heights will diverge at fine detail.
 * @param {Object} [opts.anchorField] - Reuse an existing createAnchorField() instance instead of
 *   creating a new one (avoids double-baking the same field when a consumer already has one).
 * @param {number} [opts.seed] - Anchor-field seed, only used if opts.anchorField is not passed.
 * @param {Object} [opts.uniforms] - Per-field overrides merged over HEIGHT_UNIFORM_DEFAULTS.
 * @returns {Object} { heightAt(dir), surfacePoint(dir), radius, anchorField, uniforms, _fns }.
 *   heightAt(dir) accepts a NON-unit direction vector (internally normalized via glsl-rt's
 *   normalize, which safely falls back to length=1 on a degenerate/zero-length input rather
 *   than dividing by zero -- a zero vector returns a defined, if physically meaningless, height
 *   rather than NaN or throwing). surfacePoint(dir) returns the world-space point on the terrain
 *   surface along that direction.
 */
export function createHeightSampler(opts = {}) {
  const radius = opts.radius || 6360
  // SCALE-INVARIANT relief: mirror the GLSL composeHeight wrapper's uReliefScale (R/6360000,
  // or an independent opts.reliefScale) so the CPU physics height matches the rendered surface.
  const reliefScale = opts.reliefScale != null ? opts.reliefScale : radius / 63600000
  const hpfTexRes = opts.hpfTexRes || 128
  const BAKE_MAX_LEVEL = Math.round(Math.log2(hpfTexRes))   // matches planet-orchestrator bake
  const af = opts.anchorField || createAnchorField({ seed: opts.seed })
  const U = { ...HEIGHT_UNIFORM_DEFAULTS, defRadius: radius, ...(opts.uniforms || {}) }

  // --- HPF bake (CPU mirror of planet-orchestrator bakeFaceRows + the terrain.glsl
  // hpfSample bilinear). The GPU samples a per-face RES^2 baked texture with a
  // QUINTIC-C2 bilinear, NOT the continuous field; sampling the continuous field
  // diverged from the rendered surface by up to ~640m (HPF texel interpolation).
  // We bake the SAME grid (inset map fu=x/(RES-1), the renderer default) into a flat
  // [seaBias,elevAmp,temp,humid] per texel, then replicate the inset quintic bilinear
  // -> the CPU continental bias matches the GPU to float precision. Lazy per face
  // (only faces the caller actually samples are baked) so a local play patch pays for
  // ~1 face, not all 6.
  const RES = hpfTexRes
  const _faceBuf = new Array(6).fill(null)
  function _bakeFace(face) {
    const buf = new Float32Array(RES * RES * 4)
    for (let y = 0; y < RES; y++) {
      const fv = y / (RES - 1)                          // inset (matches renderer default _hpfInset=true)
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
  // hpfSample(dir) = the GPU hpfSample: inset quintic-bilinear of the baked face grid.
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
    return out   // [seaBias, elevAmp, temp, humid]
  }
  const H = makeHeight(U, hpfSample)

  // Rendered terrain elevation (metres, signed) at a world DIRECTION (need not be unit).
  // faceLocal/tileM are inert (vtxDisplace returns 0), passed as dummies.
  function heightAt(dir) {
    const d = g.normalize(dir)
    return H.composeHeight(d, [0, 0], 100) * reliefScale
  }
  // World-space surface point for a direction: dir * (radius + height).
  function surfacePoint(dir) { const d = g.normalize(dir); return g.mul(d, radius + heightAt(d)) }

  return { heightAt, surfacePoint, radius, anchorField: af, uniforms: U, _fns: H }
}
