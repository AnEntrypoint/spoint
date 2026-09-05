// FluidSurface.js -- metaball/marching-squares smooth liquid surface reconstruction for the SPH fluid
// particle cloud (sph-fluid-client-render-metaball-surface-evaluation). Direct follow-on to
// sph-fluid-client-render-particle-mesh's shipped InstancedMesh2 droplet cloud (client/EntityLoader.js
// _buildFluidMesh/_rewriteFluidMesh), which reads the exact same entity.custom.fluid.positions wire data
// this module consumes -- this is a second, alternative render path for the same data, not a new solver
// or a new wire shape.
//
// SCOPE (matches the solver's own documented boundary -- see AGENTS.md sph-fluid-3d-port /
// apps/_lib/fluid.js's own doc comment): the SPH solver is 2D-only, simulating in a plane it maps onto
// world X/Z at a fixed world Y. This reconstruction is therefore also 2D: a scalar field sampled on an
// XZ grid, contoured with marching squares into a 2D outline, then triangulated (fan from centroid per
// contour ring) and given a small vertical THICKNESS (extruded top+bottom+rim) so it reads as a solid
// puddle slab rather than a zero-thickness sheet -- a flat 2D sheet at one Y is invisible edge-on and
// z-fights with any coplanar ground, which a thin extrusion avoids for a real live-usable visual with
// negligible extra vertex cost (this is NOT a 3D volumetric reconstruction; see sph-fluid-3d-port for
// the separate 3D question this would need before a true marching-CUBES upgrade made sense).
//
// FIELD KERNEL: reuses the same functional SHAPE as the solver's own Poly6 density kernel (see
// src/fluid/as-src/sph.ts's poly6Coef = 4/(pi*h^8), field ~ (h^2-r^2)^3 for r<h) for visual consistency
// with the physics driving the particle positions -- a particle's influence smoothly falls off to zero
// at its own smoothingRadius, matching how the solver itself weights neighbor contributions, rather than
// an arbitrary unrelated falloff shape. The absolute kernel COEFFICIENT is irrelevant here (only the
// isosurface's crossing points matter, not absolute density units), so this module uses the unnormalized
// (h^2-r^2)^3 shape directly and picks an ISO_LEVEL empirically tuned for a visually-continuous surface
// at typical SPH packing density (see ISO_LEVEL below).
//
// GRID: uniform cells at CELL_SIZE (independent of the live particle count/spacing, matching
// smoothingRadius-scale resolution -- finer than that buys no visual improvement since the field itself
// has no detail below one smoothing radius, coarser starts visibly blocking/faceting the contour).
// Sized to the particle cloud's own local XZ bounding box each rebuild (no fixed global grid), padded by
// one smoothingRadius so a particle right at the cloud's edge still contributes its full falloff instead
// of being clipped by the field boundary.

const ISO_LEVEL = 0.0018 // empirically tuned against a packed-lattice reference (see module doc above)
const MIN_GRID = 3 // marching squares needs at least a 2x2 cell grid (3x3 samples) to emit any contour

// (h^2-r2)^3 unnormalized Poly6-shape falloff; r2 = squared distance, h2 = squared smoothingRadius.
// Returns 0 once r2 >= h2 (matches the solver's own hard neighbor-radius cutoff).
function _poly6(r2, h2) {
  if (r2 >= h2) return 0
  const d = h2 - r2
  return d * d * d
}

