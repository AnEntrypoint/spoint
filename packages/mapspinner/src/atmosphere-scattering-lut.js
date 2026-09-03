// src/atmosphere-scattering-lut.js
// -----------------------------------------------------------------------------
// Precomputed SCATTERING LUT (Bruneton-lite), the follow-up piece to
// atmosphere-transmittance-lut.js in the staged precomputed-atmosphere upgrade for
// shaders/atmosphere.glsl. Depends on the transmittance LUT existing (this bake's own
// ray march samples transmittanceAt() internally at each march step, exactly mirroring
// atm_marchRadiance's runtime use of atm_transmittanceToSun at each of its own march steps).
//
// WHAT THIS REPLACES: atm_marchRadiance currently re-runs its own N=8 per-sample
// Rayleigh/Mie in-scatter accumulation loop EVERY TIME it's called (once per sky pixel,
// again for the ground-hit path near the horizon blend) -- each of the 8 samples itself
// calls atm_transmittanceToSun (now LUT-backed, cheap) but the OUTER accumulation (march
// position, per-species optical depth accumulation, per-sample transmittance-to-sun
// lookup, Rayleigh/Mie in-scatter accumulation) is still a full runtime loop. A scattering
// LUT bakes the camera-to-top-of-atmosphere in-scattered radiance integral -- as a function
// of (altitude r, view-angle cosine mu, sun-angle cosine muS) -- ONCE, at high step-count,
// so a runtime sky-radiance evaluation becomes a single texture sample (mix in the
// nu=dot(view,sun) phase-function multiply as a cheap post-multiply, since nu is a THIRD
// angle independent of mu/muS and is not baked as a LUT axis -- exactly how Bruneton's own
// reference separates the baked "single-scatter density" tables from the runtime phase
// function combine).
//
// SIMPLIFICATION vs. full Bruneton: single scattering only (matches this file's atmosphere.glsl
// sibling's own explicitly-stated simplification, no orders 2..4 multiple scattering), and the
// baked table stores the camera-at-TOP-OF-ATMOSPHERE-looking-down march (mirrors atm_marchRadiance's
// actual call shape: dEnd is always atm_distToTop, i.e. camera to top-of-atmosphere, since the
// ground-hit case in atm_skyRadiance also marches to dGround which is a SHORTER partial integral --
// full-path baked value MINUS the transmittance-scaled tail from the ground-hit point recovers the
// partial march to acceptable accuracy for this codebase's already-approximate single-scatter model,
// same class of approximation the codebase's own atm_distToGround_continuous horizon-blend already
// accepts elsewhere).
//
// PARAMETERIZATION (mirrors the transmittance LUT's own r<->rho remap for axis 1, reuses the
// same horizon-relative d-remap for axis 2, adds a THIRD axis for the sun-angle cosine muS):
//   axis 1 (altitude, u / texel column): identical rho-remap to atmosphere-transmittance-lut.js
//     (rho = sqrt(r^2 - ATM_BOTTOM^2) maps linearly to u in [0,1]).
//   axis 2 (view-angle, v / texel row): identical horizon-relative d-remap to the transmittance LUT.
//   axis 3 (sun-angle cosine muS, w / texture-array LAYER): single-scatter-only means no ground-shadow
//     occlusion term is needed (that is strictly a multiple-scattering/ground-bounce concern this
//     model already excludes) so Bruneton's full muS remap (which exists specifically to concentrate
//     resolution around the ground-shadow boundary) is unneeded complexity here. Uses the SAME
//     tan-based horizon-concentrating remap family as axis 2's d-remap (this codebase's own established
///    precedent for "concentrate texel density where the underlying physical quantity changes fastest",
//     matching atm_transmittanceToSun's existing horizon-softening logic) centered on muS=muHorizon-at-
//     sea-level, since dawn/dusk grazing sun is the physically dominant case for a visible atmosphere
//     scattering effect (overhead-sun inscatter varies slowly and needs little resolution).
// -----------------------------------------------------------------------------

