/**
 * Comprehensive test suite for physics, netcode, and map collision.
 * Run: node test-suite.mjs
 */

// ─── Tiny test framework ───────────────────────────────────────────────────
let pass = 0, fail = 0
const results = []
function assert(cond, msg) { if (!cond) throw new Error(`${msg}`) }
function assertNear(a, b, eps = 0.01, msg = '') {
  if (Math.abs(a - b) > eps) throw new Error(`${msg}: got ${a.toFixed(4)}, expected ~${b} (eps=${eps})`)
}
async function test(name, fn) {
  try { await fn(); pass++; results.push({ name, ok: true }); process.stdout.write('.') }
  catch (e) { fail++; results.push({ name, ok: false, err: e.message }); process.stdout.write('F') }
}
function section(s) { console.log(`\n\n── ${s} ──`) }
function log(s) { process.stdout.write(`\n  ${s}`) }

// ─── SECTION 1: GLBLoader ─────────────────────────────────────────────────
section('GLBLoader')
const GLBLoader = await import('./src/physics/GLBLoader.js')
const { extractAllMeshesFromGLBAsync, detectDracoInGLB } = GLBLoader

await test('detectDracoInGLB: aim_kosova → draco=true, meshopt=false', () => {
  const r = detectDracoInGLB('apps/maps/aim_kosova_ak47.glb')
  assert(r.hasDraco === true, `hasDraco should be true, got ${r.hasDraco}`)
  assert(r.hasMeshopt === false, `hasMeshopt should be false, got ${r.hasMeshopt}`)
  assert(r.meshes.length > 10, `expected many meshes, got ${r.meshes.length}`)
})

await test('detectDracoInGLB: non-GLB returns safe defaults', () => {
  const r = detectDracoInGLB('package.json')
  assert(r.hasDraco === false, 'non-GLB hasDraco should be false')
})

await test('extractAllMeshesFromGLBAsync: returns correct types', async () => {
  const r = await extractAllMeshesFromGLBAsync('apps/maps/aim_kosova_ak47.glb')
  assert(r.vertices instanceof Float32Array, 'vertices must be Float32Array')
  assert(r.indices instanceof Uint32Array, 'indices must be Uint32Array')
  assert(typeof r.vertexCount === 'number', 'vertexCount must be number')
  assert(typeof r.triangleCount === 'number', 'triangleCount must be number')
})

await test('extractAllMeshesFromGLBAsync: buffer lengths match counts', async () => {
  const r = await extractAllMeshesFromGLBAsync('apps/maps/aim_kosova_ak47.glb')
  assert(r.vertices.length === r.vertexCount * 3, `vertices.length=${r.vertices.length} != vertexCount*3=${r.vertexCount*3}`)
  assert(r.indices.length === r.triangleCount * 3, `indices.length=${r.indices.length} != triangleCount*3=${r.triangleCount*3}`)
})

await test('extractAllMeshesFromGLBAsync: aim_kosova covers all 83 primitives (>1 prim worth)', async () => {
  const r = await extractAllMeshesFromGLBAsync('apps/maps/aim_kosova_ak47.glb')
  log(`aim_kosova: ${r.vertexCount} verts, ${r.triangleCount} tris from 83 primitives`)
  assert(r.vertexCount > 10000, `vertexCount ${r.vertexCount} too low — only getting 1 primitive?`)
  assert(r.triangleCount > 5000, `triangleCount ${r.triangleCount} too low — only getting 1 primitive?`)
})

await test('extractAllMeshesFromGLBAsync: de_dust2 covers all 99 primitives', async () => {
  const r = await extractAllMeshesFromGLBAsync('apps/maps/de_dust2_kosovo.glb')
  log(`de_dust2: ${r.vertexCount} verts, ${r.triangleCount} tris`)
  assert(r.vertexCount > 15000, `vertexCount ${r.vertexCount} suspiciously low`)
  assert(r.triangleCount > 8000, `triangleCount ${r.triangleCount} suspiciously low`)
})

await test('extractAllMeshesFromGLBAsync: no index out of bounds', async () => {
  const r = await extractAllMeshesFromGLBAsync('apps/maps/aim_kosova_ak47.glb')
  let maxIdx = 0
  for (let i = 0; i < r.indices.length; i++) if (r.indices[i] > maxIdx) maxIdx = r.indices[i]
  assert(maxIdx < r.vertexCount, `Max index ${maxIdx} >= vertexCount ${r.vertexCount} (OOB!)`)
})

