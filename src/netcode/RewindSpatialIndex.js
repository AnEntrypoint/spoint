// Spatial acceleration for the rewind hit-test in apps/tps-game/server.js's handleFire.
// The rewind step itself (LagCompensator.getPlayerStateAtTime, a per-player binary search
// over that player's own ring buffer) is already O(log 128) and untouched here. What was
// O(n) is the OUTER scan in handleFire: for a shot against n live targets, every target got
// its rewound position resolved AND ray-tested unconditionally, regardless of whether it
// could possibly lie near the ray.
//
// Rebuilding a grid from each shot's own exact rewound positions was tried first and measured
// SLOWER than the linear scan at realistic player counts (~4-6x, see the perf verification
// script) -- the per-shot rewind lookup + O(n) grid insert costs more than the O(n) scan it
// replaces, since rewind time differs per shooter's own reported latencyMs so a fresh rewind
// snapshot with no reuse buys nothing.
//
// The real win is a BROAD-PHASE prune on LIVE (unrewound) positions: a shot first rejects any
// target whose CURRENT position can't possibly be near the ray (rewind displacement over a
// realistic compensation window is bounded by REWIND_SLOP below), using a grid built once per
// tick and reused across every shot fired that tick (no per-shot rebuild cost). Only the small
// prune-surviving candidate set pays the real rewind lookup + exact capsule ray test, so the
// outer scan becomes O(cells touched) broad-phase + O(candidates) exact-phase instead of O(n)
// exact-phase for every target.

// Max plausible rewind displacement: LagCompensator's default historyWindow is 1000ms (the
// oldest rewind lookup handleFire can ever be asked to resolve -- getPlayerStateAtTime binary-
// searches within that window and returns null past it, so latencyMs is effectively capped
// there), and a sprinting player moves at ~8 m/s -- 8m worst case, +hit radius (0.6m) +slack
// rounds up to 10m so the broad-phase margin can never prune a target the exact rewind test
// would have accepted, at any latency the compensator actually serves.
export const REWIND_SLOP = 10

export class RewindSpatialIndex {
  constructor(cellSize = 16) {
    this.cellSize = cellSize
    this.cells = new Map() // "cx,cy,cz" -> [{id, pos}]
    // Built alongside the grid so a query's candidate set can be resolved back to a real player
    // object and its original scan-order rank in O(1) per candidate, instead of re-scanning the
    // full player array per shot (which would silently reintroduce the O(n) cost this index exists
    // to remove).
    this._arrayIndex = new Map() // id -> index in the players array passed to buildLiveIndex
    this.playersById = new Map() // id -> player object
  }

  static _key(cx, cy, cz) { return cx + ',' + cy + ',' + cz }

  _cellOf(pos) {
    const s = this.cellSize
    return [Math.floor(pos[0] / s), Math.floor(pos[1] / s), Math.floor(pos[2] / s)]
  }

  // margin covers REWIND_SLOP (the broad-phase's own worst-case pruning error): an entry near a
  // cell boundary is registered into every cell within `margin` of its position (not just its
  // own cell), so a single-cell DDA query (cheap, no per-query neighborhood fan-out) still finds
  // it even when the ray only grazes the boundary cell. margin << cellSize keeps the extra
  // buckets-per-entry small.
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

  // 3D DDA ray traversal (Amanatides & Woo) over the grid, calling onCandidate(entry) for
  // every entry in every cell the ray segment [0, maxDist] passes through. Cells with no
  // bucket are O(1) map-miss skips, not iterated.
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
    // Bounded by the number of cells the segment can possibly cross (ray length / cellSize on each
    // axis, +constant), not an arbitrary large constant -- a degenerate near-zero direction on one
    // axis contributes ~0 extra steps on that axis since tDelta is Infinity and that axis never
    // becomes the minimum, so the walk is driven by the axes that actually move.
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

// Cell size relative to REWIND_SLOP: cells much larger than the slop margin keep the DDA walk
// short (few cells per shot) while still pruning almost all far-away targets for a spread-out
// player population.
export const DEFAULT_REWIND_CELL_SIZE = 16

// Build once per server tick from LIVE player positions (cheap: no per-player rewind lookup),
// reused as the broad-phase prune for every shot fired that tick.
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
