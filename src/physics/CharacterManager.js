const LAYER_DYNAMIC = 1
const FALLBACK_CAPSULE_HALF_HEIGHT = 0.9
const MIN_CARRY_GROUND_SPEED_SQ = 1e-6
export const DEFAULT_MAX_SLOPE_ANGLE_RAD = 0.7854
export const MAX_WALL_PLANES = 2
const WALL_MAX_NORMAL_Y = 0.3
const WALL_ABOVE_STEP_M = 0.05

export class CharacterManager {
  constructor(gravity, crouchHalfHeight = 0.45, config = {}) {
    this.gravity = gravity
    this.crouchHalfHeight = crouchHalfHeight
    this.characters = new Map()
    this._charShapes = new Map()
    this._onGroundAtLastUpdate = new Map()
    this._groundNormals = new Map()
    this._walls = new Map()
    this._nextCharId = 0
    this.J = null; this._jolt = null; this._physicsSystem = null
    this._filters = null; this._updateSettings = null
    this._charGravity = null; this._tmpVec3 = null; this._tmpRVec3 = null
    this.config = {
      maxSlopeAngle: config.maxSlopeAngle ?? DEFAULT_MAX_SLOPE_ANGLE_RAD,
      maxStepHeight: config.maxStepHeight ?? 0.4,
      stickToFloorDistance: config.stickToFloorDistance ?? 0.5
    }
  }

  init(J, jolt, physicsSystem) {
    this.J = J; this._jolt = jolt; this._physicsSystem = physicsSystem
    this._filters = {
      bp: new J.DefaultBroadPhaseLayerFilter(jolt.GetObjectVsBroadPhaseLayerFilter(), LAYER_DYNAMIC),
      ol: new J.DefaultObjectLayerFilter(jolt.GetObjectLayerPairFilter(), LAYER_DYNAMIC),
      body: new J.BodyFilter(),
      shape: new J.ShapeFilter()
    }
    this._updateSettings = new J.ExtendedUpdateSettings()
    this._updateSettings.mStickToFloorStepDown = new J.Vec3(0, -this.config.stickToFloorDistance, 0)
    this._updateSettings.mWalkStairsStepUp = new J.Vec3(0, this.config.maxStepHeight, 0)
    this._charGravity = new J.Vec3(this.gravity[0], this.gravity[1], this.gravity[2])
    this._tmpVec3 = new J.Vec3(0, 0, 0)
    this._tmpRVec3 = new J.RVec3(0, 0, 0)
  }

  setGravity(gravity) {
    this.gravity = gravity
    if (this.J && this._charGravity) {
      this.J.destroy(this._charGravity)
      this._charGravity = new this.J.Vec3(gravity[0], gravity[1], gravity[2])
    }
  }

  addCharacter(radius, halfHeight, position, mass, charConfig) {
    const J = this.J
    if (!Number.isFinite(halfHeight) || halfHeight <= 0) halfHeight = FALLBACK_CAPSULE_HALF_HEIGHT
    const cvs = new J.CharacterVirtualSettings()
    const slopeAngle = charConfig?.maxSlopeAngle ?? this.config.maxSlopeAngle
    cvs.mMass = mass || 80
    cvs.mMaxSlopeAngle = slopeAngle
    cvs.mShape = new J.CapsuleShape(halfHeight, radius)
    cvs.mBackFaceMode = J.EBackFaceMode_CollideWithBackFaces
    cvs.mCharacterPadding = 0.02
    cvs.mPenetrationRecoverySpeed = 1.0
    cvs.mPredictiveContactDistance = 0.1
    cvs.mSupportingVolume = new J.Plane(J.Vec3.prototype.sAxisY(), -radius)
    const pos = new J.RVec3(position[0], position[1], position[2])
    const ch = new J.CharacterVirtual(cvs, pos, J.Quat.prototype.sIdentity(), this._physicsSystem)
    J.destroy(cvs); J.destroy(pos)
    const id = ++this._nextCharId
    this.characters.set(id, ch)
    this._charShapes.set(id, { radius, standHeight: halfHeight, crouchHeight: this.crouchHalfHeight, slopeAngle })
    return id
  }

