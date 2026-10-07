import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PhysicsWorld } from '../src/physics/World.js'
import { AppRuntime } from '../src/apps/AppRuntime.js'
import { createEditorHandlers } from '../src/sdk/EditorHandlers.js'
import { StageLoader } from '../src/stage/StageLoader.js'
import { extractAllMeshesFromGLBAsync } from '../src/physics/GLBLoader.js'
import { MSG } from '../src/protocol/MessageTypes.js'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REAL_MODEL = './apps/maps/aim_sillos.glb'
const MISSING_MODEL = './apps/maps/definitely-not-a-model.glb'
const INSIDE_EMPTY_MODEL = './.gm/scratch/witness-trigger-only.glb'
const RETRY_MODEL = './.gm/scratch/witness-retry-model.glb'
const OUTSIDE_ROOT_MODEL = resolve(tmpdir(), 'spoint-witness-outside-root.glb')
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const eq = a.indexOf('=')
  return eq < 0 ? [a.replace(/^--/, ''), 'true'] : [a.slice(2, eq), a.slice(eq + 1)]
}))
const LABEL = args.label || 'run'
const OUT = args.out || null

const failures = []
function expect(cond, label) {
  if (!cond) failures.push(label)
  return cond
}

function buildTriangleGlb(materialName) {
  const bin = Buffer.alloc(48)
  const verts = [0, 0, 0, 1, 0, 0, 0, 1, 0]
  verts.forEach((v, i) => bin.writeFloatLE(v, i * 4))
  bin.writeUInt32LE(0, 36); bin.writeUInt32LE(1, 40); bin.writeUInt32LE(2, 44)
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    materials: [{ name: materialName }],
    meshes: [{ name: 'witness-tri', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5125, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 12 },
    ],
    buffers: [{ byteLength: 48 }],
  }
  let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4
  if (jsonPad) jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)])
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length
  const out = Buffer.alloc(total)
  out.write('glTF', 0, 'ascii')
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(total, 8)
  out.writeUInt32LE(jsonBytes.length, 12)
  out.writeUInt32LE(0x4e4f534a, 16)
  jsonBytes.copy(out, 20)
  out.writeUInt32LE(bin.length, 20 + jsonBytes.length)
  out.writeUInt32LE(0x004e4942, 24 + jsonBytes.length)
  bin.copy(out, 28 + jsonBytes.length)
  return out
}

mkdirSync(resolve(SDK_ROOT, '.gm/scratch'), { recursive: true })
writeFileSync(resolve(SDK_ROOT, INSIDE_EMPTY_MODEL), buildTriangleGlb('trigger'))
writeFileSync(OUTSIDE_ROOT_MODEL, buildTriangleGlb('trigger'))

function makeConnections() {
  const broadcasts = []
  const sends = []
  return {
    broadcasts, sends,
    send: (id, type, payload) => sends.push({ id, type, payload }),
    broadcast: (type, payload) => broadcasts.push({ type, payload }),
  }
}

const connections = makeConnections()
const physics = new PhysicsWorld({ gravity: [0, -9.81, 0] })
await physics.init()
const runtime = new AppRuntime({ physics, connections })
const editor = createEditorHandlers({ connections, appRuntime: runtime, physics })

function editorErrors() {
  return connections.broadcasts.filter(b => b.type === MSG.EDITOR_ERROR).map(b => b.payload)
}

function snapshotPending() {
  return [...runtime._pendingTrimeshBuilds]
}

async function settleTracked(pending) {
  const results = await Promise.allSettled(pending)
  return results.filter(r => r.status === 'rejected').map(r => ({ name: r.reason?.name, message: r.reason?.message }))
}

async function drainBuilds(timeoutMs = 30000) {
  await runtime.waitForPendingTrimeshBuilds(timeoutMs)
  await new Promise(r => setTimeout(r, 50))
  await runtime.waitForPendingTrimeshBuilds(timeoutMs)
}

async function waitFor(matches, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (matches()) return true
    await new Promise(r => setTimeout(r, 20))
  }
  return matches()
}

