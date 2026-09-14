import { FNV1A_32_OFFSET_BASIS, fnv1aStepString } from '../shared/fnv1a.js'

export const WIRE_STRUCTURES = [
  ['type', 'payload'],
  ['seq', 'tick', 'serverTime', 'players', 'entities', 'removed', 'delta', 'dots']
]

function _computeStructHash() {
  let hash = FNV1A_32_OFFSET_BASIS
  for (const fields of WIRE_STRUCTURES) {
    hash = fnv1aStepString(hash, '|')
    for (const f of fields) { hash = fnv1aStepString(hash, f); hash = fnv1aStepString(hash, ',') }
  }
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
