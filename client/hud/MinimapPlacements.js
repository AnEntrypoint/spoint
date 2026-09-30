import { VEG, SPECIES, classify as classifyTree, createPlacementCell, placementCellAt } from '/src/terrain/VegPlacement.js'
import { ROCK, classify as classifyRock } from '/src/terrain/RockPlacement.js'
import { latticeFor, chunkKeyAtLocal } from '/src/terrain/PlacementChart.js'
import { createCachedAnchorField } from '/src/terrain/ClimateCache.js'

export const GLYPH_STRIDE = 4
export const GLYPH_ROCK = 5
export const GLYPH_CLASS_COUNT = 6
const CELLS_PER_DEADLINE_CHECK = 4
const CLIMATE_CACHE_CAP = 60000
const CHUNK_CACHE_SLACK = 1.5
const KEY_SAMPLES_PER_CHUNK = 3

const GENUS_BY_PREFIX = [['Oak', 0, 4.2], ['Pine', 1, 2.6], ['Aspen', 2, 2.8], ['Ash', 3, 3.6], ['Bush', 4, 1.3]]
const SIZE_BY_SUFFIX = [['Small', 0.75], ['Large', 1.3]]
const TREE_CLASS = new Uint8Array(SPECIES.length)
const TREE_CANOPY_M = new Float32Array(SPECIES.length)
SPECIES.forEach((name, i) => {
  const genus = GENUS_BY_PREFIX.find(g => name.startsWith(g[0])) || GENUS_BY_PREFIX[0]
  const size = SIZE_BY_SUFFIX.find(s => name.includes(s[0]))
  TREE_CLASS[i] = genus[1]
  TREE_CANOPY_M[i] = genus[2] * (size ? size[1] : 1)
})
const ROCK_RADIUS_PER_SCALE = 0.5

function packTree(p, out, o, rendered) {
  if (rendered && !rendered[p.species]) return false
  out[o] = p.x; out[o + 1] = p.z; out[o + 2] = TREE_CLASS[p.species]; out[o + 3] = TREE_CANOPY_M[p.species] * p.scale
  return true
}
function packRock(p, out, o) {
  out[o] = p.x; out[o + 1] = p.z; out[o + 2] = GLYPH_ROCK; out[o + 3] = p.scale * ROCK_RADIUS_PER_SCALE
  return true
}

function renderedSpeciesOf(source) {
  const recs = source && source._meshes
  if (!Array.isArray(recs)) return null
  const names = new Set(recs.map(r => r && r.name))
  return Uint8Array.from(SPECIES, name => (names.has(name) ? 1 : 0))
}

let classifyFailureReported = false
function reportClassifyFailure(e) {
  if (classifyFailureReported) return
  classifyFailureReported = true
  console.error('[minimap] placement classify threw; that chunk shows no glyphs, as the world skips it:', e && e.message || e)
}

const KINDS = [
  { spec: VEG, classify: classifyTree, pack: packTree, rendered: renderedSpeciesOf, seedXor: 0x7eed, sourceKey: 'vegetation' },
  { spec: ROCK, classify: classifyRock, pack: packRock, rendered: () => null, seedXor: 0x70c5, sourceKey: 'rocks' },
]

