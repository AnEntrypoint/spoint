const DEFAULT_MOVEMENT = { maxSpeed: 7, groundAccel: 150, airAccel: 15, friction: 10, stopSpeed: 2, jumpImpulse: 5.5, sprintSpeed: 12 }
const TICK_RATE = 64
const TICK_DT = 1 / TICK_RATE
const PLAYER_ID = 'local-player-1'
const GRAVITY = -18

export class LocalClient {
  constructor(config = {}) {
    this.config = config
    this._groundRaycast = config.groundRaycast || null
    this.connected = false
    this._worldDef = null
    this._tickTimer = null
    this._inputSeq = 0
    this._lastInput = null
    this._tick = 0
    this._smoothBuf = []
    this._startTime = 0
    this.callbacks = {
      onConnect: config.onConnect || (() => {}),
      onDisconnect: config.onDisconnect || (() => {}),
      onPlayerJoined: config.onPlayerJoined || (() => {}),
      onPlayerLeft: config.onPlayerLeft || (() => {}),
      onEntityAdded: config.onEntityAdded || (() => {}),
      onEntityRemoved: config.onEntityRemoved || (() => {}),
      onSnapshot: config.onSnapshot || (() => {}),
      onStateUpdate: config.onStateUpdate || (() => {}),
      onWorldDef: config.onWorldDef || (() => {}),
      onAppModule: config.onAppModule || (() => {}),
      onAssetUpdate: config.onAssetUpdate || (() => {}),
      onAppEvent: config.onAppEvent || (() => {}),
      onHotReload: config.onHotReload || (() => {}),
      onEditorSelect: config.onEditorSelect || (() => {}),
      onMessage: config.onMessage || (() => {})
    }
    this._playerState = {
      id: PLAYER_ID,
      position: [0, 2, 0],
      rotation: [0, 0, 0, 1],
      velocity: [0, 0, 0],
      onGround: false,
      health: 100,
      inputSequence: 0,
      crouch: 0,
      lookPitch: 0,
      lookYaw: 0
    }
    this._snapshots = []
  }

  get playerId() { return PLAYER_ID }
  get currentTick() { return this._tick }

  async connect() {
    const worldDef = this.config.worldDef || {}
    this._worldDef = worldDef
    const spawn = worldDef.spawnPoint || [0, 2, 0]
    const mv = { ...DEFAULT_MOVEMENT, ...(worldDef.movement || {}) }
    this._movement = mv
    this._gravity = (worldDef.gravity?.[1] ?? GRAVITY)
    const pc = worldDef.player || {}
    this._capsuleBottom = (pc.capsuleHalfHeight ?? 0.63) + (pc.capsuleRadius ?? 0.28)
    const ps = this._playerState
    ps.position[0] = spawn[0]; ps.position[1] = spawn[1]; ps.position[2] = spawn[2]
    this.connected = true
    this.callbacks.onConnect()
    this.callbacks.onWorldDef(worldDef)
    this._startTime = performance.now()
    const entities = (worldDef.entities || []).map(e => ({
      id: e.id, model: e.model || null,
      position: [...(e.position || [0, 0, 0])],
      rotation: [...(e.rotation || [0, 0, 0, 1])],
      velocity: [0, 0, 0],
      bodyType: e.bodyType || 'static',
      custom: e.custom || null,
      scale: [...(e.scale || [1, 1, 1])]
    }))
    this._entities = entities
    await new Promise(r => setTimeout(r, 500))
    this.callbacks.onStateUpdate({ players: [{ ...ps }], entities })
    this._tickTimer = setInterval(() => this._doTick(), TICK_DT * 1000)
  }

