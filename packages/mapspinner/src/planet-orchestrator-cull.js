const FACE_FRAME = [
  { c: [ 1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { c: [-1, 0, 0], u: [0, 0,  1], v: [0, 1, 0] },
  { c: [0,  1, 0], u: [1, 0, 0],  v: [0, 0, -1] },
  { c: [0, -1, 0], u: [1, 0, 0],  v: [0, 0,  1] },
  { c: [0, 0,  1], u: [1, 0, 0],  v: [0, 1, 0] },
  { c: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];

const ATAN_INV_K = 4.0 / Math.PI;
function worldToFaceLocal(face, camWorld, R) {
  const F = FACE_FRAME[face];
  const cu = dot(camWorld, F.u), cv = dot(camWorld, F.v), cc = dot(camWorld, F.c);
  const SEAM = R;
  let ox, oy;
  const cameraInFrontOfFace = cc > 1.0;
  if (cameraInFrontOfFace) {
    ox = ATAN_INV_K * R * Math.atan(cu / cc);
    oy = ATAN_INV_K * R * Math.atan(cv / cc);
  } else {
    ox = (cu >= 0 ? SEAM : -SEAM);
    oy = (cv >= 0 ? SEAM : -SEAM);
  }
  return [ox, oy, cc];
}

const CULL_MAX_ELEV = 500000.0;
const CULL_ELEV_FRAC = CULL_MAX_ELEV / 6360000.0;
const CULL_NDC_MARGIN = 0.06;
const _wX = new Float64Array(3), _wY = new Float64Array(3);
function quadOutsideFrustum(face, ox, oy, l, R, vpr, eye) {
  const F = FACE_FRAME[face];
  const ex = eye ? eye[0] : 0, ey = eye ? eye[1] : 0, ez = eye ? eye[2] : 0;
  const WK = Math.PI / 4.0;
  const hl = l * 0.5;
  _wX[0] = R * Math.tan((ox / R) * WK); _wX[1] = R * Math.tan(((ox + hl) / R) * WK); _wX[2] = R * Math.tan(((ox + l) / R) * WK);
  _wY[0] = R * Math.tan((oy / R) * WK); _wY[1] = R * Math.tan(((oy + hl) / R) * WK); _wY[2] = R * Math.tan(((oy + l) / R) * WK);
  const radLo = R*(1.0-CULL_ELEV_FRAC), radHi = R*(1.0+CULL_ELEV_FRAC);
  const p0=vpr[0],p1=vpr[1],p2=vpr[2],p3=vpr[3],p4=vpr[4],p5=vpr[5],p6=vpr[6],p7=vpr[7],
        p8=vpr[8],p9=vpr[9],p10=vpr[10],p11=vpr[11],p12=vpr[12],p13=vpr[13],p14=vpr[14],p15=vpr[15];
  const u0=F.u[0],u1=F.u[1],u2=F.u[2], v0=F.v[0],v1=F.v[1],v2=F.v[2], c0=F.c[0],c1=F.c[1],c2=F.c[2];
  const LO = -1 - CULL_NDC_MARGIN, HI = 1 + CULL_NDC_MARGIN;
  let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity, anyFront=false, anyBehind=false, allBeyondFar=true;
  for (let gx=0; gx<3; gx++) {
    const wpx = _wX[gx];
    for (let gy=0; gy<3; gy++) {
      const wpy = _wY[gy];
      const len = Math.hypot(wpx, wpy, R) || 1;
      const ax = wpx/len, ay = wpy/len, az = R/len;
      const dx = ax*u0+ay*v0+az*c0;
      const dy = ax*u1+ay*v1+az*c1;
      const dz = ax*u2+ay*v2+az*c2;
      for (let s=0;s<2;s++){
        const rad = s===0 ? radLo : radHi;
        const X=dx*rad-ex, Y=dy*rad-ey, Z=dz*rad-ez;
        const cw = p3*X+p7*Y+p11*Z+p15;
        const sampleBehindNear = cw <= 1e-6;
        if (sampleBehindNear) { if (anyFront) return false; anyBehind = true; continue; }
        if (anyBehind) return false;
        anyFront = true;
        const cz = p2*X+p6*Y+p10*Z+p14;
        if (cz <= cw) allBeyondFar = false;
        const nx = (p0*X+p4*Y+p8*Z+p12)/cw, ny = (p1*X+p5*Y+p9*Z+p13)/cw;
        if (nx < minX) minX = nx; if (nx > maxX) maxX = nx;
        if (ny < minY) minY = ny; if (ny > maxY) maxY = ny;
      }
      if (!allBeyondFar && maxX >= LO && minX <= HI && maxY >= LO && minY <= HI) return false;
    }
  }
  if (!anyFront) return true;
  if (anyBehind) return false;
  if (allBeyondFar) return true;
  return (maxX < LO) || (minX > HI) || (maxY < LO) || (minY > HI);
}

function extractFrustumPlanes(m, out) {
  const r0x=m[0], r0y=m[4], r0z=m[8],  r0w=m[12];
  const r1x=m[1], r1y=m[5], r1z=m[9],  r1w=m[13];
  const r2x=m[2], r2y=m[6], r2z=m[10], r2w=m[14];
  const r3x=m[3], r3y=m[7], r3z=m[11], r3w=m[15];
  const W = 1.0 + CULL_NDC_MARGIN;
  _setPlane(out, 0, W*r3x+r0x, W*r3y+r0y, W*r3z+r0z, W*r3w+r0w);
  _setPlane(out, 1, W*r3x-r0x, W*r3y-r0y, W*r3z-r0z, W*r3w-r0w);
  _setPlane(out, 2, W*r3x+r1x, W*r3y+r1y, W*r3z+r1z, W*r3w+r1w);
  _setPlane(out, 3, W*r3x-r1x, W*r3y-r1y, W*r3z-r1z, W*r3w-r1w);
  _setPlane(out, 4,   r3x+r2x,   r3y+r2y,   r3z+r2z,   r3w+r2w);
  _setPlane(out, 5,   r3x-r2x,   r3y-r2y,   r3z-r2z,   r3w-r2w);
}
function _setPlane(out, i, a, b, c, d) {
  const len = Math.hypot(a, b, c) || 1, o = i * 4;
  out[o] = a/len; out[o+1] = b/len; out[o+2] = c/len; out[o+3] = d/len;
}

function pickFace(camWorld) {
  const len = Math.hypot(camWorld[0], camWorld[1], camWorld[2]) || 1;
  const dir = [camWorld[0]/len, camWorld[1]/len, camWorld[2]/len];
  let best = 0, bestDot = -Infinity;
  for (let f = 0; f < 6; f++) {
    const d = dot(dir, FACE_FRAME[f].c);
    if (d > bestDot) { bestDot = d; best = f; }
  }
  return best;
}

export { FACE_FRAME, dot, worldToFaceLocal, quadOutsideFrustum, extractFrustumPlanes, pickFace, CULL_ELEV_FRAC }
