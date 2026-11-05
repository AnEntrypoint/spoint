function refusal(code, message) {
  const err = new TypeError(`[room-routing] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

function readRooms(rooms) {
  if (!Array.isArray(rooms)) throw refusal('room-rooms-invalid', 'rooms must be an array')
  return rooms.map((room, i) => {
    if (!room || typeof room !== 'object' || typeof room.id !== 'string' || !room.id) throw refusal('room-entry-invalid', `rooms[${i}] needs a non-empty string id`)
    if (!Number.isInteger(room.players) || room.players < 0) throw refusal('room-entry-invalid', `rooms[${i}].players must be a non-negative integer`)
    if (!Number.isInteger(room.maxPlayers) || room.maxPlayers < 1) throw refusal('room-entry-invalid', `rooms[${i}].maxPlayers must be a positive integer`)
    return { id: room.id, players: room.players, maxPlayers: room.maxPlayers }
  })
}

function available(rooms, { requestedRoomId = null, rejected = [] } = {}) {
  const blocked = new Set(Array.isArray(rejected) ? rejected.map(String) : [])
  return rooms.filter(room => room.players < room.maxPlayers && !blocked.has(room.id) && (requestedRoomId === null || room.id === String(requestedRoomId)))
}

export function firstOpenRoom(rooms, options = {}) {
  return available(readRooms(rooms), options)[0] ?? null
}

export function mostFullWithSpace(rooms, options = {}) {
  const candidates = available(readRooms(rooms), options)
  if (candidates.length === 0) return null
  return candidates.reduce((best, room) => room.players > best.players || (room.players === best.players && room.id < best.id) ? room : best)
}

export function nextRoomName(prefix, existing = []) {
  if (typeof prefix !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(prefix)) throw refusal('room-prefix-invalid', 'prefix must be a non-empty alphanumeric name')
  const taken = new Set(Array.isArray(existing) ? existing.map(String) : [])
  for (let n = 1; n <= 100000; n++) {
    const name = `${prefix}-${n}`
    if (!taken.has(name)) return name
  }
  throw refusal('room-name-exhausted', `no free ${prefix}-N name in the first 100000`)
}

export function parseRoomPickRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw refusal('room-request-invalid', 'request body must be an object')
  const rejected = body.rejected === undefined ? [] : body.rejected
  if (!Array.isArray(rejected) || rejected.some(id => typeof id !== 'string')) throw refusal('room-request-invalid', 'rejected must be an array of strings')
  const requestedRoomId = body.requestedRoomId ?? body.requested ?? null
  if (requestedRoomId !== null && typeof requestedRoomId !== 'string') throw refusal('room-request-invalid', 'requestedRoomId must be a string or null')
  const world = body.world ?? body.worldName ?? null
  if (world !== null && typeof world !== 'string') throw refusal('room-request-invalid', 'world must be a string or null')
  return { requestedRoomId, rejected, world }
}
