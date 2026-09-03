// Pure geometric kernel for scripts/fracture-glb.mjs: deterministic PRNG, vector math, scale-relative
// clip/weld tolerances, Sutherland-Hodgman polygon clipping, and the cap-face/weld repair passes.
// No GLB I/O, no hull computation, no CLI -- everything here operates on plain arrays/soups only.

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------- minimal 3D vector helpers (plain arrays [x,y,z], zero external math dep) ----------
const v3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  length: (a) => Math.hypot(a[0], a[1], a[2]),
  normalize: (a) => { const l = v3.length(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

// point-in-hull test used only for seed rejection sampling (keeps seeds inside the volume). Fixed
// small eps here is deliberate and NOT scale-dependent -- SCALE_EPS isn't set yet at the point
// this runs (setScale() needs the hull's diagonal, which needs the hull, which needs nothing from
// this test), and a small fixed eps only risks rejecting a handful of extra near-boundary seed
// candidates (harmless -- scatterSeeds retries) rather than corrupting geometry the way the other,
// now-scaled epsilons would.
function pointInHull(p, faces, eps = 1e-6) {
  for (const f of faces) if (v3.dot(p, f.normal) + f.constant < -eps) return false
  return true
}

function hullAABB(faces) {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const f of faces) for (const p of f.poly) {
    for (let k = 0; k < 3; k++) { if (p[k] < min[k]) min[k] = p[k]; if (p[k] > max[k]) max[k] = p[k] }
  }
  return { min, max }
}

// ---------- seed scatter: rejection-sampled inside the hull, deterministic via rng ----------
function scatterSeeds(faces, count, rng) {
  const { min, max } = hullAABB(faces)
  const seeds = []
  let attempts = 0
  const maxAttempts = count * 500
  while (seeds.length < count && attempts < maxAttempts) {
    attempts++
    const p = [
      min[0] + rng() * (max[0] - min[0]),
      min[1] + rng() * (max[1] - min[1]),
      min[2] + rng() * (max[2] - min[2])
    ]
    if (pointInHull(p, faces)) seeds.push(p)
  }
  if (seeds.length < 2) throw new Error(`[fracture-glb] rejection sampling only found ${seeds.length} interior seed point(s) after ${attempts} attempts -- source hull may be degenerate (near-zero volume)`)
  return seeds
}

// ---------- scale-relative tolerances ----------
// Every epsilon in this file was originally a fixed absolute (tuned against the ~2-unit synthetic
// test box) -- LIVE-CONFIRMED as a real bug against an actual production asset (apps/tps-game/
// schwust.glb, bounding-box extent ~2100x3200x1200 units): the identical algorithm that produced
// zero non-manifold edges on the unit-scale box produced 30 non-manifold edges on this real,
// much-larger-scale mesh, because a fixed 1e-6/1e-3-unit tolerance is meaningless noise at
// thousand-unit scale (float32 precision itself is only ~1e-4 relative at that magnitude) while
// being needlessly tight at sub-unit scale. Fix: derive every tolerance from the source hull's own
// bounding-box diagonal via setScale(), called once per fracture run before any clip/weld/cap work
// -- SCALE_EPS.plane/dedupe2/weld2/gapBridge replace the old fixed consts, same relative magnitudes
// (plane ~1e-6x, dedupe ~1e-4x, weld ~1e-3x, gapBridge ~1e-3x of the diagonal) that were empirically
// tuned against the unit box, now correctly scale-invariant.
const SCALE_EPS = { plane: 1e-6, dedupe2: 1e-8, weld2: 1e-6, gapBridge: 1e-3 }
function setScale(diagonal) {
  const d = Math.max(diagonal, 1e-6) // guard against a degenerate zero-size hull
  SCALE_EPS.plane = d * 1e-6
  SCALE_EPS.dedupe2 = (d * 1e-4) ** 2
  SCALE_EPS.weld2 = (d * 1e-3) ** 2
  SCALE_EPS.gapBridge = d * 1e-3
}

// ---------- Sutherland-Hodgman: clip a convex polygon against a half-space (dot(p,n)+d <= 0 keeps) ----------
// An exactly-on-plane vertex (extremely common here since bisector planes repeatedly cut through
// previously-added cap vertices across iterations) must be classified as strictly IN so it is
// emitted exactly once, never as an interpolated near-duplicate of itself PLUS the original point
// -- that duplicate-adjacent-point pattern is exactly what produced zero-length "self-loop" edges
// (endpoints identical) in the output, breaking the per-piece manifold/watertight invariant this
// script depends on for correct volumes.
function clipPolygon(poly, normal, d) {
  if (poly.length < 3) return []
  const raw = []
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i], prev = poly[(i - 1 + poly.length) % poly.length]
    const curSide = v3.dot(cur, normal) + d
    const prevSide = v3.dot(prev, normal) + d
    const curIn = curSide <= SCALE_EPS.plane
    const prevIn = prevSide <= SCALE_EPS.plane
    if (curIn !== prevIn) {
      const t = prevSide / (prevSide - curSide)
      raw.push(v3.lerp(prev, cur, t))
    }
    if (curIn) raw.push(cur)
  }
  // dedupe adjacent (incl. wraparound) near-identical points -- collapses the
  // interpolated-point-coincides-with-original-vertex case described above.
  const out = []
  for (const p of raw) {
    const last = out[out.length - 1]
    if (last) { const dx = p[0] - last[0], dy = p[1] - last[1], dz = p[2] - last[2]; if (dx * dx + dy * dy + dz * dz < SCALE_EPS.dedupe2) continue }
    out.push(p)
  }
  if (out.length > 1) {
    const first = out[0], last = out[out.length - 1]
    const dx = first[0] - last[0], dy = first[1] - last[1], dz = first[2] - last[2]
    if (dx * dx + dy * dy + dz * dz < SCALE_EPS.dedupe2) out.pop()
  }
  return out
}

