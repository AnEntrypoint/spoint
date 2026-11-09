import { verticalVelocity } from '../shared/characterStep.js'
import { TRIANGLE_FLOATS, decodeTileMessage, boxRecordsOf } from '../shared/collisionTile.js'

const AT_REST_SPEED_SQ = 1e-4
const PREBUILD_INTERVAL_MS = 200
const MIRROR_JOLT_LIMITS = Object.freeze({ maxBodies: 128, maxBodyPairs: 256, maxContactConstraints: 256 })
const MIRROR_ORIGIN = [0, 0, 0]
const MIRROR_BOX_POS = [0, 0, 0]
const MIRROR_BOX_ROT = [0, 0, 0, 1]
const MIRROR_VELOCITY = [0, 0, 0]

function tileKey(tx, tz) { return tx + ',' + tz }

function hasMoveInput(input) {
  return !!(input && (input.forward || input.backward || input.left || input.right || input.jump || input.analogForward || input.analogRight))
}

export function createCollisionMirror({ loadPhysicsWorld = () => import('../physics/World.js').then(m => m.PhysicsWorld) } = {}) {
  const tiles = new Map(), boxBodies = new Map()
  let activeBoxes = new Set()
  const stats = { tiles: 0, builtTiles: 0, triangles: 0, boxes: 0, builds: 0, buildMs: 0, maxBuildMs: 0, swaps: 0, mirroredSteps: 0, stepMs: 0, uncoveredSteps: 0, bytes: 0, refusedTiles: 0 }
  let cfg = null, cfgKey = null, world = null, charId = null, generation = 0, active = null, lastPrebuildAt = 0
  const last = [NaN, NaN, NaN]
  let tempAllocator = null, lastTile = null, lastTx = NaN, lastTz = NaN

  function dispose() {
    if (world) world.destroy()
    world = null; charId = null; active = null; tempAllocator = null; lastTile = null
    boxBodies.clear(); activeBoxes.clear()
  }

  async function configure(c) {
    const gen = ++generation
    dispose()
    tiles.clear(); cfg = null
    const PhysicsWorld = await loadPhysicsWorld()
    if (gen !== generation) return
    const w = new PhysicsWorld({ gravity: c.gravity, crouchHalfHeight: c.crouchHalfHeight, joltLimits: MIRROR_JOLT_LIMITS })
    const mgr = w._charMgr
    mgr.config.maxStepHeight = c.maxStepHeight
    mgr.config.stickToFloorDistance = c.stickToFloorDistance
    await w.init()
    if (gen !== generation) { w.destroy(); return }
    world = w
    tempAllocator = w.jolt.GetTempAllocator()
    charId = mgr.addCharacter(c.radius, c.halfHeight, MIRROR_ORIGIN, c.mass, { maxSlopeAngle: c.maxSlopeAngle })
    last[0] = NaN
    cfg = c; cfgKey = JSON.stringify(c)
  }

  function forgetBody(id) {
    world.bodies.delete(id); world.bodyMeta.delete(id); world.bodyIds.delete(id)
  }

  function acquireBox(r) {
    const k = r.join(',')
    let e = boxBodies.get(k)
    if (!e) {
      const J = world.Jolt, hv = new J.Vec3(r[0], r[1], r[2])
      const shape = new J.BoxShape(hv, r[3], null)
      J.destroy(hv)
      MIRROR_BOX_POS[0] = r[4]; MIRROR_BOX_POS[1] = r[5]; MIRROR_BOX_POS[2] = r[6]
      MIRROR_BOX_ROT[0] = r[7]; MIRROR_BOX_ROT[1] = r[8]; MIRROR_BOX_ROT[2] = r[9]; MIRROR_BOX_ROT[3] = r[10]
      const id = world._addBody(shape, MIRROR_BOX_POS, J.EMotionType_Static, 0, { rotation: MIRROR_BOX_ROT, meta: { type: 'static', shape: 'box' } })
      world.bodyInterface.RemoveBody(world.bodyIds.get(id))
      e = { id, refs: 0 }
      boxBodies.set(k, e)
    }
    e.refs++
    return k
  }

  function releaseBox(k) {
    const e = boxBodies.get(k)
    if (--e.refs > 0) return
    world.bodyInterface.DestroyBody(world.bodyIds.get(e.id))
    forgetBody(e.id)
    boxBodies.delete(k)
  }

  function detach() {
    const bi = world.bodyInterface
    if (active?.meshId != null) bi.RemoveBody(world.bodyIds.get(active.meshId))
    for (const k of activeBoxes) bi.RemoveBody(world.bodyIds.get(boxBodies.get(k).id))
    activeBoxes.clear(); active = null; last[0] = NaN
  }

  function dropBody(t) {
    if (!t.built) return
    if (active === t) detach()
    if (t.meshId != null) { const id = t.meshId; world.bodyInterface.DestroyBody(world.bodyIds.get(id)); forgetBody(id) }
    for (const k of t.boxKeys) releaseBox(k)
    if (t.meshId != null || t.boxKeys.length) stats.builtTiles--
    t.meshId = null; t.boxKeys.length = 0; t.built = false
  }

  function clearTiles() {
    if (world) for (const t of tiles.values()) dropBody(t)
    tiles.clear(); active = null; activeBoxes = new Set(); last[0] = NaN; stats.tiles = 0; lastTile = null
  }

  function reexpress(transfer) {
    const seenTri = new Set(), seenBox = new Set(), triangles = [], boxes = [], p = [0, 0, 0]
    for (const t of tiles.values()) {
      const v = t.verts
      for (let i = 0; i + TRIANGLE_FLOATS <= v.length; i += TRIANGLE_FLOATS) {
        const key = v.subarray(i, i + TRIANGLE_FLOATS).join(',')
        if (seenTri.has(key)) continue
        seenTri.add(key)
        const moved = new Float32Array(TRIANGLE_FLOATS)
        for (let k = 0; k < 3; k++) {
          p[0] = v[i + k * 3]; p[1] = v[i + k * 3 + 1]; p[2] = v[i + k * 3 + 2]
          transfer.point(p, p)
          moved[k * 3] = p[0]; moved[k * 3 + 1] = p[1]; moved[k * 3 + 2] = p[2]
        }
        triangles.push(moved)
      }
      for (const r of t.boxes) {
        const key = r.join(',')
        if (seenBox.has(key)) continue
        seenBox.add(key)
        p[0] = r[4]; p[1] = r[5]; p[2] = r[6]
        transfer.point(p, p)
        boxes.push([r[0], r[1], r[2], r[3], p[0], p[1], p[2], r[7], r[8], r[9], r[10]])
      }
    }
    clearTiles()
    if (!cfg) return
    const T = cfg.tileM, margin = cfg.marginM, buckets = new Map()
    const bucketAt = (tx, tz) => {
      const k = tileKey(tx, tz)
      let b = buckets.get(k)
      if (!b) { b = { tx, tz, tris: [], boxes: [] }; buckets.set(k, b) }
      return b
    }
    for (const tri of triangles) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
      for (let k = 0; k < 3; k++) { const x = tri[k * 3], z = tri[k * 3 + 2]; if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z }
      const tx0 = Math.floor((minX - margin) / T), tx1 = Math.floor((maxX + margin) / T), tz0 = Math.floor((minZ - margin) / T), tz1 = Math.floor((maxZ + margin) / T)
      for (let tx = tx0; tx <= tx1; tx++) for (let tz = tz0; tz <= tz1; tz++) bucketAt(tx, tz).tris.push(tri)
    }
    for (const r of boxes) {
      const reach = Math.hypot(r[0], r[2]) + margin
      const tx0 = Math.floor((r[4] - reach) / T), tx1 = Math.floor((r[4] + reach) / T), tz0 = Math.floor((r[6] - reach) / T), tz1 = Math.floor((r[6] + reach) / T)
      for (let tx = tx0; tx <= tx1; tx++) for (let tz = tz0; tz <= tz1; tz++) bucketAt(tx, tz).boxes.push(r)
    }
    for (const [k, b] of buckets) {
      const verts = new Float32Array(b.tris.length * TRIANGLE_FLOATS)
      b.tris.forEach((tri, i) => verts.set(tri, i * TRIANGLE_FLOATS))
      tiles.set(k, { tx: b.tx, tz: b.tz, hash: 0, verts, boxes: b.boxes, meshId: null, boxKeys: [], built: false })
    }
    stats.tiles = tiles.size
  }

  function sameConfig(c) { return !!world && cfgKey === JSON.stringify(c) }

  function onTile(msg, nearPos) {
    const decoded = decodeTileMessage(msg)
    if (!decoded) { stats.refusedTiles++; return }
    const k = tileKey(decoded.tx, decoded.tz), prev = tiles.get(k)
    if (prev && world) dropBody(prev)
    lastTile = null
    tiles.set(k, { tx: decoded.tx, tz: decoded.tz, hash: decoded.hash, verts: decoded.verts, boxes: boxRecordsOf(decoded.boxes), meshId: null, boxKeys: [], built: false })
    stats.bytes += msg.v.byteLength + msg.b.byteLength; stats.tiles = tiles.size
    if (cfg && nearPos) evictFar(nearPos)
  }

  function evictFar(p) {
    const T = cfg.tileM, cx = Math.floor(p[0] / T), cz = Math.floor(p[2] / T), keep = cfg.forgetRing + 1
    lastTile = null
    for (const [k, t] of tiles) if (Math.max(Math.abs(t.tx - cx), Math.abs(t.tz - cz)) > keep) { dropBody(t); tiles.delete(k) }
    stats.tiles = tiles.size
  }

  function build(t) {
    const t0 = performance.now()
    const J = world.Jolt, v = t.verts, n = v.length / TRIANGLE_FLOATS
    t.built = true
    if (n > 0) {
      const list = new J.TriangleList()
      list.resize(n)
      const base = J.getPointer(list.at(0)), stride = n > 1 ? J.getPointer(list.at(1)) - base : 0
      const F = J.HEAPF32
      for (let i = 0; i < n; i++) { const o = (base + i * stride) >> 2, s = i * TRIANGLE_FLOATS; for (let q = 0; q < TRIANGLE_FLOATS; q++) F[o + q] = v[s + q] }
      const settings = new J.MeshShapeSettings(list), sr = settings.Create()
      J.destroy(list)
      if (sr.IsValid()) {
        t.meshId = world._addBody(sr.Get(), MIRROR_ORIGIN, J.EMotionType_Static, 0, { meta: { type: 'static', shape: 'mirror' } })
        world.bodyInterface.RemoveBody(world.bodyIds.get(t.meshId))
      }
      J.destroy(settings); J.destroy(sr)
    }
    for (const r of t.boxes) t.boxKeys.push(acquireBox(r))
    if (t.meshId != null || t.boxKeys.length) stats.builtTiles++
    const ms = performance.now() - t0
    stats.builds++; stats.buildMs += ms; if (ms > stats.maxBuildMs) stats.maxBuildMs = ms
    stats.triangles += n; stats.boxes += t.boxes.length
  }

  function activate(t) {
    if (active === t) return
    const bi = world.bodyInterface, J = world.Jolt
    if (active?.meshId != null) bi.RemoveBody(world.bodyIds.get(active.meshId))
    if (t.meshId != null) bi.AddBody(world.bodyIds.get(t.meshId), J.EActivation_DontActivate)
    const want = new Set(t.boxKeys)
    for (const k of activeBoxes) if (!want.has(k)) bi.RemoveBody(world.bodyIds.get(boxBodies.get(k).id))
    for (const k of want) if (!activeBoxes.has(k)) bi.AddBody(world.bodyIds.get(boxBodies.get(k).id), J.EActivation_DontActivate)
    activeBoxes = want
    active = t; last[0] = NaN; stats.swaps++
  }

  function tileAt(p) {
    const T = cfg.tileM, cx = Math.floor(p[0] / T), cz = Math.floor(p[2] / T)
    if (lastTile && cx === lastTx && cz === lastTz) return lastTile
    lastTx = cx; lastTz = cz; lastTile = tiles.get(tileKey(cx, cz))
    return lastTile
  }

  function covers(p) {
    if (!world || !cfg) return false
    const t = tileAt(p)
    if (!t) return false
    if (!t.built) build(t)
    return t.meshId != null || t.boxKeys.length > 0
  }

  function floorOf(p) {
    if (!world || !cfg) return null
    const t = tileAt(p)
    if (!t) return null
    if (!t.built) build(t)
    return {
      meshes: t.meshId == null ? 0 : 1,
      records: t.boxes,
      bodies: t.boxKeys.map(k => {
        const id = boxBodies.get(k).id, J = world.Jolt, bounds = world.bodies.get(id).GetShape().GetLocalBounds(), lo = bounds.mMin, hi = bounds.mMax
        const half = [(hi.GetX() - lo.GetX()) / 2, (hi.GetY() - lo.GetY()) / 2, (hi.GetZ() - lo.GetZ()) / 2]
        J.destroy(bounds)
        return { half, position: world.getBodyPosition(id), rotation: world.getBodyRotation(id) }
      }),
    }
  }

  function prebuildNeighbour(p) {
    const now = performance.now()
    if (now - lastPrebuildAt < PREBUILD_INTERVAL_MS) return
    const cx = Math.floor(p[0] / cfg.tileM), cz = Math.floor(p[2] / cfg.tileM)
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const t = tiles.get(tileKey(cx + dx, cz + dz))
      if (t && !t.built) { build(t); lastPrebuildAt = now; return }
    }
  }

  function syncCharacter(p) {
    if (p[0] === last[0] && p[1] === last[1] && p[2] === last[2]) return
    world.setCharacterPosition(charId, p)
    const mgr = world._charMgr, f = mgr._filters
    mgr.characters.get(charId).RefreshContacts(f.bp, f.ol, f.body, f.shape, tempAllocator)
    mgr.refreshGroundCaches()
  }

  function step(state, input, dt, gravityY, wasGrounded) {
    const t0 = performance.now()
    const p = state.position, v = state.velocity
    activate(tileAt(p))
    const crouch = !!input?.crouch
    if (input && crouch !== !!state._physCrouch) {
      const diff = (cfg.halfHeight - cfg.crouchHalfHeight) * 0.5
      state._crouchDy = (state._crouchDy || 0) + (crouch ? -diff : diff)
      state._physCrouch = crouch
    }
    const atRest = v[0] * v[0] + v[2] * v[2] < AT_REST_SPEED_SQ
    if (!hasMoveInput(input) && state.onGround && atRest) { stats.mirroredSteps++; stats.stepMs += performance.now() - t0; return }
    if (state._crouchDy) { p[1] += state._crouchDy; state._crouchDy = 0 }
    syncCharacter(p)
    const wishedX = v[0], wishedZ = v[2]
    const vy = verticalVelocity(v[1], wasGrounded, gravityY, dt)
    MIRROR_VELOCITY[0] = wishedX; MIRROR_VELOCITY[1] = vy; MIRROR_VELOCITY[2] = wishedZ
    world.setCharacterVelocity(charId, MIRROR_VELOCITY)
    world.updateCharacter(charId, dt)
    world.readCharacterPosition(charId, p)
    world.readCharacterVelocity(charId, v)
    v[0] = wishedX; v[2] = wishedZ
    state.onGround = world.getCharacterGroundState(charId)
    const n = state.groundNormal || (state.groundNormal = [0, 1, 0])
    if (!(state.onGround && world.readCharacterGroundNormal(charId, n))) { n[0] = 0; n[1] = 1; n[2] = 0 }
    if (state.onGround) state.groundY = p[1]
    last[0] = p[0]; last[1] = p[1]; last[2] = p[2]
    stats.mirroredSteps++; stats.stepMs += performance.now() - t0
    prebuildNeighbour(p)
  }

  function noteUncovered() { stats.uncoveredSteps++ }

  function getStats() { return { ...stats, ready: !!world, stepMsAvg: stats.mirroredSteps ? stats.stepMs / stats.mirroredSteps : 0 } }

  return { configure, sameConfig, clearTiles, reexpress, onTile, covers, floorOf, step, noteUncovered, getStats, dispose, get ready() { return !!world && !!cfg } }
}