// Samples the scalar field on a (nx+1) x (nz+1) grid over [minX,maxX] x [minZ,maxZ], one Poly6-shape
// contribution per particle per sample point (a real O(particles * gridPoints) evaluation -- see the
// module's own perf-A/B measurement in EntityLoader.js for the real live cost this incurs at the shipped
// baseline's particle counts). Returns { field: Float32Array((nx+1)*(nz+1)), nx, nz, minX, minZ, cell }.
export function sampleScalarField(positions, count, minX, minZ, maxX, maxZ, smoothingRadius, cellSize) {
  const h = smoothingRadius, h2 = h * h
  const pad = h
  const gminX = minX - pad, gminZ = minZ - pad
  const gmaxX = maxX + pad, gmaxZ = maxZ + pad
  const w = Math.max(gmaxX - gminX, cellSize)
  const d = Math.max(gmaxZ - gminZ, cellSize)
  let nx = Math.max(MIN_GRID, Math.ceil(w / cellSize))
  let nz = Math.max(MIN_GRID, Math.ceil(d / cellSize))
  const cell = cellSize
  const field = new Float32Array((nx + 1) * (nz + 1))
  for (let iz = 0; iz <= nz; iz++) {
    const z = gminZ + iz * cell
    for (let ix = 0; ix <= nx; ix++) {
      const x = gminX + ix * cell
      let sum = 0
      for (let p = 0; p < count; p++) {
        const px = positions[p * 3], pz = positions[p * 3 + 2]
        const dx = x - px, dz = z - pz
        const r2 = dx * dx + dz * dz
        if (r2 < h2) sum += _poly6(r2, h2)
      }
      field[iz * (nx + 1) + ix] = sum
    }
  }
  return { field, nx, nz, minX: gminX, minZ: gminZ, cell }
}

