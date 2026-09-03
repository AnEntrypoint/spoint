// Sector key: same integer floor + sector-centre sample on client and server -> byte-identical climate, required for veg/physics parity.
export const SECTOR_M = 8

function sectorIndex(v) {
  return Math.floor(v / SECTOR_M)
}

export function createCachedAnchorField(anchorField, frame) {
  if (!anchorField || !frame) return anchorField
  const cache = new Map()
  const keyOf = (sx, sz) => ((sx & 0x3fffff) * 0x400000) + (sz & 0x3fffff)

  function atSector(sx, sz) {
    const k = keyOf(sx, sz)
    let v = cache.get(k)
    if (v !== undefined) return v
    const cx = sx * SECTOR_M + SECTOR_M * 0.5
    const cz = sz * SECTOR_M + SECTOR_M * 0.5
    const dir = frame.localToDir(cx, cz)
    const raw = anchorField.sampleDir ? anchorField.sampleDir(dir) : null
    // must copy: sampleDir returns a shared scratch object, caching the reference would alias every sector to the last sample.
    v = raw ? { temp: raw.temp, humidity: raw.humidity, erosion: raw.erosion, seaBias: raw.seaBias } : null
    cache.set(k, v)
    return v
  }

  return {
    climateAtLocal(x, z) {
      return atSector(sectorIndex(x), sectorIndex(z))
    },
    sampleDir(dir) {
      return anchorField.sampleDir ? anchorField.sampleDir(dir) : null
    },
    clear() { cache.clear() },
    get size() { return cache.size },
    _underlying: anchorField,
  }
}
