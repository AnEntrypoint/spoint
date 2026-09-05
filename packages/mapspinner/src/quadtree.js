// quadtree.js -- the cube-face terrain quadtree LOD selection.
// terrain shape is the single GPU fractal (fractalTerrainH in terrain.glsl), evaluated per-vertex.
//
// Pure JS, no allocation per frame beyond the leaf array. One Quadtree instance per
// run; call setConfig once, computeSplitDist when viewport/fov change, updateQuadtree per frame
// with the camera in LOCAL (undeformed cube-face) space -> returns leaf quads [{level,tx,ty,ox,oy,l}].

const TAN_40DEG = Math.tan(40.0 / 180.0 * Math.PI);

export class Quadtree {
  constructor(size) {
    this.size = size || 6360000.0;   // root half-extent / planet radius (m). SCALE-INVARIANT: planet-orchestrator passes the configured R; was hardcoded 6360000 -> small-radius consumers got a broken (camAlt-negative) LOD mesh.
    this.maxLevel = 20;
    this.splitDist = 1.1;      // computed from splitFactor+viewport+fov
    this.distFactor = 2.0;     // altitude weighting
    this._cam = [0, 0, 0];     // camera in LOCAL (undeformed) space (aim-shifted LOD reference)
    this._camAlt = 0.0;        // true altitude above the sphere (|localCam|-R), same on every face
    this._nadir = [0, 0];      // TRUE camera nadir (face-local x,y) for the far-LOD foreground protect
    this._aim = null;          // AIM ground point (face-local x,y), 2nd foreground-protect center (or null)
    this._aimArr = [0, 0];     // reused per-frame backing for _aim (no per-frame [aimX,aimY] alloc)
    this._leaves = [];         // PERSISTENT leaf-object POOL (see updateQuadtree): reused across frames,
    this._n = 0;               //   filled by index up to _n then truncated -> zero steady-state allocation
    this._cull = null;         // optional hierarchical-cull context (see nodeOutsideFrustum); null = no pruning
    this._dz = 0.0;            // per-traversal constants derived once in updateQuadtree (see there):
    this._near = 0.0;          //   altitude split term, penalty-free near radius,
    this._floor = 0.6;         //   and the far-coarsening floor. Declared here so the shape is fixed.
  }

  setConfig(size, maxLevel, distFactor) {
    this.size = size; this.maxLevel = maxLevel; this.distFactor = distFactor;
  }

  // splitDist = splitFactor * viewportH/1024 * tan(40deg)/tan(fov/2), clamped >= 1.1.
  // TAN_40DEG is a compile-time constant (Math.tan(40*PI/180)); const-folded once at module load
  // instead of recomputed on every call (this runs once per viewport/fov change, not per frame, but
  // the recompute was still pure waste -- tan(40deg) never varies).
  computeSplitDist(splitFactor, viewportH, fovRad) {
    let sd = splitFactor * viewportH / 1024.0 * TAN_40DEG / Math.tan(fovRad / 2.0);
    if (!(sd >= 1.1) || !isFinite(sd)) sd = 1.1;
    this.splitDist = sd;
    return sd;
  }

  // TerrainNode::getCameraDist: local-space max-distance metric. The altitude term uses the TRUE
  // camera altitude above the sphere (same on every face -> adjacent faces subdivide by real
  // proximity, the fix for the turn-around-unpatched bug).
  _cameraDist(ox, oy, l) {
    const dz = this._dz;   // per-traversal constant (max(camAlt/distFactor,0)), hoisted into updateQuadtree
    const dx = Math.min(Math.abs(this._cam[0] - ox), Math.abs(this._cam[0] - (ox + l)));
    const dy = Math.min(Math.abs(this._cam[1] - oy), Math.abs(this._cam[1] - (oy + l)));
    return Math.max(dz, Math.max(dx, dy));
  }