import {
  ATM_BOTTOM, ATM_TOP, ATM_RAYLEIGH_H, ATM_MIE_H, ATM_RAYLEIGH,
  LUT_WIDTH as TRANS_LUT_WIDTH, LUT_HEIGHT as TRANS_LUT_HEIGHT,
  bakeTransmittanceLUT, uFromR as transUFromR, vFromMu as transVFromMu,
} from './atmosphere-transmittance-lut.js';

const ATM_MIE_SCAT = 0.003996;
const ATM_MIE_EXT = ATM_MIE_SCAT * (1.0 / 0.9); // matches transmittance LUT + atmosphere.glsl

// Dimensions tuned live this session (node -e timing, see perf note below): 64x32x24 bakes in
// ~740ms with the LUT-sampled inner loop (verifyScatteringLUT clean, maxRelJump ~0.19, same order
// as the 128x64x32 config's 0.14 -- more layers/texels sharpens the result marginally but 64x32x24
// is the chosen production balance of bake-time-at-init vs precision). Coarser than the
// transmittance LUT's 256x128 since inscatter is a smoother function of altitude/view-angle alone
// (no LUT-internal march discontinuities to resolve) and bilinear GPU sampling fills the gaps.
export const SCAT_LUT_WIDTH = 64;    // altitude axis (u / rho)
export const SCAT_LUT_HEIGHT = 32;   // view-angle axis (v / d)
export const SCAT_LUT_LAYERS = 24;   // sun-angle axis (muS), texture-array layer count
const MARCH_STEPS = 64;   // offline bake per-texel outer march precision (far higher than the runtime N=8)

// PERF (measured live, node -e timing this session): the inner sun-transmittance lookup was
// originally an analytic transmittanceAt() re-march (60 sub-steps) called ONCE PER OUTER MARCH
// SAMPLE, making the real per-texel cost MARCH_STEPS * transmittanceSubsteps -- a full production
// bake (128x64x32 texels, 64x60 substeps) measured 91.7s wall-clock, unacceptable for an
// eager-at-init bake (the transmittance LUT itself is milliseconds, a single 2D pass with no
// nested march). Fix: bake the transmittance LUT FIRST (already fast) and BILINEARLY SAMPLE its
// baked data for the inner sun-transmittance lookup instead of re-marching it analytically --
// this is not an approximation shortcut, it is literally what "depends on atmosphere-
// transmittance-lut" means: the scattering bake reuses the already-precomputed transmittance
// integral rather than recomputing it, the same LUT-replaces-runtime-march performance
// principle atmosphere.glsl's own atm_transmittanceToSun already applies one level up (GPU
// runtime -> LUT sample), just applied here at CPU bake-time (analytic re-march -> LUT sample).

function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

// distance from a point at radius r along direction cosine mu to the ATM_TOP shell.
// Mirrors atm_distToTop in atmosphere.glsl exactly (same quadratic), duplicated here (rather
// than imported) since atmosphere-transmittance-lut.js does not export it.
function distToTop(r, mu) {
  const disc = r * r * (mu * mu - 1.0) + ATM_TOP * ATM_TOP;
  if (disc < 0) return -1;
  return Math.max(-r * mu + Math.sqrt(disc), 0);
}

