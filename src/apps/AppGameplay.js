import * as hitscan from '../netcode/Hitscan.js'
import { recordHit } from '../netcode/OutlierDetector.js'
import { spawnSurfaceY } from '../shared/SpawnSurface.js'

const FALL_DEPTH_BELOW_GROUND_M = 20
const FALL_FLOOR_WITHOUT_TERRAIN_Y = -20
const SPAWN_GROUND_CLEARANCE_M = 2
const SPAWN_MIN_SAFE_DISTANCE_M = 25
const LAST_RESORT_SPAWN = Object.freeze([0, 15, 0])
const DEFAULT_PERSIST_DEBOUNCE_MS = 500
const SPAWN_CLEARANCE_PROBE_M = 8
const SPAWN_CLEARANCE_FALLBACK_M = 0.6
const SPAWN_CLEARANCE_DIRS = (() => {
  const dirs = []
  for (let i = 0; i < 8; i++) dirs.push([Math.cos((i * Math.PI) / 4), Math.sin((i * Math.PI) / 4)])
  return dirs
})()
const PROBE_SKIN_M = 0.02
const VOID_PROBE_DEPTH_M = 1.5
export const MAX_FOOTPRINT_INTRUSION_M = 0.15
const FOOTPRINT_RING_FRACTIONS = [0.5, 1]
const FOOTPRINT_DIR_COUNT = 8
const FALLBACK_CAPSULE_RADIUS_M = 0.6
const FOOTPRINT_OFFSETS = (() => {
  const offsets = [[0, 0]]
  for (const fraction of FOOTPRINT_RING_FRACTIONS) {
    for (let i = 0; i < FOOTPRINT_DIR_COUNT; i++) {
      const angle = (i * 2 * Math.PI) / FOOTPRINT_DIR_COUNT
      offsets.push([Math.cos(angle) * fraction, Math.sin(angle) * fraction])
    }
  }
  return offsets
})()
const CLEARANCE_PROBE_RISE_FRACTIONS = [0.08, 0.25, 0.5]

export const COMBAT_API = Object.freeze({ ...hitscan, recordHit })

export function fallFloorY(ctx, x, z, depth = FALL_DEPTH_BELOW_GROUND_M) {
  const groundY = ctx.terrainHeightAt(x, z)
  return Number.isFinite(groundY) ? groundY - depth : FALL_FLOOR_WITHOUT_TERRAIN_Y
}

function spawnSurfaceOf(ctx, sp, hitbox) {
  const terrainY = ctx.terrainHeightAt(sp[0], sp[2])
  const surfaceY = spawnSurfaceY((o, d, l) => ctx.raycast(o, d, l), sp, {
    standingOffset: hitbox.centerHeight,
    headroom: SPAWN_GROUND_CLEARANCE_M + hitbox.height,
    terrainY
  })
  return surfaceY !== null ? surfaceY : Number.isFinite(terrainY) ? terrainY : null
}

export function capsuleRadiusM(hitbox) {
  return Number.isFinite(hitbox?.radiusSq) && hitbox.radiusSq > 0
    ? Math.sqrt(hitbox.radiusSq)
    : FALLBACK_CAPSULE_RADIUS_M
}

export function capsuleHeightM(hitbox) {
  if (Number.isFinite(hitbox?.height) && hitbox.height > 0) return hitbox.height
  const derived = 2 * (Number.isFinite(hitbox?.centerHeight) ? hitbox.centerHeight : hitscan.DEFAULT_HITBOX.centerHeight)
  return derived > 0 ? derived : hitscan.DEFAULT_HITBOX.height
}

function capsuleBottomRiseM(distanceM, radiusM) {
  if (!(distanceM > 0)) return 0
  if (distanceM >= radiusM) return radiusM
  return radiusM - Math.sqrt(radiusM * radiusM - distanceM * distanceM)
}

