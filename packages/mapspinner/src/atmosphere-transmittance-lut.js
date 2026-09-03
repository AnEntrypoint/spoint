// src/atmosphere-transmittance-lut.js
// -----------------------------------------------------------------------------
// Precomputed TRANSMITTANCE LUT (Bruneton-lite), the first/foundational piece of a
// staged precomputed-atmosphere upgrade for shaders/atmosphere.glsl. Scattering LUT +
// terrain aerial-perspective integration are explicit FOLLOW-UP work (each depends on
// this LUT existing) and are NOT implemented here.
//
// WHAT THIS REPLACES: atmosphere.glsl's atm_transmittanceToSun() currently computes
// sun-to-point transmittance by an analytic fixed-step (N=4) trapezoid optical-depth
// march (atm_opticalDepth/atm_transmittanceSeg) EVERY TIME it's called -- and it's
// called from inside atm_marchRadiance's own per-sample loop (N=8 samples), so a single
// sky pixel evaluates the SAME transmittance-to-space-boundary integral (as a function
// of the sample point's altitude+view-angle-to-sun) up to 8 times per pixel, each with
// only 4 crude fixed steps. A transmittance LUT bakes exactly this integral -- optical
// depth from a point at radius r looking along direction cosine mu OUT to the top of the
// atmosphere -- ONCE, at high step-count/precision, indexed by (altitude, view-angle),
// and every runtime call becomes a single texture sample instead of a 4-step march.
//
// PARAMETERIZATION (matches Bruneton's canonical transmittance-LUT layout so the same
// bake mirrors his method's actual encoding, adapted to km/ATM_BOTTOM/ATM_TOP units this
// file already uses):
//   u (altitude axis, texel column): rho = sqrt(max(r*r - ATM_BOTTOM*ATM_BOTTOM, 0)) is
//     the distance from the point to the horizon; rho in [0, rhoMax] where
//     rhoMax = sqrt(ATM_TOP*ATM_TOP - ATM_BOTTOM*ATM_BOTTOM) maps LINEARLY to u in [0,1].
//     This is Bruneton's own r<->rho remap (constant-density-scale-height friendly,
//     avoids wasting resolution on the near-negligible high-altitude tail).
//   v (view-angle axis, texel row): d = distToTop(r, mu) (distance from the point to the
//     top-of-atmosphere boundary along mu) maps NONLINEARLY so texel density increases
//     near the horizon (where transmittance changes fastest -- grazing rays pass through
//     far more atmosphere per unit angle than near-zenith rays). Uses Bruneton's own
//     d_min/d_max horizon-relative remap (see getTextureCoordFromUnitRange in the
//     reference implementation): dMin = ATM_TOP - r (mu=1, straight up) and
//     dMax = rho + rhoMaxSurf (mu=muHorizon, grazing the ground-sphere tangent), giving
//     v = (d - dMin) / (dMax - dMin), so v=0 is the zenith ray and v=1 is the horizon ray.
// -----------------------------------------------------------------------------

// ---- Atmosphere constants (MUST mirror shaders/atmosphere.glsl's ATM_* consts exactly,
// or the baked LUT encodes a different atmosphere than the shader that samples it renders).
export const ATM_BOTTOM = 6360.0;
export const ATM_TOP = 6500.0;
export const ATM_RAYLEIGH_H = 18.0;
export const ATM_MIE_H = 4.0;
export const ATM_RAYLEIGH = [0.005802, 0.013558, 0.0331];
const ATM_MIE_SCAT = 0.003996;
export const ATM_MIE_EXT = ATM_MIE_SCAT * (1.0 / 0.9); // Mie extinction = scat/ssa, ssa~0.9 (matches atmosphere.glsl)

export const LUT_WIDTH = 256;  // altitude axis (u / rho)
export const LUT_HEIGHT = 128; // view-angle axis (v / d)
const MARCH_STEPS = 500; // offline bake: far higher precision than the runtime's own N=4 fixed-step march

function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

// distance from a point at radius r along direction cosine mu to the ATM_TOP shell.
// Mirrors atm_distToTop in atmosphere.glsl exactly (same quadratic).
function distToTop(r, mu) {
  const disc = r * r * (mu * mu - 1.0) + ATM_TOP * ATM_TOP;
  if (disc < 0) return -1;
  return Math.max(-r * mu + Math.sqrt(disc), 0);
}

