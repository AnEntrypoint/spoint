// Witness: the four prop collider states and the 1 -> 2 -> 3 chain on ONE prop.
//
// 1. add a prop             -> it has a collider at all
// 2. make it a CONVEX HULL  -> it has a convex collider
// 3. make it DYNAMIC        -> it actually simulates (gravity, displacement)
// 4. made NEITHER of those  -> it actually provides a TRIMESH STATIC collider
//
// Plus the negatives: a trimesh static prop must not be a box, and a refusal or
// a build failure must never silently become one.
//
// Driven through the real editor path: PLACE_MODEL / EDITOR_UPDATE handled by
// createEditorHandlers over a real AppRuntime over a real PhysicsWorld (Jolt).

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { PhysicsWorld } from '../src/physics/World.js'
import { MSG } from '../src/protocol/MessageTypes.js'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const eq = a.indexOf('=')
  return eq < 0 ? [a.replace(/^--/, ''), 'true'] : [a.slice(2, eq), a.slice(eq + 1)]
}))

const REAL_MAP_MODEL = './apps/maps/aim_sillos.glb'
const MISSING_MODEL = './apps/maps/definitely-not-a-prop.glb'
const CUBE_MODEL = './.gm/scratch/prop-lifecycle-cube.glb'

function buildCubeGlb() {
  const v = [
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
  ]
  const idx = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]
  const vBytes = Buffer.alloc(v.length * 4)
  v.forEach((x, i) => vBytes.writeFloatLE(x, i * 4))
  const iBytes = Buffer.alloc(idx.length * 4)
  idx.forEach((x, i) => iBytes.writeUInt32LE(x, i * 4))
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ name: 'prop-cube', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: v.length / 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5125, count: idx.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: vBytes.length },
      { buffer: 0, byteOffset: vBytes.length, byteLength: iBytes.length },
    ],
    buffers: [{ byteLength: vBytes.length + iBytes.length }],
  }
  let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8')
  const pad = (4 - (jsonBytes.length % 4)) % 4
  if (pad) jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(pad, 0x20)])
  const bin = Buffer.concat([vBytes, iBytes])
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
rmSync(resolve(SDK_ROOT, CUBE_MODEL), { force: true })
writeFileSync(resolve(SDK_ROOT, CUBE_MODEL), buildCubeGlb())

