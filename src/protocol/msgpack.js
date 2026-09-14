export const WIRE_STRUCTURES = [
  ['type', 'payload'],
  ['seq', 'tick', 'serverTime', 'players', 'entities', 'removed', 'delta', 'dots']
]

const FNV1A_32_OFFSET_BASIS = 0x811c9dc5
const FNV1A_32_PRIME = 16777619
function _computeStructHash() {
  let hash = FNV1A_32_OFFSET_BASIS
  const step = (str) => { for (let i = 0; i < str.length; i++) { hash ^= str.charCodeAt(i); hash = Math.imul(hash, FNV1A_32_PRIME) } }
  for (const fields of WIRE_STRUCTURES) { step('|'); for (const f of fields) { step(f); step(',') } }
  return (hash >>> 0).toString(16)
}

export const WIRE_STRUCT_HASH = _computeStructHash()

const _isNode = typeof process !== 'undefined' && process.versions?.node

let _packr = null
let _packrPromise = null

function _makePackr(Packr) {
  return new Packr({
    useFloat32: 3,
    bundleStrings: true,
    structures: WIRE_STRUCTURES.map(s => s.slice()),
    saveStructures: false,
    maxSharedStructures: WIRE_STRUCTURES.length
  })
}

async function _ensurePackr() {
  if (_packr) return _packr
  if (!_packrPromise) {
    _packrPromise = (_isNode || typeof globalThis.__SPOINT_EDGE_BUNDLED__ !== 'undefined'
      ? import('msgpackr')
      : import((() => '/node_modules/' + 'msgpackr/index.js')())
    ).then(({ Packr }) => { _packr = _makePackr(Packr); return _packr })
  }
  return _packrPromise
}

export function pack(obj) {
  if (!_packr) throw new Error('[msgpack] pack() called before Packr resolved -- await ensurePacked() once at boot, or move this call past first tick')
  return _packr.pack(obj)
}

export function unpack(buf) {
  if (!_packr) throw new Error('[msgpack] unpack() called before Packr resolved -- await ensurePacked() once at boot, or move this call past first tick')
  return _packr.unpack(buf)
}

export function isPacked() {
  return _packr !== null
}

export const ensurePacked = _ensurePackr()
