#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { parseArgs, numArg, strArg } from './lib/witness-args.mjs'

process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HARNESS = resolve(SDK_ROOT, 'scripts', 'netcode-conditioner-harness.mjs')

const args = parseArgs(process.argv.slice(2))
const COUNTS = strArg(args.counts, '8,24,64').split(',').map(Number).filter(Number.isFinite)
const RADIUS = numArg(args.radius, 120)
const REPS = numArg(args.reps, 2)
const DURATION = strArg(args.duration, '10000')
const COND = strArg(args.cond, '0/0/0')
const TICK = numArg(args.tick, 60)
const TICK_WINDOW_HZ = numArg(args.tickWindowHz, 3)
const WORTH_PCT = numArg(args.worthPct, 25)
const WORLD = strArg(args.world, 'arena')
const AT = strArg(args.at, '0,1.2,-95')

const AOI_PLAYERS = numArg(args.aoiPlayers, 8)
const AOI_TICKS = numArg(args.aoiTicks, 60)
const AOI_REPS = numArg(args.aoiReps, 2)
const AOI_SPREAD_M = numArg(args.aoiSpread, 900)
const AOI_CELL_BASE_MAX = 512

const sleep = ms => new Promise(r => setTimeout(r, ms))

function sortedIds(ids) {
  const out = Array.from(ids)
  out.sort()
  return out
}

function sameIdSet(a, b) {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  const x = sortedIds(a), y = sortedIds(b)
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  return true
}