// --mutate=<name> rewrites one source file into a sibling mutant and runs the arms
// against THAT module, so each arm can be shown to go red when the property it pins
// is broken. A mutant lives beside its original so its relative imports still
// resolve, and it is removed on exit.
const MUTANT = {
  'trimesh-to-box': { file: 'src/sdk/EditorHandlers.js', steps: [{ find: "if (type === 'trimesh' && entity.model) {", replace: 'if (false) {' }] },
  'convex-to-box': { file: 'src/sdk/EditorHandlers.js', steps: [{ find: "finish(ctx.physics.addBody('convex', points, entity.position, motion,", replace: "finish(ctx.physics.addBody('box', [0.5, 0.5, 0.5], entity.position, motion," }] },
  'no-rebuild-on-collider-change': { file: 'src/sdk/EditorHandlers.js', steps: [{ find: 'if (colliderChanged || scaleChanged) { rebuildEntityCollider(entity); return }', replace: 'if (scaleChanged) { rebuildEntityCollider(entity); return }' }] },
  'runtime-place-trimesh-to-box': { file: 'src/apps/AppRuntime.js', steps: [{ find: '&& this._physics) this._startTrimeshBuild(entityId, entity)', replace: "&& this._physics) { entity.collider = { type: 'box', size: [0.5, 0.5, 0.5] }; this._admitEntityBody(entity, entityId, { shapeType: 'box', params: [0.5, 0.5, 0.5], motionType: 'static', opts: {} }) }" }] },
  'runtime-build-failure-to-box': { file: 'src/apps/AppRuntime.js', steps: [{ find: "entity.collider = null\n        entity._failedColliderType = 'trimesh'", replace: "entity.collider = { type: 'box', size: [0.5, 0.5, 0.5] }\n        this._admitEntityBody(entity, entityId, { shapeType: 'box', params: [0.5, 0.5, 0.5], motionType: 'static', opts: {} })" }] },
  'refusals-removed': { file: 'src/sdk/EditorHandlers.js', steps: [{ find: "if (type === 'trimesh' || type === 'convex') {", replace: 'if (false) {' }] },
  'refusal-to-box': {
    file: 'src/sdk/EditorHandlers.js',
    steps: [
      { find: 'if (!entity.model) return refuseCollider(', replace: 'if (!entity.model) { toBox(); return }; void refuseCollider(' },
      { find: "if (type === 'trimesh' && motion !== 'static') return refuseCollider(", replace: "if (type === 'trimesh' && motion !== 'static') { toBox(); return }; void refuseCollider(" },
    ],
  },
  'runtime-convex-static': { file: 'src/apps/AppRuntime.js', steps: [{ find: 'params: points, motionType: mt, opts', replace: "params: points, motionType: 'static', opts" }] },
  'runtime-trimesh-for-dynamic': { file: 'src/apps/AppRuntime.js', steps: [{ find: 'if (modelShaped) { this._startConvexBuild(entityId, entity, mt); return }', replace: 'if (modelShaped) { this._startTrimeshBuild(entityId, entity); return }' }] },
}
const MUTANT_PATHS = []
let editorModule = '../src/sdk/EditorHandlers.js'
let runtimeModule = '../src/apps/AppRuntime.js'
if (args.mutate && args.mutate !== 'true') {
  const m = MUTANT[args.mutate]
  if (!m) { console.error(`[prop-collider] unknown mutant ${args.mutate}; known: ${Object.keys(MUTANT).join(', ')}`); process.exit(2) }
  const { readFileSync } = await import('node:fs')
  let src = readFileSync(resolve(SDK_ROOT, m.file), 'utf8')
  for (const step of m.steps) {
    if (!src.includes(step.find)) { console.error(`[prop-collider] mutant ${args.mutate} anchor not found in ${m.file}: ${step.find}`); process.exit(2) }
    src = src.replace(step.find, step.replace)
  }
  const dir = dirname(resolve(SDK_ROOT, m.file))
  const base = m.file.replace(/.*[/\\]/, '').replace(/\.js$/, '')
  const mutantPath = resolve(dir, `prop-collider-mutant-${base}.mjs`)
  writeFileSync(mutantPath, src)
  MUTANT_PATHS.push(mutantPath)
  if (m.file.endsWith('EditorHandlers.js')) editorModule = '../src/sdk/prop-collider-mutant-EditorHandlers.mjs'
  else runtimeModule = '../src/apps/prop-collider-mutant-AppRuntime.mjs'
}
const { AppRuntime } = await import(runtimeModule)
const { createEditorHandlers } = await import(editorModule)

function cleanupMutant() {
  for (const p of MUTANT_PATHS) { try { rmSync(p) } catch { /* already gone */ } }
}
process.on('exit', cleanupMutant)

const failures = []
const rows = []

function expect(cond, label) {
  if (!cond) failures.push(label)
  return cond
}

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

async function drain() {
  await runtime.waitForPendingTrimeshBuilds(30000)
  await new Promise(r => setTimeout(r, 40))
  await runtime.waitForPendingTrimeshBuilds(30000)
  await new Promise(r => setTimeout(r, 40))
}

async function waitFor(matches, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (matches()) return true
    await new Promise(r => setTimeout(r, 10))
  }
  return matches()
}

function bodyOf(entity) {
  const id = entity._physicsBodyId
  if (id === undefined) return { id: 'undefined', shape: 'none', motion: 'none', active: false }
  const meta = physics.bodyMeta.get(id) || {}
  return { id: String(id), shape: meta.shape ?? 'unknown', motion: meta.type ?? 'unknown', active: physics.isBodyActive(id) }
}

function colliderOf(entity) {
  if (!entity.collider) return 'none'
  return entity.collider.type === 'box' ? `box ${JSON.stringify(entity.collider.size)}` : entity.collider.type
}

