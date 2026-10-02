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

function horizontalClearanceM(ctx, x, y, z, probeM) {
  let min = probeM
  for (const [dx, dz] of SPAWN_CLEARANCE_DIRS) {
    const r = ctx.raycast([x, y, z], [dx, 0, dz], probeM)
    if (r && r.hit && r.distance < min) min = r.distance
  }
  return min
}

function spawnPlacement(ctx, sp, hitbox, clearanceNeeded) {
  const surfaceY = spawnSurfaceOf(ctx, sp, hitbox)
  if (surfaceY === null) return null
  const probeM = Math.max(SPAWN_CLEARANCE_PROBE_M, clearanceNeeded)
  return {
    pose: [sp[0], surfaceY + SPAWN_GROUND_CLEARANCE_M, sp[2]],
    clearance: horizontalClearanceM(ctx, sp[0], surfaceY + hitbox.centerHeight, sp[2], probeM)
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
    if (placed.clearance >= clearanceNeeded) return placed.pose
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
