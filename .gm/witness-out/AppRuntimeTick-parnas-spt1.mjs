import { AppRuntime } from '../../src/apps/AppRuntime.js'
import { SpatialIndex } from '../../src/spatial/Octree.js'
import { readFileSync } from 'node:fs'

const players = new Map()
const add = (id, pos) => players.set(id, { id, state: { position: pos } })
add(1, [0, 0, 0])
add(2, [5, 0, 0])
add(3, [200, 0, 0])

const runtime = new AppRuntime({
  playerManager: {
    getConnectedPlayers: () => [...players.values()],
    getPlayer: (id) => players.get(id) || null
  }
})

const out = []

runtime._syncPlayerIndex()
out.push('sync1 size=' + runtime._playerIndex.size)
out.push('sync1 nearby10=' + [...runtime.nearbyPlayerIds([0, 0, 0], 10)].sort().join(','))
out.push('sync1 has3=' + runtime._playerIndex.has(3))

players.delete(3)
runtime._syncPlayerIndex()
out.push('sync2 size=' + runtime._playerIndex.size)
out.push('sync2 nearby10=' + [...runtime.nearbyPlayerIds([0, 0, 0], 10)].sort().join(','))
out.push('sync2 has3=' + runtime._playerIndex.has(3))
out.push('nearest=' + String(runtime.getNearestPlayer([0, 0, 0], 10)?.id ?? 'null'))
out.push('getNearbyPlayers=' + typeof runtime.getNearbyPlayers)

const tick = readFileSync(new URL('../../src/apps/AppRuntimeTick.js', import.meta.url), 'utf8')
out.push('privateReach=' + (tick.split('._entities').length - 1))
out.push('idsAccessor=' + typeof new SpatialIndex().ids)

console.log(out.join('\n'))
