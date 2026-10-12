// How far the server's terrain collider sits from the ground the client draws, and what a finer
// collider lattice costs.
//
// The collider is a Jolt HeightFieldShape built by src/terrain/HeightfieldStreamer.js on a lattice
// of N = round(extent/resolution) samples per side over `extent` metres. The preset
// src/presets/planet.js:11 asks for extent 256 / resolution 2, i.e. N=128 and a 2.0157 m lattice.
// The ground the client draws is sampled at 1 m (apps/world/tps-game.hf is N=257 over extent 256),
// so a 2 m lattice is a decimation of a 1 m field and the collider cannot follow it.
//
// This witness measures BOTH halves of that trade, on the same instrument:
//   * delta  - collider surface vs the 1 m source the collider itself samples, read by a real
//              downward Jolt raycast at real (x,z) probes, split by the sign of the local
//              curvature so the direction of the error is visible, not just its magnitude;
//   * cost   - per-field sampling and per-field Jolt shape construction, split, with counted
//              work units (samples solved, samples served from the bake, fields built), plus the
//              longest synchronous block the server loop takes across a landscape change.
//
// --resolution / --extent override the preset so the two lattices are compared head to head.
// --arm=baked|cpu|both picks where the probes land: inside the bake's coverage (collider reads
// the 1 m artifact), outside it (collider re-solves terrain), or both. --arm defaults to baked,
// because the outside-coverage arm is a parked defect and does not belong in the gate.
// --no-fine is the mutation arm: it turns the source-following lattice back off. It exists so a
// red here names the lattice as the cause -- PASS without it and FAIL with it is the proof.
// --count / --half size the probe set. --accept-mean-m / --accept-m are the gate.
process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'

import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const href = p => pathToFileURL(resolve(ROOT, p)).href
const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const num = (name, fallback) => { const v = Number(arg(name, NaN)); return Number.isFinite(v) ? v : fallback }

const WORLD = arg('world', 'tps-game')
const RES = num('resolution', 2)
const EXTENT = num('extent', 256)
const ARM = arg('arm', 'baked')
const PROBE_HALF_M = num('half', 120)
// Worst case: 0.20 m, against 0.1241 m measured. The floor is Jolt's own triangulation of each
// 1 m cell (0.0825 m for a field hand-fed the source's exact samples), so this is a claim about
// the collider that no lattice can beat, with room for a platform to differ -- and the mutation
// arm still misses it by 1.6x (0.3291 m).
const ACCEPT_M = num('accept-m', 0.2)
// The mean is the discriminating statistic: a coarser lattice shifts it by 6x while the max is
// bounded below by Jolt's own triangulation of each cell, which no lattice choice changes.
const ACCEPT_MEAN_M = num('accept-mean-m', 0.01)
// Mutation arm: --no-fine turns the source-following lattice back off, which is the defect this
// witness exists to catch. It must FAIL here and PASS without it.
const NO_FINE = process.argv.some(a => a === '--no-fine' || a === '--no-fine=true')
const PROBE_COUNT = Math.max(200, Math.round(num('count', 1681)))
const TRAVEL_TO = [num('travelX', 520), num('travelZ', 0)]
const RAY_UP_M = 6000
const LAG_THRESHOLDS_MS = [16.68, 33.36, 100]

function radicalInverse(k, b) {
  let f = 1, r = 0
  while (k > 0) { f /= b; r += f * (k % b); k = Math.floor(k / b) }
  return r
}