async function runAoiRingArm() {
  if (typeof globalThis.WebSocket !== 'function') {
    const { WebSocket } = await import('ws')
    globalThis.WebSocket = WebSocket
  }
  const { createServer } = await import('../src/sdk/server.js')
  const { PhysicsNetworkClient } = await import('../src/client/PhysicsNetworkClient.js')
  const { loadWorldModule } = await import('../src/sdk/WorldLocator.js')
  const aoi = await import('../src/sdk/TickHandlerAOI.js')
  const { aoiRingWork, _spatialCache, _ringCache } = aoi

  const port = await new Promise((res, rej) => {
    const s = createNetServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
  })
  const worldDef = await loadWorldModule(resolve(SDK_ROOT, 'apps', 'world', 'tps-game.js'))
  const server = await createServer({
    port,
    tickRate: worldDef.tickRate || 60,
    appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src', 'stdlib-apps')],
    sdkRoot: SDK_ROOT,
    gravity: worldDef.gravity,
    staticDirs: [],
    storageDir: resolve(SDK_ROOT, 'data', 'aoi-ring-witness'),
  })
  await server.loadWorld(worldDef)
  await server.start()
  const runtime = server.runtime
  const stage = runtime._stageLoader?.getActiveStage?.() || null
  const relevanceRadius = stage ? stage.spatial.relevanceRadius : 0

  const clients = []
  for (let i = 0; i < AOI_PLAYERS; i++) clients.push(new PhysicsNetworkClient({ url: `ws://127.0.0.1:${port}/ws`, predictionEnabled: false, smoothInterpolation: false, webTransport: { enabled: false } }))
  const connFail = []
  await Promise.all(clients.map(c => c.connect().catch(e => connFail.push(e))))
  if (connFail.length) {
    failures.push(`aoi ring arm: ${connFail.length} of ${AOI_PLAYERS} client(s) failed to connect (${connFail[0].message}), so no arm ran`)
    return null
  }
  const joinDeadline = Date.now() + 30000
  while (server.playerManager.getConnectedPlayers().length < AOI_PLAYERS && Date.now() < joinDeadline) await sleep(50)
  for (let i = 0; i < clients.length; i++) clients[i].startInputLoop(() => ({ forward: false, sprint: false, yaw: i, pitch: 0 }))
  await sleep(1500)

  const players = server.playerManager.getConnectedPlayers()
  const perCell = Math.max(2, Math.floor(AOI_PLAYERS / 4))
  for (let i = 0; i < players.length; i++) {
    const slot = Math.floor(i / perCell)
    const x = (slot % 2) * AOI_SPREAD_M
    const z = Math.floor(slot / 2) * AOI_SPREAD_M
    const g = server.physics.terrainHeightAt ? server.physics.terrainHeightAt(x, z) : NaN
    players[i].state.position[0] = x
    players[i].state.position[1] = (Number.isFinite(g) ? g : 0) + 2
    players[i].state.position[2] = z
    try { server.physicsIntegration.setPlayerPosition(players[i].id, players[i].state.position) } catch {}
  }
  await sleep(2500)

  let ticks = 0
  let baseMismatch = 0
  let baseChecks = 0
  let maxCellBaseCache = 0
  const mismatchSamples = []

  const recentTicks = []
  const observe = () => {
    ticks++
    const liveRadius = stage ? stage.spatial.relevanceRadius : 0
    const active = runtime._stageLoader ? runtime._stageLoader.getActiveStage() : null
    recentTicks.push({ tick: ticks, liveRadius, activeRadius: active ? active.spatial.relevanceRadius : null, sameStage: active === stage, epoch: aoi.aoiCellBaseEpoch(), baseComputes: aoiRingWork.cellBaseComputes })
    if (recentTicks.length > 8) recentTicks.shift()
    if (aoi.aoiCellBaseCacheSize() > maxCellBaseCache) maxCellBaseCache = aoi.aoiCellBaseCacheSize()
    for (const [, c] of _spatialCache) {
      if (!c.baseRelevantIds) continue
      baseChecks++
      const fresh = runtime.relevantEntities(c.cellViewerPos, liveRadius)
      if (!sameIdSet(fresh, c.baseRelevantIds)) {
        baseMismatch++
        if (mismatchSamples.length < 6) {
          const cached = new Set(c.baseRelevantIds), now = new Set(fresh)
          const onlyCached = [...cached].filter(id => !now.has(id))
          const onlyFresh = [...now].filter(id => !cached.has(id))
          mismatchSamples.push({ tick: ticks, liveRadius, epoch: aoi.aoiCellBaseEpoch(), cached: cached.size, fresh: now.size, onlyCached, onlyFresh, recent: recentTicks.slice() })
        }
      }
    }
  }

  const tickSystem = server.tickSystem || null
  if (!tickSystem || typeof tickSystem.onTick !== 'function') {
    failures.push('aoi ring arm: server exposes no tickSystem.onTick, so no observation window can be aligned to a completed snapshot pass')
    return null
  }
  tickSystem.onTick(observe)

  const snapshotWork = () => ({ ...aoiRingWork, ticks })
  async function window(label, n = AOI_TICKS) {
    const before = snapshotWork()
    const mismatchBefore = baseMismatch
    const start = Date.now()
    while (ticks - before.ticks < n && Date.now() - start < 30000) await sleep(25)
    const after = snapshotWork()
    const d = {}
    for (const k of Object.keys(before)) d[k] = after[k] - before[k]
    d.mismatch = baseMismatch - mismatchBefore
    const t = Math.max(1, d.ticks)
    return { label, ticks: d.ticks, per: n => Number((n / t).toFixed(2)), raw: d, epoch: aoi.aoiCodeEpoch() }
  }

  const rows = []
  for (let rep = 0; rep < AOI_REPS; rep++) {
    aoi.invalidateAoiCellBaseCache()
    const off = await window(`rep${rep}-cache-off`)
    await aoi.installAoiCodeEpoch()
    const cold = await window(`rep${rep}-cache-on-cold`, 24)
    const warm = await window(`rep${rep}-cache-on-warm`)
    rows.push({ rep, off, cold, warm })
  }

  const stageSpatial = stage ? stage.spatial : null
  const probes = {}
  if (stageSpatial) {
    await aoi.installAoiCodeEpoch()
    await window('cache-on-warm', 24)
    const steady = await window('cache-on-steady', 24)
    probes.steady = { centreSolves: steady.raw.cellCentreSolves, baseHits: steady.raw.cellBaseHits, ticks: steady.ticks, mismatch: steady.raw.mismatch }

    const savedRadius = stageSpatial.relevanceRadius
    stageSpatial.relevanceRadius = savedRadius + 37
    const changed = await window('radius-changed', 24)
    probes.radius = { centreSolves: changed.raw.cellCentreSolves, epochDrops: changed.raw.epochDrops, ticks: changed.ticks, mismatch: changed.raw.mismatch }
    stageSpatial.relevanceRadius = savedRadius
    const restoredRadius = await window('radius-restored', 24)
    probes.restoreRadius = { ticks: restoredRadius.ticks, mismatch: restoredRadius.raw.mismatch, centreSolves: restoredRadius.raw.cellCentreSolves }

    let moveEntity = null
    for (const id of stage.entityIds) {
      const e = runtime.entities.get(id)
      if (e && e.position) { moveEntity = e; break }
    }
    if (moveEntity) {
      const home = [moveEntity.position[0], moveEntity.position[1], moveEntity.position[2]]
      moveEntity.position[0] += 6
      moveEntity.position[2] += 6
      stage.updateEntityPosition(moveEntity.id, moveEntity.position)
      const moved = await window('entity-moved', 24)
      probes.move = { centreSolves: moved.raw.cellCentreSolves, epochDrops: moved.raw.epochDrops, ticks: moved.ticks, mismatch: moved.raw.mismatch }
      moveEntity.position[0] = home[0]
      moveEntity.position[1] = home[1]
      moveEntity.position[2] = home[2]
      stage.updateEntityPosition(moveEntity.id, moveEntity.position)
      const restoredMove = await window('entity-restored', 24)
      probes.restoreMove = { ticks: restoredMove.ticks, mismatch: restoredMove.raw.mismatch, centreSolves: restoredMove.raw.cellCentreSolves }
    }

    const R = stageSpatial.relevanceRadius
    const entPos = new Map()
    for (const id of stage.entityIds) { const p = stageSpatial.getPosition(id); if (p) entPos.set(id, p) }
    const cellXZ = (x, z) => [Math.floor(x / R), Math.floor(z / R)]
    const keyOf = (cx, cz) => (cx * 65536 + cz) | 0
    const ringSignatures = new Set()
    const perPlayerRings = []
    let farLeaks = 0
    let ownCellChecked = 0
    let ownCellMissing = 0
    for (const p of server.playerManager.getConnectedPlayers()) {
      const pos = p.state.position
      const [cx, cz] = cellXZ(pos[0], pos[2])
      const ring = _ringCache.get(keyOf(cx, cz))
      if (!ring) { perPlayerRings.push({ cell: `${cx}|${cz}`, ring: null }); continue }
      const ids = ring.relevantIds
      ringSignatures.add([...ids].sort().join(','))
      for (const id of ids) {
        const ep = entPos.get(id)
        if (!ep) continue
        if (Math.hypot(ep[0] - pos[0], ep[2] - pos[2]) > 3.5 * R) farLeaks++
      }
      for (const [id, ep] of entPos) {
        const [ex, ez] = cellXZ(ep[0], ep[2])
        if (ex !== cx || ez !== cz) continue
        ownCellChecked++
        if (!ids.has(id)) ownCellMissing++
      }
      perPlayerRings.push({ cell: `${cx}|${cz}`, ringSize: ids.size })
    }
    probes.divergence = { distinctRings: ringSignatures.size, farLeaks, ownCellChecked, ownCellMissing, perPlayerRings, entities: entPos.size, radius: R }
  }

  const observerAt = tickSystem.callbacks.indexOf(observe)
  if (observerAt >= 0) tickSystem.callbacks.splice(observerAt, 1)
  const cellsNow = new Set()
  for (const p of server.playerManager.getConnectedPlayers()) {
    cellsNow.add(`${Math.floor(p.state.position[0] / relevanceRadius)}|${Math.floor(p.state.position[2] / relevanceRadius)}`)
  }

  for (const c of clients) { try { c.close?.() } catch {} }
  try { await server.stop?.() } catch {}
  const drain = Date.now() + 2000
  const handles = () => (typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : 0)
  while (Date.now() < drain && handles() > 0) await sleep(25)

  return { rows, probes, baseMismatch, baseChecks, mismatchSamples, maxCellBaseCache, distinctPlayerCells: cellsNow.size, players: players.length, relevanceRadius, stageEntities: stageSpatial ? stageSpatial.size : 0 }
}