await test('extractAllMeshesFromGLBAsync: no NaN or Inf vertices', async () => {
  const r = await extractAllMeshesFromGLBAsync('apps/maps/aim_kosova_ak47.glb')
  let bad = 0
  for (let i = 0; i < r.vertices.length; i++) if (!isFinite(r.vertices[i])) bad++
  assert(bad === 0, `Found ${bad} NaN/Inf in vertex buffer`)
})

await test('extractAllMeshesFromGLBAsync: vertex scale is plausible (meters, not mm or km)', async () => {
  const r = await extractAllMeshesFromGLBAsync('apps/maps/aim_kosova_ak47.glb')
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < r.vertexCount; i++) {
    const x = r.vertices[i*3], y = r.vertices[i*3+1]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  const spanX = maxX - minX, spanY = maxY - minY
  log(`aim_kosova bounds: X[${minX.toFixed(1)}, ${maxX.toFixed(1)}] Y[${minY.toFixed(1)}, ${maxY.toFixed(1)}]`)
  assert(spanX > 5 && spanX < 2000, `X span ${spanX.toFixed(1)}m out of plausible range`)
  assert(spanY > 1 && spanY < 200, `Y span ${spanY.toFixed(1)}m out of plausible range`)
})

await test('extractAllMeshesFromGLBAsync: all 5 maps extract cleanly', async () => {
  const maps = [
    'apps/maps/aim_kosova_ak47.glb',
    'apps/maps/aim_sillos.glb',
    'apps/maps/de_dust2_kosovo.glb',
    'apps/maps/de_gash.glb',
    'apps/maps/fy_osama_house.glb',
  ]
  for (const m of maps) {
    const r = await extractAllMeshesFromGLBAsync(m)
    assert(r.triangleCount > 0, `${m}: zero triangles`)
    assert(r.vertexCount > 0, `${m}: zero vertices`)
    log(`${m.split('/').pop()}: ${r.triangleCount} tris, ${r.vertexCount} verts`)
  }
})

// ─── SECTION 2: SnapshotEncoder ────────────────────────────────────────────
section('SnapshotEncoder')
const { SnapshotEncoder } = await import('./src/netcode/SnapshotEncoder.js')

const mkPlayer = (id, x=1, y=2, z=3) => ({
  id, position: [x, y, z], rotation: [0, 0, 0, 1],
  velocity: [0.5, -1, 0.25], onGround: true, health: 75,
  inputSequence: 42, crouch: 0, lookPitch: 0.3, lookYaw: 1.2
})
const mkEntity = (id, x=5, y=0, z=5) => ({
  id, model: './apps/maps/aim.glb', position: [x, y, z],
  rotation: [0, 0, 0, 1], bodyType: 'static', custom: { hp: 100 }
})

await test('encode→decode roundtrips player fields', () => {
  const enc = SnapshotEncoder.encode({ tick: 7, timestamp: 0, players: [mkPlayer('p1')], entities: [] })
  const dec = SnapshotEncoder.decode(enc)
  const p = dec.players[0]
  assertNear(p.position[0], 1, 0.02, 'x')
  assertNear(p.position[1], 2, 0.02, 'y')
  assertNear(p.position[2], 3, 0.02, 'z')
  assert(p.onGround === true, 'onGround')
  assertNear(p.health, 75, 0.5, 'health')
})

await test('encode→decode roundtrips entity fields', () => {
  const enc = SnapshotEncoder.encode({ tick: 1, timestamp: 0, players: [], entities: [mkEntity('env1')] })
  const dec = SnapshotEncoder.decode(enc)
  const e = dec.entities[0]
  assert(e.id === 'env1', `id: ${e.id}`)
  assertNear(e.position[0], 5, 0.02, 'entity x')
  assert(e.bodyType === 'static', `bodyType: ${e.bodyType}`)
})

await test('encodeDelta with empty prev sends all entities', () => {
  const snap = { tick: 1, timestamp: 0, players: [], entities: [mkEntity('e1'), mkEntity('e2', 10, 0, 10)] }
  const { encoded, entityMap } = SnapshotEncoder.encodeDelta(snap, new Map())
  assert(encoded.delta === 1, 'should be delta=1')
  assert(encoded.entities.length === 2, `all entities on first delta, got ${encoded.entities.length}`)
  assert(entityMap.size === 2, `entityMap size ${entityMap.size}`)
  assert(!encoded.removed || encoded.removed.length === 0, 'no removals on first send')
})

