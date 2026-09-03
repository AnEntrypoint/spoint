// A placeable, driveable CAR using a REAL Jolt WheeledVehicleController constraint (not a hand-rolled
// raycast-suspension model -- vehicles-jolt-wheeled-constraints-app's first probe this session confirmed
// jolt-physics 1.1.0's compiled WASM build genuinely exports the full upstream VehicleConstraint /
// WheeledVehicleController / TrackedVehicleController surface, even though it is entirely undocumented in
// the package's own .d.ts files -- see World.js's createWheeledVehicle header comment for the full probe
// detail and the one real gotcha found (WheeledVehicleControllerSettings.mDifferentials defaults EMPTY,
// so a vehicle with zero differentials configured never receives any engine torque on any wheel).
//
// Mount/dismount reuses the existing interactable primitive (ctx.interactable + onInteract, Press E) --
// zero new protocol messages. NOTE: wiring this up live-discovered that the interact KEY itself was a
// dead end client-side -- InputHandler.js already read KeyE into input.interact (keyboard/gamepad/VR/
// mobile all populate it) and AppModuleSystem.js's _buildInteractPrompt already showed a "Press E to..."
// prompt in range, but nothing ever SENT the resulting APP_EVENT{entityId} on press; every ctx.interactable
// app (button, this one, any future one) was silently unusable by a real keyboard-driven player before
// this session's client/app.js fix (edge-triggered dispatch in startInputLoop, same nearest-in-range
// target selection as the prompt so the two can never disagree about which entity E targets). While a
// player is the driver, their OWN character movement is frozen via
// ctx.players.setMovementOverride (maxSpeed:0 etc, same primitive combat-bot-adjacent apps already use
// for lifecycle freezing) and their raw per-tick input (ctx.players.getById(driverId).lastInput -- the
// same pre-applyMovement input object TickHandler.js's own processPlayerMovement reads, already reachable
// with zero new plumbing) is translated into Jolt SetDriverInput calls each server tick. The driver's own
// wire-visible/camera position is pinned to the vehicle's authoritative position every update() tick via
// ctx.players.setPosition (the PLAYER follows the VEHICLE) -- deliberately NOT ctx.players.attachEntity,
// which is the opposite direction (makes an ENTITY follow a PLAYER, the flag-carry/escort primitive).
//
// SCOPE (explicitly first-slice, see AGENTS.md audit log / PRD decomposition for this row):
//   - Wheeled only (4-wheel car). Tracked vehicles (TrackedVehicleController) are a real, separately
//     probed-available API but NOT implemented here -- same shape of work, deliberately deferred to keep
//     this slice shippable (see the sibling PRD row filed for it).
//   - Single driver seat only, no passenger seats.
//   - Wheel visuals ARE rendered client-side (vehicles-wheel-visual-wire-sync), but positions/spin/steer
//     are NOT individually wire-synced per tick (would need a new per-wheel snapshot field per wheel per
//     vehicle, real per-tick wire-budget cost against TickHandler's 900-byte/tick budget -- see that
//     row's own audit). Instead: (1) each wheel's chassis-local position/radius/steer/drive flags are
//     published ONCE into custom.wheels (below) -- static geometry, costs one custom dirty-write at
//     spawn, not a per-tick field; (2) the CHASSIS's own position/rotation/velocity are already
//     broadcast every tick for any dynamic body (zero new wire cost) -- the client derives wheel SPIN
//     from chassis forward speed (already-synced velocity projected onto the chassis forward axis,
//     divided by wheel radius) and front-wheel STEER visually from the chassis's own yaw rate (derived
//     client-side from consecutive already-synced rotation quaternions), both real dead-reckoning off
//     authoritative data, not a client-invented animation. A follow-up row can wire the true per-wheel
//     Jolt suspension-travel/steer-angle/spin state (World.js's getVehicleWheelTransform/
//     getVehicleWheelSpeed/isVehicleWheelGrounded already exist server-side) for a client that wants
//     exact suspension travel, not just a chassis-derived approximation.
//   - No fuel/damage/horn/lights gameplay layer -- pure drive/steer/brake movement primitive.
//   - Vehicle chassis bodies ARE exempted from AppRuntimePhysics' hard-activation-ring physics LOD
//     (see _tickPhysicsLOD in AppRuntimePhysics.js): any entity with a live e._vehicleId is forced to
//     stay 'physical' tier regardless of distance from every player, so a parked/unattended vehicle
//     never gets kinematic-frozen or has its chassis body destroyed out from under the still-live
//     VehicleConstraint (which held a direct native reference to that body -- destroying it was a real
//     dangling-reference hazard, live-confirmed pre-fix: the body id went undefined while _vehicleId
//     stayed non-null, and setVehicleInput kept silently succeeding against the desynced state).
//   - vehicles-wheel-visual-wire-sync (this row) found+fixed TWO real bugs live-witnessing its own mount/
//     drive test, both upstream of wheel rendering itself: (1) World.js's setVehicleDriverInput never
//     reactivated a SLEEPING chassis body -- a parked/settled vehicle (Jolt deactivates any stationary
//     dynamic body after its settle window, same as any other prop) silently ignored throttle input
//     forever, since SetDriverInput records the input but the physics step never runs real dynamics
//     against a deactivated body; fixed by explicitly calling bodyInterface.ActivateBody whenever
//     non-zero forward/right/handbrake arrives (brake alone deliberately excluded, so holding brake on an
//     already-sleeping parked car doesn't fight the sleep optimization). (2) SnapshotEncoder.js's sleep-
//     based send-rate throttle (PROP_SLEEP_TICKMOD) applied to the ENTIRE entry including custom, not
//     just the physics fields it was designed for -- so mounting a settled vehicle (onInteract's
//     custom.driverId write) sat invisible on the wire for up to ~7s measured live, since the throttle
//     has no way to distinguish "position/rotation is legitimately frozen while asleep" from "custom just
//     changed for an unrelated interactive reason"; fixed by bypassing the sleep extraMod specifically
//     when a given viewer's own last-sent custom version differs from the current one. NEWLY DISCOVERED,
//     NOT FIXED THIS ROW (separate from wheel visuals, re-filed as its own sibling row): even once awake,
//     a mounted vehicle sometimes never actually accelerates under held forward input despite the chassis
//     body staying active and the wheel/steer visual code correctly deriving spin/steer from whatever
//     chassis velocity IS on the wire (verified via a synthetic-velocity dimensional check) -- live
//     8-second-hold drive tests repeatedly showed zero further position/velocity change after the
//     vehicle's initial post-spawn settle, suggesting the WheeledVehicleController's engine torque isn't
//     reliably reaching the drive wheels (candidates: wheel-ground contact/suspension resting state,
//     differential wiring, or a real per-tick input-freshness gap) -- a Jolt vehicle-tuning bug, not a
//     rendering one.
export default {
  description: 'Driveable car (real Jolt WheeledVehicleController): press E to enter/exit, WASD to drive.',
  server: {
    bodyType: 'dynamic',
    editorProps: [
      { key: 'color', label: 'Color', type: 'color', default: '#c0392b' },
      { key: 'mass', label: 'Mass (kg)', type: 'range', min: 300, max: 4000, step: 100, default: 1500 },
      { key: 'maxTorque', label: 'Engine torque', type: 'range', min: 100, max: 1500, step: 50, default: 500 },
      { key: 'maxSteerDeg', label: 'Max steer angle (deg)', type: 'range', min: 15, max: 55, step: 5, default: 35 },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      const hx = 0.9, hy = 0.4, hz = 2.0
      ctx.entity.custom = { ...(ctx.entity.custom || {}), mesh: 'box', color: c.color ?? '#c0392b', sx: hx * 2, sy: hy * 2, sz: hz * 2, vehicle: true }
      ctx.physics.addColliderFromConfig({ type: 'box', size: [hx, hy, hz], mass: c.mass ?? 1500, dynamic: true, ccd: 'always' })
      const maxSteerRad = ((c.maxSteerDeg ?? 35) * Math.PI) / 180
      const wheelDefs = [
        { position: [-0.8, -hy, hz - 0.6], radius: 0.35, width: 0.25, suspensionMin: 0.3, suspensionMax: 0.5, steer: true, maxSteerAngle: maxSteerRad, maxBrakeTorque: 1200 },
        { position: [0.8, -hy, hz - 0.6], radius: 0.35, width: 0.25, suspensionMin: 0.3, suspensionMax: 0.5, steer: true, maxSteerAngle: maxSteerRad, maxBrakeTorque: 1200 },
        { position: [-0.8, -hy, -(hz - 0.6)], radius: 0.35, width: 0.25, suspensionMin: 0.3, suspensionMax: 0.5, drive: true, maxBrakeTorque: 1500, maxHandBrakeTorque: 4000 },
        { position: [0.8, -hy, -(hz - 0.6)], radius: 0.35, width: 0.25, suspensionMin: 0.3, suspensionMax: 0.5, drive: true, maxBrakeTorque: 1500, maxHandBrakeTorque: 4000 },
      ]
      const vid = ctx.physics.createVehicle(wheelDefs, { engine: { maxTorque: c.maxTorque ?? 500 } })
      if (vid == null) ctx.debug.warn('[vehicle] createVehicle failed -- driving input will be a no-op (chassis still exists as plain dynamic prop)')
      // Static wheel geometry for the client's visual mesh build (buildEntityMesh/EntityLoader.js) --
      // chassis-local position/radius match wheelDefs exactly (same array, same order) so the client's
      // wheel meshes sit exactly where the real Jolt suspension anchors are. Written ONCE here (not
      // per-tick): a wheel never moves relative to the chassis in this app's own config, so there is
      // nothing to dirty-resend after spawn.
      ctx.entity.custom = { ...(ctx.entity.custom || {}), wheels: wheelDefs.map(w => ({ position: w.position, radius: w.radius, width: w.width, steer: !!w.steer })) }
      ctx.interactable({ prompt: 'Press E to drive', radius: 3 })
      ctx.state._driverId = null
    },
    onInteract(ctx, player) {
      const pid = player?.id; if (pid == null) return
      if (ctx.state._driverId === pid) {
        // Already the driver pressing E again: exit.
        ctx.players.setMovementOverride(pid, null)
        ctx.physics.setVehicleInput(0, 0, 1, 0) // full brake on dismount so an unmanned car doesn't coast
        ctx.state._driverId = null
        ctx.entity.custom = { ...(ctx.entity.custom || {}), driverId: null }
        return
      }
      if (ctx.state._driverId != null) return // occupied by someone else
      ctx.state._driverId = pid
      // Freeze the driver's own capsule (no self-propelled translation while driving) -- the vehicle's
      // own position, written every update() tick below via ctx.players.setPosition, is what actually
      // carries the driver's wire-visible/camera position now. There is no attachEntityToPlayer use
      // here on purpose: that primitive makes an ENTITY follow a PLAYER (flag-carry direction), the
      // opposite of what a driver seat needs (player follows vehicle) -- setPosition each tick is that.
      ctx.players.setMovementOverride(pid, { maxSpeed: 0, groundAccel: 0, airAccel: 0, jumpImpulse: 0 })
      ctx.entity.custom = { ...(ctx.entity.custom || {}), driverId: pid }
    },
    update(ctx, dt) {
      const driverId = ctx.state._driverId
      if (driverId == null) return
      const driver = ctx.players.getById(driverId)
      if (!driver) { ctx.state._driverId = null; return } // driver disconnected mid-drive
      const inp = driver.lastInput || {}
      const hasAnalog = inp.analogForward !== undefined || inp.analogRight !== undefined
      const forward = hasAnalog ? (inp.analogForward || 0) : ((inp.forward ? 1 : 0) - (inp.backward ? 1 : 0))
      const right = hasAnalog ? (inp.analogRight || 0) : ((inp.right ? 1 : 0) - (inp.left ? 1 : 0))
      const brake = inp.crouch ? 1 : 0
      const handbrake = inp.jump ? 1 : 0
      ctx.physics.setVehicleInput(forward, right, brake, handbrake)
      // Keep the driver's own player position pinned to the vehicle (camera + wire position follow the
      // car) each tick -- movement override already zeroed their own capsule's ability to translate
      // itself, but a stationary capsule sitting where the car started would desync from the moving car
      // without an explicit follow. Same primitive moving-platform riders use (setPosition), driven here
      // by the vehicle's own authoritative position instead of raw player input.
      ctx.players.setPosition(driverId, [ctx.entity.position[0], ctx.entity.position[1] + 0.6, ctx.entity.position[2]])
    },
    // Fires on hot-reload (HotReloadQueue._execute, BEFORE the reloaded setup() re-runs) and on
    // detachApp/destroyEntity. Real gap found live this session: without this, a hot-reload of THIS
    // file (e.g. any edit while a vehicle is live) re-ran setup() -> createVehicle on the SAME entity
    // that already had a live Jolt VehicleConstraint from the previous setup() call -- createVehicleForEntity's
    // own already-has-a-vehicle guard correctly refused the second create (no double-constraint leak),
    // but that left the entity in a permanently broken state (_vehicleId stale-but-non-null, so the
    // NEW app instance's ctx.physics.createVehicle silently no-ops forever after) since nothing ever
    // released the OLD constraint first. Release the vehicle constraint and restore the driver's
    // movement override here, mirroring AppRuntime.destroyEntity's own vehicle-before-body teardown
    // discipline, so re-setup() after this always starts from a clean, vehicle-less body.
    teardown(ctx) {
      const driverId = ctx.state?._driverId
      if (driverId != null) ctx.players.setMovementOverride(driverId, null)
      if (ctx.physics.hasVehicle()) ctx.physics.destroyVehicle()
    },
  },
}