const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '-')
const outFiles = []

async function collect(tag, bots, extraFlags) {
  const out = resolve(SDK_ROOT, 'data', 'netcode-harness', `relevance-${process.pid}-${tag}.json`)
  const argv = [
    HARNESS,
    `--world=${WORLD}`,
    '--precise',
    `--tick=${TICK}`,
    `--duration=${DURATION}`,
    '--predict=off',
    '--kinds=off',
    `--cond=${COND}`,
    `--bots=${bots}`,
    `--out=${out}`,
    `--at=${AT}`,
    ...extraFlags,
  ]
  execFileSync(process.execPath, argv, { cwd: SDK_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SPOINT_NO_WATCH: '1', SPOINT_SKIP_PREWARM: '1' } })
  outFiles.push(out)
  return JSON.parse(await readFile(out, 'utf8')).results[0]
}

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return NaN
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2
}

function metrics(r) {
  return {
    tickHz: r.ticks?.hz ?? NaN,
    snapHz: r.snapshots?.hz ?? NaN,
    downKBps: r.bandwidth?.downKBps ?? NaN,
    snapshotBytesAvg: r.bandwidth?.snapshotBytesAvg ?? NaN,
    shotCount: r.hitReg?.shots ?? 0,
    hitRate: r.hitReg?.hitRate ?? NaN,
    remotePops: r.remotePops?.pops ?? NaN,
  }
}

