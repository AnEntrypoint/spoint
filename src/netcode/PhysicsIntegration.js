import { waterlineLocalY } from '../terrain/PlanetFrame.js'

const KILL_PLANE_Y = -100

const SWIM_GRAVITY_MUL = 0.15
const SWIM_DRAG = 1.5
const SWIM_UP_SPEED = 2.2
const SWIM_SINK_SPEED = -0.6

export class PhysicsIntegration {
  constructor(config = {}) {
    this.physicsWorld = config.physicsWorld || null
    this.config = {
      gravity: config.gravity ?? [0, -9.81, 0],
      capsuleRadius: config.capsuleRadius ?? 0.4,
      capsuleHalfHeight: config.capsuleHalfHeight ?? 0.9,
      crouchHalfHeight: config.crouchHalfHeight ?? 0.45,
      playerMass: config.playerMass ?? 120
    }
    this.playerBodies = new Map()
    this._crouchStates = new Map()
  }

  setPhysicsWorld(world) {
    this.physicsWorld = world
  }

  _submersionFrac(y, x = 0, z = 0) {
    const waterlineY = waterlineLocalY(this.physicsWorld?._planetFrame, x, z)
    if (waterlineY == null) return 0
    const halfHeight = this.config.capsuleHalfHeight
    const bottomY = y - halfHeight
    const span = 2 * halfHeight
    return Math.max(0, Math.min(1, (waterlineY - bottomY) / span))
  }

  _resolveSwimVelocity(state, deltaTime, gravityVy, jumpHeld) {
    const submersionFrac = this._submersionFrac(state.position[1], state.position[0], state.position[2])
    const swimming = submersionFrac > 0.5
    state.swimming = swimming
    if (!swimming) return { vy: gravityVy, dragMul: 1 }
    const g = this.config.gravity[1]
    let vy = state.velocity[1] + g * SWIM_GRAVITY_MUL * deltaTime
    if (jumpHeld) vy = Math.max(vy, SWIM_UP_SPEED)
    else vy = Math.max(SWIM_SINK_SPEED, vy)
    const dragMul = Math.max(0, 1 - SWIM_DRAG * deltaTime)
    return { vy, dragMul }
  }

  addPlayerCollider(playerId, radius = 0.4) {
    const radiusUnsafeForJolt = !Number.isFinite(radius) || radius <= 0
    if (radiusUnsafeForJolt) radius = 0.4
    if (this.playerBodies.has(playerId)) {
      this.removePlayerCollider(playerId)
    }
    if (!this.physicsWorld) {
      this.playerBodies.set(playerId, { id: playerId, charId: null, onGround: false })
      return
    }
    const charId = this.physicsWorld.addPlayerCharacter(
      radius,
      this.config.capsuleHalfHeight,
      [0, 5, 0],
      this.config.playerMass
    )
    this.playerBodies.set(playerId, { id: playerId, charId, onGround: false })
  }

  removePlayerCollider(playerId) {
    const data = this.playerBodies.get(playerId)
    if (data?.charId && this.physicsWorld) {
      this.physicsWorld.removeCharacter(data.charId)
    }
    this.playerBodies.delete(playerId)
  }

  resyncPlayerFromPhysics(playerId, state) {
    const data = this.playerBodies.get(playerId)
    if (!data || !data.charId || !this.physicsWorld) return
    this.physicsWorld.readCharacterPosition(data.charId, state.position)
    this.physicsWorld.readCharacterVelocity(data.charId, state.velocity)
    data.onGround = state.swimming ? false : this.physicsWorld.getCharacterGroundState(data.charId)
    state.onGround = data.onGround
  }

  updatePlayerPhysics(playerId, state, deltaTime) {
    const data = this.playerBodies.get(playerId)
    if (!data || !data.charId || !this.physicsWorld) {
      return this._fallbackPhysics(playerId, state, deltaTime)
    }
    const charId = data.charId
    const onGround = data.onGround
    let vy = onGround ? (state.velocity[1] > 0 ? state.velocity[1] : 0) : state.velocity[1] + this.config.gravity[1] * deltaTime
    const swim = this._resolveSwimVelocity(state, deltaTime, vy, !!state._jumpHeld)
    vy = swim.vy
    const vx = state.velocity[0] * swim.dragMul, vz = state.velocity[2] * swim.dragMul
    this.physicsWorld.setCharacterVelocity(charId, [vx, vy, vz])
    this.physicsWorld.updateCharacter(charId, deltaTime)
    this.physicsWorld.readCharacterPosition(charId, state.position)
    this.physicsWorld.readCharacterVelocity(charId, state.velocity)
    data.onGround = state.swimming ? false : this.physicsWorld.getCharacterGroundState(charId)
    state.onGround = data.onGround
    if (this._applyKillPlane(state)) {
      this.physicsWorld.setCharacterPosition(charId, state.position)
    }
    return state
  }

  _applyKillPlane(state) {
    const p = state.position
    const badY = !Number.isFinite(p[1]) || p[1] < KILL_PLANE_Y
    const badX = !Number.isFinite(p[0])
    const badZ = !Number.isFinite(p[2])
    if (badY || badX || badZ) {
      p[0] = Number.isFinite(p[0]) ? p[0] : 0
      p[1] = KILL_PLANE_Y
      p[2] = Number.isFinite(p[2]) ? p[2] : 0
      state.velocity[0] = 0; state.velocity[1] = 0; state.velocity[2] = 0
      return true
    }
    return false
  }

  _fallbackPhysics(playerId, state, deltaTime) {
    const gravityVy = state.velocity[1] + this.config.gravity[1] * deltaTime
    const swim = this._resolveSwimVelocity(state, deltaTime, gravityVy, !!state._jumpHeld)
    state.velocity[0] *= swim.dragMul
    state.velocity[1] = swim.vy
    state.velocity[2] *= swim.dragMul
    state.position[0] += state.velocity[0] * deltaTime
    state.position[1] += state.velocity[1] * deltaTime
    state.position[2] += state.velocity[2] * deltaTime
    state.onGround = this._applyKillPlane(state)
    return state
  }

  setPlayerPosition(playerId, position) {
    const data = this.playerBodies.get(playerId)
    if (data?.charId && this.physicsWorld) {
      this.physicsWorld.setCharacterPosition(data.charId, position)
    }
  }

  getPlayerPosition(playerId) {
    const data = this.playerBodies.get(playerId)
    if (data?.charId && this.physicsWorld) {
      return this.physicsWorld.getCharacterPosition(data.charId)
    }
    return [0, 0, 0]
  }

  raycast(origin, direction, maxDistance) {
    if (!this.physicsWorld) return { hit: false, distance: maxDistance }
    return this.physicsWorld.raycast(origin, direction, maxDistance)
  }

  validateMovement(playerId, newPosition, oldPosition) {
    const distance = Math.hypot(
      newPosition[0] - oldPosition[0],
      newPosition[1] - oldPosition[1],
      newPosition[2] - oldPosition[2]
    )
    if (distance > 2.0) return { valid: false, reason: 'move_too_far', distance }
    return { valid: true }
  }

  setCrouch(playerId, isCrouching) {
    const data = this.playerBodies.get(playerId)
    if (!data?.charId || !this.physicsWorld) return
    const currentState = this._crouchStates.get(playerId)
    if (currentState === isCrouching) return
    this.physicsWorld.setCharacterCrouch(data.charId, isCrouching)
    this._crouchStates.set(playerId, isCrouching)
  }
}
