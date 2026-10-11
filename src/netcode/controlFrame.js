export const LOCKSTEP_CTRL_PREFIX = 'wwlockstep:'
export const ROLLBACK_CTRL_PREFIX = 'wwrollback:'

export const CONTROL_FRAME_TYPES = ['checksum', 'input', 'drop']

export function encodeControlFrame(prefix, frame) {
  return prefix + JSON.stringify(frame)
}

export function decodeControlFrame(prefix, data) {
  if (typeof data !== 'string' || !data.startsWith(prefix)) return null
  let frame
  try {
    frame = JSON.parse(data.slice(prefix.length))
  } catch {
    return null
  }
  if (frame === null || typeof frame !== 'object') return null
  if (!CONTROL_FRAME_TYPES.includes(frame.type)) return null
  return frame
}