await test('encodeDelta suppresses unchanged entities', () => {
  const snap = { tick: 1, timestamp: 0, players: [], entities: [mkEntity('e1'), mkEntity('e2')] }
  const { entityMap: m1 } = SnapshotEncoder.encodeDelta(snap, new Map())
  const snap2 = { ...snap, entities: [mkEntity('e1'), mkEntity('e2', 99, 0, 99)] }
  const { encoded } = SnapshotEncoder.encodeDelta(snap2, m1)
  assert(encoded.entities.length === 1, `only changed entity sent, got ${encoded.entities.length}`)
  const dec = SnapshotEncoder.decode(encoded)
  assertNear(dec.entities[0].position[0], 99, 0.02, 'moved entity x')
})

await test('encodeDelta tracks removed entities', () => {
  const snap = { tick: 1, timestamp: 0, players: [], entities: [mkEntity('e1'), mkEntity('e2')] }
  const { entityMap: m1 } = SnapshotEncoder.encodeDelta(snap, new Map())
  const { encoded } = SnapshotEncoder.encodeDelta({ ...snap, entities: [mkEntity('e1')] }, m1)
  assert(encoded.removed && encoded.removed.includes('e2'), `e2 not in removed: ${JSON.stringify(encoded.removed)}`)
})

await test('encodeDelta handles entity returning after removal', () => {
  const snap = { tick: 1, timestamp: 0, players: [], entities: [mkEntity('e1'), mkEntity('e2')] }
  const { entityMap: m1 } = SnapshotEncoder.encodeDelta(snap, new Map())
  const { entityMap: m2 } = SnapshotEncoder.encodeDelta({ ...snap, entities: [mkEntity('e1')] }, m1)
  // e2 returns
  const { encoded } = SnapshotEncoder.encodeDelta(snap, m2)
  const dec = SnapshotEncoder.decode(encoded)
  assert(dec.entities.some(e => e.id === 'e2'), 'e2 should reappear')
})

await test('position quantization maintains sub-centimeter precision', () => {
  const p = mkPlayer('p1', 1.23456, -0.00001, 999.9999)
  const enc = SnapshotEncoder.encode({ tick: 1, timestamp: 0, players: [p], entities: [] })
  const dec = SnapshotEncoder.decode(enc)
  assertNear(dec.players[0].position[0], 1.23456, 0.01, 'x precision')
  assertNear(dec.players[0].position[1], -0.00001, 0.01, 'y precision')
  assertNear(dec.players[0].position[2], 999.9999, 0.01, 'z precision')
})

await test('encode handles 100 players without error', () => {
  const players = Array.from({ length: 100 }, (_, i) => mkPlayer(`p${i}`, i, 1, i))
  const enc = SnapshotEncoder.encode({ tick: 999, timestamp: 0, players, entities: [] })
  assert(enc.players.length === 100, `got ${enc.players.length} players`)
  const dec = SnapshotEncoder.decode(enc)
  assert(dec.players.length === 100, 'decoded 100 players')
})

await test('encode handles 1000 entities without error', () => {
  const entities = Array.from({ length: 1000 }, (_, i) => mkEntity(`e${i}`, i % 100, 0, Math.floor(i/100)))
  const enc = SnapshotEncoder.encode({ tick: 1, timestamp: 0, players: [], entities })
  assert(enc.entities.length === 1000, `got ${enc.entities.length} entities`)
})

await test('perf: 100 players × 128 ticks encode < 200ms', () => {
  const players = Array.from({ length: 100 }, (_, i) => mkPlayer(`p${i}`, i, 1, i))
  const snap = { tick: 999, timestamp: Date.now(), players, entities: [] }
  const t0 = performance.now()
  for (let i = 0; i < 128; i++) SnapshotEncoder.encode(snap)
  const ms = performance.now() - t0
  log(`100p × 128 ticks encode: ${ms.toFixed(1)}ms`)
  assert(ms < 200, `Too slow: ${ms.toFixed(1)}ms`)
})

