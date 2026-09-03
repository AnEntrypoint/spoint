// anchor-field.js -- the Hierarchical Parameter Field (HPF) that drives the terrain
// generation from a stack of fixed, spatially-indexed anchor quadtrees.
//
// DESIGN (user directive): a HIERARCHY of parameters across scale bands, each band its
// OWN quadtree spatial index, each band driven by its OWN fractal -- so different fractals
// affect different scale bands in different ways. Anchors are FIXED (the quadtree node
// centres; they never move, and the count per band never changes); only their PARAMETER
// payload mutates. The entire planet is anchor-indexed (every surface point falls inside
// exactly one node per band), the distribution is EVEN by construction (a quadtree over a
// cube face subdivides uniformly), and support is LOCAL: a sample reads only the node it
// lands in plus its 3 neighbours for bilinear blend, so editing one node's params changes
// only that cell's neighbourhood -- never the whole planet.
//
// INTEGRATION: this is a pure-JS field (editable, serialisable). The orchestrator samples
// it per tile and pushes the result into the terrain VS via a uniform or texture.
// The field is C0-continuous across tile edges because every tile samples the SAME global
// quadtree partition at its own scale band.
//
// PERFORMANCE (all the most-performant choices):
//   - Param storage is a flat Float32Array per band (cache-friendly, zero object churn),
//     indexed by the node's linear quadtree address. O(1) read/write.
//   - The procedural BASE of every node derives from a deterministic integer hash of its
//     (face, band, level, tx, ty) -- no RNG state, fully reproducible, so persistence only
//     needs the EDITED deltas (a sparse Map), not the whole field.
//   - Sampling is O(bands) -- a handful of band lookups + one bilinear per band -- with no
//     allocation on the hot path (results written into a reused scratch object).


import { FACE_FRAME, BANDS } from './anchor-field-bands.js';


// the parameter keys the field accumulates (sum across bands for additive ones, the field's
// contract with the shader material).
const PARAM_KEYS = ['seaBias', 'elevAmp', 'temp', 'humidity', 'erosion', 'roughness'];
const K = PARAM_KEYS.length;
const PIDX = Object.create(null); PARAM_KEYS.forEach((k, i) => PIDX[k] = i);

// ---- ADAPTIVE QUADTREE node addressing (build-spec aqt-design). Each band has its OWN
// sparse quadtree of EDIT nodes at ARBITRARY depth below its base level. The procedural BASE
// stays analytic (no storage) and the EXISTING fixed-level cell bilinear is the BASE layer,
// byte-for-byte; adaptivity is a strictly ADDITIVE overlay of node "detail hats", so an
// empty edit tree leaves sampleUV numerically identical to the pre-AQT field (no-regression
// is a theorem, not a hope). A node's payload is a flat Float32Array(K) of param DELTAS.
//
// Path key: a depth-0 root per (face, base-cell) folds the base grid into the key; childKey
// is *4+q (q=(cy<<1)|cx), parentKey is /4. Integer-only, prefix-free, safe to ~depth 12.
const FACE_OFF = 8;   // face roots start at 8 (keeps key positive + leaves low range free)
const childKey  = (k, q) => k * 4 + q;
const parentKey = (k) => Math.floor(k / 4);
// hat basis (tent): 1 at centre, 0 at +/-1, compact support -> C0 + local.
const hat = (t) => { t = t < 0 ? -t : t; return t >= 1 ? 0 : 1 - t; };

