export class KalmanFilter3D {
  constructor(config = {}) {
    this.processNoise = config.processNoise || 0.1
    this.measurementNoise = config.measurementNoise || 0.5
    this.uncertainty = config.uncertainty || 1.0
    
    this.x = [0, 0, 0]
    this.v = [0, 0, 0]
    
    this.P = [
      [this.uncertainty, 0, 0],
      [0, this.uncertainty, 0],
      [0, 0, this.uncertainty]
    ]
    
    this.initialized = false
  }
  
  init(position, velocity = [0, 0, 0]) {
    this.x = [...position]
    this.v = [...velocity]
    this.initialized = true
  }
  
  predict(dt) {
    if (!this.initialized) return { position: this.x, velocity: this.v }
    
    for (let i = 0; i < 3; i++) {
      this.x[i] += this.v[i] * dt
    }
    
    const q = this.processNoise * dt * dt
    for (let i = 0; i < 3; i++) {
      this.P[i][i] += q
    }
    
    return { position: [...this.x], velocity: [...this.v] }
  }
  
  update(measuredPosition, measuredVelocity = null) {
    if (!this.initialized) {
      this.init(measuredPosition, measuredVelocity || [0, 0, 0])
      return { position: [...this.x], velocity: [...this.v] }
    }
    
    const R = this.measurementNoise
    
    for (let i = 0; i < 3; i++) {
      const P = this.P[i][i]
      const K = P / (P + R)
      
      this.x[i] += K * (measuredPosition[i] - this.x[i])
      
      if (measuredVelocity) {
        this.v[i] = measuredVelocity[i]
      }
      
      this.P[i][i] = (1 - K) * P
    }
    
    return { position: [...this.x], velocity: [...this.v] }
  }
  
  getState() {
    return {
      position: [...this.x],
      velocity: [...this.v]
    }
  }
  
  setPosition(pos) {
    this.x = [...pos]
  }
  
  setVelocity(vel) {
    this.v = [...vel]
  }
  
  reset(position = [0, 0, 0]) {
    this.x = [...position]
    this.v = [0, 0, 0]
    this.P = [
      [this.uncertainty, 0, 0],
      [0, this.uncertainty, 0],
      [0, 0, this.uncertainty]
    ]
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
    filter.predict(dt)
    return filter.update(position, velocity)
  }
  
  predict(id, dt) {
    const filter = this.getFilter(id)
    return filter.predict(dt)
  }
  
  remove(id) {
    this.filters.delete(id)
  }
  
  clear() {
    this.filters.clear()
  }
}
