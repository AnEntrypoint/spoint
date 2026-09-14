class NavmeshQuery {
  constructor(navmeshData) {
    this.data = navmeshData
    this.vertices = navmeshData.vertices
    this.polygons = navmeshData.polygons
    this.links = navmeshData.links || []
    this.bounds = navmeshData.bounds
    this.config = navmeshData.config || {}

    this.neighborMap = new Map()
    for (const link of this.links) {
      this.neighborMap.set(link.polygon, link.neighbors)
    }

    this.pathCache = new Map()
    this.cacheOrder = []
    this.maxCacheEntries = 100
  }

  findPath(start, goal, config = {}) {
    const cacheKey = `${start.map(x => x.toFixed(2)).join(',')}_${goal.map(x => x.toFixed(2)).join(',')}`

    if (this.pathCache.has(cacheKey)) {
      return this.pathCache.get(cacheKey)
    }

    const startPoly = this._findPolygonContaining(start)
    const goalPoly = this._findPolygonContaining(goal)

    if (startPoly === -1 || goalPoly === -1) {
      return null
    }

    const path = this._astarSearch(startPoly, goalPoly, start, goal, config)

    if (!path) {
      return null
    }

    const pulled = this._pullPath(path, start, goal)

    this._cacheResult(cacheKey, pulled)

    return pulled
  }

  _findPolygonContaining(point) {
    for (let i = 0; i < this.polygons.length; i++) {
      if (this._pointInPolygon(point, i)) {
        return i
      }
    }
    return -1
  }

  _pointInPolygon(point, polyIdx) {
    if (polyIdx < 0 || polyIdx >= this.polygons.length) return false
    const poly = this.polygons[polyIdx]
    if (!poly || !poly.vertices || poly.vertices.length < 3) return false
    if (!this.vertices || this.vertices.length === 0) return false

    const verts = poly.vertices
      .map(vi => {
        if (vi >= 0 && vi < this.vertices.length) {
          return this.vertices[vi]
        }
        return null
      })
      .filter(v => v !== null)

    if (verts.length < 3) return false

    let cx = 0, cz = 0
    for (const v of verts) {
      cx += v[0]
      cz += v[2]
    }
    cx /= verts.length
    cz /= verts.length

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const v of verts) {
      minX = Math.min(minX, v[0])
      maxX = Math.max(maxX, v[0])
      minZ = Math.min(minZ, v[2])
      maxZ = Math.max(maxZ, v[2])
    }

    if (point[0] < minX || point[0] > maxX || point[2] < minZ || point[2] > maxZ) {
      return false
    }

    const px = point[0], pz = point[2]
    for (let i = 0; i < verts.length; i++) {
      const v1 = verts[i]
      const v2 = verts[(i + 1) % verts.length]
      const cross = (v2[0] - v1[0]) * (pz - v1[2]) - (v2[2] - v1[2]) * (px - v1[0])
      if (cross < -0.001) return false
    }
    return true
  }

  _astarSearch(startPoly, goalPoly, startPos, goalPos, config = {}) {
    if (startPoly === goalPoly) {
      return [startPoly, goalPoly]
    }

    const openSet = new Set([startPoly])
    const cameFrom = new Map()
    const gScore = new Map()
    const fScore = new Map()

    gScore.set(startPoly, 0)
    const h = this._heuristic(startPoly, goalPoly)
    fScore.set(startPoly, h)

    while (openSet.size > 0) {
      let current = -1
      let lowestF = Infinity
      for (const node of openSet) {
        const f = fScore.get(node) || Infinity
        if (f < lowestF) {
          lowestF = f
          current = node
        }
      }

      if (current === goalPoly) {
        const path = [goalPoly]
        let c = current
        while (cameFrom.has(c)) {
          c = cameFrom.get(c)
          path.unshift(c)
        }
        return path
      }

      openSet.delete(current)

      const neighbors = this.neighborMap.get(current) || []
      for (const neighbor of neighbors) {
        if (neighbor < 0 || neighbor >= this.polygons.length) continue

        const tentativeG = (gScore.get(current) || 0) + this._polygonDistance(current, neighbor)
        const neighborG = gScore.get(neighbor) || Infinity

        if (tentativeG < neighborG) {
          cameFrom.set(neighbor, current)
          gScore.set(neighbor, tentativeG)
          const heur = this._heuristic(neighbor, goalPoly)
          fScore.set(neighbor, tentativeG + heur)
          openSet.add(neighbor)
        }
      }
    }

    return null
  }

  _heuristic(polyA, polyB) {
    const centroidA = this._polygonCentroid(polyA)
    const centroidB = this._polygonCentroid(polyB)
    const dx = centroidB[0] - centroidA[0]
    const dz = centroidB[2] - centroidA[2]
    return Math.sqrt(dx * dx + dz * dz)
  }

  _polygonDistance(polyA, polyB) {
    const centroidA = this._polygonCentroid(polyA)
    const centroidB = this._polygonCentroid(polyB)
    const dx = centroidB[0] - centroidA[0]
    const dz = centroidB[2] - centroidA[2]
    return Math.sqrt(dx * dx + dz * dz)
  }

  _polygonCentroid(polyIdx) {
    const poly = this.polygons[polyIdx]
    if (!poly.vertices || poly.vertices.length === 0) return [0, 0, 0]

    let x = 0, y = 0, z = 0
    for (const vi of poly.vertices) {
      const v = this.vertices[vi]
      x += v[0]
      y += v[1]
      z += v[2]
    }
    const len = poly.vertices.length
    return [x / len, y / len, z / len]
  }

  _pullPath(polygonPath, startPos, goalPos) {
    const waypoints = [startPos]

    for (let i = 1; i < polygonPath.length; i++) {
      const polyIdx = polygonPath[i]
      const centroid = this._polygonCentroid(polyIdx)

      const lastWaypoint = waypoints[waypoints.length - 1]
      const canDirectTo = this._canWalkDirectly(lastWaypoint, centroid)

      if (!canDirectTo) {
        const prevCentroid = this._polygonCentroid(polygonPath[i - 1])
        waypoints.push(prevCentroid)
      }
    }

    waypoints.push(goalPos)
    return waypoints
  }

  _canWalkDirectly(from, to) {
    const fromPoly = this._findPolygonContaining(from)
    const toPoly = this._findPolygonContaining(to)
    return fromPoly >= 0 && toPoly >= 0
  }

  _cacheResult(key, result) {
    this.pathCache.set(key, result)
    this.cacheOrder.push(key)

    if (this.cacheOrder.length > this.maxCacheEntries) {
      const oldest = this.cacheOrder.shift()
      this.pathCache.delete(oldest)
    }
  }

  clearCache() {
    this.pathCache.clear()
    this.cacheOrder = []
  }
}

export { NavmeshQuery }
