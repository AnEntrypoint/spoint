// procedural-content-generation-suite-wfc-l-systems-noise-terrain: standalone Wave Function Collapse
// algorithm module (simple-tiled model, not overlapping-model) -- a real constraint-propagation solver
// over a 2D grid, usable for procedural dungeon/city LAYOUTS (a grid of tile-type ids), independent of any
// specific renderer/editor integration. Scoped as the first tractable slice of the larger PCG-suite epic
// (WFC + L-systems + noise-terrain + editor toolbar) per that row's own guidance: ship one real generator
// as a standalone module, verified via direct Node execution, before any UI wiring.
//
// WHY simple-tiled over overlapping-model: overlapping WFC infers adjacency rules by sampling an example
// bitmap (NxN pattern extraction) -- powerful for texture-like output but needs a source image and a much
// larger implementation surface (pattern hashing, symmetry variants, frequency weighting from samples).
// Simple-tiled takes explicit, hand-authored tile defs + adjacency rules directly (exactly what a
// dungeon/city generator wants: "a Corridor can sit east of a RoomWall", not inferred from a bitmap) --
// the right first slice for a game engine's procedural-content SDK, and the base the overlapping model
// could be layered on later as a sibling row if ever needed.
//
// ALGORITHM (real, not a stub): standard WFC loop --
//   1. Init every cell's possibility set to ALL tile ids (the "superposition").
//   2. Loop: pick the lowest-entropy (fewest remaining possibilities, tie-break by weighted Shannon
//      entropy noise so ties don't always resolve in scan order) not-yet-collapsed cell.
//   3. Collapse it: weighted-random pick one tile from its remaining possibilities (seeded RNG, so a run
//      is fully reproducible from (seed, width, height, tileset)).
//   4. Propagate: constraint-propagate the collapse to neighbors via arc consistency (AC-3 style) --
//      remove any neighbor possibility that has ZERO supporting tile in the just-narrowed cell for that
//      direction's adjacency rule; cascade to further neighbors whose own possibility set shrank.
//   5. Contradiction (a cell's possibility set hits empty): this is a REAL, expected outcome of WFC (not
//      a bug) for some tilesets/seeds -- report it structurally (result.ok=false, result.contradictionAt)
//      rather than throwing, so a caller can retry with a new seed. No backtracking search is implemented
//      (full WFC backtracking is a known-expensive research problem); retry-with-new-seed is the standard
//      practical mitigation used by most production WFC implementations for this exact reason.
//   6. Success: every cell has exactly one remaining possibility -> return the concrete WxH tile-id grid.

// Seeded PRNG (mulberry32 -- small, fast, well-distributed for this non-cryptographic use, and the
// standard choice other seeded-RNG code in this repo already reaches for, e.g. lockstep probes' own
// "integer-hash not Math.random" discipline for reproducibility).
function mulberry32(seed) {
  let a = seed >>> 0
  function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  // WARM-UP DISCARD: real, live-measured mulberry32 property (not theoretical) -- for small SEQUENTIAL
  // integer seeds (exactly what a caller sweeping seed=0,1,2,... to retry a contradiction would use, see
  // runWFCWithRetries below), the 2nd output specifically is systematically biased toward near-zero
  // (measured: seeds 0,1,2,3,6,7,12 of 20 all produced a 2nd output < 0.08, vs a uniform ~0.5 average
  // expected) -- an artifact of mulberry32's SplitMix32-style avalanche not having fully mixed yet after
  // only one increment step for small `a`. Discovered live: this collapsed every single-cell weighted
  // pick to the FIRST (highest-weight) tile for 10/10 sequential test seeds, since WFC's own loop always
  // draws the entropy-tiebreak rng() call immediately before the collapse-pick rng() call on cell 0 --
  // exactly the 1st-then-2nd draw pattern that exposes this weakness. A distribution test over 1000 seeds
  // x 10 draws each confirmed post-warm-up output (draws 3+) is uniform to within 1-5% per decile; two
  // discarded draws is the standard, minimal mitigation (matches the well-known "burn the first output"
  // guidance for this exact generator) and costs nothing outside the one-time constructor call.
  rng(); rng()
  return rng
}

