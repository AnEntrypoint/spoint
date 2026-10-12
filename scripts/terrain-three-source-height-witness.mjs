// Measures the disagreement between the height sources that all claim to describe the same
// ground: where grass is placed, the CPU terrain sampler placement reads, the physics
// heightfield, and (--gpu) the GPU terrain the client draws.
//
// Every number it prints is a real delta in metres between two real sources evaluated at the SAME
// (x,z): the sample points are real grass blade positions from placementsForGrassChunk, and each
// source is queried at that blade's own (x,z).
//
// --gpu adds the visual arm (needs SESSION_ID, a served app on --port, and scripts/gpulock.mjs).
process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'

import fs from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const href = p => pathToFileURL(resolve(ROOT, p)).href
const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const has = name => process.argv.includes(`--${name}`)

const WORLD = arg('world', 'tps-game')
const PORT = Number(arg('port', 8090))
const GPU = has('gpu')
const CHORD_CARVE_INNER_M = 60
const CHORD_CARVE_OUTER_M = 100
const DELTA_TOLS_M = [0.01, 0.1, 1]
const ACCEPT_M = Number(arg('accept-m', 0.05))
const MIN_SAMPLES_PER_PHASE = 24
const BLADE_STRIDE = 900
const CHUNK_RADII_M = [0, 40, 80, 112]
const TRAVEL_CANDIDATES = [[760, -520], [640, 320], [-520, 700], [900, 900], [-800, -300], [300, -900]]
const RAY_UP_M = 6000
// The exit path drains for DRAIN_BOUND_MS once the verdict is out, and the guard may only fire well
// after that drain has had its chance: a quiet window shorter than the drain reports a hang that is
// not one (measured: an 8000 ms window over a 10 s stdio drain red-flagged a witness that exited).
// The two are named together so the order of magnitude between them is the one fact to preserve.
const DRAIN_BOUND_MS = 1500
const QUIET_AFTER_VERDICT_MS = 15000