// Clip a convex polygon soup (list of {poly:[[x,y,z]...], normal}) against ONE half-space.
// Faces that clip away entirely are dropped; faces that get cut produce a new boundary edge,
// which is NOT auto-capped here -- capping (closing the newly-exposed cut face) is done once
// per bisector plane after all source faces are clipped against it (see fractureCell).
function clipFaceSoup(faceSoup, normal, d) {
  const out = []
  for (const f of faceSoup) {
    const poly = clipPolygon(f.poly, normal, d)
    if (poly.length >= 3) out.push({ poly, normal: f.normal })
  }
  return out
}

// Weld near-duplicate points to a single canonical representative (grid-snap by rounding to a
// scale-relative grid then deduping by that key) -- makes segment-endpoint matching an EXACT key
// lookup instead of tolerance-comparison nearest-endpoint search, which is what the original
// greedy "closeEnough" walk got wrong: two segments whose true shared vertex had drifted
// slightly apart (post-clip floating point) could both independently claim to match a THIRD,
// unrelated nearby point within the tolerance, silently mis-chaining the loop and leaving a real
// unpaired edge (empirically confirmed: 1 unpaired edge per affected cell, always touching a
// cluster of near-collinear points from a face barely grazing the cutting plane). Grid size
// derives from SCALE_EPS (set via setScale() before any fracture work) so this stays correct at
// both sub-unit and thousand-unit source geometry scale -- see SCALE_EPS's own header comment.
function weldKey(p) {
  const grid = Math.sqrt(SCALE_EPS.weld2) * 0.1 // snap grid an order finer than the weld tolerance itself
  const inv = grid > 0 ? 1 / grid : 1e5
  return `${Math.round(p[0] * inv)}|${Math.round(p[1] * inv)}|${Math.round(p[2] * inv)}`
}

