// A placeable, driveable TANK using a REAL Jolt TrackedVehicleController constraint -- sibling to
// apps/vehicle's WheeledVehicleController car (vehicles-tracked-controller-follow-up, split out of
// vehicles-jolt-wheeled-constraints-app). The constraint-availability question was already answered by
// that row's session (jolt-physics 1.1.0's compiled WASM build exports the full TrackedVehicleController/
// TrackedVehicleControllerSettings/VehicleTrack/VehicleTrackSettings surface, same undocumented-in-.d.ts
// situation as the wheeled case) -- this app is pure implementation reusing that probe result.
//
// MATERIAL DIFFERENCE from apps/vehicle's driver-input model (the row's own instruction, confirmed via a
// live probe before writing World.js's wrapper -- see createTrackedVehicle's header comment there): a
// tracked vehicle steers via PER-TRACK POWER RATIO (SetDriverInput(forward, leftRatio, rightRatio,
// brake)), not a wheel-turn steering angle -- equal ratios drive straight, differing ratios curve/pivot
// (a ratio of 0 on one side while the other holds full power pivots roughly in place, real tank-style
// steering). This app maps WASD the same way apps/vehicle does for forward/back (analogForward or
// forward/backward keys) but derives leftRatio/rightRatio from the SAME right/analogRight input instead
// of a steer angle: right input differentially reduces the opposite-side ratio (right-turn input scales
// the left track down while holding the right track at full, and vice versa) rather than aiming wheels.
//
// Mount/dismount/driver-input-routing/teardown-before-hot-reload all reuse the EXACT same pattern
// apps/vehicle/index.js already established (ctx.interactable+onInteract, ctx.players.getById(driverId)
// .lastInput, ctx.players.setPosition each tick, teardown(ctx) releasing the constraint) per the row's
// own instruction not to re-derive it.
//
// SCOPE (first-slice, same follow-up-row discipline as apps/vehicle):
//   - Tracked only (this app). Wheeled car is the sibling apps/vehicle app.
//   - Single driver seat only, no passenger/turret gunner seat.
//   - Wheel/track visuals are NOT wire-synced -- same documented gap as apps/vehicle
//     (vehicles-wheel-visual-wire-sync); this app renders a plain box chassis client-side, zero track
//     meshes, matching apps/vehicle's own first-slice scope exactly.
//   - No turret/cannon gameplay layer -- pure drive/steer/brake movement primitive, same as apps/vehicle.
//   - NOT exempted from AppRuntimePhysics' hard-activation-ring physics LOD -- same documented gap as
//     apps/vehicle (vehicles-physics-lod-exemption), tracked by the same sibling PRD row (that row's
//     scope already covers "vehicle chassis bodies" generically, not wheeled-only).
export default {
  description: 'Driveable tank (real Jolt TrackedVehicleController): press E to enter/exit, WASD to drive/pivot.',
  server: {
    bodyType: 'dynamic',
    editorProps: [
      { key: 'color', label: 'Color', type: 'color', default: '#4a5d23' },
      { key: 'mass', label: 'Mass (kg)', type: 'range', min: 1000, max: 12000, step: 500, default: 6000 },
      { key: 'maxTorque', label: 'Engine torque', type: 'range', min: 200, max: 3000, step: 100, default: 1200 },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      const hx = 1.2, hy = 0.5, hz = 2.4
      ctx.entity.custom = { ...(ctx.entity.custom || {}), mesh: 'box', color: c.color ?? '#4a5d23', sx: hx * 2, sy: hy * 2, sz: hz * 2, vehicle: true, tracked: true }
      ctx.physics.addColliderFromConfig({ type: 'box', size: [hx, hy, hz], mass: c.mass ?? 6000, dynamic: true, ccd: 'always' })
      // 6 wheels: 3 per side, spaced along the chassis length. Middle wheel of each side is the driven
      // wheel (mDrivenWheel) -- matches this row's probe convention (World.js createTrackedVehicle's
      // header comment: a side with no explicit driven:true wheel silently falls back to its first wheel).
      const zs = [hz - 0.6, 0, -(hz - 0.6)]
      const wheelDefs = []
      for (let i = 0; i < zs.length; i++) wheelDefs.push({ position: [-hx, -hy, zs[i]], radius: 0.4, width: 0.3, suspensionMin: 0.25, suspensionMax: 0.45, maxBrakeTorque: 2500, side: 'left', driven: i === 1 })
      for (let i = 0; i < zs.length; i++) wheelDefs.push({ position: [hx, -hy, zs[i]], radius: 0.4, width: 0.3, suspensionMin: 0.25, suspensionMax: 0.45, maxBrakeTorque: 2500, side: 'right', driven: i === 1 })
      const vid = ctx.physics.createTrackedVehicle(wheelDefs, { engine: { maxTorque: c.maxTorque ?? 1200 } })
      if (vid == null) ctx.debug.warn('[tank] createTrackedVehicle failed -- driving input will be a no-op (chassis still exists as plain dynamic prop)')
      ctx.interactable({ prompt: 'Press E to drive', radius: 3.5 })
      ctx.state._driverId = null
    },
    onInteract(ctx, player) {
      const pid = player?.id; if (pid == null) return
      if (ctx.state._driverId === pid) {
        ctx.players.setMovementOverride(pid, null)
        ctx.physics.setTrackedVehicleInput(0, 0, 0, 1) // full brake on dismount so an unmanned tank doesn't coast
        ctx.state._driverId = null
        ctx.entity.custom = { ...(ctx.entity.custom || {}), driverId: null }
        return
      }
      if (ctx.state._driverId != null) return // occupied by someone else
      ctx.state._driverId = pid
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
      const turn = hasAnalog ? (inp.analogRight || 0) : ((inp.right ? 1 : 0) - (inp.left ? 1 : 0))
      const brake = inp.crouch ? 1 : 0
      // Differential track power from a single turn axis: positive turn (right) scales the LEFT track
      // down while the right track holds full power (and vice versa for negative/left) -- the standard
      // tank-steer mapping. Clamped to [-1,1] like every other ratio input this constraint accepts.
      const leftRatio = Math.max(-1, Math.min(1, turn > 0 ? 1 - turn * 2 : 1))
      const rightRatio = Math.max(-1, Math.min(1, turn < 0 ? 1 + turn * 2 : 1))
      ctx.physics.setTrackedVehicleInput(forward, leftRatio, rightRatio, brake)
      ctx.players.setPosition(driverId, [ctx.entity.position[0], ctx.entity.position[1] + 0.7, ctx.entity.position[2]])
    },
    teardown(ctx) {
      const driverId = ctx.state?._driverId
      if (driverId != null) ctx.players.setMovementOverride(driverId, null)
      if (ctx.physics.hasVehicle()) ctx.physics.destroyVehicle()
    },
  },
}