const failures = []
const table = []
const decisions = []

for (const count of COUNTS) {
  const bots = Math.max(0, count - 2)
  const rows = {}
  for (const arm of ['off', 'on']) {
    const list = []
    for (let rep = 0; rep < REPS; rep++) {
      const r = await collect(`${count}-${arm}-${rep}`, bots, arm === 'on' ? [`--relevance=${RADIUS}`] : [])
      const m = metrics(r)
      if (Math.abs(m.tickHz - TICK) > TICK_WINDOW_HZ) { list.push(null); continue }
      list.push(m)
    }
    const kept = list.filter(Boolean)
    rows[arm] = {
      kept: kept.length,
      tickHz: median(kept.map(m => m.tickHz)),
      snapHz: median(kept.map(m => m.snapHz)),
      downKBps: median(kept.map(m => m.downKBps)),
      snapshotBytesAvg: median(kept.map(m => m.snapshotBytesAvg)),
      hitRate: median(kept.map(m => m.hitRate)),
      shotCount: kept.reduce((s, m) => s + m.shotCount, 0),
      remotePops: median(kept.map(m => m.remotePops)),
    }
    if (kept.length === 0) failures.push(`${count} player(s), relevance ${arm}: no rep landed within ${TICK}+-${TICK_WINDOW_HZ} Hz, so this arm is unmeasured`)
  }
  const off = rows.off, on = rows.on
  const bytePct = (off.snapshotBytesAvg > 0 && Number.isFinite(on.snapshotBytesAvg)) ? (1 - on.snapshotBytesAvg / off.snapshotBytesAvg) * 100 : NaN
  const downPct = (off.downKBps > 0 && Number.isFinite(on.downKBps)) ? (1 - on.downKBps / off.downKBps) * 100 : NaN
  const worthIt = Number.isFinite(bytePct) && bytePct >= WORTH_PCT && (on.hitRate >= off.hitRate - 0.01)
  decisions.push({ count, bytePct, downPct, worthIt, off, on })
  for (const arm of ['off', 'on']) {
    const a = rows[arm]
    table.push(`| ${count} | ${arm === 'on' ? `${RADIUS} m` : 'off'} | ${a.kept}/${REPS} | ${fmt(a.tickHz, 1)} | ${fmt(a.snapHz, 1)} | ${fmt(a.snapshotBytesAvg, 0)} | ${fmt(a.downKBps, 2)} | ${fmt(a.hitRate, 3)} | ${fmt(a.remotePops, 1)} |`)
  }
}

