export let FNV1A_32_OFFSET_BASIS = 0x811c9dc5
export let FNV1A_32_PRIME = 0x01000193

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

// --- hot swap -----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapFnv1a = (next) => {
  fnv1aStepString = next.fnv1aStepString
  fnv1aStepBytes = next.fnv1aStepBytes
  fnv1aStepFloat32 = next.fnv1aStepFloat32
  fnv1aStepFloat64 = next.fnv1aStepFloat64
  fnv1aString = next.fnv1aString
  fnv1aBytes = next.fnv1aBytes
  FNV1A_32_OFFSET_BASIS = next.FNV1A_32_OFFSET_BASIS
  FNV1A_32_PRIME = next.FNV1A_32_PRIME
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapFnv1a)
