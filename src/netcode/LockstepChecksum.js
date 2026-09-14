import { FNV1A_32_OFFSET_BASIS, fnv1aStepFloat64 } from '../shared/fnv1a.js'

const SECOND_LANE_SEED = 0x1000193
const SECOND_LANE_BYTE_OFFSET = 1

function canonicalFloat64(n) {
  return n === 0 ? 0 : (Number.isNaN(n) ? NaN : n)
}

export function createChecksumFold() {
  let a = FNV1A_32_OFFSET_BASIS, b = SECOND_LANE_SEED
  const fold = (n) => {
    const c = canonicalFloat64(n)
    a = fnv1aStepFloat64(a, c)
    b = fnv1aStepFloat64(b, c, SECOND_LANE_BYTE_OFFSET)
  }
  return {
    push(n) { fold(n); return this },
    pushInt(n) { fold(n | 0); return this },
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
