const TAN_40DEG = Math.tan(40.0 / 180.0 * Math.PI);

export class Quadtree {
  constructor(size) {
    this.size = size || 6360000.0;
    this.maxLevel = 20;
    this.splitDist = 1.1;
    this.distFactor = 2.0;
    this._cam = [0, 0, 0];
    this._camAlt = 0.0;
    this._nadir = [0, 0];
    this._aim = null;
    this._aimArr = [0, 0];
    this._leaves = [];
    this._n = 0;
    this._cull = null;
    this._altitudeDistTerm = 0.0;
    this._nearProtectRadius = 0.0;
    this._farCoarsenFloor = 0.6;
  }

  setConfig(size, maxLevel, distFactor) {
    this.size = size; this.maxLevel = maxLevel; this.distFactor = distFactor;
  }

  computeSplitDist(splitFactor, viewportH, fovRad) {
    let sd = splitFactor * viewportH / 1024.0 * TAN_40DEG / Math.tan(fovRad / 2.0);
    if (!(sd >= 1.1) || !isFinite(sd)) sd = 1.1;
    this.splitDist = sd;
    return sd;
  }

  _cameraDist(ox, oy, l) {
    const dz = this._altitudeDistTerm;
    const dx = Math.min(Math.abs(this._cam[0] - ox), Math.abs(this._cam[0] - (ox + l)));
    const dy = Math.min(Math.abs(this._cam[1] - oy), Math.abs(this._cam[1] - (oy + l)));
    return Math.max(dz, Math.max(dx, dy));
  }

  _recurse(level, tx, ty, ox, oy, l) {
    if (this._cull !== null && level >= 2 && nodeOutsideFrustum(this._cull, ox, oy, l)) return;
    const dist = this._cameraDist(ox, oy, l);
    const cxv = ox + l * 0.5, cyv = oy + l * 0.5;
    const nx0 = Math.max(ox, Math.min(this._nadir[0], ox + l));
    const ny0 = Math.max(oy, Math.min(this._nadir[1], oy + l));
    let latC = Math.max(Math.abs(this._nadir[0] - nx0), Math.abs(this._nadir[1] - ny0));
    if (this._aim !== null) {
      const ax0 = Math.max(ox, Math.min(this._aim[0], ox + l));
      const ay0 = Math.max(oy, Math.min(this._aim[1], oy + l));
      const latA = Math.max(Math.abs(this._aim[0] - ax0), Math.abs(this._aim[1] - ay0));
      if (latA < latC) latC = latA;
    }
    const near = this._nearProtectRadius;
    const fall = 1.0 / (1.0 + Math.max(0.0, latC - near) / near);
    const floor = this._farCoarsenFloor;
    const effSplit = this.splitDist * Math.max(floor, fall);
    if (dist < l * effSplit && level < this.maxLevel) {
      const hl = l / 2.0;
      this._recurse(level + 1, 2 * tx,     2 * ty,     ox,      oy,      hl);
      this._recurse(level + 1, 2 * tx + 1, 2 * ty,     ox + hl, oy,      hl);
      this._recurse(level + 1, 2 * tx,     2 * ty + 1, ox,      oy + hl, hl);
      this._recurse(level + 1, 2 * tx + 1, 2 * ty + 1, ox + hl, oy + hl, hl);
    } else {
      const i = this._n++;
      let o = this._leaves[i];
      if (o === undefined) o = this._leaves[i] = { level: 0, tx: 0, ty: 0, ox: 0, oy: 0, l: 0 };
      o.level = level; o.tx = tx; o.ty = ty; o.ox = ox; o.oy = oy; o.l = l;
    }
  }