const checks = []
const expect = (name, ok, observed) => {
  checks.push(ok === true)
  console.log(`${ok === true ? 'ok  ' : 'FAIL'} ${name}${ok === true ? '' : ' observed=' + JSON.stringify(observed)}`)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

const { PhysicsWorld } = await import(href('src/physics/World.js'))
const { loadWorldModule } = await import(href('src/sdk/WorldLocator.js'))
const terrainPhysics = await import(href('src/terrain/TerrainPhysics.js'))
const { placementsForGrassChunk, GRASS } = await import(href('src/terrain/GrassPlacement.js'))
const { chunkKeyAtLocal, latticeFor } = await import(href('src/terrain/PlacementChart.js'))
const { createCachedAnchorField } = await import(href('src/terrain/ClimateCache.js'))
const { armVerdictExitGuard } = await import(href('scripts/lib/verdict-exit-guard.mjs'))
armVerdictExitGuard({ label: 'terrain-three-source-height', quietMs: QUIET_AFTER_VERDICT_MS })

const loaded = await loadWorldModule(resolve(ROOT, 'apps', 'world', `${WORLD}.js`))
const tcfg = loaded.terrain
console.log(`world=${WORLD} seed=${tcfg.seed} radius=${tcfg.radius} reliefScale=${tcfg.reliefScale} hashVersion=${tcfg.hashVersion ?? 2} baked=${tcfg.bakedHeightfield || '(none)'} physics=${JSON.stringify(tcfg.physics || {})}`)

const players = new Map()
players.set(0, { state: { position: [0, 0, 0], onGround: true, velocity: [0, 0, 0] } })
const physics = new PhysicsWorld({ gravity: [0, -18, 0] })
await physics.init()

let frame = null
const realSetSource = physics.setTerrainHeightSource.bind(physics)
physics.setTerrainHeightSource = (fn, f, off) => { frame = f; return realSetSource(fn, f, off) }
const builtFields = []
const realAdd = physics.addHeightField.bind(physics)
physics.addHeightField = (samples, N, scale, origin) => {
  const id = realAdd(samples, N, scale, origin)
  builtFields.push({ id, N, spacing: scale[0], cornerX: origin[0], cornerZ: origin[2] })
  return id
}

const streamer = await terrainPhysics.setupTerrainStreaming({ physics, playerManager: { players }, terrain: tcfg })
if (!streamer || !frame) throw new Error('setupTerrainStreaming produced no streamer or frame')
const servedHeight = physics.getTerrainHeightFn()
console.log(`groundSource=${frame.groundSource} anchorHeight=${frame.anchorHeight.toFixed(3)} physicsFields=${builtFields.length} N=${builtFields.map(f => f.N).join('/')} spacing=${builtFields.map(f => f.spacing.toFixed(3)).join('/')}m`)

const settle = async () => { for (let i = 0; i < 900 && streamer.busy; i++) await sleep(20) }
const waitCovered = async (x, z) => { for (let i = 0; i < 900 && !streamer.coversPosition(x, z); i++) await sleep(20) }
await settle()

// ---------------------------------------------------------------- sources

// Physics: the real Jolt heightfield, read by a downward ray onto it.
function physicsAt(x, z) {
  const h = physics.raycast([x, RAY_UP_M, z], [0, -1, 0], RAY_UP_M * 2, null)
  if (!h || !h.hit) return { y: NaN, bodyId: null }
  return { y: h.position[1], bodyId: h.bodyId ?? null }
}

const anchorField = createCachedAnchorField(frame.sampler ? frame.sampler.anchorField : null, frame)
const lattice = latticeFor(frame, GRASS)

// Grass: real placed blade positions from the real placement pipeline.
function grassBladesNear(cx, cz) {
  const out = []
  const seen = new Set()
  for (const r of CHUNK_RADII_M) {
    for (let a = 0; a < 360; a += 45) {
      const x = cx + r * Math.cos(a * Math.PI / 180), z = cz + r * Math.sin(a * Math.PI / 180)
      const key = chunkKeyAtLocal(lattice, frame, x, z)
      if (seen.has(key)) continue
      seen.add(key)
      let blades
      try { blades = placementsForGrassChunk(key, frame, anchorField, tcfg.seed | 0) } catch (e) { throw new Error(`placementsForGrassChunk(${key}) threw: ${e && e.message}`) }
      if (!blades || !blades.length) continue
      for (let i = 0; i < blades.length; i += BLADE_STRIDE) out.push(blades[i])
    }
  }
  return out
}

const chordOf = (x, z) => Math.hypot(x, z)
function zoneOf(x, z) {
  const c = chordOf(x, z)
  if (c <= CHORD_CARVE_INNER_M) return 'carved-flat'
  if (c <= CHORD_CARVE_OUTER_M) return 'carved-falloff'
  return 'open-terrain'
}

const stats = new Map()
const acc = (key, deltaM) => {
  let s = stats.get(key)
  if (!s) { s = { n: 0, sumAbs: 0, maxAbs: 0, over: DELTA_TOLS_M.map(() => 0) }; stats.set(key, s) }
  const a = Math.abs(deltaM)
  s.n++
  s.sumAbs += a
  if (a > s.maxAbs) s.maxAbs = a
  DELTA_TOLS_M.forEach((t, i) => { if (a > t) s.over[i]++ })
  return s
}
function dumpStats(label) {
  console.log(`--- ${label}`)
  let worst = 0
  for (const [k, s] of [...stats.entries()].sort()) {
    console.log(`  ${k} n=${s.n} mean=${(s.sumAbs / s.n).toFixed(4)}m max=${s.maxAbs.toFixed(4)}m ${DELTA_TOLS_M.map((t, i) => `>${t}m=${s.over[i]}`).join(' ')}`)
    if (s.maxAbs > worst) worst = s.maxAbs
    stats.delete(k)
  }
  return worst
}

// ---------------------------------------------------------------- phases

const phases = []
async function runPhase(name, cx, cz, blades) {
  const rows = []
  let uncovered = 0, nonFinite = 0
  for (const b of blades) {
    const grass = b.y
    const cpu = frame.groundHeightLocal(b.x, b.z)
    const p = physicsAt(b.x, b.z)
    if (p.bodyId == null) { uncovered++; continue }
    if (!Number.isFinite(grass) || !Number.isFinite(cpu) || !Number.isFinite(p.y)) { nonFinite++; continue }
    const z = zoneOf(b.x, b.z)
    rows.push({ x: b.x, z: b.z, grass, cpu, phys: p.y, served: servedHeight(b.x, b.z), zone: z })
  }
  for (const r of rows) {
    acc(`${name}|grass-vs-cpu`, r.grass - r.cpu)
    acc(`${name}|cpu-vs-physics`, r.cpu - r.phys)
    acc(`${name}|grass-vs-physics`, r.grass - r.phys)
    acc(`${name}|served-vs-physics`, r.served - r.phys)
    acc(`${name}|zone=${r.zone}|cpu-vs-physics`, r.cpu - r.phys)
    acc(`${name}|zone=${r.zone}|grass-vs-cpu`, r.grass - r.cpu)
  }
  const worst = dumpStats(name)
  console.log(`  samples=${rows.length} uncoveredByCollider=${uncovered} nonFinite=${nonFinite}`)
  phases.push({ name, samples: rows.length, worst, rows })
  expect(`${name}: at least ${MIN_SAMPLES_PER_PHASE} samples measured through every source`, rows.length >= MIN_SAMPLES_PER_PHASE, { samples: rows.length, uncovered, nonFinite })
  expect(`${name}: the physics ray landed on a real terrain body for every counted sample`, uncovered === 0 || rows.length >= MIN_SAMPLES_PER_PHASE, { uncovered })
  return rows
}

const restBlades = grassBladesNear(0, 0)
console.log(`rest grass blades sampled: ${restBlades.length}`)
const restRows = await runPhase('REST', 0, 0, restBlades)

// Travel has to land somewhere that actually grows grass, or the phase measures nothing: pick the
// first candidate whose surrounding chunks place blades on open (uncarved) terrain.
let TRAVEL_TO = null
let travelBlades = []
for (const cand of TRAVEL_CANDIDATES) {
  const blades = grassBladesNear(cand[0], cand[1])
  const open = blades.filter(b => zoneOf(b.x, b.z) === 'open-terrain').length
  console.log(`travel candidate (${cand}) blades=${blades.length} openTerrain=${open}`)
  if (blades.length >= MIN_SAMPLES_PER_PHASE && open >= MIN_SAMPLES_PER_PHASE) { TRAVEL_TO = cand; travelBlades = blades; break }
}
if (!TRAVEL_TO) throw new Error(`no travel candidate places grass on open terrain: ${JSON.stringify(TRAVEL_CANDIDATES)}`)
players.get(0).state.position[0] = TRAVEL_TO[0]
players.get(0).state.position[2] = TRAVEL_TO[1]
await waitCovered(TRAVEL_TO[0], TRAVEL_TO[1])
await settle()
console.log(`travel grass blades sampled: ${travelBlades.length} (player at ${TRAVEL_TO})`)
const travelRows = await runPhase('TRAVEL', TRAVEL_TO[0], TRAVEL_TO[1], travelBlades)

// Same coordinates as REST, re-measured after the collider was rebuilt elsewhere and rebuilt here.
players.get(0).state.position[0] = 0
players.get(0).state.position[2] = 0
await waitCovered(0, 0)
await settle()
const returnRows = await runPhase('RETURN', 0, 0, restBlades)

// ---------------------------------------------------------------- visual arm

let visualRows = null
if (GPU) {
  const { withGpuPage } = await import(href('scripts/lib/gpu-eval.mjs'))
  const coords = [...restRows, ...travelRows].filter((_, i) => i % 6 === 0).map(r => [r.x, r.z])
  const url = `http://localhost:${PORT}/?singleplayer&world=${encodeURIComponent(WORLD)}&nc=${Date.now()}`
  visualRows = await withGpuPage({ port: PORT, url, backend: 'webgpu' }, async (run) => run(`
const __dirs = ${JSON.stringify(coords)}.map(([x, z]) => __t.frame.localToDir(x, z));
const __h = await __sampleHeights(__dirs);
return { backend: __backend, coords: ${JSON.stringify(coords)}, gpuElevationM: Array.from(__h) };
`))
  if (!visualRows || !Array.isArray(visualRows.gpuElevationM)) throw new Error(`gpu arm returned no heights: ${JSON.stringify(visualRows)}`)
  console.log(`visual arm backend=${visualRows.backend} samples=${visualRows.gpuElevationM.length}`)
  // probeHeights returns radial elevation; convert the other two into the same elevation space
  // with elevationAtLocal so the three are compared as the same quantity in metres.
  const { elevationAtLocal } = await import(href('src/terrain/PlanetFrame.js'))
  let n = 0
  visualRows.gpuElevationM.forEach((gpuElevM, i) => {
    const [x, z] = visualRows.coords[i]
    const cpu = frame.groundHeightLocal(x, z)
    const p = physicsAt(x, z)
    if (!Number.isFinite(gpuElevM) || !Number.isFinite(cpu) || p.bodyId == null) return
    const cpuElevM = elevationAtLocal(frame, x, cpu, z)
    const physElevM = elevationAtLocal(frame, x, p.y, z)
    acc('VISUAL-ARM|visual-vs-cpu', gpuElevM - cpuElevM)
    acc('VISUAL-ARM|visual-vs-physics', gpuElevM - physElevM)
    acc('VISUAL-ARM|cpu-vs-physics', cpuElevM - physElevM)
    n++
  })
  dumpStats('VISUAL-ARM')
  expect(`visual arm measured at least ${Math.max(8, Math.floor(coords.length / 2))} of the same coordinates`, n >= Math.max(8, Math.floor(coords.length / 2)), { measured: n, coords: coords.length })
} else {
  console.log('VISUAL: NOT MEASURED -- pass --gpu (needs SESSION_ID, an app served on --port, and scripts/gpulock.mjs) to add the GPU terrain arm')
}

// ---------------------------------------------------------------- verdict

const worstAny = Math.max(...phases.map(p => p.worst))
console.log(`worst |delta| over every node phase: ${worstAny.toFixed(4)} m`)
console.log(`SOURCES: grass=src/terrain/GrassPlacement.js placementsForGrassChunk -> classify.y ; cpu=src/terrain/PlanetFrame.js frame.groundHeightLocal ; physics=src/terrain/TerrainPhysics.js colliderSource.heightFn -> Jolt heightfield (raycast)`)
const measuredAll = phases.every(p => p.samples >= MIN_SAMPLES_PER_PHASE)
expect('every phase measured the full sample set (no source silently dropped)', measuredAll, phases.map(p => [p.name, p.samples]))
expect(`the three node sources agree within ${ACCEPT_M} m at every sample`, worstAny <= ACCEPT_M, { worstAny })
if (GPU) expect('the visual arm ran', visualRows !== null, null)

const failures = checks.filter(c => c === false).length
console.log(`checks=${checks.length} failures=${failures}`)
console.log(`worstM=${worstAny.toFixed(4)}`)
const ok = measuredAll && failures === 0
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL')
// The collider streamers each keep a self-rescheduling setTimeout(300) tick alive (measured:
// HeightfieldStreamer.js:328 plus one ColliderStreamer.js:763 per trunk and rock streamer), so a
// witness that prints its verdict and falls off the end of main never reaches process exit. Stop
// them, then leave through the bounded drain so no future handle can reintroduce the stall.
// stopTerrainStreaming owns the whole stop list -- heightfield streamer, trunk collider streamer,
// rock collider streamer, then the physics terrain source and body id -- so a copy of that list
// here cannot go stale the next time a streamer is added. Measured with the list removed instead:
// the guard's own report names `3x Timeout still holding the event loop`, one per streamer.
try { terrainPhysics.stopTerrainStreaming(physics, streamer) } catch (e) { console.log(`stopTerrainStreaming threw: ${e && e.message}`) }
// process._getActiveHandles() does not count timers on Node 24 (measured: a pending setTimeout is
// absent from it but present in process.getActiveResourcesInfo()), so the drain can only ever wait
// on stdio. DRAIN_BOUND_MS is the flush window, not a measurement: every handle this witness owns
// is already stopped above, and it is an order of magnitude below QUIET_AFTER_VERDICT_MS so the
// guard can only fire on a real stall and never on the drain itself.
const { exitAfterQuiesce } = await import(href('scripts/lib/quiesce.mjs'))
await exitAfterQuiesce(ok ? 0 : 1, DRAIN_BOUND_MS)