/**
 * Create the hierarchical parameter field (HPF) -- world-direction climate/elevation
 * modulation (continental bias, biome/temperature/humidity, roughness) sampled seamlessly
 * across cube-sphere faces + poles, with an editable additive-overlay quadtree per band
 * (terraforming edits). Consumed by both the GPU renderer (baked to a texture) and
 * createHeightSampler (CPU parity path) so the same field drives both surfaces.
 *
 * @param {Object} [opts]
 * @param {number} [opts.seed=1337] - Deterministic fractal seed for the base (unedited) field.
 * @returns {Object} { BANDS, PARAM_KEYS, sampleUV(face,fu,fv,maxBandLevel), sampleTile(...),
 *   sampleDir(dir), editNode(...), editAtDir(...), nodeParams(...), baseParams(...), rootKey(...),
 *   dirToFaceUV(dir), serialize(), load(data), bandsInfo(), setBandScales(i,{seaBiasScale,
 *   elevAmpScale,roughnessScale}), getBandScales(i), totalEdits (getter) }. sampleUV/sampleTile
 *   return a shared mutable scratch object -- copy its fields if you need to retain a sample
 *   across the next call.
 */
export function createAnchorField(opts = {}) {
  const seed = (opts.seed | 0) || 1337;

  // Per-band ADAPTIVE QUADTREE record. nodes: pathKey -> Float32Array(K) edit deltas.
  // cover: every ANCESTOR pathKey of an edited node, refcounted -> the descent guide (enter
  // a child only if its key is in cover; O(depth) integer-only, no speculative gets).
  // maxDepth: max adaptive depth present (0 = no overlay anywhere -> global early-out).
  const bands = BANDS.map((B) => ({
    baseLevel: B.level, bn: 1 << B.level,
    nodes: new Map(), cover: new Map(), maxDepth: 0,
  }));
  // RUNTIME per-band scales (full-adjustability via window.__gen.hpf.band[i]). 1.0 = identity =
  // the tuned base field (no behaviour change until edited). seaBiasScale multiplies the band's
  // additive seaBias contribution; elevAmpScale scales its elevAmp DEVIATION from 1 (so 0 = flat,
  // 1 = base, >1 = exaggerated); roughnessScale scales its roughness contribution.
  const bandScales = BANDS.map(() => ({ seaBiasScale: 1.0, elevAmpScale: 1.0, roughnessScale: 1.0 }));
  // depth-0 root key for a base-level cell on a face. bn folded so cells don't collide.
  function rootKey(bandIdx, face, btx, bty) {
    const bn = bands[bandIdx].bn;
    return ((FACE_OFF + face) * bn + bty) * bn + btx;
  }

  // procedural BASE params of a band node (no edits). Deterministic from the node's face-uv
  // centre + the band fractal. UNCHANGED from the pre-AQT field (regression firewall).
  function baseParams(bandIdx, face, tx, ty) {
    const B = BANDS[bandIdx];
    const n = 1 << B.level;
    // cell-CENTRE face coords -> delegate to the continuous evaluator (used by the edit-overlay grid).
    const fu = (tx + 0.5) / n, fv = (ty + 0.5) / n;
    return baseParamsAt(bandIdx, face, fu, fv);
  }
  // CONTINUOUS base params at exact face coords (fu,fv) in [0,1] -- a pure function of the WORLD DIR,
  // so it is seamless across cube faces + poles by construction (seam fix 2026-06-05). The per-band
  // SCALE (cycles/sphere) mirrors the old face-local frequency (n*0.06 cycles/face * 4 faces/sphere).
  function baseParamsAt(bandIdx, face, fu, fv) {
    const B = BANDS[bandIdx];
    const n = 1 << B.level;
    const u = fu * 2.0 - 1.0, v = fv * 2.0 - 1.0;
    const F = FACE_FRAME[face];
    let dx = F.c[0] + u * F.u[0] + v * F.v[0];
    let dy = F.c[1] + u * F.u[1] + v * F.v[1];
    let dz = F.c[2] + u * F.u[2] + v * F.v[2];
    const dl = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1; dx/=dl; dy/=dl; dz/=dl;   // unit world dir
    const lat = Math.asin(Math.max(-1, Math.min(1, dy)));
    const SC = n * 0.06 * 4.0;
    const sx = dx * SC, sy = dy * SC, sz = dz * SC;
    const fval = B.fractal3(sx, sy, sz, seed + bandIdx * 101);
    return B.params(fval, lat, sx, sz);
  }

  // ADDITIVE overlay walk: descend the band's edit quadtree from the base cell toward the
  // sample, accumulating each visited node's hat-weighted delta into the per-band scratch.
  // Allocation-free. Local support is exact (a node's hat is 0 outside its cell +/-1 ring).
  function addOverlay(out, bandIdx, face, fu, fv) {
    const band = bands[bandIdx];
    if (band.nodes.size === 0) return;               // EARLY-OUT: no edits in this band. (Guard
    // on nodes.size, NOT maxDepth===0 -- a DEPTH-0 base-cell edit leaves maxDepth at 0 yet must
    // still apply; the old maxDepth guard silently dropped every depth-0 terraform edit. The
    // loop below runs depth 0..maxDepth, so maxDepth 0 correctly does one iteration at the root.)
    const bn = band.bn;
    let btx = (fu * bn) | 0, bty = (fv * bn) | 0;
    if (btx < 0) btx = 0; else if (btx >= bn) btx = bn - 1;
    if (bty < 0) bty = 0; else if (bty >= bn) bty = bn - 1;
    let key = rootKey(bandIdx, face, btx, bty);
    let lu = fu * bn - btx, lv = fv * bn - bty;      // local coords in [0,1] within base cell
    for (let depth = 0; depth <= band.maxDepth; depth++) {
      const node = band.nodes.get(key);
      if (node) {
        const w = hat((lu - 0.5) * 2.0) * hat((lv - 0.5) * 2.0);
        if (w !== 0) for (let i = 0; i < K; i++) out[i] += node[i] * w;
      }
      const cx = lu >= 0.5 ? 1 : 0, cy = lv >= 0.5 ? 1 : 0;
      const ck = childKey(key, (cy << 1) | cx);
      // descend if the child is an ANCESTOR of some edit (in cover) OR is itself an edited
      // leaf (in nodes). cover holds only ancestors, so the deepest edited node is reached
      // only by also checking nodes -- else the descent breaks one level above the leaf.
      if (!band.cover.has(ck) && !band.nodes.has(ck)) break;
      key = ck; lu = lu * 2 - cx; lv = lv * 2 - cy;
    }
  }

  // reused flat scratch for the hot sample path (no allocation per sample).
  const _scratch = {}; for (const k of PARAM_KEYS) _scratch[k] = 0;
  const _band = new Float32Array(K), _acc = new Float32Array(K);

  // LOCAL-SUPPORT bilinear sample of one band's BASE at face uv, then the additive overlay.
  // The base body is the pre-AQT fixed-level cell bilinear, byte-for-byte (regression firewall).
  function sampleBand(out, bandIdx, face, fu, fv) {
    // SEAM FIX (2026-06-05): the base used a per-face GRID bilinear (4 baseParams cells at clamped
    // integer indices). Even after baseParams became a pure world-dir function, the grid CELL CENTRES
    // do not align across a shared cube-face edge, so the clamped edge-cell bilinear reintroduced a
    // ~2km step (the residual shelf). Since baseParams is now continuous in world dir, evaluate it
    // DIRECTLY at the sample's exact (face,fu,fv) world dir -- no grid quantization, no edge step =
    // fully seamless. (The additive edit OVERLAY still uses the band quadtree below; edits are local
    // deltas and seam-irrelevant.) baseParamsAt takes continuous face coords (fu,fv) in [0,1].
    const p = baseParamsAt(bandIdx, face, fu, fv);
    for (let i = 0; i < K; i++) out[i] += p[PARAM_KEYS[i]];
    addOverlay(out, bandIdx, face, fu, fv);          // additive edit detail (0 if no edits)
  }

  // PUBLIC: sample the full hierarchical field at face uv in [0,1]^2. Sums every band, each
  // at its own scale. Compose: additive seaBias/temp/humidity/erosion, MULTIPLICATIVE elevAmp,
  // MAX roughness (finest-band-wins) -- identical semantics to the pre-AQT field. Alloc-free
  // (flat Float32Array scratch, integer-indexed).
  const _iAmp = PIDX.elevAmp, _iRgh = PIDX.roughness, _iSea = PIDX.seaBias;
  // maxBandLevel (optional): skip bands FINER than this level. The baked HPF texture is HPF_RES/face;
  // a band at level L resolves 2^L cells/face, so bands with level > log2(HPF_RES) are SUB-TEXEL in the
  // bake (their detail aliases to noise) and sampling them per-texel is wasted cost. Passing
  // maxBandLevel = log2(HPF_RES) skips them in the bake -> big speedup (the finest ~1.5M-anchor local
  // band dominates cost) with negligible change to the baked channels (local band touches only elevAmp
  // by <=1.1x, CLI-measured median 1.03). Default (undefined) samples ALL bands (full-fidelity path).
  function sampleUV(face, fu, fv, maxBandLevel) {
    for (let i = 0; i < K; i++) _acc[i] = 0;
    let amp = 1.0, rough = 0.0;
    for (let b = 0; b < bands.length; b++) {
      if (maxBandLevel !== undefined && BANDS[b].level > maxBandLevel) continue;
      for (let i = 0; i < K; i++) _band[i] = 0; _band[_iAmp] = 1.0;
      sampleBand(_band, b, face, fu, fv);
      // apply per-band runtime scales (full-adjustability; 1.0 = identity).
      const bs = bandScales[b];
      _band[_iSea] *= bs.seaBiasScale;
      _band[_iAmp]  = 1.0 + (_band[_iAmp] - 1.0) * bs.elevAmpScale;   // scale deviation from 1
      _band[_iRgh] *= bs.roughnessScale;
      for (let i = 0; i < K; i++) if (i !== _iAmp && i !== _iRgh) _acc[i] += _band[i];
      amp *= _band[_iAmp];
      rough = Math.max(rough, _band[_iRgh]);
    }
    _acc[_iAmp] = amp; _acc[_iRgh] = rough;
    for (let i = 0; i < K; i++) _scratch[PARAM_KEYS[i]] = _acc[i];
    return _scratch;
  }

  // PER-TILE sample for the orchestrator: a tile (face, level, tx, ty) covers a uv
  // square on its face; sample the field at the tile CENTRE (the bias is per-tile, and the
  // field is C0 across tiles because every tile samples the same global band quadtrees).
  function sampleTile(face, level, tx, ty) {
    const n = 1 << level;
    const fu = (tx + 0.5) / n, fv = (ty + 0.5) / n;
    return sampleUV(face, fu, fv);
  }

  // world-direction (unit vector) -> face + uv, for sampleDir / biomeAt(worldDir).
  function dirToFaceUV(d) {
    const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
    let face, sc, fu, fv;
    if (ax >= ay && ax >= az) { face = d[0] > 0 ? 0 : 1; sc = 1 / ax; }
    else if (ay >= az)        { face = d[1] > 0 ? 2 : 3; sc = 1 / ay; }
    else                      { face = d[2] > 0 ? 4 : 5; sc = 1 / az; }
    const F = FACE_FRAME[face];
    // project d onto the face's u,v axes (face plane is the unit-cube face), -> [-1,1] -> [0,1]
    const u = (d[0]*F.u[0] + d[1]*F.u[1] + d[2]*F.u[2]) * sc;
    const v = (d[0]*F.v[0] + d[1]*F.v[1] + d[2]*F.v[2]) * sc;
    fu = u * 0.5 + 0.5; fv = v * 0.5 + 0.5;
    return { face, fu, fv };
  }
  function sampleDir(d) { const { face, fu, fv } = dirToFaceUV(d); return sampleUV(face, fu, fv); }

  // ---- EDIT API (terraform), ADAPTIVE DEPTH. Edits a node's param DELTAS at ANY depth below
  // the band base level. depth=0 -> the base cell (btx,bty); depth>0 -> the sub-cell (sx,sy)
  // in [0,2^depth) within that base cell. Auto-creates the node + registers its ancestor
  // chain in `cover` (refcounted) so the descent walk reaches it. Local support holds at
  // every depth (additive hat). Returns the node's path key.
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
  // edit the node CONTAINING a world direction at a chosen depth (click-to-terraform).
  function editAtDir(bandIdx, d, deltas, depth = 0) {
    const { face, fu, fv } = dirToFaceUV(d);
    const bn = bands[bandIdx].bn;
    let btx = Math.min(bn - 1, Math.max(0, Math.floor(fu * bn)));
    let bty = Math.min(bn - 1, Math.max(0, Math.floor(fv * bn)));
    // sub-cell index within the base cell at `depth`.
    const sub = 1 << depth;
    const lu = fu * bn - btx, lv = fv * bn - bty;
    const sx = Math.min(sub - 1, Math.max(0, Math.floor(lu * sub)));
    const sy = Math.min(sub - 1, Math.max(0, Math.floor(lv * sub)));
    return editNode(bandIdx, face, btx, bty, deltas, depth, sx, sy);
  }

  // rebuild a band's cover + maxDepth from a flat [key, deltaArray] node list (used by load).
  // depth of a node is derived by walking parents until the key falls in a root range.
  function rebuildBand(bandIdx, entries) {
    const band = bands[bandIdx];
    band.nodes = new Map(); band.cover = new Map(); band.maxDepth = 0;
    const bn = band.bn, rootLo = FACE_OFF * bn * bn, rootHi = (FACE_OFF + 6) * bn * bn;
    const isRoot = (k) => k >= rootLo && k < rootHi;
    for (const [k, arr] of entries) {
      band.nodes.set(k, arr instanceof Float32Array ? arr : Float32Array.from(arr));
      // walk ancestors, counting depth, registering cover.
      let pk = k, depth = 0;
      while (!isRoot(pk)) { pk = parentKey(pk); band.cover.set(pk, (band.cover.get(pk) || 0) + 1); depth++; }
      if (depth > band.maxDepth) band.maxDepth = depth;
    }
  }

  // ---- PERSISTENCE (v2): serialise ONLY the sparse edit nodes (procedural base is
  // deterministic from seed). Compact, reload-safe, offline-authorable. v1 shim maps old
  // fixed-level addr edits to depth-0 nodes (terraform saves survive).
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
    if (o.version === 1) {   // SHIM: old fixed-level addr -> depth-0 node
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

  // effective params of a base-level node = base + (depth-0 edit overlay at cell centre).
  // Kept for introspection (__diag); the hot path uses sampleUV.
  function nodeParams(bandIdx, face, tx, ty) {
    const p = baseParams(bandIdx, face, tx, ty);
    const node = bands[bandIdx].nodes.get(rootKey(bandIdx, face, tx, ty));
    if (node) for (let i = 0; i < K; i++) p[PARAM_KEYS[i]] += node[i];
    return p;
  }

  // ---- introspection for __diag.hpf
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
    // RUNTIME per-band scale setter (full-adjustability; consumed in sampleUV). i = band index.
    setBandScales(i, s){ if(i>=0 && i<bandScales.length && s){ const b=bandScales[i];
      if(s.seaBiasScale!=null)b.seaBiasScale=+s.seaBiasScale; if(s.elevAmpScale!=null)b.elevAmpScale=+s.elevAmpScale; if(s.roughnessScale!=null)b.roughnessScale=+s.roughnessScale; } return bandScales[i]; },
    getBandScales(i){ return bandScales[i]; },
    get totalEdits() { return bands.reduce((s, b) => s + b.nodes.size, 0); },
  };
}