  _doTick() {
    const ps = this._playerState
    const input = this._lastInput
    const mv = this._movement
    const dt = TICK_DT
    if (input) {
      let fx = 0, fz = 0
      if (input.forward) fz += 1; if (input.backward) fz -= 1
      if (input.left) fx -= 1; if (input.right) fx += 1
      const flen = Math.sqrt(fx * fx + fz * fz)
      if (flen > 0) { fx /= flen; fz /= flen }
      const yaw = input.yaw || 0, cy = Math.cos(yaw), sy = Math.sin(yaw)
      const wishX = fz * sy - fx * cy, wishZ = fx * sy + fz * cy
      const baseSpeed = input.sprint ? mv.sprintSpeed : mv.maxSpeed
      const wishSpeed = flen > 0 ? baseSpeed : 0
      if (input.jump && ps.onGround) { ps.velocity[1] = mv.jumpImpulse; ps.onGround = false }
      let vx = ps.velocity[0], vz = ps.velocity[2]
      if (ps.onGround) {
        const speed = Math.sqrt(vx * vx + vz * vz)
        if (speed > 0.1) { const s = Math.max(0, speed - speed * mv.friction * dt) / speed; vx *= s; vz *= s } else { vx = 0; vz = 0 }
        if (wishSpeed > 0) { const cur = vx * wishX + vz * wishZ; const add = wishSpeed - cur; if (add > 0) { const a = Math.min(add, mv.groundAccel * dt); vx += wishX * a; vz += wishZ * a } }
      } else {
        if (wishSpeed > 0) { const cur = vx * wishX + vz * wishZ; const add = wishSpeed - cur; if (add > 0) { const a = Math.min(add, mv.airAccel * dt); vx += wishX * a; vz += wishZ * a } }
      }
      ps.velocity[0] = vx; ps.velocity[2] = vz
      ps.lookYaw = input.yaw || 0; ps.lookPitch = input.pitch || 0
    }
    if (!ps.onGround) ps.velocity[1] += this._gravity * dt
    ps.position[0] += ps.velocity[0] * dt
    ps.position[1] += ps.velocity[1] * dt
    ps.position[2] += ps.velocity[2] * dt
    const capsuleBottom = this._capsuleBottom ?? 0.91
    const groundY = this._groundRaycast ? this._groundRaycast(ps.position[0], ps.position[1] - capsuleBottom, ps.position[2]) : null
    const floorY = (groundY !== null ? groundY + capsuleBottom : -15.0)
    if (ps.position[1] <= floorY) { ps.position[1] = floorY; ps.velocity[1] = 0; ps.onGround = true } else { ps.onGround = false }
    ps.inputSequence = this._inputSeq
    this._tick++
    this._lastTickTime = performance.now()
    const snap = { tick: this._tick, players: [{ ...ps, position: [...ps.position], velocity: [...ps.velocity], rotation: [...ps.rotation] }], entities: this._entities, serverTime: this._lastTickTime }
    this._snapshots.push(snap)
    if (this._snapshots.length > 8) this._snapshots.shift()
    this.callbacks.onStateUpdate({ players: snap.players, entities: snap.entities })
  }

  sendInput(input) {
    this._lastInput = input
    this._inputSeq++
  }

  send(type, payload) {}
  sendFire() {}
  sendReload() {}

  getSmoothState(now) {
    const snap = this._snapshots[this._snapshots.length - 1]
    return snap ? { players: snap.players, entities: snap.entities } : { players: [], entities: [] }
  }

  getLocalState() {
    const ps = this._playerState, dt = Math.min((performance.now() - (this._lastTickTime || performance.now())) / 1000, TICK_DT * 2)
    return { ...ps, position: [ps.position[0] + ps.velocity[0] * dt, ps.position[1] + ps.velocity[1] * dt, ps.position[2] + ps.velocity[2] * dt], velocity: [...ps.velocity] }
  }
  getRemoteState() { return null }
  getAllStates() { const m = new Map(); m.set(PLAYER_ID, this._playerState); return m }
  getEntity(id) { return this._entities?.find(e => e.id === id) }
  getAllEntities() { const m = new Map(); (this._entities || []).forEach(e => m.set(e.id, e)); return m }
  getRTT() { return 0 }
  getBufferHealth() { return 1 }

  disconnect() {
    this.connected = false
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null }
    this.callbacks.onDisconnect()
  }
}