function editorErrors() {
  return connections.broadcasts.filter(b => b.type === MSG.EDITOR_ERROR).map(b => b.payload)
}

function record(row) {
  rows.push(row)
  console.log(JSON.stringify(row))
  return row
}

function placeModel(url) {
  const before = connections.sends.length
  editor.handle(MSG.PLACE_MODEL, { url, position: [0, 20, 0] }, 1)
  const selected = connections.sends.slice(before).filter(s => s.type === MSG.EDITOR_SELECT).pop()
  return runtime.entities.get(selected?.payload?.entityId)
}

function update(entityId, changes) {
  editor.handle(MSG.EDITOR_UPDATE, { entityId, changes }, 1)
}

// ---------------------------------------------------------------- state 1 + 4

const propA = placeModel(CUBE_MODEL)
await drain()
const b1 = bodyOf(propA)
record({
  arm: 'state1.placeModelHasACollider',
  model: CUBE_MODEL,
  bodyId: b1.id,
  shape: b1.shape,
  motion: b1.motion,
  active: b1.active,
  collider: colliderOf(propA),
})
expect(b1.id !== 'undefined', 'state1: placed prop has no physics body at all')
expect(b1.shape === 'trimesh', `state1: placed prop shape is ${b1.shape}, expected trimesh`)
expect(b1.motion === 'static', `state1: placed prop motion is ${b1.motion}, expected static`)
expect(colliderOf(propA) === 'trimesh', `state1: placed prop collider is ${colliderOf(propA)}, expected trimesh`)

const mapProp = placeModel(REAL_MAP_MODEL)
await drain()
const b4 = bodyOf(mapProp)
const mapUpdateErrors0 = editorErrors().length
update(mapProp.id, { custom: { _collider: 'trimesh' } })
await waitFor(() => (mapProp._physicsBodyId !== undefined && bodyOf(mapProp).id !== b4.id) || mapProp._failedColliderType !== null)
await drain()
const b4b = bodyOf(mapProp)
record({
  arm: 'state4.neitherIsTrimeshStatic',
  model: REAL_MAP_MODEL,
  bodyIdAfterPlace: b4.id,
  shapeAfterPlace: b4.shape,
  bodyIdAfterExplicitTrimesh: b4b.id,
  shape: b4b.shape,
  motion: b4b.motion,
  collider: colliderOf(mapProp),
  editorErrorCount: editorErrors().length - mapUpdateErrors0,
})
expect(b4.shape === 'trimesh' && b4.motion === 'static', `state4: placed map prop is ${b4.shape}/${b4.motion}, expected trimesh/static`)
expect(b4b.shape === 'trimesh', `state4: explicit trimesh gave shape ${b4b.shape}, expected trimesh`)
expect(b4b.motion === 'static', `state4: explicit trimesh gave motion ${b4b.motion}, expected static`)
expect(b4b.shape !== 'box', 'state4: neither-convex-nor-dynamic degraded to a box')

// ------------------------------------------------------------ chain 2 then 3

const beforeConvex = bodyOf(propA)
update(propA.id, { custom: { _collider: 'convex' } })
await waitFor(() => propA._physicsBodyId !== undefined && bodyOf(propA).id !== beforeConvex.id)
await drain()
const b2 = bodyOf(propA)
record({
  arm: 'state2.convexHull',
  bodyIdBefore: beforeConvex.id,
  bodyId: b2.id,
  shape: b2.shape,
  motion: b2.motion,
  collider: colliderOf(propA),
  bodyIdChanged: b2.id !== beforeConvex.id,
})
expect(b2.shape === 'convex', `state2: convex hull gave shape ${b2.shape}, expected convex`)
expect(colliderOf(propA) === 'convex', `state2: collider is ${colliderOf(propA)}, expected convex`)
expect(b2.id !== beforeConvex.id, 'state2: convex hull reused the trimesh body id, so no rebuild happened')

