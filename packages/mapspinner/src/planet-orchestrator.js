import { Quadtree } from './quadtree.js';
import { initMapspinnerRender } from './gl-render.js';
import { createAnchorField } from './anchor-field.js';
import { TERRAIN_DEFAULTS as TD } from './terrain-defaults.js';

import { FACE_FRAME, dot, worldToFaceLocal, quadOutsideFrustum, extractFrustumPlanes, pickFace, CULL_ELEV_FRAC } from './planet-orchestrator-cull.js';
export { FACE_FRAME, dot, worldToFaceLocal, quadOutsideFrustum, extractFrustumPlanes, pickFace } from './planet-orchestrator-cull.js';

const LOD_LEAN = 0.35;
const LOD_POP_ALTITUDE_MUL = 8.0;
const NEAR_NADIR_LOOK_DOT = -0.95;
const MOUNTAIN_ELEVAMP_LO = 16.8, MOUNTAIN_ELEVAMP_HI = 18.6;

export async function initMapspinnerPlanet(gl, opts = {}) {
  if (opts.radius != null && (!Number.isFinite(opts.radius) || opts.radius <= 0)) {
    throw new TypeError(`mapspinner: opts.radius must be a positive finite number, got ${opts.radius}`);
  }
  if (opts.gridMeshSize != null && (!Number.isInteger(opts.gridMeshSize) || opts.gridMeshSize < 2)) {
    throw new TypeError(`mapspinner: opts.gridMeshSize must be an integer >= 2, got ${opts.gridMeshSize}`);
  }
  const R = opts.radius || 6360.0;
  const maxLevel = opts.maxLevel ?? 11;
  const splitFactor = opts.splitFactor ?? TD.splitFactor;
  const gridMeshSize = opts.gridMeshSize || 11;
  const _geomorphLod = !!opts.geomorphLod

  const _colorBufferFloatExt = gl.getExtension('EXT_color_buffer_float');
  if (!_colorBufferFloatExt) {
    throw new Error('mapspinner: EXT_color_buffer_float required for terrain rendering');
  }
  const _floatLinearExt = gl.getExtension('OES_texture_float_linear');
  if (typeof window !== 'undefined') window.__floatLinearOK = !!_floatLinearExt;

  const _now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const _t = { start: _now() };
  const render = await initMapspinnerRender(gl, { radius: R, gridMeshSize, reliefScale: opts.reliefScale, bakeOnly: !!opts.bakeOnly });
  _t.shaderCompileMs = +(_now() - _t.start).toFixed(0);
  const qt = new Quadtree(R);

  const _tHpf0 = _now();
  const hpf = createAnchorField({ seed: opts.hpfSeed || 1337 });
  _t.anchorFieldMs = +(_now() - _tHpf0).toFixed(0);
  const HPF_RES = opts.hpfTexRes || 128;
  function _mkHpfTex(internalFmt) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, internalFmt, HPF_RES, HPF_RES, 6);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  const hpfTex  = _mkHpfTex(gl.RG16F);
  const hpfTex2 = _mkHpfTex(gl.RG8);
  const BAKE_MAX_LEVEL = Math.round(Math.log2(HPF_RES));
  const _bakeBuf  = new Float32Array(HPF_RES * HPF_RES * 2);
  const _bakeBuf2 = new Uint8Array(HPF_RES * HPF_RES * 2);
  function bakeFace(face) {
    const buf = _bakeBuf;
    const _hpfInset = (typeof window !== 'undefined' && window.__hpfInset === false) ? false : true;
    const buf2 = _bakeBuf2;
    bakeFaceRows(face, 0, HPF_RES, buf, buf2, _hpfInset);
    uploadFace(face, buf, buf2);
  }
  function bakeFaceRows(face, yStart, yEnd, buf, buf2, _hpfInset) {
    for (let y = yStart; y < yEnd; y++) for (let x = 0; x < HPF_RES; x++) {
      const fu = _hpfInset ? x / (HPF_RES - 1) : (x + 0.5) / HPF_RES;
      const fv = _hpfInset ? y / (HPF_RES - 1) : (y + 0.5) / HPF_RES;
      const s = hpf.sampleUV(face, fu, fv, BAKE_MAX_LEVEL);
      const o = (y * HPF_RES + x) * 2;
      buf[o] = s.seaBias; buf[o+1] = s.elevAmp;
      buf2[o]   = Math.max(0, Math.min(255, Math.round(s.temp     * 255)));
      buf2[o+1] = Math.max(0, Math.min(255, Math.round(s.humidity * 255)));
    }
  }
  function uploadFace(face, buf, buf2) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, hpfTex);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, face, HPF_RES, HPF_RES, 1, gl.RG, gl.FLOAT, buf);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, hpfTex2);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, face, HPF_RES, HPF_RES, 1, gl.RG, gl.UNSIGNED_BYTE, buf2);
  }
  function bakeHpf() { for (let face = 0; face < 6; face++) bakeFace(face); }
  const _startFace = (typeof opts.startFace === 'number') ? (opts.startFace|0) : 0;
  const _tBake0 = _now();
  bakeFace(_startFace);
  _t.bakeHpfMs = +(_now() - _tBake0).toFixed(0);
  _t.bakeFacesPending = 5;
  _t.totalInitMs = +(_now() - _t.start).toFixed(0);
  if (render.setHpf) render.setHpf(hpfTex, HPF_RES, hpfTex2);

  if (typeof window !== 'undefined') {
    const _rest = [0,1,2,3,4,5].filter(f => f !== _startFace);
    const _bgYield = (cb) => (typeof requestIdleCallback !== 'undefined') ? requestIdleCallback(cb, {timeout: 32}) : setTimeout(cb, 0);
    const ROWS_PER_SLICE = 32;
    let _bgFace = -1, _bgRow = 0;
    const _bgInset = (typeof window !== 'undefined' && window.__hpfInset === false) ? false : true;
    function _bgBakeNext(deadline) {
      if (_bgFace < 0) {
        if (!_rest.length) { _t.bakeFacesPending = 0; clearCache(); return; }
        _bgFace = _rest.shift(); _bgRow = 0;
      }
      do {
        const yEnd = Math.min(HPF_RES, _bgRow + ROWS_PER_SLICE);
        bakeFaceRows(_bgFace, _bgRow, yEnd, _bakeBuf, _bakeBuf2, _bgInset);
        _bgRow = yEnd;
      } while (_bgRow < HPF_RES && deadline && deadline.timeRemaining && deadline.timeRemaining() > 8);
      if (_bgRow >= HPF_RES) {
        uploadFace(_bgFace, _bakeBuf, _bakeBuf2);
        _bgFace = -1;
        _t.bakeFacesPending = _rest.length;
        clearCache();
      }
      _bgYield(_bgBakeNext);
    }
    _bgYield(_bgBakeNext);
  } else { bakeHpf(); _t.bakeFacesPending = 0; }
  if (typeof window !== 'undefined') {
    window.__initTimings = _t;
    window.__hpf = hpf;
    window.__hpfRebake = () => { bakeHpf(); };
  }
  let vegetation = null;

  let _frameCache = null;
  let _pipelineQuads = null;
  const _quadsPoolA = [], _quadsPoolB = [];
  const _cullCtxScratch = { planes: new Float64Array(24), ex: 0, ey: 0, ez: 0,
                            ux: 0, uy: 0, uz: 0, vx: 0, vy: 0, vz: 0, cx: 0, cy: 0, cz: 0,
                            R, maxElev: R * CULL_ELEV_FRAC };
  let frameStart = 0;

  function frame(camWorldPos, camTarget, fovy = 0.7, displayMode = 0, sunDir, time = 0, up, surfElev = 0, shadowInfo) {
    const sun = sunDir || (() => { const s = [0.4, 0.5, 0.75]; const sl = Math.hypot(...s); return [s[0]/sl, s[1]/sl, s[2]/sl]; })();
    const camUp = up || opts.up || [0, 1, 0];

    const camDist = Math.hypot(camWorldPos[0],camWorldPos[1],camWorldPos[2]);
    const moveTol = Math.min(250.0, Math.max(1.0, (camDist - R) * 0.00005));
    const fwd = [camTarget[0]-camWorldPos[0], camTarget[1]-camWorldPos[1], camTarget[2]-camWorldPos[2]];
    const c = _frameCache;
    const moved = !c || !c.pos
      || Math.hypot(camWorldPos[0]-c.pos[0], camWorldPos[1]-c.pos[1], camWorldPos[2]-c.pos[2]) > moveTol
      || (fwd[0]*c.fwd[0]+fwd[1]*c.fwd[1]+fwd[2]*c.fwd[2]) < c.fwdLen2*0.99999
      || displayMode !== c.displayMode;
    if (!moved) {
      const cam2 = { eye: camWorldPos, center: camTarget, up: camUp, fovy, displayMode, surfElev, shadowInfo, morphSplitDist: _geomorphLod ? qt.splitDist : 0, morphDistFactor: qt.distFactor, morphMaxLevel: qt.maxLevel };
      render.render(c.quads, cam2, sun, time);
      const glError = (typeof window !== 'undefined' && window.__glCheck) ? render.checkGlError() : 0;
      try {
        if (vegetation && typeof window !== 'undefined' && window.__veg) {
          vegetation.draw(cam2, sun, render.cullMatrix(cam2).viewProjRel);
        }
      } catch(e){}
      try { if (typeof window !== 'undefined') window.__cullStats = { kept: c.quads.length, culled: -1, culledOnScreen: -1, cullActive: false, frame: 'cached', altM: Math.round(camDist - R) }; } catch(_){}
      return { quadCount: c.quads.length, glError, face: c.frontFace, residentCount: 0,
               fallbackCount: c.fallbackCount, maxFallbackLevel: c.maxFallbackLevel, frontFallback: c.frontFallback, cached: true };
    }

    let sf = (typeof window !== 'undefined' && window.__splitFactor != null)
      ? Math.max(0.05, +window.__splitFactor) : splitFactor;
    const altKm = Math.max(0, (camDist - R) / 1000);
    if (opts.altSplitRamp && (typeof window === 'undefined' || window.__splitFactor == null)) {
      const PEAK = 1.4;
      let mul;
      if (altKm >= 700) {
        const KN = [[700,0.865],[900,1.009],[1200,0.966],[1700,0.898],[2400,1.19],[3200,0.865],[5000,0.86],[12000,0.72],[20000,0.60],[40000,0.45]];
        if (altKm <= KN[0][0]) { mul = KN[0][1]; }
        else if (altKm >= KN[KN.length-1][0]) { mul = KN[KN.length-1][1]; }
        else { for (let i = 1; i < KN.length; i++) { if (altKm <= KN[i][0]) {
          const a0 = KN[i-1][0], v0 = KN[i-1][1], a1 = KN[i][0], v1 = KN[i][1];
          const t = (Math.log(altKm) - Math.log(a0)) / (Math.log(a1) - Math.log(a0));
          mul = v0 + (v1 - v0) * t; break;
        } } }
      } else if (altKm >= 150) {
        const x = (700 - altKm) / (700 - 150);
        mul = 1.0 + (PEAK - 1.0) * (x*x*(3 - 2*x));
      } else if (altKm >= 50) {
        mul = PEAK;
      } else {
        mul = PEAK;
      }
      sf = sf * mul * LOD_LEAN;
    }
    const LOD_STEP = 3.6;
    qt.computeSplitDist(sf * LOD_STEP, gl.drawingBufferHeight || 480, fovy);
    const distF = (typeof window !== 'undefined' && window.__distFactor != null) ? +window.__distFactor : sf * LOD_POP_ALTITUDE_MUL;
    let mxl = (typeof window !== 'undefined' && window.__maxLevel != null)
      ? Math.max(2, Math.min(22, window.__maxLevel|0)) : maxLevel;
    const DECK_CAP_ALT_KM = (typeof window !== 'undefined' && window.__deckCapAltKm != null) ? +window.__deckCapAltKm : 1.0;
    let DECK_CAP_LEVEL = 12;
    if (hpf && hpf.sampleDir) {
      const nA = hpf.sampleDir([camWorldPos[0]/camDist, camWorldPos[1]/camDist, camWorldPos[2]/camDist]);
      const mountainWeight = Math.max(0, Math.min(1, (nA.elevAmp - MOUNTAIN_ELEVAMP_LO) / (MOUNTAIN_ELEVAMP_HI - MOUNTAIN_ELEVAMP_LO)));
      DECK_CAP_LEVEL = 12 + Math.round(2 * mountainWeight);
    }
    const _maxLevelOverridden = (typeof window !== 'undefined' && window.__maxLevel != null);
    if (!_maxLevelOverridden && altKm < DECK_CAP_ALT_KM && mxl > DECK_CAP_LEVEL) mxl = DECK_CAP_LEVEL;
    if (!_maxLevelOverridden && altKm >= 30 && mxl > 4) {
      mxl -= (altKm >= 700) ? 2 : 1;
    }
    qt.setConfig(R, mxl, distF);
    const splitDist = sf + 1.0;

    const quads = (_pipelineQuads === _quadsPoolA) ? _quadsPoolB : _quadsPoolA;
    let _quadN = 0;
    let fallbackCount = 0, maxFallbackLevel = -1, frontFallback = 0, culledCount = 0;
    let frontFace = pickFace(camWorldPos);
    let lodRefPos = camWorldPos;
    let aimGroundPt = null;
    {
      const aimBias = (typeof window !== 'undefined' && window.__lodAimBias != null) ? Math.max(0, Math.min(1, +window.__lodAimBias)) : 0.0;
      const fwdLen = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
      const fx = fwd[0]/fwdLen, fy = fwd[1]/fwdLen, fz = fwd[2]/fwdLen;
      const b = camWorldPos[0]*fx + camWorldPos[1]*fy + camWorldPos[2]*fz;
      const cc = camDist*camDist - R*R;
      const disc = b*b - cc;
      if (disc > 0) {
        const tHit = -b - Math.sqrt(disc);
        if (tHit > 0) aimGroundPt = [camWorldPos[0] + tHit*fx, camWorldPos[1] + tHit*fy, camWorldPos[2] + tHit*fz];
      }
      if (aimBias > 0 && disc > 0) {
        const t = -b - Math.sqrt(disc);
        if (t > 0) {
          const gx = camWorldPos[0] + t*fx, gy = camWorldPos[1] + t*fy, gz = camWorldPos[2] + t*fz;
          const gl = Math.hypot(gx, gy, gz) || 1;
          const cnx = camWorldPos[0]/camDist, cny = camWorldPos[1]/camDist, cnz = camWorldPos[2]/camDist;
          let rx = cnx*(1-aimBias) + (gx/gl)*aimBias;
          let ry = cny*(1-aimBias) + (gy/gl)*aimBias;
          let rz = cnz*(1-aimBias) + (gz/gl)*aimBias;
          const rl = Math.hypot(rx, ry, rz) || 1;
          lodRefPos = [rx/rl*camDist, ry/rl*camDist, rz/rl*camDist];
        }
      }
    }
    try {
      if (typeof window !== 'undefined' && window.__glCheck) {
        const sepDot = (lodRefPos[0]*camWorldPos[0] + lodRefPos[1]*camWorldPos[1] + lodRefPos[2]*camWorldPos[2]) / (camDist*camDist);
        window.__lodRefSepDeg = Math.acos(Math.max(-1, Math.min(1, sepDot))) * 57.29578;
      }
    } catch (e) {}
    const cullOn = (typeof window !== 'undefined' && window.__frustumCull != null) ? !!window.__frustumCull : (opts.frustumCull !== false);
    const cullActive = cullOn && render.cullMatrix;
    const _cullDbgOn = (typeof window !== 'undefined' && !!window.__cullDebug);
    let _cullDbgOnScreen = 0;
    const _cm = cullActive ? render.cullMatrix({ eye: camWorldPos, center: camTarget, up: camUp, fovy, surfElev }) : null;
    const vpr = _cm ? _cm.viewProjNoEye : null;
    let cullCtx = null;
    if (cullActive && vpr) {
      const fl = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
      const lookDot = (fwd[0] * camWorldPos[0] + fwd[1] * camWorldPos[1] + fwd[2] * camWorldPos[2]) / (fl * camDist);
      const hcOn = (typeof window !== 'undefined' && window.__hcull != null) ? !!window.__hcull : (lookDot > NEAR_NADIR_LOOK_DOT);
      if (hcOn) {
        extractFrustumPlanes(vpr, _cullCtxScratch.planes);
        _cullCtxScratch.ex = camWorldPos[0]; _cullCtxScratch.ey = camWorldPos[1]; _cullCtxScratch.ez = camWorldPos[2];
        cullCtx = _cullCtxScratch;
      }
    }
    const camDirX = camWorldPos[0]/camDist, camDirY = camWorldPos[1]/camDist, camDirZ = camWorldPos[2]/camDist;
    const cosHorizon = Math.min(1.0, R / camDist);
    const altM = Math.max(0.0, camDist - R);
    const elSlack = Math.min(R * CULL_ELEV_FRAC, 200.0 * (R / 6360000.0) + altM * 0.5);
    const limbCullActive = (typeof window !== 'undefined' && window.__limbCull != null ? !!window.__limbCull : true)
      && altM > 0.5;
    const cam = { eye: camWorldPos, center: camTarget, up: camUp, fovy, displayMode, surfElev, shadowInfo, morphSplitDist: _geomorphLod ? qt.splitDist : 0, morphDistFactor: qt.distFactor, morphMaxLevel: qt.maxLevel, cullMatrix: _cm };
    if (_pipelineQuads) {
      render.render(_pipelineQuads, cam, sun, time);
    }
    for (let face = 0; face < 6; face++) {
      const localCam = worldToFaceLocal(face, camWorldPos, R);
      const lodLocalCam = (lodRefPos === camWorldPos) ? localCam : worldToFaceLocal(face, lodRefPos, R);
      const aimLocal = aimGroundPt ? worldToFaceLocal(face, aimGroundPt, R) : null;
      if (cullCtx) {
        const Fc = FACE_FRAME[face];
        cullCtx.ux = Fc.u[0]; cullCtx.uy = Fc.u[1]; cullCtx.uz = Fc.u[2];
        cullCtx.vx = Fc.v[0]; cullCtx.vy = Fc.v[1]; cullCtx.vz = Fc.v[2];
        cullCtx.cx = Fc.c[0]; cullCtx.cy = Fc.c[1]; cullCtx.cz = Fc.c[2];
      }
      const leaves = qt.updateQuadtree(lodLocalCam[0], lodLocalCam[1], lodLocalCam[2], localCam[0], localCam[1],
                                       aimLocal ? aimLocal[0] : undefined, aimLocal ? aimLocal[1] : undefined,
                                       camDist - R, cullCtx);
      const n = leaves.length;
      if (n <= 0) continue;
      const F = FACE_FRAME[face];
      for (let i = 0; i < n; i++) {
        const q = leaves[i];
        const level = q.level, tx = q.tx, ty = q.ty;
        const ox = q.ox, oy = q.oy, l = q.l;
        let _qofInside = false;
        if (limbCullActive && (level|0) >= 2) {
          const cx = ox + l*0.5, cy = oy + l*0.5;
          const len = Math.hypot(cx, cy, R) || 1;
          const wx = (cx/len)*F.u[0]+(cy/len)*F.v[0]+(R/len)*F.c[0];
          const wy = (cx/len)*F.u[1]+(cy/len)*F.v[1]+(R/len)*F.c[1];
          const wz = (cx/len)*F.u[2]+(cy/len)*F.v[2]+(R/len)*F.c[2];
          const dotOut = wx*camDirX + wy*camDirY + wz*camDirZ;
          const slack = elSlack / R + (l / R);
          if (dotOut < cosHorizon - slack) {
            if (vpr) {
              if (quadOutsideFrustum(face, ox, oy, l, R, vpr, camWorldPos)) { culledCount++; continue; }
              _qofInside = true;
            }
          }
        }
        if (cullActive && (level|0) >= 2 && !_qofInside && quadOutsideFrustum(face, ox, oy, l, R, vpr, camWorldPos)) {
          culledCount++;
          if (_cullDbgOn) {
            const _wk = Math.PI/4.0;
            const ccx = R*Math.tan(((ox + l*0.5)/R)*_wk), ccy = R*Math.tan(((oy + l*0.5)/R)*_wk);
            const cl = Math.hypot(ccx, ccy, R) || 1;
            const cwx = (ccx/cl)*F.u[0]+(ccy/cl)*F.v[0]+(R/cl)*F.c[0];
            const cwy = (ccx/cl)*F.u[1]+(ccy/cl)*F.v[1]+(R/cl)*F.c[1];
            const cwz = (ccx/cl)*F.u[2]+(ccy/cl)*F.v[2]+(R/cl)*F.c[2];
            const dX = cwx*R - camWorldPos[0], dY = cwy*R - camWorldPos[1], dZ = cwz*R - camWorldPos[2];
            const px = vpr[0]*dX+vpr[4]*dY+vpr[8]*dZ+vpr[12];
            const py = vpr[1]*dX+vpr[5]*dY+vpr[9]*dZ+vpr[13];
            const pw = vpr[3]*dX+vpr[7]*dY+vpr[11]*dZ+vpr[15];
            const pz = vpr[2]*dX+vpr[6]*dY+vpr[10]*dZ+vpr[14];
            if (pw > 1e-3 && Math.abs(px/pw) < 1 && Math.abs(py/pw) < 1 && pz <= pw) _cullDbgOnScreen++;
          }
          continue;
        }
        if (opts.occlusionPredicate) {
          try {
            const _wk = Math.PI / 4.0;
            const _ccx = R * Math.tan(((ox + l * 0.5) / R) * _wk), _ccy = R * Math.tan(((oy + l * 0.5) / R) * _wk);
            const _cl = Math.hypot(_ccx, _ccy, R) || 1;
            const wx = (_ccx / _cl) * F.u[0] + (_ccy / _cl) * F.v[0] + (R / _cl) * F.c[0];
            const wy = (_ccx / _cl) * F.u[1] + (_ccy / _cl) * F.v[1] + (R / _cl) * F.c[1];
            const wz = (_ccx / _cl) * F.u[2] + (_ccy / _cl) * F.v[2] + (R / _cl) * F.c[2];
            const worldCenter = [wx * R, wy * R, wz * R];
            const worldSize = l * 1.2;
            if (opts.occlusionPredicate(face, level, tx, ty, worldCenter, worldSize)) { culledCount++; continue; }
          } catch (_) { }
        }
        let _qo = quads[_quadN];
        if (_qo === undefined) _qo = quads[_quadN] = { quad: { level: 0, tx: 0, ty: 0, ox: 0, oy: 0, l: 0 }, face: 0, localCam: null, splitDist: 0 };
        const _qd = _qo.quad; _qd.level = level; _qd.tx = tx; _qd.ty = ty; _qd.ox = ox; _qd.oy = oy; _qd.l = l;
        _qo.face = face; _qo.localCam = localCam; _qo.splitDist = splitDist;
        _quadN++;
      }
    }
    quads.length = _quadN;

    if (!_pipelineQuads) {
      render.render(quads, cam, sun, time);
    }
    const glError = (typeof window !== 'undefined' && window.__glCheck) ? render.checkGlError() : 0;
    _pipelineQuads = quads;
    try {
      if (typeof window !== 'undefined') {
        window.__cullStats = { kept: quads.length, culled: culledCount, culledOnScreen: _cullDbgOnScreen,
          cullActive, frame: 'rebuild', altM: Math.round((camDist - R) ) };
      }
    } catch(_){}
    try {
      if (vegetation && typeof window !== 'undefined' && window.__veg) {
        const vn = vegetation.buildInstances(quads, cam);
        vegetation.draw(cam, sun, render.cullMatrix(cam).viewProjRel);
        try { window.__vegCount = vn; window.__grassCount = vegetation.grass; } catch(_){}
      }
    } catch(e){ try { window.__vegErr = String(e.message||e); } catch(_){} }
    try { window.__lastGLQuads = quads; window.__lastGLCam = cam; window.__lastGLRender = render; } catch(e){}
    if (_frameCache && _frameCache.pos) {
      _frameCache.pos[0]=camWorldPos[0]; _frameCache.pos[1]=camWorldPos[1]; _frameCache.pos[2]=camWorldPos[2];
      _frameCache.fwd = fwd; _frameCache.fwdLen2 = fwd[0]*fwd[0]+fwd[1]*fwd[1]+fwd[2]*fwd[2];
      _frameCache.displayMode = displayMode; _frameCache.quads = quads; _frameCache.frontFace = frontFace;
      _frameCache.fallbackCount = fallbackCount; _frameCache.maxFallbackLevel = maxFallbackLevel; _frameCache.frontFallback = frontFallback;
    } else {
      _frameCache = { pos: [camWorldPos[0],camWorldPos[1],camWorldPos[2]], fwd, fwdLen2: fwd[0]*fwd[0]+fwd[1]*fwd[1]+fwd[2]*fwd[2],
                      displayMode, quads, frontFace, fallbackCount, maxFallbackLevel, frontFallback };
    }
    return { quadCount: quads.length, glError, face: frontFace, residentCount: 0, fallbackCount, maxFallbackLevel, frontFallback, culledCount, cached: false };
  }

  function clearCache() { _frameCache = null; }
  return { frame, render, clearCache };
}