await test('perf: 1000 entities delta × 128 ticks < 500ms', () => {
  const entities = Array.from({ length: 1000 }, (_, i) => mkEntity(`e${i}`, i % 100, 0, Math.floor(i/100)))
  const snap = { tick: 1, timestamp: 0, players: [], entities }
  let prevMap = SnapshotEncoder.encodeDelta(snap, new Map()).entityMap
  const t0 = performance.now()
  for (let tick = 0; tick < 128; tick++) {
    const ents = entities.map((e, i) => i === tick % 1000 ? { ...e, position: [i+0.1, 0, 0] } : e)
    prevMap = SnapshotEncoder.encodeDelta({ ...snap, tick, entities: ents }, prevMap).entityMap
  }
  const ms = performance.now() - t0
  log(`1000 entities delta × 128 ticks: ${ms.toFixed(1)}ms`)
  assert(ms < 500, `Too slow: ${ms.toFixed(1)}ms`)
})

// ─── SECTION 3: SnapshotProcessor ──────────────────────────────────────────
section('SnapshotProcessor')
const { SnapshotProcessor } = await import('./src/client/SnapshotProcessor.js')

const pArr = (id, x=0,y=0,z=0) => [id, x,y,z, 0,0,0,1, 0,0,0, 1,100,0, 0,0,0]
const eArr = (id, x=0,y=0,z=0) => [id, null, x,y,z, 0,0,0,1, 'static', null]

await test('processSnapshot: full snapshot populates entity and player state', () => {
  const proc = new SnapshotProcessor()
  proc.processSnapshot({ tick: 1, timestamp: 0, players: [pArr('p1',1,2,3)], entities: [eArr('env',5,0,5)] }, 1)
  assert(proc.getAllEntities().size === 1, `entities: ${proc.getAllEntities().size}`)
  assert(proc.getAllPlayerStates().size === 1, `players: ${proc.getAllPlayerStates().size}`)
  assertNear(proc.getPlayerState('p1').position[0], 1, 0.02, 'player x')
  assertNear(proc.getEntity('env').position[0], 5, 0.02, 'entity x')
})

await test('processSnapshot: delta merges changed entities, preserves unchanged', () => {
  const proc = new SnapshotProcessor()
  proc.processSnapshot({ tick: 1, timestamp: 0, players: [], entities: [eArr('e1',0,0,0), eArr('e2',5,0,5)] }, 1)
  proc.processSnapshot({ tick: 2, timestamp: 0, delta: 1, players: [], entities: [eArr('e1',99,0,0)] }, 2)
  assert(proc.getAllEntities().size === 2, `should still have 2 entities, got ${proc.getAllEntities().size}`)
  assertNear(proc.getEntity('e1').position[0], 99, 0.02, 'e1 updated')
  assertNear(proc.getEntity('e2').position[0], 5, 0.02, 'e2 preserved')
})

await test('processSnapshot: delta removed entities cleaned up', () => {
  const proc = new SnapshotProcessor()
  proc.processSnapshot({ tick: 1, timestamp: 0, players: [], entities: [eArr('e1'), eArr('e2')] }, 1)
  proc.processSnapshot({ tick: 2, timestamp: 0, delta: 1, players: [], entities: [], removed: ['e2'] }, 2)
  assert(proc.getAllEntities().size === 1, `e2 should be removed, got ${proc.getAllEntities().size}`)
  assert(!proc.getEntity('e2'), 'e2 state should be gone')
})

await test('processSnapshot: player disconnect clears state', () => {
  const proc = new SnapshotProcessor()
  proc.processSnapshot({ tick: 1, timestamp: 0, players: [pArr('a'), pArr('b')], entities: [] }, 1)
  proc.processSnapshot({ tick: 2, timestamp: 0, players: [pArr('a')], entities: [] }, 2)
  assert(proc.getAllPlayerStates().size === 1, `1 player remaining`)
  assert(!proc.getPlayerState('b'), 'b should be gone')
})

await test('processSnapshot: onPlayerJoined/Left callbacks fire correctly', () => {
  const joined = [], left = []
  const proc = new SnapshotProcessor({ callbacks: { onPlayerJoined: id => joined.push(id), onPlayerLeft: id => left.push(id) } })
  proc.processSnapshot({ tick: 1, timestamp: 0, players: [pArr('p1'), pArr('p2')], entities: [] }, 1)
  assert(joined.length === 2 && joined.includes('p1') && joined.includes('p2'), `joined: ${joined}`)
  proc.processSnapshot({ tick: 2, timestamp: 0, players: [pArr('p1')], entities: [] }, 2)
  assert(left.includes('p2'), `left: ${left}`)
})

