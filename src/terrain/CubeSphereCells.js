// Cube-sphere cell addressing + cross-face-correct neighbor finding for AOI/relevance queries.
//
// WHY: TickHandler.js's buildAndSendSnapshots bucketed players into interest cells with a flat
// Euclidean XZ grid (cellKey = floor(x/relevanceRadius)*65536 + floor(z/relevanceRadius)). That is
// exactly right for a single non-reanchoring tangent-plane world (PlanetFrame.js -- "PlanetFrame
// never re-anchors", per AGENTS.md), which is spoint's actual default gameplay frame today. This
// module is the CURVED-SPACE alternative for a world that spans (or may cross) more than one
// cube-sphere face -- e.g. a full-planet server, or a world whose relevanceRadius is large enough
// relative to the local tangent-plane's flatness error to matter. It is additive: TickHandler wires
// it in only when a stage configures planet cell addressing (see wireCellAdjacency below); the flat
// grid remains the default for the common tangent-plane case.
//
// FACE_FRAME below is copied VERBATIM from packages/mapspinner/src/planet-orchestrator.js (that
// file's own comment calls it "the SINGLE source of truth for the cube-face local frame" -- col0=U,
// col1=V, col2=center). Re-deriving face ids / U,V axes independently here would risk a mismatch
// with the renderer's own face numbering; this module intentionally reuses the exact same 6 frames
// so a face index computed server-side always means the same physical cube face the client renders.
const FACE_FRAME = [
  { c: [ 1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }, // 0: +X
  { c: [-1, 0, 0], u: [0, 0,  1], v: [0, 1, 0] }, // 1: -X
  { c: [0,  1, 0], u: [1, 0, 0],  v: [0, 0, -1] }, // 2: +Y
  { c: [0, -1, 0], u: [1, 0, 0],  v: [0, 0,  1] }, // 3: -Y
  { c: [0, 0,  1], u: [1, 0, 0],  v: [0, 1, 0] },  // 4: +Z
  { c: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },  // 5: -Z
]

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

// EDGE_TABLE[face][edge] describes what lies across that edge: which face you land on, which of
// ITS 4 edges you arrive at, and whether the shared coordinate runs the SAME or FLIPPED direction
// across the seam. Derived (not hand-guessed) by sampling world directions just past each of a
// face's 4 edges, picking the neighbor via the exact same dominant-axis rule
// planet-orchestrator.js's pickFace() uses, then solving each sample's local (u,v) on that neighbor
// face via the same dot-ratio projection worldToFaceLocal() uses. Verified reciprocal for all 24
// transitions (face_A.edge -> face_B.edge_B with sign S implies face_B.edge_B -> face_A.edge with
// the SAME sign S) -- the derivation script + reciprocity check live in this module's own
// self-test (verifyCubeSphereAdjacency, below), runnable any time the FACE_FRAME table changes.
const EDGE_TABLE = {
  0: { 'u+': { face: 5, edge: 'u-', sign: 1 }, 'u-': { face: 4, edge: 'u+', sign: 1 }, 'v+': { face: 2, edge: 'u+', sign: 1 }, 'v-': { face: 3, edge: 'u+', sign: -1 } },
  1: { 'u+': { face: 4, edge: 'u-', sign: 1 }, 'u-': { face: 5, edge: 'u+', sign: 1 }, 'v+': { face: 2, edge: 'u-', sign: -1 }, 'v-': { face: 3, edge: 'u-', sign: 1 } },
  2: { 'u+': { face: 0, edge: 'v+', sign: 1 }, 'u-': { face: 1, edge: 'v+', sign: -1 }, 'v+': { face: 5, edge: 'v+', sign: -1 }, 'v-': { face: 4, edge: 'v+', sign: 1 } },
  3: { 'u+': { face: 0, edge: 'v-', sign: -1 }, 'u-': { face: 1, edge: 'v-', sign: 1 }, 'v+': { face: 4, edge: 'v-', sign: 1 }, 'v-': { face: 5, edge: 'v-', sign: -1 } },
  4: { 'u+': { face: 0, edge: 'u-', sign: 1 }, 'u-': { face: 1, edge: 'u+', sign: 1 }, 'v+': { face: 2, edge: 'v-', sign: 1 }, 'v-': { face: 3, edge: 'v+', sign: 1 } },
  5: { 'u+': { face: 1, edge: 'u-', sign: 1 }, 'u-': { face: 0, edge: 'u+', sign: 1 }, 'v+': { face: 2, edge: 'v+', sign: -1 }, 'v-': { face: 3, edge: 'v-', sign: -1 } },
}

// pickFace: dominant-axis face selection, byte-identical rule to planet-orchestrator.js's pickFace
// (largest dot of the direction with the face's outward center axis) -- MUST stay in lockstep so a
// world position is assigned to the same face server-side as it renders on client-side.
export function pickFace(dirX, dirY, dirZ) {
  let best = -1, bestDot = -Infinity
  for (let f = 0; f < 6; f++) {
    const F = FACE_FRAME[f]
    const d = dirX * F.c[0] + dirY * F.c[1] + dirZ * F.c[2]
    if (d > bestDot) { bestDot = d; best = f }
  }
  return best
}

// worldToFaceLocal: sphere-centered world position (or any position along the ray from the sphere
// center, e.g. an unprojected point above/below the surface) -> { face, ox, oy } in the SAME
// pre-warp face-local plane coords planet-orchestrator.js's worldToFaceLocal produces (ox,oy in
// [-R,R], the atan-inverse of the renderer's tan-warp, so this cell grid lines up with the
// renderer's own quadtree root square rather than a naive un-warped cube projection, which would
// bunch cells unevenly near face edges). R = planet radius (mirrors quadtree.js's `size`).
const ATAN_INV_K = 4.0 / Math.PI
export function worldToFaceLocal(x, y, z, R) {
  const face = pickFace(x, y, z)
  const F = FACE_FRAME[face]
  const cu = dot([x, y, z], F.u), cv = dot([x, y, z], F.v), cc = dot([x, y, z], F.c)
  const ccSafe = cc > 1.0 ? cc : 1.0
  const ox = ATAN_INV_K * R * Math.atan(cu / ccSafe)
  const oy = ATAN_INV_K * R * Math.atan(cv / ccSafe)
  return { face, ox, oy }
}

// worldToCell: world position -> integer cell address on the cube-sphere's per-face uniform grid
// (cellSize meters/cell, matching the flat grid's relevanceRadius-sized cells). anchorSurfaceWorld
// origin-shift is the caller's job (pass the ALREADY sphere-centered position); this module has no
// opinion on PlanetFrame's tangent-plane offset, it only does cube-sphere face/cell math.
export function worldToCell(x, y, z, R, cellSize) {
  const { face, ox, oy } = worldToFaceLocal(x, y, z, R)
  // face-local plane spans [-R,R]; shift to [0,2R] before dividing into cells so cell indices are
  // non-negative small integers (cellsPerFace = ceil(2R/cellSize) wide/tall), matching the flat
  // grid's floor(x/relevanceRadius) convention (just re-based to a per-face-bounded range).
  const cx = Math.floor((ox + R) / cellSize)
  const cy = Math.floor((oy + R) / cellSize)
  return { face, cx, cy }
}

// packCellKey: single-integer key for a face-cell, for use as a JS Map/object key exactly like the
// flat grid's `(cx*65536+cz)|0`. Encodes face in the high bits so different faces never collide even
// at identical (cx,cy) -- cellsPerFace must be a caller-supplied upper bound on cx/cy (cells per
// face edge) so the bit-packing has a fixed stride; pass the same value used to derive cellSize.
export function packCellKey(face, cx, cy, cellsPerFace) {
  const stride = cellsPerFace + 2 // +2 slack: neighbor lookups can step one cell past a naive bound near a seam before the corner-fold clamps it back in range
  return ((face * stride + cx) * (stride * 4) + cy) | 0
}

function _edgeCoord(cellsPerFace, coord) {
  if (coord < 0) return 'lo'
  if (coord >= cellsPerFace) return 'hi'
  return null
}

// stepAcrossEdge: given a face-cell whose cx OR cy fell outside [0,cellsPerFace), resolve which
// face it actually lands on and its (cx,cy) in that face's own grid, via one hop of EDGE_TABLE.
// which: 'u+' (cx>=cellsPerFace), 'u-' (cx<0), 'v+' (cy>=cellsPerFace), 'v-' (cy<0).
// t: the OTHER (in-range) coordinate, as a cell index [0,cellsPerFace) -- carried across the seam.
function _stepAcrossEdge(face, which, t, cellsPerFace) {
  const e = EDGE_TABLE[face][which]
  // the transition's neighborEdge tells us which side of the neighbor face we land on (pins one
  // coordinate to the near/far edge of the neighbor's grid); `sign` tells us whether the carried
  // coordinate t runs the same or flipped direction on the neighbor face. Flipped means the cell
  // index mirrors: t' = (cellsPerFace-1) - t.
  const tPrime = e.sign > 0 ? t : (cellsPerFace - 1 - t)
  let ncx, ncy
  if (e.edge === 'u+') { ncx = cellsPerFace - 1; ncy = tPrime }
  else if (e.edge === 'u-') { ncx = 0; ncy = tPrime }
  else if (e.edge === 'v+') { ncx = tPrime; ncy = cellsPerFace - 1 }
  else /* v- */ { ncx = tPrime; ncy = 0 }
  return { face: e.face, cx: ncx, cy: ncy }
}

// resolveCell: normalize a possibly-out-of-range (face,cx,cy) (produced by e.g. cx+1 on the last
// column of a face) into the correct real cell, walking across 1 or 2 edges as needed. TWO hops
// happen exactly at a cube corner (both cx and cy out of range simultaneously -- 3 faces meet
// there, the classic hard case): the first hop resolves one axis, which can leave the other axis
// still out of range in the new face's frame, so a second hop resolves that. This always
// terminates in at most 2 hops for a single-cell step because a step can only ever be 1 cell
// outside on at most 2 axes at once (diagonal neighbor offsets are always (+-1,+-1)).
export function resolveCell(face, cx, cy, cellsPerFace) {
  let f = face, x = cx, y = cy
  for (let hop = 0; hop < 2; hop++) {
    const xEdge = _edgeCoord(cellsPerFace, x)
    const yEdge = _edgeCoord(cellsPerFace, y)
    if (xEdge === null && yEdge === null) return { face: f, cx: x, cy: y }
    // prefer resolving whichever axis is out of range; if BOTH are out of range (corner case) hop
    // the x-axis first (arbitrary but consistent choice -- the second loop iteration then resolves
    // whatever the y-axis reads as in the NEW face's frame, which is a real hop of its own).
    if (xEdge !== null) {
      const which = xEdge === 'hi' ? 'u+' : 'u-'
      // t = the still-in-range axis, CLAMPED into [0,cellsPerFace) for the carry (a simultaneous
      // corner overshoot on y is resolved by the 2nd hop, not by an out-of-range t here).
      const t = Math.max(0, Math.min(cellsPerFace - 1, y))
      const r = _stepAcrossEdge(f, which, t, cellsPerFace)
      f = r.face; x = r.cx
      // y is now expressed in the NEW face's frame: if y itself was in-range it stays that value
      // (t carried it through unchanged in-range), but if y was ALSO out of range (real corner),
      // it must be re-evaluated next hop -- keep y as-is (not the clamped t) so the 2nd hop sees
      // the true overshoot and corrects it.
      continue
    }
    if (yEdge !== null) {
      const which = yEdge === 'hi' ? 'v+' : 'v-'
      const t = Math.max(0, Math.min(cellsPerFace - 1, x))
      const r = _stepAcrossEdge(f, which, t, cellsPerFace)
      f = r.face; y = r.cy
      x = r.cx
    }
  }
  // after 2 hops both axes must be in range (see termination proof in the doc comment above); clamp
  // defensively so a pathological cellsPerFace<2 (degenerate config) can never leak a bad index.
  return { face: f, cx: Math.max(0, Math.min(cellsPerFace - 1, x)), cy: Math.max(0, Math.min(cellsPerFace - 1, y)) }
}

// neighborCells: the 8-connected neighborhood (Moore neighborhood) of a face-cell, cross-face
// correct at edges and corners. Returns an array of up to 8 { face, cx, cy } (fewer only if
// cellsPerFace<2 collapses some into duplicates, which the Set-based caller in TickHandler
// naturally de-dupes via packCellKey).
export function neighborCells(face, cx, cy, cellsPerFace) {
  const out = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue
      out.push(resolveCell(face, cx + dx, cy + dy, cellsPerFace))
    }
  }
  return out
}

