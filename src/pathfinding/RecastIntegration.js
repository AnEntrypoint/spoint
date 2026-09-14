import { extractMeshFromGLB } from '../physics/GLBLoader.js'

let Recast = null
let NavMesh = null

export async function initRecast() {
  if (Recast) return
  try {
    const mod = await import('recast-navigation')
    Recast = mod.Recast
    NavMesh = mod.NavMesh
  } catch (e) {
    throw new Error('recast-navigation npm package not found. Install with: npm install recast-navigation')
  }
}

export async function bakeNavmesh(options = {}) {
  await initRecast()

  const {
    glbPath,
    worldBounds = [[-1000, -100, -1000], [1000, 1000, 1000]],
    cellSize = 0.3,
    cellHeight = 0.2,
    agentHeight = 1.7,
    agentRadius = 0.4,
    agentMaxClimb = 0.5,
    agentMaxSlope = 45,
    regionMinSize = 8,
    regionMergeSize = 20,
    maxVertsPerPoly = 6,
    tileSize = 32,
    detailSampleDist = 6,
    detailSampleMaxError = 1,
  } = options

  try {
    const mesh = extractMeshFromGLB(glbPath, 0)

    if (!mesh.vertices || !mesh.indices) {
      throw new Error(`No valid geometry in ${glbPath}`)
    }

    const config = new Recast.RecastConfig()
    config.cs = cellSize
    config.ch = cellHeight
    config.walkableHeight = Math.ceil(agentHeight / cellHeight)
    config.walkableClimb = Math.ceil(agentMaxClimb / cellHeight)
    config.walkableRadius = Math.ceil(agentRadius / cellSize)
    config.walkableSlopeAngle = agentMaxSlope
    config.minRegionArea = regionMinSize
    config.mergeRegionArea = regionMergeSize
    config.maxVertsPerPoly = maxVertsPerPoly
    config.detailSampleDist = detailSampleDist
    config.detailSampleMaxError = detailSampleMaxError
    config.borderSize = 0
    config.width = tileSize
    config.height = tileSize
    config.bmin = worldBounds[0]
    config.bmax = worldBounds[1]

    const context = new Recast.RecastContext(false)
    const heightfield = Recast.rcAllocHeightfield()
    const compactHeightfield = Recast.rcAllocCompactHeightfield()
    const contourSet = Recast.rcAllocContourSet()
    const polyMesh = Recast.rcAllocPolyMesh()
    const polyMeshDetail = Recast.rcAllocPolyMeshDetail()

    const verts = mesh.vertices
    const tris = mesh.indices

    if (!Recast.rcCreateHeightfield(context, heightfield, config.width, config.height, config.bmin, config.bmax, config.cs, config.ch)) {
      throw new Error('Failed to create heightfield')
    }

    if (!Recast.rcRasterizeTriangles(context, verts, verts.length / 3, tris, tris.length / 3, heightfield)) {
      throw new Error('Failed to rasterize triangles')
    }

    if (!Recast.rcFilterLowHangingWalkableObstacles(context, config.walkableClimb, heightfield)) {
      throw new Error('Failed to filter obstacles')
    }
    if (!Recast.rcFilterLedgeSpans(context, config.walkableHeight, config.walkableClimb, heightfield)) {
      throw new Error('Failed to filter ledges')
    }
    if (!Recast.rcFilterWalkableLowHeightSpans(context, config.walkableHeight, heightfield)) {
      throw new Error('Failed to filter low spans')
    }

    if (!Recast.rcBuildCompactHeightfield(context, config.walkableHeight, config.walkableClimb, heightfield, compactHeightfield)) {
      throw new Error('Failed to build compact heightfield')
    }

    if (!Recast.rcErodeWalkableArea(context, config.walkableRadius, compactHeightfield)) {
      throw new Error('Failed to erode walkable area')
    }

    if (!Recast.rcBuildDistanceField(context, compactHeightfield)) {
      throw new Error('Failed to build distance field')
    }
    if (!Recast.rcBuildRegions(context, compactHeightfield, 0, config.minRegionArea, config.mergeRegionArea)) {
      throw new Error('Failed to build regions')
    }

    if (!Recast.rcBuildContours(context, compactHeightfield, config.walkableMaxSlope, config.maxVertsPerPoly, contourSet)) {
      throw new Error('Failed to build contours')
    }

    if (!Recast.rcBuildPolyMesh(context, contourSet, config.maxVertsPerPoly, polyMesh)) {
      throw new Error('Failed to build poly mesh')
    }

    if (!Recast.rcBuildPolyMeshDetail(context, polyMesh, compactHeightfield, detailSampleDist, detailSampleMaxError, polyMeshDetail)) {
      throw new Error('Failed to build poly mesh detail')
    }

    const navmeshData = extractNavmeshJSON(polyMesh, polyMeshDetail, config)

    Recast.rcFreeHeightField(heightfield)
    Recast.rcFreeCompactHeightfield(compactHeightfield)
    Recast.rcFreeContourSet(contourSet)
    Recast.rcFreePolyMesh(polyMesh)
    Recast.rcFreePolyMeshDetail(polyMeshDetail)

    return navmeshData
  } catch (e) {
    console.error('Navmesh baking failed:', e.message)
    throw e
  }
}

function extractNavmeshJSON(polyMesh, polyMeshDetail, config) {
  const vertices = []
  const polygons = []
  const links = []

  const verts = Recast.getPolyMeshVerts(polyMesh)
  for (let i = 0; i < verts.length; i += 3) {
    vertices.push([verts[i], verts[i + 1], verts[i + 2]])
  }

  const polys = Recast.getPolyMeshPolys(polyMesh)
  const polyFlags = Recast.getPolyMeshFlags(polyMesh)
  const polyAreas = Recast.getPolyMeshAreas(polyMesh)
  const nvp = Recast.getPolyMeshNvp(polyMesh)

  for (let i = 0; i < polys.length; i += nvp) {
    const poly = []
    const neighbors = []

    for (let j = 0; j < nvp; j++) {
      const vi = polys[i + j]
      if (vi === 0xffff) break
      poly.push(vi)

      const neighborIdx = polys[i + nvp + j]
      if (neighborIdx !== 0) {
        neighbors.push(neighborIdx - 1)
      }
    }

    if (poly.length >= 3) {
      polygons.push({
        vertices: poly,
        flags: polyFlags ? polyFlags[i / nvp] : 0,
        area: polyAreas ? polyAreas[i / nvp] : 0,
      })

      if (neighbors.length > 0) {
        links.push({
          polygon: polygons.length - 1,
          neighbors: neighbors,
        })
      }
    }
  }

  return {
    version: 1,
    config: {
      cellSize: config.cs,
      cellHeight: config.ch,
      agentHeight: config.walkableHeight * config.ch,
      agentRadius: config.walkableRadius * config.cs,
      agentMaxClimb: config.walkableClimb * config.ch,
      agentMaxSlope: config.walkableSlopeAngle,
    },
    bounds: {
      min: config.bmin,
      max: config.bmax,
    },
    vertices: vertices,
    polygons: polygons,
    links: links,
  }
}