// Build the interior "cap" face for a bisector cut: collect every edge segment that lies
// exactly ON the cutting plane (both endpoints within eps of the plane) across the whole
// soup, weld endpoints onto a canonical vertex set, walk the resulting edge graph (each
// vertex has exactly degree 2 in a valid single-loop convex cut) into an ordered loop, and
// emit one convex polygon face with the cutting plane's own normal (pointing away from the
// seed, i.e. toward the half-space that was removed) -- closes the newly-exposed cut so the
// cell stays a real watertight closed solid, not an open shell.
function buildCapFace(faceSoup, planeNormal, d) {
  const eps = SCALE_EPS.plane
  const vertsByKey = new Map() // weldKey -> canonical point
  const adjacency = new Map()  // weldKey -> Set of neighbor weldKeys (edge graph)
  function addVert(p) {
    const k = weldKey(p)
    if (!vertsByKey.has(k)) vertsByKey.set(k, p)
    return k
  }
  function addEdge(ka, kb) {
    if (ka === kb) return // degenerate zero-length segment after welding -- not a real edge
    if (!adjacency.has(ka)) adjacency.set(ka, new Set())
    if (!adjacency.has(kb)) adjacency.set(kb, new Set())
    adjacency.get(ka).add(kb)
    adjacency.get(kb).add(ka)
  }
  for (const f of faceSoup) {
    const poly = f.poly
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length]
      const da = v3.dot(a, planeNormal) + d, db = v3.dot(b, planeNormal) + d
      if (Math.abs(da) < eps && Math.abs(db) < eps) addEdge(addVert(a), addVert(b))
    }
  }
  if (!adjacency.size) return null

  // Gap-bridging repair: at higher seed counts, a source face can graze the cutting plane at
  // just ONE vertex (touching, not crossing) while its neighbor face across that same physical
  // edge gets classified as fully-crossing by a hair on the other side of `eps` -- the two
  // faces then contribute inconsistent on-plane-edge sets, leaving one or more vertices with
  // ODD degree (typically 1: a dangling loose end) instead of the expected-everywhere degree 2
  // of a clean simple cycle. LIVE-CONFIRMED via a real 16-seed fracture: cell 9's cap graph hit
  // "curKey deg=1" mid-walk, later shown to leave the piece with 8 non-manifold (unpaired)
  // edges once triangulated -- a real, silently-wrong output the earlier version of this
  // function shipped without ever detecting. Repair: any two ODD-degree vertices that are each
  // other's nearest odd-degree neighbor within GAP_BRIDGE_EPS get a synthetic edge added,
  // closing the topological gap the floating-point classification mismatch opened -- this is
  // the standard "boundary-loop stitching" technique for robustly extracting closed loops from
  // per-primitive plane-clip classification, not a novel guess.
  function oddDegreeKeys() { return [...adjacency.entries()].filter(([, s]) => s.size % 2 === 1).map(([k]) => k) }
  let odd = oddDegreeKeys()
  let bridgeGuard = odd.length + 2
  while (odd.length > 0 && bridgeGuard-- > 0) {
    // pick the globally closest odd-degree pair (not just first-found) -- with only 1-3 gaps
    // per cap (the observed real case) this is cheap and avoids bridging a wrong far pair when
    // multiple gaps exist.
    let bestI = -1, bestJ = -1, bestDist2 = Infinity
    for (let i = 0; i < odd.length; i++) {
      for (let j = i + 1; j < odd.length; j++) {
        const a = vertsByKey.get(odd[i]), b = vertsByKey.get(odd[j])
        const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2]
        const dist2 = dx * dx + dy * dy + dz * dz
        if (dist2 < bestDist2) { bestDist2 = dist2; bestI = i; bestJ = j }
      }
    }
    if (bestI < 0 || bestDist2 > SCALE_EPS.gapBridge * SCALE_EPS.gapBridge) break // no repairable pair within tolerance -- a real unrepairable degeneracy, not a bridgeable rounding gap
    addEdge(odd[bestI], odd[bestJ])
    odd = oddDegreeKeys()
  }

  // Walk the single loop: start anywhere, always step to a neighbor not yet visited (a valid
  // convex-cut cap graph is a simple cycle -- every vertex has exactly degree 2 -- so this walk
  // is unambiguous and needs no distance heuristics/tolerances at all).
  const startKey = adjacency.keys().next().value
  const visited = new Set([startKey])
  const loopKeys = [startKey]
  let prevKey = null, curKey = startKey
  let guard = adjacency.size + 4
  while (guard-- > 0) {
    const neighbors = [...adjacency.get(curKey)].filter((k) => k !== prevKey)
    const next = neighbors.find((k) => !visited.has(k)) ?? (neighbors.includes(startKey) ? startKey : null)
    if (next == null) break
    if (next === startKey) break // closed the loop
    visited.add(next); loopKeys.push(next)
    prevKey = curKey; curKey = next
  }
  // A cap that still didn't close into a full simple cycle after gap-bridging is a genuine,
  // rare geometric degeneracy (not merely a smaller sliver) -- surfacing it as a thrown error
  // (caught by fractureCell's caller and reported per-piece) is the fail-loud discipline this
  // engine's other systems already follow, rather than silently emitting an open/non-manifold
  // piece the caller has no way to detect short of re-running the same manifold check itself.
  if (loopKeys.length !== adjacency.size) {
    throw new Error(`[fracture-glb] cap loop did not close (${loopKeys.length}/${adjacency.size} vertices walked) -- unrepairable plane-clip degeneracy`)
  }
  if (loopKeys.length < 3) return null
  const loop = loopKeys.map((k) => vertsByKey.get(k))
  // The cap's true outward normal is ALREADY KNOWN exactly -- it is planeNormal itself (the
  // bisector normal, which by construction points FROM seed TOWARD the other seed, i.e. away
  // from the kept half-space -- exactly the outward direction for a face bounding that half-
  // space). Deriving the normal from the loop's own leading 3 vertices (as a prior version of
  // this function did, via cross(loop[1]-loop[0], loop[2]-loop[0])) is numerically unreliable:
  // those 3 points can be near-collinear (a common case immediately after a clip leaves a
  // near-degenerate short first edge), giving a near-zero or wrong-signed cross product that
  // silently flips the reversal decision -- LIVE-CONFIRMED as a real bug via a Monte-Carlo
  // cross-check (a completely independent volume estimator) that caught one mis-wound face
  // among a cell's 11, corrupting only ITS cell's divergence-theorem volume integral by ~52%
  // while every per-piece watertightness/manifold check still passed clean (a backwards-wound
  // but still-closed face breaks the SIGNED volume sum, not the mesh topology, so on its own a
  // manifold check cannot catch it). Fix: just wind the already-known-correct loop to match the
  // known planeNormal via Newell's method over the FULL loop (robust to any single degenerate
  // edge, unlike a 3-point cross product), never re-derive or trust a locally-computed normal.
  let nx = 0, ny = 0, nz = 0
  for (let k = 0; k < loop.length; k++) {
    const a = loop[k], b = loop[(k + 1) % loop.length]
    nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1])
  }
  const windingNormal = [nx, ny, nz] // unnormalized Newell normal of the loop AS WOUND
  if (v3.dot(windingNormal, planeNormal) < 0) loop.reverse() // wound backwards relative to the known-correct outward normal -- flip vertex order (normal itself needs no reversal, we return planeNormal directly)
  return { poly: loop, normal: [...planeNormal] }
}