function describeCollider(entity) {
  if (!entity.collider) return 'none'
  return entity.collider.type === 'box'
    ? `box ${JSON.stringify(entity.collider.size)}`
    : entity.collider.type
}

const rows = []

function record(row) {
  rows.push(row)
  return row
}

async function armAppRuntimeAutoTrimesh(name, model) {
  const before = editorErrors().length
  const entity = runtime.spawnEntity(name, { model, position: [0, 10, 0], autoTrimesh: true })
  const tracked = snapshotPending()
  await drainBuilds()
  const rejected = await settleTracked(tracked)
  const errors = editorErrors().slice(before)
  return record({
    arm: `appruntime.autoTrimesh.${name}`,
    model,
    collider: describeCollider(entity),
    failedColliderType: entity._failedColliderType ?? null,
    bodyId: entity._physicsBodyId === undefined ? 'undefined' : String(entity._physicsBodyId),
    editorErrorCount: errors.length,
    boxFallback: errors.some(p => /box collider fallback/i.test(p.message || '')),
    detail: errors.map(p => p.detail).find(Boolean) || null,
    rejected: rejected[0] || null,
  })
}

async function armPlaceModel(name, url) {
  const before = editorErrors().length
  const sendsBefore = connections.sends.length
  editor.handle(MSG.PLACE_MODEL, { url, position: [0, 10, 0] }, 1)
  const tracked = snapshotPending()
  await drainBuilds()
  const rejected = await settleTracked(tracked)
  const errors = editorErrors().slice(before)
  const selected = connections.sends.slice(sendsBefore).filter(s => s.type === MSG.EDITOR_SELECT).pop()
  const entity = runtime.entities.get(selected?.payload?.entityId)
  return record({
    arm: `editor.placeModel.${name}`,
    model: url,
    entityId: entity?.id ?? null,
    collider: entity ? describeCollider(entity) : 'missing',
    failedColliderType: entity?._failedColliderType ?? null,
    bodyId: !entity || entity._physicsBodyId === undefined ? 'undefined' : String(entity._physicsBodyId),
    editorErrorCount: errors.length,
    boxFallback: errors.some(p => /box collider fallback/i.test(p.message || '')),
    detail: errors.map(p => p.detail).find(Boolean) || null,
    rejected: rejected[0] || null,
  })
}

async function armEditorRebuild(name, model, colliderType) {
  const entity = runtime.spawnEntity(name, { model: REAL_MODEL, position: [0, 10, 0], autoTrimesh: true })
  await drainBuilds()
  const builtBodyId = entity._physicsBodyId
  entity.model = model
  const before = editorErrors().length
  editor.handle(MSG.EDITOR_UPDATE, { entityId: entity.id, changes: { custom: { _collider: colliderType } } }, 1)
  await waitFor(() => entity._failedColliderType !== null || (entity._physicsBodyId !== undefined && entity._physicsBodyId !== builtBodyId))
  const errors = editorErrors().slice(before)
  return record({
    arm: `editor.rebuild.${name}`,
    model,
    requestedCollider: colliderType,
    bodyBefore: builtBodyId === undefined ? 'undefined' : String(builtBodyId),
    collider: describeCollider(entity),
    failedColliderType: entity._failedColliderType ?? null,
    bodyId: entity._physicsBodyId === undefined ? 'undefined' : String(entity._physicsBodyId),
    editorErrorCount: errors.length,
    boxFallback: errors.some(p => /box collider fallback/i.test(p.message || '')),
    detail: errors.map(p => p.detail).find(Boolean) || null,
  })
}

