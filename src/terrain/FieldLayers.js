export function createFieldLayers({ cellSize, chunkCells }) {
  if (!(cellSize > 0) || !Number.isInteger(chunkCells) || chunkCells < 1) throw new RangeError('FieldLayers: cellSize > 0 and integer chunkCells >= 1 required')
  const authored = new Map()
  const runtime = new Map()
  const versions = new Map()
  let version = 0
  const span = cellSize * chunkCells

  function locate(x, z) {
    const gx = Math.floor(x / cellSize)
    const gz = Math.floor(z / cellSize)
    const kx = Math.floor(gx / chunkCells)
    const kz = Math.floor(gz / chunkCells)
    const ix = gx - kx * chunkCells
    const iz = gz - kz * chunkCells
    return { key: `${kx},${kz}`, index: iz * chunkCells + ix }
  }

  function chunkOf(layer, key) {
    let chunk = layer.get(key)
    if (!chunk) {
      chunk = new Float32Array(chunkCells * chunkCells)
      layer.set(key, chunk)
    }
    return chunk
  }

  function readField(x, z) {
    const { key, index } = locate(x, z)
    const a = authored.get(key)
    const r = runtime.get(key)
    return (a ? a[index] : 0) + (r ? r[index] : 0)
  }

  function paint(x, z, delta) {
    const { key, index } = locate(x, z)
    const chunk = chunkOf(runtime, key)
    chunk[index] += delta
    version += 1
    versions.set(key, version)
    return chunk[index]
  }

  function setAuthored(kx, kz, cells) {
    if (!(cells instanceof Float32Array) || cells.length !== chunkCells * chunkCells) throw new RangeError('FieldLayers: authored chunk must be a Float32Array of chunkCells^2')
    authored.set(`${kx},${kz}`, cells)
    version += 1
    versions.set(`${kx},${kz}`, version)
  }

  function clearRuntime(kx, kz) {
    const key = `${kx},${kz}`
    if (!runtime.delete(key)) return false
    version += 1
    versions.set(key, version)
    return true
  }

  function clearAllRuntime() {
    const keys = [...runtime.keys()]
    for (const key of keys) {
      runtime.delete(key)
      version += 1
      versions.set(key, version)
    }
    return keys.length
  }

  function changes(at = 0) {
    const chunks = []
    for (const [key, v] of versions) if (v > at) chunks.push(key)
    return { chunks, at: version }
  }

  function paintedChunks() {
    return [...runtime.keys()]
  }

  return { span, readField, paint, setAuthored, clearRuntime, clearAllRuntime, changes, paintedChunks, locate }
}
