import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

await installSpecifierHooks()
const { PhysicsWorld } = await import('../src/physics/World.js')
const { createCollisionMirror } = await import('../src/client/CollisionMirror.js')
const { encodeTileMessage, boxRecordOf, boxRecordsOf, COLLISION_TILE_FORMAT } = await import('../src/shared/collisionTile.js')

const TILE_M = 16
const MARGIN_M = 3
const checks = []
const check = (name, ok, detail = '') => {
  checks.push(ok)
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}
const sameRecord = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const shapeDiff = (mirrorRecords, serverRecords) => {
  if (mirrorRecords.length !== serverRecords.length) return `count ${mirrorRecords.length} vs ${serverRecords.length}`
  const bad = mirrorRecords.findIndex((r, i) => !sameRecord(r, serverRecords[i]))
  return bad < 0 ? '' : `record ${bad}: mirror [${mirrorRecords[bad].join(', ')}] server [${serverRecords[bad].join(', ')}]`
}

const server = new PhysicsWorld({ gravity: [0, -9.8, 0] })
await server.init()
const floorId = server.addBody('box', [100, 1, 100], [0, -1, 0], 'static')
const tiltId = server.addBody('box', [2, 0.5, 3], [5, 0.6, -4], 'static', { rotation: [0, Math.sin(0.3 / 2), 0, Math.cos(0.3 / 2)] })
const index = server.enableStaticTiles()

const serverRecordOf = id => {
  const m = server.bodyMeta.get(id)
  return boxRecordOf(m.half, m.convexRadius, server.getBodyPosition(id), server.getBodyRotation(id))
}
const serverBoxes = [floorId, tiltId].map(serverRecordOf)
check('server boxes carry their half extents and convex radius in meta', [floorId, tiltId].every(id => server.bodyMeta.get(id).shape === 'box' && server.bodyMeta.get(id).half && Number.isFinite(server.bodyMeta.get(id).convexRadius)))

const PROBES = [[0, 0], [5, -4], [-40, 30]]
const probe3 = ([px, pz]) => [px, 0, pz]
const probeTile = ([px, pz]) => [Math.floor(px / TILE_M), Math.floor(pz / TILE_M)]
const probeTiles = PROBES.map(probeTile)
const serverTiles = probeTiles.map(([tx, tz]) => index.get(tx, tz, 0))
check('server tiles carry no triangles for box-only bodies', serverTiles.every(t => t.verts.length === 0), serverTiles.map(t => t.verts.length).join(','))
const serverTileRecords = serverTiles.map(t => boxRecordsOf(t.boxes))
check('every record a server tile carries matches a server body exactly', serverTileRecords.every(rs => rs.every(r => serverBoxes.some(s => sameRecord(r, s)))))
check('the tilted box reaches the tile of its own centre', serverTileRecords[1].some(r => sameRecord(r, serverBoxes[1])))

const mirror = createCollisionMirror({ loadPhysicsWorld: async () => PhysicsWorld })
await mirror.configure({ radius: 0.4, halfHeight: 0.9, crouchHalfHeight: 0.5, maxSlopeAngle: 45, maxStepHeight: 0.35, stickToFloorDistance: 0.2, mass: 120, gravity: [0, -9.8, 0], tileM: TILE_M, marginM: MARGIN_M, forgetRing: 2 })
check('mirror initialised with its own physics world', mirror.ready)

const goodMessages = serverTiles.map(encodeTileMessage)
check('the wire message carries format version 2', goodMessages.every(m => m.f === COLLISION_TILE_FORMAT && COLLISION_TILE_FORMAT === 2))

let mismatches = 0
PROBES.forEach((p, i) => {
  mirror.onTile(goodMessages[i])
  const floor = mirror.floorOf(probe3(p))
  const diff = floor ? shapeDiff(floor.records, serverTileRecords[i]) : 'no floor'
  check(`mirror floor records equal the server's at probe ${i} (${p.join(',')})`, diff === '', diff)
  check(`mirror holds no triangle floor at probe ${i}`, floor?.meshes === 0, `meshes ${floor?.meshes}`)
  const bodyDiff = floor ? floor.bodies.findIndex((b, j) => !sameRecord(b.half, floor.records[j].slice(0, 3).map(Math.fround)) || !sameRecord(b.position, floor.records[j].slice(4, 7).map(Math.fround)) || !sameRecord(b.rotation, floor.records[j].slice(7, 11).map(Math.fround))) : -1
  check(`mirror Jolt bodies hold the record exactly to float32 at probe ${i}`, bodyDiff < 0 && floor?.bodies.length === floor?.records.length && floor.records.length > 0, `body ${bodyDiff}, ${floor?.bodies.length} bodies for ${floor?.records.length} records`)
  if (floor && shapeDiff(floor.records, serverTileRecords[i])) mismatches++
})

const floorMeta = server.bodyMeta.get(floorId)
const floorHalfTrue = floorMeta.half
floorMeta.half = [floorHalfTrue[0] + 0.01, floorHalfTrue[1], floorHalfTrue[2]]
index.forget(floorId)
index.update(floorId)
const perturbedTile = index.get(probeTiles[1][0], probeTiles[1][1], 0)
const perturbedRecords = boxRecordsOf(perturbedTile.boxes)
check('negative control: the server tile carries the perturbed floor record', perturbedRecords.some(r => r[0] === floorHalfTrue[0] + 0.01), `floor half ${floorMeta.half[0]}`)
mirror.onTile(encodeTileMessage(perturbedTile))
const perturbed = mirror.floorOf(probe3(PROBES[1]))
const perturbedDiff = perturbed ? shapeDiff(perturbed.records, serverTileRecords[1]) : 'no floor'
check('negative control: the mirror path reports the perturbed server record as a shape difference', perturbedDiff !== '' && perturbedDiff !== 'no floor', perturbedDiff)
floorMeta.half = floorHalfTrue
index.forget(floorId)
index.update(floorId)

const refusedBefore = mirror.getStats().refusedTiles
mirror.onTile({ ...goodMessages[1], f: 1 })
mirror.onTile({ tx: goodMessages[1].tx, tz: goodMessages[1].tz, h: goodMessages[1].h, v: goodMessages[1].v, b: goodMessages[1].b })
check('a message without the version-2 format is refused, not installed', mirror.getStats().refusedTiles === refusedBefore + 2, `refused ${mirror.getStats().refusedTiles - refusedBefore} of 2`)

mirror.onTile(goodMessages[1])
const restored = mirror.floorOf(probe3(PROBES[1]))
check('restoring the good tile returns the server shape', !!restored && shapeDiff(restored.records, serverTileRecords[1]) === '')

const failed = checks.filter(ok => !ok).length
console.log(`mirror floor shape differs from the server's at ${mismatches} probe(s) of ${PROBES.length}`)
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'} collision tile floor is the server's box (${checks.length - failed} of ${checks.length} checks)`)
mirror.dispose()
server.destroy()
await exitAfterQuiesce(failed ? 1 : 0)
