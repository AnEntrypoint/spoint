import { FNV1A_32_OFFSET_BASIS, fnv1aStepString } from '../shared/fnv1a.js'

export const WIRE_STRUCTURES = Object.freeze([
  Object.freeze(['type', 'payload']),
  Object.freeze(['seq', 'tick', 'serverTime', 'players', 'entities', 'removed', 'delta', 'dots', 'me', 'chartEpoch'])
])

function _computeStructHash() {
  let hash = FNV1A_32_OFFSET_BASIS
  for (const fields of WIRE_STRUCTURES) {
    hash = fnv1aStepString(hash, '|')
    for (const f of fields) { hash = fnv1aStepString(hash, f); hash = fnv1aStepString(hash, ',') }
  }
  return (hash >>> 0).toString(16)
}

export const WIRE_STRUCT_HASH = _computeStructHash()

const WIRE_STRUCT_HASH_RE = /^[0-9a-f]{1,8}$/

export function parseWireStructHash(value) {
  if (value === undefined || value === null) return { kind: 'absent', value }
  if (typeof value !== 'string') return { kind: 'malformed', reason: 'wire-struct-hash-not-a-string', value }
  if (!WIRE_STRUCT_HASH_RE.test(value)) return { kind: 'malformed', reason: 'wire-struct-hash-not-a-hex32', value }
  return { kind: 'hash', hash: value }
}

const _isNode = typeof process !== 'undefined' && process.versions?.node

let _packr = null
let _unpackr = null
let _packrPromise = null

function _wireOptions(useFloat32) {
  return {
    useFloat32,
    bundleStrings: true,
    structures: WIRE_STRUCTURES.map(s => s.slice()),
    saveStructures: false,
    maxSharedStructures: WIRE_STRUCTURES.length
  }
}

async function _ensurePackr() {
  if (_packr) return _packr
  if (!_packrPromise) {
    _packrPromise = (_isNode || typeof globalThis.__SPOINT_EDGE_BUNDLED__ !== 'undefined'
      ? import('msgpackr')
      : import((() => '/node_modules/' + 'msgpackr/index.js')())
    ).then(({ Packr, Unpackr, NEVER, DECIMAL_ROUND }) => {
      _packr = new Packr(_wireOptions(NEVER))
      _unpackr = new Unpackr(_wireOptions(DECIMAL_ROUND))
      return _packr
    })
  }
  return _packrPromise
}

export function pack(obj) {
  if (!_packr) throw new Error('[msgpack] pack() called before Packr resolved -- await ensurePacked() once at boot, or move this call past first tick')
  return _packr.pack(obj)
}

export function unpack(buf) {
  if (!_unpackr) throw new Error('[msgpack] unpack() called before Packr resolved -- await ensurePacked() once at boot, or move this call past first tick')
  return _unpackr.unpack(buf)
}

export function isPacked() {
  return _packr !== null
}

// Node loads msgpackr synchronously (CJS build via the builtin module loader), so pack/unpack
// work from the first call after import. The browser has no synchronous loader that avoids
// bundling msgpackr, so it keeps the async path and the throw until ensurePacked settles.
function _loadPackrSync() {
  if (!_isNode || typeof process.getBuiltinModule !== 'function') return false
  const { createRequire } = process.getBuiltinModule('module')
  const { Packr, Unpackr, NEVER, DECIMAL_ROUND } = createRequire(import.meta.url)('msgpackr')
  _packr = new Packr(_wireOptions(NEVER))
  _unpackr = new Unpackr(_wireOptions(DECIMAL_ROUND))
  return true
}

_loadPackrSync()

export const ensurePacked = _ensurePackr()