// Analytic densities at radius r (mirrors atm_densities in atmosphere.glsl).
function densities(r) {
  const alt = r - ATM_BOTTOM;
  return [Math.exp(-alt / ATM_RAYLEIGH_H), Math.exp(-alt / ATM_MIE_H)];
}

// Optical depth (Rayleigh, Mie) along the segment [p0, p0+dir*d], high-precision trapezoid.
// dir must be a unit 3-vector; p0/dir are plain [x,y,z] arrays (km, atmosphere-space).
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

// Transmittance (r, mu) -> [Tr, Tg, Tb], from a point at radius r along view-cosine mu
// out to the top of the atmosphere (or [1,1,1] if the ray never enters/immediately exits).
// This is the exact quantity atm_transmittanceToSun/atm_marchRadiance need (minus the
// soft sea-level horizon attenuation, which stays a runtime multiply post-LUT-sample --
// it depends on the SUN's horizon dip, not a property of the atmosphere's optical depth).
export function transmittanceAt(r, mu, steps = MARCH_STEPS) {
  const d = distToTop(r, mu);
  if (d <= 0) return [1, 1, 1];
  // Build an orthonormal-enough frame: point straight along +z at radius r, direction
  // with cosine mu against +z (sinTheta component along +x). This 2D-in-3D placement is
  // exact for a spherically symmetric atmosphere (only r and mu matter, not azimuth).
  const sinMu = Math.sqrt(Math.max(0, 1 - mu * mu));
  const p0 = [0, 0, r];
  const dir = [sinMu, 0, mu];
  const [odR, odM] = opticalDepth(p0, dir, d, steps);
  const tr = Math.exp(-(ATM_RAYLEIGH[0] * odR + ATM_MIE_EXT * odM));
  const tg = Math.exp(-(ATM_RAYLEIGH[1] * odR + ATM_MIE_EXT * odM));
  const tb = Math.exp(-(ATM_RAYLEIGH[2] * odR + ATM_MIE_EXT * odM));
  return [tr, tg, tb];
}

// u (altitude/rho axis) <-> r. Bruneton's rho-remap: rho = sqrt(r^2 - bottom^2) maps
// LINEARLY to u in [0,1]; rho in [0, rhoMax], rhoMax = sqrt(top^2 - bottom^2).
function rFromU(u) {
  const rhoMax = Math.sqrt(ATM_TOP * ATM_TOP - ATM_BOTTOM * ATM_BOTTOM);
  const rho = clamp(u, 0, 1) * rhoMax;
  return Math.sqrt(rho * rho + ATM_BOTTOM * ATM_BOTTOM);
}
// uFromR/vFromMu exported: atmosphere-scattering-lut.js's bake samples this ALREADY-BAKED
// transmittance data (bilinear, via these exact forward remaps) instead of re-marching
// transmittanceAt() analytically at every one of its own inner-loop samples -- the scattering
// bake's own march calls the sun-transmittance term once per (outer march step) instead of
// once per (outer march step * inner analytic-march sub-step), which is the same LUT-replaces-
// runtime-march performance win this file's own header comment describes, just applied a level
// deeper (CPU-side bake-time reuse, not GPU-side runtime reuse).
export function uFromR(r) {
  const rhoMax = Math.sqrt(ATM_TOP * ATM_TOP - ATM_BOTTOM * ATM_BOTTOM);
  const rho = Math.sqrt(Math.max(0, r * r - ATM_BOTTOM * ATM_BOTTOM));
  return clamp(rho / rhoMax, 0, 1);
}