await test('processSnapshot: onEntityAdded/Removed callbacks fire correctly', () => {
  const added = [], removed = []
  const proc = new SnapshotProcessor({ callbacks: { onEntityAdded: id => added.push(id), onEntityRemoved: id => removed.push(id) } })
  proc.processSnapshot({ tick: 1, timestamp: 0, players: [], entities: [eArr('e1')] }, 1)
  assert(added.includes('e1'), `e1 not added: ${added}`)
  proc.processSnapshot({ tick: 2, timestamp: 0, delta: 1, players: [], entities: [], removed: ['e1'] }, 2)
  assert(removed.includes('e1'), `e1 not removed: ${removed}`)
})

await test('SnapshotEncoder + SnapshotProcessor full roundtrip', () => {
  const players = [mkPlayer('p1', 3, 1.5, -7)]
  const entities = [mkEntity('map', 0, 0, 0)]
  const snap = { tick: 55, timestamp: Date.now(), players, entities }
  const { encoded } = SnapshotEncoder.encodeDelta(snap, new Map())
  const dec = SnapshotEncoder.decode(encoded)
  const proc = new SnapshotProcessor()
  proc.processSnapshot(dec, 55)
  const ps = proc.getPlayerState('p1')
  assert(ps, 'player state missing')
  assertNear(ps.position[0], 3, 0.02, 'x')
  assertNear(ps.position[1], 1.5, 0.02, 'y')
  assertNear(ps.position[2], -7, 0.02, 'z')
  assert(proc.getEntity('map')?.bodyType === 'static', 'entity bodyType')
})

await test('full roundtrip: 100 players + 200 entities, all positions preserved', () => {
  const players = Array.from({ length: 100 }, (_, i) => mkPlayer(`p${i}`, i*0.7, 1.5 + i*0.01, -i*0.3))
  const entities = Array.from({ length: 200 }, (_, i) => mkEntity(`e${i}`, i*2, 0, i*2))
  const snap = { tick: 1, timestamp: 0, players, entities }
  const { encoded } = SnapshotEncoder.encodeDelta(snap, new Map())
  const proc = new SnapshotProcessor()
  proc.processSnapshot(SnapshotEncoder.decode(encoded), 1)
  assert(proc.getAllPlayerStates().size === 100, `player count: ${proc.getAllPlayerStates().size}`)
  assert(proc.getAllEntities().size === 200, `entity count: ${proc.getAllEntities().size}`)
  assertNear(proc.getPlayerState('p50').position[0], 50*0.7, 0.02, 'p50 x')
  assertNear(proc.getEntity('e100').position[0], 200, 0.02, 'e100 x')
})

// ─── SECTION 4: Physics World ──────────────────────────────────────────────
section('Physics World (Jolt)')
const { PhysicsWorld } = await import('./src/physics/World.js')

// Initialize ONE shared world for most tests to avoid WASM heap pressure
const sharedWorld = new PhysicsWorld({ gravity: [0, -9.81, 0] })
await sharedWorld.init()
log('Shared PhysicsWorld initialized')

await test('init: Jolt and physicsSystem created', () => {
  assert(sharedWorld.Jolt !== null, 'Jolt loaded')
  assert(sharedWorld.physicsSystem !== null, 'physicsSystem created')
  assert(sharedWorld.bodyInterface !== null, 'bodyInterface created')
})

await test('addBody: box at position is retrievable', () => {
  const id = sharedWorld.addBody('box', [1,1,1], [10, 5, -3], 'static')
  const pos = sharedWorld.getBodyPosition(id)
  assertNear(pos[0], 10, 0.01, 'x'); assertNear(pos[1], 5, 0.01, 'y'); assertNear(pos[2], -3, 0.01, 'z')
  sharedWorld.removeBody(id)
})

await test('addBody: removed body is gone from bodies map', () => {
  const id = sharedWorld.addBody('box', [1,1,1], [0,0,0], 'static')
  sharedWorld.removeBody(id)
  assert(!sharedWorld.bodies.has(id), 'body should be removed')
})

