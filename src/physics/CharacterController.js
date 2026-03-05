export class CharacterController {
  constructor(world) { this._world = world; this.characters = new Map(); this._shapes = new Map(); this._filters = null; this._settings = null; this._gravity = null; this._nextId = 1 }
  add(radius, halfHeight, pos, mass) {
    const J = this._world.Jolt, cvs = new J.CharacterVirtualSettings(); cvs.mMass = mass || 80; cvs.mMaxSlopeAngle = 0.7854; cvs.mShape = new J.CapsuleShape(halfHeight, radius); cvs.mBackFaceMode = J.EBackFaceMode_CollideWithBackFaces; cvs.mCharacterPadding = 0.02; cvs.mPenetrationRecoverySpeed = 1.0; cvs.mPredictiveContactDistance = 0.1; cvs.mSupportingVolume = new J.Plane(J.Vec3.prototype.sAxisY(), -radius)
    const ch = new J.CharacterVirtual(cvs, new J.RVec3(pos[0], pos[1], pos[2]), J.Quat.prototype.sIdentity(), this._world.physicsSystem); J.destroy(cvs)
    if (!this._filters) {
      const L_D = 1; this._filters = { bp: new J.DefaultBroadPhaseLayerFilter(this._world.jolt.GetObjectVsBroadPhaseLayerFilter(), L_D), ol: new J.DefaultObjectLayerFilter(this._world.jolt.GetObjectLayerPairFilter(), L_D), body: new J.BodyFilter(), shape: new J.ShapeFilter() }
      this._settings = new J.ExtendedUpdateSettings(); this._settings.mStickToFloorStepDown = new J.Vec3(0, -0.5, 0); this._settings.mWalkStairsStepUp = new J.Vec3(0, 0.4, 0); this._gravity = new J.Vec3(this._world.gravity[0], this._world.gravity[1], this._world.gravity[2])
    }
    const id = this._nextId++; this.characters.set(id, ch); this._shapes.set(id, { radius, standHeight: halfHeight, crouchHeight: this._world.crouchHalfHeight }); return id
  }
  update(id, dt) { const ch = this.characters.get(id); if (ch) ch.ExtendedUpdate(dt, this._gravity, this._settings, this._filters.bp, this._filters.ol, this._filters.body, this._filters.shape, this._world.jolt.GetTempAllocator()) }
  setPosition(id, x, y, z) { const ch = this.characters.get(id); if (ch) { const p = this._world._tmpRVec3; p.Set(x, y, z); ch.SetPosition(p) } }
  setVelocity(id, x, y, z) { const ch = this.characters.get(id); if (ch) { const v = this._world._tmpVec3; v.Set(x, y, z); ch.SetLinearVelocity(v) } }
  getPosition(id, out) { const ch = this.characters.get(id); if (ch && out) { const p = ch.GetPosition(); out[0] = p.GetX(); out[1] = p.GetY(); out[2] = p.GetZ() } }
  getVelocity(id, out) { const ch = this.characters.get(id); if (ch && out) { const v = ch.GetLinearVelocity(); out[0] = v.GetX(); out[1] = v.GetY(); out[2] = v.GetZ(); this._world.Jolt.destroy(v) } }
  getGroundState(id) { const ch = this.characters.get(id); return ch ? ch.GetGroundState() === this._world.Jolt.EGroundState_OnGround : false }
  setCrouch(id, isCrouching) {
    const d = this._shapes.get(id); if (!d) return; const ch = this.characters.get(id); if (!ch) return
    const diff = (d.standHeight - d.crouchHeight) * 0.5; const pos = [0,0,0]; this.getPosition(id, pos)
    if (isCrouching) pos[1] -= diff; else pos[1] += diff; this.setPosition(id, pos[0], pos[1], pos[2])
  }
  remove(id) { const ch = this.characters.get(id); if (ch) { this._world.Jolt.destroy(ch); this.characters.delete(id); this._shapes.delete(id) } }
  destroy() { for (const ch of this.characters.values()) this._world.Jolt.destroy(ch); this.characters.clear(); if (this._filters) { const J = this._world.Jolt; J.destroy(this._filters.bp); J.destroy(this._filters.ol); J.destroy(this._filters.body); J.destroy(this._filters.shape); J.destroy(this._settings); J.destroy(this._gravity) } }
}