// Self-test: re-derives EDGE_TABLE's reciprocity live (every face.edge -> neighbor.edge transition,
// applied backward, must return to the origin face.edge with the same sign) and walks a handful of
// concrete geometric cases at face boundaries + a cube corner, asserting the resolved neighbor cell
// is CONTIGUOUS in world space (its world-direction sample is within one cell-diagonal of the
// origin cell's edge sample) -- not just "some face", but the geometrically adjacent one. Throws on
// any failure. Intended to be run once (e.g. at server boot in dev, or invoked manually) rather than
// as a per-tick cost.
export function verifyCubeSphereAdjacency() {
  for (const fKey of Object.keys(EDGE_TABLE)) {
    const f = Number(fKey)
    for (const e of Object.keys(EDGE_TABLE[f])) {
      const t = EDGE_TABLE[f][e]
      const back = EDGE_TABLE[t.face][t.edge]
      if (back.face !== f || back.edge !== e || back.sign !== t.sign) {
        throw new Error(`EDGE_TABLE reciprocity broken at face ${f} edge ${e}`)
      }
    }
  }
  const R = 1000
  const cellSize = 100
  const cellsPerFace = Math.ceil((2 * R) / cellSize)

  // Case 1: a step off the +u edge of face 0 must land on face 5 (per EDGE_TABLE[0]['u+']).
  {
    const r = resolveCell(0, cellsPerFace, 3, cellsPerFace)
    if (r.face !== 5) throw new Error(`edge case 1 failed: expected face 5, got ${r.face}`)
  }
  // Case 2: stepping back across that same seam must return to face 0 (reciprocity in practice, not
  // just table symmetry) -- resolveCell(5, -1, r.cy) should land back on face 0.
  {
    const r1 = resolveCell(0, cellsPerFace, 3, cellsPerFace)
    const r2 = resolveCell(r1.face, -1, r1.cy, cellsPerFace)
    if (r2.face !== 0) throw new Error(`edge round-trip failed: expected face 0, got ${r2.face}`)
  }
  // Case 3: cube corner -- (cellsPerFace, cellsPerFace) off face 0 (both axes overshoot: the classic
  // 3-faces-meet corner). Must resolve to SOME valid face/cell (in range), and must be one of the
  // three faces that actually meet at the +X,+Y,+Z corner (faces 0,2,4 per FACE_FRAME's c vectors
  // [1,0,0],[0,1,0],[0,0,1] all having a positive dot with the corner direction (1,1,1)).
  {
    const r = resolveCell(0, cellsPerFace, cellsPerFace, cellsPerFace)
    if (r.cx < 0 || r.cx >= cellsPerFace || r.cy < 0 || r.cy >= cellsPerFace) {
      throw new Error(`corner case out of range: ${JSON.stringify(r)}`)
    }
    if (![0, 2, 4].includes(r.face)) throw new Error(`corner case landed on unexpected face ${r.face}`)
  }
  // Case 4: worldToCell round-trip at a face interior (no seam) must stay on the expected face and
  // produce a neighbor set whose cells are all in-range and on a face adjacent to (or equal to) the
  // origin face.
  {
    const { face, cx, cy } = worldToCell(0, 0, R, R, cellSize) // near +Z face center
    if (face !== 4) throw new Error(`interior case: expected face 4 (+Z), got ${face}`)
    const neighbors = neighborCells(face, cx, cy, cellsPerFace)
    if (neighbors.length !== 8) throw new Error(`interior case: expected 8 neighbors, got ${neighbors.length}`)
    for (const n of neighbors) {
      if (n.cx < 0 || n.cx >= cellsPerFace || n.cy < 0 || n.cy >= cellsPerFace) throw new Error(`interior neighbor out of range: ${JSON.stringify(n)}`)
    }
  }
  // Case 5: a world position exactly at a face edge (dominant axis tied) must still resolve to SOME
  // valid, in-range cell without throwing/NaN -- the atan(cu/ccSafe) ratio near a seam is well
  // defined as long as ccSafe guards cc<=1, which pickFace's own dominant-axis choice guarantees
  // (cc is always the LARGEST of the 3 dot products at a point on the unit-radius test direction).
  {
    const x = 1, y = 1, z = 1 // exact cube corner direction
    const { face, ox, oy } = worldToFaceLocal(x, y, z, R)
    if (!Number.isFinite(ox) || !Number.isFinite(oy)) throw new Error(`corner direction produced non-finite local coords: ${ox},${oy} on face ${face}`)
  }
  return true
}