await test('raycast: hits static box after physics step', () => {
  // Box: half-extents [5,0.5,5] at [0,-1,0] → spans y[-1.5, -0.5]
  const boxId = sharedWorld.addBody('box', [5, 0.5, 5], [0, -1, 0], 'static')
  sharedWorld.step(1/60) // let broadphase update
  const hit = sharedWorld.raycast([0, 10, 0], [0, -1, 0], 20)
  sharedWorld.removeBody(boxId)
  assert(hit.hit === true, `raycast should hit box, got hit=${hit.hit}`)
  assert(hit.position !== null, 'hit.position should exist')
  assertNear(hit.position[1], -0.5, 0.2, 'hit y near top of box')
  log(`Raycast hit at y=${hit.position[1].toFixed(3)}, dist=${hit.distance.toFixed(2)}`)
})

await test('raycast: misses when empty world', () => {
  const hit = sharedWorld.raycast([0, 100, 0], [0, -1, 0], 5)
  assert(hit.hit === false, `should miss, got hit=${hit.hit}`)
})

await test('character: lands on static box floor', () => {
  const floorId = sharedWorld.addBody('box', [50, 0.1, 50], [0, 0, 0], 'static')
  sharedWorld.step(1/60)
  const charId = sharedWorld.addPlayerCharacter(0.4, 0.9, [0, 5, 0], 80)
  const dt = 1/60
  for (let i = 0; i < 120; i++) {
    const vel = sharedWorld.getCharacterVelocity(charId)
    const onGround = sharedWorld.getCharacterGroundState(charId)
    const vy = onGround ? 0 : vel[1] + (-9.81) * dt
    sharedWorld.setCharacterVelocity(charId, [0, vy, 0])
    sharedWorld.updateCharacter(charId, dt)
    sharedWorld.step(dt)
  }
  const pos = sharedWorld.getCharacterPosition(charId)
  const onGround = sharedWorld.getCharacterGroundState(charId)
  sharedWorld.removeCharacter(charId)
  sharedWorld.removeBody(floorId)
  log(`Character landed at y=${pos[1].toFixed(3)}, onGround=${onGround}`)
  assert(onGround, 'character should be on ground')
  assert(pos[1] > -1 && pos[1] < 4, `character y=${pos[1].toFixed(3)} out of expected range`)
})

await test('character: gravity causes downward acceleration (no floor)', () => {
  const charId = sharedWorld.addPlayerCharacter(0.4, 0.9, [50, 10, 50], 80)
  const startY = sharedWorld.getCharacterPosition(charId)[1]
  const dt = 1/60
  // Fall for 1 second — expect ~5m drop (0.5 * 9.81 * 1^2 ≈ 4.9m)
  for (let i = 0; i < 60; i++) {
    const vel = sharedWorld.getCharacterVelocity(charId)
    sharedWorld.setCharacterVelocity(charId, [0, vel[1] + (-9.81) * dt, 0])
    sharedWorld.updateCharacter(charId, dt)
    sharedWorld.step(dt)
  }
  const endY = sharedWorld.getCharacterPosition(charId)[1]
  sharedWorld.removeCharacter(charId)
  const drop = startY - endY
  log(`Free fall 1s: dropped ${drop.toFixed(2)}m (expect ~4.9m)`)
  assert(drop > 3, `Too little drop: ${drop.toFixed(2)}m — gravity broken?`)
  assert(drop < 8, `Too much drop: ${drop.toFixed(2)}m`)
})

await test('character: setCharacterPosition teleports character', () => {
  const charId = sharedWorld.addPlayerCharacter(0.4, 0.9, [0, 0, 0], 80)
  sharedWorld.setCharacterPosition(charId, [100, 50, -200])
  const pos = sharedWorld.getCharacterPosition(charId)
  sharedWorld.removeCharacter(charId)
  assertNear(pos[0], 100, 0.1, 'x after teleport')
  assertNear(pos[1], 50, 0.1, 'y after teleport')
  assertNear(pos[2], -200, 0.1, 'z after teleport')
})

await test('character: setCharacterVelocity is applied', () => {
  const charId = sharedWorld.addPlayerCharacter(0.4, 0.9, [0, 100, 0], 80)
  sharedWorld.setCharacterVelocity(charId, [5, 0, -3])
  const vel = sharedWorld.getCharacterVelocity(charId)
  sharedWorld.removeCharacter(charId)
  assertNear(vel[0], 5, 0.01, 'vx')
  assertNear(vel[2], -3, 0.01, 'vz')
})