function createKindScanner(kind) {
  const cache = new Map()
  const spec = kind.spec
  const cellsPerChunk = spec.GRID * spec.GRID
  const scratch = new Float32Array(cellsPerChunk * GLYPH_STRIDE)
  const dec = [0, 0, 0]
  const keys = [], keySet = new Set()
  let frame = null, baseField = null, field = null, seed = 0, lattice = null, cell = null, k = 0, cellIdx = 0, used = 0, strokes = -1
  let boundSource = null, rendered = null, chunkFailed = false
  let winLeft = 0, winTop = 0, winSpan = 0, sampleStep = 1, sampleCount = 0, sampleRow = 0

  function bind(nextFrame, nextBaseField, source, worldSeed) {
    const overrides = source && source.biomeOverride
    const strokeCount = overrides ? overrides.strokeCount : 0
    if (nextFrame !== frame || nextBaseField !== baseField || source !== boundSource || worldSeed !== seed || strokeCount !== strokes || !field) {
      cache.clear()
      frame = nextFrame; baseField = nextBaseField; boundSource = source; seed = worldSeed; strokes = strokeCount
      rendered = kind.rendered(source)
      lattice = latticeFor(frame, spec)
      cell = createPlacementCell(frame)
      const cached = createCachedAnchorField(baseField, frame)
      field = { cached, wrapped: overrides ? overrides.wrapClimateField(cached) : cached }
    }
    if (field.cached && field.cached.size > CLIMATE_CACHE_CAP) field.cached.clear()
  }

  function begin(cx, cz, halfM) {
    winLeft = cx - halfM; winTop = cz - halfM; winSpan = 2 * halfM
    sampleStep = lattice.chunkM / KEY_SAMPLES_PER_CHUNK
    sampleCount = Math.ceil(winSpan / sampleStep) + 1
    sampleRow = 0
    keySet.clear(); keys.length = 0
    k = 0; cellIdx = 0; used = 0
  }

  function collectKeys(deadline) {
    while (sampleRow < sampleCount) {
      const z = Math.min(winTop + sampleRow * sampleStep, winTop + winSpan)
      for (let i = 0; i < sampleCount; i++) {
        const key = chunkKeyAtLocal(lattice, frame, Math.min(winLeft + i * sampleStep, winLeft + winSpan), z)
        if (!keySet.has(key)) { keySet.add(key); keys.push(key) }
      }
      sampleRow++
      if (performance.now() >= deadline) return false
    }
    if (cache.size > keys.length * CHUNK_CACHE_SLACK) cache.forEach(evictOutside)
    return true
  }

  function evictOutside(v, key) { if (!keySet.has(key)) cache.delete(key) }

  function step(deadline, onChunk) {
    if (sampleRow < sampleCount && !collectKeys(deadline)) return false
    const seedValue = (seed | 0) ^ kind.seedXor
    const jitter = spec.JITTER / spec.CELL
    while (k < keys.length) {
      const key = keys[k]
      const hit = cache.get(key)
      if (hit) { onChunk(hit); k++; if (performance.now() >= deadline) return false; continue }
      if (cellIdx === 0) { lattice.decodeChunk(key, dec); chunkFailed = false }
      while (cellIdx < cellsPerChunk && !chunkFailed) {
        try {
          placementCellAt(frame, lattice, dec, cellIdx % spec.GRID, (cellIdx / spec.GRID) | 0, seedValue, jitter, 0, 1, cell)
          const p = kind.classify(frame, field.wrapped, cell)
          if (p && Number.isFinite(p.x) && Number.isFinite(p.z) && kind.pack(p, scratch, used * GLYPH_STRIDE, rendered)) used++
        } catch (e) {
          reportClassifyFailure(e)
          chunkFailed = true
          used = 0
        }
        cellIdx++
        if (cellIdx % CELLS_PER_DEADLINE_CHECK === 0 && performance.now() >= deadline) return false
      }
      const packed = scratch.slice(0, used * GLYPH_STRIDE)
      cache.set(key, packed)
      onChunk(packed)
      k++; cellIdx = 0; used = 0; chunkFailed = false
      if (performance.now() >= deadline) return false
    }
    return true
  }

  return { bind, begin, step, cache, get cachedChunks() { return cache.size }, get sourceKey() { return kind.sourceKey } }
}

export function createPlacementScanner() {
  const scanners = KINDS.map(createKindScanner)
  const active = new Uint8Array(scanners.length)
  let s = 0

  function begin(frame, anchorField, sources, worldSeed, cx, cz, halfM) {
    s = 0
    for (let i = 0; i < scanners.length; i++) {
      const source = sources[scanners[i].sourceKey]
      active[i] = source ? 1 : 0
      if (!source) continue
      scanners[i].bind(frame, anchorField, source, worldSeed)
      scanners[i].begin(cx, cz, halfM)
    }
  }

  function step(deadline, onChunk) {
    while (s < scanners.length) {
      if (active[s] && !scanners[s].step(deadline, onChunk)) return false
      s++
    }
    return true
  }

  function glyphSnapshot() {
    const out = []
    for (const sc of scanners) for (const packed of sc.cache.values()) for (let o = 0; o < packed.length; o += GLYPH_STRIDE) out.push([packed[o], packed[o + 1], packed[o + 2], packed[o + 3]])
    return out
  }

  return { begin, step, glyphSnapshot, get cachedChunks() { return scanners.map(x => x.cachedChunks) } }
}
