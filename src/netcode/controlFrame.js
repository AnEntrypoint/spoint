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

export function parseControlFrame(prefix, data) {
  const kinds = FRAME_KINDS_BY_PREFIX.get(prefix)
  if (!kinds) return { status: 'unregistered-prefix' }
  if (typeof data !== 'string' || !data.startsWith(prefix)) return { status: 'foreign-prefix' }
  let frame
  try {
    frame = JSON.parse(data.slice(prefix.length))
  } catch {
    return { status: 'malformed-payload' }
  }
  if (frame === null || typeof frame !== 'object') return { status: 'malformed-payload' }
  if (!kinds.has(frame.type)) return { status: 'unknown-kind', kind: frame.type }
  return { status: 'accepted', frame }
}

export function decodeControlFrame(prefix, data) {
  const parsed = parseControlFrame(prefix, data)
  return parsed.status === 'accepted' ? parsed.frame : null
}

export function controlFrameHandlers(prefix, handlers) {
  const kinds = FRAME_KINDS_BY_PREFIX.get(prefix)
  if (!kinds) throw new Error(`controlFrameHandlers: no control protocol registered for prefix "${prefix}"`)
  const arms = new Map(Object.entries(handlers))
  for (const kind of kinds) {
    if (!arms.has(kind)) throw new Error(`controlFrameHandlers: ${prefix} admits control frame kind "${kind}" but no handler arm was supplied`)
  }
  for (const kind of arms.keys()) {
    if (!kinds.has(kind)) throw new Error(`controlFrameHandlers: handler arm "${kind}" is not a ${prefix} control frame kind`)
  }
  return arms
}

export const countUnknownKind = (stats) => (parsed) => {
  if (parsed.status === 'unknown-kind') stats.unknownKind++
}

export function dispatchControlFrame(prefix, arms, data, onReject = null) {
  const parsed = parseControlFrame(prefix, data)
  if (parsed.status !== 'accepted') {
    if (onReject) onReject(parsed)
    return null
  }
  return { frame: parsed.frame, apply: arms.get(parsed.frame.type) }
}
