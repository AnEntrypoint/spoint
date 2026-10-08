#!/usr/bin/env node
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdir, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { parseArgs, numArg, strArg } from './lib/witness-args.mjs'

process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = parseArgs(process.argv.slice(2))
const WORLD = strArg(args.world, 'tps-game')
const PLAYERS = numArg(args.players, 4)
const WINDOW_TICKS = numArg(args.ticks, 40)
const PROBE_RADIUS = numArg(args.planetRadius, 63600)
const SPREAD_M = numArg(args.spread, 700)

const failures = []
const measurements = []
function expect(ok, label, detail) {
  measurements.push({ label, ok, detail })
  if (!ok) failures.push(`${label}: ${detail}`)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function armWorldDefs() {
  const { loadWorldModule } = await import('../src/sdk/WorldLocator.js')
  const { expandWorldPresets } = await import('../src/shared/worldPresets.js')
  const dir = resolve(SDK_ROOT, 'apps', 'world')
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.js')) files.push(join(dir, e.name))
    else if (e.isDirectory() && (e.name === '_fixtures' || e.name === '_shared')) {
      const sub = await readdir(join(dir, e.name))
      for (const s of sub) if (s.endsWith('.js')) files.push(join(dir, e.name, s))
    }
  }
  files.sort()
  const rows = []
  for (const f of files) {
    let def = null
    try {
      def = await loadWorldModule(f)
    } catch (e) {
      rows.push({ world: f, loadError: e.message, effective: 0, declared: null })
      continue
    }
    let expanded = def
    try {
      expanded = expandWorldPresets(def)
    } catch (e) {
      rows.push({ world: f, loadError: `expandWorldPresets: ${e.message}`, effective: 0, declared: null })
      continue
    }
    const declared = expanded && Object.prototype.hasOwnProperty.call(expanded, 'planetRadius') ? expanded.planetRadius : null
    const effective = Number(declared) || 0
    rows.push({
      world: f,
      loadError: null,
      def: expanded,
      declared,
      effective,
      declaredTerrainRadius: expanded?.terrain?.radius ?? null,
      declaredRelevanceRadius: expanded?.relevanceRadius ?? null,
      presets: Array.isArray(expanded?.presets) ? expanded.presets.join('+') : '-',
    })
  }
  console.log('world-def sweep (apps/world/*.js through loadWorldModule + expandWorldPresets)')
  console.log('| world | planetRadius declared | effective | presets | terrain.radius | relevanceRadius |')
  console.log('|' + '---|'.repeat(6))
  for (const r of rows) {
    if (r.loadError) { console.log(`| ${r.world} | LOAD-ERROR | ${r.loadError} | | | |`.slice(0, 400)); continue }
    console.log(`| ${r.world} | ${r.declared === null ? 'absent' : JSON.stringify(r.declared)} | ${r.effective} | ${r.presets} | ${r.declaredTerrainRadius ?? '-'} | ${r.declaredRelevanceRadius ?? '-'} |`)
  }
  const loadErrors = rows.filter(r => r.loadError)
  expect(loadErrors.length === 0, 'world-def sweep: every apps/world/*.js loads as a world module', `${loadErrors.length} of ${rows.length} failed to load (${loadErrors.map(r => `${r.world}: ${r.loadError}`).join('; ')})`)
  const nonZero = rows.filter(r => !r.loadError && r.effective > 0)
  expect(nonZero.length === 0, 'world-def sweep: planetRadius is 0 in every shipped world', nonZero.length === 0 ? `all ${rows.length} world def(s) resolve planetRadius to 0 (none declares it)` : `${nonZero.length} world def(s) set a non-zero planetRadius: ${nonZero.map(r => `${r.world}=${r.declared}`).join(', ')}`)
  return rows
}

