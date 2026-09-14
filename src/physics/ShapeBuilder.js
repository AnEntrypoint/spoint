import { extractAllMeshesFromGLBAsync } from './GLBLoader.js'

export function buildConvexShape(J, params, shapeCache, cacheKey) {
  if (cacheKey && shapeCache.has(cacheKey)) return { shape: shapeCache.get(cacheKey), cached: true, sr: null }
  const pts = new J.VertexList(), f3 = new J.Float3(0, 0, 0)
  for (let i = 0; i < params.length; i += 3) { f3.x = params[i]; f3.y = params[i+1]; f3.z = params[i+2]; pts.push_back(f3) }
  J.destroy(f3)
  const cvx = new J.ConvexHullShapeSettings(); cvx.set_mPoints(pts)
  const sr = cvx.Create()
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