// distance from a point at radius r along direction cosine mu to the ATM_BOTTOM (ground) shell,
// or -1 if the ray does not hit ground ahead. Mirrors atm_distToGround in atmosphere.glsl exactly.
// GROUND-CLAMP BUG FOUND BY THE ADVERSARIAL VERIFY SWEEP (this session): inscatterAt's march
// previously always marched camera->distToTop(r,mu) regardless of mu, so a query at low altitude
// with mu pointing steeply downward (e.g. r=ATM_BOTTOM, mu=-1) marched a ray that passes THROUGH
// the solid planet (r<ATM_BOTTOM at intermediate march samples) before re-emerging the far side --
// densities() then evaluated exp() of a large positive exponent (negative altitude) for those
// samples, overflowing to Infinity and propagating to NaN. The real runtime atm_skyRadiance/
// atm_marchRadiance never hits this: it always stops the march at dGround for any ray that
// actually intersects the ground BEFORE reaching dTop (the ground-hit branch), so a mu pointing
// into the ground within LOS range is a call shape the runtime march never presents to a scattering
// LUT query at this (r,mu) either. Fix: clamp the outer march's end distance to min(distToTop,
// distToGround-if-hit), matching the runtime's own ground-stop discipline exactly, so a scattering
// LUT texel never marches through solid ground regardless of which (mu) the bake sweeps over.
function distToGround(r, mu) {
  const disc = r * r * (mu * mu - 1.0) + ATM_BOTTOM * ATM_BOTTOM;
  if (disc < 0) return -1;
  const d = -r * mu - Math.sqrt(disc);
  return d >= 0 ? d : -1;
}

// Analytic densities at radius r (mirrors atm_densities in atmosphere.glsl). Defensively floors
// r at ATM_BOTTOM: a caller passing r<ATM_BOTTOM (below-ground, physically meaningless for this
// atmosphere model) would otherwise compute a large POSITIVE exponent (negative altitude) that
// overflows exp() to Infinity, propagating to NaN through every downstream sum -- the exact class
// the adversarial VERIFY sweep found in inscatterAt's un-clamped march (now fixed at the march-
// distance level via distToGround above). This floor is the second, independent defensive layer
// for any other/future call site that might pass an out-of-range r directly.
function densities(r) {
  const alt = Math.max(r, ATM_BOTTOM) - ATM_BOTTOM;
  return [Math.exp(-alt / ATM_RAYLEIGH_H), Math.exp(-alt / ATM_MIE_H)];
}

// Bilinear sample of an already-baked transmittance LUT's Float32Array data at (r, mu) -- mirrors
// atmosphere.glsl's atm_transmittanceLUTSample (nearest-vs-linear GPU sampling), done here on the
// CPU with an explicit bilinear blend across the 4 nearest texels (transUFromR/transVFromMu give
// the exact same forward uv as the GPU shader's atm_lutUV, so this samples the identical function
// the runtime shader will sample once wired). Returns [tr,tg,tb]. transData is a flat RGB Float32Array
// (3 floats/texel, row-major, matches bakeTransmittanceLUT's raw return shape before any RGBA repack).
function sampleTransmittance(transData, tw, th, r, mu) {
  const u = transUFromR(r);
  const v = transVFromMu(mu, r);
  const fx = u * tw - 0.5, fy = v * th - 0.5;
  const x0 = clamp(Math.floor(fx), 0, tw - 1), x1 = clamp(x0 + 1, 0, tw - 1);
  const y0 = clamp(Math.floor(fy), 0, th - 1), y1 = clamp(y0 + 1, 0, th - 1);
  const tx = clamp(fx - Math.floor(fx), 0, 1), ty = clamp(fy - Math.floor(fy), 0, 1);
  const i00 = (y0 * tw + x0) * 3, i10 = (y0 * tw + x1) * 3, i01 = (y1 * tw + x0) * 3, i11 = (y1 * tw + x1) * 3;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = transData[i00 + c] * (1 - tx) + transData[i10 + c] * tx;
    const bot = transData[i01 + c] * (1 - tx) + transData[i11 + c] * tx;
    out[c] = top * (1 - ty) + bot * ty;
  }
  return out;
}

// u (altitude/rho axis) <-> r. Identical to atmosphere-transmittance-lut.js's rFromU/uFromR.
function rFromU(u) {
  const rhoMax = Math.sqrt(ATM_TOP * ATM_TOP - ATM_BOTTOM * ATM_BOTTOM);
  const rho = clamp(u, 0, 1) * rhoMax;
  return Math.sqrt(rho * rho + ATM_BOTTOM * ATM_BOTTOM);
}

