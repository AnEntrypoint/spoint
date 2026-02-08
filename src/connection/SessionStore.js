import { randomBytes } from 'node:crypto'

export class SessionStore {
  constructor(options = {}) {
    this.ttl = options.ttl || 30000
    this.sessions = new Map()
    this.timers = new Map()
  }

  create(playerId, state) {
    const token = randomBytes(16).toString('hex')
    const session = {
      token,
      playerId,
      state: state ? { ...state } : {},
      createdAt: Date.now()
    }
    this.sessions.set(token, session)
    this._setupExpire(token)
    return token
  }

  update(token, data) {
    const session = this.sessions.get(token)
    if (!session) return false
    if (data.state) Object.assign(session.state, data.state)
    session.lastUpdated = Date.now()
    return true
  }

  get(token) {
    const session = this.sessions.get(token)
    if (!session) return null
    if (Date.now() - session.createdAt > this.ttl) {
      this.destroy(token)
      return null
    }
    return session
  }

  _setupExpire(token) {
    const timer = setTimeout(() => {
      this.sessions.delete(token)
      this.timers.delete(token)
    }, this.ttl)
    this.timers.set(token, timer)
  }

  destroy(token) {
    const timer = this.timers.get(token)
    if (timer) clearTimeout(timer)
    this.timers.delete(token)
    this.sessions.delete(token)
  }

  getActiveCount() {
    return this.sessions.size
  }

  destroyAll() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    this.sessions.clear()
  }
}