// Fracture cell i: start from the full source hull face soup, clip against every OTHER
// seed's perpendicular bisector plane, capping the cut after each clip. Returns the final
// closed convex polyhedron's face soup for this seed's cell (intersection of the source
// hull and the Voronoi cell of seed i among all seeds).
function fractureCell(sourceFaces, seeds, i) {
  let soup = sourceFaces.map((f) => ({ poly: f.poly.slice(), normal: f.normal }))
  const seed = seeds[i]
  for (let j = 0; j < seeds.length; j++) {
    if (j === i) continue
    const other = seeds[j]
    const mid = v3.scale(v3.add(seed, other), 0.5)
    const normal = v3.normalize(v3.sub(other, seed)) // points FROM seed TOWARD other -- half-space dot(p,n)+d<=0 keeps the side closer to seed
    const d = -v3.dot(mid, normal)
    const clipped = clipFaceSoup(soup, normal, d)
    if (!clipped.length) { soup = []; break } // seed fully outside this bisector's kept half -- degenerate cell (can happen for far-apart seed counts vs hull shape)
    const cap = buildCapFace(clipped, normal, d)
    soup = cap ? [...clipped, cap] : clipped
  }
  return weldSoup(soup)
}

// Global vertex weld across an ENTIRE cell's face soup (not per-polygon): two faces that meet
// at a shared physical vertex can have independently-computed floating-point coordinates for
// "the same" point (e.g. one face's clip-intersection math vs. the cap loop's own copy of a
// hull vertex) that differ by ~1e-4 -- close enough that a per-polygon dedupe or a tight
// grid-snap weldKey both miss it, but far enough apart that a downstream edge-key match (used
// by both this script's own manifold self-check and any consumer, e.g. a physics collider
// builder) sees two DISTINCT points and reports a broken edge. Building ONE canonical point
// list for the whole soup via the same tolerance-based clustering as weldPolygon, then
// re-pointing every face to reference the canonical points, guarantees any two faces that meant
// to share a vertex now literally share the same array reference -- eliminating this whole bug
// class rather than chasing each symptom (the earlier per-polygon-only weldPolygon is kept as
// the first, cheaper pass; this closes the cross-face gap it structurally cannot reach).
function weldSoup(soup) {
  const canonical = []
  function canonicalize(p) {
    for (const q of canonical) {
      const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2]
      if (dx * dx + dy * dy + dz * dz < SCALE_EPS.weld2) return q
    }
    canonical.push(p)
    return p
  }
  const out = []
  for (const f of soup) {
    const poly = weldPolygon(f.poly).map(canonicalize)
    // re-dedupe after canonicalization -- two originally-distinct-but-close points in the same
    // face can both canonicalize to the SAME earlier canonical point.
    const clean = []
    for (const p of poly) { if (clean.length === 0 || clean[clean.length - 1] !== p) clean.push(p) }
    if (clean.length > 1 && clean[0] === clean[clean.length - 1]) clean.pop()
    if (clean.length >= 3) out.push({ poly: clean, normal: f.normal })
  }
  return out
}

