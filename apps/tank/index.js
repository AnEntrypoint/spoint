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
      const zs = [hz - 0.6, 0, -(hz - 0.6)]
      const middleWheelIndex = 1
      const wheelDefs = []
      for (let i = 0; i < zs.length; i++) wheelDefs.push({ position: [-hx, -hy, zs[i]], radius: 0.4, width: 0.3, suspensionMin: 0.25, suspensionMax: 0.45, maxBrakeTorque: 2500, side: 'left', driven: i === middleWheelIndex })
      for (let i = 0; i < zs.length; i++) wheelDefs.push({ position: [hx, -hy, zs[i]], radius: 0.4, width: 0.3, suspensionMin: 0.25, suspensionMax: 0.45, maxBrakeTorque: 2500, side: 'right', driven: i === middleWheelIndex })
      const vid = ctx.physics.createTrackedVehicle(wheelDefs, { engine: { maxTorque: c.maxTorque ?? 1200 } })
      if (vid == null) ctx.debug.warn('[tank] createTrackedVehicle failed -- driving input will be a no-op (chassis still exists as plain dynamic prop)')
      ctx.interactable({ prompt: 'Press E to drive', radius: 3.5 })
      ctx.state._driverId = null
    },
    onInteract(ctx, player) {
      const pid = player?.id; if (pid == null) return
      if (ctx.state._driverId === pid) {
        ctx.players.setMovementOverride(pid, null)
        ctx.physics.setTrackedVehicleInput(0, 0, 0, 1)
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
      const turn = hasAnalog ? (inp.analogRight || 0) : ((inp.right ? 1 : 0) - (inp.left ? 1 : 0))
      const brake = inp.crouch ? 1 : 0
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
