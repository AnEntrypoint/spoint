export class KalmanFilter3D {
  constructor(config = {}) {
    this.positionQ = config.positionQ ?? 2.0
    this.velocityQ = config.velocityQ ?? 4.0
    this.positionR = config.positionR ?? 0.01
    this.velocityR = config.velocityR ?? 0.1

    this.x = [0, 0, 0]
    this.v = [0, 0, 0]

    this.Pp = [1, 1, 1]
    this.Pv = [1, 1, 1]

    this.initialized = false
    this._prevPos = null
    this._lastUpdateMs = 0
  }

  init(position, velocity = null, now = Date.now()) {
    this.x = [...position]
    this.v = velocity ? [...velocity] : [0, 0, 0]
    this._prevPos = [...position]
    this._lastUpdateMs = now
    this.initialized = true
  }

  predict(dt) {
    if (!this.initialized || dt <= 0) return { position: [...this.x], velocity: [...this.v] }

    for (let i = 0; i < 3; i++) {
      this.x[i] += this.v[i] * dt
      this.Pp[i] += this.positionQ * dt
      this.Pv[i] += this.velocityQ * dt
    }

    return { position: [...this.x], velocity: [...this.v] }
  }

  update(measuredPosition, measuredVelocity = null, now = Date.now()) {
    if (!this.initialized) {
      this.init(measuredPosition, measuredVelocity, now)
      return { position: [...this.x], velocity: [...this.v] }
    }

    const elapsedMs = now - this._lastUpdateMs
    if (elapsedMs < 1) return { position: [...this.x], velocity: [...this.v] }
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
      } else if (this._prevPos) {
        measuredV = (measuredPosition[i] - this._prevPos[i]) / elapsed
      } else {
        measuredV = 0
      }

      const Kv = this.Pv[i] / (this.Pv[i] + this.velocityR)
      this.v[i] += Kv * (measuredV - this.v[i])
      this.Pv[i] = (1 - Kv) * this.Pv[i]
    }

    this._prevPos = [...measuredPosition]
    return { position: [...this.x], velocity: [...this.v] }
  }

  getState() { return { position: [...this.x], velocity: [...this.v] } }
  setPosition(pos) { this.x = [...pos]; this._prevPos = [...pos] }
  setVelocity(vel) { this.v = [...vel] }

  reset(position = [0, 0, 0]) {
    this.x = [...position]
    this.v = [0, 0, 0]
    this.Pp = [1, 1, 1]
    this.Pv = [1, 1, 1]
    this._prevPos = null
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
