export const LOCKSTEP_CTRL_PREFIX = 'wwlockstep:'
export const ROLLBACK_CTRL_PREFIX = 'wwrollback:'
export const CONSENSUS_CTRL_PREFIX = 'wwconsensus:'

const FRAME_KINDS_BY_PREFIX = new Map([
  [LOCKSTEP_CTRL_PREFIX, new Set(['input', 'drop'])],
  [ROLLBACK_CTRL_PREFIX, new Set(['input', 'checksum'])],
  [CONSENSUS_CTRL_PREFIX, new Set(['checksum'])],
])

export function controlFrameKinds(prefix) {
  return [...(FRAME_KINDS_BY_PREFIX.get(prefix) ?? [])]
}

export function encodeControlFrame(prefix, frame) {
  const kinds = FRAME_KINDS_BY_PREFIX.get(prefix)
  if (!kinds) throw new Error(`encodeControlFrame: no control protocol registered for prefix "${prefix}"`)
  if (!kinds.has(frame?.type)) throw new Error(`encodeControlFrame: ${JSON.stringify(frame?.type)} is not a ${prefix} control frame kind`)
  return prefix + JSON.stringify(frame)
}

export function decodeControlFrame(prefix, data) {
  const kinds = FRAME_KINDS_BY_PREFIX.get(prefix)
  if (!kinds) return null
  if (typeof data !== 'string' || !data.startsWith(prefix)) return null
  let frame
  try {
    frame = JSON.parse(data.slice(prefix.length))
  } catch {
    return null
  }
  if (frame === null || typeof frame !== 'object') return null
  if (!kinds.has(frame.type)) return null
  return frame
}