  setCrouch(charId, isCrouching) {
    const data = this._charShapes.get(charId); if (!data) return
    const heightDiff = (data.standHeight - data.crouchHeight) * 0.5
    const pos = this.getPosition(charId)
    pos[1] += isCrouching ? -heightDiff : heightDiff
    this.setPosition(charId, pos)
  }

  update(charId, dt) {
    const ch = this.characters.get(charId); if (!ch) return
    const f = this._filters
    ch.ExtendedUpdate(dt, this._charGravity, this._updateSettings, f.bp, f.ol, f.body, f.shape, this._jolt.GetTempAllocator())
    let onGround = false
    if (ch.GetGroundState) { onGround = ch.GetGroundState() === this.J.EGroundState_OnGround; this._onGroundAtLastUpdate.set(charId, onGround) }
    this._captureGroundNormal(charId, ch, onGround)
    this._captureWalls(charId, ch)
    if (onGround && ch.GetGroundVelocity) {
      const gv = ch.GetGroundVelocity()
      const vx = gv.GetX(), vy = gv.GetY(), vz = gv.GetZ()
      if (vx*vx + vy*vy + vz*vz > MIN_CARRY_GROUND_SPEED_SQ) {
        const p = ch.GetPosition()
        this._tmpRVec3.Set(p.GetX() + vx*dt, p.GetY() + vy*dt, p.GetZ() + vz*dt)
        ch.SetPosition(this._tmpRVec3)
      }
    }
  }

  getPosition(charId) {
    const ch = this.characters.get(charId); if (!ch) return [0, 0, 0]
    const p = ch.GetPosition()
    return [p.GetX(), p.GetY(), p.GetZ()]
  }

  readPosition(charId, out) {
    const ch = this.characters.get(charId); if (!ch) return
    const p = ch.GetPosition()
    out[0] = p.GetX(); out[1] = p.GetY(); out[2] = p.GetZ()
  }

  getVelocity(charId) {
    const ch = this.characters.get(charId); if (!ch) return [0, 0, 0]
    const v = ch.GetLinearVelocity()
    return [v.GetX(), v.GetY(), v.GetZ()]
  }

  readVelocity(charId, out) {
    const ch = this.characters.get(charId); if (!ch) return
    const v = ch.GetLinearVelocity()
    out[0] = v.GetX(); out[1] = v.GetY(); out[2] = v.GetZ()
  }

  setVelocity(charId, velocity) {
    const ch = this.characters.get(charId); if (!ch) return
    this._tmpVec3.Set(velocity[0], velocity[1], velocity[2])
    ch.SetLinearVelocity(this._tmpVec3)
  }

  setPosition(charId, position) {
    const ch = this.characters.get(charId); if (!ch) return
    this._tmpRVec3.Set(position[0], position[1], position[2])
    ch.SetPosition(this._tmpRVec3)
  }

  _captureGroundNormal(charId, ch, onGround) {
    let n = this._groundNormals.get(charId)
    if (!n) { n = [0, 1, 0, 0]; this._groundNormals.set(charId, n) }
    n[3] = 0
    if (!onGround || !ch.GetGroundNormal) return
    const g = ch.GetGroundNormal()
    const x = g.GetX(), y = g.GetY(), z = g.GetZ()
    if (y > 0 && Number.isFinite(x) && Number.isFinite(z)) { n[0] = x; n[1] = y; n[2] = z; n[3] = 1 }
  }

  refreshGroundCaches() {
    for (const [id, ch] of this.characters) {
      const onGround = ch.GetGroundState() === this.J.EGroundState_OnGround
      this._onGroundAtLastUpdate.set(id, onGround)
      this._captureGroundNormal(id, ch, onGround)
      this._captureWalls(id, ch)
    }
  }