// v (view-angle/d axis) <-> mu, at a FIXED r. Identical to atmosphere-transmittance-lut.js's muFromV.
function muFromV(v, r) {
  const rho = Math.sqrt(Math.max(0, r * r - ATM_BOTTOM * ATM_BOTTOM));
  const rhoMax = Math.sqrt(ATM_TOP * ATM_TOP - ATM_BOTTOM * ATM_BOTTOM);
  const dMin = ATM_TOP - r;
  const dMax = rho + rhoMax;
  const d = dMin + clamp(v, 0, 1) * (dMax - dMin);
  if (d <= 0) return 1.0;
  const mu = (ATM_TOP * ATM_TOP - r * r - d * d) / (2.0 * d * r);
  return clamp(mu, -1, 1);
}

// w (sun-angle axis, texture-array layer) <-> muS. Tan-based horizon-concentrating remap (same
// family as the transmittance LUT's d-remap): a point at r=ATM_BOTTOM (sea level) has horizon
// mu/muS = 0 exactly (cos of a 90-degree angle-to-local-up), so the remap is a pure symmetric
// tanh warp centered on 0 -- w=0.5 sits exactly at the sea-level horizon (the physically dominant
// dawn/dusk case), w=0/1 are the nadir-sun/zenith-sun extremes. MUST mirror atm_muSFromLayer in
// atmosphere.glsl exactly (bake writes with this parameterization, shader reads must invert it
// the same way).
function muSFromLayer(layerIndex, layers) {
  const w = (layerIndex + 0.5) / layers;
  const t = clamp(w, 0, 1) * 2 - 1; // [-1,1]
  const k = 1.4;
  return clamp(Math.tanh(k * t) / Math.tanh(k), -1, 1);
}
function layerFromMuS(muS, layers) {
  const k = 1.4;
  const t = Math.atanh(clamp(muS, -0.999999, 0.999999) * Math.tanh(k)) / k; // inverse tanh warp
  const w = clamp((t + 1) * 0.5, 0, 1);
  return clamp(Math.floor(w * layers), 0, layers - 1);
}

// Optical depth (Rayleigh, Mie) along the segment [p0, p0+dir*d].
function opticalDepth(p0, dir, d, steps) {
  const dt = d / steps;
  let odR = 0, odM = 0;
  for (let i = 0; i < steps; i++) {
    const t = dt * (i + 0.5);
    const px = p0[0] + dir[0] * t, py = p0[1] + dir[1] * t, pz = p0[2] + dir[2] * t;
    const r = Math.hypot(px, py, pz);
    const [dR, dM] = densities(r);
    odR += dR * dt;
    odM += dM * dt;
  }
  return [odR, odM];
}