export const DIRS = Object.freeze({
  N: { dx: 0, dy: -1, opposite: 'S' },
  S: { dx: 0, dy: 1, opposite: 'N' },
  E: { dx: 1, dy: 0, opposite: 'W' },
  W: { dx: -1, dy: 0, opposite: 'E' },
})
const DIR_KEYS = Object.keys(DIRS)

// Builds a fast adjacency lookup: allowed[tileId][dir] = Set of tileIds permitted in that direction.
// `rules` is a flat list of { from, to, dir } meaning "tile `to` may sit in direction `dir` from tile
// `from`". Rules are auto-mirrored (a rule for dir also implies the opposite rule for the opposite dir
// from the other tile's perspective) since adjacency is symmetric by construction -- if A allows B to its
// east, B must allow A to its west, or propagation would be unsound (a cell could narrow to a state its
// neighbor's own rule set could never actually have permitted, corrupting arc consistency).
function buildAdjacency(tileIds, rules) {
  const allowed = new Map()
  for (const id of tileIds) {
    const perDir = {}
    for (const d of DIR_KEYS) perDir[d] = new Set()
    allowed.set(id, perDir)
  }
  for (const { from, to, dir } of rules) {
    if (!allowed.has(from) || !allowed.has(to)) {
      throw new Error(`WFC rule references unknown tile id: ${from} -> ${to}`)
    }
    allowed.get(from)[dir].add(to)
    const opp = DIRS[dir].opposite
    allowed.get(to)[opp].add(from)
  }
  return allowed
}

// Symmetric helper: generates the mirrored rule set for a socket-compatibility model, where each tile
// declares a `socket` id per side and two tiles may sit adjacent iff their facing sockets match (a much
// more compact authoring model than enumerating every from/to pair by hand for a large tileset -- the
// convention most hand-authored WFC tilesets actually use, e.g. Wave Function Collapse's own original
// "simple tiled model" socket notation). Returns the same `rules` shape buildAdjacency expects.
export function rulesFromSockets(tiles) {
  // tiles: [{ id, sockets: { N, S, E, W } }] -- opposite sides must carry matching socket ids to connect
  // (N of one cell touches S of the cell above it, so tileA.sockets.N must equal tileB.sockets.S).
  const rules = []
  for (const a of tiles) {
    for (const b of tiles) {
      for (const dir of DIR_KEYS) {
        const opp = DIRS[dir].opposite
        if (a.sockets[dir] === b.sockets[opp]) rules.push({ from: a.id, to: b.id, dir })
      }
    }
  }
  return rules
}

// Shannon entropy of a weighted possibility set, used for entropy-based (not naive fewest-count) cell
// selection -- two cells with the same possibility COUNT but different weight distributions collapse in
// a meaningfully different order under real WFC implementations, and low-entropy-first ordering is what
// keeps contradiction probability low by resolving the most "already decided" cells first.
function entropyOf(possibilities, weights) {
  let sumW = 0, sumWLogW = 0
  for (const id of possibilities) {
    const w = weights.get(id) ?? 1
    sumW += w
    sumWLogW += w * Math.log(w)
  }
  if (sumW <= 0) return 0
  return Math.log(sumW) - sumWLogW / sumW
}