function capsuleRadiusAtRiseM(riseM, radiusM, heightM) {
  const cylinderTopM = heightM - radiusM
  if (!(cylinderTopM > radiusM)) return radiusM
  if (riseM >= radiusM && riseM <= cylinderTopM) return radiusM
  const sphereCentreM = riseM < radiusM ? radiusM : cylinderTopM
  const gapM = Math.abs(riseM - sphereCentreM)
  const innerM = radiusM * radiusM - gapM * gapM
  return innerM > 0 ? Math.sqrt(innerM) : 0
}

function withinContactDisc(distanceM, radiusM) {
  return distanceM < radiusM
}

function surfaceYOf(hit) {
  return hit && hit.hit && Number.isFinite(hit.position?.[1]) ? hit.position[1] : null
}

export function footprintBlockers(ctx, sp, feetY, hitbox = hitscan.DEFAULT_HITBOX) {
  const radiusM = capsuleRadiusM(hitbox)
  const heightM = capsuleHeightM(hitbox)
  const blockers = []
  for (const [unitX, unitZ] of FOOTPRINT_OFFSETS) {
    const offsetX = unitX * radiusM
    const offsetZ = unitZ * radiusM
    const distanceM = Math.hypot(offsetX, offsetZ)
    const riseM = capsuleBottomRiseM(distanceM, radiusM)
    const bottomY = feetY + riseM
    const topY = feetY + heightM - riseM
    const sampleX = sp[0] + offsetX
    const sampleZ = sp[2] + offsetZ
    const probeLengthM = topY - bottomY + VOID_PROBE_DEPTH_M
    if (!(probeLengthM > 0)) continue
    const support = ctx.raycast([sampleX, topY - PROBE_SKIN_M, sampleZ], [0, -1, 0], probeLengthM)
    const supportY = surfaceYOf(support)
    if (supportY === null) {
      if (withinContactDisc(distanceM, radiusM)) {
        blockers.push({ kind: 'void', x: sampleX, z: sampleZ, offsetM: distanceM, surfaceY: null, intrusionM: null })
      }
      continue
    }
    if (supportY > bottomY + MAX_FOOTPRINT_INTRUSION_M) {
      blockers.push({ kind: 'intruding', x: sampleX, z: sampleZ, offsetM: distanceM, surfaceY: supportY, intrusionM: supportY - bottomY })
    }
  }
  return blockers
}

function clearanceProbeRisesM(radiusM, heightM, centreM) {
  const rises = CLEARANCE_PROBE_RISE_FRACTIONS.map(fraction => radiusM * fraction)
  rises.push(radiusM, centreM, Math.max(radiusM, heightM - radiusM))
  const unique = []
  for (const riseM of rises) if (!unique.some(seen => Math.abs(seen - riseM) < 1e-6)) unique.push(riseM)
  return unique.sort((a, b) => a - b)
}

function clearanceMarginM(ctx, x, feetY, z, hitbox, probeM) {
  const radiusM = capsuleRadiusM(hitbox)
  const heightM = capsuleHeightM(hitbox)
  const centreM = Number.isFinite(hitbox?.centerHeight) && hitbox.centerHeight > 0 ? hitbox.centerHeight : heightM / 2
  let marginM = probeM
  for (const riseM of clearanceProbeRisesM(radiusM, heightM, centreM)) {
    const neededM = capsuleRadiusAtRiseM(riseM, radiusM, heightM)
    if (!(neededM > 0)) continue
    const y = feetY + riseM
    for (const [dx, dz] of SPAWN_CLEARANCE_DIRS) {
      const r = ctx.raycast([x, y, z], [dx, 0, dz], probeM)
      if (r && r.hit && r.distance - neededM < marginM) marginM = r.distance - neededM
    }
  }
  return marginM
}

