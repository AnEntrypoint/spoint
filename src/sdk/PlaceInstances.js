export const INSTANCE_SCOPES = Object.freeze(['party', 'solo'])
export const INSTANCE_LIFETIMES = Object.freeze(['ephemeral', 'session', 'persistent'])

export function instanceRoomId(scope, groupId) {
  if (!INSTANCE_SCOPES.includes(scope)) throw Object.assign(new Error(`PlaceInstances: scope "${scope}" is not one of ${INSTANCE_SCOPES.join(', ')}`), { reasonCode: 'instance-scope' })
  if (typeof groupId !== 'string' || groupId.length === 0) throw Object.assign(new Error(`PlaceInstances: ${scope} groupId must be a non-empty string`), { reasonCode: 'instance-group' })
  return `${scope}:${groupId}`
}

export class PlaceInstances {
  constructor(directory, { place, lifetime = 'session' } = {}) {
    if (!directory) throw new Error('PlaceInstances requires a RoomDirectory')
    if (typeof place !== 'string' || place.length === 0) throw Object.assign(new Error('PlaceInstances requires a place (world name)'), { reasonCode: 'instance-place' })
    if (!INSTANCE_LIFETIMES.includes(lifetime)) throw Object.assign(new Error(`PlaceInstances: lifetime "${lifetime}" is not one of ${INSTANCE_LIFETIMES.join(', ')}`), { reasonCode: 'instance-lifetime' })
    this.directory = directory
    this.place = place
    this.lifetime = lifetime
    this.pending = new Map()
  }

  get(scope, groupId) {
    return this.directory.getRoom(instanceRoomId(scope, groupId))
  }

  acquire(scope, groupId, opts = {}) {
    const roomId = instanceRoomId(scope, groupId)
    const existing = this.directory.getRoom(roomId)
    if (existing) return Promise.resolve(existing)
    const inflight = this.pending.get(roomId)
    if (inflight) return inflight
    const created = this.directory.createRoom(roomId, this.place, opts)
      .finally(() => this.pending.delete(roomId))
    this.pending.set(roomId, created)
    return created
  }

  async release(scope, groupId) {
    const roomId = instanceRoomId(scope, groupId)
    const handle = this.directory.getRoom(roomId)
    if (!handle) return false
    if (this.lifetime !== 'ephemeral') return false
    if (handle.server.playerManager.getPlayerCount() > 0) return false
    return this.directory.stopRoom(roomId)
  }

  async sweep() {
    if (this.lifetime !== 'ephemeral') return 0
    const empty = this.directory.listRooms()
      .filter(r => r.roomId.startsWith('party:') || r.roomId.startsWith('solo:'))
      .filter(r => r.server.playerManager.getPlayerCount() === 0)
    const stopped = await Promise.all(empty.map(r => this.directory.stopRoom(r.roomId)))
    return stopped.filter(Boolean).length
  }

  list(scope = null) {
    return this.directory.listRooms()
      .filter(r => scope == null ? /^(party|solo):/.test(r.roomId) : r.roomId.startsWith(`${scope}:`))
      .map(r => ({ roomId: r.roomId, port: r.port, worldName: r.worldName, players: r.server.playerManager.getPlayerCount() }))
  }
}
