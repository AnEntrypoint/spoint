import crypto from 'node:crypto'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Stage } from '../src/stage/Stage.js'
import { StageLoader } from '../src/stage/StageLoader.js'
import { AppRuntime } from '../src/apps/AppRuntime.js'

const DEFAULT_MODULE = fileURLToPath(new URL('../src/sdk/TickHandlerAOI.js', import.meta.url))

const RELEVANCE = 100
const PLANET_RADIUS = 0
const STARVE_WINDOW = 300
const TICKS = STARVE_WINDOW + 60
const PLAYER = [70, 0, 80]
const IN_RING = [['near-a', [60, 0, 55]], ['near-b', [140, 0, 60]], ['near-c', [30, 0, 130]]]
const OUT_RING = [['far-a', [9000, 0, 9000]], ['far-b', [-5200, 0, 4100]]]

const claimResults = []

function record(id, text, outcome) {
  claimResults.push(outcome.ok === true)
  console.log(`${outcome.ok === true ? 'PASS' : 'FAIL'} ${id} ${text} -- ${outcome.detail}`)
}

function runClaim(id, text, fn) {
  try {
    record(id, text, fn())
  } catch (err) {
    record(id, text, { ok: false, detail: `exception ${err && err.name}: ${err && err.message}` })
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function finishWithFailure(reason) {
  console.log(`RESULT: FAIL (${reason})`)
  process.exitCode = 1
}

function finishWithClaims() {
  const passed = claimResults.filter(Boolean).length
  const total = claimResults.length
  if (passed === total) {
    console.log(`RESULT: PASS (${passed} of ${total} claims)`)
    process.exitCode = 0
  } else {
    console.log(`RESULT: FAIL (${total - passed} of ${total} claims failed)`)
    process.exitCode = 1
  }
}

function moduleArgument(argv) {
  const hit = argv.find(arg => arg.startsWith('--module='))
  return hit === undefined ? null : hit.slice('--module='.length)
}

function buildRuntime() {
  const stage = new Stage('aoi-postcondition', { relevanceRadius: RELEVANCE, planetRadius: PLANET_RADIUS })
  const stageLoader = Object.create(StageLoader.prototype)
  stageLoader._stages = new Map([['aoi-postcondition', stage]])
  stageLoader._activeStage = stage
  for (const [id, pos] of IN_RING.concat(OUT_RING)) {
    stage.entityIds.add(id)
    stage.spatial.insert(id, pos)
  }
  const runtime = { _stageLoader: stageLoader }
  runtime.relevantEntities = AppRuntime.prototype.relevantEntities.bind(runtime)
  runtime.getRelevantDynamicIdsWithStarvation = AppRuntime.prototype.getRelevantDynamicIdsWithStarvation.bind(runtime)
  return { stage, stageLoader, runtime }
}

function cellCentres(cellCx, cellCy, relevance) {
  const out = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      out.push([(cellCx + dx + 0.5) * relevance, 0, (cellCy + dy + 0.5) * relevance])
    }
  }
  return out
}

function worstOutsideRing(stage, ids, centres, relevance) {
  const r2 = relevance * relevance
  let worst = null
  for (const id of ids) {
    const p = stage.spatial.getPosition(id)
    if (!p) continue
    let best = Infinity
    for (const c of centres) {
      const dx = p[0] - c[0], dz = p[2] - c[2]
      const d2 = dx * dx + dz * dz
      if (d2 < best) best = d2
    }
    if (best > r2 && (worst === null || best > worst.d2)) worst = { id, d2: best, dist: Math.sqrt(best), pos: [p[0], p[1], p[2]] }
  }
  return worst
}

function describeWorst(worst) {
  if (!worst) return 'none'
  return `id=${worst.id} at (${worst.pos.join(',')}) horizontal ${worst.dist.toFixed(1)}m from the nearest of the nine cell centres, ring radius ${RELEVANCE}m`
}

