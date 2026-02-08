export class PhysicsIntegration {
  constructor(config = {}) {
    this.physicsWorld = config.physicsWorld || null
    this.config = {
      gravity: config.gravity || [0, -9.81, 0],
      capsuleRadius: config.capsuleRadius || 0.4,
      capsuleHalfHeight: config.capsuleHalfHeight || 0.9,
      playerMass: config.playerMass || 160,
      ...config
    }
    this.playerBodies = new Map()
  }

  setPhysicsWorld(world) {
    this.physicsWorld = world
  }

  addPlayerCollider(playerId, radius = 0.4) {
    if (!this.physicsWorld) {
      this.playerBodies.set(playerId, { id: playerId, charId: null, onGround: true })
      return
    }
    const charId = this.physicsWorld.addPlayerCharacter(
      radius,
      this.config.capsuleHalfHeight,
      [0, 5, 0],
      this.config.playerMass
    )
    this.playerBodies.set(playerId, { id: playerId, charId, onGround: true })
  }

  removePlayerCollider(playerId) {
    const data = this.playerBodies.get(playerId)
    if (data?.charId && this.physicsWorld) {
      this.physicsWorld.removeCharacter(data.charId)
    }
    this.playerBodies.delete(playerId)
  }

  updatePlayerPhysics(playerId, state, deltaTime) {
    const data = this.playerBodies.get(playerId)
    if (!data || !data.charId || !this.physicsWorld) {
      return this._fallbackPhysics(playerId, state, deltaTime)
    }
    const charId = data.charId
    const currentVel = this.physicsWorld.getCharacterVelocity(charId)
    const onGround = this.physicsWorld.getCharacterGroundState(charId)
    let vy
    if (onGround) {
      vy = state.velocity[1] > 0 ? state.velocity[1] : 0
    } else {
      vy = currentVel[1] + this.config.gravity[1] * deltaTime
    }
    this.physicsWorld.setCharacterVelocity(charId, [state.velocity[0], vy, state.velocity[2]])
    this.physicsWorld.updateCharacter(charId, deltaTime)
    const pos = this.physicsWorld.getCharacterPosition(charId)
    const vel = this.physicsWorld.getCharacterVelocity(charId)
    data.onGround = this.physicsWorld.getCharacterGroundState(charId)
    state.position = pos
    state.velocity = vel
    state.onGround = data.onGround
    return state
  }

  _fallbackPhysics(playerId, state, deltaTime) {
    state.velocity[1] += this.config.gravity[1] * deltaTime
    state.position[0] += state.velocity[0] * deltaTime
    state.position[1] += state.velocity[1] * deltaTime
    state.position[2] += state.velocity[2] * deltaTime
    if (state.position[1] <= 0) {
      state.position[1] = 0
      state.velocity[1] = 0
      state.onGround = true
    } else {
      state.onGround = false
    }
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

  checkCollisionWithOthers(playerId, allPlayers) {
    const data = this.playerBodies.get(playerId)
    if (!data) return []
    const pos = data.charId && this.physicsWorld
      ? this.physicsWorld.getCharacterPosition(data.charId)
      : [0, 0, 0]
    const collisions = []
    for (const other of allPlayers) {
      if (other.id === playerId) continue
      const otherPos = other.state?.position || other.position
      if (!otherPos) continue
      const dx = otherPos[0] - pos[0]
      const dy = otherPos[1] - pos[1]
      const dz = otherPos[2] - pos[2]
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
      const minDist = this.config.capsuleRadius * 2
      if (distance < minDist && distance > 0) {
        collisions.push({ playerId: other.id, distance, normal: [dx / distance, dy / distance, dz / distance] })
      }
    }
    return collisions
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
}