async function armEditorRebuildRetry() {
  const path = resolve(SDK_ROOT, RETRY_MODEL)
  const bytes = buildTriangleGlb('opaque')
  writeFileSync(path, bytes)
  const entity = runtime.spawnEntity('ed-retry', { model: RETRY_MODEL, position: [0, 10, 0], autoTrimesh: true })
  await drainBuilds()
  const firstBodyId = entity._physicsBodyId
  unlinkSync(path)
  editor.handle(MSG.EDITOR_UPDATE, { entityId: entity.id, changes: { scale: [2, 2, 2] } }, 1)
  await waitFor(() => entity._failedColliderType === 'trimesh')
  const failedBodyId = entity._physicsBodyId
  const failedCollider = describeCollider(entity)
  const failedType = entity._failedColliderType ?? null
  writeFileSync(path, bytes)
  editor.handle(MSG.EDITOR_UPDATE, { entityId: entity.id, changes: { scale: [3, 3, 3] } }, 1)
  const recovered = await waitFor(() => entity._physicsBodyId !== undefined)
  const retryRow = record({
    arm: 'editor.rebuild.retryAfterFailure',
    firstBodyId: firstBodyId === undefined ? 'undefined' : String(firstBodyId),
    failedBodyId: failedBodyId === undefined ? 'undefined' : String(failedBodyId),
    failedCollider,
    failedColliderType: failedType,
    retryBodyId: entity._physicsBodyId === undefined ? 'undefined' : String(entity._physicsBodyId),
    retryCollider: describeCollider(entity),
    recovered,
  })
  unlinkSync(path)
  return retryRow
}

async function armPendingSetIsolation() {
  await drainBuilds()
  const spawned = runtime.spawnEntity('ed-pending-good', { model: REAL_MODEL, position: [0, 10, 0], autoTrimesh: true })
  const worldLoadPending = runtime._pendingTrimeshBuilds.size
  await drainBuilds()
  await drainBuilds()
  const editorEntity = runtime.spawnEntity('ed-pending-rebuild', { model: REAL_MODEL, position: [0, 20, 0], autoTrimesh: true })
  await drainBuilds()
  editor.handle(MSG.EDITOR_UPDATE, { entityId: editorEntity.id, changes: { scale: [2, 2, 2] } }, 1)
  const editorRebuildPending = runtime._pendingTrimeshBuilds.size
  const rebuildSettled = await waitFor(() => editorEntity._physicsBodyId !== undefined)
  return record({
    arm: 'editor.rebuild.pendingSetIsolation',
    worldLoadPending,
    editorRebuildPending,
    rebuildSettled,
    spawnedBodyId: spawned._physicsBodyId === undefined ? 'undefined' : String(spawned._physicsBodyId),
    editorBodyId: editorEntity._physicsBodyId === undefined ? 'undefined' : String(editorEntity._physicsBodyId),
  })
}

async function armStageLoader() {
  const loader = new StageLoader(runtime)
  loader.loadFromDefinition('witness-collider-stage', {
    entities: [
      { id: 'sl-good', model: REAL_MODEL, position: [0, 10, 0] },
      { id: 'sl-bad', model: MISSING_MODEL, position: [0, 20, 0] },
    ],
  })
  await drainBuilds()
  const good = runtime.entities.get('sl-good')
  const bad = runtime.entities.get('sl-bad')
  return record({
    arm: 'stage.loadFromDefinition.worldStatics',
    goodCollider: good ? describeCollider(good) : 'missing',
    goodBodyId: !good || good._physicsBodyId === undefined ? 'undefined' : String(good._physicsBodyId),
    badCollider: bad ? describeCollider(bad) : 'missing',
    badFailedColliderType: bad?._failedColliderType ?? null,
    badBodyId: !bad || bad._physicsBodyId === undefined ? 'undefined' : String(bad._physicsBodyId),
  })
}

function glbFilesUnder(dir, acc = []) {
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const entry of entries) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) glbFilesUnder(full, acc)
    else if (entry.name.endsWith('.glb')) acc.push(full)
  }
  return acc
}