  updateQuadtree(camX, camY, camZ, nadirX, nadirY, aimX, aimY, camAlt, cull) {
    this._cam[0] = camX; this._cam[1] = camY; this._cam[2] = camZ;
    this._camAlt = (camAlt !== undefined && camAlt !== null)
      ? camAlt
      : Math.sqrt(camX * camX + camY * camY + camZ * camZ) - this.size;
    this._nadir[0] = (nadirX !== undefined) ? nadirX : camX;
    this._nadir[1] = (nadirY !== undefined) ? nadirY : camY;
    if (aimX !== undefined && aimY !== undefined) { this._aimArr[0] = aimX; this._aimArr[1] = aimY; this._aim = this._aimArr; }
    else this._aim = null;
    this._n = 0;
    this._cull = (cull != null) ? cull : null;
    this._altitudeDistTerm = Math.max(this._camAlt / this.distFactor, 0.0);
    const _horizon = Math.sqrt(2.0 * this.size * Math.max(this._camAlt, 0.0));
    this._nearProtectRadius = Math.max(this._camAlt * 2.0, _horizon * 0.2, 10000.0 * (this.size / 6360000.0));
    const _altLog = Math.log2(Math.max(this._camAlt, 5000.0) / 5000.0);
    this._farCoarsenFloor = Math.max(0.30, Math.min(0.60, 0.60 - _altLog * 0.05));
    this._recurse(0, 0, 0, -this.size, -this.size, 2.0 * this.size);
    this._leaves.length = this._n;
    return this._leaves;
  }
}

export function localToDeformed(x, y, z, R) {
  const k = Math.PI / 4.0;
  const wx = R * Math.tan((x / R) * k);
  const wy = R * Math.tan((y / R) * k);
  const inv = (z + R) / Math.sqrt(wx * wx + wy * wy + R * R);
  return [wx * inv, wy * inv, R * inv];
}

function nodeOutsideFrustum(cull, ox, oy, l) {
  const R = cull.R, WK = Math.PI / 4.0, ME = cull.maxElev;
  const ux = cull.ux, uy = cull.uy, uz = cull.uz, vx = cull.vx, vy = cull.vy, vz = cull.vz, cx = cull.cx, cy = cull.cy, cz = cull.cz;
  const rr = R + ME;
  const tX0 = R * Math.tan((ox / R) * WK), tX1 = R * Math.tan(((ox + l) / R) * WK);
  const tY0 = R * Math.tan((oy / R) * WK), tY1 = R * Math.tan(((oy + l) / R) * WK);
  const cwX = R * Math.tan(((ox + l * 0.5) / R) * WK), cwY = R * Math.tan(((oy + l * 0.5) / R) * WK);
  let ax = cwX * ux + cwY * vx + R * cx, ay = cwX * uy + cwY * vy + R * cy, az = cwX * uz + cwY * vz + R * cz;
  let ln = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
  const C0x = (ax / ln) * R, C0y = (ay / ln) * R, C0z = (az / ln) * R;
  let maxR2 = 0;
  for (let ci = 0; ci < 4; ci++) {
    const wx = (ci & 1) ? tX1 : tX0, wy = (ci & 2) ? tY1 : tY0;
    ax = wx * ux + wy * vx + R * cx; ay = wx * uy + wy * vy + R * cy; az = wx * uz + wy * vz + R * cz;
    ln = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    const dx = (ax / ln) * rr - C0x, dy = (ay / ln) * rr - C0y, dz = (az / ln) * rr - C0z;
    const d2 = dx * dx + dy * dy + dz * dz; if (d2 > maxR2) maxR2 = d2;
  }
  const radius = Math.sqrt(maxR2) + ME;
  const Cx = C0x - cull.ex, Cy = C0y - cull.ey, Cz = C0z - cull.ez;
  const P = cull.planes;
  const nearSD = P[16] * Cx + P[17] * Cy + P[18] * Cz + P[19];
  if (nearSD <= -radius) return true;
  if (nearSD < radius) return false;
  if (P[0]  * Cx + P[1]  * Cy + P[2]  * Cz + P[3]  < -radius) return true;
  if (P[4]  * Cx + P[5]  * Cy + P[6]  * Cz + P[7]  < -radius) return true;
  if (P[8]  * Cx + P[9]  * Cy + P[10] * Cz + P[11] < -radius) return true;
  if (P[12] * Cx + P[13] * Cy + P[14] * Cz + P[15] < -radius) return true;
  if (P[20] * Cx + P[21] * Cy + P[22] * Cz + P[23] < -radius) return true;
  return false;
}