// v (view-angle/d axis) <-> mu, at a FIXED r (the row's own r, from u). Bruneton's
// horizon-relative d-remap: dMin = top - r (mu=1, zenith), dMax = rho + rhoMax
// (mu=muHorizon, grazing tangent to the ground sphere). v=0 -> zenith ray (mu=1),
// v=1 -> horizon-grazing ray (mu=muHorizon, the most oblique ray that still clears
// the ground and reaches the top shell).
function muFromV(v, r) {
  const rho = Math.sqrt(Math.max(0, r * r - ATM_BOTTOM * ATM_BOTTOM));
  const rhoMax = Math.sqrt(ATM_TOP * ATM_TOP - ATM_BOTTOM * ATM_BOTTOM);
  const dMin = ATM_TOP - r;
  const dMax = rho + rhoMax;
  const d = dMin + clamp(v, 0, 1) * (dMax - dMin);
  if (d <= 0) return 1.0;
  // invert distToTop(r,mu) = -r*mu + sqrt(r^2*(mu^2-1) + top^2) = d for mu:
  //   d + r*mu = sqrt(r^2*mu^2 - r^2 + top^2)
  //   (d + r*mu)^2 = r^2*mu^2 - r^2 + top^2
  //   d^2 + 2*d*r*mu = -r^2 + top^2
  //   mu = (top^2 - r^2 - d^2) / (2*d*r)
  const mu = (ATM_TOP * ATM_TOP - r * r - d * d) / (2.0 * d * r);
  return clamp(mu, -1, 1);
}
// Forward v<-mu (inverse of muFromV above), at a fixed r: v = (d - dMin) / (dMax - dMin), where
// d = distToTop(r,mu) -- exact mirror of atmosphere.glsl's atm_lutUV, needed on the CPU side so
// the scattering bake can look up an arbitrary (r,mu) pair against the already-baked transmittance
// texel grid instead of re-deriving it via the shader-side uv function it doesn't have access to.
export function vFromMu(mu, r) {
  const rho = Math.sqrt(Math.max(0, r * r - ATM_BOTTOM * ATM_BOTTOM));
  const rhoMax = Math.sqrt(ATM_TOP * ATM_TOP - ATM_BOTTOM * ATM_BOTTOM);
  const dMin = ATM_TOP - r;
  const dMax = rho + rhoMax;
  const d = distToTop(r, mu);
  if (d < 0) return 0;
  return dMax > dMin ? clamp((d - dMin) / (dMax - dMin), 0, 1) : 0;
}

// Bake the full LUT into a flat Float32Array, RGB per texel (row-major, v (view-angle)
// varying along rows / texel-Y, u (altitude) varying along columns / texel-X -- matches
// the WebGL texel-Y-is-row convention the JS-side upload uses unchanged).
// steps: march precision per texel (lower for a fast smoke-test bake, MARCH_STEPS default
// for the real shipped bake -- see verify-lut-values below for a live sanity witness).
export function bakeTransmittanceLUT(width = LUT_WIDTH, height = LUT_HEIGHT, steps = MARCH_STEPS) {
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const r = rFromU(u);
      const mu = muFromV(v, r);
      const [tr, tg, tb] = transmittanceAt(r, mu, steps);
      const idx = (y * width + x) * 3;
      data[idx] = tr; data[idx + 1] = tg; data[idx + 2] = tb;
    }
  }
  return { data, width, height };
}

// Live sanity check over an already-baked LUT: every texel finite, in [0,1], and altitude
// monotonicity holds (higher altitude at fixed mu => transmittance never decreases, since
// there is strictly less atmosphere to cross). Returns {ok, reasons[]} -- never throws, so
// a caller (browser witness / exec_js) can inspect a structured verdict.
export function verifyLUT({ data, width, height }) {
  const reasons = [];
  let nonFinite = 0, outOfRange = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) nonFinite++;
    else if (v < -1e-6 || v > 1 + 1e-6) outOfRange++;
  }
  if (nonFinite > 0) reasons.push(`${nonFinite} non-finite texels`);
  if (outOfRange > 0) reasons.push(`${outOfRange} texels outside [0,1]`);
  // Altitude monotonicity: for a fixed row (fixed v -> fixed mu-relative-to-horizon
  // geometry), scanning columns u=0..1 is scanning r=ATM_BOTTOM..ATM_TOP at THE SAME
  // v-fraction (not the same absolute mu, since muFromV depends on r) -- so instead
  // check the more directly meaningful invariant: at a FIXED mu=1 (straight up), r
  // increasing must never decrease transmittance (monotonically thinner path to space).
  let monotoneViolations = 0;
  const N = 32;
  let prevT = 0;
  for (let i = 0; i <= N; i++) {
    const r = ATM_BOTTOM + (ATM_TOP - ATM_BOTTOM) * (i / N);
    const [tr] = transmittanceAt(r, 1.0, 200);
    if (i > 0 && tr < prevT - 1e-4) monotoneViolations++;
    prevT = tr;
  }
  if (monotoneViolations > 0) reasons.push(`${monotoneViolations} altitude-monotonicity violations (zenith ray)`);
  return { ok: reasons.length === 0, reasons, nonFinite, outOfRange, monotoneViolations };
}
