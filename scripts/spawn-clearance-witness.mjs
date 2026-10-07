import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createNetServer } from 'node:net'

if (typeof globalThis.WebSocket !== 'function') {
  const { WebSocket } = await import('ws')
  globalThis.WebSocket = WebSocket
}

process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))

const WORLD = process.env.WORLD || 'empty'
const BLOCKER_HALF_XZ_M = 2
const BLOCKER_XZ = [0, 0]
const CONTROL_POINT = [0, 1, -14]
const SPAWN_Y = 1
const HEIGHTS_M = [0.2, 0.4, 0.6, 0.8, 0.9, 1.0, 1.4, 1.8]
const OFFSETS_M = [2.1, 2.2, 2.3, 2.4, 2.5]
const SETTLE_MS = Number(process.env.SETTLE_MS || 250)

const DEFAULT_HITBOX = { centerHeight: 0.9, radiusSq: 0.36, height: 1.8 }
const CAPSULE_RADIUS_M = Math.sqrt(DEFAULT_HITBOX.radiusSq)
const CAPSULE_HEIGHT_M = DEFAULT_HITBOX.height

const numberArg = (name, fallback) => {
  const raw = process.argv.find(a => a.startsWith(`--${name}=`))
  const value = Number(raw ? raw.slice(name.length + 3) : NaN)
  return Number.isFinite(value) ? value : fallback
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
  })
}

const failures = []
function check(ok, message) {
  if (ok) return true
  failures.push(message)
  return false
}

const { createServer } = await import('../src/sdk/server.js')
const { loadWorldModule } = await import('../src/sdk/WorldLocator.js')
const { evaluateSpawnPoint } = await import('../apps/tps-game/respawn-clearance.js')
const gameplay = await import('../src/apps/AppGameplay.js')
const MATERIAL_INTRUSION_M = Number.isFinite(gameplay.MAX_FOOTPRINT_INTRUSION_M) ? gameplay.MAX_FOOTPRINT_INTRUSION_M : 0.15

const port = await freePort()
const worldDef = await loadWorldModule(resolve(SDK_ROOT, 'apps', 'world', WORLD + '.js'))
const server = await createServer({
  port,
  tickRate: worldDef.tickRate || 60,
  appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src', 'stdlib-apps')],
  sdkRoot: SDK_ROOT,
  gravity: worldDef.gravity,
  staticDirs: [],
  storageDir: resolve(SDK_ROOT, 'data', 'spawn-clearance-witness'),
})
await server.loadWorld(worldDef)
await server.start()
await sleep(1200)

const runtime = server.runtime
const physics = server.physics
const ctx = [...runtime.contexts.values()].find(c => c.players && typeof c.raycast === 'function' && typeof c.pickSpawnPoint === 'function')

if (!ctx) {
  console.error(`RESULT: FAIL -- world "${WORLD}" produced no app context exposing pickSpawnPoint`)
  try { await server.stop?.() } catch {}
  process.exit(1)
}

const playerCount = ctx.players.getAll().length
check(playerCount === 0, `expected an empty room so candidate order is preserved, but ${playerCount} player(s) are connected`)

const realRaycast = ctx.raycast.bind(ctx)
const probe = { rays: 0, downColumns: new Set() }
ctx.raycast = (origin, direction, maxDistance, excludeBodyId) => {
  probe.rays++
  if (direction[1] === -1 && direction[0] === 0 && direction[2] === 0) {
    probe.downColumns.add(`${origin[0].toFixed(4)},${origin[2].toFixed(4)}`)
  }
  return realRaycast(origin, direction, maxDistance, excludeBodyId)
}

function resetProbe() {
  probe.rays = 0
  probe.downColumns.clear()
}

function floorYAt(x, z) {
  const r = realRaycast([x, 40, z], [0, -1, 0], 200)
  return r && r.hit && Number.isFinite(r.position?.[1]) ? r.position[1] : null
}