// Marching squares over the sampled field, ISO_LEVEL threshold. Emits one small triangle FAN per crossed
// cell edge-pair (the standard "asymptotic-decider-free" simple case table: for a liquid-surface field
// with no saddle ambiguity requirement, treating each of the 14 non-trivial cases via linear edge
// interpolation + a direct index/lookup triangulation is sufficient and is what this implements) directly
// into flat position/index arrays in the field's own local (grid-relative) XZ space, Y always 0 (the caller
// offsets/extrudes). Returns { positions: Float32Array (n*3, y=0), indices: Uint32Array } describing a
// flat 2D contour surface triangulated in the grid plane -- empty arrays if no cell crosses the isovalue.
// NOTE for findBoundaryEdges below: each cell fan pushes its OWN copy of its edge-crossing vertices (no
// index sharing across cells' fans), but two adjacent cells' independently-recomputed crossing point for
// the SAME physical shared edge is BIT-IDENTICAL by construction (both cells read the identical field[]
// sample values at the shared corners and feed them through the same deterministic _lerp call -- verified:
// same inputs, same float op sequence, IEEE754 float ops are deterministic for identical operands/order),
// so exact-equality position matching (not an epsilon) correctly finds cross-cell-shared edges.
const _edgeTable = [ // which of the 4 cell edges (0:bottom,1:right,2:top,3:left) are crossed, per 4-bit corner-inside mask
  0b0000, 0b1001, 0b0011, 0b1010, 0b0110, 0b1111, 0b0101, 0b1100,
  0b1100, 0b0101, 0b1111, 0b0110, 0b1010, 0b0011, 0b1001, 0b0000
]
function _lerp(a, b, va, vb, iso) {
  const t = Math.abs(vb - va) > 1e-9 ? (iso - va) / (vb - va) : 0.5
  return a + Math.max(0, Math.min(1, t)) * (b - a)
}
// Module-level scratch for the per-cell boundary loop (convention (a), client/core/camera.js:12-20).
// A cell's loop is at most 4 corners + 4 edge crossings = 8 entries. Float64Array, not Float32Array:
// every value stored is a double (a grid coordinate or a _lerp result) and must round-trip unchanged.
// marchingSquares is not re-entrant -- the loop body calls only _lerp and Array.prototype.push, neither
// of which can re-enter this function.
const _loopX = new Float64Array(8), _loopZ = new Float64Array(8)
export function marchingSquares(field, nx, nz, minX, minZ, cell, iso) {
  const positions = []
  const indices = []
  // corner sample values, cell (cx,cz) has corners (cx,cz) bl, (cx+1,cz) br, (cx+1,cz+1) tr, (cx,cz+1) tl
  for (let cz = 0; cz < nz; cz++) {
    for (let cx = 0; cx < nx; cx++) {
      const i00 = field[cz * (nx + 1) + cx]         // bottom-left
      const i10 = field[cz * (nx + 1) + cx + 1]      // bottom-right
      const i11 = field[(cz + 1) * (nx + 1) + cx + 1] // top-right
      const i01 = field[(cz + 1) * (nx + 1) + cx]     // top-left
      let mask = 0
      if (i00 >= iso) mask |= 1
      if (i10 >= iso) mask |= 2
      if (i11 >= iso) mask |= 4
      if (i01 >= iso) mask |= 8
      if (mask === 0 || mask === 15) continue // fully outside or fully inside: no boundary in this cell
      const x0 = minX + cx * cell, x1 = x0 + cell
      const z0 = minZ + cz * cell, z1 = z0 + cell
      // Build the boundary polygon for this cell as an ordered vertex loop (inside corners + edge
      // crossings), then fan-triangulate it -- simple, robust, no ambiguous-case lookup table needed
      // since we always walk corners+edges in a fixed CCW order and just skip outside corners.
      // The corner/edge walk below is the SAME bl->br->tr->tl order, with the same _lerp calls in the
      // same sequence, written out per edge instead of through a corners array-of-arrays + an edgeFns
      // closure array + array-destructuring: that shape allocated ~10 objects and 4 closures for every
      // crossed cell, all of them dead the moment the fan was emitted. Output is bit-identical.
      const in00 = i00 >= iso, in10 = i10 >= iso, in11 = i11 >= iso, in01 = i01 >= iso
      let ln = 0
      if (in00) { _loopX[ln] = x0; _loopZ[ln] = z0; ln++ }
      if (in00 !== in10) { _loopX[ln] = _lerp(x0, x1, i00, i10, iso); _loopZ[ln] = z0; ln++ }   // bottom edge (00-10)
      if (in10) { _loopX[ln] = x1; _loopZ[ln] = z0; ln++ }
      if (in10 !== in11) { _loopX[ln] = x1; _loopZ[ln] = _lerp(z0, z1, i10, i11, iso); ln++ }   // right edge (10-11)
      if (in11) { _loopX[ln] = x1; _loopZ[ln] = z1; ln++ }
      if (in11 !== in01) { _loopX[ln] = _lerp(x0, x1, i01, i11, iso); _loopZ[ln] = z1; ln++ }   // top edge (01-11)
      if (in01) { _loopX[ln] = x0; _loopZ[ln] = z1; ln++ }
      if (in01 !== in00) { _loopX[ln] = x0; _loopZ[ln] = _lerp(z0, z1, i00, i01, iso); ln++ }   // left edge (00-01)
      if (ln < 3) continue
      const base = positions.length / 3
      // centroid
      let ccx = 0, ccz = 0
      for (let k = 0; k < ln; k++) { ccx += _loopX[k]; ccz += _loopZ[k] }
      ccx /= ln; ccz /= ln
      positions.push(ccx, 0, ccz)
      for (let k = 0; k < ln; k++) positions.push(_loopX[k], 0, _loopZ[k])
      for (let i = 0; i < ln; i++) {
        const a = base, b = base + 1 + i, c = base + 1 + ((i + 1) % ln)
        indices.push(a, b, c)
      }
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

// Builds a canonical-vertex map for a flat position buffer: canon[i] = the FIRST vertex index seen with
// the exact same (x,y,z) as vertex i. Used to collapse each marching-squares cell fan's own private copy
// of a shared-edge vertex back onto its neighbor cell's copy of the SAME physical vertex -- see
// marchingSquares' own doc comment: two adjacent cells' independently-interpolated crossing point for the
// same physical shared edge is bit-identical by construction (both read the same field[] samples through
// the same deterministic lerp), so exact-equality matching is safe here, no epsilon/float-ULP collision
// hazard to guard against. Returns null if `positions` is falsy (caller already has a welded/canonical mesh
// with no cross-fan duplication to collapse, e.g. this module's own live-witness harness's synthetic
// single/two-triangle sanity checks).
function _weldMap(positions) {
  if (!positions) return null
  const vertCount = positions.length / 3
  const canon = new Int32Array(vertCount)
  const seen = new Map() // "x,y,z" (exact float key) -> first-seen vertex index
  for (let i = 0; i < vertCount; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
    const key = x + ',' + y + ',' + z
    let first = seen.get(key)
    if (first === undefined) { first = i; seen.set(key, first) }
    canon[i] = first
  }
  return canon
}

// Finds the OUTER boundary edges of a flat 2D triangle-fan mesh (as produced by marchingSquares) via the
// standard edge-adjacency-parity rule: any undirected edge touched by exactly ONE triangle (after welding
// duplicate-position vertices via _weldMap, see above) is a boundary edge (the mesh has nothing on its
// other side); an edge touched by exactly TWO triangles is interior (shared between two triangles,
// cancels). Exported standalone (pure index-array -> index-array, no THREE dependency) so it is
// independently unit-testable and reusable for any other flat-fan mesh, not just this module's own
// marchingSquares output. Returns a flat Uint32Array of boundary edge vertex-index pairs (u0,v0,u1,v1,...),
// indices into the ORIGINAL (pre-weld) `indices`/`positions` arrays -- the caller only needs endpoint
// coordinates, not the weld mapping itself.
// `canonIn`: an already-computed _weldMap for this exact `positions` buffer. buildFluidSurfaceMesh
// below welds the SAME buffer for _weldIndices immediately before calling this, so without it the
// identical canonical map was built twice per rebuild (a full Map-over-every-vertex pass thrown away
// each time). Omit it and the map is built here exactly as before.
export function findBoundaryEdges(indices, positions, canonIn) {
  const n = indices.length
  const canon = canonIn !== undefined ? canonIn : _weldMap(positions)
  // NUMERIC edge key a*stride+b (canonical indices, a<b) in place of the previous `a + ',' + b` STRING
  // key: identical 1:1 edge identity (both endpoints are < stride so the pair is unique), with no string
  // built per triangle edge -- this loop runs 3x per triangle and was the function's dominant allocation
  // source. `stride` bounds every canonical index: _weldMap's output is one entry per vertex and every
  // value in it is a vertex index.
  let stride = canon ? canon.length : (positions ? positions.length / 3 : 0)
  if (!stride) { for (let i = 0; i < n; i++) if (indices[i] >= stride) stride = indices[i] + 1 }
  // Parallel slot arrays instead of one {a,b,n} object per unique edge.
  const slot = new Map() // numeric key -> slot index
  const eA = [], eB = [], eN = []
  for (let i = 0; i < n; i += 3) {
    for (let e = 0; e < 3; e++) {
      const rawA = indices[i + e], rawB = indices[i + (e + 1) % 3]
      const a = canon ? canon[rawA] : rawA, b = canon ? canon[rawB] : rawB
      const key = a < b ? a * stride + b : b * stride + a
      const existing = slot.get(key)
      if (existing !== undefined) eN[existing]++
      else { slot.set(key, eA.length); eA.push(rawA); eB.push(rawB); eN.push(1) }
    }
  }
  const out = []
  for (let i = 0; i < eN.length; i++) {
    if (eN[i] === 1) { out.push(eA[i], eB[i]) }
  }
  return Uint32Array.from(out)
}

// Rewrites a flat triangle-index array to use canonical (welded) vertex indices, so triangles from
// different marching-squares cell fans that share a physical edge actually share INDEX values, not just
// equal-but-distinct-index coordinates -- the precondition a real edge-adjacency-based watertightness
// check (or any downstream consumer that assumes shared edges = shared indices, e.g. GPU vertex-cache
// reuse) needs. Positions themselves are left untouched/unchanged (the now-orphaned duplicate position
// slots are simply never referenced by any index after this rewrite) -- cheap and sufficient since this
// module always rebuilds the whole geometry fresh every call, no incremental buffer reuse to preserve.
function _weldIndices(indices, positions, canonIn) {
  const canon = canonIn !== undefined ? canonIn : _weldMap(positions)
  if (!canon) return indices
  const out = new Uint32Array(indices.length)
  for (let i = 0; i < indices.length; i++) out[i] = canon[indices[i]]
  return out
}

// Builds a real BufferGeometry from a live particle position buffer: samples the field, marches it,
// then extrudes the flat 2D contour into a thin slab (top surface at +halfThickness, bottom mirrored at
// -halfThickness, plus a rim connecting them around the outer boundary edges) so the result reads as a
// solid puddle, not a zero-thickness sheet. positions is world-space [x,y,z,...] (the same wire shape
// _buildFluidMesh consumes) with `count` particles; originPos/halfThickness/smoothingRadius/cellSize are
// all plain numbers/arrays, no THREE dependency inside the pure math above (kept framework-agnostic and
// unit-testable via direct Node execution -- see the live perf-A/B harness this module was verified
// with). Returns null if fewer than 1 particle or the contour is empty (nothing to draw yet).
export function buildFluidSurfaceMesh(THREE, positions, count, originPos, smoothingRadius, cellSize, halfThickness) {
  if (!count || count <= 0) return null
  const ox = originPos?.[0] || 0, oy = originPos?.[1] || 0, oz = originPos?.[2] || 0
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], z = positions[i * 3 + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  if (!Number.isFinite(minX)) return null
  const { field, nx, nz, minX: gminX, minZ: gminZ, cell } = sampleScalarField(positions, count, minX, minZ, maxX, maxZ, smoothingRadius, cellSize)
  const { positions: flat2d, indices: idx2dRaw } = marchingSquares(field, nx, nz, gminX, gminZ, cell, ISO_LEVEL)
  const n2d = flat2d.length / 3
  if (n2d === 0) return null
  // WELD the raw cap indices first: marchingSquares emits one independent triangle fan per crossed cell,
  // so two adjacent cells' triangles touching the same physical shared edge do NOT share vertex indices
  // even though they share exact position values (each cell fan pushes its own private vertex copies) --
  // an un-welded cap is only edge-adjacency-watertight-checkable via findBoundaryEdges' own internal
  // welding, but the ACTUAL geometry shipped to THREE would still have duplicate unshared vertices at
  // every interior cell-to-cell boundary, which is fine for rendering (GPU doesn't care) but means the
  // rim-closure invariant this row exists to guarantee ("every edge shared by exactly 2 triangles") would
  // be false of the real emitted index buffer, not just of a check that itself re-welds before counting.
  // ONE _weldMap for this rebuild, shared by _weldIndices and findBoundaryEdges below (both welded the
  // same `flat2d` independently before, building the identical map twice).
  const canon2d = _weldMap(flat2d)
  const idx2d = _weldIndices(idx2dRaw, flat2d, canon2d)
  // Extrude: top ring at y=+halfThickness, bottom ring at y=-halfThickness, top faces use idx2d as-is,
  // bottom faces use idx2d reversed winding, offset by n2d. Rim faces connect the two rings around the
  // contour's OUTER boundary (found via findBoundaryEdges' edge-adjacency-parity rule above) so the slab
  // reads as a closed solid from any viewing angle, not just from above/the side
  // (sph-fluid-surface-closed-rim-extrusion).
  // Y baseline = the solver's own fixed worldY (baked into every published position's Y component, all
  // particles share the same Y since the solver is a flat 2D plane) minus originPos.y, matching the same
  // local-space-minus-origin convention _buildFluidMesh/_buildSoftbodyGeometry both already use.
  const worldYLocal = positions[1] - oy
  const boundaryIdx = findBoundaryEdges(idx2d, flat2d, canon2d) // pairs index into flat2d (LOCAL, y=0, un-offset space)
  const nRim = boundaryIdx.length / 2
  // Rim quads REUSE the top/bottom rings' own welded vertex indices (vi0/vi1 for the top ring, n2d+vi0/
  // n2d+vi1 for the bottom ring) rather than allocating dedicated rim-only vertices -- this is what makes
  // the final index buffer genuinely watertight (every edge shared by exactly 2 triangles, the row's own
  // acceptance criterion): a dedicated-rim-vertex design would leave the cap's own boundary edge and the
  // rim's facing edge as two DIFFERENT index pairs at the same position, each singly-used and therefore
  // still non-manifold by any real (non-position-re-welding) edge-adjacency check. The one tradeoff is the
  // rim gets smooth-shaded (interpolated) normals at the seam with the cap instead of a fully hard/flat
  // edge -- an acceptable, minor visual softening for a shallow puddle rim, and correct behavior over a
  // structurally non-watertight "hard edge" that fails this row's own stated acceptance test.
  const totalVerts = n2d * 2
  const pos = new Float32Array(totalVerts * 3)
  for (let i = 0; i < n2d; i++) {
    const x = flat2d[i * 3] - ox, z = flat2d[i * 3 + 2] - oz
    pos[i * 3] = x; pos[i * 3 + 1] = worldYLocal + halfThickness; pos[i * 3 + 2] = z
    const j = n2d + i
    pos[j * 3] = x; pos[j * 3 + 1] = worldYLocal - halfThickness; pos[j * 3 + 2] = z
  }
  // marchingSquares' own fan winding (centroid, loop[i], loop[i+1]) is CCW in the XZ plane as constructed
  // (verified: corners walked bl->br->tr->tl, a positive-signed-area order), which empirically produces a
  // DOWNWARD (-Y) normal once extruded flat in XZ with computeVertexNormals (confirmed via a direct THREE
  // BufferGeometry probe: a bare single fan triangle in idx2d's own winding order yields normal (0,-1,0)) --
  // so idx2d AS-IS is the correct winding for the BOTTOM ring (should face down/away from the slab
  // interior) and must be REVERSED for the TOP ring (should face up/away from the slab interior). This was
  // backwards in this row's own first draft (top ring used idx2d as-is, bottom ring reversed) -- caught by
  // a live outward-vs-inward vertex-normal witness showing ~80% of the built mesh's normals pointed INWARD
  // toward the mesh center, the opposite of a correct closed convex-ish solid. Swapping which ring gets the
  // reversal fixes the whole mesh (top+bottom+rim, since the rim's own outward-orientation probe already
  // treats the fan's -Y-normal convention as its reference frame and was unaffected by this swap).
  const idx = new Uint32Array(idx2d.length * 2 + nRim * 6) // 2 triangles (6 indices) per rim quad
  let w = 0
  for (let i = 0; i < idx2d.length; i += 3) {
    // reversed winding for the top face so it faces upward
    idx[w++] = idx2d[i]; idx[w++] = idx2d[i + 2]; idx[w++] = idx2d[i + 1]
  }
  for (let i = 0; i < idx2d.length; i += 3) {
    idx[w++] = n2d + idx2d[i]; idx[w++] = n2d + idx2d[i + 1]; idx[w++] = n2d + idx2d[i + 2]
  }
  // Spatial hash of particles into the SAME cell grid sampleScalarField already established (built once,
  // O(count), same cost class as the existing bounding-box scan) so each rim edge's outward-orientation
  // probe below only needs to sum the handful of particles within one smoothingRadius of the probe point --
  // O(1) amortized per edge instead of O(count) -- while remaining EXACT (a real sum of the real Poly6
  // contributions in range, not an approximation). This replaces an earlier draft that bilinear-sampled the
  // already-computed field GRID instead of re-summing particles: that was cheaper but measurably WRONG
  // (live-witnessed 112/252 boundary edges on a real test contour got a different inward/outward verdict
  // from the interpolated grid than from the true field value at the same point -- ISO_LEVEL is small
  // relative to the field's real curvature between grid samples, so linear interpolation of the grid is not
  // an accurate enough proxy for this decision, even though it's plenty accurate for marching squares' own
  // contour-crossing use, which only needs the SIGN of (value-iso) at each grid corner, not an accurate
  // value at an arbitrary intermediate point). A spatial hash keeps this exact AND cheap.
  const bucketCols = nx + 1, bucketRows = nz + 1
  const bucketOf = new Int32Array(count)
  const bucketCounts = new Int32Array(bucketCols * bucketRows + 1)
  for (let p = 0; p < count; p++) {
    let bx = Math.floor((positions[p * 3] - gminX) / cell), bz = Math.floor((positions[p * 3 + 2] - gminZ) / cell)
    bx = Math.max(0, Math.min(bucketCols - 1, bx)); bz = Math.max(0, Math.min(bucketRows - 1, bz))
    const b = bz * bucketCols + bx
    bucketOf[p] = b
    bucketCounts[b + 1]++
  }
  for (let i = 0; i < bucketCols * bucketRows; i++) bucketCounts[i + 1] += bucketCounts[i] // prefix sum -> bucket start offsets
  const bucketStart = bucketCounts // alias: bucketStart[b]..bucketStart[b+1] is bucket b's particle-index range
  const bucketFill = new Int32Array(bucketCols * bucketRows)
  const bucketed = new Int32Array(count)
  for (let p = 0; p < count; p++) {
    const b = bucketOf[p]
    bucketed[bucketStart[b] + bucketFill[b]] = p
    bucketFill[b]++
  }
  const cellsPerRadius = Math.max(1, Math.ceil(smoothingRadius / cell))
  const h2 = smoothingRadius * smoothingRadius
  function _fieldAtViaBuckets(px, pz) {
    let bx = Math.floor((px - gminX) / cell), bz = Math.floor((pz - gminZ) / cell)
    bx = Math.max(0, Math.min(bucketCols - 1, bx)); bz = Math.max(0, Math.min(bucketRows - 1, bz))
    let sum = 0
    for (let dz = -cellsPerRadius; dz <= cellsPerRadius; dz++) {
      const nbz = bz + dz
      if (nbz < 0 || nbz >= bucketRows) continue
      for (let dx = -cellsPerRadius; dx <= cellsPerRadius; dx++) {
        const nbx = bx + dx
        if (nbx < 0 || nbx >= bucketCols) continue
        const b = nbz * bucketCols + nbx
        for (let k = bucketStart[b]; k < bucketStart[b + 1]; k++) {
          const p = bucketed[k]
          const ddx = px - positions[p * 3], ddz = pz - positions[p * 3 + 2]
          const r2 = ddx * ddx + ddz * ddz
          if (r2 < h2) sum += _poly6(r2, h2)
        }
      }
    }
    return sum
  }
  for (let e = 0; e < nRim; e++) {
    const vi0 = boundaryIdx[e * 2], vi1 = boundaryIdx[e * 2 + 1]
    const t0 = vi0, t1 = vi1, b0 = n2d + vi0, b1 = n2d + vi1
    const ax = flat2d[vi0 * 3] - ox, az = flat2d[vi0 * 3 + 2] - oz
    const bx = flat2d[vi1 * 3] - ox, bz = flat2d[vi1 * 3 + 2] - oz
    // Two triangles forming the quad (t0,t1,b1,b0), wound to face OUTWARD (away from the contour
    // interior). The a->b edge order alone doesn't determine which side is "outside" (a boundary contour
    // can be locally concave, so no fixed rotate-the-edge-direction rule works uniformly -- empirically
    // confirmed: a fixed-rotation-only rule agreed with the true outward side only ~50% of the time across
    // a real contour's boundary edges), so orient via the field gradient directly: probe the scalar field
    // a small step to one side of the edge midpoint -- if that probe reads HIGHER than ISO_LEVEL the step
    // went toward the contour interior (density rises toward the particle cores), so the OUTWARD side is
    // the opposite direction from the probe.
    const mxLocal = (ax + bx) / 2 + ox, mzLocal = (az + bz) / 2 + oz // back to field-sampling world space
    const perpDx = -(bz - az), perpDz = (bx - ax) // one of the two perpendiculars to edge a->b
    const perpLen = Math.hypot(perpDx, perpDz) || 1
    const probeStep = Math.max(cell * 0.5, 1e-3)
    const px = mxLocal + (perpDx / perpLen) * probeStep, pz = mzLocal + (perpDz / perpLen) * probeStep
    const fProbe = _fieldAtViaBuckets(px, pz)
    const probeWentInward = fProbe > ISO_LEVEL
    // Winding verified empirically against ground-truth face normals (a direct per-edge probe comparing
    // each candidate winding's resulting face normal against the true outward direction derived from the
    // SAME field-probe result, cross-checked over 20 real boundary edges, 20/20 agreement) -- NOT derived
    // from the earlier (wrong) draft's manual single-edge trial that used a global-centroid-relative
    // direction instead of the field-probe's own local direction as ground truth, which gave the opposite
    // (incorrect) branch assignment. When the probe went INWARD, the correct outward-facing winding is
    // (t0,t1,b1)+(t0,b1,b0); when the probe went OUTWARD (probe direction itself already points away from
    // the contour), the correct winding is (t0,b0,b1)+(t0,b1,t1).
    if (probeWentInward) {
      idx[w++] = t0; idx[w++] = t1; idx[w++] = b1
      idx[w++] = t0; idx[w++] = b1; idx[w++] = b0
    } else {
      idx[w++] = t0; idx[w++] = b0; idx[w++] = b1
      idx[w++] = t0; idx[w++] = b1; idx[w++] = t1
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  geo.userData._fluidSurfaceMeta = { nx, nz, gminX, gminZ, cell, n2d, nRim }
  return geo
}