update(propA.id, { bodyType: 'dynamic' })
await waitFor(() => propA._physicsBodyId !== undefined && bodyOf(propA).id !== b2.id)
await drain()
const b3 = bodyOf(propA)
const y0 = physics.getBodyPosition(propA._physicsBodyId)[1]
for (let i = 0; i < 90; i++) physics.step(1 / 60)
const y1 = physics.getBodyPosition(propA._physicsBodyId)[1]
const fell = y0 - y1
record({
  arm: 'state3.dynamicSimulates',
  bodyIdBefore: b2.id,
  bodyId: b3.id,
  shape: b3.shape,
  motion: b3.motion,
  active: b3.active,
  bodyType: propA.bodyType,
  fellMetres: Number(fell.toFixed(4)),
  activeDynamic: runtime._activeDynamicIds.has(propA.id),
})
expect(propA.bodyType === 'dynamic', `state3: entity bodyType is ${propA.bodyType}, expected dynamic`)
expect(b3.motion === 'dynamic', `state3: body motion is ${b3.motion}, expected dynamic`)
expect(b3.shape === 'convex', `state3: dynamic body shape is ${b3.shape}, expected convex`)
expect(b3.active === true, 'state3: dynamic body IsActive() is false, so it will never simulate')
expect(fell > 1, `state3: dynamic body fell ${fell.toFixed(4)} m over 90 steps, expected > 1 m of gravity`)

// ------------------------------------------------------------------ negatives

const propB = placeModel(CUBE_MODEL)
await drain()
const bBox = bodyOf(propB)
propB.model = null
update(propB.id, { custom: { _collider: 'trimesh' } })
await drain()
const bNoModel = bodyOf(propB)
const noModelErrors = editorErrors().filter(p => p.entityId === propB.id)
record({
  arm: 'negative.trimeshWithoutModelIsNotABox',
  bodyIdBefore: bBox.id,
  bodyId: bNoModel.id,
  shape: bNoModel.shape,
  collider: colliderOf(propB),
  failedColliderType: propB._failedColliderType ?? null,
  editorErrors: noModelErrors.length,
})
expect(bNoModel.shape !== 'box', `negative: trimesh with no model produced a ${bNoModel.shape} body, so the prop silently became a box`)
expect(!colliderOf(propB).startsWith('box'), `negative: trimesh with no model left collider ${colliderOf(propB)}`)
expect(propB._failedColliderType === 'trimesh', `negative: trimesh with no model set _failedColliderType ${propB._failedColliderType}, expected trimesh`)

const propC = placeModel(CUBE_MODEL)
await drain()
propC.model = null
update(propC.id, { custom: { _collider: 'convex' } })
await drain()
const bConvexNoModel = bodyOf(propC)
record({
  arm: 'negative.convexWithoutModelIsNotABox',
  bodyId: bConvexNoModel.id,
  shape: bConvexNoModel.shape,
  collider: colliderOf(propC),
  failedColliderType: propC._failedColliderType ?? null,
})
expect(bConvexNoModel.shape !== 'box', `negative: convex with no model produced a ${bConvexNoModel.shape} body`)
expect(!colliderOf(propC).startsWith('box'), `negative: convex with no model left collider ${colliderOf(propC)}`)
expect(propC._failedColliderType === 'convex', `negative: convex with no model set _failedColliderType ${propC._failedColliderType}, expected convex`)

const errsBefore = editorErrors().length
const broken = placeModel(MISSING_MODEL)
await drain()
const bBroken = bodyOf(broken)
const brokenErrors = editorErrors().slice(errsBefore)
record({
  arm: 'negative.trimeshBuildFailureIsNotABox',
  model: MISSING_MODEL,
  bodyId: bBroken.id,
  shape: bBroken.shape,
  collider: colliderOf(broken),
  failedColliderType: broken._failedColliderType ?? null,
  editorErrors: brokenErrors.length,
  detail: brokenErrors.map(p => p.detail).find(Boolean) || null,
})
expect(bBroken.shape !== 'box', `negative: a failed trimesh build produced a ${bBroken.shape} body`)
expect(bBroken.id === 'undefined', `negative: a failed trimesh build still handed out body ${bBroken.id}`)
expect(broken._failedColliderType === 'trimesh', `negative: a failed trimesh build set _failedColliderType ${broken._failedColliderType}, expected trimesh`)
expect(brokenErrors.length > 0, 'negative: a failed trimesh build broadcast no EDITOR_ERROR')

