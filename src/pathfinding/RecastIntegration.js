import { init } from 'recast-navigation'
import { generateSoloNavMesh } from 'recast-navigation/generators'

export const NAVMESH_FORMAT_VERSION = 1
const RC_MESH_NULL_IDX = 0xffff
const RC_PORTAL_FLAG = 0x8000

export const DEFAULT_AGENT = { cellSize: 0.3, cellHeight: 0.2, agentHeight: 1.7, agentRadius: 0.4, agentMaxClimb: 0.5, agentMaxSlope: 45, regionMinSize: 8, regionMergeSize: 20, maxVertsPerPoly: 6, detailSampleDist: 6, detailSampleMaxError: 1 }

let _ready = null

export async function bakeNavmesh({ positions, indices, ...overrides }) {
  if (!(positions?.length >= 9) || positions.length % 3 !== 0) throw new TypeError(`bakeNavmesh: positions must be a flat xyz array with at least one triangle, got length ${positions?.length}`)
  if (!(indices?.length >= 3) || indices.length % 3 !== 0) throw new TypeError(`bakeNavmesh: indices must be a flat triangle list, got length ${indices?.length}`)
  const a = { ...DEFAULT_AGENT, ...overrides }
  await (_ready || (_ready = init()))
  const rc = {
    cs: a.cellSize, ch: a.cellHeight, walkableSlopeAngle: a.agentMaxSlope,
    walkableHeight: Math.ceil(a.agentHeight / a.cellHeight),
    walkableClimb: Math.floor(a.agentMaxClimb / a.cellHeight),
    walkableRadius: Math.ceil(a.agentRadius / a.cellSize),
    minRegionArea: a.regionMinSize, mergeRegionArea: a.regionMergeSize, maxVertsPerPoly: a.maxVertsPerPoly,
    detailSampleDist: a.detailSampleDist, detailSampleMaxError: a.detailSampleMaxError,
  }
  const res = generateSoloNavMesh(positions, indices, rc, true)
  try {
    if (!res.success) throw new Error(`recast solo navmesh generation failed: ${res.error}`)
    return polyMeshToJSON(res.intermediates.polyMesh, rc)
  } finally {
    res.navMesh?.destroy?.()
  }
}

function polyMeshToJSON(pm, rc) {
  const cs = pm.cs(), ch = pm.ch(), bmin = pm.bmin(), bmax = pm.bmax(), nvp = pm.nvp()
  const vertices = new Array(pm.nverts())
  for (let i = 0; i < vertices.length; i++) vertices[i] = [bmin.x + pm.verts(i * 3) * cs, bmin.y + pm.verts(i * 3 + 1) * ch, bmin.z + pm.verts(i * 3 + 2) * cs]
  const polygons = [], links = []
  for (let p = 0, np = pm.npolys(); p < np; p++) {
    const base = p * nvp * 2, verts = [], neighbors = []
    for (let j = 0; j < nvp; j++) {
      const v = pm.polys(base + j)
      if (v === RC_MESH_NULL_IDX) break
      verts.push(v)
      const n = pm.polys(base + nvp + j)
      if (n !== RC_MESH_NULL_IDX && !(n & RC_PORTAL_FLAG)) neighbors.push(n)
    }
    polygons.push({ vertices: verts.reverse(), flags: pm.flags(p), area: pm.areas(p) })
    if (neighbors.length) links.push({ polygon: p, neighbors })
  }
  return {
    version: NAVMESH_FORMAT_VERSION,
    config: { cellSize: cs, cellHeight: ch, agentHeight: rc.walkableHeight * ch, agentRadius: rc.walkableRadius * cs, agentMaxClimb: rc.walkableClimb * ch, agentMaxSlope: rc.walkableSlopeAngle },
    bounds: { min: [bmin.x, bmin.y, bmin.z], max: [bmax.x, bmax.y, bmax.z] },
    vertices, polygons, links,
  }
}
