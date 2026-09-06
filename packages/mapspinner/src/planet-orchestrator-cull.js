// Cube-sphere face math + view-frustum culling for planet-orchestrator.js's initMapspinnerPlanet:
// world<->face-local coordinate conversion (with the atan-inverse LOD-center fix), per-quad screen-AABB
// frustum cull, and hierarchical frustum-plane extraction. Split out as planet-orchestrator.js's largest
// stateless block -- every function here is pure (face index + camera/matrix inputs -> outputs), no
// closure state from initMapspinnerPlanet. See each function's own comment for the coordinate-frame and
// cull-margin rationale (this file has zero GLSL/shader content -- the FXC/ANGLE mis-translation class
// documented in AGENTS.md applies only to terrain.glsl, not this plain-JS math).

const FACE_FRAME = [
  { c: [ 1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }, // +X
  { c: [-1, 0, 0], u: [0, 0,  1], v: [0, 1, 0] }, // -X
  { c: [0,  1, 0], u: [1, 0, 0],  v: [0, 0, -1] }, // +Y
  { c: [0, -1, 0], u: [1, 0, 0],  v: [0, 0,  1] }, // -Y
  { c: [0, 0,  1], u: [1, 0, 0],  v: [0, 1, 0] },  // +Z
  { c: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },  // -Z
];

const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];

// World camera position (meters, sphere centered at origin) -> that face's LOCAL
// plane coords, matching the render's P=(ox,oy,R) convention. The render builds each
// vertex as P = (localX, localY, R) then maps it through localToWorld3 = [U V center].
// So the face-local x is the projection onto U, local y onto V, and local z onto the
// center axis (this is the camera's signed distance along the outward face axis,
// i.e. its altitude component). Units stay in METERS, consistent with ox,oy,l.
// LOD-CENTER FIX (user 2026-06-02, after the moveTol cadence fix did NOT cure it): the quadtree
// ox/oy space is PRE-warp -- the VS maps each vertex through faceWarp(p)=R*tan((p/R)*pi/4)
// (terrain.glsl:490) before placing it on the sphere, and quadtree.js:132 localToDeformed mirrors
// that tan. The plain dot products onto (U,V,center) give the WARPED projection wx=R*tan(s); to get
// the quadtree's PRE-warp coord we must invert the tan: ox = (4/pi)*R*atan(wx/R). WITHOUT the atan,
// the quadtree _cam grew like tan(true_s) -- IDENTITY at the face centre (the only place LOD worked)
// and DIVERGING toward the edges, so the dense LOD trailed the camera ("the camera moves faster than
// the LOD center"). The atan only remaps in-face x,y; the z/center term is the altitude and stays raw.
// Identity at the seam (tan(pi/4)=1, atan(1)=pi/4) so cross-face edges still meet exactly.
// faceWarp forward: q = (R+z)*normalize(R*tan(s_x*pi/4), R*tan(s_y*pi/4), R), s=ox/R. The (R+z)/L
// scalar and L normalization cancel in the RATIO of face-frame components: dot(q,U)/dot(q,center) =
// (R*tan(s_x))/R = tan(s_x). So the pre-warp coord is ox = (4/pi)*R*atan(cu/cc), cu=dot(c,U),
// cc=dot(c,center) -- NOT atan(cu/R) (that ignores the altitude/normalize scalar). cc>0 for any camera
// over this face (it is the front face). z/altitude term stays the raw center projection.
const ATAN_INV_K = 4.0 / Math.PI;   // 1/(pi/4): undo faceWarp's (p/R)*pi/4 scaling
function worldToFaceLocal(face, camWorld, R) {   // R = configured planet radius (== quadtree size / defRadius). SCALE-INVARIANT 2026-06-17: was hardcoded 6360000, which broke the LOD when a consumer (spoint) passed a different radius (camAlt = camDist-6360000 went negative). Now the real R.
  const F = FACE_FRAME[face];
  const cu = dot(camWorld, F.u), cv = dot(camWorld, F.v), cc = dot(camWorld, F.c);
  // GUARD: worldToFaceLocal runs for ALL 6 faces every frame. For a face the camera is NOT in
  // front of, cc<=0 and cu/cc flips sign / blows up -> a garbage _cam that explodes the quadtree
  // recursion (witnessed: 75s frames). The atan inverse is only meaningful on the FRONT hemisphere
  // (cc>0). Off the front face, clamp the ratio to the seam (|s|=pi/4 -> ox=+-R, one face away) so
  // the quad sits at the face edge and the quadtree coarsens it naturally -- the bounded behaviour
  // the OLD plain-dot code had. ccSafe floors the denominator so a near-limb camera can't blow up.
  const SEAM = R;                              // ox at the face edge (s=+-1)
  let ox, oy;
  if (cc > 1.0) {                              // camera in front of this face (cc up to ~R+alt)
    ox = ATAN_INV_K * R * Math.atan(cu / cc);
    oy = ATAN_INV_K * R * Math.atan(cv / cc);
  } else {                                     // back/side face: push to the edge, sign-preserving
    ox = (cu >= 0 ? SEAM : -SEAM);
    oy = (cv >= 0 ? SEAM : -SEAM);
  }
  return [ox, oy, cc];
}