// a convex hull requested on an already-dynamic prop must stay dynamic: the editor
// rebuild is the one path that used to force 'static' no matter what the prop was
const propD = placeModel(CUBE_MODEL)
await drain()
update(propD.id, { bodyType: 'dynamic' })
await waitFor(() => propD._physicsBodyId !== undefined)
await drain()
const bdynBefore = bodyOf(propD)
update(propD.id, { custom: { _collider: 'convex' } })
await waitFor(() => propD._physicsBodyId !== undefined && bodyOf(propD).id !== bdynBefore.id)
await drain()
const bdyn = bodyOf(propD)
const yc0 = physics.getBodyPosition(propD._physicsBodyId)[1]
for (let i = 0; i < 90; i++) physics.step(1 / 60)
const yc1 = physics.getBodyPosition(propD._physicsBodyId)[1]
record({
  arm: 'state2.convexOnAlreadyDynamicStaysDynamic',
  bodyIdBefore: bdynBefore.id,
  bodyId: bdyn.id,
  shape: bdyn.shape,
  motion: bdyn.motion,
  active: bdyn.active,
  bodyType: propD.bodyType,
  fellMetres: Number((yc0 - yc1).toFixed(4)),
})
expect(propD.bodyType === 'dynamic', `state2: entity bodyType is ${propD.bodyType}, expected dynamic`)
expect(bdyn.shape === 'convex', `state2: convex on a dynamic prop gave shape ${bdyn.shape}, expected convex`)
expect(bdyn.motion === 'dynamic', `state2: convex on a dynamic prop gave motion ${bdyn.motion}, expected dynamic`)
expect(bdyn.active === true, 'state2: convex on a dynamic prop produced an inactive body')
expect(yc0 - yc1 > 1, `state2: convex on a dynamic prop fell only ${(yc0 - yc1).toFixed(4)} m`)

// a trimesh request on an already-dynamic prop must not silently become a static
// trimesh that never simulates: it is refused, loudly, and leaves no collider
const errsBeforeDynTri = editorErrors().length
update(propA.id, { custom: { _collider: 'trimesh' } })
await drain()
const bDynTri = bodyOf(propA)
const dynTriErrors = editorErrors().slice(errsBeforeDynTri).filter(p => p.entityId === propA.id)
record({
  arm: 'negative.dynamicTrimeshIsNotASilentStatic',
  bodyId: bDynTri.id,
  shape: bDynTri.shape,
  motion: bDynTri.motion,
  active: bDynTri.active,
  bodyType: propA.bodyType,
  collider: colliderOf(propA),
  failedColliderType: propA._failedColliderType ?? null,
  editorErrors: dynTriErrors.length,
})
expect(bDynTri.shape !== 'trimesh', 'negative: a dynamic prop requesting trimesh got a trimesh body, which Jolt cannot simulate')
expect(bDynTri.shape !== 'box', `negative: a dynamic prop requesting trimesh degraded to a ${bDynTri.shape} body`)
expect(bDynTri.id === 'undefined', `negative: a dynamic prop requesting trimesh still holds body ${bDynTri.id}`)
expect(propA._failedColliderType === 'trimesh', `negative: a dynamic prop requesting trimesh set _failedColliderType ${propA._failedColliderType}, expected trimesh`)
expect(dynTriErrors.length > 0, 'negative: a dynamic prop requesting trimesh reported nothing')

const total = rows.length
const tag = args.mutate && args.mutate !== 'true' ? ` MUTANT ${args.mutate}` : ''
if (failures.length) {
  console.log(`[prop-collider] RESULT: FAIL (${failures.length} failure(s) over ${total} arm(s))${tag}`)
  for (const f of failures) console.log(`[prop-collider] [FAIL] ${f}`)
  process.exit(1)
}
console.log(`[prop-collider] RESULT: PASS ${total}/${total}${tag}`)
