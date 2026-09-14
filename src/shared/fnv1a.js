export const FNV1A_32_OFFSET_BASIS = 0x811c9dc5
export const FNV1A_32_PRIME = 0x01000193

const _floatScratch = new DataView(new ArrayBuffer(8))

export function fnv1aStepString(hash, str) {
  for (let i = 0; i < str.length; i++) hash = Math.imul(hash ^ str.charCodeAt(i), FNV1A_32_PRIME)
  return hash
}

export function fnv1aStepBytes(hash, bytes) {
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], FNV1A_32_PRIME)
  return hash
}

export function fnv1aStepFloat32(hash, n) {
  _floatScratch.setFloat32(0, n)
  for (let i = 0; i < 4; i++) hash = Math.imul(hash ^ _floatScratch.getUint8(i), FNV1A_32_PRIME)
  return hash
}

export function fnv1aStepFloat64(hash, n, byteOffset = 0) {
  _floatScratch.setFloat64(0, n)
  for (let i = 0; i < 8; i++) hash = Math.imul(hash ^ (_floatScratch.getUint8(i) + byteOffset), FNV1A_32_PRIME)
  return hash
}

export function fnv1aString(str) {
  return fnv1aStepString(FNV1A_32_OFFSET_BASIS, str) >>> 0
}

function plainUint8View(bytes) {
  return bytes instanceof Uint8Array && bytes.constructor !== Uint8Array
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : bytes
}

export function fnv1aBytes(bytes) {
  return fnv1aStepBytes(FNV1A_32_OFFSET_BASIS, plainUint8View(bytes)) >>> 0
}
