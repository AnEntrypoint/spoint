const LAYER_DYNAMIC = 1

export class CharacterManager {
  constructor(gravity, crouchHalfHeight = 0.45) {
    this.gravity = gravity
    this.crouchHalfHeight = crouchHalfHeight
    this.characters = new Map()
    this._charShapes = new Map()
    this._nextCharId = 0
    this.J = null; this._jolt = null; this._physicsSystem = null
    this._filters = null; this._updateSettings = null
    this._charGravity = null; this._tmpVec3 = null; this._tmpRVec3 = null
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
    this._updateSettings.mStickToFloorStepDown = new J.Vec3(0, -0.5, 0)
    this._updateSettings.mWalkStairsStepUp = new J.Vec3(0, 0.4, 0)
    this._charGravity = new J.Vec3(this.gravity[0], this.gravity[1], this.gravity[2])
    this._tmpVec3 = new J.Vec3(0, 0, 0)
    this._tmpRVec3 = new J.RVec3(0, 0, 0)
  }

  addCharacter(radius, halfHeight, position, mass) {
    const J = this.J
    const cvs = new J.CharacterVirtualSettings()
    cvs.mMass = mass || 80
    cvs.mMaxSlopeAngle = 0.7854
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
    this._charShapes.set(id, { radius, standHeight: halfHeight, crouchHeight: this.crouchHalfHeight })
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
    const r = [v.GetX(), v.GetY(), v.GetZ()]
    this.J.destroy(v); return r
  }

  readVelocity(charId, out) {
    const ch = this.characters.get(charId); if (!ch) return
    const v = ch.GetLinearVelocity()
    out[0] = v.GetX(); out[1] = v.GetY(); out[2] = v.GetZ()
    this.J.destroy(v)
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

  getGroundState(charId) {
    const ch = this.characters.get(charId); if (!ch) return false
    return ch.GetGroundState() === this.J.EGroundState_OnGround
  }

  removeCharacter(charId) {
    const ch = this.characters.get(charId)
    if (ch) { this.J.destroy(ch); this.characters.delete(charId); this._charShapes.delete(charId) }
  }

  destroy() {
    for (const ch of this.characters.values()) this.J.destroy(ch)
    this.characters.clear()
    if (!this._filters) return
    this.J.destroy(this._filters.bp); this.J.destroy(this._filters.ol)
    this.J.destroy(this._filters.body); this.J.destroy(this._filters.shape)
    this.J.destroy(this._updateSettings); this.J.destroy(this._charGravity)
    this.J.destroy(this._tmpVec3); this.J.destroy(this._tmpRVec3)
    this._filters = null
  }
}