function spawnPlacement(ctx, sp, hitbox, clearanceNeeded) {
  const surfaceY = spawnSurfaceOf(ctx, sp, hitbox)
  if (surfaceY === null) return null
  const probeM = Math.max(SPAWN_CLEARANCE_PROBE_M, clearanceNeeded)
  return {
    pose: [sp[0], surfaceY + SPAWN_GROUND_CLEARANCE_M, sp[2]],
    clearance: clearanceMarginM(ctx, sp[0], surfaceY, sp[2], hitbox, probeM),
    blockers: footprintBlockers(ctx, sp, surfaceY, hitbox)
  }
}

export function pickSpawnPoint(ctx, spawnPoints, { exclude = () => false, minSafeDistance = SPAWN_MIN_SAFE_DISTANCE_M, hitbox = hitscan.DEFAULT_HITBOX } = {}) {
  const active = ctx.players.getAll().filter(p => p.state && !exclude(p))
  let candidates = spawnPoints
  if (active.length > 0) {
    const scored = spawnPoints.map(sp => ({ sp, minDist: Math.min(...active.map(p => Math.hypot(sp[0] - p.state.position[0], sp[2] - p.state.position[2]))) }))
    const safe = scored.filter(s => s.minDist >= minSafeDistance)
    candidates = safe.length > 0 ? safe.map(s => s.sp) : scored.sort((a, b) => b.minDist - a.minDist).map(s => s.sp)
  }
  const clearanceNeeded = Number.isFinite(hitbox?.radiusSq) && hitbox.radiusSq > 0 ? Math.sqrt(hitbox.radiusSq) : SPAWN_CLEARANCE_FALLBACK_M
  let roomiest = null
  for (const sp of [...candidates, LAST_RESORT_SPAWN]) {
    const placed = spawnPlacement(ctx, sp, hitbox, clearanceNeeded)
    if (!placed) continue
    if (placed.blockers.length === 0 && placed.clearance >= 0) return placed.pose
    if (!roomiest || placed.clearance > roomiest.clearance) roomiest = placed
  }
  return roomiest ? roomiest.pose : candidates[0] ? [...candidates[0]] : [...LAST_RESORT_SPAWN]
}

export function leaderboard(ctx, key, { order = 'asc', maxEntries = 100 } = {}) {
  const store = persisted(ctx, key, {})
  const better = order === 'asc' ? (a, b) => a < b : (a, b) => a > b
  const valueOf = e => e.value ?? e.timeMs
  return {
    ready: store.ready,
    record(scope, name, value) {
      const list = store.value[scope] || (store.value[scope] = [])
      const at = list.findIndex(e => e.name === name)
      const previousBest = at >= 0 ? valueOf(list[at]) : null
      if (at >= 0) {
        if (!better(value, previousBest)) return { recorded: false, rank: null, previousBest }
        list.splice(at, 1)
      }
      list.push({ name, value, timeMs: value, ts: Date.now() })
      list.sort((a, b) => order === 'asc' ? valueOf(a) - valueOf(b) : valueOf(b) - valueOf(a))
      if (list.length > maxEntries) list.length = maxEntries
      store.save()
      const rank = list.findIndex(e => e.name === name && valueOf(e) === value)
      return { recorded: true, rank: rank >= 0 ? rank + 1 : null, previousBest }
    },
    top(scope, n = 10) { return (store.value[scope] || []).slice(0, n) },
    entryCount() { return Object.values(store.value).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0) },
    flush() { return store.flush() }
  }
}

export function persisted(ctx, key, initial, { debounceMs = DEFAULT_PERSIST_DEBOUNCE_MS } = {}) {
  let value = initial
  let timer = null
  const write = async () => {
    try { await ctx.storage?.set(key, value) } catch (e) { console.error(`[persisted] ${key} write error:`, e.message) }
  }
  const ready = (async () => {
    try {
      const saved = await ctx.storage?.get(key)
      if (saved !== undefined && saved !== null && typeof saved === typeof initial) value = saved
    } catch (e) { console.error(`[persisted] ${key} load error:`, e.message) }
  })()
  return {
    ready,
    get value() { return value },
    set value(v) { value = v },
    save() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; write() }, debounceMs)
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null }
      await ready
      await write()
    }
  }
}