console.log(`\nrelevance radius ${RADIUS} m vs off, world "${WORLD}", cond ${COND}, tick ${TICK} Hz, ${REPS} rep(s) of ${DURATION} ms`)
console.log('| players | relevance | reps kept | tick Hz | snap Hz | snap bytes/snapshot | KB/s down (mover) | hit rate | remote pops |')
console.log('|' + '---|'.repeat(9))
for (const line of table) console.log(line)
console.log('\nper-count decision (counted units: bytes per snapshot at the mover, downstream KB/s at the mover):')
for (const d of decisions) {
  console.log(`  ${d.count} player(s): snapshot bytes ${fmt(d.off.snapshotBytesAvg, 0)} -> ${fmt(d.on.snapshotBytesAvg, 0)} (${fmt(d.bytePct, 1)}% cut), downstream ${fmt(d.off.downKBps, 2)} -> ${fmt(d.on.downKBps, 2)} KB/s (${fmt(d.downPct, 1)}% cut), hit rate ${fmt(d.off.hitRate, 3)} -> ${fmt(d.on.hitRate, 3)} -- ${d.worthIt ? `WORTH ENABLING at >=${WORTH_PCT}%` : `NOT worth enabling at >=${WORTH_PCT}%`}`)
}
const anyWorth = decisions.filter(d => d.worthIt)
console.log(`\nDECISION: interest management ${anyWorth.length ? `earns its complexity at ${anyWorth.map(d => d.count).join(', ')} player(s)` : `does not reach the ${WORTH_PCT}% byte cut at any measured count (${COUNTS.join(', ')}), so leaving relevanceRadius off by default is the honest default at these world sizes`}`)

