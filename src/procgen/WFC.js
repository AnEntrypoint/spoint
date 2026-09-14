function mulberry32(seed) {
  let a = seed >>> 0
  function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
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
const ENTROPY_TIEBREAK_JITTER = 1e-6

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

export function rulesFromSockets(tiles) {
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

  const possibilities = new Array(n)
  for (let i = 0; i < n; i++) possibilities[i] = new Set(tileIds)

  const idx = (x, y) => y * width + x
  const inBounds = (x, y) => x >= 0 && x < width && y >= 0 && y < height

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
        if (neighborSet.size <= 1) continue
        let changed = false
        for (const candidate of [...neighborSet]) {
          let supported = false
          for (const hereTile of here) {
            if (adjacency.get(hereTile)[d].has(candidate)) { supported = true; break }
          }
          if (!supported) { neighborSet.delete(candidate); changed = true }
        }
        if (changed) {
          if (neighborSet.size === 0) return { x: nx, y: ny }
          if (!queued.has(nIdx)) { queue.push([nx, ny]); queued.add(nIdx) }
        }
      }
    }
    return null
  }

  let steps = 0
  while (steps < cap) {
    let bestIdx = -1, bestEntropy = Infinity
    for (let i = 0; i < n; i++) {
      const size = possibilities[i].size
      if (size <= 1) continue
      const e = entropyOf(possibilities[i], weights) + rng() * ENTROPY_TIEBREAK_JITTER
      if (e < bestEntropy) { bestEntropy = e; bestIdx = i }
    }
    if (bestIdx === -1) {
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