  // TerrainQuad subdivision: subdivide while dist < l*splitDist AND level < maxLevel; emit leaves.
  // DISTANCE FALLOFF (user 2026-06-01j: 'when close to terrain, far-away quads should LOD better').
  // The plain dist<l*splitDist gives constant screen-space leaf size (leaf ~ dist/splitDist), so when
  // the camera is LOW the horizon-distant terrain still subdivides fine = wasted quads. Tighten the
  // effective splitDist with the quad's LATERAL distance from the camera: far quads need to be much
  // bigger to keep splitting, so distant terrain stays coarse while the near/under-camera stays fine.
  // Falloff scaled by altitude so high views (where 'far' is the whole visible disc) are unaffected.
  _recurse(level, tx, ty, ox, oy, l) {
    // HIERARCHICAL FRUSTUM CULL (derived from agargaro/batched-mesh-extensions' dynamic-BVH frustum
    // cull -- the ALGORITHM, reimplemented for this cube-sphere quadtree, NOT imported). Reject a whole
    // off-screen SUBTREE at the internal node with ONE conservative bounding-sphere-vs-6-planes test,
    // instead of letting the orchestrator run its 18-projection per-leaf quadOutsideFrustum on every
    // descendant leaf. CONSERVATIVE (the node sphere encloses each descendant leaf's R+/-CULL_MAX_ELEV
    // shell), so a pruned node's leaves would ALL have failed the leaf frustum test anyway -> the
    // surviving (drawn) leaf set is IDENTICAL = zero visual change. Gated level>=2 to match the leaf
    // cull's gate (coarse roots always kept -> no whole-face blank from an off-by-one in the bounds).
    if (this._cull !== null && level >= 2 && nodeOutsideFrustum(this._cull, ox, oy, l)) return;
    const dist = this._cameraDist(ox, oy, l);
    // DISTANCE FALLOFF: coarsen far quads when low. Use the lateral distance to the quad CENTER
    // (NOT its nearest edge -- a big near quad has a far edge, which must NOT penalize it, or the
    // root never splits). Only quads whose CENTRE sits well beyond the near footprint coarsen.
    const cxv = ox + l * 0.5, cyv = oy + l * 0.5;
    // latC = lateral distance from the TRUE camera NADIR (this._nadir), NOT the aim-shifted LOD ref.
    // This decouples foreground-protection from the aim-shift: the foreground (near the true nadir)
    // always has latC~0 -> fall=1.0 -> full LOD, no matter how low the floor. So a LOW floor can
    // reduce the far horizon hard WITHOUT collapsing nearby terrain (user: 'nearby reduced all the
    // way when going to land' was the aim-shifted ref penalizing the foreground).
    // latC = lateral distance from the nadir to the quad's NEAREST POINT (clamp nadir into the quad's
    // [ox,ox+l]x[oy,oy+l] extent), NOT its CENTER. THE CENTER WAS THE BUG (user 2026-06-02: 'dense LOD
    // off to the side, not under the camera; moving toward a face edge it wraps'): a LARGE quad that
    // CONTAINS the camera has its center offset by up to l/2, so a center-distance falloff penalized
    // the camera's own containing quads and they never subdivided -- the only fine quads landed where a
    // quad CENTER happened to align with nadir (off toward the face centre). Nearest-point distance is
    // ~0 for any quad containing the nadir, so the footprint refines UNDER the camera at any face pos.
    const nx0 = Math.max(ox, Math.min(this._nadir[0], ox + l));
    const ny0 = Math.max(oy, Math.min(this._nadir[1], oy + l));
    let latC = Math.max(Math.abs(this._nadir[0] - nx0), Math.abs(this._nadir[1] - ny0));
    // Protect the foreground around the AIM ground point too (the pitched-down bottom-of-screen band):
    // nearest-point distance to the aim box as well; take the NEARER so a quad close to EITHER is fine.
    if (this._aim !== null) {
      const ax0 = Math.max(ox, Math.min(this._aim[0], ox + l));
      const ay0 = Math.max(oy, Math.min(this._aim[1], oy + l));
      const latA = Math.max(Math.abs(this._aim[0] - ax0), Math.abs(this._aim[1] - ay0));
      if (latA < latC) latC = latA;
    }
    // near = the penalty-free radius around the foreground; it and its `horizon` input are pure
    // functions of _camAlt + size, both FIXED for the whole traversal -- they were recomputed (incl. a
    // Math.sqrt) at every visited node. Derived once per updateQuadtree; see the rationale there.
    const near = this._near;
    const fall = 1.0 / (1.0 + Math.max(0.0, latC - near) / near);
    // ALTITUDE-DETAIL-GRADIENT-SWAP far-coarsening floor: also a pure function of _camAlt, so its
    // Math.log2 ran once per visited node for one value per traversal. Hoisted; see updateQuadtree.
    const floor = this._floor;
    const effSplit = this.splitDist * Math.max(floor, fall);
    if (dist < l * effSplit && level < this.maxLevel) {
      const hl = l / 2.0;
      this._recurse(level + 1, 2 * tx,     2 * ty,     ox,      oy,      hl);
      this._recurse(level + 1, 2 * tx + 1, 2 * ty,     ox + hl, oy,      hl);
      this._recurse(level + 1, 2 * tx,     2 * ty + 1, ox,      oy + hl, hl);
      this._recurse(level + 1, 2 * tx + 1, 2 * ty + 1, ox + hl, oy + hl, hl);
    } else {
      // GEOMORPHING LOD: see gl-render.js/terrain.glsl for the actual blend. Deliberately NOT computed
      // here as a per-quad JS value (a first attempt at that -- per-leaf morph derived from THIS quad's
      // own `dist` vs its own `effSplit` threshold -- was proven, by direct construction, to crack: two
      // same-level sibling leaves legitimately have different `dist`/`effSplit` ratios (that is the
      // entire point of the per-quad lateral-clamp distance metric above -- it is what differentiates
      // "about to split" from "comfortably fine" across one LOD ring), so a per-quad morph value is
      // fundamentally neighbor-INCONSISTENT: two leaves sharing an edge can be told to blend their
      // shared boundary vertices by different amounts, opening a real lateral gap (measured up to
      // several metres at a maxLevel boundary; broader once the band is widened enough to actually
      // engage). The watertight fix computes morph PER-VERTEX in the shader from that vertex's own
      // world-space distance to the camera against a level-keyed (not quad-keyed) detail range built
      // from the same splitDist/distFactor this class already exposes as public fields -- two adjacent
      // same-level leaves' SHARED boundary vertex has one world position and one level, so both sides
      // evaluate the identical formula and get the identical morph, crack-free by construction (not by
      // sweep-verified coincidence). See terrain.glsl's iMorph computation.
      const i = this._n++;
      let o = this._leaves[i];
      if (o === undefined) o = this._leaves[i] = { level: 0, tx: 0, ty: 0, ox: 0, oy: 0, l: 0 };
      o.level = level; o.tx = tx; o.ty = ty; o.ox = ox; o.oy = oy; o.l = l;
    }
  }

