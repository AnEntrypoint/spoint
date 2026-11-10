import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argPath = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? path.resolve(hit.slice(name.length + 3)) : path.join(ROOT, fallback)
}
const encoderPath = argPath('module', 'src/netcode/SnapshotEncoder.js')
const rewindPath = argPath('rewind-module', 'src/netcode/RewindSpatialIndex.js')

const NativeMap = globalThis.Map
const counts = { mapNew: 0 }
globalThis.Map = class CountingMap extends NativeMap {
  constructor(entries) { super(entries); counts.mapNew++ }
}
const { SnapshotEncoder } = await import(pathToFileURL(encoderPath).href)
const { RewindSpatialIndex } = await import(pathToFileURL(rewindPath).href)

const checks = []
const check = (name, ok, detail = '') => {
  checks.push(ok)
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const unit = (a, b) => {
  let h = Math.imul(a + 1, 374761393) ^ Math.imul(b + 7, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const plain = (v) => JSON.stringify(v, (_, x) => (ArrayBuffer.isView(x) ? Array.from(x) : x))

const ENTITY_COUNT = 60
const TICKS = 240

function snapshotAt(t) {
  const entities = []
  const phase = t % 17
  for (let i = 1; i <= ENTITY_COUNT; i++) {
    if (i === 7 && phase >= 5 && phase < 9) continue
    const still = i % 4 === 0
    const ph = still ? 0 : t * 0.05 + i
    const base = [unit(i, 1) * 400 - 200, unit(i, 2) * 20, unit(i, 3) * 400 - 200]
    entities.push({
      id: i,
      model: `m${i % 3}`,
      bodyType: i % 5 === 0 ? 'static' : 'dynamic',
      position: [base[0] + Math.sin(ph) * 30, base[1], base[2] + Math.cos(ph) * 30],
      rotation: [0, Math.sin(ph / 2) * 0.1, 0, Math.cos(ph / 2)],
      velocity: still ? [0, 0, 0] : [Math.cos(ph), 0, -Math.sin(ph)],
      scale: [1, 1, 1],
      custom: i % 6 === 0 ? { hp: (t >> 4) % 3 } : null,
      _dynSleeping: i === 11 && t % 25 < 10
    })
  }
  return { tick: t, serverTime: t * 16, players: [], entities }
}

let refBase = new Map()
let cur = new Map()
let spare = null
let outMismatch = 0
let mapMismatch = 0
let prevMutated = 0
let returnedPrev = 0
let steadyMaps = 0
let sawRemoved = 0
for (let t = 0; t < TICKS; t++) {
  const snap = snapshotAt(t)
  const ref = SnapshotEncoder.encodeDelta(snap, refBase)
  const refEncoded = plain(ref.encoded)
  const refMap = plain([...ref.entityMap])
  refBase = ref.entityMap

  const prev = cur
  const prevBefore = plain([...prev])
  counts.mapNew = 0
  const got = SnapshotEncoder.encodeDelta(snap, prev, undefined, undefined, undefined, undefined, spare)
  if (t > 0) steadyMaps += counts.mapNew
  if (got.encoded.removed) sawRemoved++
  const gotEncoded = plain(got.encoded)
  const gotMap = plain([...got.entityMap])
  if (plain([...prev]) !== prevBefore) prevMutated++
  if (got.entityMap === prev) returnedPrev++
  if (gotEncoded !== refEncoded) outMismatch++
  if (gotMap !== refMap) mapMismatch++
  spare = prev
  cur = got.entityMap
}

check(`encodeDelta output matches a fresh-map reference on all ${TICKS} ticks`, outMismatch === 0, `${outMismatch} tick(s) differ`)
check(`encodeDelta entity map matches a fresh-map reference on all ${TICKS} ticks`, mapMismatch === 0, `${mapMismatch} tick(s) differ`)
check('encodeDelta never mutates the prev map it reads', prevMutated === 0, `${prevMutated} mutation(s)`)
check('encodeDelta never returns the prev map as its next map', returnedPrev === 0, `${returnedPrev} alias(es)`)
check('the fixed input removes entities on some ticks', sawRemoved > 0, `${sawRemoved} tick(s) with removed`)
check(`steady-state encodeDelta constructs no Map over ${TICKS - 1} ticks`, steadyMaps === 0, `new Map ${steadyMaps}`)

class ReferenceIndex {
  constructor(cellSize) {
    this.cellSize = cellSize
    this.cells = new NativeMap()
  }
  insert(id, pos) {
    const s = this.cellSize, m = 10
    const loX = Math.floor((pos[0] - m) / s), hiX = Math.floor((pos[0] + m) / s)
    const loY = Math.floor((pos[1] - m) / s), hiY = Math.floor((pos[1] + m) / s)
    const loZ = Math.floor((pos[2] - m) / s), hiZ = Math.floor((pos[2] + m) / s)
    for (let cx = loX; cx <= hiX; cx++) for (let cy = loY; cy <= hiY; cy++) for (let cz = loZ; cz <= hiZ; cz++) {
      const key = cx + ',' + cy + ',' + cz
      let bucket = this.cells.get(key)
      if (!bucket) { bucket = []; this.cells.set(key, bucket) }
      bucket.push({ id, pos })
    }
  }
  queryRay(origin, direction, maxDist, onCandidate) {
    const s = this.cellSize
    let cx = Math.floor(origin[0] / s), cy = Math.floor(origin[1] / s), cz = Math.floor(origin[2] / s)
    const stepX = direction[0] > 0 ? 1 : direction[0] < 0 ? -1 : 0
    const stepY = direction[1] > 0 ? 1 : direction[1] < 0 ? -1 : 0
    const stepZ = direction[2] > 0 ? 1 : direction[2] < 0 ? -1 : 0
    const bound = (o, d, c) => (d === 0 ? Infinity : ((d > 0 ? c * s + s : c * s) - o) / d)
    let tMaxX = bound(origin[0], direction[0], cx)
    let tMaxY = bound(origin[1], direction[1], cy)
    let tMaxZ = bound(origin[2], direction[2], cz)
    const tDeltaX = stepX !== 0 ? Math.abs(s / direction[0]) : Infinity
    const tDeltaY = stepY !== 0 ? Math.abs(s / direction[1]) : Infinity
    const tDeltaZ = stepZ !== 0 ? Math.abs(s / direction[2]) : Infinity
    const visited = new Set()
    let t = 0
    let guard = 0
    const guardMax = Math.ceil(maxDist / s) * 3 + 8
    while (t <= maxDist && guard++ < guardMax) {
      const key = cx + ',' + cy + ',' + cz
      if (!visited.has(key)) {
        visited.add(key)
        const bucket = this.cells.get(key)
        if (bucket) for (let i = 0; i < bucket.length; i++) onCandidate(bucket[i])
      }
      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) { cx += stepX; t = tMaxX; tMaxX += tDeltaX }
        else { cz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ }
      } else {
        if (tMaxY < tMaxZ) { cy += stepY; t = tMaxY; tMaxY += tDeltaY }
        else { cz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ }
      }
      if (stepX === 0 && stepY === 0 && stepZ === 0) break
    }
  }
  size() { let n = 0; for (const b of this.cells.values()) n += b.length; return n }
}

const PLAYER_COUNT = 300
const players = []
for (let i = 0; i < PLAYER_COUNT; i++) {
  players.push({ id: `p${i}`, pos: [unit(i, 21) * 400 - 200, unit(i, 22) * 60 - 30, unit(i, 23) * 400 - 200] })
}
players.push({ id: 'mid', pos: [3e9, 0, 0] })
players.push({ id: 'farPos', pos: [2 ** 35 + 5, 3, 3] })
players.push({ id: 'farNeg', pos: [-(2 ** 35) + 5, 3, 3] })

const index = new RewindSpatialIndex(16)
const reference = new ReferenceIndex(16)
for (const p of players) { index.insert(p.id, p.pos); reference.insert(p.id, p.pos) }

const RAY_COUNT = 400
const rays = []
for (let r = 0; r < RAY_COUNT; r++) {
  const origin = [unit(r, 31) * 480 - 240, unit(r, 32) * 80 - 40, unit(r, 33) * 480 - 240]
  let direction = [unit(r, 34) * 2 - 1, unit(r, 35) * 2 - 1, unit(r, 36) * 2 - 1]
  if (r % 7 === 0) direction[1] = 0
  if (r % 11 === 0) direction = [1, 0, 0]
  rays.push({ origin, direction, maxDist: 40 + unit(r, 37) * 300 })
}
rays.push({ origin: [-(2 ** 35) + 5, 3, 3], direction: [1, 0, 0], maxDist: 8 })
rays.push({ origin: [2 ** 35 + 5, 3, 3], direction: [-1, 0, 0], maxDist: 8 })

const collect = (idx, ray) => {
  const ids = []
  idx.queryRay(ray.origin, ray.direction, ray.maxDist, (e) => ids.push(e.id))
  return ids
}

let rayMismatch = 0
let queryMaps = 0
const farNegIds = []
const farPosIds = []
for (let r = 0; r < rays.length; r++) {
  counts.mapNew = 0
  const got = collect(index, rays[r])
  queryMaps += counts.mapNew
  const want = collect(reference, rays[r])
  if (JSON.stringify(got) !== JSON.stringify(want)) rayMismatch++
  if (r === RAY_COUNT) farNegIds.push(...got)
  if (r === RAY_COUNT + 1) farPosIds.push(...got)
}

check(`all ${rays.length} rays yield the reference candidates in the same order`, rayMismatch === 0, `${rayMismatch} ray(s) differ`)
check('a far negative ray sees only its own cell, not the hash-sharing far positive', JSON.stringify(farNegIds) === JSON.stringify(['farNeg']), JSON.stringify(farNegIds))
check('a far positive ray sees only the far positive', farPosIds.length > 0 && farPosIds.every((id) => id === 'farPos'), JSON.stringify(farPosIds))
check('every stored cell key is a number, so no string key is built', [...index.cells.keys()].every((k) => typeof k === 'number'))
check(`ray queries over ${rays.length} rays construct no Map`, queryMaps === 0, `new Map ${queryMaps}`)
check('index size equals the reference size', index.size() === reference.size(), `${index.size()} vs ${reference.size()}`)

const failed = checks.filter((ok) => !ok).length
const modules = `encoder ${path.relative(ROOT, encoderPath)}, rewind ${path.relative(ROOT, rewindPath)}`
if (failed) {
  console.log(`RESULT: FAIL ${failed} of ${checks.length} check(s) failed (${modules})`)
  process.exit(1)
}
console.log(`RESULT: PASS ${checks.length} of ${checks.length} checks: ${TICKS} encodeDelta ticks matched a fresh reference with no Map in steady state, ${rays.length} rays matched the string-keyed reference with no Map (${modules})`)
process.exit(0)