// Conservative view-frustum cull: returns true ONLY if every sample point of the quad's
// deformed shell (4 corners x [R-MAX_ELEV, R+MAX_ELEV]) is beyond the SAME clip plane
// (all left / all right / all up / all down / all far). Never tests near/z<-w, so a quad
// straddling the near/limb is kept. This can't remove a quad touching the screen (such a
// quad has >=1 corner inside every plane's half-space). vpr = the SAME viewProjRel the
// render uses (render.cullMatrix), fed ABSOLUTE world coords (vpr folds translate(-eye)).
const CULL_MAX_ELEV = 500000.0;  // meters: +/- elevation margin so peaks can't poke in (Earth-reference; the cull uses R*CULL_ELEV_FRAC so it scales with the planet); raised to match 750000 height multiplier x 0.6 peak
const CULL_ELEV_FRAC = CULL_MAX_ELEV / 6360000.0;   // SCALE-INVARIANT: the elevation margin as a FRACTION of R, so R*CULL_ELEV_FRAC == 12km at Earth R and 120m at the 63.6km real-size R (else the cull margin is relatively 100x too big at the small scale -> looser cull -> more quads)
const CULL_NDC_MARGIN = 0.06;   // NDC slack so an edge-touching quad is kept (false-keep is cheap)
// Robust screen-space-AABB frustum cull. The old 4-CORNER "all corners past one plane" test could not
// bound a spherically-bulged + tangent-warped quad's true screen extent at oblique views -- the bulge
// is maximal at the EDGE MIDPOINTS, which 4 corners miss entirely, so on-screen quads got false-culled
// (the user hit a missing-quad hole at nearly every oblique angle; margin-tuning never converged). This
// version samples a 3x3 grid (corners + edge mids + centre) at BOTH elevation shells, projects each the
// SAME way the VS does (tangent-warp px->R*tan(px/R*pi/4) + camera-relative eye-subtract in fp64), and
// builds the quad's NDC bounding box from the IN-FRONT samples. A quad is culled ONLY if that box lies
// entirely beyond one viewport edge ([-1,1] +/- a small margin) OR every sample is behind the near plane.
// AABB-vs-viewport is the correct screen-overlap test; the edge-mid samples capture the bulge the corners
// don't, so an on-screen quad's box always overlaps the viewport and is kept.
function quadOutsideFrustum(face, ox, oy, l, R, vpr, eye) {
  const F = FACE_FRAME[face];
  const ex = eye ? eye[0] : 0, ey = eye ? eye[1] : 0, ez = eye ? eye[2] : 0;
  const WK = Math.PI / 4.0;
  const hl = l * 0.5;
  // 3x3 face-local sample grid: corners, edge midpoints, centre.
  const sx = [ox, ox+hl, ox+l], sy = [oy, oy+hl, oy+l];
  let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity, anyFront=false, anyBehind=false, allBeyondFar=true;
  for (let gx=0; gx<3; gx++) for (let gy=0; gy<3; gy++) {
    const wpx = R * Math.tan((sx[gx] / R) * WK);
    const wpy = R * Math.tan((sy[gy] / R) * WK);
    const len = Math.hypot(wpx, wpy, R) || 1;
    const dx = (wpx/len)*F.u[0]+(wpy/len)*F.v[0]+(R/len)*F.c[0];
    const dy = (wpx/len)*F.u[1]+(wpy/len)*F.v[1]+(R/len)*F.c[1];
    const dz = (wpx/len)*F.u[2]+(wpy/len)*F.v[2]+(R/len)*F.c[2];
    for (let s=0;s<2;s++){
      const rad = s===0 ? (R*(1.0-CULL_ELEV_FRAC)) : (R*(1.0+CULL_ELEV_FRAC));   // SCALE-INVARIANT margin (R*FRAC == CULL_MAX_ELEV at Earth R)
      const X=dx*rad-ex, Y=dy*rad-ey, Z=dz*rad-ez;
      const cx = vpr[0]*X+vpr[4]*Y+vpr[8]*Z+vpr[12];
      const cy = vpr[1]*X+vpr[5]*Y+vpr[9]*Z+vpr[13];
      const cz = vpr[2]*X+vpr[6]*Y+vpr[10]*Z+vpr[14];
      const cw = vpr[3]*X+vpr[7]*Y+vpr[11]*Z+vpr[15];
      if (cw <= 1e-6) { anyBehind = true; continue; } // behind near plane: can't project to a finite NDC
      anyFront = true;
      if (cz <= cw) allBeyondFar = false; // at least one sample in front of the far plane
      const nx = cx/cw, ny = cy/cw;
      if (nx < minX) minX = nx; if (nx > maxX) maxX = nx;
      if (ny < minY) minY = ny; if (ny > maxY) maxY = ny;
    }
  }
  if (!anyFront) return true;             // entire quad behind the camera -> cull
  // STRADDLES the near plane (some samples in front, some behind): the projected NDC AABB is only
  // PARTIAL (the behind-near samples have no finite projection), so it cannot prove off-screen --
  // a near-straddling quad is almost always on-screen. KEEP it (this was the over-cull at oblique
  // low-alt: the far edge dipped behind the near plane, the AABB shrank to the near edge, and the
  // quad got wrongly culled -> blank). Only quads FULLY in front get the AABB-vs-viewport test.
  if (anyBehind) return false;
  if (allBeyondFar) return true;          // entire quad beyond the far plane -> cull
  const M = CULL_NDC_MARGIN;
  // cull only if the NDC AABB is fully off one side of the viewport.
  return (maxX < -1 - M) || (minX > 1 + M) || (maxY < -1 - M) || (minY > 1 + M);
}

