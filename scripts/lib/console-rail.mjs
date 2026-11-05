export const CONSOLE_LEVELS = Object.freeze(['debug', 'log', 'info', 'warn', 'error', 'exception'])

export function createConsoleRail({ capacity = 2000 } = {}) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`console-rail capacity must be a positive integer, got ${capacity}`)
  const entries = []
  let seq = 0

  return {
    push({ level, objectId = null, text = '', ts = Date.now() }) {
      if (!CONSOLE_LEVELS.includes(level)) throw new RangeError(`console-rail unknown level ${JSON.stringify(level)}`)
      if (objectId !== null && typeof objectId !== 'string') throw new TypeError('console-rail objectId must be a string or null')
      seq += 1
      entries.push({ seq, level, objectId, text: String(text), ts })
      if (entries.length > capacity) entries.splice(0, entries.length - capacity)
      return seq
    },
    query({ level = null, objectId = undefined, limit = Infinity } = {}) {
      const levels = level === null ? null : Array.isArray(level) ? level : [level]
      if (levels) for (const l of levels) if (!CONSOLE_LEVELS.includes(l)) throw new RangeError(`console-rail unknown level ${JSON.stringify(l)}`)
      const hits = entries.filter((e) => (levels === null || levels.includes(e.level)) && (objectId === undefined || e.objectId === objectId))
      return limit >= hits.length ? hits.slice() : hits.slice(hits.length - limit)
    },
    size() {
      return entries.length
    },
    clear() {
      entries.length = 0
    },
  }
}