function blockerBounds(bodyId) {
  const body = physics.bodies.get(bodyId)
  if (!body) return null
  const bb = body.GetWorldSpaceBounds()
  const mn = bb.mMin
  const mx = bb.mMax
  const out = { minX: mn.GetX(), minY: mn.GetY(), minZ: mn.GetZ(), maxX: mx.GetX(), maxY: mx.GetY(), maxZ: mx.GetZ() }
  bb.delete?.()
  return out
}

function capsuleHitsBlocker(bounds, x, z, feetY) {
  const gapX = Math.max(bounds.minX - x, 0, x - bounds.maxX)
  const gapZ = Math.max(bounds.minZ - z, 0, z - bounds.maxZ)
  const planarGapM = Math.hypot(gapX, gapZ)
  const axisLowY = feetY + CAPSULE_RADIUS_M
  const axisHighY = feetY + CAPSULE_HEIGHT_M - CAPSULE_RADIUS_M
  let verticalGapM = 0
  if (bounds.maxY < axisLowY) verticalGapM = axisLowY - bounds.maxY
  else if (bounds.minY > axisHighY) verticalGapM = bounds.minY - axisHighY
  const distanceM = Math.hypot(planarGapM, verticalGapM)
  const penetrationM = CAPSULE_RADIUS_M - distanceM
  return {
    hits: penetrationM > 0,
    material: penetrationM > MATERIAL_INTRUSION_M,
    planarGapM,
    penetrationM,
  }
}

function generalPathSaysClear(candidate) {
  resetProbe()
  const pose = ctx.pickSpawnPoint([candidate, CONTROL_POINT], {})
  const raysFired = probe.rays
  const columns = probe.downColumns.size
  const choseCandidate = Math.abs(pose[0] - candidate[0]) < 1e-6 && Math.abs(pose[2] - candidate[2]) < 1e-6
  const choseControl = Math.abs(pose[0] - CONTROL_POINT[0]) < 1e-6 && Math.abs(pose[2] - CONTROL_POINT[2]) < 1e-6
  return { clear: choseCandidate, choseControl, pose, raysFired, columns }
}

function tpsPathSaysClear(candidate) {
  resetProbe()
  const evaluated = evaluateSpawnPoint(ctx, candidate, DEFAULT_HITBOX, () => false)
  return { clear: evaluated.blockers.length === 0, blockers: evaluated.blockers.length, raysFired: probe.rays, columns: probe.downColumns.size }
}

const rows = []
let totalFalseClear = 0
let totalFalseIntruding = 0
let totalIntersecting = 0
let totalMaterial = 0
let aboveRayHeightCandidates = 0
let aboveRayHeightRejected = 0
let controlAccepted = 0
let rayHeightSeen = null