const checks = []
const expect = (name, ok, observed) => {
  checks.push(ok === true)
  console.log(`${ok === true ? 'ok  ' : 'FAIL'} ${name}${ok === true ? '' : ' observed=' + JSON.stringify(observed)}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const { PhysicsWorld } = await import(href('src/physics/World.js'))
const { loadWorldModule } = await import(href('src/sdk/WorldLocator.js'))
const terrainPhysics = await import(href('src/terrain/TerrainPhysics.js'))
const { armVerdictExitGuard } = await import(href('scripts/lib/verdict-exit-guard.mjs'))
armVerdictExitGuard({ label: 'collider-lattice-vs-source' })

const loaded = await loadWorldModule(resolve(ROOT, 'apps', 'world', `${WORLD}.js`))
const tcfg = {
  ...loaded.terrain,
  physics: { ...(loaded.terrain.physics || {}), extent: EXTENT, resolution: RES, followSource: !NO_FINE },
  // The trunk and rock collider streamers are a different measurement with their own 300 ms tick;
  // this witness is about the terrain heightfield, so they are off.
  vegetation: null,
}
console.log(`world=${WORLD} extent=${EXTENT} resolution=${RES} followSource=${!NO_FINE} baked=${tcfg.bakedHeightfield || '(none)'} hashVersion=${tcfg.hashVersion ?? 2}`)

const players = new Map()
players.set(0, { state: { position: [0, 0, 0], onGround: true, velocity: [0, 0, 0] } })
const physics = new PhysicsWorld({ gravity: [0, -18, 0] })
await physics.init()

let frame = null
const realSetSource = physics.setTerrainHeightSource.bind(physics)
physics.setTerrainHeightSource = (fn, f, off) => { frame = f; return realSetSource(fn, f, off) }

// ------------------------------------------------------------------ cost instrumentation
const fieldBuilds = []
const realAdd = physics.addHeightField.bind(physics)
physics.addHeightField = (samples, N, scale, origin) => {
  const t0 = performance.now()
  const id = realAdd(samples, N, scale, origin)
  fieldBuilds.push({ N, spacing: scale[0], cornerX: origin[0], cornerZ: origin[2], addMs: performance.now() - t0, samples: samples.length })
  return id
}

// Longest synchronous block on this loop. A repeating 1 ms timer that fires late was blocked by
// whatever ran between the two ticks; that gap is the main-thread stall a landscape change costs,
// and unlike rAF-to-rAF wall it is not quantised to a refresh period.
const lag = { max: 0, samples: 0, over: LAG_THRESHOLDS_MS.map(() => 0), last: performance.now() }
const lagTimer = setInterval(() => {
  const now = performance.now()
  const gap = now - lag.last
  lag.last = now
  lag.samples++
  if (gap > lag.max) lag.max = gap
  LAG_THRESHOLDS_MS.forEach((t, i) => { if (gap > t) lag.over[i]++ })
}, 1)
function resetLag() { lag.max = 0; lag.samples = 0; lag.over = LAG_THRESHOLDS_MS.map(() => 0); lag.last = performance.now() }

const streamer = await terrainPhysics.setupTerrainStreaming({
  physics, playerManager: { players }, terrain: tcfg,
})
if (!streamer || !frame) throw new Error('setupTerrainStreaming produced no streamer or frame')
const servedHeight = physics.getTerrainHeightFn()
const groundFrozenAt = physics.groundFrozenAt
console.log(`groundSource=${frame.groundSource} fields=${fieldBuilds.length} N=${fieldBuilds.map(f => f.N).join('/')} spacing=${fieldBuilds.map(f => f.spacing.toFixed(4)).join('/')}m`)

const settle = async () => { for (let i = 0; i < 900 && streamer.busy; i++) await sleep(20) }
const waitCovered = async (x, z) => { for (let i = 0; i < 900 && !streamer.coversPosition(x, z); i++) await sleep(20) }
await settle()

// ------------------------------------------------------------------ the 1 m source, read directly
const baked = await terrainPhysics.loadBakedHeightField(tcfg.bakedHeightfield, tcfg.hashVersion ?? 2, tcfg, frame)
console.log(`reference: ${baked ? `baked N=${baked.N} extent=${baked.extent} spacing=${(baked.extent / (baked.N - 1)).toFixed(4)}m covers=+-${(baked.extent / 2).toFixed(0)}m` : 'NO BAKE (cpu)'}`)

// ------------------------------------------------------------------ sources at one (x,z)
function colliderAt(x, z) {
  const h = physics.raycast([x, RAY_UP_M, z], [0, -1, 0], RAY_UP_M * 2, null)
  if (!h || !h.hit) return { y: NaN, bodyId: null }
  return { y: h.position[1], bodyId: h.bodyId ?? null }
}
const inBake = (x, z) => !!baked && baked.covers(x, z)
const referenceAt = (x, z) => (inBake(x, z) ? baked.heightAtLocal(x, z) : frame.groundHeightLocal(x, z))

// Discrete Laplacian over +-2 m: negative at a crest, positive in a valley. The sign of the
// collider error is only interpretable once the probes are split this way -- a lattice that
// point-samples cuts crests and fills valleys, so an unsigned mean near zero hides both.
const LAP_STEP = 2
function curvatureClass(x, z) {
  const c = referenceAt(x, z)
  const n = referenceAt(x + LAP_STEP, z) + referenceAt(x - LAP_STEP, z) + referenceAt(x, z + LAP_STEP) + referenceAt(x, z - LAP_STEP)
  if (!Number.isFinite(c) || !Number.isFinite(n)) return 'unknown'
  const lap = n - 4 * c
  if (lap < -0.002) return 'crest'
  if (lap > 0.002) return 'valley'
  return 'flat'
}

const stats = new Map()
function acc(key, deltaM) {
  let s = stats.get(key)
  if (!s) { s = { n: 0, sumAbs: 0, sumSigned: 0, maxAbs: 0, maxSignedBelow: 0, maxSignedAbove: 0 }; stats.set(key, s) }
  const a = Math.abs(deltaM)
  s.n++; s.sumAbs += a; s.sumSigned += deltaM
  if (a > s.maxAbs) s.maxAbs = a
  if (deltaM < 0 && a > s.maxSignedBelow) s.maxSignedBelow = a
  if (deltaM > 0 && deltaM > s.maxSignedAbove) s.maxSignedAbove = deltaM
  return s
}
function dumpStats(label) {
  console.log(`--- ${label}`)
  let worst = 0, overall = null
  for (const [k, s] of [...stats.entries()].sort()) {
    const mean = s.sumAbs / s.n
    if (s.maxAbs > worst) worst = s.maxAbs
    if (k === `${label}|collider-vs-source`) overall = mean
    console.log(`  ${k} n=${s.n} meanAbs=${mean.toFixed(4)}m maxAbs=${s.maxAbs.toFixed(4)}m meanSigned=${(s.sumSigned / s.n).toFixed(4)}m maxBelow=${s.maxSignedBelow.toFixed(4)}m maxAbove=${s.maxSignedAbove.toFixed(4)}m`)
    stats.delete(k)
  }
  return { worst, mean: overall }
}

// Counted coverage split for one field: how many of its own lattice nodes the bake answers and
// how many fall through to a terrain solve. That is the unit the cost question turns on.
function coverageSplit(b) {
  let frozen = 0, total = 0
  for (let j = 0; j < b.N; j++) {
    for (let i = 0; i < b.N; i++) {
      total++
      const x = b.cornerX + i * b.spacing, z = b.cornerZ + j * b.spacing
      if (groundFrozenAt && groundFrozenAt(x, z)) frozen++
    }
  }
  return { total, frozen, solved: total - frozen }
}

async function runArm(name, cx, cz) {
  players.get(0).state.position[0] = cx
  players.get(0).state.position[2] = cz
  await waitCovered(cx, cz)
  await settle()
  const rows = []
  let uncovered = 0, nonFinite = 0
  // Halton, not a uniform grid: a grid step that divides the lattice spacing lands every probe ON a
  // lattice node, where the collider and its own source agree to the millimetre by construction.
  // That reads ~0 for a field that is badly wrong BETWEEN nodes, so the step must be one that no
  // lattice divides. Low-discrepancy points are spread evenly and align with neither lattice.
  for (let k = 1; k <= PROBE_COUNT; k++) {
    const x = cx - PROBE_HALF_M + radicalInverse(k, 2) * 2 * PROBE_HALF_M
    const z = cz - PROBE_HALF_M + radicalInverse(k, 3) * 2 * PROBE_HALF_M
    const ref = referenceAt(x, z)
    const c = colliderAt(x, z)
    if (c.bodyId == null) { uncovered++; continue }
    if (!Number.isFinite(ref) || !Number.isFinite(c.y)) { nonFinite++; continue }
    rows.push({ x, z, ref, phys: c.y, cls: curvatureClass(x, z) })
  }
  for (const r of rows) {
    const d = r.phys - r.ref
    acc(`${name}|collider-vs-source`, d)
    acc(`${name}|cls=${r.cls}|collider-vs-source`, d)
  }
  const { worst, mean } = dumpStats(name)
  console.log(`  probes=${rows.length} uncovered=${uncovered} nonFinite=${nonFinite} bakeCovers=${inBake(cx, cz)}`)
  expect(`${name}: every probe landed on a real terrain body`, uncovered === 0, { uncovered, probes: rows.length })
  expect(`${name}: measured at least 200 probes through both sources`, rows.length >= 200, { probes: rows.length })
  expect(`${name}: collider tracks its own source to ${ACCEPT_MEAN_M} m mean / ${ACCEPT_M} m worst`, mean <= ACCEPT_MEAN_M && worst <= ACCEPT_M, { mean, worst, ACCEPT_MEAN_M, ACCEPT_M })
  return { rows, worst, mean }
}

const results = {}
if (ARM === 'baked' || ARM === 'both') results.baked = await runArm('BAKED-ARM', 0, 0)
if (ARM === 'cpu' || ARM === 'both') results.cpu = await runArm('CPU-ARM', TRAVEL_TO[0], TRAVEL_TO[1])

// ------------------------------------------------------------------ cost: the two lattices, head to head
// The streamer's own height function, driven over both lattice sizes on the same machine, with the
// Jolt shape construction timed separately: sampling and shape building are different costs and
// only one of them is chunked by sampleTerrainGridChunked's budgetMs yield.
const { sampleTerrainGridChunked } = await import(href('src/terrain/HeightfieldStreamer.js'))
const heightFn = streamer.liveHeightFn
async function costAt(gridN, cornerX, cornerZ) {
  const before = fieldBuilds.length
  const g = await sampleTerrainGridChunked({ heightFn, N: gridN, spacing: EXTENT / (gridN - 1), cornerX, cornerZ, budgetMs: 2 })
  const id = physics.addHeightField(g.samples, gridN, [EXTENT / (gridN - 1), 1, EXTENT / (gridN - 1)], [cornerX, 0, cornerZ])
  if (id != null) physics.removeBody(id)
  const built = fieldBuilds[before]
  const cs = coverageSplit({ N: gridN, spacing: EXTENT / (gridN - 1), cornerX, cornerZ })
  return { gridN, samples: gridN * gridN, sampleMs: g.sampleMs, addMs: built ? built.addMs : NaN, ...cs }
}
console.log('--- lattice cost at extent ' + EXTENT + 'm (sampling yield budget 2 ms/slice)')
const costRows = []
const BAKE_CORNER = [-EXTENT / 2, -EXTENT / 2]
const OPEN_CORNER = [EXTENT * 1.5, -EXTENT / 2]
for (const [label, c] of [['inside-bake', BAKE_CORNER], ['outside-bake', OPEN_CORNER]]) {
  for (const gridN of [Math.max(2, Math.round(EXTENT / RES)), Math.max(2, Math.round(EXTENT / 1))]) {
    const k = await costAt(gridN, c[0], c[1])
    costRows.push({ label, ...k })
    console.log(`  ${label} N=${k.gridN} spacing=${(EXTENT / (k.gridN - 1)).toFixed(4)}m samples=${k.samples} bakeServed=${k.frozen} terrainSolved=${k.solved} sampleMs=${k.sampleMs.toFixed(1)} addHeightFieldMs=${k.addMs.toFixed(1)} perSampleUs=${((k.sampleMs * 1000) / Math.max(1, k.solved)).toFixed(1)}`)
  }
}

// ------------------------------------------------------------------ a landscape change, end to end
// Measured after the cost runs: the field the change builds is the one whose shape-build time has
// to be in the worst-block figure, and the loop-lag window has to wrap the build, not precede it.
resetLag()
const travel = ARM === 'baked' ? [240, 0] : [TRAVEL_TO[0] + 240, TRAVEL_TO[1]]
players.get(0).state.position[0] = travel[0]
players.get(0).state.position[2] = travel[1]
await waitCovered(travel[0], travel[1])
await settle()
console.log(`--- landscape change: player -> (${travel[0]},${travel[1]})`)
console.log(`  loopLag maxMs=${lag.max.toFixed(1)} samples=${lag.samples} ${LAG_THRESHOLDS_MS.map((t, i) => `>${t}ms=${lag.over[i]}`).join(' ')}`)

console.log('--- fields actually built by the streamer')
let worstAddMs = 0
for (const b of fieldBuilds) {
  const cs = coverageSplit(b)
  if (b.addMs > worstAddMs) worstAddMs = b.addMs
  console.log(`  N=${b.N} spacing=${b.spacing.toFixed(4)}m corner=(${b.cornerX.toFixed(1)},${b.cornerZ.toFixed(1)}) addMs=${b.addMs.toFixed(1)} nodes=${cs.total} bakeServed=${cs.frozen} terrainSolved=${cs.solved}`)
}
console.log(`  worstSingleJoltShapeBuildMs=${worstAddMs.toFixed(1)} (this call is synchronous: it is not chunked by the sampler's budget yield)`)

// ------------------------------------------------------------------ verdict
const worstAny = Math.max(...Object.values(results).map(r => r.worst))
for (const label of ['inside-bake', 'outside-bake']) {
  const pair = costRows.filter(r => r.label === label)
  if (pair.length !== 2 || pair[0].gridN === pair[1].gridN) continue
  console.log(`${label}: finer lattice N=${pair[0].gridN} -> ${pair[1].gridN} sampleMs ${pair[0].sampleMs.toFixed(1)} -> ${pair[1].sampleMs.toFixed(1)} addHeightFieldMs ${pair[0].addMs.toFixed(1)} -> ${pair[1].addMs.toFixed(1)}`)
}
console.log(`SOURCES: collider=Jolt heightfield raycast ; reference=${baked ? 'apps/world/tps-game.hf baked field (1 m)' : 'frame.groundHeightLocal'}`)
console.log(`worstM=${worstAny.toFixed(4)} meanM=${Math.max(...Object.values(results).map(r => r.mean)).toFixed(4)}`)
expect('every measured arm produced probes', Object.keys(results).length > 0, Object.keys(results))
expect('the Jolt shape build is measured for every field', fieldBuilds.every(b => Number.isFinite(b.addMs)), fieldBuilds.map(b => b.addMs))

const failures = checks.filter(c => c === false).length
console.log(`checks=${checks.length} failures=${failures}`)
const ok = failures === 0
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL')
for (const s of [streamer, streamer && streamer._trunkStreamer, streamer && streamer._rockStreamer]) {
  try { if (s && typeof s.stop === 'function') s.stop() } catch (e) { console.log(`streamer stop threw: ${e && e.message}`) }
}
clearInterval(lagTimer)
const { exitAfterQuiesce } = await import(href('scripts/lib/quiesce.mjs'))
await exitAfterQuiesce(ok ? 0 : 1, 1500)
