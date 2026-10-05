import { createServer as createNetServer } from 'node:net'
import { createServer } from '../sdk/server.js'
import { anchorBasis } from '../terrain/PlanetFrame.js'

const SPAWN_ABOVE_GROUND_M = 3

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)) })
  })
}

export function chartLocalSpawnOf(anchorDir, radius, dir) {
  const { up, east, north } = anchorBasis(anchorDir)
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const k = radius / dot(dir, up)
  return [dot(dir, east) * k, SPAWN_ABOVE_GROUND_M - 0.5 * ((dot(dir, east) * k) ** 2 + (dot(dir, north) * k) ** 2) / radius, dot(dir, north) * k]
}

export function createClusterServerWorldFactory({ baseWorldDef, serverConfig, host = '127.0.0.1' }) {
  async function createWorld(clusterId, descriptor) {
    const port = await freePort()
    const radius = baseWorldDef.terrain.radius
    const spawnPoints = (descriptor.spawnDirs || []).map(dir => chartLocalSpawnOf(descriptor.anchorDir, radius, dir))
    const worldDef = { ...baseWorldDef, terrain: { ...baseWorldDef.terrain, anchorDir: descriptor.anchorDir }, ...(spawnPoints.length ? { spawnPoint: spawnPoints[0], spawnPoints } : {}) }
    const server = await createServer({ ...serverConfig, port, gravity: worldDef.gravity })
    await server.loadWorld({ ...worldDef, tickRate: serverConfig.tickRate })
    await server.start()
    return { clusterId, server, port, url: `ws://${host}:${port}/ws`, anchorDir: descriptor.anchorDir }
  }
  async function destroyWorld(clusterId, world) {
    world.server.stop()
  }
  return { createWorld, destroyWorld }
}