  // Run the quadtree for the current camera (LOCAL cube-face coords); returns the leaf-quad array.
  // The root quad spans [-size, size] in x and y (one cube face).
  // camX/Y/Z = the (aim-shifted) LOD reference; nadirX/nadirY (optional) = the TRUE camera nadir in
  // face-local coords, used by the far-LOD falloff to protect the real foreground (decoupled from the
  // aim-shift). Defaults to the LOD ref's x,y when not supplied (back-compat). aimX/aimY (optional) =
  // the look ray's ground-hit in face-local coords; a SECOND foreground-protect center so the
  // pitched-down bottom-of-screen band stays full-LOD in every azimuth (null/omitted -> nadir only).
  updateQuadtree(camX, camY, camZ, nadirX, nadirY, aimX, aimY, camAlt, cull) {
    this._cam[0] = camX; this._cam[1] = camY; this._cam[2] = camZ;
    // TRUE ALTITUDE (fix off-center LOD stall, user 2026-06-03 'LOD dense only at the start point').
    // camX,camY are the atan-WARPED face-local lateral coords (from worldToFaceLocal); off the face
    // centre they are large (up to ~R near the edge), so sqrt(camX^2+camY^2+camZ^2) hugely
    // OVERESTIMATES altitude -> the altitude term dominates the split metric -> LOD stalls everywhere
    // but the face centre (where camX=camY=0 makes the hypot correct). Use the caller's TRUE altitude
    // (|camWorld|-R) when supplied; fall back to the old hypot only for back-compat.
    this._camAlt = (camAlt !== undefined && camAlt !== null)
      ? camAlt
      : Math.sqrt(camX * camX + camY * camY + camZ * camZ) - this.size;
    this._nadir[0] = (nadirX !== undefined) ? nadirX : camX;
    this._nadir[1] = (nadirY !== undefined) ? nadirY : camY;
    // reuse _aimArr (no per-frame allocation); preserve the null = "no aim" semantics _recurse tests.
    if (aimX !== undefined && aimY !== undefined) { this._aimArr[0] = aimX; this._aimArr[1] = aimY; this._aim = this._aimArr; }
    else this._aim = null;
    this._n = 0;
    this._cull = (cull != null) ? cull : null;   // per-frame frustum-cull context, or null (cull off)
    // PER-TRAVERSAL CONSTANTS (opt): _dz/_near/_floor depend only on _camAlt, size and distFactor --
    // all three are fixed before _recurse starts and nothing in the recursion mutates them, so the
    // sqrt (horizon), log2 (altLog) and divide (dz) that _recurse ran at EVERY visited node collapse
    // to one evaluation per traversal. Values and therefore the emitted leaf set are unchanged.
    this._dz = Math.max(this._camAlt / this.distFactor, 0.0);
    // horizon: the on-screen field reaches ~sqrt(2*R*alt); `near` protects it from the far-LOD falloff.
    const _horizon = Math.sqrt(2.0 * this.size * Math.max(this._camAlt, 0.0));
    // W2 near-radius tighten (mob-w2, unconditional): max(camAlt*2, horizon*0.2, 10km scaled by size).
    this._near = Math.max(this._camAlt * 2.0, _horizon * 0.2, 10000.0 * (this.size / 6360000.0));
    // floor starts at 0.60 at the deck and drops logarithmically with altitude toward 0.30 at orbit,
    // so the far-coarsening engages progressively at every altitude (no one-step jump at ~45km).
    const _altLog = Math.log2(Math.max(this._camAlt, 5000.0) / 5000.0);
    this._floor = Math.max(0.30, Math.min(0.60, 0.60 - _altLog * 0.05));
    this._recurse(0, 0, 0, -this.size, -this.size, 2.0 * this.size);
    this._leaves.length = this._n;   // expose exactly the filled prefix; tail (rare peak shrink) is dropped
    return this._leaves;
  }
}

