export class SeatError extends Error {
  constructor(reasonCode, detail) {
    super(`seat ${reasonCode}${detail === undefined ? '' : ` ${detail}`}`)
    this.name = 'SeatError'
    this.reasonCode = reasonCode
  }
}

const ROLES = Object.freeze(['driver', 'passenger'])

function vec3Or(value, reasonCode, id) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) throw new SeatError(reasonCode, id)
  return Object.freeze([...value])
}

function normalizeGrips(grips, id) {
  if (grips === undefined) return Object.freeze({})
  if (grips === null || typeof grips !== 'object' || Array.isArray(grips)) throw new SeatError('grips-not-object', id)
  const out = {}
  for (const [hand, bone] of Object.entries(grips)) {
    if (hand !== 'left' && hand !== 'right') throw new SeatError('grip-hand-unknown', `${id}.${hand}`)
    if (typeof bone !== 'string' || bone === '') throw new SeatError('grip-bone-missing', `${id}.${hand}`)
    out[hand] = bone
  }
  return Object.freeze(out)
}

export function normalizeSeatDef(seatId, def) {
  if (typeof seatId !== 'string' || seatId === '') throw new SeatError('seat-id-missing')
  if (def === null || typeof def !== 'object') throw new SeatError('def-not-object', seatId)
  if (!ROLES.includes(def.role)) throw new SeatError('role-unknown', seatId)
  return Object.freeze({
    id: seatId,
    role: def.role,
    offset: vec3Or(def.offset, 'offset-not-vec3', seatId),
    bone: def.bone === undefined || def.bone === null ? null : def.bone,
    grips: normalizeGrips(def.grips, seatId)
  })
}

export function createSeatTable() {
  const vehicles = new Map()
  const riders = new Map()

  const vehicleOf = entityId => {
    const v = vehicles.get(entityId)
    if (!v) throw new SeatError('vehicle-unknown', entityId)
    return v
  }

  const occupantOf = (v, seatId) => {
    const playerId = v.occupied.get(seatId)
    return playerId === undefined ? null : playerId
  }

  const seatView = (entityId, v, seatId) => {
    const def = v.seats.get(seatId)
    const playerId = occupantOf(v, seatId)
    return { entityId, seatId, role: def.role, offset: [...def.offset], bone: def.bone, grips: { ...def.grips }, playerId }
  }

  return {
    define(entityId, seats) {
      if (typeof entityId !== 'string' && typeof entityId !== 'number') throw new SeatError('entity-id-invalid')
      if (seats === null || typeof seats !== 'object' || Array.isArray(seats)) throw new SeatError('seats-not-object', entityId)
      const table = new Map()
      for (const [seatId, def] of Object.entries(seats)) table.set(seatId, normalizeSeatDef(seatId, def))
      if (![...table.values()].some(s => s.role === 'driver')) throw new SeatError('no-driver-seat', entityId)
      if ((vehicles.get(entityId)?.occupied.size ?? 0) > 0) throw new SeatError('redefine-while-occupied', entityId)
      vehicles.set(entityId, { seats: table, occupied: new Map() })
      return [...table.keys()]
    },

    undefine(entityId) {
      const v = vehicles.get(entityId)
      if (!v) return null
      const released = [...v.occupied.values()]
      for (const playerId of released) riders.delete(playerId)
      vehicles.delete(entityId)
      return released
    },

    mount(playerId, entityId, seatId) {
      if (typeof playerId !== 'string' && typeof playerId !== 'number') throw new SeatError('player-id-invalid')
      const v = vehicleOf(entityId)
      if (!v.seats.has(seatId)) throw new SeatError('seat-unknown', `${entityId}.${seatId}`)
      if (riders.has(playerId)) throw new SeatError('player-already-mounted', playerId)
      if (occupantOf(v, seatId) !== null) throw new SeatError('seat-occupied', `${entityId}.${seatId}`)
      v.occupied.set(seatId, playerId)
      riders.set(playerId, { entityId, seatId })
      return seatView(entityId, v, seatId)
    },

    dismount(playerId) {
      const rider = riders.get(playerId)
      if (!rider) return null
      const v = vehicles.get(rider.entityId)
      riders.delete(playerId)
      if (v) v.occupied.delete(rider.seatId)
      return { entityId: rider.entityId, seatId: rider.seatId, playerId }
    },

    handoff(fromPlayerId, toPlayerId) {
      const rider = riders.get(fromPlayerId)
      if (!rider) throw new SeatError('source-not-mounted', fromPlayerId)
      if (riders.has(toPlayerId)) throw new SeatError('target-already-mounted', toPlayerId)
      const v = vehicleOf(rider.entityId)
      if (v.seats.get(rider.seatId).role !== 'driver') throw new SeatError('handoff-not-driver', rider.seatId)
      v.occupied.set(rider.seatId, toPlayerId)
      riders.delete(fromPlayerId)
      riders.set(toPlayerId, { entityId: rider.entityId, seatId: rider.seatId })
      return seatView(rider.entityId, v, rider.seatId)
    },

    seatOf(playerId) {
      const rider = riders.get(playerId)
      if (!rider) return null
      return seatView(rider.entityId, vehicleOf(rider.entityId), rider.seatId)
    },

    seatsOf(entityId) {
      const v = vehicles.get(entityId)
      if (!v) return []
      return [...v.seats.keys()].map(seatId => seatView(entityId, v, seatId))
    },

    vehicleIds() {
      return [...vehicles.keys()]
    }
  }
}