const aoiArm = await runAoiRingArm()
if (aoiArm) {
  const { rows, probes, baseChecks, baseMismatch, mismatchSamples, maxCellBaseCache } = aoiArm
  console.log(`\nAOI ring cell-neighbour capture (counted work units, world "tps-game", ${aoiArm.players} real client(s), ${aoiArm.stageEntities} stage entities, relevance ${aoiArm.relevanceRadius} m, LRU cap ${AOI_CELL_BASE_MAX})`)
  console.log('| rep | arm | code epoch | ticks | cell-centre solves/tick | base computes/tick | base hits/tick | stateful queries/tick | base-set mismatches |')
  console.log('|' + '---|'.repeat(9))
  for (const row of rows) {
    for (const [name, w] of [['off', row.off], ['on-cold', row.cold], ['on-warm', row.warm]]) {
      console.log(`| ${row.rep} | ${name} | ${w.epoch === '' ? 'none' : w.epoch.slice(0, 8)} | ${w.ticks} | ${w.per(w.raw.cellCentreSolves)} | ${w.per(w.raw.cellBaseComputes)} | ${w.per(w.raw.cellBaseHits)} | ${w.per(w.raw.statefulQueries)} | ${w.raw.mismatch} |`)
    }
  }
  console.log(`| probe | steady | - | ${probes.steady.ticks} | ${probes.steady.centreSolves} | - | - | - | ${probes.steady.mismatch} |`)
  console.log(`| probe | radius-changed | - | ${probes.radius.ticks} | ${probes.radius.centreSolves} | - | - | - | ${probes.radius.mismatch} |`)
  console.log(`| probe | entity-moved | - | ${probes.move.ticks} | ${probes.move.centreSolves} | - | - | - | ${probes.move.mismatch} |`)
  console.log(`| probe | radius-restored | - | ${probes.restoreRadius.ticks} | ${probes.restoreRadius.centreSolves} | - | - | - | ${probes.restoreRadius.mismatch} |`)
  console.log(`| probe | entity-restored | - | ${probes.restoreMove.ticks} | ${probes.restoreMove.centreSolves} | - | - | - | ${probes.restoreMove.mismatch} |`)
  if (aoiArm.relevanceRadius <= 0) failures.push(`aoi ring arm: relevance radius is 0 in "tps-game", so the AOI path never ran and every work count below is vacuous`)
  if (aoiArm.stageEntities <= 0) failures.push(`aoi ring arm: stage spatial holds 0 entities, so a cached empty set is indistinguishable from a correct one`)
  if (baseChecks <= 0) failures.push(`aoi ring arm: the per-tick equivalence check never fired (baseChecks 0), so cached base sets were never compared against a fresh recompute`)
  if (baseMismatch > 0) {
    failures.push(`aoi ring arm: ${baseMismatch} of ${baseChecks} cached cell base set(s) differ from a fresh recompute, so the cache serves stale entity ids`)
    for (const s of mismatchSamples) {
      console.error(`MISMATCH tick=${s.tick} liveRadius=${s.liveRadius} epoch=${s.epoch} cached=${s.cached} fresh=${s.fresh} onlyCached=[${s.onlyCached}] onlyFresh=[${s.onlyFresh}]`)
      for (const r of s.recent) console.error(`  t${r.tick} stageR=${r.liveRadius} activeR=${r.activeRadius} sameStage=${r.sameStage} baseComputes=${r.baseComputes}`)
    }
  }
  if (maxCellBaseCache > AOI_CELL_BASE_MAX) failures.push(`aoi ring arm: cell base cache reached ${maxCellBaseCache} entries, over the ${AOI_CELL_BASE_MAX} LRU cap`)

  const perTick = (w, k) => w.per(w.raw[k])
  const controlSpread = Math.max(...rows.map(r => perTick(r.off, 'cellCentreSolves'))) - Math.min(...rows.map(r => perTick(r.off, 'cellCentreSolves')))
  for (const row of rows) {
    for (const [name, w] of [['off', row.off], ['on-cold', row.cold], ['on-warm', row.warm]]) {
      if (w.ticks < 20) failures.push(`aoi ring arm rep ${row.rep} ${name}: only ${w.ticks} tick(s) landed in the window, so its work counts measure too little to compare`)
    }
    if (perTick(row.off, 'cellCentreSolves') < 1) failures.push(`aoi ring arm rep ${row.rep}: control arm solved ${perTick(row.off, 'cellCentreSolves')} cell centre(s)/tick, so the always-recompute baseline is not doing the work the cache claims to remove`)
    if (row.warm.raw.cellCentreSolves !== 0) failures.push(`aoi ring arm rep ${row.rep}: warm cached window still solved ${row.warm.raw.cellCentreSolves} cell centre(s) over ${row.warm.ticks} tick(s), so the cell base cache is not being hit`)
    if (row.warm.raw.cellBaseHits < row.warm.ticks) failures.push(`aoi ring arm rep ${row.rep}: warm window only served ${row.warm.raw.cellBaseHits} base hit(s) over ${row.warm.ticks} tick(s), fewer than one ring per tick`)
    if (perTick(row.off, 'statefulQueries') !== perTick(row.warm, 'statefulQueries')) failures.push(`aoi ring arm rep ${row.rep}: stateful hysteresis/starvation queries moved ${perTick(row.off, 'statefulQueries')} -> ${perTick(row.warm, 'statefulQueries')} per tick, so the cache changed how often those stateful methods advance`)
  }
  if (controlSpread !== 0) failures.push(`aoi ring arm: control arm rep-to-rep spread is ${controlSpread} cell-centre solves/tick, so the measured reduction is inside the control's own noise`)
  if (probes.steady && probes.steady.centreSolves !== 0) failures.push(`aoi ring arm: steady state still solved ${probes.steady.centreSolves} cell centre(s) over ${probes.steady.ticks} tick(s), so nothing settled`)
  if (!probes.radius) failures.push('aoi ring arm: relevance-radius invalidation probe did not run')
  else if (probes.radius.centreSolves < 8 || probes.radius.epochDrops < 8) failures.push(`aoi ring arm: after relevanceRadius changed, only ${probes.radius.centreSolves} cell centre(s) were re-solved and ${probes.radius.epochDrops} cache entr(y/ies) dropped (need >= 8 each), so a radius change is served stale base sets`)
  if (!probes.move) failures.push('aoi ring arm: entity-move invalidation probe did not run')
  else if (probes.move.centreSolves < 8 || probes.move.epochDrops < 8) failures.push(`aoi ring arm: after an entity moved 6 m, only ${probes.move.centreSolves} cell centre(s) were re-solved and ${probes.move.epochDrops} cache entr(y/ies) dropped (need >= 8 each), so entity motion is served stale base sets`)

  if (!probes.divergence) failures.push('aoi ring arm: per-player ring divergence probe did not run')
  else {
    const dv = probes.divergence
    if (aoiArm.distinctPlayerCells < 2) failures.push(`aoi ring arm: ${aoiArm.players} player(s) occupy only ${aoiArm.distinctPlayerCells} distinct relevance cell(s), so per-player ring divergence cannot be measured`)
    else if (dv.distinctRings < 2) failures.push(`aoi ring arm: ${aoiArm.players} player(s) across ${aoiArm.distinctPlayerCells} relevance cell(s) were all served the same relevant id set (${dv.perPlayerRings.map(r => `${r.cell}:${r.ringSize}`).join(' ')}), so the ring is still anchored at the origin instead of each player's own cell`)
    if (dv.farLeaks > 0) failures.push(`aoi ring arm: ${dv.farLeaks} served id(s) sit farther than 3.5 x ${dv.radius} m from the player they were served to, which no ring built around that player's own cell can legitimately reach`)
    if (dv.ownCellChecked === 0) failures.push('aoi ring arm: no player had a stage entity inside their own relevance cell, so own-cell coverage is unmeasured')
    else if (dv.ownCellMissing > 0) failures.push(`aoi ring arm: ${dv.ownCellMissing} of ${dv.ownCellChecked} stage entit(y/ies) inside a player's own relevance cell were missing from that player's ring`)
  }

  const cut = rows.length && perTick(rows[0].off, 'cellCentreSolves') > 0
    ? (1 - perTick(rows[0].warm, 'cellCentreSolves') / perTick(rows[0].off, 'cellCentreSolves')) * 100
    : NaN
  console.log(`\ncell-centre solves/tick ${fmt(perTick(rows[0].off, 'cellCentreSolves'), 2)} -> ${fmt(perTick(rows[0].warm, 'cellCentreSolves'), 2)} (${fmt(cut, 1)}% cut), control arm rep-to-rep spread ${controlSpread}`)
  console.log(`stateful queries/tick held at ${fmt(perTick(rows[0].off, 'statefulQueries'), 2)} -> ${fmt(perTick(rows[0].warm, 'statefulQueries'), 2)}, equivalence ${baseChecks - baseMismatch}/${baseChecks} cached base set(s) matched a fresh recompute, cache peak ${maxCellBaseCache}/${AOI_CELL_BASE_MAX}`)
  console.log(`invalidation: radius change re-solved ${probes.radius ? probes.radius.centreSolves : '-'} centre(s) and dropped ${probes.radius ? probes.radius.epochDrops : '-'} entr(y/ies); entity move re-solved ${probes.move ? probes.move.centreSolves : '-'} centre(s) and dropped ${probes.move ? probes.move.epochDrops : '-'} entr(y/ies)`)
  const dv = probes.divergence
  console.log(`per-player ring: ${aoiArm.distinctPlayerCells} player cell(s) -> ${dv ? dv.distinctRings : '-'} distinct relevant id set(s) [${dv ? dv.perPlayerRings.map(r => `${r.cell}=${r.ringSize === null ? 'none' : r.ringSize}`).join(' ') : '-'}], own-cell entities served ${dv ? dv.ownCellChecked - dv.ownCellMissing : '-'}/${dv ? dv.ownCellChecked : '-'}, ids beyond 3.5r of their player ${dv ? dv.farLeaks : '-'}`)
  console.log(`OBSERVATION: ${aoiArm.players} player(s) occupy ${aoiArm.distinctPlayerCells} distinct relevance cell(s), spread ${AOI_SPREAD_M} m against relevance ${aoiArm.relevanceRadius} m`)
}

for (const f of outFiles) await rm(f, { force: true })
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`)
  console.log(`\nRESULT: FAIL (${failures.length} failure(s))`)
  process.exit(1)
}
console.log('\nRESULT: PASS')
process.exit(0)
