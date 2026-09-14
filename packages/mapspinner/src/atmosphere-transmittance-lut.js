export const ATM_BOTTOM = 6360.0;
export const ATM_TOP = 6500.0;
export const ATM_RAYLEIGH_H = 18.0;
export const ATM_MIE_H = 4.0;
export const ATM_RAYLEIGH = [0.005802, 0.013558, 0.0331];
const ATM_MIE_SCAT = 0.003996;
export const ATM_MIE_EXT = ATM_MIE_SCAT * (1.0 / 0.9);

export const LUT_WIDTH = 256;
export const LUT_HEIGHT = 128;
const MARCH_STEPS = 500;

function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

function distToTop(r, mu) {
  const disc = r * r * (mu * mu - 1.0) + ATM_TOP * ATM_TOP;
  if (disc < 0) return -1;
  return Math.max(-r * mu + Math.sqrt(disc), 0);
}

function densities(r) {
  const alt = r - ATM_BOTTOM;
  return [Math.exp(-alt / ATM_RAYLEIGH_H), Math.exp(-alt / ATM_MIE_H)];
}

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

export function transmittanceAt(r, mu, steps = MARCH_STEPS) {
  const d = distToTop(r, mu);
  if (d <= 0) return [1, 1, 1];
  const sinMu = Math.sqrt(Math.max(0, 1 - mu * mu));
  const p0 = [0, 0, r];
  const dir = [sinMu, 0, mu];
  const [odR, odM] = opticalDepth(p0, dir, d, steps);
  const tr = Math.exp(-(ATM_RAYLEIGH[0] * odR + ATM_MIE_EXT * odM));
  const tg = Math.exp(-(ATM_RAYLEIGH[1] * odR + ATM_MIE_EXT * odM));
  const tb = Math.exp(-(ATM_RAYLEIGH[2] * odR + ATM_MIE_EXT * odM));
  return [tr, tg, tb];
}

function rFromU(u) {
  const rhoMax = Math.sqrt(ATM_TOP * ATM_TOP - ATM_BOTTOM * ATM_BOTTOM);
  const rho = clamp(u, 0, 1) * rhoMax;
  return Math.sqrt(rho * rho + ATM_BOTTOM * ATM_BOTTOM);
}
export function uFromR(r) {
  const rhoMax = Math.sqrt(ATM_TOP * ATM_TOP - ATM_BOTTOM * ATM_BOTTOM);
  const rho = Math.sqrt(Math.max(0, r * r - ATM_BOTTOM * ATM_BOTTOM));
  return clamp(rho / rhoMax, 0, 1);
}

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
export function vFromMu(mu, r) {
  const rho = Math.sqrt(Math.max(0, r * r - ATM_BOTTOM * ATM_BOTTOM));
  const rhoMax = Math.sqrt(ATM_TOP * ATM_TOP - ATM_BOTTOM * ATM_BOTTOM);
  const dMin = ATM_TOP - r;
  const dMax = rho + rhoMax;
  const d = distToTop(r, mu);
  if (d < 0) return 0;
  return dMax > dMin ? clamp((d - dMin) / (dMax - dMin), 0, 1) : 0;
}

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