// SphericalDeformation::localToDeformed with the tangent-adjusted (equal-area-ish) cube->sphere
// remap: warp the normalized face coord s=x/R by tan(s*pi/4) before the radial projection so cell
// area is near-uniform (seam-safe: identity at s=+-1). MUST match terrain.glsl faceWarp + the VS.
// q = (R+z) * normalize(R*tan(x/R*pi/4), R*tan(y/R*pi/4), R).
export function localToDeformed(x, y, z, R) {
  const k = Math.PI / 4.0;
  const wx = R * Math.tan((x / R) * k);
  const wy = R * Math.tan((y / R) * k);
  const inv = (z + R) / Math.sqrt(wx * wx + wy * wy + R * R);
  return [wx * inv, wy * inv, R * inv];
}

// CONSERVATIVE node-vs-frustum test for the hierarchical cull in _recurse. `cull` is a context the
// orchestrator fills once per frame + per face (reused, alloc-free):
//   { planes:Float64Array(24)  -- 6 normalized camera-RELATIVE frustum planes [a,b,c,d] (eye at origin),
//     ex,ey,ez                 -- eye (world), to make the sphere center camera-relative,
//     ux,uy,uz, vx,vy,vz, cx,cy,cz  -- THIS face's U,V,center orthonormal axes (FACE_FRAME[face]),
//     R, maxElev }             -- planet radius + the same +/- elevation margin the leaf cull uses.
// Builds the node's world bounding sphere from its 4 tan-warped corners at the R+maxElev shell -- the
// corners are the angular EXTREMES of the patch, so in 3D they bound every interior/edge surface point
// (the screen-space edge-midpoint bulge that the leaf test's 3x3 grid guards against is a 2D-NDC issue,
// not a 3D bounding-sphere one) -- plus a maxElev blanket for the inner (R-maxElev) shell. Rejects only
// if the sphere lies fully outside one plane (signedDist < -radius). Over-estimating the radius only
// ever KEEPS more (never over-culls), so the leaf set is preserved by construction.
function nodeOutsideFrustum(cull, ox, oy, l) {
  const R = cull.R, WK = Math.PI / 4.0, ME = cull.maxElev;
  const ux = cull.ux, uy = cull.uy, uz = cull.uz, vx = cull.vx, vy = cull.vy, vz = cull.vz, cx = cull.cx, cy = cull.cy, cz = cull.cz;
  const rr = R + ME;
  // The 4 corners share only TWO distinct x-warps and TWO y-warps, so the exact bounding sphere costs
  // 6 tan (4 edges + the 2 center warps), not 10. Corners are the angular extremes of the patch, so on
  // a convex sphere they bound every interior/edge surface point in 3D (the edge-midpoint bulge the leaf
  // test's 3x3 grid guards against is a 2D-NDC concern, not a 3D one). radius = farthest corner at the
  // R+ME shell + an ME blanket for the inner (R-ME) shell -> encloses ALL descendant leaf geometry.
  const tX0 = R * Math.tan((ox / R) * WK), tX1 = R * Math.tan(((ox + l) / R) * WK);
  const tY0 = R * Math.tan((oy / R) * WK), tY1 = R * Math.tan(((oy + l) / R) * WK);
  // node-center world direction (same tan-warp + face frame as the VS and quadOutsideFrustum)
  const cwX = R * Math.tan(((ox + l * 0.5) / R) * WK), cwY = R * Math.tan(((oy + l * 0.5) / R) * WK);
  let ax = cwX * ux + cwY * vx + R * cx, ay = cwX * uy + cwY * vy + R * cy, az = cwX * uz + cwY * vz + R * cz;
  // OPTIMIZATION (ms-hypot-to-sqrt): magnitudes here are world-meter direction vectors bounded by
  // ~R (planet radius, far below float overflow range) -- Math.hypot's overflow/underflow guard is
  // unneeded overhead per node visited; a direct sqrt-of-sum-of-squares is exact and faster.
  let ln = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
  const C0x = (ax / ln) * R, C0y = (ay / ln) * R, C0z = (az / ln) * R;   // sphere center (sea-level surface)
  let maxR2 = 0;
  for (let ci = 0; ci < 4; ci++) {
    const wx = (ci & 1) ? tX1 : tX0, wy = (ci & 2) ? tY1 : tY0;
    ax = wx * ux + wy * vx + R * cx; ay = wx * uy + wy * vy + R * cy; az = wx * uz + wy * vz + R * cz;
    ln = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    const dx = (ax / ln) * rr - C0x, dy = (ay / ln) * rr - C0y, dz = (az / ln) * rr - C0z;
    const d2 = dx * dx + dy * dy + dz * dz; if (d2 > maxR2) maxR2 = d2;
  }
  const radius = Math.sqrt(maxR2) + ME;
  // bounding-sphere center relative to the eye (the planes live in camera-relative space)
  const Cx = C0x - cull.ex, Cy = C0y - cull.ey, Cz = C0z - cull.ez;
  const P = cull.planes;   // 6 planes, index 0=left 1=right 2=bottom 3=top 4=near 5=far
  // NEAR plane FIRST, mirroring quadOutsideFrustum's near handling EXACTLY so the surviving leaf set
  // is byte-identical (verified by node A/B). quadOutsideFrustum KEEPS any quad straddling the near
  // plane (its NDC AABB is only partial there, so off-screen is unprovable) and only culls quads fully
  // in front (tested vs the sides) or fully behind the camera. A node sphere straddling near must
  // therefore NOT be pruned -- defer to the per-leaf test. This is the load-bearing oblique-low-alt
  // no-blank invariant (the recurring over-cull class the renderer comments warn about).
  const nearSD = P[16] * Cx + P[17] * Cy + P[18] * Cz + P[19];
  if (nearSD <= -radius) return true;    // sphere fully behind the camera -> cull (matches !anyFront)
  if (nearSD < radius) return false;     // straddles the near plane -> KEEP (matches the near-straddle keep)
  // fully in front of near: prune iff the sphere is fully outside a side or far plane.
  if (P[0]  * Cx + P[1]  * Cy + P[2]  * Cz + P[3]  < -radius) return true;  // left
  if (P[4]  * Cx + P[5]  * Cy + P[6]  * Cz + P[7]  < -radius) return true;  // right
  if (P[8]  * Cx + P[9]  * Cy + P[10] * Cz + P[11] < -radius) return true;  // bottom
  if (P[12] * Cx + P[13] * Cy + P[14] * Cz + P[15] < -radius) return true;  // top
  if (P[20] * Cx + P[21] * Cy + P[22] * Cz + P[23] < -radius) return true;  // far
  return false;
}
