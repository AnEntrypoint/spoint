import { resolveTarget } from '/src/shared/relocation.js'
import { listBookmarks } from '/src/shared/bookmarks.js'
import { searchBookmark } from './RelocationSearch.js'
import { whenSettled } from './RelocationSettle.js'

const WALK_ARRIVE_M = 3
const WALK_STUCK_MS = 8000
const WALK_STUCK_PROGRESS_M = 0.5
const WALK_TIMEOUT_BASE_MS = 20000
const WALK_TIMEOUT_PER_M_MS = 400
const BOOT_POLL_MS = 250
const BOOT_TERRAIN_WAIT_MS = 30000
const BOOT_GIVE_UP_MS = 300000
const SPEC_KEYS = ['clearance', 'snap', 'alt']

const customBookmarks = new Map()
let walker = null

function requireClient() {
  const client = window.__client
  if (!client || !client.connected || typeof client.requestTeleport !== 'function') throw new Error('__spoint: no connected client yet')
  return client
}

function planet() {
  const t = window.__terrain
  if (!t || !t.frame) return null
  return { frame: t.frame, heightAt: (x, z) => t.frame.groundHeightLocal(x, z), sampler: t.sampler, seed: t.seed }
}

function bookmarkTable() {
  const own = [...customBookmarks].map(([name, spec]) => ({ name, spec }))
  const derived = listBookmarks(window.__client?.config?.worldDef || null, planet()?.frame || null)
  return [...own, ...derived.filter(b => !customBookmarks.has(b.name))]
}

function hereSpec() {
  const local = requireClient().getLocalState()
  if (!local) throw new Error('__spoint: no local player state yet')
  return { x: local.position[0], y: local.position[1], z: local.position[2] }
}

async function specFor(target) {
  if (typeof target === 'string') {
    const b = bookmarkTable().find(entry => entry.name === target)
    if (!b) throw new Error(`unknown bookmark "${target}"; known: ${bookmarkTable().map(e => e.name).join(', ')}`)
    if (b.reachable === false) throw new Error(`bookmark "${target}" is ${b.angleDeg.toFixed(1)} deg from the anchor, beyond the local frame (reaches under ~87 deg)`)
    if (b.search) {
      const pl = planet()
      if (!pl) throw new Error(`bookmark "${target}" needs the planet frame (terrain not ready)`)
      const xz = await searchBookmark(b.search, pl)
      return { x: xz.x, z: xz.z }
    }
    return b.spec
  }
  if (target && typeof target === 'object' && target.bookmark !== undefined) return specFor(target.bookmark)
  return target
}

function withOptions(spec, opts) {
  const merged = { ...spec }
  for (const key of SPEC_KEYS) if (opts[key] !== undefined) merged[key] = opts[key]
  return merged
}

async function teleport(target, opts = {}) {
  const client = requireClient()
  const spec = withOptions(await specFor(target), opts)
  const t0 = performance.now()
  const { placed, grounded } = await client.requestTeleport('to', spec, opts.timeoutMs)
  return { spec, placed: placed.position, worker: { groundHit: grounded.groundHit, groundY: grounded.groundY, heldMs: grounded.heldMs }, ms: Math.round(performance.now() - t0) }
}

async function go(target, opts = {}) {
  const t0 = performance.now()
  const moved = await teleport(target, opts)
  const settled = await whenSettled(opts.settle)
  return { target: typeof target === 'string' ? target : moved.spec, placed: moved.placed, worker: moved.worker, ...settled, ms: Math.round(performance.now() - t0) }
}

async function walkTo(target, { speed, arriveM = WALK_ARRIVE_M, timeoutMs }) {
  const pl = planet()
  const goal = resolveTarget(await specFor(target), { frame: pl?.frame, heightAt: pl?.heightAt })
  const start = requireClient().getLocalState().position
  const distance = Math.hypot(goal.x - start[0], goal.z - start[2])
  const sprint = speed > (window.__client?.config?.worldDef?.movement?.maxSpeed ?? 7)
  const t0 = performance.now()
  return new Promise((resolve, reject) => {
    const budgetMs = timeoutMs ?? WALK_TIMEOUT_BASE_MS + distance * WALK_TIMEOUT_PER_M_MS
    const timer = setTimeout(() => { walker = null; reject(new Error(`walk to ${JSON.stringify(target)} timed out after ${Math.round(budgetMs)}ms`)) }, budgetMs)
    const finish = (report) => { clearTimeout(timer); walker = null; resolve({ target, distanceStartM: Math.round(distance), ms: Math.round(performance.now() - t0), ...report }) }
    walker = { x: goal.x, z: goal.z, sprint, arriveM, finish, bestDist: Infinity, progressAt: performance.now() }
  })
}