await test('getBodyRotation: returns identity for unrotated body', () => {
  const id = sharedWorld.addBody('box', [1,1,1], [0,0,0], 'static')
  const rot = sharedWorld.getBodyRotation(id)
  sharedWorld.removeBody(id)
  assertNear(rot[3], 1, 0.01, 'w should be 1 for identity quat')
  assertNear(rot[0], 0, 0.01, 'x should be 0')
})

// ─── SECTION 5: Map trimesh physics ────────────────────────────────────────
section('Map trimesh physics (Draco multi-mesh maps)')

// Use a fresh world for heavy trimesh tests to avoid heap fragmentation
const mapWorld = new PhysicsWorld({ gravity: [0, -9.81, 0] })
await mapWorld.init()

await test('addStaticTrimeshAsync: aim_kosova creates body with correct metadata', async () => {
  const { resolve } = await import('path')
  const bodyId = await mapWorld.addStaticTrimeshAsync(resolve('./apps/maps/aim_kosova_ak47.glb'))
  assert(bodyId !== undefined && bodyId !== null, `bodyId: ${bodyId}`)
  assert(mapWorld.bodies.has(bodyId), 'body in bodies map')
  const meta = mapWorld.bodyMeta.get(bodyId)
  assert(meta.shape === 'trimesh', `meta.shape: ${meta.shape}`)
  assert(meta.triangles > 10000, `too few triangles: ${meta.triangles}`)
  log(`aim_kosova body: ${meta.triangles} triangles`)
  mapWorld.removeBody(bodyId)
})

