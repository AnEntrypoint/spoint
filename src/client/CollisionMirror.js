import { verticalVelocity } from '../shared/characterStep.js'

const AT_REST_SPEED_SQ = 1e-4
const TRIANGLE_FLOATS = 9
const PREBUILD_INTERVAL_MS = 200
const MIRROR_JOLT_LIMITS = Object.freeze({ maxBodies: 128, maxBodyPairs: 256, maxContactConstraints: 256 })

function tileKey(tx, tz) { return tx + ',' + tz }

function hasMoveInput(input) {
  return !!(input && (input.forward || input.backward || input.left || input.right || input.jump || input.analogForward || input.analogRight))
}

export function createCollisionMirror({ loadPhysicsWorld = () => import('../physics/World.js').then(m => m.PhysicsWorld) } = {}) {
  const tiles = new Map()
  const stats = { tiles: 0, builtTiles: 0, triangles: 0, builds: 0, buildMs: 0, maxBuildMs: 0, swaps: 0, mirroredSteps: 0, stepMs: 0, uncoveredSteps: 0, bytes: 0 }
  let cfg = null, world = null, charId = null, generation = 0, active = null, lastPrebuildAt = 0
  const last = [NaN, NaN, NaN]

  function dispose() {
    if (world) world.destroy()
    world = null; charId = null; active = null
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
    charId = mgr.addCharacter(c.radius, c.halfHeight, [0, 0, 0], c.mass, { maxSlopeAngle: c.maxSlopeAngle })
    last[0] = NaN
    cfg = c
  }

  function dropBody(t) {
    if (t.bodyId == null) return
    const bi = world.bodyInterface, jid = world.bodyIds.get(t.bodyId)
    if (active === t) { bi.RemoveBody(jid); active = null; last[0] = NaN }
    bi.DestroyBody(jid)
    world.bodies.delete(t.bodyId); world.bodyMeta.delete(t.bodyId); world.bodyIds.delete(t.bodyId)
    t.bodyId = null; t.built = false
    stats.builtTiles--
  }

  function onTile(msg, nearPos) {
    if (!msg || !Number.isInteger(msg.tx) || !Number.isInteger(msg.tz)) return
    const raw = msg.v instanceof Uint8Array ? msg.v : new Uint8Array(0)
    if (raw.byteLength % (TRIANGLE_FLOATS * 4) !== 0) return
    const k = tileKey(msg.tx, msg.tz), prev = tiles.get(k)
    if (prev && world) dropBody(prev)
    tiles.set(k, { tx: msg.tx, tz: msg.tz, hash: msg.h >>> 0, verts: new Float32Array(raw.slice().buffer), bodyId: null, built: false })
    stats.bytes += raw.byteLength; stats.tiles = tiles.size
    if (cfg && nearPos) evictFar(nearPos)
  }

  function evictFar(p) {
    const T = cfg.tileM, cx = Math.floor(p[0] / T), cz = Math.floor(p[2] / T), keep = cfg.forgetRing + 1
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
        t.bodyId = world._addBody(sr.Get(), [0, 0, 0], J.EMotionType_Static, 0, { meta: { type: 'static', shape: 'mirror' } })
        world.bodyInterface.RemoveBody(world.bodyIds.get(t.bodyId))
        stats.builtTiles++
      }
      J.destroy(settings); J.destroy(sr)
    }
    const ms = performance.now() - t0
    stats.builds++; stats.buildMs += ms; if (ms > stats.maxBuildMs) stats.maxBuildMs = ms
    stats.triangles += n
  }

  function activate(t) {
    if (active === t) return
    const bi = world.bodyInterface, J = world.Jolt
    if (active?.bodyId != null) bi.RemoveBody(world.bodyIds.get(active.bodyId))
    if (t.bodyId != null) bi.AddBody(world.bodyIds.get(t.bodyId), J.EActivation_DontActivate)
    active = t; last[0] = NaN; stats.swaps++
  }

  function tileAt(p) { return tiles.get(tileKey(Math.floor(p[0] / cfg.tileM), Math.floor(p[2] / cfg.tileM))) }

  function covers(p) {
    if (!world || !cfg) return false
    const t = tileAt(p)
    if (!t) return false
    if (!t.built) build(t)
    return t.bodyId != null
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
    mgr.characters.get(charId).RefreshContacts(f.bp, f.ol, f.body, f.shape, world.jolt.GetTempAllocator())
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
    world.setCharacterVelocity(charId, [wishedX, vy, wishedZ])
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

  return { configure, onTile, covers, step, noteUncovered, getStats, dispose, get ready() { return !!world && !!cfg } }
}