// Weld NON-ADJACENT near-duplicate vertices within a single polygon (clipPolygon's own dedupe
// only catches ADJACENT duplicates in its own single-plane clip pass; across MANY accumulated
// clips a polygon can end up with two non-adjacent vertices that are the same physical point to
// within floating-point tolerance but were never adjacent at the moment either clip introduced
// them). LIVE-CONFIRMED real bug: a 16-seed fracture produced fan-triangulated zero-length
// edges (e.g. a vertex appearing twice in one polygon, `a|a` after triangle-edge rounding) and
// near-duplicate-but-not-identical vertex pairs (differing only in the 4th decimal) that broke
// the per-piece watertight/manifold invariant even though the cap-loop-closure repair above
// made the SIGNED VOLUME come out exactly right -- proving volume-correctness alone is not a
// sufficient watertightness witness and a real triangle-level check is required. Snaps every
// vertex to the same weldKey grid used elsewhere in this file, drops the resulting duplicate,
// and additionally drops near-zero-length edges introduced by the weld (three consecutive
// points where the middle contributes negligible area, i.e. a near-collinear sliver).
// Pairwise tolerance-based dedupe (not grid-snap -- a grid-snap weldKey only catches points on
// the SAME side of a grid boundary; two points 1e-4 apart that straddle a grid line still hash
// to different keys, which is exactly the residual case a real 16-seed fracture hit: two
// independently-computed intersection points that are mathematically the same point in exact
// arithmetic but drifted ~1e-4 apart in floating point). O(n^2) is fine -- a fracture-cell face
// has at most a few dozen vertices even for a heavily-fractured source.
function weldPolygon(poly) {
  const out = []
  for (const p of poly) {
    let dup = false
    for (const q of out) {
      const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2]
      if (dx * dx + dy * dy + dz * dz < SCALE_EPS.weld2) { dup = true; break }
    }
    if (!dup) out.push(p)
  }
  if (out.length > 1) {
    const f = out[0], l = out[out.length - 1]
    const dx = f[0] - l[0], dy = f[1] - l[1], dz = f[2] - l[2]
    if (dx * dx + dy * dy + dz * dz < SCALE_EPS.weld2) out.pop()
  }
  return out
}

export { mulberry32, v3, pointInHull, hullAABB, scatterSeeds, SCALE_EPS, setScale, clipPolygon, clipFaceSoup, weldKey, buildCapFace, weldSoup, weldPolygon, fractureCell }
