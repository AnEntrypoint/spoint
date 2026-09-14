import { FACE_FRAME, BANDS } from './anchor-field-bands.js';


const PARAM_KEYS = ['seaBias', 'elevAmp', 'temp', 'humidity', 'erosion', 'roughness'];
const K = PARAM_KEYS.length;
const PIDX = Object.create(null); PARAM_KEYS.forEach((k, i) => PIDX[k] = i);

const FACE_ROOT_KEY_OFFSET = 8;
const FRACTAL_CYCLES_PER_CELL = 0.06;
const FACES_AROUND_SPHERE = 4.0;
const childKey  = (k, q) => k * 4 + q;
const parentKey = (k) => Math.floor(k / 4);
const hat = (t) => { t = t < 0 ? -t : t; return t >= 1 ? 0 : 1 - t; };

export function createAnchorField(opts = {}) {
  const seed = (opts.seed | 0) || 1337;

  const bands = BANDS.map((B) => ({
    baseLevel: B.level, bn: 1 << B.level,
    nodes: new Map(), cover: new Map(), maxDepth: 0,
  }));
  const bandScales = BANDS.map(() => ({ seaBiasScale: 1.0, elevAmpScale: 1.0, roughnessScale: 1.0 }));
  function rootKey(bandIdx, face, btx, bty) {
    const bn = bands[bandIdx].bn;
    return ((FACE_ROOT_KEY_OFFSET + face) * bn + bty) * bn + btx;
  }

  function baseParams(bandIdx, face, tx, ty) {
    const B = BANDS[bandIdx];
    const n = 1 << B.level;
    const fu = (tx + 0.5) / n, fv = (ty + 0.5) / n;
    return baseParamsAt(bandIdx, face, fu, fv);
  }
  function baseParamsAt(bandIdx, face, fu, fv) {
    const B = BANDS[bandIdx];
    const n = 1 << B.level;
    const u = fu * 2.0 - 1.0, v = fv * 2.0 - 1.0;
    const F = FACE_FRAME[face];
    let dx = F.c[0] + u * F.u[0] + v * F.v[0];
    let dy = F.c[1] + u * F.u[1] + v * F.v[1];
    let dz = F.c[2] + u * F.u[2] + v * F.v[2];
    const dl = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1; dx/=dl; dy/=dl; dz/=dl;
    const lat = Math.asin(Math.max(-1, Math.min(1, dy)));
    const cyclesPerSphere = n * FRACTAL_CYCLES_PER_CELL * FACES_AROUND_SPHERE;
    const sx = dx * cyclesPerSphere, sy = dy * cyclesPerSphere, sz = dz * cyclesPerSphere;
    const fval = B.fractal3(sx, sy, sz, seed + bandIdx * 101);
    return B.params(fval, lat, sx, sz);
  }

  function addOverlay(out, bandIdx, face, fu, fv) {
    const band = bands[bandIdx];
    if (band.nodes.size === 0) return;
    const bn = band.bn;
    let btx = (fu * bn) | 0, bty = (fv * bn) | 0;
    if (btx < 0) btx = 0; else if (btx >= bn) btx = bn - 1;
    if (bty < 0) bty = 0; else if (bty >= bn) bty = bn - 1;
    let key = rootKey(bandIdx, face, btx, bty);
    let lu = fu * bn - btx, lv = fv * bn - bty;
    for (let depth = 0; depth <= band.maxDepth; depth++) {
      const node = band.nodes.get(key);
      if (node) {
        const w = hat((lu - 0.5) * 2.0) * hat((lv - 0.5) * 2.0);
        if (w !== 0) for (let i = 0; i < K; i++) out[i] += node[i] * w;
      }
      const cx = lu >= 0.5 ? 1 : 0, cy = lv >= 0.5 ? 1 : 0;
      const ck = childKey(key, (cy << 1) | cx);
      const childOnEditPath = band.cover.has(ck) || band.nodes.has(ck);
      if (!childOnEditPath) break;
      key = ck; lu = lu * 2 - cx; lv = lv * 2 - cy;
    }
  }

  const _scratch = {}; for (const k of PARAM_KEYS) _scratch[k] = 0;
  const _band = new Float32Array(K), _acc = new Float32Array(K);

  function sampleBand(out, bandIdx, face, fu, fv) {
    const p = baseParamsAt(bandIdx, face, fu, fv);
    for (let i = 0; i < K; i++) out[i] += p[PARAM_KEYS[i]];
    addOverlay(out, bandIdx, face, fu, fv);
  }

  const _iAmp = PIDX.elevAmp, _iRgh = PIDX.roughness, _iSea = PIDX.seaBias;
  function sampleUV(face, fu, fv, maxBandLevel) {
    for (let i = 0; i < K; i++) _acc[i] = 0;
    let amp = 1.0, rough = 0.0;
    for (let b = 0; b < bands.length; b++) {
      if (maxBandLevel !== undefined && BANDS[b].level > maxBandLevel) continue;
      for (let i = 0; i < K; i++) _band[i] = 0; _band[_iAmp] = 1.0;
      sampleBand(_band, b, face, fu, fv);
      const bs = bandScales[b];
      _band[_iSea] *= bs.seaBiasScale;
      _band[_iAmp]  = 1.0 + (_band[_iAmp] - 1.0) * bs.elevAmpScale;
      _band[_iRgh] *= bs.roughnessScale;
      for (let i = 0; i < K; i++) if (i !== _iAmp && i !== _iRgh) _acc[i] += _band[i];
      amp *= _band[_iAmp];
      rough = Math.max(rough, _band[_iRgh]);
    }
    _acc[_iAmp] = amp; _acc[_iRgh] = rough;
    for (let i = 0; i < K; i++) _scratch[PARAM_KEYS[i]] = _acc[i];
    return _scratch;
  }

  function sampleTile(face, level, tx, ty) {
    const n = 1 << level;
    const fu = (tx + 0.5) / n, fv = (ty + 0.5) / n;
    return sampleUV(face, fu, fv);
  }

  function dirToFaceUV(d) {
    const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
    let face, sc, fu, fv;
    if (ax >= ay && ax >= az) { face = d[0] > 0 ? 0 : 1; sc = 1 / ax; }
    else if (ay >= az)        { face = d[1] > 0 ? 2 : 3; sc = 1 / ay; }
    else                      { face = d[2] > 0 ? 4 : 5; sc = 1 / az; }
    const F = FACE_FRAME[face];
    const u = (d[0]*F.u[0] + d[1]*F.u[1] + d[2]*F.u[2]) * sc;
    const v = (d[0]*F.v[0] + d[1]*F.v[1] + d[2]*F.v[2]) * sc;
    fu = u * 0.5 + 0.5; fv = v * 0.5 + 0.5;
    return { face, fu, fv };
  }
  function sampleDir(d) { const { face, fu, fv } = dirToFaceUV(d); return sampleUV(face, fu, fv); }

  function editNode(bandIdx, face, btx, bty, deltas, depth = 0, sx = 0, sy = 0) {
    const band = bands[bandIdx];
    let key = rootKey(bandIdx, face, btx, bty);
    for (let dd = 0; dd < depth; dd++) {
      const sh = depth - 1 - dd, cx = (sx >> sh) & 1, cy = (sy >> sh) & 1;
      key = childKey(key, (cy << 1) | cx);
    }
    let v = band.nodes.get(key);
    const fresh = !v;
    if (!v) { v = new Float32Array(K); band.nodes.set(key, v); }
    for (const k in deltas) { const i = PIDX[k]; if (i !== undefined) v[i] += deltas[k]; }
    if (fresh) {
      const root = rootKey(bandIdx, face, btx, bty);
      let pk = key;
      while (pk !== root) { pk = parentKey(pk); band.cover.set(pk, (band.cover.get(pk) || 0) + 1); }
      if (depth > band.maxDepth) band.maxDepth = depth;
    }
    return key;
  }
  function editAtDir(bandIdx, d, deltas, depth = 0) {
    const { face, fu, fv } = dirToFaceUV(d);
    const bn = bands[bandIdx].bn;
    let btx = Math.min(bn - 1, Math.max(0, Math.floor(fu * bn)));
    let bty = Math.min(bn - 1, Math.max(0, Math.floor(fv * bn)));
    const sub = 1 << depth;
    const lu = fu * bn - btx, lv = fv * bn - bty;
    const sx = Math.min(sub - 1, Math.max(0, Math.floor(lu * sub)));
    const sy = Math.min(sub - 1, Math.max(0, Math.floor(lv * sub)));
    return editNode(bandIdx, face, btx, bty, deltas, depth, sx, sy);
  }

  function rebuildBand(bandIdx, entries) {
    const band = bands[bandIdx];
    band.nodes = new Map(); band.cover = new Map(); band.maxDepth = 0;
    const bn = band.bn, rootLo = FACE_ROOT_KEY_OFFSET * bn * bn, rootHi = (FACE_ROOT_KEY_OFFSET + 6) * bn * bn;
    const isRoot = (k) => k >= rootLo && k < rootHi;
    for (const [k, arr] of entries) {
      band.nodes.set(k, arr instanceof Float32Array ? arr : Float32Array.from(arr));
      let pk = k, depth = 0;
      while (!isRoot(pk)) { pk = parentKey(pk); band.cover.set(pk, (band.cover.get(pk) || 0) + 1); depth++; }
      if (depth > band.maxDepth) band.maxDepth = depth;
    }
  }

  function serialize() {
    return JSON.stringify({
      seed, version: 2,
      bands: bands.map((b) => ({ baseLevel: b.baseLevel,
        nodes: Array.from(b.nodes, ([k, arr]) => [k, Array.from(arr)]) })),
    });
  }
  function load(json) {
    const o = typeof json === 'string' ? JSON.parse(json) : json;
    if (!o) return false;
    if (o.version === 2) {
      for (let b = 0; b < bands.length && b < o.bands.length; b++) rebuildBand(b, o.bands[b].nodes);
      return true;
    }
    if (o.version === 1) {
      for (let b = 0; b < bands.length && b < (o.edits || []).length; b++) {
        const bn = bands[b].bn;
        for (const [addr, delta] of o.edits[b]) {
          const face = (addr / (bn * bn)) | 0, rem = addr % (bn * bn);
          const bty = (rem / bn) | 0, btx = rem % bn;
          editNode(b, face, btx, bty, delta, 0);
        }
      }
      return true;
    }
    return false;
  }

  function nodeParams(bandIdx, face, tx, ty) {
    const p = baseParams(bandIdx, face, tx, ty);
    const node = bands[bandIdx].nodes.get(rootKey(bandIdx, face, tx, ty));
    if (node) for (let i = 0; i < K; i++) p[PARAM_KEYS[i]] += node[i];
    return p;
  }

  function bandsInfo() {
    return BANDS.map((B, i) => ({
      band: i, name: B.name, level: B.level,
      anchorsPerFace: (1 << B.level) * (1 << B.level),
      totalAnchors: 6 * (1 << B.level) * (1 << B.level),
      editedNodes: bands[i].nodes.size, maxDepth: bands[i].maxDepth,
    }));
  }

  return {
    BANDS, PARAM_KEYS,
    sampleUV, sampleTile, sampleDir,
    editNode, editAtDir,
    nodeParams, baseParams, rootKey, dirToFaceUV,
    serialize, load, bandsInfo,
    setBandScales(i, s){ if(i>=0 && i<bandScales.length && s){ const b=bandScales[i];
      if(s.seaBiasScale!=null)b.seaBiasScale=+s.seaBiasScale; if(s.elevAmpScale!=null)b.elevAmpScale=+s.elevAmpScale; if(s.roughnessScale!=null)b.roughnessScale=+s.roughnessScale; } return bandScales[i]; },
    getBandScales(i){ return bandScales[i]; },
    get totalEdits() { return bands.reduce((s, b) => s + b.nodes.size, 0); },
  };
}
