const UPGRADE_HEADER = 'Upgrade'
const WEBSOCKET = 'websocket'

const DEFAULT_ROOM_BINDING = 'SPOINT_GAME_ROOM'
const DEFAULT_ROOM_KEY = 'probe-room'
const ROOM_QUERY_PARAM = 'room'

const UPGRADE_REQUIRED_STATUS = 426
const NO_STATIC_ORIGIN_STATUS = 502
const NO_ROOM_BINDING_STATUS = 503

function isWebSocketUpgrade(request) {
  const header = request.headers.get(UPGRADE_HEADER)
  return typeof header === 'string' && header.toLowerCase() === WEBSOCKET
}

function refused(status, reason) {
  return { accepted: false, status, reason }
}

function roomKeyFor(request, env) {
  const requested = new URL(request.url).searchParams.get(ROOM_QUERY_PARAM)
  if (requested) return requested
  return typeof env.SPOINT_ROOM_KEY === 'string' && env.SPOINT_ROOM_KEY
    ? env.SPOINT_ROOM_KEY
    : DEFAULT_ROOM_KEY
}

export function acceptRoomRequest(request) {
  return isWebSocketUpgrade(request)
    ? { accepted: true, kind: 'game' }
    : refused(UPGRADE_REQUIRED_STATUS, 'expected websocket upgrade')
}

export function acceptEdgeRequest(request, env) {
  if (isWebSocketUpgrade(request)) {
    const bindingName =
      typeof env.SPOINT_ROOM_BINDING === 'string' && env.SPOINT_ROOM_BINDING
        ? env.SPOINT_ROOM_BINDING
        : DEFAULT_ROOM_BINDING
    const binding = env[bindingName]
    if (!binding || typeof binding.idFromName !== 'function') {
      return refused(NO_ROOM_BINDING_STATUS, 'no durable object binding "' + bindingName + '" on this Worker')
    }
    return { accepted: true, kind: 'game', binding, roomKey: roomKeyFor(request, env) }
  }

  if (!env.STATIC_ORIGIN) {
    return refused(
      NO_STATIC_ORIGIN_STATUS,
      'edge Worker has no STATIC_ORIGIN configured for non-WebSocket requests',
    )
  }
  return { accepted: true, kind: 'static', origin: env.STATIC_ORIGIN }
}

export function refuseResponse(decision) {
  return new Response(decision.reason, { status: decision.status })
}
