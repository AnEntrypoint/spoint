import { extractMeshFromGLB } from '../physics/GLBLoader.js'

// Navmesh baking: uses Recast library (npm recast-navigation) to convert collision geometry
// into a navigable mesh, then serializes to JSON for runtime pathfinding queries.
//
// Design: input is a world GLB + collision geometry (from placed-model instances + terrain).
// Output is a navmesh JSON with vertices, polygons, and connectivity for A* queries.
//
// This module handles the Node.js baking pipeline only, not runtime queries (see NavmeshQuery.js).
// Node.js only: uses require/import of recast-navigation npm package.

let Recast = null
let NavMesh = null

export async function initRecast() {
  if (Recast) return
  try {
    // Try to import recast-navigation from npm
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
    // Load GLB and extract collision geometry
    const mesh = extractMeshFromGLB(glbPath, 0)

    if (!mesh.vertices || !mesh.indices) {
      throw new Error(`No valid geometry in ${glbPath}`)
    }

    // Create Recast config
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

    // Build Recast heightfield and navmesh
    const context = new Recast.RecastContext(false)
    const heightfield = Recast.rcAllocHeightfield()
    const compactHeightfield = Recast.rcAllocCompactHeightfield()
    const contourSet = Recast.rcAllocContourSet()
    const polyMesh = Recast.rcAllocPolyMesh()
    const polyMeshDetail = Recast.rcAllocPolyMeshDetail()

    // Rasterize input geometry
    const verts = mesh.vertices
    const tris = mesh.indices

    if (!Recast.rcCreateHeightfield(context, heightfield, config.width, config.height, config.bmin, config.bmax, config.cs, config.ch)) {
      throw new Error('Failed to create heightfield')
    }

    if (!Recast.rcRasterizeTriangles(context, verts, verts.length / 3, tris, tris.length / 3, heightfield)) {
      throw new Error('Failed to rasterize triangles')
    }

    // Filter unwalkable regions
    if (!Recast.rcFilterLowHangingWalkableObstacles(context, config.walkableClimb, heightfield)) {
      throw new Error('Failed to filter obstacles')
    }
    if (!Recast.rcFilterLedgeSpans(context, config.walkableHeight, config.walkableClimb, heightfield)) {
      throw new Error('Failed to filter ledges')
    }
    if (!Recast.rcFilterWalkableLowHeightSpans(context, config.walkableHeight, heightfield)) {
      throw new Error('Failed to filter low spans')
    }

    // Compact heightfield
    if (!Recast.rcBuildCompactHeightfield(context, config.walkableHeight, config.walkableClimb, heightfield, compactHeightfield)) {
      throw new Error('Failed to build compact heightfield')
    }

    // Erode walkable area
    if (!Recast.rcErodeWalkableArea(context, config.walkableRadius, compactHeightfield)) {
      throw new Error('Failed to erode walkable area')
    }

    // Partition walkable surface into regions
    if (!Recast.rcBuildDistanceField(context, compactHeightfield)) {
      throw new Error('Failed to build distance field')
    }
    if (!Recast.rcBuildRegions(context, compactHeightfield, 0, config.minRegionArea, config.mergeRegionArea)) {
      throw new Error('Failed to build regions')
    }

    // Trace and simplify region boundaries
    if (!Recast.rcBuildContours(context, compactHeightfield, config.walkableMaxSlope, config.maxVertsPerPoly, contourSet)) {
      throw new Error('Failed to build contours')
    }

    // Build polygon mesh
    if (!Recast.rcBuildPolyMesh(context, contourSet, config.maxVertsPerPoly, polyMesh)) {
      throw new Error('Failed to build poly mesh')
    }

    // Build detailed mesh
    if (!Recast.rcBuildPolyMeshDetail(context, polyMesh, compactHeightfield, detailSampleDist, detailSampleMaxError, polyMeshDetail)) {
      throw new Error('Failed to build poly mesh detail')
    }

    // Extract mesh data to JSON
    const navmeshData = extractNavmeshJSON(polyMesh, polyMeshDetail, config)

    // Cleanup
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
  // Serialize Recast output to JSON format for runtime queries
  const vertices = []
  const polygons = []
  const links = []

  // Extract vertices from polyMesh
  const verts = Recast.getPolyMeshVerts(polyMesh)
  for (let i = 0; i < verts.length; i += 3) {
    vertices.push([verts[i], verts[i + 1], verts[i + 2]])
  }

  // Extract polygons and connectivity
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

      // Extract neighbor links
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