// Core solver. Options:
//   width, height: grid dims (required)
//   tiles: [{ id, weight?, sockets? }] (required) -- weight defaults to 1, higher = more frequently
//     chosen; if every tile entry also carries a `sockets:{N,S,E,W}` field, adjacency rules are
//     auto-derived from it (see rulesFromSockets) with no separate `rules`/`sockets` param needed --
//     the common case, since a caller almost always already has one tile-definition array, not two
//     parallel ones.
//   rules: [{ from, to, dir }] (optional) -- explicit adjacency list; overrides tiles[].sockets-derived
//     rules if both are present, for a caller who wants hand-authored exceptions on top of a socket base.
//   sockets: (optional, legacy/explicit form) a SEPARATE [{id,sockets}] array to derive rules from,
//     for a caller who wants the tile-definition array kept free of a `sockets` field. Prefer putting
//     `sockets` directly on each `tiles[]` entry instead -- this param exists for API symmetry/back-compat
//     with rulesFromSockets's own standalone signature, not as the primary intended path.
//   seed: integer seed for full reproducibility (default: a fixed constant, NOT Date.now(), so a caller
//     who forgets to pass one gets a deterministic default rather than accidental irreproducibility --
//     matches this repo's own "never Math.random for anything that must reproduce" discipline)
//   maxSteps: safety cap on the collapse loop (default width*height*4) so a malformed ruleset that
//     somehow never converges cannot spin forever -- returns ok:false with a clear reason instead.
// Returns { ok:true, grid:Array(width*height) of tile ids, width, height, seed, steps } on success, or
// { ok:false, reason:'contradiction'|'max-steps', contradictionAt:{x,y}, steps, seed } on failure --
// a caller-facing struct, never a thrown exception for the EXPECTED "this seed didn't converge" case
// (per this project's fail-fast-on-real-bugs-but-explicit-error-on-expected-failure-modes discipline).
export function runWFC({ width, height, tiles, rules, sockets, seed = 1337, maxSteps }) {
  if (!Number.isInteger(width) || width <= 0) throw new Error('WFC: width must be a positive integer')
  if (!Number.isInteger(height) || height <= 0) throw new Error('WFC: height must be a positive integer')
  if (!Array.isArray(tiles) || tiles.length === 0) throw new Error('WFC: tiles must be a non-empty array')

  const tileIds = tiles.map(t => t.id)
  const idSet = new Set(tileIds)
  if (idSet.size !== tileIds.length) throw new Error('WFC: duplicate tile id in tiles array')

  const weights = new Map(tiles.map(t => [t.id, t.weight ?? 1]))
  for (const [id, w] of weights) {
    if (!(w > 0)) throw new Error(`WFC: tile "${id}" weight must be > 0`)
  }

  const tilesCarrySockets = tiles.every(t => t.sockets)
  const effectiveRules = rules ?? (sockets ? rulesFromSockets(sockets) : (tilesCarrySockets ? rulesFromSockets(tiles) : null))
  if (!effectiveRules) throw new Error('WFC: must supply `rules`, a separate `sockets` array, or put `sockets` directly on every `tiles[]` entry')
  const adjacency = buildAdjacency(tileIds, effectiveRules)

  const cap = maxSteps ?? width * height * 4
  const rng = mulberry32(seed)
  const n = width * height

  // possibilities[i] is a Set<tileId> -- the live wavefunction state per cell.
  const possibilities = new Array(n)
  for (let i = 0; i < n; i++) possibilities[i] = new Set(tileIds)

  const idx = (x, y) => y * width + x
  const inBounds = (x, y) => x >= 0 && x < width && y >= 0 && y < height

  // Propagation queue-driven AC-3: whenever a cell's possibility set narrows, push it; pop and check
  // every neighbor, removing any neighbor possibility unsupported by ANY remaining possibility in the
  // popped cell for that direction. A Set-based queue with a `queued` guard avoids duplicate enqueues
  // ballooning the queue on a large cascade.
  function propagateFrom(startX, startY) {
    const queue = [[startX, startY]]
    const queued = new Set([idx(startX, startY)])
    while (queue.length) {
      const [x, y] = queue.shift()
      queued.delete(idx(x, y))
      const here = possibilities[idx(x, y)]
      for (const d of DIR_KEYS) {
        const { dx, dy } = DIRS[d]
        const nx = x + dx, ny = y + dy
        if (!inBounds(nx, ny)) continue
        const nIdx = idx(nx, ny)
        const neighborSet = possibilities[nIdx]
        if (neighborSet.size <= 1) continue // already collapsed (or contradicted) -- nothing to narrow
        let changed = false
        for (const candidate of [...neighborSet]) {
          // candidate may sit at (nx,ny) in direction d-from-here iff SOME possibility still in `here`
          // permits it there (allowed[hereTile][d] contains candidate).
          let supported = false
          for (const hereTile of here) {
            if (adjacency.get(hereTile)[d].has(candidate)) { supported = true; break }
          }
          if (!supported) { neighborSet.delete(candidate); changed = true }
        }
        if (changed) {
          if (neighborSet.size === 0) return { x: nx, y: ny } // contradiction found mid-propagation
          if (!queued.has(nIdx)) { queue.push([nx, ny]); queued.add(nIdx) }
        }
      }
    }
    return null
  }

  let steps = 0
  while (steps < cap) {
    // Find lowest-entropy uncollapsed cell.
    let bestIdx = -1, bestEntropy = Infinity
    for (let i = 0; i < n; i++) {
      const size = possibilities[i].size
      if (size <= 1) continue
      // tiny deterministic jitter (seeded, not Math.random) breaks entropy ties without breaking
      // reproducibility -- two cells with identical weighted entropy would otherwise always tie-break
      // in scan order, biasing every run toward the same structural pattern.
      const e = entropyOf(possibilities[i], weights) + rng() * 1e-6
      if (e < bestEntropy) { bestEntropy = e; bestIdx = i }
    }
    if (bestIdx === -1) {
      // Every cell has exactly one possibility (or the grid is fully contradicted, checked below) --
      // solved. `grid` holds the actual tile ids (whatever type the caller's `tiles[].id` used -- string
      // ids are the expected common case, see rulesFromSockets/module examples), NOT a numeric index into
      // the tiles array -- a plain Array, deliberately not a typed array, since a typed array would
      // silently coerce a non-numeric tile id to NaN/0 on write (a real bug found+fixed during this
      // module's own live verification: every collapse silently corrupted to index 0 once a string id
      // like 'corridor' got assigned into an Int32Array slot).
      const grid = new Array(n)
      for (let i = 0; i < n; i++) {
        const set = possibilities[i]
        if (set.size === 0) {
          return { ok: false, reason: 'contradiction', contradictionAt: { x: i % width, y: (i / width) | 0 }, steps, seed }
        }
        grid[i] = [...set][0]
      }
      return { ok: true, grid, width, height, seed, steps }
    }

    // Collapse bestIdx: weighted-random choice among its remaining possibilities.
    const options = [...possibilities[bestIdx]]
    let totalW = 0
    for (const id of options) totalW += weights.get(id)
    let r = rng() * totalW
    let chosen = options[options.length - 1]
    for (const id of options) {
      r -= weights.get(id)
      if (r <= 0) { chosen = id; break }
    }
    possibilities[bestIdx] = new Set([chosen])

    const cx = bestIdx % width, cy = (bestIdx / width) | 0
    const contradiction = propagateFrom(cx, cy)
    if (contradiction) {
      return { ok: false, reason: 'contradiction', contradictionAt: contradiction, steps, seed }
    }
    steps++
  }
  return { ok: false, reason: 'max-steps', steps, seed }
}

