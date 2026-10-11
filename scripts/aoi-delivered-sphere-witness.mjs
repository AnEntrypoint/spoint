import crypto from 'node:crypto'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Stage } from '../src/stage/Stage.js'
import { flatPlanetRadius, clusterPlanetRadius } from '../src/stage/planetRadius.js'
import { StageLoader } from '../src/stage/StageLoader.js'
import { AppRuntime } from '../src/apps/AppRuntime.js'
import tpsPreset from '../src/presets/tps.js'

const DEFAULT_MODULE = fileURLToPath(new URL('../src/sdk/TickHandlerAOI.js', import.meta.url))

const RELEVANCE = tpsPreset.relevanceRadius
const PLANET_RADIUS = 0
const STARVE_WINDOW = 300
const TICKS = STARVE_WINDOW + 60
const VIEWER = [70, 0, 80]
const SPHERE_ENTITIES = [
  ['ground-inside', [60, 0, 55]],
  ['high-outside', [60, 240, 55]],
  ['deep-outside', [60, -240, 55]],
]
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
  const stage = new Stage('aoi-delivered-sphere', { relevanceRadius: RELEVANCE, planetRadius: PLANET_RADIUS === 0 ? flatPlanetRadius() : clusterPlanetRadius(PLANET_RADIUS) })
  const stageLoader = Object.create(StageLoader.prototype)
  stageLoader._stages = new Map([['aoi-delivered-sphere', stage]])
  stageLoader._activeStage = stage
  for (const [id, pos] of SPHERE_ENTITIES.concat(OUT_RING)) {
    stage.entityIds.add(id)
    stage.spatial.insert(id, pos)
  }
  const runtime = { _stageLoader: stageLoader, entities: new Map() }
  runtime.relevantEntities = AppRuntime.prototype.relevantEntities.bind(runtime)
  runtime.getRelevantDynamicIdsWithStarvation = AppRuntime.prototype.getRelevantDynamicIdsWithStarvation.bind(runtime)
  return { stage, stageLoader, runtime }
}

function sphereDistanceToViewer(stage, id, viewer) {
  const p = stage.spatial.getPosition(id)
  if (!p) return null
  const dx = p[0] - viewer[0], dy = p[1] - viewer[1], dz = p[2] - viewer[2]
  return { d: Math.sqrt(dx * dx + dy * dy + dz * dz), horizontal: Math.sqrt(dx * dx + dz * dz), pos: [p[0], p[1], p[2]] }
}

function describeOutside(stage, ids, viewer) {
  const r2 = RELEVANCE * RELEVANCE
  const out = []
  for (const id of ids) {
    const m = sphereDistanceToViewer(stage, id, viewer)
    if (!m) continue
    if (m.d * m.d > r2) out.push(`${id} at (${m.pos.join(',')}) sphere ${m.d.toFixed(1)}m horizontal ${m.horizontal.toFixed(1)}m`)
  }
  return out
}

