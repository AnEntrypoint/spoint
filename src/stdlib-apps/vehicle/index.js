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
      ctx.entity.custom = { ...(ctx.entity.custom || {}), wheels: wheelDefs.map(w => ({ position: w.position, radius: w.radius, width: w.width, steer: !!w.steer })) }
      ctx.interactable({ prompt: 'Press E to drive', radius: 3 })
      ctx.state._driverId = null
    },
    onInteract(ctx, player) {
      const pid = player?.id; if (pid == null) return
      if (ctx.state._driverId === pid) {
        ctx.players.setMovementOverride(pid, null)
        ctx.physics.setVehicleInput(0, 0, 1, 0)
        ctx.state._driverId = null
        ctx.entity.custom = { ...(ctx.entity.custom || {}), driverId: null }
        return
      }
      if (ctx.state._driverId != null) return
      ctx.state._driverId = pid
      ctx.players.setMovementOverride(pid, { maxSpeed: 0, groundAccel: 0, airAccel: 0, jumpImpulse: 0 })
      ctx.entity.custom = { ...(ctx.entity.custom || {}), driverId: pid }
    },
    update(ctx, dt) {
      const driverId = ctx.state._driverId
      if (driverId == null) return
      const driver = ctx.players.getById(driverId)
      if (!driver) { ctx.state._driverId = null; return }
      const inp = driver.lastInput || {}
      const hasAnalog = inp.analogForward !== undefined || inp.analogRight !== undefined
      const forward = hasAnalog ? (inp.analogForward || 0) : ((inp.forward ? 1 : 0) - (inp.backward ? 1 : 0))
      const right = hasAnalog ? (inp.analogRight || 0) : ((inp.right ? 1 : 0) - (inp.left ? 1 : 0))
      const brake = inp.crouch ? 1 : 0
      const handbrake = inp.jump ? 1 : 0
      ctx.physics.setVehicleInput(forward, right, brake, handbrake)
      ctx.players.setPosition(driverId, [ctx.entity.position[0], ctx.entity.position[1] + 0.6, ctx.entity.position[2]])
    },
    teardown(ctx) {
      const driverId = ctx.state?._driverId
      if (driverId != null) ctx.players.setMovementOverride(driverId, null)
      if (ctx.physics.hasVehicle()) ctx.physics.destroyVehicle()
    },
  },
}