await test('addStaticTrimeshAsync: character lands on real map (not falling through)', async () => {
  const { resolve } = await import('path')
  const path = resolve('./apps/maps/aim_kosova_ak47.glb')

  // Get map geometry bounds to place character intelligently
  const mesh = await extractAllMeshesFromGLBAsync(path)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < mesh.vertexCount; i++) {
    const x = mesh.vertices[i*3], y = mesh.vertices[i*3+1], z = mesh.vertices[i*3+2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2
  const spawnY = maxY + 3

  log(`Map bounds: X[${minX.toFixed(1)},${maxX.toFixed(1)}] Y[${minY.toFixed(1)},${maxY.toFixed(1)}] center=(${cx.toFixed(1)},${cz.toFixed(1)})`)
  log(`Spawning character at (${cx.toFixed(1)}, ${spawnY.toFixed(1)}, ${cz.toFixed(1)})`)

  const bodyId = await mapWorld.addStaticTrimeshAsync(path)
  mapWorld.step(1/60) // broadphase settle

  const charId = mapWorld.addPlayerCharacter(0.4, 0.9, [cx, spawnY, cz], 80)
  const dt = 1/60
  let landedY = null, landedAt = null
  for (let i = 0; i < 300; i++) { // 5s
    const vel = mapWorld.getCharacterVelocity(charId)
    const onGround = mapWorld.getCharacterGroundState(charId)
    const vy = onGround ? 0 : vel[1] + (-9.81) * dt
    mapWorld.setCharacterVelocity(charId, [0, vy, 0])
    mapWorld.updateCharacter(charId, dt)
    mapWorld.step(dt)
    if (onGround && landedY === null) { landedY = mapWorld.getCharacterPosition(charId)[1]; landedAt = i }
  }
  const finalPos = mapWorld.getCharacterPosition(charId)
  const finalOnGround = mapWorld.getCharacterGroundState(charId)

  mapWorld.removeCharacter(charId)
  mapWorld.removeBody(bodyId)

  if (landedY !== null) log(`Landed at y=${landedY.toFixed(3)} after ${(landedAt/60).toFixed(2)}s`)
  log(`Final pos: (${finalPos[0].toFixed(2)}, ${finalPos[1].toFixed(2)}, ${finalPos[2].toFixed(2)}), onGround=${finalOnGround}`)

  assert(finalPos[1] > minY - 2, `Character fell through map floor: y=${finalPos[1].toFixed(3)}, mapMinY=${minY.toFixed(2)}`)
  assert(finalOnGround, `Character should be grounded, y=${finalPos[1].toFixed(3)}`)
})

await test('raycast: hits real map geometry', async () => {
  const { resolve } = await import('path')
  const path = resolve('./apps/maps/aim_kosova_ak47.glb')
  const mesh = await extractAllMeshesFromGLBAsync(path)

  // Find centroid of map geometry
  let sumX = 0, sumZ = 0, maxY = -Infinity
  for (let i = 0; i < mesh.vertexCount; i++) {
    sumX += mesh.vertices[i*3]; maxY = Math.max(maxY, mesh.vertices[i*3+1]); sumZ += mesh.vertices[i*3+2]
  }
  const cx = sumX / mesh.vertexCount, cz = sumZ / mesh.vertexCount

  const bodyId = await mapWorld.addStaticTrimeshAsync(path)
  mapWorld.step(1/60)

  // Cast ray from above centroid downward
  const rayFrom = [cx, maxY + 5, cz]
  const hit = mapWorld.raycast(rayFrom, [0, -1, 0], 50)

  mapWorld.removeBody(bodyId)
  log(`Map raycast from (${cx.toFixed(1)}, ${(maxY+5).toFixed(1)}, ${cz.toFixed(1)}): hit=${hit.hit}, y=${hit.position?.[1]?.toFixed(3)}`)
  assert(hit.hit === true, `Raycast should hit map geometry. Got hit=${hit.hit}`)
})

await test('20 characters all land independently on flat floor', () => {
  const floorId = mapWorld.addBody('box', [200, 0.1, 200], [0, 0, 0], 'static')
  mapWorld.step(1/60)
  const charIds = []
  for (let i = 0; i < 20; i++) charIds.push(mapWorld.addPlayerCharacter(0.4, 0.9, [i*3 - 30, 5, 0], 80))
  const dt = 1/128
  for (let tick = 0; tick < 128; tick++) {
    for (const id of charIds) {
      const vel = mapWorld.getCharacterVelocity(id)
      const og = mapWorld.getCharacterGroundState(id)
      mapWorld.setCharacterVelocity(id, [0, og ? 0 : vel[1] + (-9.81)*dt, 0])
      mapWorld.updateCharacter(id, dt)
    }
    mapWorld.step(dt)
  }
  let grounded = 0
  for (const id of charIds) { if (mapWorld.getCharacterGroundState(id)) grounded++; mapWorld.removeCharacter(id) }
  mapWorld.removeBody(floorId)
  log(`${grounded}/20 characters grounded after 1s`)
  assert(grounded === 20, `Only ${grounded}/20 characters grounded`)
})

await test('destroy: cleans up without WASM error', () => {
  mapWorld.destroy()
  assert(mapWorld.jolt === null, 'jolt should be null after destroy')
  assert(mapWorld.physicsSystem === null, 'physicsSystem should be null')
})

sharedWorld.destroy()
assert(sharedWorld.jolt === null, 'sharedWorld destroyed cleanly')

// ─── SECTION 6: AppContext integration ────────────────────────────────────
section('AppContext addTrimeshCollider')

await test('addTrimeshCollider calls addStaticTrimeshAsync and stores bodyId', async () => {
  // Mock runtime with minimal physics world
  const world = new PhysicsWorld({ gravity: [0, -9.81, 0] })
  await world.init()
  const { resolve } = await import('path')

  const entity = {
    id: 'testmap',
    model: './apps/maps/aim_kosova_ak47.glb',
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    bodyType: 'static',
    velocity: [0, 0, 0],
    custom: {},
    _physicsBodyId: undefined
  }
  const mockRuntime = {
    _physics: world,
    resolveAssetPath: (p) => resolve(p.replace('./', './'))
  }

  const { AppContext } = await import('./src/apps/AppContext.js')
  const ctx = new AppContext(entity, mockRuntime)

  await ctx.physics.addTrimeshCollider()

  assert(entity._physicsBodyId !== undefined, `_physicsBodyId not set: ${entity._physicsBodyId}`)
  assert(world.bodies.has(entity._physicsBodyId), 'body should be in physics world')
  log(`addTrimeshCollider created body ${entity._physicsBodyId}`)
  world.destroy()
})

// ─── Final results ──────────────────────────────────────────────────────────
console.log('\n\n' + '═'.repeat(65))
console.log(`RESULTS: ${pass} passed, ${fail} failed`)
console.log('═'.repeat(65))
for (const r of results) {
  if (!r.ok) console.log(`\n  FAIL: ${r.name}\n        ${r.err}`)
}
if (fail === 0) {
  console.log('\n✓ ALL TESTS PASSED')
  process.exit(0)
} else {
  console.log(`\n✗ ${fail} test(s) FAILED`)
  process.exit(1)
}