async function armShippedAssetsAreNotEmpty() {
  const files = glbFilesUnder(resolve(SDK_ROOT, 'apps/maps')).sort()
  let minTriangles = Infinity
  let empties = 0
  const failuresSeen = []
  for (const f of files) {
    try {
      const mesh = await extractAllMeshesFromGLBAsync(f)
      minTriangles = Math.min(minTriangles, mesh.triangleCount)
      if (mesh.triangleCount === 0) empties++
    } catch (e) {
      empties++
      failuresSeen.push(`${f}: ${e.message}`)
    }
  }
  return record({
    arm: 'shipped.mapAssets.emptyModelScan',
    files: files.length,
    minTriangles: minTriangles === Infinity ? null : minTriangles,
    empties,
    failures: failuresSeen,
  })
}

async function main() {
  const good = await armAppRuntimeAutoTrimesh('probe-good', REAL_MODEL)
  const bad = await armAppRuntimeAutoTrimesh('probe-bad', MISSING_MODEL)

  expect(good.collider === 'trimesh', 'real model keeps trimesh collider')
  expect(good.bodyId !== 'undefined', 'real model gets a trimesh body')
  expect(good.rejected === null, 'real model build does not reject')

  expect(bad.collider === 'none', 'missing model leaves no collider instead of a box')
  expect(bad.failedColliderType === 'trimesh', 'missing model records the collider type it failed to build')
  expect(bad.bodyId === 'undefined', 'missing model gets no physics body')
  expect(!bad.boxFallback, 'missing model does not broadcast a box fallback')
  expect(/ENOENT|no such file/i.test(bad.detail || ''), 'missing model broadcasts its real cause')
  expect(bad.rejected?.name === 'ColliderBuildError', 'missing model propagates ColliderBuildError')
  expect(/trimesh collider for entity probe-bad/.test(bad.rejected?.message || ''), 'propagated error names the entity')

  const emptyModel = await armAppRuntimeAutoTrimesh('probe-empty', INSIDE_EMPTY_MODEL)
  expect(emptyModel.collider === 'none', 'zero-collidable-geometry model leaves no collider instead of a box')
  expect(emptyModel.bodyId === 'undefined', 'zero-collidable-geometry model gets no physics body')
  expect(emptyModel.rejected?.name === 'ColliderBuildError', 'zero-collidable-geometry model propagates ColliderBuildError')
  expect(/No valid mesh primitives/.test(emptyModel.rejected?.message || ''), 'zero-collidable-geometry model names its cause')

  const outsideRoot = await armAppRuntimeAutoTrimesh('probe-outside-root', OUTSIDE_ROOT_MODEL)
  expect(outsideRoot.collider === 'none', 'model outside the server root leaves no collider instead of a box')
  expect(outsideRoot.bodyId === 'undefined', 'model outside the server root gets no physics body')
  expect(outsideRoot.rejected?.name === 'ColliderBuildError', 'model outside the server root propagates ColliderBuildError')
  expect(/no glbPath/.test(outsideRoot.rejected?.message || ''), 'model outside the server root names the rejection')

  const placeGood = await armPlaceModel('good', REAL_MODEL)
  expect(placeGood.collider === 'trimesh', 'PLACE_MODEL of a real model keeps a trimesh collider')
  expect(placeGood.bodyId !== 'undefined', 'PLACE_MODEL of a real model gets a body')

  const placeBad = await armPlaceModel('bad', MISSING_MODEL)
  expect(placeBad.collider === 'none', 'PLACE_MODEL of a missing model leaves no collider instead of a box')
  expect(placeBad.bodyId === 'undefined', 'PLACE_MODEL of a missing model gets no physics body')
  expect(!placeBad.boxFallback, 'PLACE_MODEL of a missing model does not announce a box fallback')

  const edGood = await armEditorRebuild('ed-good', REAL_MODEL, 'trimesh')
  expect(edGood.collider === 'trimesh', 'editor trimesh rebuild of a real model keeps trimesh')
  expect(edGood.bodyId !== 'undefined', 'editor trimesh rebuild of a real model gets a body')

  const edBadTrimesh = await armEditorRebuild('ed-bad-trimesh', MISSING_MODEL, 'trimesh')
  expect(edBadTrimesh.collider === 'none', 'editor trimesh failure leaves no collider')
  expect(edBadTrimesh.failedColliderType === 'trimesh', 'editor trimesh failure records trimesh as the failed type')
  expect(edBadTrimesh.bodyId === 'undefined', 'editor trimesh failure leaves no body')
  expect(/ENOENT|no such file/i.test(edBadTrimesh.detail || ''), 'editor trimesh failure reports its real cause')

  const edBadConvex = await armEditorRebuild('ed-bad-convex', MISSING_MODEL, 'convex')
  expect(edBadConvex.collider === 'none', 'editor convex failure leaves no collider')
  expect(edBadConvex.failedColliderType === 'convex', 'editor convex failure records convex as the failed type')
  expect(edBadConvex.bodyId === 'undefined', 'editor convex failure leaves no body')
  expect(/ENOENT|no such file/i.test(edBadConvex.detail || ''), 'editor convex failure reports its real cause')

  const stage = await armStageLoader()
  expect(stage.goodCollider === 'trimesh', 'stage-loaded world static with a real model keeps trimesh')
  expect(stage.goodBodyId !== 'undefined', 'stage-loaded world static with a real model gets a body')
  expect(stage.badCollider === 'none', 'stage-loaded world static with a missing model leaves no collider')
  expect(stage.badFailedColliderType === 'trimesh', 'stage-loaded world static records trimesh as the failed type')
  expect(stage.badBodyId === 'undefined', 'stage-loaded world static with a missing model gets no body')

  const retry = await armEditorRebuildRetry()
  expect(retry.firstBodyId !== 'undefined', 'retry arm starts from a real trimesh body')
  expect(retry.failedBodyId === 'undefined', 'deleting the model file strips the body on rebuild')
  expect(retry.failedCollider === 'none', 'a failed rebuild leaves no collider')
  expect(retry.failedColliderType === 'trimesh', 'a failed rebuild records trimesh as the failed type')
  expect(retry.recovered === true, 'restoring the model file rebuilds the collider on the next EDITOR_UPDATE')
  expect(retry.retryBodyId !== 'undefined', 'the retried rebuild produces a real body')
  expect(retry.retryCollider === 'trimesh', 'the retried rebuild restores the trimesh collider')

  const pending = await armPendingSetIsolation()
  expect(pending.worldLoadPending >= 1, 'a world-load trimesh build is still tracked as pending')
  expect(pending.editorRebuildPending === 0, 'an editor rebuild does not gate spawn grounding via _pendingTrimeshBuilds')
  expect(pending.rebuildSettled === true, 'the untracked editor rebuild still completes')
  expect(pending.editorBodyId !== 'undefined', 'the untracked editor rebuild still produces a body')

  const assets = await armShippedAssetsAreNotEmpty()
  expect(assets.files > 0, 'shipped map assets scanned')
  expect(assets.empties === 0, 'no shipped map asset is a legitimately empty model')

  const boxAnnouncements = editorErrors().filter(p => /box collider fallback|falling back to box/i.test(`${p.message || ''} ${p.detail || ''}`))
  expect(boxAnnouncements.length === 0, 'no box fallback is announced anywhere')

  console.log(`--- collider-build-failure-witness ${LABEL} ---`)
  for (const row of rows) console.log(JSON.stringify(row))
  console.log(`RESULT: ${failures.length === 0 ? 'PASS' : 'FAIL'}`)
  if (failures.length) for (const f of failures) console.log(`FAILED: ${f}`)
  if (OUT) writeFileSync(OUT, JSON.stringify({ label: LABEL, rows, failures, ok: failures.length === 0 }, null, 2))
  for (const p of [resolve(SDK_ROOT, INSIDE_EMPTY_MODEL), OUTSIDE_ROOT_MODEL]) {
    try { unlinkSync(p) } catch {}
  }
  return failures.length === 0 ? 0 : 1
}

const code = await main()
for (let i = 0; i < 200; i++) {
  const n = typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : 0
  if (n <= 2) break
  await new Promise(r => setTimeout(r, 10))
}
process.exit(code)
