import { extractAllMeshesFromGLBAsync } from './GLBLoader.js'

export function buildConvexShape(J, params, shapeCache, cacheKey) {
  if (cacheKey && shapeCache.has(cacheKey)) return { shape: shapeCache.get(cacheKey), cached: true }
  const pts = new J.VertexList(), f3 = new J.Float3(0, 0, 0)
  for (let i = 0; i < params.length; i += 3) { f3.x = params[i]; f3.y = params[i+1]; f3.z = params[i+2]; pts.push_back(f3) }
  J.destroy(f3)
  const cvx = new J.ConvexHullShapeSettings(); cvx.set_mPoints(pts)
  const sr = cvx.Create(), shape = sr.Get()
  J.destroy(pts); J.destroy(cvx)
  if (cacheKey) shapeCache.set(cacheKey, shape); else J.destroy(sr)
  return { shape, cached: false }
}

export async function buildTrimeshShape(J, glbPath, scale) {
  const mesh = await extractAllMeshesFromGLBAsync(glbPath)
  let { vertices, indices, triangleCount } = mesh
  if (scale[0] !== 1 || scale[1] !== 1 || scale[2] !== 1)
    for (let i = 0; i < vertices.length; i += 3) { vertices[i] *= scale[0]; vertices[i+1] *= scale[1]; vertices[i+2] *= scale[2] }
  const triangles = new J.TriangleList(); triangles.resize(triangleCount)
  const f3 = new J.Float3(0, 0, 0)
  for (let t = 0; t < triangleCount; t++) {
    const tri = triangles.at(t)
    for (let v = 0; v < 3; v++) { const idx = indices[t*3+v]; f3.x = vertices[idx*3]; f3.y = vertices[idx*3+1]; f3.z = vertices[idx*3+2]; tri.set_mV(v, f3) }
  }
  const settings = new J.MeshShapeSettings(triangles), sr = settings.Create(), shape = sr.Get()
  J.destroy(f3); J.destroy(triangles); J.destroy(settings)
  return { shape, sr, triangleCount }
}
