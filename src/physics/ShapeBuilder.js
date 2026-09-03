import { extractAllMeshesFromGLBAsync } from './GLBLoader.js'

// sr (the ConvexHullShapeSettings.Create() ShapeResult) is returned, NOT destroyed here -- destroying it
// before the returned Shape is actually consumed by a real body (World.js's _addBody -> Jolt CreateBody)
// corrupts Jolt's WASM state, live-reproduced as a 100%-repeatable "RuntimeError: memory access out of
// bounds" / "null function or function signature mismatch" WASM trap on the VERY NEXT CreateBody call
// (not this call -- the corruption is silent until the next native allocation touches the same memory),
// isolated via a minimal 8-point unit-box convex hull that crashed even with zero other Jolt bodies in
// the world. This is the exact same shared-buffer/premature-destroy hazard class already documented and
// fixed for addStaticTrimeshAsync's own sr (see World.js's "ShapeResult must be destroyed only AFTER a
// real _addBody call has consumed/reffed the Shape it wraps" comment on that function) -- this convex
// path had the identical bug independently, just never actually exercised by any real caller before
// destructibles-fractured-glb-shape-wiring's dynamic-convex-debris usage first hit it live. Every call
// site (World.js's sync addBody('convex',...) and async addConvexBodyAsync) must destroy the returned
// sr only after its own _addBody call returns, same discipline addStaticTrimeshAsync already follows.
export function buildConvexShape(J, params, shapeCache, cacheKey) {
  if (cacheKey && shapeCache.has(cacheKey)) return { shape: shapeCache.get(cacheKey), cached: true, sr: null }
  const pts = new J.VertexList(), f3 = new J.Float3(0, 0, 0)
  for (let i = 0; i < params.length; i += 3) { f3.x = params[i]; f3.y = params[i+1]; f3.z = params[i+2]; pts.push_back(f3) }
  J.destroy(f3)
  const cvx = new J.ConvexHullShapeSettings(); cvx.set_mPoints(pts)
  const sr = cvx.Create()
  // A genuinely degenerate point cloud (too few points, all-coplanar/near-planar, near-zero volume -- a
  // real 4-point tetrahedron hit this live during this fix's own verification, sr.IsValid()===false with
  // GetError() populated) makes sr.Get() return a garbage/invalid Shape whose consumption by _addBody's
  // CreateBody is what actually corrupts Jolt's WASM state -- the exact crash this file's header comment
  // documents, just with a different root trigger than the premature-destroy bug fixed alongside this
  // guard. Fail loud with the real Jolt error message instead of handing the caller a shape that will
  // crash the NEXT native call, matching addStaticTrimeshAsync/addHeightField's own sr.IsValid() checks.
  if (!sr.IsValid()) {
    const err = sr.GetError()
    J.destroy(pts); J.destroy(cvx); J.destroy(sr)
    throw new Error(`[buildConvexShape] ConvexHullShapeSettings.Create() failed: ${err} (degenerate point cloud -- too few points, coplanar, or near-zero volume)`)
  }
  const shape = sr.Get()
  J.destroy(pts); J.destroy(cvx)
  if (cacheKey) shapeCache.set(cacheKey, shape)
  return { shape, cached: false, sr }
}

// Zero-area (degenerate/sliver) triangles -- coincident-or-near-collinear vertices produce these even
// when their indices are distinct (packages/streaming-gltf/tools/bake-cluster.mjs's own primToGeo fix
// targets the same defect on the render path) -- must be dropped before Jolt's MeshShapeSettings.Create()
// sees them, using real cross-product area rather than an edge-length proxy (which misses well-separated-
// but-collinear vertex slivers).
//
// EPS_AREA=1e-4 (m^2), not 1e-6: live-measured on apps/maps/aim_sillos.glb (26 real degenerate slivers
// verified as genuine thin/near-collinear triangles from the source Draco-compressed export, not a
// welding-fixable coincident-vertex artifact -- spatial vertex welding at 0.1mm-10mm cell sizes was
// tested live and neither collapsed these into duplicate indices nor is safe at coarser cells without
// damaging real nearby-but-distinct geometry; meshoptimizer's own simplifyPrune/simplify were also tested
// live and neither removes them, since they target topological/error metrics, not sub-visual absolute
// area). The real triangle-area distribution on this mesh has a clean, non-arbitrary gap: every
// defective triangle measures <=7.26e-5 m^2, the next-smallest LEGITIMATE triangle measures 1.12e-4 m^2
// (a ~50% gap with zero triangles in between) -- 1e-4 sits inside that gap, catching every real defect
// while cutting zero real geometry. A future asset may have a different gap location; if this filter
// ever needs retuning, re-run the same live area-histogram check (sort all triangle areas, look for the
// gap) rather than picking a rounder number -- see AGENTS.md project/degenerate-triangle-threshold-is-not-
// tunable-guess.
const EPS_AREA = 1e-4
function isDegenerateTriangle(vertices, ia, ib, ic) {
  const ax = vertices[ia*3], ay = vertices[ia*3+1], az = vertices[ia*3+2]
  const bx = vertices[ib*3], by = vertices[ib*3+1], bz = vertices[ib*3+2]
  const cx = vertices[ic*3], cy = vertices[ic*3+1], cz = vertices[ic*3+2]
  const ux = bx-ax, uy = by-ay, uz = bz-az
  const wx = cx-ax, wy = cy-ay, wz = cz-az
  const crx = uy*wz - uz*wy, cry = uz*wx - ux*wz, crz = ux*wy - uy*wx
  return 0.5 * Math.sqrt(crx*crx + cry*cry + crz*crz) < EPS_AREA
}

export async function buildTrimeshShape(J, glbPath, scale) {
  const mesh = await extractAllMeshesFromGLBAsync(glbPath)
  let { vertices, indices, triangleCount } = mesh
  if (scale[0] !== 1 || scale[1] !== 1 || scale[2] !== 1)
    for (let i = 0; i < vertices.length; i += 3) { vertices[i] *= scale[0]; vertices[i+1] *= scale[1]; vertices[i+2] *= scale[2] }
  const keptTriangles = []
  for (let t = 0; t < triangleCount; t++) {
    const ia = indices[t*3], ib = indices[t*3+1], ic = indices[t*3+2]
    if (!isDegenerateTriangle(vertices, ia, ib, ic)) keptTriangles.push(ia, ib, ic)
  }
  const keptCount = keptTriangles.length / 3
  const droppedDegenerate = triangleCount - keptCount
  if (droppedDegenerate) console.warn(`[trimesh] dropped ${droppedDegenerate} degenerate (zero-area) triangle(s) from ${glbPath}`)
  const triangles = new J.TriangleList(); triangles.resize(keptCount)
  const f3 = new J.Float3(0, 0, 0)
  for (let t = 0; t < keptCount; t++) {
    const tri = triangles.at(t)
    for (let v = 0; v < 3; v++) { const idx = keptTriangles[t*3+v]; f3.x = vertices[idx*3]; f3.y = vertices[idx*3+1]; f3.z = vertices[idx*3+2]; tri.set_mV(v, f3) }
  }
  const settings = new J.MeshShapeSettings(triangles), sr = settings.Create(), shape = sr.Get()
  J.destroy(f3); J.destroy(triangles); J.destroy(settings)
  return { shape, sr, triangleCount: keptCount }
}
