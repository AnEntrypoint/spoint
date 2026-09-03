const LAYER_DYNAMIC = 1

export class CharacterManager {
  constructor(gravity, crouchHalfHeight = 0.45, config = {}) {
    this.gravity = gravity
    this.crouchHalfHeight = crouchHalfHeight
    this.characters = new Map()
    this._charShapes = new Map()
    this._nextCharId = 0
    this.J = null; this._jolt = null; this._physicsSystem = null
    this._filters = null; this._updateSettings = null
    this._charGravity = null; this._tmpVec3 = null; this._tmpRVec3 = null
    this.config = {
      maxSlopeAngle: config.maxSlopeAngle ?? 0.7854,
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

  addCharacter(radius, halfHeight, position, mass, charConfig) {
    const J = this.J
    // Defense-in-depth (see PhysicsIntegration.js constructor comment for the root-caused caller-side
    // bug this backstops): a non-finite/<=0 halfHeight builds a degenerate CapsuleShape whose
    // CharacterVirtual.ExtendedUpdate never registers ground contact -- the character free-falls straight
    // through a real static collider directly under it. Mirrors the pre-existing radius UB guard one call
    // site up (PhysicsIntegration.addPlayerCollider).
    if (!Number.isFinite(halfHeight) || halfHeight <= 0) halfHeight = 0.9
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
    // Moving-platform carry: a rider standing on a kinematic/moving body should translate WITH it. Jolt's
    // CharacterVirtual tracks the surface it stands on; read that surface's velocity and offset the character by
    // groundVel*dt so it doesn't slide off a moving platform. Guarded: only when on-ground with a moving surface,
    // and only if the runtime's Jolt build exposes GetGroundVelocity (older builds silently no-op, no regression).
    if (ch.GetGroundState && ch.GetGroundVelocity && ch.GetGroundState() === this.J.EGroundState_OnGround) {
      const gv = ch.GetGroundVelocity()
      const vx = gv.GetX(), vy = gv.GetY(), vz = gv.GetZ()
      this.J.destroy(gv)
      if (vx*vx + vy*vy + vz*vz > 1e-6) {
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

  // Rollback-netcode primitive (rollback-netcode-ggpo-style-input-rollback first slice): capture every
  // live character's position+velocity for later exact restore. CharacterVirtual has no rotation state
  // of its own (the capsule shape doesn't rotate) so only position+velocity round-trip; GetGroundState is
  // deliberately NOT captured -- it's a derived read of nearby geometry Jolt recomputes fresh on the next
  // ExtendedUpdate, not authoritative state, so restoring stale ground-state would fight Jolt's own logic.
  snapshotAll() {
    const out = {}
    for (const [id, ch] of this.characters) {
      const p = ch.GetPosition(), v = ch.GetLinearVelocity()
      out[id] = { position: [p.GetX(), p.GetY(), p.GetZ()], velocity: [v.GetX(), v.GetY(), v.GetZ()] }
      this.J.destroy(v)
    }
    return out
  }

  // Restores exactly the characters present in `snap` (ids not in snap are left untouched -- a rollback
  // caller snapshots+restores the same character set every time, so partial-snapshot semantics never
  // apply in practice, but silently skipping an unknown id here is safer than throwing mid-restore).
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
    this.characters.clear()
    if (!this._filters) return
    this.J.destroy(this._filters.bp); this.J.destroy(this._filters.ol)
    this.J.destroy(this._filters.body); this.J.destroy(this._filters.shape)
    this.J.destroy(this._updateSettings); this.J.destroy(this._charGravity)
    this.J.destroy(this._tmpVec3); this.J.destroy(this._tmpRVec3)
    this._filters = null
  }
}