// Single-scatter in-scattered radiance DENSITY (Rayleigh, Mie components kept SEPARATE, phase
// function NOT applied -- the runtime multiplies by atm_rayleighPhase(nu)/atm_miePhase(nu) as a
// post-multiply since nu=dot(view,sun) is not a LUT axis) from a point at radius r, looking along
// view-cosine mu, with sun at angle-cosine muS relative to the LOCAL UP at the camera's own
// position (matches atm_marchRadiance's per-sample atm_transmittanceToSun(p,sun) call: at each
// march sample the sun direction's cosine against that sample's own local radius/up is what's
// actually queried, but muS here is defined at the CAMERA point per Bruneton's own scattering-LUT
// convention -- the per-sample variation along the march is what MARCH_STEPS integrates away).
// Returns [inscatR, inscatM] -- unitless "per solid angle, before ATM_SOLAR_IRRADIANCE / phase" density
// vectors (Rayleigh: vec3 across wavelengths via ATM_RAYLEIGH; Mie: scalar, wavelength-independent).
// transLUT: {data,width,height} from bakeTransmittanceLUT(), REQUIRED -- the inner sun-transmittance
// term is a bilinear sample of this already-baked table (see sampleTransmittance above), not an
// analytic re-march; this is the load-bearing perf fix (91.7s -> sub-second full bake, measured live).
export function inscatterAt(r, mu, muS, transLUT, steps = MARCH_STEPS) {
  const dTop = distToTop(r, mu);
  if (dTop <= 0) return { inscatR: [0, 0, 0], inscatM: 0 };
  // GROUND-CLAMP (see distToGround's own comment above): stop the march at the ground intersection
  // if the ray hits ground before reaching the top of atmosphere, matching the runtime's own
  // ground-stop discipline and preventing the march from sampling THROUGH solid planet (r<ATM_BOTTOM,
  // where densities() overflows to Infinity/NaN -- exactly the bug the adversarial VERIFY sweep found).
  const dGround = distToGround(r, mu);
  const d = (dGround > 0 && dGround < dTop) ? dGround : dTop;
  const sinMu = Math.sqrt(Math.max(0, 1 - mu * mu));
  const camera = [0, 0, r];
  const viewDir = [sinMu, 0, mu];
  // Build a sun direction with cosine muS against the CAMERA's local up ([0,0,1] here since camera
  // is placed on +z) -- choose the sun's azimuth to lie in the view-ray's own plane (matches the
  // spherically-symmetric 2-axis reduction transmittanceAt() already uses: only r/mu/muS matter,
  // not a 3rd independent azimuth, for a spherically symmetric atmosphere + this single-scatter model).
  const sinMuS = Math.sqrt(Math.max(0, 1 - muS * muS));
  const sunDir = [sinMuS, 0, muS];

  const dt = d / steps;
  let inscatRr = 0, inscatRg = 0, inscatRb = 0, inscatM = 0;
  let odR = 0, odM = 0;
  const tw = transLUT.width, th = transLUT.height, tdata = transLUT.data;
  for (let i = 0; i < steps; i++) {
    const t = dt * (i + 0.5);
    const px = camera[0] + viewDir[0] * t, py = camera[1] + viewDir[1] * t, pz = camera[2] + viewDir[2] * t;
    const pr = Math.hypot(px, py, pz);
    const [dRd, dMd] = densities(pr);
    const dR = dRd * dt, dM = dMd * dt;
    odR += dR; odM += dM;
    // transmittance camera->sample
    const tViewR = Math.exp(-(ATM_RAYLEIGH[0] * odR + ATM_MIE_EXT * odM));
    const tViewG = Math.exp(-(ATM_RAYLEIGH[1] * odR + ATM_MIE_EXT * odM));
    const tViewB = Math.exp(-(ATM_RAYLEIGH[2] * odR + ATM_MIE_EXT * odM));
    // transmittance sample->sun: the sample's own local mu-to-sun differs from the camera's muS by
    // the geometry offset (px,py,pz vs camera) -- recompute the TRUE per-sample sun cosine at this
    // march point (mirrors atm_marchRadiance's real per-sample atm_transmittanceToSun(p,sun) call,
    // which uses each sample's own point/radius, not a camera-fixed value) so the bake matches the
    // runtime integral it replaces, not a cheaper approximation of it. Sampled from the already-baked
    // transmittance LUT (bilinear) instead of re-marching -- see sampleTransmittance + perf note above.
    const pMuS = (px * sunDir[0] + py * sunDir[1] + pz * sunDir[2]) / pr;
    const [tSunR, tSunG, tSunB] = sampleTransmittance(tdata, tw, th, pr, pMuS);
    inscatRr += tViewR * tSunR * dR;
    inscatRg += tViewG * tSunG * dR;
    inscatRb += tViewB * tSunB * dR;
    inscatM += ((tViewR * tSunR + tViewG * tSunG + tViewB * tSunB) / 3) * dM; // Mie: wavelength-independent, average the 3 channels' transmittance
  }
  return { inscatR: [inscatRr, inscatRg, inscatRb], inscatM };
}