async function armFailLoud(defRows) {
  const { parseWorld } = await import('../src/shared/worldResolve.js')
  const { StageLoader } = await import('../src/stage/StageLoader.js')

  const rejectionOf = value => {
    const r = parseWorld({ name: 'probe', planetRadius: value })
    return r.ok ? null : `${r.path}: ${r.reason}`
  }
  const accepted = rejectionOf(PROBE_RADIUS)
  expect(accepted === null, 'fail-loud: assertWorld accepts a positive finite planetRadius', accepted === null ? `planetRadius ${PROBE_RADIUS} validates` : `planetRadius ${PROBE_RADIUS} rejected: ${accepted}`)
  for (const bad of [0, -1, NaN, Infinity, '63600']) {
    const reason = rejectionOf(bad)
    expect(reason !== null, `fail-loud: assertWorld rejects planetRadius ${String(bad)} (${typeof bad})`, reason === null ? 'accepted, so a world can still ship a radius the ring cannot serve' : reason.slice(0, 160))
  }

  const stageProbe = def => {
    try {
      const stage = new StageLoader(null).loadFromDefinition('probe', def)
      return { threw: null, radius: stage.spatial.planetRadius }
    } catch (e) {
      return { threw: e.message, radius: null }
    }
  }
  const flat = stageProbe({ name: 'probe-flat' })
  expect(flat.threw === null && flat.radius === 0, 'fail-loud: a world that declares no planetRadius still builds a flat stage', flat.threw === null ? `stage.spatial.planetRadius = ${flat.radius}` : flat.threw.slice(0, 200))

  const declared = stageProbe({ name: 'probe-declared', planetRadius: PROBE_RADIUS })
  expect(declared.threw !== null && /planetRadius/.test(declared.threw) && /clusters/.test(declared.threw), 'fail-loud: a world that declares a planetRadius without enabled clusters is refused instead of silently serving flat cells under it', declared.threw === null ? `accepted with stage.spatial.planetRadius = ${declared.radius}, so the empty-AOI failure mode stays reachable` : declared.threw.slice(0, 220))

  const negative = stageProbe({ name: 'probe-negative', planetRadius: -1 })
  expect(negative.threw !== null && /planetRadius/.test(negative.threw), 'fail-loud: a negative planetRadius is refused at the stage instead of defaulting to 0', negative.threw === null ? `accepted with stage.spatial.planetRadius = ${negative.radius}` : negative.threw.slice(0, 200))

  const clustered = stageProbe({ name: 'probe-clustered', relevanceRadius: 200, terrain: { radius: PROBE_RADIUS, clusters: { enabled: true } } })
  expect(clustered.threw === null && clustered.radius === PROBE_RADIUS, 'fail-loud: the radius resolveClusterConfig resolves is the radius that reaches the stage', clustered.threw === null ? `clusters enabled on terrain.radius ${PROBE_RADIUS} -> stage.spatial.planetRadius = ${clustered.radius}` : clustered.threw.slice(0, 220))

  const clusterNoRadius = stageProbe({ name: 'probe-cluster-no-radius', terrain: { clusters: { enabled: true } } })
  expect(clusterNoRadius.threw !== null && /cluster-needs-planet-radius/.test(clusterNoRadius.threw), 'fail-loud: clusters enabled without a positive terrain radius throw cluster-needs-planet-radius instead of resolving to 0', clusterNoRadius.threw === null ? `accepted with stage.spatial.planetRadius = ${clusterNoRadius.radius}` : clusterNoRadius.threw.slice(0, 220))

  const swept = []
  for (const r of defRows) {
    if (r.loadError) { swept.push({ world: r.world, parseOk: null, stageThrew: 'not loaded' }); continue }
    const parsed = parseWorld(r.def)
    const probe = stageProbe({ ...r.def, entities: [], gravity: undefined })
    swept.push({
      world: r.world,
      parseOk: parsed.ok,
      parseReason: parsed.ok ? null : `${parsed.path}: ${parsed.reason}`,
      stageThrew: probe.threw,
      stageRadius: probe.radius,
    })
  }
  console.log('\nfail-loud sweep (each shipped world def through parseWorld and through StageLoader with entities and gravity withheld, so no probe spawns)')
  console.log('| world | parseWorld | stage planetRadius |')
  console.log('|' + '---|'.repeat(3))
  for (const s of swept) console.log(`| ${s.world} | ${s.parseOk === null ? 'not loaded' : (s.parseOk ? 'ok' : `REJECTED ${s.parseReason}`)} | ${s.stageThrew === null ? s.stageRadius : `THREW ${String(s.stageThrew).slice(0, 120)}`} |`)

  const rejectedWorlds = swept.filter(s => s.parseOk === false)
  expect(rejectedWorlds.length === 0, 'fail-loud: no shipped world is rejected by the planetRadius validation', rejectedWorlds.length === 0 ? `all ${swept.length} shipped world def(s) pass parseWorld` : `${rejectedWorlds.length} rejected: ${rejectedWorlds.map(s => `${s.world} (${s.parseReason})`).join('; ')}`)
  const throwingWorlds = swept.filter(s => s.stageThrew !== null)
  expect(throwingWorlds.length === 0, 'fail-loud: no shipped world throws at stage construction', throwingWorlds.length === 0 ? `all ${swept.length} shipped world def(s) build a stage` : `${throwingWorlds.length} throw: ${throwingWorlds.map(s => `${s.world} (${String(s.stageThrew).slice(0, 120)})`).join('; ')}`)
  const flatWorlds = swept.filter(s => s.stageThrew === null && s.stageRadius === 0)
  expect(flatWorlds.length === swept.length, 'fail-loud: every shipped world still resolves a flat stage', `${flatWorlds.length} of ${swept.length} ship stage.spatial.planetRadius 0`)
}

