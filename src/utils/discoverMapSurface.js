import { PhysicsWorld } from '../physics/World.js'
import worldConfig from '../../apps/world/index.js'

async function discoverMapSurface() {
  console.log('[map-surface] Starting map surface discovery...')

  const world = new PhysicsWorld(worldConfig)
  await world.init()

  const mapEntity = { position: [0, 0, 0] }
  try {
    await world.addStaticTrimeshAsync('./apps/maps/aim_sillos.glb', mapEntity)
    console.log('[map-surface] Map geometry loaded successfully')
  } catch (e) {
    console.error('[map-surface] Failed to load map:', e.message)
    world.destroy()
    return null
  }

  console.log('[map-surface] Sampling map surface at grid points...')

  const discovered = []
  const gridSpacing = 3
  const startX = -25, endX = 25
  const startZ = -50, endZ = 10
  const sampleY = 50

  for (let x = startX; x <= endX; x += gridSpacing) {
    for (let z = startZ; z <= endZ; z += gridSpacing) {
      const hit = world.raycast([x, sampleY, z], [0, -1, 0], 100)

      if (hit.hit && hit.position) {
        const y = hit.position[1] + 1.0
        if (discovered.length < 50) {
          console.log(`  (${x.toFixed(1)}, ${z.toFixed(1)}) -> Y=${y.toFixed(2)}`)
        }
        discovered.push({ x, y, z })
      }
    }
  }

  world.destroy()

  console.log(`\n[map-surface] Discovered ${discovered.length} surface points`)

  if (discovered.length === 0) {
    console.log('[map-surface] No surface points found!')
    return null
  }

  const avgY = discovered.reduce((sum, p) => sum + p.y, 0) / discovered.length
  const minY = Math.min(...discovered.map(p => p.y))
  const maxY = Math.max(...discovered.map(p => p.y))

  console.log(`[map-surface] Y range: [${minY.toFixed(2)}, ${maxY.toFixed(2)}]`)
  console.log(`[map-surface] Average Y: ${avgY.toFixed(2)}`)

  const spawnPoints = discovered.slice(0, 77).map(p => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, Math.round(p.z * 10) / 10])

  if (spawnPoints.length < 77) {
    console.log(`[map-surface] WARNING: Only found ${spawnPoints.length} valid spawn points, need 77`)
  }

  console.log('\n[map-surface] Generated spawn points:')
  for (let i = 0; i < Math.min(10, spawnPoints.length); i++) {
    console.log(`  [${i}] [${spawnPoints[i][0]}, ${spawnPoints[i][1]}, ${spawnPoints[i][2]}]`)
  }

  return spawnPoints
}

discoverMapSurface().then(points => {
  if (!points) {
    console.error('[map-surface] FAILED')
    process.exit(1)
  }
  console.log('[map-surface] SUCCESS')
  process.exit(0)
}).catch(e => {
  console.error('[map-surface] ERROR:', e)
  process.exit(1)
})