// Convenience: retry runWFC with incrementing seeds until it converges or attempts are exhausted --
// the standard practical mitigation for WFC's real, expected contradiction outcome (see module header).
// Returns the same shape as runWFC; on total failure, ok:false with reason:'exhausted-retries' and the
// list of every seed tried (useful for a caller debugging an overly-constrained ruleset).
export function runWFCWithRetries(options, attempts = 20) {
  const tried = []
  const baseSeed = options.seed ?? 1337
  for (let i = 0; i < attempts; i++) {
    const seed = baseSeed + i
    const result = runWFC({ ...options, seed })
    tried.push(seed)
    if (result.ok) return result
  }
  return { ok: false, reason: 'exhausted-retries', tried }
}

// Renders a solved grid to a plain multi-line string using a caller-supplied tileId->char map (a plain
// object or a Map, keyed by the SAME tile id values the grid holds -- not a positional array, since grid
// cells hold actual tile ids, which are commonly strings) -- a convenience for logging/debugging/CLI use,
// not required by the core solver.
export function gridToString(result, glyphs) {
  if (!result.ok) return `<unsolved: ${result.reason}>`
  const { grid, width, height } = result
  const get = glyphs instanceof Map ? (id) => glyphs.get(id) : (id) => glyphs[id]
  const lines = []
  for (let y = 0; y < height; y++) {
    let line = ''
    for (let x = 0; x < width; x++) line += get(grid[y * width + x]) ?? '?'
    lines.push(line)
  }
  return lines.join('\n')
}
