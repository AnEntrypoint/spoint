export const REWIND_SLOP = 10

function nextBoundary(o, d, c, s) {
  if (d === 0) return Infinity
  const cellMin = c * s
  const boundary = d > 0 ? cellMin + s : cellMin
  return (boundary - o) / d
}

const CELL_HASH_X = 73856093
const CELL_HASH_Y = 19349663
const CELL_HASH_Z = 83492791

function cellHash(cx, cy, cz) {
  return Math.imul(cx | 0, CELL_HASH_X) ^ Math.imul(cy | 0, CELL_HASH_Y) ^ Math.imul(cz | 0, CELL_HASH_Z)
}

export class RewindSpatialIndex {
  constructor(cellSize = 16) {
    this.cellSize = cellSize
    this.cells = new Map()
    this._arrayIndex = new Map()
    this.playersById = new Map()
    this._cell = [0, 0, 0]
    this._visited = new Set()
  }

  _cellNode(cx, cy, cz, create) {
    const h = cellHash(cx, cy, cz)
    let node = this.cells.get(h)
    let tail = null
    while (node !== undefined) {
      if (node.cx === cx && node.cy === cy && node.cz === cz) return node
      tail = node
      node = node.next
    }
    if (!create) return undefined
    const fresh = { cx, cy, cz, items: [], next: undefined }
    if (tail === null) this.cells.set(h, fresh)
    else tail.next = fresh
    return fresh
  }

  _cellOf(pos) {
    const s = this.cellSize
    const cell = this._cell
    cell[0] = Math.floor(pos[0] / s); cell[1] = Math.floor(pos[1] / s); cell[2] = Math.floor(pos[2] / s)
    return cell
  }

  insert(id, pos, margin = REWIND_SLOP) {
    const s = this.cellSize
    const loX = Math.floor((pos[0] - margin) / s), hiX = Math.floor((pos[0] + margin) / s)
    const loY = Math.floor((pos[1] - margin) / s), hiY = Math.floor((pos[1] + margin) / s)
    const loZ = Math.floor((pos[2] - margin) / s), hiZ = Math.floor((pos[2] + margin) / s)
    for (let cx = loX; cx <= hiX; cx++) for (let cy = loY; cy <= hiY; cy++) for (let cz = loZ; cz <= hiZ; cz++) {
      this._cellNode(cx, cy, cz, true).items.push({ id, pos })
    }
  }

  queryRay(origin, direction, maxDist, onCandidate) {
    const s = this.cellSize
    let [cx, cy, cz] = this._cellOf(origin)
    const stepX = direction[0] > 0 ? 1 : direction[0] < 0 ? -1 : 0
    const stepY = direction[1] > 0 ? 1 : direction[1] < 0 ? -1 : 0
    const stepZ = direction[2] > 0 ? 1 : direction[2] < 0 ? -1 : 0

    let tMaxX = nextBoundary(origin[0], direction[0], cx, s)
    let tMaxY = nextBoundary(origin[1], direction[1], cy, s)
    let tMaxZ = nextBoundary(origin[2], direction[2], cz, s)
    const tDeltaX = stepX !== 0 ? Math.abs(s / direction[0]) : Infinity
    const tDeltaY = stepY !== 0 ? Math.abs(s / direction[1]) : Infinity
    const tDeltaZ = stepZ !== 0 ? Math.abs(s / direction[2]) : Infinity

    const visited = this._visited
    visited.clear()
    let t = 0
    let guard = 0
    const guardMax = Math.ceil(maxDist / s) * 3 + 8
    while (t <= maxDist && guard++ < guardMax) {
      const node = this._cellNode(cx, cy, cz, false)
      if (node !== undefined && !visited.has(node)) {
        visited.add(node)
        const bucket = node.items
        for (let i = 0; i < bucket.length; i++) onCandidate(bucket[i])
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

  size() {
    let n = 0
    for (const head of this.cells.values()) for (let node = head; node !== undefined; node = node.next) n += node.items.length
    return n
  }

  arrayIndexOf(id) { const i = this._arrayIndex.get(id); return i === undefined ? -1 : i }
}

export const DEFAULT_REWIND_CELL_SIZE = 16

export const DUPLICATE_PLAYER_ID = 'duplicate_player_id'

export class RewindDuplicatePlayerIdError extends Error {
  constructor(duplicateId, firstIndex, againIndex) {
    super(`${DUPLICATE_PLAYER_ID}: player id ${String(duplicateId)} is registered at index ${firstIndex} and again at index ${againIndex}; one live index resolves one position per id`)
    this.name = 'RewindDuplicatePlayerIdError'
    this.code = DUPLICATE_PLAYER_ID
    this.duplicateId = duplicateId
    this.firstIndex = firstIndex
    this.againIndex = againIndex
  }
}

export function buildLiveIndex(players, cellSize = DEFAULT_REWIND_CELL_SIZE) {
  const index = new RewindSpatialIndex(cellSize)
  for (let i = 0; i < players.length; i++) {
    const p = players[i]
    const firstIndex = index.arrayIndexOf(p.id)
    if (firstIndex !== -1) throw new RewindDuplicatePlayerIdError(p.id, firstIndex, i)
    index.playersById.set(p.id, p)
    index._arrayIndex.set(p.id, i)
    if (!p.state || !p.state.position) continue
    index.insert(p.id, p.state.position)
  }
  return index
}
