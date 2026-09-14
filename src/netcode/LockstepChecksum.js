const FNV_PRIME = 16777619
const FNV_OFFSET_BASIS_32 = 0x811c9dc5
const SECOND_LANE_SEED = 0x1000193
const _f64buf = new ArrayBuffer(8)
const _f64view = new DataView(_f64buf)

function foldFloat64(hashA, hashB, n) {
  const canonicalN = n === 0 ? 0 : (Number.isNaN(n) ? NaN : n)
  _f64view.setFloat64(0, canonicalN)
  for (let i = 0; i < 8; i++) {
    const byte = _f64view.getUint8(i)
    hashA ^= byte; hashA = Math.imul(hashA, FNV_PRIME)
    hashB ^= byte + 1; hashB = Math.imul(hashB, FNV_PRIME)
  }
  return [hashA, hashB]
}

export function createChecksumFold() {
  let a = FNV_OFFSET_BASIS_32, b = SECOND_LANE_SEED
  return {
    push(n) { [a, b] = foldFloat64(a, b, n); return this },
    pushInt(n) { [a, b] = foldFloat64(a, b, n | 0); return this },
    digest() { return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0') },
  }
}

export function checksumBodies(tick, snap) {
  const fold = createChecksumFold().pushInt(tick)
  const ids = snap instanceof Map ? [...snap.keys()] : Object.keys(snap).map(Number)
  ids.sort((x, y) => x - y)
  for (const id of ids) {
    const s = snap instanceof Map ? snap.get(id) : snap[id]
    fold.pushInt(id)
    for (const v of s.position) fold.push(v)
    for (const v of s.rotation) fold.push(v)
    for (const v of s.velocity) fold.push(v)
    for (const v of s.angularVelocity) fold.push(v)
  }
  return fold.digest()
}
