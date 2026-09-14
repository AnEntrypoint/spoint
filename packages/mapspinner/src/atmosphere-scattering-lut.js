import {
  ATM_BOTTOM, ATM_TOP, ATM_RAYLEIGH_H, ATM_MIE_H, ATM_RAYLEIGH,
  LUT_WIDTH as TRANS_LUT_WIDTH, LUT_HEIGHT as TRANS_LUT_HEIGHT,
  bakeTransmittanceLUT, uFromR as transUFromR, vFromMu as transVFromMu,
} from './atmosphere-transmittance-lut.js';

const ATM_MIE_SCAT = 0.003996;
const ATM_MIE_EXT = ATM_MIE_SCAT * (1.0 / 0.9);

export const SCAT_LUT_WIDTH = 64;
export const SCAT_LUT_HEIGHT = 32;
export const SCAT_LUT_LAYERS = 24;
const MARCH_STEPS = 64;

const SCAT_MUS_WARP_K = 1.4;
const MAX_ALTITUDE_REL_JUMP = 0.6;

function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

function distToTop(r, mu) {
  const disc = r * r * (mu * mu - 1.0) + ATM_TOP * ATM_TOP;
  if (disc < 0) return -1;
  return Math.max(-r * mu + Math.sqrt(disc), 0);
}

function distToGround(r, mu) {
  const disc = r * r * (mu * mu - 1.0) + ATM_BOTTOM * ATM_BOTTOM;
  if (disc < 0) return -1;
  const d = -r * mu - Math.sqrt(disc);
  return d >= 0 ? d : -1;
}

function densities(r) {
  const alt = Math.max(r, ATM_BOTTOM) - ATM_BOTTOM;
  return [Math.exp(-alt / ATM_RAYLEIGH_H), Math.exp(-alt / ATM_MIE_H)];
}

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

function rFromU(u) {
  const rhoMax = Math.sqrt(ATM_TOP * ATM_TOP - ATM_BOTTOM * ATM_BOTTOM);
  const rho = clamp(u, 0, 1) * rhoMax;
  return Math.sqrt(rho * rho + ATM_BOTTOM * ATM_BOTTOM);
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

function muSFromLayer(layerIndex, layers) {
  const w = (layerIndex + 0.5) / layers;
  const t = clamp(w, 0, 1) * 2 - 1;
  const k = SCAT_MUS_WARP_K;
  return clamp(Math.tanh(k * t) / Math.tanh(k), -1, 1);
}
function layerFromMuS(muS, layers) {
  const k = SCAT_MUS_WARP_K;
  const t = Math.atanh(clamp(muS, -0.999999, 0.999999) * Math.tanh(k)) / k;
  const w = clamp((t + 1) * 0.5, 0, 1);
  return clamp(Math.floor(w * layers), 0, layers - 1);
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

export function inscatterAt(r, mu, muS, transLUT, steps = MARCH_STEPS) {
  const dTop = distToTop(r, mu);
  if (dTop <= 0) return { inscatR: [0, 0, 0], inscatM: 0 };
  const dGround = distToGround(r, mu);
  const rayHitsGroundBeforeTop = dGround > 0 && dGround < dTop;
  const d = rayHitsGroundBeforeTop ? dGround : dTop;
  const sinMu = Math.sqrt(Math.max(0, 1 - mu * mu));
  const camera = [0, 0, r];
  const viewDir = [sinMu, 0, mu];
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
    const tViewR = Math.exp(-(ATM_RAYLEIGH[0] * odR + ATM_MIE_EXT * odM));
    const tViewG = Math.exp(-(ATM_RAYLEIGH[1] * odR + ATM_MIE_EXT * odM));
    const tViewB = Math.exp(-(ATM_RAYLEIGH[2] * odR + ATM_MIE_EXT * odM));
    const pMuS = (px * sunDir[0] + py * sunDir[1] + pz * sunDir[2]) / pr;
    const [tSunR, tSunG, tSunB] = sampleTransmittance(tdata, tw, th, pr, pMuS);
    inscatRr += tViewR * tSunR * dR;
    inscatRg += tViewG * tSunG * dR;
    inscatRb += tViewB * tSunB * dR;
    const channelMeanTransmittanceForMie = (tViewR * tSunR + tViewG * tSunG + tViewB * tSunB) / 3;
    inscatM += channelMeanTransmittanceForMie * dM;
  }
  return { inscatR: [inscatRr, inscatRg, inscatRb], inscatM };
}

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
  const midLayer = Math.floor(layers / 2);
  let maxRelJump = 0, jumpViolations = 0;
  const layerBase = midLayer * width * height * 4;
  let prevLum = null;
  for (let x = 0; x < width; x++) {
    const idx = layerBase + 0 * width * 4 + x * 4;
    const lum = data[idx] + data[idx + 1] + data[idx + 2] + data[idx + 3];
    if (prevLum !== null) {
      const denom = Math.max(prevLum, lum, 1e-8);
      const relJump = Math.abs(lum - prevLum) / denom;
      if (relJump > maxRelJump) maxRelJump = relJump;
      if (relJump > MAX_ALTITUDE_REL_JUMP) jumpViolations++;
    }
    prevLum = lum;
  }
  if (jumpViolations > 0) reasons.push(`${jumpViolations} altitude-smoothness violations (maxRelJump=${maxRelJump.toFixed(3)})`);
  return { ok: reasons.length === 0, reasons, nonFinite, negative, jumpViolations, maxRelJump };
}

export { muSFromLayer, layerFromMuS };
