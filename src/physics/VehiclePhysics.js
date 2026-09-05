// Vehicle constraint methods for PhysicsWorld (World.js): real Jolt VehicleConstraint
// (WheeledVehicleController + TrackedVehicleController). Split out as World.js's largest
// self-contained block -- every method here only touches PhysicsWorld's own class-level state
// (this.physicsSystem/this._getBody/this.bodyInterface/this._vehicles/this.Jolt) through the same
// accessors the rest of that class uses, so mixing these onto PhysicsWorld.prototype changes
// nothing about the public API or the WASM-interop discipline documented inline below.
//
// WASM-CRASH-AVOIDANCE RULES THIS FILE MUST NOT VIOLATE (see each method's own comment for the
// live-reproduced finding that established the rule):
//   - removeVehicle: do NOT J.destroy(v.constraint) or J.destroy(v.tester) after RemoveConstraint
//     has run -- RemoveConstraint's own destructor chain already drops both refs; destroying either
//     afterward is a real use-after-free WASM trap.
//   - createTrackedVehicle: do NOT J.destroy() a VehicleTrackSettings handle returned by
//     get_mTracks() after set_mTracks() has copied it in -- these are copy-semantics value handles
//     with no Jolt-side ref to release, unlike the constraint/tester RefTarget objects above.
//   - setVehicleDriverInput/setTrackedVehicleDriverInput: a sleeping chassis silently ignores driver
//     input (no error) unless explicitly reactivated first.

const LAYER_DYNAMIC = 1