async function armLive() {
  if (typeof globalThis.WebSocket !== 'function') {
    const { WebSocket } = await import('ws')
    globalThis.WebSocket = WebSocket
  }
  const { createServer } = await import('../src/sdk/server.js')
  const { PhysicsNetworkClient } = await import('../src/client/PhysicsNetworkClient.js')
  const { loadWorldModule } = await import('../src/sdk/WorldLocator.js')
  const aoi = await import('../src/sdk/TickHandlerAOI.js')
  const { aoiRingWork, _spatialCache } = aoi

  const port = await new Promise((res, rej) => {
    const s = createNetServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
  })
  const storageDir = resolve(SDK_ROOT, 'data', 'planet-radius-witness')
  await rm(storageDir, { recursive: true, force: true })
  const worldDef = await loadWorldModule(resolve(SDK_ROOT, 'apps', 'world', `${WORLD}.js`))
  const server = await createServer({
    port,
    tickRate: worldDef.tickRate || 60,
    appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src', 'stdlib-apps')],
    sdkRoot: SDK_ROOT,
    gravity: worldDef.gravity,
    staticDirs: [],
    storageDir,
  })
  await server.loadWorld(worldDef)
  await server.start()

  const runtime = server.runtime
  const stage = runtime._stageLoader?.getActiveStage?.() || null
  const spatial = stage ? stage.spatial : null
  const relevanceRadius = spatial ? spatial.relevanceRadius : 0
  const stageEntities = stage ? stage.entityIds.size : 0

  const clients = []
  for (let i = 0; i < PLAYERS; i++) clients.push(new PhysicsNetworkClient({ url: `ws://127.0.0.1:${port}/ws`, predictionEnabled: false, smoothInterpolation: false, webTransport: { enabled: false } }))
  const connFail = []
  await Promise.all(clients.map(c => c.connect().catch(e => connFail.push(e))))
  if (connFail.length) {
    failures.push(`live arm: ${connFail.length} of ${PLAYERS} client(s) failed to connect (${connFail[0].message}), so no arm ran`)
    return { server, clients, storageDir }
  }
  const joinDeadline = Date.now() + 30000
  while (server.playerManager.getConnectedPlayers().length < PLAYERS && Date.now() < joinDeadline) await sleep(50)
  const players = server.playerManager.getConnectedPlayers()
  for (let i = 0; i < players.length; i++) clients[i].startInputLoop(() => ({ forward: false, sprint: false, yaw: i, pitch: 0 }))
  await sleep(1200)

  for (let i = 0; i < players.length; i++) {
    const x = (i % 2) * SPREAD_M
    const z = Math.floor(i / 2) * SPREAD_M
    const g = server.physics.terrainHeightAt ? server.physics.terrainHeightAt(x, z) : NaN
    players[i].state.position[0] = x
    players[i].state.position[1] = (Number.isFinite(g) ? g : 0) + 2
    players[i].state.position[2] = z
    try { server.physicsIntegration.setPlayerPosition(players[i].id, players[i].state.position) } catch {}
  }
  await sleep(2000)

  const tickSystem = server.tickSystem || null
  if (!tickSystem || typeof tickSystem.onTick !== 'function') {
    failures.push('live arm: server exposes no tickSystem.onTick, so no window can be aligned to a completed snapshot pass')
    return { server, clients, storageDir }
  }
  let ticks = 0
  let observing = true
  const onTick = () => { if (observing) ticks++ }
  tickSystem.onTick(onTick)

  async function window(label, n = WINDOW_TICKS) {
    const before = { ...aoiRingWork, ticks }
    const start = Date.now()
    while (ticks - before.ticks < n && Date.now() - start < 30000) await sleep(25)
    const after = { ...aoiRingWork, ticks }
    const d = {}
    for (const k of Object.keys(before)) d[k] = after[k] - before[k]
    return { label, ticks: d.ticks, raw: d }
  }

  const sampleCentres = () => {
    const out = []
    for (const [, c] of _spatialCache) {
      const p = c.cellViewerPos
      out.push({ norm: Math.hypot(p[0], p[1], p[2]), y: p[1], base: c.baseRelevantIds ? c.baseRelevantIds.length : 0 })
    }
    return out
  }

  expect(relevanceRadius > 0, 'live arm: the AOI relevance path is on for this world', `stage.spatial.relevanceRadius = ${relevanceRadius} in "${WORLD}"${relevanceRadius > 0 ? '' : ', so every work count below is vacuous'}`)
  expect(stageEntities > 0, 'live arm: stage spatial holds entities', `${stageEntities} stage entit(y/ies) in "${WORLD}"`)
  const livePlanetRadius = spatial ? (spatial.planetRadius || 0) : -1
  expect(livePlanetRadius === 0, 'live arm: the live stage carries planetRadius 0', `stage.spatial.planetRadius = ${spatial ? spatial.planetRadius : 'no stage'}`)

  await aoi.installAoiCodeEpoch()
  aoi.invalidateAoiCellBaseCache()
  aoi.resetAoiRingWork()
  const flat = await window('flat')
  const flatCentres = sampleCentres()
  const flatNonEmpty = flatCentres.filter(c => c.base > 0).length
  const flatEmpty = flatCentres.filter(c => c.base === 0).length
  const flatMaxNorm = flatCentres.length ? Math.max(...flatCentres.map(c => c.norm)) : 0
  const playerMaxNorm = Math.max(...players.map(p => Math.hypot(p.state.position[0], p.state.position[1], p.state.position[2])))

  expect(flat.raw.cellCentreSolves > 0, 'live arm: the AOI ring actually ran', `${flat.raw.cellCentreSolves} cell-centre solve(s) and ${flat.raw.cellComputes} cell compute(s) over ${flat.ticks} tick(s)`)
  expect(flat.raw.neighbourCellsCalls === 0, 'live arm: the cube-sphere neighbour branch never executes', `neighbourCellsCalls = ${flat.raw.neighbourCellsCalls} over ${flat.ticks} tick(s) with planetRadius ${livePlanetRadius}`)

  expect(flat.raw.cellBaseHits > 0, 'cell base cache: a live run serves cached cell base sets instead of recomputing every cell every tick', `${flat.raw.cellBaseHits} hit(s) against ${flat.raw.cellBaseComputes} compute(s) over ${flat.ticks} tick(s), ${flatCentres.length} cell(s) per tick`)

  let baseChecks = 0, baseMismatch = 0
  for (const [, c] of _spatialCache) {
    if (!c.baseRelevantIds) continue
    const cached = new Set(c.baseRelevantIds)
    const fresh = new Set(stage.getRelevantEntitiesHorizontal(c.cellViewerPos, relevanceRadius))
    baseChecks++
    let same = cached.size === fresh.size
    if (same) { for (const id of cached) if (!fresh.has(id)) { same = false; break } }
    if (!same) baseMismatch++
  }
  expect(baseChecks > 0 && baseMismatch === 0, 'cell base cache: every served cell base set equals a fresh recompute, so a cache hit is never a stale set', `${baseChecks - baseMismatch}/${baseChecks} served cell base set(s) matched a fresh recompute at the same cell centre`)

  aoi.invalidateAoiCellBaseCache()
  aoi.resetAoiRingWork()
  const resumed = await window('flat-resumed', 6)
  expect(resumed.raw.cellBaseHits > 0, 'cell base cache: invalidation drops the cached sets but leaves the cache enabled, so the next window hits again', `after invalidateAoiCellBaseCache(): ${resumed.raw.cellBaseHits} hit(s) and ${resumed.raw.cellBaseComputes} compute(s) over ${resumed.ticks} tick(s)`)

  const flatYs = flatCentres.map(c => c.y)
  expect(flatCentres.length > 0 && Math.max(...flatYs.map(Math.abs)) === 0, 'flat path: every cell-centre query origin sits at y = 0', `${flatCentres.length} cell centre(s), max |y| = ${flatCentres.length ? Math.max(...flatYs.map(Math.abs)) : 'n/a'}`)

  const probeEntity = (() => {
    for (const id of stage.entityIds) {
      const e = runtime.entities.get(id)
      if (e && e.position && e.bodyType !== 'static') return e
    }
    for (const id of stage.entityIds) {
      const e = runtime.entities.get(id)
      if (e && e.position) return e
    }
    return null
  })()
  let probeCentre = null
  for (const [, c] of _spatialCache) {
    if (c.baseRelevantIds && c.baseRelevantIds.length) { probeCentre = [c.cellViewerPos[0], c.cellViewerPos[1], c.cellViewerPos[2]]; break }
  }
  if (probeEntity && probeCentre) {
    const home = [probeEntity.position[0], probeEntity.position[1], probeEntity.position[2]]
    const place = (x, y, z) => {
      probeEntity.position[0] = x
      probeEntity.position[1] = y
      probeEntity.position[2] = z
      stage.updateEntityPosition(probeEntity.id, probeEntity.position)
    }
    const inCellBaseSet = () => stage.getRelevantEntitiesHorizontal(probeCentre, relevanceRadius).includes(probeEntity.id)
    const inSphereQuery = () => stage.getRelevantEntities(probeCentre, relevanceRadius).includes(probeEntity.id)
    const highY = relevanceRadius + 50
    const farX = probeCentre[0] + relevanceRadius * 1.5

    place(probeCentre[0], 0, probeCentre[2])
    const servedAtCentre = inCellBaseSet()
    place(probeCentre[0], highY, probeCentre[2])
    const servedHigh = inCellBaseSet()
    const droppedHighBySphereQuery = !inSphereQuery()
    place(farX, 0, probeCentre[2])
    const droppedFarSideways = !inCellBaseSet()
    place(home[0], home[1], home[2])

    expect(servedAtCentre === true, 'flat path: an entity sitting at the cell centre is in the cell base set', `probe entity ${probeEntity.id} at [${probeCentre.map(v => Number(v.toFixed(1)))}] with relevanceRadius ${relevanceRadius}: inCellBaseSet ${servedAtCentre}`)
    expect(servedHigh === true, 'flat path: the cell base set serves an entity more than relevanceRadius above the cell-centre plane, so the ring is no longer blind above y = 0', `probe entity ${probeEntity.id} at y = ${highY} over cell centre [${probeCentre.map(v => Number(v.toFixed(1)))}]: inCellBaseSet ${servedHigh}`)
    expect(droppedHighBySphereQuery === true, 'flat path: control -- the 3-D query the flat cell centre used still drops that same entity, so the horizontal query is what serves it', `same entity at y = ${highY}: 3-D query includes it ${!droppedHighBySphereQuery}, horizontal query includes it ${servedHigh}`)
    expect(droppedFarSideways === true, 'flat path: control -- an entity beyond relevanceRadius sideways is still dropped, so the horizontal query did not become unbounded', `probe entity at x = ${Number(farX.toFixed(1))} (${relevanceRadius * 1.5} m sideways from the cell centre): inCellBaseSet ${!droppedFarSideways}`)

    place(probeCentre[0], highY, probeCentre[2])
    aoi.invalidateAoiCellBaseCache()
    aoi.resetAoiRingWork()
    const highWindow = await window('flat-high', 5)
    let servedByLiveRing = false
    for (const [, c] of _spatialCache) if (c.baseRelevantIds && c.baseRelevantIds.includes(probeEntity.id)) servedByLiveRing = true
    const highWindowCells = _spatialCache.size
    place(home[0], home[1], home[2])
    aoi.invalidateAoiCellBaseCache()

    expect(servedByLiveRing === true, 'flat path: the live ring puts an entity more than relevanceRadius above the cell-centre plane into a cell base set', `probe entity ${probeEntity.id} at y = ${highY} shows up in ${servedByLiveRing ? 'a' : 'no'} cell base set over ${highWindow.ticks} tick(s) and ${highWindowCells} cell(s) (${highWindow.raw.cellBaseComputes} base compute(s))`)

    const awayX = probeCentre[0] + relevanceRadius * 10
    place(awayX, 0, probeCentre[2])
    aoi.invalidateAoiCellBaseCache()
    aoi.resetAoiRingWork()
    const awayWindow = await window('flat-away', 5)
    let servedAway = false
    for (const [, c] of _spatialCache) if (c.baseRelevantIds && c.baseRelevantIds.includes(probeEntity.id)) servedAway = true
    expect(servedAway === false, 'cell base cache: an entity moved out of every cell disc drops out of the base sets, so a hit is not a set pinned at first computation', `probe entity ${probeEntity.id} at x = ${Number(awayX.toFixed(1))} shows up in ${servedAway ? 'a' : 'no'} cell base set over ${awayWindow.ticks} tick(s)`)

    place(probeCentre[0], 0, probeCentre[2])
    aoi.invalidateAoiCellBaseCache()
    aoi.resetAoiRingWork()
    const enterWindow = await window('flat-enter', 5)
    let servedEntered = false
    for (const [, c] of _spatialCache) if (c.baseRelevantIds && c.baseRelevantIds.includes(probeEntity.id)) servedEntered = true
    expect(servedEntered === true, 'cell base cache: an entity that enters a cell mid-run appears in that cell base set', `probe entity ${probeEntity.id} moved back onto the cell centre shows up in ${servedEntered ? 'a' : 'no'} cell base set over ${enterWindow.ticks} tick(s)`)
    place(home[0], home[1], home[2])
    aoi.invalidateAoiCellBaseCache()
  } else {
    expect(false, 'flat path: a stage entity and a non-empty cell centre were available to probe the y = 0 blind spot', `probeEntity ${probeEntity ? probeEntity.id : 'none'}, probeCentre ${probeCentre ? JSON.stringify(probeCentre) : 'none'}`)
  }

  if (!spatial) {
    failures.push('live arm: no active stage, so the planet-radius flip cannot be exercised')
    observing = false
    return { server, clients, storageDir }
  }

  spatial.planetRadius = PROBE_RADIUS
  aoi.invalidateAoiCellBaseCache()
  await aoi.installAoiCodeEpoch()
  aoi.resetAoiRingWork()
  const planet = await window('planet')
  const planetCentres = sampleCentres()
  const planetNonEmpty = planetCentres.filter(c => c.base > 0).length
  const planetEmpty = planetCentres.filter(c => c.base === 0).length
  const planetMaxNorm = planetCentres.length ? Math.max(...planetCentres.map(c => c.norm)) : 0
  spatial.planetRadius = 0
  aoi.invalidateAoiCellBaseCache()
  await aoi.installAoiCodeEpoch()

  expect(planet.raw.neighbourCellsCalls > 0, 'live arm: setting planetRadius does make the cube-sphere branch execute (so neighbourCellsCalls discriminates, it is not a silent no-op)', `neighbourCellsCalls = ${planet.raw.neighbourCellsCalls} over ${planet.ticks} tick(s) at planetRadius ${PROBE_RADIUS}`)
  expect(planetCentres.length > 0 && planetMaxNorm > 10000, 'live arm: with planetRadius set, cell-centre query origins jump onto the sphere', `max |cellViewerPos| ${flatMaxNorm.toFixed(1)} m (flat) -> ${planetMaxNorm.toFixed(1)} m (planet), while the farthest served player sits ${playerMaxNorm.toFixed(1)} m from the origin`)
  expect(flatNonEmpty > 0 && planetNonEmpty === 0, 'live arm: with planetRadius set on chart-local coordinates the ring serves no dynamic entity at all while snapshots keep flowing', `${flatNonEmpty}/${flatCentres.length} non-empty base set(s) flat -> ${planetNonEmpty}/${planetCentres.length} at planetRadius ${PROBE_RADIUS}, over ${planet.ticks} tick(s) and ${planet.raw.cellComputes} cell compute(s)`)


  console.log('\nlive arm (real server, real PhysicsNetworkClient clients)')
  console.log('| arm | planetRadius | ticks | cell-centre solves | cell computes | neighbourCells calls | base computes | base hits |')
  console.log('|' + '---|'.repeat(8))
  console.log(`| flat | ${livePlanetRadius} | ${flat.ticks} | ${flat.raw.cellCentreSolves} | ${flat.raw.cellComputes} | ${flat.raw.neighbourCellsCalls} | ${flat.raw.cellBaseComputes} | ${flat.raw.cellBaseHits} |`)
  console.log(`| planet | ${PROBE_RADIUS} | ${planet.ticks} | ${planet.raw.cellCentreSolves} | ${planet.raw.cellComputes} | ${planet.raw.neighbourCellsCalls} | ${planet.raw.cellBaseComputes} | ${planet.raw.cellBaseHits} |`)
  console.log(`cell-centre query origins: flat max |p| ${flatMaxNorm.toFixed(1)} m over ${flatCentres.length} cell(s), ${flatEmpty} empty base set(s); planet max |p| ${planetMaxNorm.toFixed(1)} m over ${planetCentres.length} cell(s), ${planetEmpty} empty base set(s); farthest served player |p| ${playerMaxNorm.toFixed(1)} m`)
  console.log(`relevanceRadius ${relevanceRadius} m, ${players.length} player(s), ${stageEntities} stage entit(y/ies)`)
  observing = false
  return { server, clients, storageDir }
}

const defRows = await armWorldDefs()
await armFailLoud(defRows)
const live = await armLive()

for (const c of live.clients || []) {
  try { if (typeof c.disconnect === 'function') c.disconnect(); else if (typeof c.close === 'function') c.close() } catch {}
}
try { if (live.server && typeof live.server.stop === 'function') await live.server.stop() } catch {}
try { await rm(live.storageDir, { recursive: true, force: true }) } catch {}

console.log('\nmeasurements')
for (const m of measurements) console.log(`  ${m.ok ? 'ok  ' : 'FAIL'} ${m.label} -- ${m.detail}`)
console.log(`\nworld defs swept: ${defRows.length}`)
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`)
  console.log(`\nRESULT: FAIL (${failures.length} failure(s))`)
  process.exit(1)
}
console.log('\nRESULT: PASS')
process.exit(0)
