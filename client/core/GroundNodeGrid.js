const NODE_SPACING_M = 1
const WINDOW_BITS = 6
const WINDOW_NODES = 1 << WINDOW_BITS
const WINDOW_MASK = WINDOW_NODES - 1

export function createGroundNodeGrid(sampleExact) {
  const slots = WINDOW_NODES * WINDOW_NODES
  const heights = new Float64Array(slots)
  const tagX = new Int32Array(slots), tagZ = new Int32Array(slots), tagGeneration = new Uint32Array(slots)
  let generation = 1

  function node(ix, iz) {
    const slot = ((iz & WINDOW_MASK) << WINDOW_BITS) | (ix & WINDOW_MASK)
    if (tagGeneration[slot] === generation && tagX[slot] === ix && tagZ[slot] === iz) return heights[slot]
    const h = sampleExact(ix * NODE_SPACING_M, iz * NODE_SPACING_M)
    heights[slot] = h
    tagX[slot] = ix; tagZ[slot] = iz; tagGeneration[slot] = generation
    return h
  }

  function heightAt(x, z) {
    const fx = x / NODE_SPACING_M, fz = z / NODE_SPACING_M
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz
    const h00 = node(ix, iz), h10 = node(ix + 1, iz), h01 = node(ix, iz + 1), h11 = node(ix + 1, iz + 1)
    if (!Number.isFinite(h00 + h10 + h01 + h11)) return sampleExact(x, z)
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
  }

  function invalidate() { generation = (generation + 1) >>> 0 || 1 }

  return { heightAt, invalidate, spacingM: NODE_SPACING_M, windowM: WINDOW_NODES * NODE_SPACING_M }
}