for (const heightM of HEIGHTS_M) {
  const bodyId = physics.addStaticBox([BLOCKER_HALF_XZ_M, heightM / 2, BLOCKER_HALF_XZ_M], [BLOCKER_XZ[0], heightM / 2, BLOCKER_XZ[1]], [0, 0, 0, 1])
  await sleep(SETTLE_MS)
  const bounds = blockerBounds(bodyId)
  if (!bounds) {
    failures.push(`blocker of height ${heightM}m was added as body ${bodyId} but has no world-space bounds`)
    continue
  }

  const floorY = floorYAt(0, -8)
  const rayHeightM = floorY + DEFAULT_HITBOX.centerHeight
  if (rayHeightSeen === null) rayHeightSeen = rayHeightM

  let accepted = 0
  let intersecting = 0
  let material = 0
  let falseClear = 0
  let falseIntruding = 0
  let rays = 0
  let columns = 0

  for (const offsetM of OFFSETS_M) {
    const candidate = [BLOCKER_XZ[0] + offsetM, SPAWN_Y, BLOCKER_XZ[1]]
    const feetY = floorYAt(candidate[0], candidate[2])
    const truth = capsuleHitsBlocker(bounds, candidate[0], candidate[2], feetY)
    const general = generalPathSaysClear(candidate)
    const tps = tpsPathSaysClear(candidate)
    rays += general.raysFired + tps.raysFired
    columns = Math.max(columns, general.columns, tps.columns)
    if (truth.hits) intersecting++
    if (truth.material) material++
    if (general.clear) accepted++
    if (truth.material && general.clear) falseClear++
    if (!general.clear && !truth.hits) falseIntruding++
    if (bounds.maxY > rayHeightM) {
      aboveRayHeightCandidates++
      if (!general.clear) aboveRayHeightRejected++
    }
    rows.push({
      heightM,
      topY: Number(bounds.maxY.toFixed(4)),
      rayHeightM: Number(rayHeightM.toFixed(4)),
      offsetM,
      penetrationM: Number(truth.penetrationM.toFixed(4)),
      hitsBlocker: truth.hits,
      material: truth.material,
      generalClear: general.clear,
      tpsClear: tps.clear,
      generalRays: general.raysFired,
      tpsRays: tps.raysFired,
    })
  }

  const controlRun = generalPathSaysClear([...CONTROL_POINT])
  if (controlRun.choseControl) controlAccepted++

  totalFalseClear += falseClear
  totalFalseIntruding += falseIntruding
  totalIntersecting += intersecting
  totalMaterial += material

  const relation = bounds.maxY < rayHeightM ? 'below' : bounds.maxY > rayHeightM ? 'above' : 'at'
  console.log(
    `height=${heightM.toFixed(2)}m topY=${bounds.maxY.toFixed(3)} rayHeight=${rayHeightM.toFixed(3)} (${relation}) ` +
    `candidates=${OFFSETS_M.length} intersecting=${intersecting} material=${material} calledClear=${accepted} ` +
    `falseClear=${falseClear} falseIntruding=${falseIntruding} rays=${rays} downColumns=${columns} controlAccepted=${controlRun.choseControl}`
  )
  physics.removeBody(bodyId, true)
  await sleep(SETTLE_MS)
}

for (const r of rows) {
  console.log(
    `row h=${r.heightM.toFixed(2)} top=${r.topY} ray=${r.rayHeightM} off=${r.offsetM} pen=${r.penetrationM} ` +
    `hits=${r.hitsBlocker} material=${r.material} generalClear=${r.generalClear} tpsClear=${r.tpsClear} rays(general/tps)=${r.generalRays}/${r.tpsRays}`
  )
}

console.log(
  `totals heights=${HEIGHTS_M.length} candidates=${rows.length} intersecting=${totalIntersecting} material=${totalMaterial} ` +
  `falseClear=${totalFalseClear} falseIntruding=${totalFalseIntruding} ` +
  `aboveRayHeightRejected=${aboveRayHeightRejected}/${aboveRayHeightCandidates} controlAccepted=${controlAccepted}/${HEIGHTS_M.length} rayHeight=${rayHeightSeen}`
)

check(totalIntersecting > 0, `no candidate spawn point actually intersected a blocker, so the fixture proves nothing (intersecting=${totalIntersecting})`)
check(totalFalseClear === 0, `${totalFalseClear} of ${totalMaterial} materially intersecting candidate spawn point(s) (penetration > ${MATERIAL_INTRUSION_M}m) were reported clear`)
check(totalFalseIntruding === 0, `${totalFalseIntruding} candidate spawn point(s) that no blocker geometry touches at all were reported blocked, so the clearance test over-rejects`)
check(controlAccepted === HEIGHTS_M.length, `the unblocked control spawn point was accepted for only ${controlAccepted} of ${HEIGHTS_M.length} blocker height(s), so the clearance test rejects every spawn point`)
check(aboveRayHeightRejected === aboveRayHeightCandidates, `only ${aboveRayHeightRejected} of ${aboveRayHeightCandidates} candidate(s) beside a blocker taller than the probe height were rejected, so tall-blocker clearance regressed`)

try { await server.stop?.() } catch {}
await sleep(300)

if (failures.length) {
  console.error(`RESULT: FAIL (${failures.length} check(s))`)
  for (const f of failures) console.error(`  FAIL ${f}`)
  process.exit(1)
}
console.log(`RESULT: PASS -- ${totalIntersecting} intersecting candidate(s) across ${HEIGHTS_M.length} blocker height(s), 0 called clear, control accepted ${controlAccepted}/${HEIGHTS_M.length}`)
process.exit(0)
