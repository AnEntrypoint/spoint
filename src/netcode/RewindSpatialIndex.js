export const REWIND_SLOP = 10

export class RewindSpatialIndex {
  constructor(cellSize = 16) {
    this.cellSize = cellSize
    this.cells = new Map()
    this._arrayIndex = new Map()
    this.playersById = new Map()
  }

  static _key(cx, cy, cz) { return cx + ',' + cy + ',' + cz }

  _cellOf(pos) {
    const s = this.cellSize
    return [Math.floor(pos[0] / s), Math.floor(pos[1] / s), Math.floor(pos[2] / s)]
  }

  insert(id, pos, margin = REWIND_SLOP) {
    const s = this.cellSize
    const loX = Math.floor((pos[0] - margin) / s), hiX = Math.floor((pos[0] + margin) / s)
    const loY = Math.floor((pos[1] - margin) / s), hiY = Math.floor((pos[1] + margin) / s)
    const loZ = Math.floor((pos[2] - margin) / s), hiZ = Math.floor((pos[2] + margin) / s)
    for (let cx = loX; cx <= hiX; cx++) for (let cy = loY; cy <= hiY; cy++) for (let cz = loZ; cz <= hiZ; cz++) {
      const key = RewindSpatialIndex._key(cx, cy, cz)
      let bucket = this.cells.get(key)
      if (!bucket) { bucket = []; this.cells.set(key, bucket) }
      bucket.push({ id, pos })
    }
  }

  queryRay(origin, direction, maxDist, onCandidate) {
    const s = this.cellSize
    let [cx, cy, cz] = this._cellOf(origin)
    const stepX = direction[0] > 0 ? 1 : direction[0] < 0 ? -1 : 0
    const stepY = direction[1] > 0 ? 1 : direction[1] < 0 ? -1 : 0
    const stepZ = direction[2] > 0 ? 1 : direction[2] < 0 ? -1 : 0

    const nextBoundary = (o, d, c) => {
      if (d === 0) return Infinity
      const cellMin = c * s
      const boundary = d > 0 ? cellMin + s : cellMin
      return (boundary - o) / d
    }
    let tMaxX = nextBoundary(origin[0], direction[0], cx)
    let tMaxY = nextBoundary(origin[1], direction[1], cy)
    let tMaxZ = nextBoundary(origin[2], direction[2], cz)
    const tDeltaX = stepX !== 0 ? Math.abs(s / direction[0]) : Infinity
    const tDeltaY = stepY !== 0 ? Math.abs(s / direction[1]) : Infinity
    const tDeltaZ = stepZ !== 0 ? Math.abs(s / direction[2]) : Infinity

    const visited = new Set()
    let t = 0
    let guard = 0
    const guardMax = Math.ceil(maxDist / s) * 3 + 8
    while (t <= maxDist && guard++ < guardMax) {
      const key = RewindSpatialIndex._key(cx, cy, cz)
      if (!visited.has(key)) {
        visited.add(key)
        const bucket = this.cells.get(key)
        if (bucket) for (let i = 0; i < bucket.length; i++) onCandidate(bucket[i])
      }
      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) { cx += stepX; t = tMaxX; tMaxX += tDeltaX }
        else { cz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ }
      } else {
        if (tMaxY < tMaxZ) { cy += stepY; t = tMaxY; tMaxY += tDeltaY }
        else { cz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ }
      }
      if (stepX === 0 && stepY === 0 && stepZ === 0) break
    }
  }

  size() { let n = 0; for (const b of this.cells.values()) n += b.length; return n }

  arrayIndexOf(id) { const i = this._arrayIndex.get(id); return i === undefined ? -1 : i }
}

export const DEFAULT_REWIND_CELL_SIZE = 16

export function buildLiveIndex(players, cellSize = DEFAULT_REWIND_CELL_SIZE) {
  const index = new RewindSpatialIndex(cellSize)
  for (let i = 0; i < players.length; i++) {
    const p = players[i]
    index.playersById.set(p.id, p)
    index._arrayIndex.set(p.id, i)
    if (!p.state || !p.state.position) continue
    index.insert(p.id, p.state.position)
  }
  return index
}