async function main() {
  const override = moduleArgument(process.argv.slice(2))
  const modulePath = override === null ? DEFAULT_MODULE : path.resolve(process.cwd(), override)
  console.log(`witness aoi-ring-postcondition node=${process.version}`)
  console.log(`module ${modulePath}`)
  if (!fs.existsSync(modulePath)) {
    finishWithFailure(`module not found: ${modulePath}`)
    return
  }
  console.log(`module_sha256 ${sha256(modulePath)}`)
  let aoi
  try {
    aoi = await import(pathToFileURL(modulePath).href)
  } catch (err) {
    finishWithFailure(`module import failed: ${err && (err.code || err.name)}: ${String(err && err.message).split('\n')[0]}`)
    return
  }
  const surface = typeof aoi.resolvePlayerCell === 'function' && typeof aoi.computeRingRelevantIds === 'function'
  if (!surface) {
    record('C0', 'module exposes the cell ring entry surface', { ok: false, detail: 'resolvePlayerCell or computeRingRelevantIds missing' })
    finishWithClaims()
    return
  }
  record('C0', 'module exposes the cell ring entry surface', { ok: true, detail: 'resolvePlayerCell and computeRingRelevantIds present' })

  const { stage, stageLoader, runtime } = buildRuntime()
  await aoi.installAoiCodeEpoch()
  aoi.invalidateAoiCellBaseCache()
  aoi.resetAoiRingWork()
  const cell = aoi.resolvePlayerCell(PLAYER, PLANET_RADIUS, RELEVANCE)
  const centres = cellCentres(cell.cellCx, cell.cellCy, RELEVANCE)

  const baseUnion = new Set()
  for (const c of centres) for (const id of stageLoader.getRelevantEntitiesHorizontal(c, RELEVANCE)) baseUnion.add(id)
  const baseWorst = worstOutsideRing(stage, baseUnion, centres, RELEVANCE)
  const baseOut = [...baseUnion].filter(id => !IN_RING.some(e => e[0] === id))

  let firstWorst = null
  let starveWorst = null
  const sizeTrace = []
  const inRingMissing = []
  for (let t = 1; t <= TICKS; t++) {
    aoi._spatialCache.clear()
    aoi._ringCache.clear()
    aoi.setAoiCellBaseEpoch(RELEVANCE, PLANET_RADIUS, runtime)
    const ring = aoi.computeRingRelevantIds(cell.cellKey, cell.cellFace, cell.cellCx, cell.cellCy, cell.cellsPerFace, PLANET_RADIUS, RELEVANCE, runtime)
    const worst = worstOutsideRing(stage, ring.relevantIds, centres, RELEVANCE)
    if (t === 1) {
      firstWorst = worst
      for (const [id] of IN_RING) if (!ring.relevantIds.has(id)) inRingMissing.push(id)
    }
    if (worst && starveWorst === null) starveWorst = { tick: t, ...worst }
    if (t === 1 || t % 100 === 0 || t === TICKS) sizeTrace.push(`t${t}=${ring.relevantIds.size}`)
  }
  console.log(`ring size trace over ${TICKS} ticks: ${sizeTrace.join(' ')} (in-ring entities ${IN_RING.length}, world entities ${IN_RING.length + OUT_RING.length})`)

  runClaim('C1', `on the first tick every id of the cell relevant set lies within relevanceRadius=${RELEVANCE}m horizontally of one of the nine cell centres around the player`, () => {
    const ok = firstWorst === null && inRingMissing.length === 0
    return { ok, detail: `outside=${describeWorst(firstWorst)}; in-ring ids absent from the set: ${inRingMissing.join(',') || 'none'}` }
  })
  runClaim('C2', `across ${TICKS} ticks, past the ${STARVE_WINDOW}-tick starvation window, the cell relevant set keeps every id within relevanceRadius=${RELEVANCE}m horizontally of one of the nine cell centres`, () => {
    return { ok: starveWorst === null, detail: starveWorst === null ? `no violation in ${TICKS} ticks` : `violation first seen at tick ${starveWorst.tick}: ${describeWorst(starveWorst)}` }
  })
  runClaim('C3', 'the spec-level base relevance set (union of the nine per-cell horizontal queries) obeys the same postcondition and carries no out-of-ring id', () => {
    const ok = baseWorst === null && baseOut.length === 0
    return { ok, detail: `outside=${describeWorst(baseWorst)}; ids in the base set that are not in-ring entities: ${baseOut.join(',') || 'none'}` }
  })
  finishWithClaims()

  const active = process._getActiveHandles ? process._getActiveHandles().length : 0
  if (active > 0) console.log(`active_handles ${active}`)
}

await main()
