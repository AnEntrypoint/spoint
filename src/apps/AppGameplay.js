import * as hitscan from '../netcode/Hitscan.js'
import { recordHit } from '../netcode/OutlierDetector.js'
import { spawnSurfaceY } from '../shared/SpawnSurface.js'

const FALL_DEPTH_BELOW_GROUND_M = 20
const FALL_FLOOR_WITHOUT_TERRAIN_Y = -20
const SPAWN_GROUND_CLEARANCE_M = 2
const SPAWN_MIN_SAFE_DISTANCE_M = 25
const LAST_RESORT_SPAWN = Object.freeze([0, 15, 0])
const DEFAULT_PERSIST_DEBOUNCE_MS = 500

export const COMBAT_API = Object.freeze({ ...hitscan, recordHit })

export function fallFloorY(ctx, x, z, depth = FALL_DEPTH_BELOW_GROUND_M) {
  const groundY = ctx.terrainHeightAt(x, z)
  return Number.isFinite(groundY) ? groundY - depth : FALL_FLOOR_WITHOUT_TERRAIN_Y
}

function groundSnap(ctx, sp, hitbox) {
  const terrainY = ctx.terrainHeightAt(sp[0], sp[2])
  const surfaceY = spawnSurfaceY((o, d, l) => ctx.raycast(o, d, l), sp, {
    standingOffset: hitbox.centerHeight,
    headroom: SPAWN_GROUND_CLEARANCE_M + hitbox.height,
    terrainY
  })
  if (surfaceY !== null) return [sp[0], surfaceY + SPAWN_GROUND_CLEARANCE_M, sp[2]]
  if (Number.isFinite(terrainY)) return [sp[0], terrainY + SPAWN_GROUND_CLEARANCE_M, sp[2]]
  return null
}

export function pickSpawnPoint(ctx, spawnPoints, { exclude = () => false, minSafeDistance = SPAWN_MIN_SAFE_DISTANCE_M, hitbox = hitscan.DEFAULT_HITBOX } = {}) {
  const active = ctx.players.getAll().filter(p => p.state && !exclude(p))
  let candidates = spawnPoints
  if (active.length > 0) {
    const scored = spawnPoints.map(sp => ({ sp, minDist: Math.min(...active.map(p => Math.hypot(sp[0] - p.state.position[0], sp[2] - p.state.position[2]))) }))
    const safe = scored.filter(s => s.minDist >= minSafeDistance)
    candidates = safe.length > 0 ? safe.map(s => s.sp) : scored.sort((a, b) => b.minDist - a.minDist).map(s => s.sp)
  }
  for (const sp of [...candidates, LAST_RESORT_SPAWN]) {
    const snapped = groundSnap(ctx, sp, hitbox)
    if (snapped) return snapped
  }
  return candidates[0] ? [...candidates[0]] : [...LAST_RESORT_SPAWN]
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
  const write = () => ctx.storage?.set(key, value).catch(e => console.error(`[persisted] ${key} write error:`, e.message))
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
