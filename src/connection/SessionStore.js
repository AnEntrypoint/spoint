import { mintPlayerOwner, playerIdOf, isPlayerOwner, UNBOUND_OWNER } from './playerOwner.js'

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
      _owner: playerId == null ? UNBOUND_OWNER : mintPlayerOwner(playerId),
      get playerId() { return playerIdOf(this._owner) },
      state: state ? { ...state } : {},
      createdAt: Date.now(),
      lastTouched: Date.now(),
      pinned: false
    }
    this.sessions.set(token, session)
    this._setupExpire(token)
    return token
  }

  update(token, data) {
    const session = this.sessions.get(token)
    if (!session) return false
    if (data && data.state && typeof data.state === 'object' && !Array.isArray(data.state)) {
      for (const k of Object.keys(data.state)) {
        const isPrototypePollutionKey = k === '__proto__' || k === 'constructor' || k === 'prototype'
        if (isPrototypePollutionKey) continue
        session.state[k] = data.state[k]
      }
    }
    session.lastTouched = Date.now()
    if (!session.pinned) this._refreshExpire(token)
    return true
  }

  rebindOwner(token, owner) {
    const session = this.sessions.get(token)
    if (!session) return false
    if (!isPlayerOwner(owner)) throw new TypeError('[SessionStore] rebindOwner requires a PlayerOwner minted by the player boundary')
    session._owner = owner
    session.lastTouched = Date.now()
    if (!session.pinned) this._refreshExpire(token)
    return true
  }

  pin(token) {
    const session = this.sessions.get(token)
    if (!session) return false
    session.pinned = true
    const timer = this.timers.get(token)
    if (timer) clearTimeout(timer)
    this.timers.delete(token)
    return true
  }

  release(token) {
    const session = this.sessions.get(token)
    if (!session) return false
    session.pinned = false
    session.lastTouched = Date.now()
    this._refreshExpire(token)
    return true
  }

  get(token) {
    const session = this.sessions.get(token)
    if (!session) return null
    if (!session.pinned && Date.now() - session.lastTouched > this.ttl) {
      this.destroy(token)
      return null
    }
    session.lastTouched = Date.now()
    if (!session.pinned) this._refreshExpire(token)
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

// --- hot swap -----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapSessionStore = (next) => {
  SessionStore = next.SessionStore
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapSessionStore)
