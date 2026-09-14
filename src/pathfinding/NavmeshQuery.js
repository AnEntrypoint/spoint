const NO_POLY = -1
const INSIDE_EPS = 1e-3
const PATH_CACHE_ENTRIES = 100

function cross2(ax, az, bx, bz, cx, cz) { return (bx - ax) * (cz - az) - (bz - az) * (cx - ax) }

class NavmeshQuery {
  constructor(navmeshData) {
    const { vertices, polygons, links = [] } = navmeshData
    this.data = navmeshData
    this.vertices = vertices
    this.polygons = polygons
    this.bounds = navmeshData.bounds
    this.config = navmeshData.config || {}
    const n = polygons.length
    this.neighbors = Array.from({ length: n }, () => [])
    for (const l of links) if (l.polygon >= 0 && l.polygon < n) this.neighbors[l.polygon] = l.neighbors.filter(k => k >= 0 && k < n && k !== l.polygon)
    this.centroids = new Float64Array(n * 3)
    this.boxes = new Float64Array(n * 4)
    for (let i = 0; i < n; i++) {
      const vs = polygons[i].vertices
      let x = 0, y = 0, z = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
      for (const vi of vs) {
        const v = vertices[vi]
        x += v[0]; y += v[1]; z += v[2]
        if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0]
        if (v[2] < minZ) minZ = v[2]; if (v[2] > maxZ) maxZ = v[2]
      }
      this.centroids.set([x / vs.length, y / vs.length, z / vs.length], i * 3)
      this.boxes.set([minX, maxX, minZ, maxZ], i * 4)
    }
    this.pathCache = new Map()
  }

  findPath(start, goal) {
    const key = start.map(v => v.toFixed(2)).join(',') + '_' + goal.map(v => v.toFixed(2)).join(',')
    let path = this.pathCache.get(key)
    if (path === undefined) {
      path = this._solve(start, goal)
      this.pathCache.set(key, path)
      if (this.pathCache.size > PATH_CACHE_ENTRIES) this.pathCache.delete(this.pathCache.keys().next().value)
    }
    return path && path.map(p => [...p])
  }

  locate(point) {
    let best = NO_POLY, bestDy = Infinity
    for (let i = 0; i < this.polygons.length; i++) {
      if (!this._contains(point, i)) continue
      const dy = Math.abs(point[1] - this.centroids[i * 3 + 1])
      if (dy < bestDy) { bestDy = dy; best = i }
    }
    return best
  }

  clearCache() { this.pathCache.clear() }

  _contains(p, i) {
    const b = this.boxes, o = i * 4
    if (p[0] < b[o] || p[0] > b[o + 1] || p[2] < b[o + 2] || p[2] > b[o + 3]) return false
    const vs = this.polygons[i].vertices, V = this.vertices
    for (let j = 0; j < vs.length; j++) {
      const a = V[vs[j]], c = V[vs[(j + 1) % vs.length]]
      if (cross2(a[0], a[2], c[0], c[2], p[0], p[2]) < -INSIDE_EPS) return false
    }
    return true
  }

  _solve(start, goal) {
    const s = this.locate(start), g = this.locate(goal)
    if (s === NO_POLY || g === NO_POLY) return null
    const corridor = this._corridor(s, g)
    if (!corridor) return null
    return this._funnel(start, goal, corridor)
  }

  _dist(a, b) {
    const C = this.centroids
    return Math.hypot(C[a * 3] - C[b * 3], C[a * 3 + 1] - C[b * 3 + 1], C[a * 3 + 2] - C[b * 3 + 2])
  }

  _corridor(s, g) {
    if (s === g) return [s]
    const n = this.polygons.length
    const cost = new Float64Array(n).fill(Infinity), from = new Int32Array(n).fill(NO_POLY), closed = new Uint8Array(n)
    const heap = []
    const push = (node, f) => { heap.push([f, node]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p } }
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m } } return top[1] }
    cost[s] = 0
    push(s, this._dist(s, g))
    while (heap.length) {
      const cur = pop()
      if (closed[cur]) continue
      if (cur === g) {
        const out = [g]
        for (let c = g; from[c] !== NO_POLY; c = from[c]) out.push(from[c])
        return out.reverse()
      }
      closed[cur] = 1
      for (const nb of this.neighbors[cur]) {
        if (closed[nb]) continue
        const t = cost[cur] + this._dist(cur, nb)
        if (t < cost[nb]) { cost[nb] = t; from[nb] = cur; push(nb, t + this._dist(nb, g)) }
      }
    }
    return null
  }

  _portal(a, b) {
    const va = this.polygons[a].vertices, vb = new Set(this.polygons[b].vertices)
    for (let j = 0; j < va.length; j++) {
      const p = va[j], q = va[(j + 1) % va.length]
      if (vb.has(p) && vb.has(q)) return { left: this.vertices[q], right: this.vertices[p] }
    }
    throw new Error(`navmesh polygons ${a} and ${b} are linked but share no edge`)
  }

  _funnel(start, goal, corridor) {
    const portals = [{ left: start, right: start }]
    for (let i = 0; i + 1 < corridor.length; i++) portals.push(this._portal(corridor[i], corridor[i + 1]))
    portals.push({ left: goal, right: goal })
    const out = [[...start]]
    const emit = p => { const t = out[out.length - 1]; if (t[0] !== p[0] || t[1] !== p[1] || t[2] !== p[2]) out.push([...p]) }
    let apex = start, left = start, right = start, apexI = 0, leftI = 0, rightI = 0
    for (let i = 1; i < portals.length; i++) {
      const L = portals[i].left, R = portals[i].right
      if (cross2(apex[0], apex[2], right[0], right[2], R[0], R[2]) >= 0) {
        if (apex === right || cross2(apex[0], apex[2], left[0], left[2], R[0], R[2]) < 0) { right = R; rightI = i }
        else { emit(left); apex = left; apexI = leftI; right = left = apex; rightI = leftI = apexI; i = apexI; continue }
      }
      if (cross2(apex[0], apex[2], left[0], left[2], L[0], L[2]) <= 0) {
        if (apex === left || cross2(apex[0], apex[2], right[0], right[2], L[0], L[2]) > 0) { left = L; leftI = i }
        else { emit(right); apex = right; apexI = rightI; right = left = apex; rightI = leftI = apexI; i = apexI; continue }
      }
    }
    emit(goal)
    return out
  }
}

export { NavmeshQuery }
