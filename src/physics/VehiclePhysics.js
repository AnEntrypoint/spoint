const LAYER_DYNAMIC = 1
const LEFT_TRACK = 0, RIGHT_TRACK = 1

export function installVehiclePhysics(PhysicsWorld) {
  const proto = PhysicsWorld.prototype

  proto.createWheeledVehicle = function (chassisBodyId, wheelDefs, opts = {}) {
    if (!this.physicsSystem) return null
    const chassis = this._getBody(chassisBodyId); if (!chassis) return null
    if (!Array.isArray(wheelDefs) || wheelDefs.length === 0) return null
    const J = this.Jolt
    let vcs = null, wheelSettingsList = [], constraint = null, tester = null, stepListener = null
    try {
      vcs = new J.VehicleConstraintSettings()
      const up = opts.up || [0, 1, 0], fwd = opts.forward || [0, 0, 1]
      vcs.mUp = new J.Vec3(up[0], up[1], up[2])
      vcs.mForward = new J.Vec3(fwd[0], fwd[1], fwd[2])
      if (opts.maxPitchRollAngle != null) vcs.mMaxPitchRollAngle = opts.maxPitchRollAngle

      const wheelsArr = vcs.mWheels
      const driveIdxL = [], driveIdxR = []
      for (let i = 0; i < wheelDefs.length; i++) {
        const w = wheelDefs[i] || {}
        const ws = new J.WheelSettingsWV()
        const p = w.position || [0, 0, 0]
        ws.mPosition = new J.Vec3(p[0], p[1], p[2])
        if (w.suspensionDirection) { const sd = w.suspensionDirection; ws.mSuspensionDirection = new J.Vec3(sd[0], sd[1], sd[2]) }
        ws.mRadius = w.radius ?? 0.35
        ws.mWidth = w.width ?? 0.25
        ws.mSuspensionMinLength = w.suspensionMin ?? 0.3
        ws.mSuspensionMaxLength = w.suspensionMax ?? 0.5
        ws.mMaxSteerAngle = w.steer ? (w.maxSteerAngle ?? 0.6) : 0
        ws.mMaxBrakeTorque = w.maxBrakeTorque ?? 1500
        ws.mMaxHandBrakeTorque = w.maxHandBrakeTorque ?? 0
        wheelSettingsList.push(ws)
        wheelsArr.push_back(ws)
        if (w.drive) { if (p[0] < 0) driveIdxL.push(i); else driveIdxR.push(i) }
      }
      vcs.mWheels = wheelsArr

      const controllerSettings = new J.WheeledVehicleControllerSettings()
      const diffs = controllerSettings.mDifferentials
      if (Array.isArray(opts.differentials) && opts.differentials.length) {
        for (const d of opts.differentials) {
          const vd = new J.VehicleDifferentialSettings()
          vd.mLeftWheel = d.leftWheel ?? -1; vd.mRightWheel = d.rightWheel ?? -1
          if (d.differentialRatio != null) vd.mDifferentialRatio = d.differentialRatio
          if (d.limitedSlipRatio != null) vd.mLimitedSlipRatio = d.limitedSlipRatio
          if (d.engineTorqueRatio != null) vd.mEngineTorqueRatio = d.engineTorqueRatio
          diffs.push_back(vd)
        }
      } else {
        const n = Math.max(driveIdxL.length, driveIdxR.length)
        for (let i = 0; i < n; i++) {
          const vd = new J.VehicleDifferentialSettings()
          vd.mLeftWheel = driveIdxL[i] ?? -1; vd.mRightWheel = driveIdxR[i] ?? -1
          vd.mEngineTorqueRatio = 1 / n
          diffs.push_back(vd)
        }
      }
      controllerSettings.mDifferentials = diffs
      if (opts.engine) {
        if (opts.engine.maxTorque != null) controllerSettings.mEngine.mMaxTorque = opts.engine.maxTorque
        if (opts.engine.maxRPM != null) controllerSettings.mEngine.mMaxRPM = opts.engine.maxRPM
        if (opts.engine.minRPM != null) controllerSettings.mEngine.mMinRPM = opts.engine.minRPM
      }
      vcs.mController = controllerSettings

      constraint = new J.VehicleConstraint(chassis, vcs)
      tester = new J.VehicleCollisionTesterRay(LAYER_DYNAMIC, new J.Vec3(up[0], up[1], up[2]))
      constraint.SetVehicleCollisionTester(tester)
      this.physicsSystem.AddConstraint(constraint)
      stepListener = new J.VehicleConstraintStepListener(constraint)
      this.physicsSystem.AddStepListener(stepListener)

      const controller = J.castObject(constraint.GetController(), J.WheeledVehicleController)
      const vid = (this._nextVehicleId = (this._nextVehicleId || 0) + 1)
      if (!this._vehicles) this._vehicles = new Map()
      this._vehicles.set(vid, { constraint, controller, tester, stepListener, chassisBodyId, wheelCount: wheelDefs.length })
      return vid
    } catch (e) {
      console.error('[physics] createWheeledVehicle failed:', e?.message || e)
      return null
    } finally { if (vcs) J.destroy(vcs) }
  }

  proto.setVehicleDriverInput = function (vehicleId, forward, right, brake = 0, handbrake = 0) {
    const v = this._vehicles && this._vehicles.get(vehicleId); if (!v) return false
    const inputNeedsAwakeChassis = forward || right || handbrake
    if (inputNeedsAwakeChassis && this.bodyInterface.ActivateBody) {
      const chassis = this._getBody(v.chassisBodyId)
      if (chassis && !chassis.IsActive()) this.bodyInterface.ActivateBody(chassis.GetID())
    }
    v.controller.SetDriverInput(forward, right, brake, handbrake)
    return true
  }

  proto.getVehicleWheelTransform = function (vehicleId, wheelIndex) {
    const v = this._vehicles && this._vehicles.get(vehicleId); if (!v) return null
    const J = this.Jolt
    let ax = this._vehWheelAxes
    if (!ax) ax = this._vehWheelAxes = { right: new J.Vec3(1, 0, 0), up: new J.Vec3(0, 1, 0) }
    const t = v.constraint.GetWheelWorldTransform(wheelIndex, ax.right, ax.up)
    const pos = t.GetTranslation(), rot = t.GetQuaternion()
    const out = { position: [pos.GetX(), pos.GetY(), pos.GetZ()], rotation: [rot.GetX(), rot.GetY(), rot.GetZ(), rot.GetW()] }
    J.destroy(t)
    return out
  }
  proto.getVehicleWheelSpeed = function (vehicleId, wheelIndex) {
    const v = this._vehicles && this._vehicles.get(vehicleId); if (!v) return 0
    const w = v.constraint.GetWheel(wheelIndex)
    return w ? w.GetAngularVelocity() : 0
  }
  proto.isVehicleWheelGrounded = function (vehicleId, wheelIndex) {
    const v = this._vehicles && this._vehicles.get(vehicleId); if (!v) return false
    const w = v.constraint.GetWheel(wheelIndex)
    return w ? w.HasContact() : false
  }
  proto.removeVehicle = function (vehicleId) {
    const v = this._vehicles && this._vehicles.get(vehicleId); if (!v || !this.physicsSystem) return false
    const J = this.Jolt
    try {
      this.physicsSystem.RemoveStepListener(v.stepListener)
      J.destroy(v.stepListener)
      this.physicsSystem.RemoveConstraint(v.constraint)
    } catch (e) { console.error('[physics] removeVehicle cleanup error:', e?.message || e) }
    this._vehicles.delete(vehicleId)
    return true
  }

  proto.createTrackedVehicle = function (chassisBodyId, wheelDefs, opts = {}) {
    if (!this.physicsSystem) return null
    const chassis = this._getBody(chassisBodyId); if (!chassis) return null
    if (!Array.isArray(wheelDefs) || wheelDefs.length === 0) return null
    const J = this.Jolt
    let vcs = null, wheelSettingsList = [], constraint = null, tester = null, stepListener = null
    try {
      vcs = new J.VehicleConstraintSettings()
      const up = opts.up || [0, 1, 0], fwd = opts.forward || [0, 0, 1]
      vcs.mUp = new J.Vec3(up[0], up[1], up[2])
      vcs.mForward = new J.Vec3(fwd[0], fwd[1], fwd[2])
      if (opts.maxPitchRollAngle != null) vcs.mMaxPitchRollAngle = opts.maxPitchRollAngle

      const wheelsArr = vcs.mWheels
      const leftIdx = [], rightIdx = [], leftDrivenIdx = [], rightDrivenIdx = []
      for (let i = 0; i < wheelDefs.length; i++) {
        const w = wheelDefs[i] || {}
        const ws = new J.WheelSettingsTV()
        const p = w.position || [0, 0, 0]
        ws.mPosition = new J.Vec3(p[0], p[1], p[2])
        if (w.suspensionDirection) { const sd = w.suspensionDirection; ws.mSuspensionDirection = new J.Vec3(sd[0], sd[1], sd[2]) }
        ws.mRadius = w.radius ?? 0.35
        ws.mWidth = w.width ?? 0.4
        ws.mSuspensionMinLength = w.suspensionMin ?? 0.3
        ws.mSuspensionMaxLength = w.suspensionMax ?? 0.5
        if (w.maxBrakeTorque != null) ws.mMaxBrakeTorque = w.maxBrakeTorque
        wheelSettingsList.push(ws)
        wheelsArr.push_back(ws)
        const side = w.side || (p[0] < 0 ? 'left' : 'right')
        if (side === 'left') { leftIdx.push(i); if (w.driven) leftDrivenIdx.push(i) }
        else { rightIdx.push(i); if (w.driven) rightDrivenIdx.push(i) }
      }
      vcs.mWheels = wheelsArr

      const controllerSettings = new J.TrackedVehicleControllerSettings()
      if (opts.engine) {
        if (opts.engine.maxTorque != null) controllerSettings.mEngine.mMaxTorque = opts.engine.maxTorque
        if (opts.engine.maxRPM != null) controllerSettings.mEngine.mMaxRPM = opts.engine.maxRPM
        if (opts.engine.minRPM != null) controllerSettings.mEngine.mMinRPM = opts.engine.minRPM
      }
      const buildTrack = (trackIndex, idxList, drivenList, override) => {
        const t = controllerSettings.get_mTracks(trackIndex)
        const wv = t.mWheels
        const list = (override && Array.isArray(override.wheels)) ? override.wheels : idxList
        for (const wi of list) wv.push_back(wi)
        t.mWheels = wv
        const drivenWheel = override && override.drivenWheel != null ? override.drivenWheel : (drivenList[0] ?? idxList[0] ?? 0)
        t.mDrivenWheel = drivenWheel
        if ((override && override.maxBrakeTorque != null)) t.mMaxBrakeTorque = override.maxBrakeTorque
        if ((override && override.differentialRatio != null)) t.mDifferentialRatio = override.differentialRatio
        return t
      }
      const leftOverride = opts.tracks && opts.tracks.left
      const rightOverride = opts.tracks && opts.tracks.right
      const leftTrack = buildTrack(LEFT_TRACK, leftIdx, leftDrivenIdx, leftOverride)
      controllerSettings.set_mTracks(LEFT_TRACK, leftTrack)
      const rightTrack = buildTrack(RIGHT_TRACK, rightIdx, rightDrivenIdx, rightOverride)
      controllerSettings.set_mTracks(RIGHT_TRACK, rightTrack)
      vcs.mController = controllerSettings

      constraint = new J.VehicleConstraint(chassis, vcs)
      tester = new J.VehicleCollisionTesterRay(LAYER_DYNAMIC, new J.Vec3(up[0], up[1], up[2]))
      constraint.SetVehicleCollisionTester(tester)
      this.physicsSystem.AddConstraint(constraint)
      stepListener = new J.VehicleConstraintStepListener(constraint)
      this.physicsSystem.AddStepListener(stepListener)

      const controller = J.castObject(constraint.GetController(), J.TrackedVehicleController)
      const vid = (this._nextVehicleId = (this._nextVehicleId || 0) + 1)
      if (!this._vehicles) this._vehicles = new Map()
      this._vehicles.set(vid, { constraint, controller, tester, stepListener, chassisBodyId, wheelCount: wheelDefs.length, tracked: true })
      return vid
    } catch (e) {
      console.error('[physics] createTrackedVehicle failed:', e?.message || e)
      return null
    } finally { if (vcs) J.destroy(vcs) }
  }

  proto.setTrackedVehicleDriverInput = function (vehicleId, forward, leftRatio, rightRatio, brake = 0) {
    const v = this._vehicles && this._vehicles.get(vehicleId); if (!v || !v.tracked) return false
    if ((forward || leftRatio || rightRatio || brake) && this.bodyInterface?.ActivateBody) {
      const b = this._getBody(v.chassisBodyId); if (b) this.bodyInterface.ActivateBody(b.GetID())
    }
    v.controller.SetDriverInput(forward, leftRatio, rightRatio, brake)
    return true
  }
}