function drive(input, cam) {
  if (!walker) return
  const local = window.__client?.getLocalState()
  if (!local) return
  const p = local.position
  const dx = walker.x - p[0], dz = walker.z - p[2]
  const dist = Math.hypot(dx, dz)
  const now = performance.now()
  if (dist < walker.arriveM) { walker.finish({ reached: true, distanceM: +dist.toFixed(2), position: [...p] }); return }
  if (dist < walker.bestDist - WALK_STUCK_PROGRESS_M) { walker.bestDist = dist; walker.progressAt = now }
  else if (now - walker.progressAt > WALK_STUCK_MS) { walker.finish({ reached: false, reason: 'no progress', distanceM: +dist.toFixed(2), position: [...p] }); return }
  cam.setVRYaw(Math.atan2(dx, dz))
  input.forward = true; input.backward = false; input.left = false; input.right = false
  input.sprint = walker.sprint
}

async function route(waypoints, opts = {}) {
  const { mode = 'jump', speed = 12, settle = true } = opts
  if (!Array.isArray(waypoints) || !waypoints.length) throw new Error('route needs a non-empty waypoint array')
  const reports = []
  for (const wp of waypoints) {
    if (mode === 'jump') reports.push(await go(wp, opts))
    else if (mode === 'walk') {
      const walked = await walkTo(wp, { speed, arriveM: opts.arriveM, timeoutMs: opts.timeoutMs })
      reports.push(settle ? { ...walked, settled: await whenSettled(opts.settle) } : walked)
    } else throw new Error(`route mode must be "jump" or "walk", got ${mode}`)
  }
  return reports
}

function bookmarks(name, spec) {
  if (name === undefined) {
    return bookmarkTable().map(b => ({ name: b.name, kind: b.search ? 'search' : 'coords', reachable: b.reachable ?? true, tiltWalkable: b.tiltWalkable ?? true, angleDeg: b.angleDeg ?? null, custom: customBookmarks.has(b.name) }))
  }
  if (spec === undefined) return specFor(name)
  customBookmarks.set(name, spec === 'here' ? hereSpec() : spec)
  return customBookmarks.size
}

function where() {
  const local = requireClient().getLocalState()
  return local ? { position: [...local.position], velocity: [...local.velocity], onGround: local.onGround } : null
}

function parseTarget(raw) {
  if (raw.startsWith('ll:')) {
    const [lat, lon, alt] = raw.slice(3).split(',').map(Number)
    return alt === undefined ? { lat, lon } : { lat, lon, alt }
  }
  const nums = raw.split(',').map(Number)
  if (nums.length >= 2 && nums.every(Number.isFinite)) return nums.length === 2 ? { x: nums[0], z: nums[1] } : { x: nums[0], y: nums[1], z: nums[2] }
  return raw
}

function bootFromUrl() {
  const q = new URLSearchParams(location.search)
  const hashAt = location.hash.indexOf('?')
  if (hashAt >= 0) for (const [k, v] of new URLSearchParams(location.hash.slice(hashAt + 1))) if (!q.has(k)) q.append(k, v)
  const raw = q.get('at') ?? q.get('bookmark') ?? q.get('spawn')
  if (raw === null) return
  const target = parseTarget(raw)
  const t0 = performance.now()
  const poll = setInterval(() => {
    const elapsed = performance.now() - t0
    const c = window.__client
    const ready = c && c.connected && c.playerId != null && c.getLocalState() && (window.__terrain?.frame || elapsed > BOOT_TERRAIN_WAIT_MS)
    if (!ready && elapsed < BOOT_GIVE_UP_MS) return
    clearInterval(poll)
    if (!ready) { window.__spointBoot = { error: 'client never became ready' }; return }
    go(target).then(report => { window.__spointBoot = { report }; console.log('[spoint] boot relocation settled', JSON.stringify(report)) })
      .catch(error => { window.__spointBoot = { error: error.message, report: error.report }; console.error('[spoint] boot relocation failed:', error.message) })
  }, BOOT_POLL_MS)
}

window.__spoint = { teleport, relocate: teleport, go, whenSettled, route, bookmarks, where, _drive: drive }
bootFromUrl()
