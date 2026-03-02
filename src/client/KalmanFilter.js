export class KalmanFilter3D {
  constructor(config = {}) {
    this.positionQ = config.positionQ ?? 2.0
    this.velocityQ = config.velocityQ ?? 4.0
    this.positionR = config.positionR ?? 0.1
    this.velocityR = config.velocityR ?? 0.1

    this.x = new Float64Array(3)
    this.v = new Float64Array(3)
    this.Pp = new Float64Array([1, 1, 1])
    this.Pv = new Float64Array([1, 1, 1])
    this._prevPos = new Float64Array(3)
    this._hasPrevPos = false

    this.initialized = false
    this._lastUpdateMs = 0

    this._outPos = new Float64Array(3)
    this._outVel = new Float64Array(3)
  }

  init(position, velocity = null, now = Date.now()) {
    this.x[0] = position[0]; this.x[1] = position[1]; this.x[2] = position[2]
    if (velocity) { this.v[0] = velocity[0]; this.v[1] = velocity[1]; this.v[2] = velocity[2] }
    else { this.v[0] = 0; this.v[1] = 0; this.v[2] = 0 }
    this._prevPos[0] = position[0]; this._prevPos[1] = position[1]; this._prevPos[2] = position[2]
    this._hasPrevPos = true
    this._lastUpdateMs = now
    this.initialized = true
  }

  predict(dt) {
    if (!this.initialized || dt <= 0) return this

    for (let i = 0; i < 3; i++) {
      this.x[i] += this.v[i] * dt
      this.Pp[i] += this.positionQ * dt
      this.Pv[i] += this.velocityQ * dt
    }

    return this
  }

  update(measuredPosition, measuredVelocity = null, now = Date.now()) {
    if (!this.initialized) {
      this.init(measuredPosition, measuredVelocity, now)
      return this
    }

    const elapsedMs = now - this._lastUpdateMs
    if (elapsedMs < 1) return this
    const elapsed = elapsedMs / 1000
    this._lastUpdateMs = now

    for (let i = 0; i < 3; i++) {
      this.x[i] += this.v[i] * elapsed
      this.Pp[i] += this.positionQ * elapsed
      this.Pv[i] += this.velocityQ * elapsed
    }

    for (let i = 0; i < 3; i++) {
      const Kp = this.Pp[i] / (this.Pp[i] + this.positionR)
      this.x[i] += Kp * (measuredPosition[i] - this.x[i])
      this.Pp[i] = (1 - Kp) * this.Pp[i]

      let measuredV
      if (measuredVelocity) {
        measuredV = measuredVelocity[i]
      } else if (this._hasPrevPos) {
        measuredV = (measuredPosition[i] - this._prevPos[i]) / elapsed
      } else {
        measuredV = 0
      }

      const Kv = this.Pv[i] / (this.Pv[i] + this.velocityR)
      this.v[i] += Kv * (measuredV - this.v[i])
      this.Pv[i] = (1 - Kv) * this.Pv[i]
    }

    this._prevPos[0] = measuredPosition[0]; this._prevPos[1] = measuredPosition[1]; this._prevPos[2] = measuredPosition[2]
    this._hasPrevPos = true
    return this
  }

  getState() { return { position: [this.x[0], this.x[1], this.x[2]], velocity: [this.v[0], this.v[1], this.v[2]] } }
  setPosition(pos) { this.x[0] = pos[0]; this.x[1] = pos[1]; this.x[2] = pos[2]; this._prevPos[0] = pos[0]; this._prevPos[1] = pos[1]; this._prevPos[2] = pos[2]; this._hasPrevPos = true }
  setVelocity(vel) { this.v[0] = vel[0]; this.v[1] = vel[1]; this.v[2] = vel[2] }

  reset(position = [0, 0, 0]) {
    this.x[0] = position[0]; this.x[1] = position[1]; this.x[2] = position[2]
    this.v[0] = 0; this.v[1] = 0; this.v[2] = 0
    this.Pp[0] = 1; this.Pp[1] = 1; this.Pp[2] = 1
    this.Pv[0] = 1; this.Pv[1] = 1; this.Pv[2] = 1
    this._hasPrevPos = false
    this._lastUpdateMs = 0
    this.initialized = false
  }
}

export class SmoothStateTracker {
  constructor(config = {}) {
    this.filters = new Map()
    this.maxAge = config.maxAge || 5000
    this.defaultConfig = config.filterConfig || {}
  }

  getFilter(id) {
    let filter = this.filters.get(id)
    if (!filter) {
      filter = new KalmanFilter3D(this.defaultConfig)
      this.filters.set(id, filter)
    }
    return filter
  }

  update(id, position, velocity, dt) {
    const filter = this.getFilter(id)
    return filter.update(position, velocity)
  }

  predict(id, dt) {
    const filter = this.getFilter(id)
    return filter.predict(dt)
  }

  remove(id) { this.filters.delete(id) }
  clear() { this.filters.clear() }
}