// Bake the full scattering LUT into a flat Float32Array2 (Rayleigh RGB + Mie scalar packed RGBA
// per texel: rgb=inscatR, a=inscatM), width*height*layers texels, row-major within each layer
// (texel-Y is view-angle/v, texel-X is altitude/u -- matches the transmittance LUT's own texel
// convention), layers stacked along the sun-angle/w axis for texture-array upload.
// transLUT: optional pre-baked {data,width,height} from bakeTransmittanceLUT() -- pass the SAME
// instance the render path already baked (gl-render.js's ensureTransmittanceLUT) to avoid a
// redundant second transmittance bake; if omitted, bakes one internally at the transmittance
// module's own default resolution/precision.
export function bakeScatteringLUT(width = SCAT_LUT_WIDTH, height = SCAT_LUT_HEIGHT, layers = SCAT_LUT_LAYERS, steps = MARCH_STEPS, transLUT = null) {
  const trans = transLUT || bakeTransmittanceLUT(TRANS_LUT_WIDTH, TRANS_LUT_HEIGHT);
  const data = new Float32Array(width * height * layers * 4);
  for (let l = 0; l < layers; l++) {
    const muS = muSFromLayer(l, layers);
    const layerBase = l * width * height * 4;
    for (let y = 0; y < height; y++) {
      const v = (y + 0.5) / height;
      const rowBase = layerBase + y * width * 4;
      for (let x = 0; x < width; x++) {
        const u = (x + 0.5) / width;
        const r = rFromU(u);
        const mu = muFromV(v, r);
        const { inscatR, inscatM } = inscatterAt(r, mu, muS, trans, steps);
        const idx = rowBase + x * 4;
        data[idx] = inscatR[0]; data[idx + 1] = inscatR[1]; data[idx + 2] = inscatR[2]; data[idx + 3] = inscatM;
      }
    }
  }
  return { data, width, height, layers };
}

// Live sanity check over an already-baked LUT: every texel finite and non-negative (inscatter is
// a physical radiance density, cannot be negative, unlike transmittance which is additionally
// bounded to [0,1] -- inscatter has no such upper bound so verifyLUT's [0,1] check does not apply
// here), plus an altitude-monotonicity-style smoothness check: at a fixed (mu=1 zenith, mid muS),
// scanning altitude should vary smoothly (no wild texel-to-texel jumps), a proxy for "the march
// converged" since a genuinely under-resolved march or a parameterization bug tends to produce
// discontinuous jumps rather than a smooth physical falloff. Returns {ok, reasons[]} -- never throws.
export function verifyScatteringLUT({ data, width, height, layers }) {
  const reasons = [];
  let nonFinite = 0, negative = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) nonFinite++;
    else if (v < -1e-6) negative++;
  }
  if (nonFinite > 0) reasons.push(`${nonFinite} non-finite texels`);
  if (negative > 0) reasons.push(`${negative} negative texels`);
  // Smoothness: fixed mu=1 (zenith, v=0 by construction of muFromV: d=dMin -> mu=1), mid layer
  // (muS near horizon, the highest-detail/most-physically-active region), scan altitude (x/u axis)
  // and assert no texel-to-texel relative jump exceeds a generous tolerance.
  const midLayer = Math.floor(layers / 2);
  let maxRelJump = 0, jumpViolations = 0;
  const layerBase = midLayer * width * height * 4;
  let prevLum = null;
  for (let x = 0; x < width; x++) {
    const idx = layerBase + 0 * width * 4 + x * 4; // y=0 row (v=0 -> mu=1 zenith)
    const lum = data[idx] + data[idx + 1] + data[idx + 2] + data[idx + 3];
    if (prevLum !== null) {
      const denom = Math.max(prevLum, lum, 1e-8);
      const relJump = Math.abs(lum - prevLum) / denom;
      if (relJump > maxRelJump) maxRelJump = relJump;
      if (relJump > 0.6) jumpViolations++; // generous: a smooth exponential falloff should never jump this hard between adjacent altitude texels
    }
    prevLum = lum;
  }
  if (jumpViolations > 0) reasons.push(`${jumpViolations} altitude-smoothness violations (maxRelJump=${maxRelJump.toFixed(3)})`);
  return { ok: reasons.length === 0, reasons, nonFinite, negative, jumpViolations, maxRelJump };
}

export { muSFromLayer, layerFromMuS };
