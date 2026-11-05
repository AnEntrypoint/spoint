const LEVELS = new Set(['info', 'warn', 'error'])

export class RoomLogError extends Error {
  constructor(reasonCode, message) {
    super(message)
    this.name = 'RoomLogError'
    this.reasonCode = reasonCode
  }
}

export class RoomLog {
  constructor({ capacity = 512 } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RoomLogError('bad-capacity', `RoomLog capacity must be a positive integer, got ${capacity}`)
    }
    this.capacity = capacity
    this.entries = []
    this.nextSeq = 1
  }

  append(level, source, message, path = null) {
    if (!LEVELS.has(level)) {
      throw new RoomLogError('bad-level', `RoomLog level must be info, warn or error, got ${level}`)
    }
    if (level === 'error' && (typeof path !== 'string' || path === '')) {
      throw new RoomLogError('missing-path', `RoomLog error from ${source} must name the path it failed on`)
    }
    const entry = { seq: this.nextSeq, level, source: String(source), message: String(message), path }
    this.nextSeq += 1
    this.entries.push(entry)
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
    return entry.seq
  }

  read({ after = 0, limit = 100, level = null } = {}) {
    if (!Number.isInteger(after) || after < 0) {
      throw new RoomLogError('bad-cursor', `RoomLog cursor must be a non-negative integer, got ${after}`)
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new RoomLogError('bad-limit', `RoomLog limit must be an integer in 1..1000, got ${limit}`)
    }
    const oldest = this.entries.length ? this.entries[0].seq : this.nextSeq
    const matching = this.entries.filter(e => e.seq > after && (level === null || e.level === level))
    const page = matching.slice(0, limit)
    return {
      entries: page,
      nextCursor: page.length ? page[page.length - 1].seq : after,
      more: matching.length > limit,
      dropped: Math.max(0, oldest - 1 - after),
    }
  }
}
