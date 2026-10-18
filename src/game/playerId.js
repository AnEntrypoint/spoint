// The one playerId parser for src/game. A player id is a non-empty string or an
// integer; both spellings of the same player (1 and '1') parse to the same key.
// Every system keys its maps on the parsed value and no function accepts the raw one.

export function parsePlayerId(pid) {
  const key = tryParsePlayerId(pid)
  if (key === null) throw new TypeError(`[game] playerId must be a non-empty string or an integer, got ${typeof pid}`)
  return key
}

export function tryParsePlayerId(pid) {
  if (typeof pid === 'string') return pid.length > 0 ? pid : null
  if (typeof pid === 'number' && Number.isInteger(pid)) return String(pid)
  return null
}