export function installVehiclePhysics(PhysicsWorld) {
  const proto = PhysicsWorld.prototype

  // Real Jolt VehicleConstraint (WheeledVehicleController) -- vehicles-jolt-wheeled-constraints-app.
  // AGENTS.md's ragdoll-brawl-arena-no-joint-api caveat (2026-07-07) said "no joint/constraint
  // primitive anywhere in World.js" -- that was already stale by the time addConstraint (TwoBody
  // fixed/point/distance/hinge) landed, and a live probe against the ACTUAL jolt-physics 1.1.0
  // WASM build this session (both wasm and wasm-compat -- the .d.ts ships with zero Vehicle* entries,
  // a real type-definition gap, but the compiled WASM module itself exports the full upstream Jolt
  // VehicleConstraint/WheeledVehicleController/TrackedVehicleController surface, ~280 distinct
  // Vehicle*-prefixed bindings) confirms it IS available. A minimal real vehicle (box chassis body +
  // 4 WheelSettingsWV + one rear-wheel-drive VehicleDifferentialSettings + VehicleCollisionTesterRay)
  // was built, stepped 120 real ticks, and drove forward ~4.65m under sustained throttle -- see
  // AGENTS.md audit log entry for this session for the full probe transcript. The single sharpest
  // real gotcha found: WheeledVehicleControllerSettings.mDifferentials defaults to an EMPTY array --
  // with zero differentials configured, engine torque never reaches ANY wheel (a silent no-op: the
  // constraint builds fine, the wheels spin at 0 RPM, the chassis never moves) -- at least one
  // differential entry (mLeftWheel/mRightWheel wheel INDEXES into mWheels, matching the order wheels
  // were push_back'd) is mandatory for a driveable vehicle, not merely a tuning nicety.
  //
  // createWheeledVehicle(chassisBodyId, wheelDefs, opts): wheelDefs is an array of
  // {position:[x,y,z] (chassis-local), radius, width, suspensionMin, suspensionMax, maxSteerAngle,
  // maxBrakeTorque, maxHandBrakeTorque, steer:bool, drive:bool}. opts.up/opts.forward default to
  // [0,1,0]/[0,0,1] (matches this project's Z-forward convention already used by player rotation/yaw
  // elsewhere in this file's caller). Returns a vehicleId (opaque, keyed into this._vehicles) or null.
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
        // Left/right classified by local X sign (chassis-local wheel position) -- matches the probe's
        // convention and every real 4-wheel layout (negative X = left, positive X = right).
        if (w.drive) { if (p[0] < 0) driveIdxL.push(i); else driveIdxR.push(i) }
      }
      vcs.mWheels = wheelsArr

      const controllerSettings = new J.WheeledVehicleControllerSettings()
      const diffs = controllerSettings.mDifferentials
      // opts.differentials lets a caller fully hand-author the diff list (tracked-style split-per-axle
      // setups); default is one differential per drive axle pairing left/right drive wheels 1:1 by
      // position order (covers the common RWD/FWD/AWD single-or-dual-axle case with zero caller config).
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

  // driverInput: forward/right in -1..1, brake/handbrake in 0..1 -- straight passthrough to Jolt's own
  // WheeledVehicleController.SetDriverInput, which internally handles engine RPM/torque/transmission
  // gear-shift simulation every physics step via the registered VehicleConstraintStepListener.
  //
  // REAL BUG independently found+fixed by two sibling sessions the same day (vehicles-tracked-controller-
  // follow-up and vehicles-wheel-visual-wire-sync, both live-reproduced via a real booted server +
  // Playwright drive test): a parked vehicle that settles onto the ground goes to sleep via Jolt's own
  // island-based sleep logic (this project's own aggressive World.js init() sleep tuning --
  // mTimeBeforeSleep=0.25s -- makes a resting chassis fall asleep FAST) same as any other dynamic body,
  // and SetDriverInput alone does NOT wake a sleeping body -- driver input reaches the controller every
  // tick (confirmed via a call-count probe) but a sleeping VehicleConstraint's step listener still runs
  // against an inactive body and produces zero motion, silently -- no error, no thrown exception, the
  // constraint simply has nothing to move. A real player mounting a vehicle that already settled to sleep
  // before they pressed a drive key (the overwhelmingly common case -- a vehicle sits parked for more
  // than ~0.25s before anyone drives it) would find it completely unresponsive. Fix: wake the body on any
  // driver-input call carrying real forward/right/handbrake input -- brake alone is intentionally
  // excluded, since braking an already-sleeping/at-rest vehicle has nothing to do and must not fight the
  // sleep optimization by re-waking it every tick a parked driver holds the brake. Gated on isActive()
  // first so an already-awake vehicle (the common case, mid-drive) pays zero extra native call per tick.
  proto.setVehicleDriverInput = function (vehicleId, forward, right, brake = 0, handbrake = 0) {
    const v = this._vehicles && this._vehicles.get(vehicleId); if (!v) return false
    if ((forward || right || handbrake) && this.bodyInterface.ActivateBody) {
      const chassis = this._getBody(v.chassisBodyId)
      if (chassis && !chassis.IsActive()) this.bodyInterface.ActivateBody(chassis.GetID())
    }
    v.controller.SetDriverInput(forward, right, brake, handbrake)
    return true
  }

  proto.getVehicleWheelTransform = function (vehicleId, wheelIndex) {
    const v = this._vehicles && this._vehicles.get(vehicleId); if (!v) return null
    const J = this.Jolt
    // (bodyRotation, wheelRotationAxis) -- GetWheelWorldTransform's 3rd param is the local rotation
    // axis wheels spin about; [1,0,0] matches the WheelSettingsWV convention (wheel spin axis = local X).
    // Both axes are compile-time constants, so they are built once and reused instead of per call: the
    // two Vec3 temporaries were never destroyed, a measured 80 bytes of WASM heap high-water leaked per
    // call (monotonic over 400k calls), i.e. ~19 KB/s for a 4-wheel vehicle read every tick.
    // Not re-entrant: this method is synchronous with no callback, and the two axes are never mutated.
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
      // v.constraint and v.tester are BOTH Jolt-side ref-counted objects (RefTarget -- same family as
      // the Shape.AddRef/Release convention already documented in addStaticTrimeshAsync). RemoveConstraint's
      // own native destructor chain drops the constraint's ref (which in turn drops its ref on the
      // collision tester it holds) -- live-witnessed: a manual J.destroy(v.constraint) or
      // J.destroy(v.tester) AFTER RemoveConstraint has already run is a real use-after-free ("memory
      // access out of bounds" / "table index is out of bounds" WASM traps, not a benign double-free
      // warning). Do NOT call J.destroy on either -- RemoveConstraint alone is the complete, correct
      // teardown for both.
      this.physicsSystem.RemoveConstraint(v.constraint)
    } catch (e) { console.error('[physics] removeVehicle cleanup error:', e?.message || e) }
    this._vehicles.delete(vehicleId)
    return true
  }

  // Real Jolt TrackedVehicleController -- vehicles-tracked-controller-follow-up, sibling to
  // createWheeledVehicle above. jolt-physics 1.1.0's compiled WASM build was probed live this session
  // (Object.keys(Jolt) against a real `import('jolt-physics/wasm-compat')`) and confirmed to export the
  // full TrackedVehicleController/TrackedVehicleControllerSettings/VehicleTrack/VehicleTrackSettings
  // surface, same undocumented-in-.d.ts situation as the wheeled case.
  //
  // MATERIAL DIFFERENCE from the wheeled settings shape (the row's own instruction to audit before
  // assuming 1:1 parity): TrackedVehicleControllerSettings.mTracks is NOT a push_back-able vector like
  // WheeledVehicleControllerSettings.mDifferentials -- it is a fixed C++ array of exactly 2
  // VehicleTrackSettings (upstream Jolt: `VehicleTrackSettings mTracks[2]`), and VehicleTrackSettings
  // itself has no public constructor (`new J.VehicleTrackSettings()` throws "no constructor in IDL").
  // The embind wrapper exposes this as get_mTracks(index)/set_mTracks(index, value) COPY-semantics
  // accessors (live-probed): get_mTracks(0) returns an independent mutable copy of track 0, mutating
  // that copy does NOT affect get_mTracks(1)'s copy, and the mutated copy must be written back via
  // set_mTracks(index, track) to take effect -- get-mutate-set, not get-and-keep-reference. Track index
  // 0 = left, 1 = right (matches Jolt's own sample/doc convention and this wrapper's driveIdx classification
  // below). Each track's mWheels IS a real push_back-able vector of wheel INDEXES (into mWheels on the
  // parent VehicleConstraintSettings, same indexing convention as the wheeled mDifferentials wheel refs).
  //
  // wheelDefs: array of {position:[x,y,z] chassis-local, radius, width, suspensionMin, suspensionMax,
  // maxBrakeTorque, side:'left'|'right', driven:bool}. Wheels use WheelSettingsTV (Tracked Vehicle) not
  // WheelSettingsWV (Wheeled) -- no steer angle field (tracks steer via differential left/right ratio,
  // not wheel-turn angle). At least one wheel per side must have driven:true set as that side's
  // mDrivenWheel (the wheel index the engine torque/track tension is actually applied through) --
  // otherwise, mirroring the wheeled mDifferentials-empty gotcha, a side with no explicit driven wheel
  // silently defaults mDrivenWheel to 0 (this wrapper's own first-wheel-of-side fallback below), so a
  // caller SHOULD mark one wheel per side driven:true rather than relying on the fallback.
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
        // side classified explicitly (w.side) if given, else by local-X sign (negative = left, matching
        // createWheeledVehicle's own left/right convention) -- same fallback discipline as the wheeled case.
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
      // opts.tracks lets a caller fully hand-author both tracks (explicit wheel-index lists / driven
      // wheel / brake torque), matching createWheeledVehicle's opts.differentials override pattern.
      // Default: classify by side above, driven wheel = first driven:true wheel on that side, or the
      // side's first wheel if none was marked driven (fallback documented in the header comment).
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
      const leftTrack = buildTrack(0, leftIdx, leftDrivenIdx, leftOverride)
      controllerSettings.set_mTracks(0, leftTrack)
      const rightTrack = buildTrack(1, rightIdx, rightDrivenIdx, rightOverride)
      controllerSettings.set_mTracks(1, rightTrack)
      // Deliberately NOT calling J.destroy(leftTrack)/J.destroy(rightTrack) here -- live-probed: destroying
      // either track handle AFTER set_mTracks has copied it in corrupts Jolt's WASM state, surfacing as a
      // "memory access out of bounds" RuntimeError on the NEXT physicsSystem.Step() call (not immediately,
      // making it easy to misattribute) -- same failure-mode CLASS as the documented trimesh-ShapeResult
      // and vehicle-constraint-teardown use-after-free lessons above, but here the correct fix is the
      // opposite of those: never destroy at all rather than destroy-after-use, since get_mTracks(index)
      // copy semantics mean these two small JS wrapper handles have no Jolt-side ref to release (unlike
      // the constraint/tester RefTarget objects, which DO need RemoveConstraint).
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

  // driverInput for a tracked vehicle: forward in -1..1 (throttle/reverse), leftRatio/rightRatio in
  // -1..1 (per-track power ratio -- equal ratios drive straight, differing ratios steer/pivot, matching
  // Jolt's own TrackedVehicleController::SetDriverInput(forward, leftRatio, rightRatio, brake) signature
  // live-confirmed via the probe this session), brake in 0..1. Deliberately a DIFFERENT shape from
  // setVehicleDriverInput's forward/right/brake/handbrake (the row's own instruction: tracks steer via
  // per-side power ratio, not a wheel-turn angle, so a shared signature would be misleading).
  proto.setTrackedVehicleDriverInput = function (vehicleId, forward, leftRatio, rightRatio, brake = 0) {
    const v = this._vehicles && this._vehicles.get(vehicleId); if (!v || !v.tracked) return false
    // Same sleeping-body wake fix as setVehicleDriverInput above -- see that method's header comment
    // for the full live-reproduced finding (a settled/sleeping vehicle ignores driver input silently
    // with zero error until its body is explicitly reactivated).
    if ((forward || leftRatio || rightRatio || brake) && this.bodyInterface?.ActivateBody) {
      const b = this._getBody(v.chassisBodyId); if (b) this.bodyInterface.ActivateBody(b.GetID())
    }
    v.controller.SetDriverInput(forward, leftRatio, rightRatio, brake)
    return true
  }
}
