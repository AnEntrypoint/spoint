function _randomHex16() {
  const arr = new Uint8Array(16)
  globalThis.crypto.getRandomValues(arr)
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

export class SessionStore {
  constructor(options = {}) {
    this.ttl = options.ttl || 30000
    this.sessions = new Map()
    this.timers = new Map()
  }

  create(playerId, state) {
    const token = _randomHex16()
    const session = {
      token,
      playerId,
      state: state ? { ...state } : {},
      createdAt: Date.now(),
      lastTouched: Date.now()
    }
    this.sessions.set(token, session)
    this._setupExpire(token)
    return token
  }

  update(token, data) {
    const session = this.sessions.get(token)
    if (!session) return false
    // untrusted reconnect blob: skip __proto__/constructor/prototype keys to avoid prototype pollution
    if (data && data.state && typeof data.state === 'object' && !Array.isArray(data.state)) {
      for (const k of Object.keys(data.state)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
        session.state[k] = data.state[k]
      }
    }
    session.lastTouched = Date.now()
    this._refreshExpire(token)
    return true
  }

  get(token) {
    const session = this.sessions.get(token)
    if (!session) return null
    if (Date.now() - session.lastTouched > this.ttl) {
      this.destroy(token)
      return null
    }
    session.lastTouched = Date.now()
    this._refreshExpire(token)
    return session
  }

  _setupExpire(token) {
    const timer = setTimeout(() => {
      this.sessions.delete(token)
      this.timers.delete(token)
    }, this.ttl)
    this.timers.set(token, timer)
  }

  _refreshExpire(token) {
    const old = this.timers.get(token)
    if (old) clearTimeout(old)
    this._setupExpire(token)
  }

  destroy(token) {
    const timer = this.timers.get(token)
    if (timer) clearTimeout(timer)
    this.timers.delete(token)
    this.sessions.delete(token)
  }

  getActiveCount() { return this.sessions.size }

  destroyAll() {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.sessions.clear()
  }
}