  _captureWalls(charId, ch) {
    let w = this._walls.get(charId)
    if (!w) { w = new Float64Array(1 + MAX_WALL_PLANES * 2); this._walls.set(charId, w) }
    w[0] = 0
    const shape = this._charShapes.get(charId)
    if (!shape || !ch.GetActiveContacts) return
    const contacts = ch.GetActiveContacts()
    const n = contacts.size()
    if (!n) return
    const feetY = ch.GetPosition().GetY() - shape.standHeight - shape.radius
    const minContactY = feetY + this.config.maxStepHeight + WALL_ABOVE_STEP_M
    const staticType = this.J.EMotionType_Static
    for (let i = 0; i < n && w[0] < MAX_WALL_PLANES; i++) {
      const c = contacts.at(i)
      if (!c.mHadCollision || c.mIsSensorB || c.mMotionTypeB !== staticType) continue
      if (c.mPosition.GetY() < minContactY) continue
      const cn = c.mContactNormal
      const nx = cn.GetX(), ny = cn.GetY(), nz = cn.GetZ()
      if (Math.abs(ny) > WALL_MAX_NORMAL_Y) continue
      const len = Math.hypot(nx, nz)
      if (!(len > 0)) continue
      const k = 1 + w[0] * 2
      w[k] = nx / len; w[k + 1] = nz / len
      w[0]++
    }
  }

  readWallNormals(charId, out) {
    const w = this._walls.get(charId)
    const count = w ? w[0] : 0
    out.length = count * 2
    for (let i = 0; i < count * 2; i++) out[i] = w[1 + i]
    return count
  }

  readGroundNormal(charId, out) {
    const n = this._groundNormals.get(charId)
    if (!n || !n[3]) return false
    out[0] = n[0]; out[1] = n[1]; out[2] = n[2]
    return true
  }

  getGroundState(charId) {
    const ch = this.characters.get(charId); if (!ch) return false
    const cached = this._onGroundAtLastUpdate.get(charId)
    if (cached !== undefined) return cached
    return ch.GetGroundState() === this.J.EGroundState_OnGround
  }

  removeCharacter(charId) {
    const ch = this.characters.get(charId)
    if (ch) { this.J.destroy(ch); this.characters.delete(charId); this._charShapes.delete(charId); this._onGroundAtLastUpdate.delete(charId); this._groundNormals.delete(charId); this._walls.delete(charId) }
  }

  snapshotAll() {
    const out = {}
    for (const [id, ch] of this.characters) {
      const p = ch.GetPosition(), v = ch.GetLinearVelocity()
      out[id] = { position: [p.GetX(), p.GetY(), p.GetZ()], velocity: [v.GetX(), v.GetY(), v.GetZ()] }
    }
    return out
  }

  restoreAll(snap) {
    for (const idKey in snap) {
      const id = Number(idKey)
      const ch = this.characters.get(id); if (!ch) continue
      const s = snap[idKey]
      this._tmpRVec3.Set(s.position[0], s.position[1], s.position[2])
      ch.SetPosition(this._tmpRVec3)
      this._tmpVec3.Set(s.velocity[0], s.velocity[1], s.velocity[2])
      ch.SetLinearVelocity(this._tmpVec3)
    }
  }

  destroy() {
    for (const ch of this.characters.values()) this.J.destroy(ch)
    this.characters.clear(); this._onGroundAtLastUpdate.clear()
    if (!this._filters) return
    this.J.destroy(this._filters.bp); this.J.destroy(this._filters.ol)
    this.J.destroy(this._filters.body); this.J.destroy(this._filters.shape)
    this.J.destroy(this._updateSettings); this.J.destroy(this._charGravity)
    this.J.destroy(this._tmpVec3); this.J.destroy(this._tmpRVec3)
    this._filters = null
  }
}
