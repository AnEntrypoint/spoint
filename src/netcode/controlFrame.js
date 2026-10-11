export const LOCKSTEP_CTRL_PREFIX = 'wwlockstep:'
export const ROLLBACK_CTRL_PREFIX = 'wwrollback:'
export const CONSENSUS_CTRL_PREFIX = 'wwconsensus:'

const integer = (v) => Number.isInteger(v)
const positiveInteger = (v) => Number.isInteger(v) && v >= 1
const text = (v) => typeof v === 'string'
const list = (v) => Array.isArray(v)
const number = (v) => typeof v === 'number'
const truthy = (v) => !!v

const FRAME_CONTRACTS = new Map([
  [LOCKSTEP_CTRL_PREFIX, new Map([
    ['input', new Map([['tick', positiveInteger]])],
    ['drop', new Map([['peer', text], ['have', integer], ['tail', list]])],
  ])],
  [ROLLBACK_CTRL_PREFIX, new Map([
    ['input', new Map([['tick', integer]])],
    ['checksum', new Map([['tick', integer]])],
  ])],
  [CONSENSUS_CTRL_PREFIX, new Map([
    ['checksum', new Map([['tick', number], ['pubkey', truthy], ['checksum', truthy]])],
  ])],
])

export function controlFrameKinds(prefix) {
  return [...(FRAME_CONTRACTS.get(prefix)?.keys() ?? [])]
}

export function encodeControlFrame(prefix, frame) {
  const kinds = FRAME_CONTRACTS.get(prefix)
  if (!kinds) throw new Error(`encodeControlFrame: no control protocol registered for prefix "${prefix}"`)
  if (!kinds.has(frame?.type)) throw new Error(`encodeControlFrame: ${JSON.stringify(frame?.type)} is not a ${prefix} control frame kind`)
  return prefix + JSON.stringify(frame)
}

export function parseControlFrame(prefix, data) {
  const kinds = FRAME_CONTRACTS.get(prefix)
  if (!kinds) return { status: 'unregistered-prefix' }
  if (typeof data !== 'string' || !data.startsWith(prefix)) return { status: 'foreign-prefix' }
  let frame
  try {
    frame = JSON.parse(data.slice(prefix.length))
  } catch {
    return { status: 'malformed-payload' }
  }
  if (frame === null || typeof frame !== 'object') return { status: 'malformed-payload' }
  const contract = kinds.get(frame.type)
  if (!contract) return { status: 'unknown-kind', kind: frame.type }
  for (const [field, admits] of contract) {
    if (!admits(frame[field])) return { status: 'invalid-field', kind: frame.type, field }
  }
  return { status: 'accepted', frame }
}

export function controlFrameHandlers(prefix, handlers) {
  const kinds = FRAME_CONTRACTS.get(prefix)
  if (!kinds) throw new Error(`controlFrameHandlers: no control protocol registered for prefix "${prefix}"`)
  const arms = new Map(Object.entries(handlers))
  for (const kind of kinds.keys()) {
    if (!arms.has(kind)) throw new Error(`controlFrameHandlers: ${prefix} admits control frame kind "${kind}" but no handler arm was supplied`)
  }
  for (const kind of arms.keys()) {
    if (!kinds.has(kind)) throw new Error(`controlFrameHandlers: handler arm "${kind}" is not a ${prefix} control frame kind`)
  }
  return arms
}

export const countReject = (stats) => (parsed) => {
  const rejects = stats.rejects ?? (stats.rejects = {})
  rejects[parsed.status] = (rejects[parsed.status] ?? 0) + 1
  if (parsed.status === 'unknown-kind') stats.unknownKind = (stats.unknownKind ?? 0) + 1
}

export function dispatchControlFrame(prefix, arms, data, onReject = null) {
  const parsed = parseControlFrame(prefix, data)
  if (parsed.status !== 'accepted') {
    if (onReject) onReject(parsed)
    return null
  }
  return { frame: parsed.frame, apply: arms.get(parsed.frame.type) }
}
