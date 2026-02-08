export class CliDebugger {
  constructor(prefix = '[spawnpoint]') {
    this.prefix = prefix
    this.startTime = Date.now()
    this.history = []
  }

  _timestamp() {
    const elapsed = Date.now() - this.startTime
    const s = (elapsed / 1000).toFixed(2)
    return `${s}s`.padStart(8)
  }

  _formatVec3(v) {
    if (!v) return '(null)'
    return `(${v[0].toFixed(2)}, ${v[1].toFixed(2)}, ${v[2].toFixed(2)})`
  }

  spawn(entity, position) {
    const msg = `${this.prefix} SPAWN ${String(entity).padEnd(15)} @ ${this._formatVec3(position)}`
    console.log(`${this._timestamp()} ${msg}`)
    this.history.push(msg)
  }

  collision(a, b, position) {
    const msg = `${this.prefix} COLLISION ${String(a).padEnd(8)} <-> ${String(b).padEnd(8)} @ ${this._formatVec3(position)}`
    console.log(`${this._timestamp()} ${msg}`)
    this.history.push(msg)
  }

  hit(shooter, target, damage) {
    const msg = `${this.prefix} HIT ${String(shooter).padEnd(10)} -> ${String(target).padEnd(10)} [${damage}hp]`
    console.log(`${this._timestamp()} ${msg}`)
    this.history.push(msg)
  }

  death(entity, damage) {
    const msg = `${this.prefix} DEATH ${String(entity).padEnd(15)} from ${damage}hp`
    console.log(`${this._timestamp()} ${msg}`)
    this.history.push(msg)
  }

  respawn(entity, position) {
    const msg = `${this.prefix} RESPAWN ${String(entity).padEnd(10)} @ ${this._formatVec3(position)}`
    console.log(`${this._timestamp()} ${msg}`)
    this.history.push(msg)
  }

  state(entity, key, value) {
    const v = typeof value === 'object' ? JSON.stringify(value) : String(value)
    const msg = `${this.prefix} STATE ${String(entity).padEnd(15)} ${key}=${v}`
    console.log(`${this._timestamp()} ${msg}`)
  }

  perf(label, ms) {
    const status = ms < 10 ? '✓' : ms < 20 ? '⚠' : '✗'
    const msg = `${this.prefix} ${status} ${label.padEnd(20)} ${ms.toFixed(1)}ms`
    console.log(`${this._timestamp()} ${msg}`)
  }

  physics(body, pos, vel, health) {
    const speed = Math.sqrt(vel[0]*vel[0] + vel[1]*vel[1] + vel[2]*vel[2]).toFixed(1)
    const msg = `${this.prefix} PHY ${String(body).padEnd(10)} pos=${this._formatVec3(pos)} vel=${speed}m/s hp=${health}`
    console.log(`${this._timestamp()} ${msg}`)
  }

  error(category, message) {
    const msg = `${this.prefix} ERROR [${category}] ${message}`
    console.error(`${this._timestamp()} ${msg}`)
    this.history.push(msg)
  }

  section(title) {
    console.log(`\n${this.prefix} ${'='.repeat(50)}`)
    console.log(`${this.prefix} ${title}`)
    console.log(`${this.prefix} ${'='.repeat(50)}\n`)
  }

  summary(stats = {}) {
    console.log(`\n${this.prefix} SESSION SUMMARY`)
    for (const [key, value] of Object.entries(stats)) {
      console.log(`${this.prefix}   ${key}: ${value}`)
    }
  }

  log(message) {
    const msg = `${this.prefix} ${message}`
    console.log(`${this._timestamp()} ${msg}`)
    this.history.push(msg)
  }
}

export const cliDebugger = new CliDebugger()