// Extract the 6 normalized frustum planes (Gribb-Hartmann) from a COLUMN-MAJOR clip-from-cameraRelative
// matrix (proj * viewRotation; the translate(-eye) is folded out via the manual eye-subtract, exactly as
// quadOutsideFrustum feeds vpr). Plane[i] = [a,b,c,d], `inside` half-space a*x+b*y+c*z+d >= 0 for a
// camera-relative point (x,y,z). Writes 6*4 floats into `out`. Feeds the quadtree's hierarchical cull
// (quadtree.nodeOutsideFrustum) -- the BVH-style subtree prune derived from batched-mesh-extensions.
function extractFrustumPlanes(m, out) {
  const r0x=m[0], r0y=m[4], r0z=m[8],  r0w=m[12];   // x-row
  const r1x=m[1], r1y=m[5], r1z=m[9],  r1w=m[13];   // y-row
  const r2x=m[2], r2y=m[6], r2z=m[10], r2w=m[14];   // z-row
  const r3x=m[3], r3y=m[7], r3z=m[11], r3w=m[15];   // w-row
  // The 4 SIDE planes are WIDENED by CULL_NDC_MARGIN (the same 0.06-NDC slack quadOutsideFrustum keeps
  // an edge-touching quad with). Combining row_x with W*row_w gives the plane x >= -(1+M)*w, so the
  // hierarchical prune never removes a near-edge leaf the per-leaf test would keep -> identical leaf set
  // (node A/B verified). Near + far stay un-margined (near is handled specially; far matches NDC z<=1).
  const W = 1.0 + CULL_NDC_MARGIN;
  _setPlane(out, 0, W*r3x+r0x, W*r3y+r0y, W*r3z+r0z, W*r3w+r0w);  // left
  _setPlane(out, 1, W*r3x-r0x, W*r3y-r0y, W*r3z-r0z, W*r3w-r0w);  // right
  _setPlane(out, 2, W*r3x+r1x, W*r3y+r1y, W*r3z+r1z, W*r3w+r1w);  // bottom
  _setPlane(out, 3, W*r3x-r1x, W*r3y-r1y, W*r3z-r1z, W*r3w-r1w);  // top
  _setPlane(out, 4,   r3x+r2x,   r3y+r2y,   r3z+r2z,   r3w+r2w);  // near
  _setPlane(out, 5,   r3x-r2x,   r3y-r2y,   r3z-r2z,   r3w-r2w);  // far
}
function _setPlane(out, i, a, b, c, d) {
  const len = Math.hypot(a, b, c) || 1, o = i * 4;
  out[o] = a/len; out[o+1] = b/len; out[o+2] = c/len; out[o+3] = d/len;
}

// Pick the cube face the camera is most directly over (largest dot of camDir with
// the face's outward center axis).
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
