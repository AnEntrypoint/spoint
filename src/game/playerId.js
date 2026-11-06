
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