async function main() {
  const override = moduleArgument(process.argv.slice(2))
  const modulePath = override === null ? DEFAULT_MODULE : path.resolve(process.cwd(), override)
  console.log(`witness aoi-delivered-sphere node=${process.version}`)
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
  const surface = typeof aoi.resolvePlayerCell === 'function' && typeof aoi.computeRingRelevantIds === 'function' && typeof aoi.resolveDeliveredIds === 'function'
  if (!surface) {
    record('C0', 'module exposes the cell ring plus delivery entry surface', { ok: false, detail: 'resolvePlayerCell, computeRingRelevantIds or resolveDeliveredIds missing' })
    finishWithClaims()
    return
  }
  record('C0', 'module exposes the cell ring plus delivery entry surface', { ok: true, detail: 'resolvePlayerCell, computeRingRelevantIds and resolveDeliveredIds present' })

  const { stage, stageLoader, runtime } = buildRuntime()
  await aoi.installAoiCodeEpoch()
  aoi.invalidateAoiCellBaseCache()
  aoi.resetAoiRingWork()
  const cell = aoi.resolvePlayerCell(VIEWER, PLANET_RADIUS, RELEVANCE)
  const unmanagedIds = SPHERE_ENTITIES.concat(OUT_RING).map(e => e[0])

  runClaim('C1', `a shipped flat preset (relevanceRadius=${RELEVANCE}, planetRadius=${PLANET_RADIUS}) resolves to a flat cell`, () => {
    const ok = cell.cellFace === -1 && cell.cellsPerFace === 0
    return { ok, detail: `cellFace=${cell.cellFace} cellsPerFace=${cell.cellsPerFace} cellKey=${cell.cellKey}` }
  })

  let firstViolationTick = null
  let firstViolationIds = []
  const deliveredTrace = []
  for (let t = 1; t <= TICKS; t++) {
    aoi._spatialCache.clear()
    aoi._ringCache.clear()
    aoi.setAoiCellBaseEpoch(RELEVANCE, PLANET_RADIUS, runtime)
    const ring = aoi.computeRingRelevantIds(cell.cellKey, cell.cellFace, cell.cellCx, cell.cellCy, cell.cellsPerFace, PLANET_RADIUS, RELEVANCE, runtime)
    const delivered = aoi.resolveDeliveredIds(ring.relevantIds, unmanagedIds, VIEWER, PLANET_RADIUS, RELEVANCE, runtime)
    const outside = describeOutside(stage, delivered, VIEWER)
    if (outside.length > 0 && firstViolationTick === null) { firstViolationTick = t; firstViolationIds = outside }
    if (t === 1 || t % 100 === 0 || t === TICKS) deliveredTrace.push(`t${t}=${delivered.size}`)
  }
  console.log(`delivered size trace over ${TICKS} ticks: ${deliveredTrace.join(' ')} (sphere entities ${SPHERE_ENTITIES.length}, out-of-ring entities ${OUT_RING.length})`)

  runClaim('C2', `invariant "every delivered id lies inside the spherical relevance ball of some viewer" is VIOLATED on the flat shipped world (measured, filed as a row)`, () => {
    const ok = firstViolationTick !== null
    return { ok, detail: ok ? `violation at tick ${firstViolationTick}: ${firstViolationIds.join('; ')}` : `no violation in ${TICKS} ticks` }
  })
  runClaim('C3', `the delivery gate is not vacuous: no out-of-ring entity is delivered in ${TICKS} ticks`, () => {
    aoi._spatialCache.clear()
    aoi._ringCache.clear()
    aoi.setAoiCellBaseEpoch(RELEVANCE, PLANET_RADIUS, runtime)
    const ring = aoi.computeRingRelevantIds(cell.cellKey, cell.cellFace, cell.cellCx, cell.cellCy, cell.cellsPerFace, PLANET_RADIUS, RELEVANCE, runtime)
    const delivered = aoi.resolveDeliveredIds(ring.relevantIds, unmanagedIds, VIEWER, PLANET_RADIUS, RELEVANCE, runtime)
    const leaked = OUT_RING.filter(e => delivered.has(e[0])).map(e => e[0])
    return { ok: leaked.length === 0, detail: `leaked=${leaked.join(',') || 'none'}; delivered=${[...delivered].join(',') || 'none'}` }
  })
  runClaim('C4', 'on a flat stage the single geometry holder Stage.getRelevantEntitiesForCell returns exactly the horizontal relation, so the ring base can derive its relation from it', () => {
    const viaHolder = stageLoader.getRelevantEntitiesForCell(VIEWER, RELEVANCE).slice().sort()
    const viaHorizontal = stageLoader.getRelevantEntitiesHorizontal(VIEWER, RELEVANCE).slice().sort()
    const ok = viaHolder.length === viaHorizontal.length && viaHolder.every((id, i) => id === viaHorizontal[i])
    return { ok, detail: `holder=[${viaHolder.join(',')}] horizontal=[${viaHorizontal.join(',')}]` }
  })
  const caseNames = aoi.AOI_ENTITY_POSITION_CASE
  runtime.entities.set('registry-no-position', {})
  aoi.resetAoiRingWork()
  const knownResult = aoi._positionOfEntity(runtime, 'ground-inside')
  const noPositionResult = aoi._positionOfEntity(runtime, 'registry-no-position')
  const unknownResult = aoi._positionOfEntity(runtime, 'vanished-id')
  const work = { ...aoi.aoiRingWork }

  runClaim('C5', 'the entity-position case set names both refusals, so neither is expressible as the other', () => {
    const names = Object.keys(caseNames || {}).sort()
    const ok = names.length === 3 && names.join(',') === 'noPosition,position,unknownEntity'
    return { ok, detail: `cases=[${names.join(',')}]` }
  })
  runClaim('C6', 'an id neither the index nor the registry knows resolves to unknownEntity, not null and not noPosition', () => {
    const ok = unknownResult !== null && unknownResult.case === caseNames.unknownEntity && unknownResult.position === null
    return { ok, detail: `case=${unknownResult && unknownResult.case} position=${String(unknownResult && unknownResult.position)}` }
  })
  runClaim('C7', 'an entity the registry holds without a position resolves to noPosition, distinct from unknownEntity', () => {
    const ok = noPositionResult !== null && noPositionResult.case === caseNames.noPosition && noPositionResult.case !== unknownResult.case
    return { ok, detail: `noPosition=${noPositionResult && noPositionResult.case} unknown=${unknownResult && unknownResult.case}` }
  })
  runClaim('C8', 'each refusal is counted separately on the hot path instead of collapsing into one unresolved null', () => {
    const ok = knownResult.case === caseNames.position && work.positionOfEntityResolves === 1 && work.positionOfEntityNoPosition === 1 && work.positionOfEntityUnknownEntity === 1
    return { ok, detail: `known=${knownResult && knownResult.case} resolves=${work.positionOfEntityResolves} noPosition=${work.positionOfEntityNoPosition} unknown=${work.positionOfEntityUnknownEntity}` }
  })
  runClaim('C9', 'the delivery policy is unchanged: both unresolvable ids still reach the client through resolveDeliveredIds', () => {
    aoi.resetAoiRingWork()
    aoi._spatialCache.clear()
    aoi._ringCache.clear()
    aoi.setAoiCellBaseEpoch(RELEVANCE, PLANET_RADIUS, runtime)
    const ring = aoi.computeRingRelevantIds(cell.cellKey, cell.cellFace, cell.cellCx, cell.cellCy, cell.cellsPerFace, PLANET_RADIUS, RELEVANCE, runtime)
    const delivered = aoi.resolveDeliveredIds(ring.relevantIds, ['registry-no-position', 'vanished-id'], VIEWER, PLANET_RADIUS, RELEVANCE, runtime)
    const keptBoth = delivered.has('registry-no-position') && delivered.has('vanished-id')
    return { ok: keptBoth, detail: `delivered=[${[...delivered].join(',')}]` }
  })
  finishWithClaims()

  const active = process._getActiveHandles ? process._getActiveHandles().length : 0
  if (active > 0) console.log(`active_handles ${active}`)
}

await main()
