import { PhysicsWorld } from '../physics/World.js'
import worldConfig from '../../apps/world/index.js'

async function discoverSpawnPoints() {
  console.log('[spawn-discovery] Starting spawn point discovery...')

  const world = new PhysicsWorld(worldConfig)
  await world.init()

  console.log('[spawn-discovery] Physics initialized. Loading map geometry...')

  const mapEntity = { position: [0, 0, 0] }
  try {
    await world.addStaticTrimeshAsync('./apps/maps/aim_sillos.glb', mapEntity)
    console.log('[spawn-discovery] Map geometry loaded successfully')
  } catch (e) {
    console.error('[spawn-discovery] Failed to load map:', e.message)
    world.destroy()
    return null
  }

  const discoveredPoints = []
  const stats = { hits: 0, misses: 0, min: Infinity, max: -Infinity, sum: 0 }

  console.log('[spawn-discovery] Raycasting from', worldConfig.spawnPoints.length, 'spawn locations...')

  for (let i = 0; i < worldConfig.spawnPoints.length; i++) {
    const [x, _, z] = worldConfig.spawnPoints[i]

    const rayOrigin = [x, 100, z]
    const rayDirection = [0, -1, 0]
    const maxDistance = 150

    const hit = world.raycast(rayOrigin, rayDirection, maxDistance)

    let newY
    if (hit.hit && hit.position) {
      newY = Math.max(-10, hit.position[1] + 1.0)
      stats.hits++
      stats.min = Math.min(stats.min, newY)
      stats.max = Math.max(stats.max, newY)
      stats.sum += newY

      if (i < 5 || i % 15 === 0) {
        console.log(`  [${i}] (${x}, ${z}) raycast HIT at Y=${hit.position[1].toFixed(2)} -> spawn at Y=${newY.toFixed(2)}`)
      }
    } else {
      newY = 5
      stats.misses++
      console.log(`  [${i}] (${x}, ${z}) raycast MISS -> default spawn at Y=5`)
    }

    discoveredPoints.push([x, newY, z])
  }

  world.destroy()

  const avgY = stats.hits > 0 ? stats.sum / stats.hits : 0
  console.log('\n[spawn-discovery] STATISTICS:')
  console.log(`  Raycast hits: ${stats.hits}/${worldConfig.spawnPoints.length}`)
  console.log(`  Raycast misses: ${stats.misses}/${worldConfig.spawnPoints.length}`)
  console.log(`  Terrain Y range: [${stats.min.toFixed(2)}, ${stats.max.toFixed(2)}]`)
  console.log(`  Average terrain Y: ${avgY.toFixed(2)}`)
  console.log(`  Total spawn points discovered: ${discoveredPoints.length}`)

  return discoveredPoints
}

discoverSpawnPoints().then(points => {
  if (!points) {
    console.error('[spawn-discovery] FAILED')
    process.exit(1)
  }

  console.log('\n[spawn-discovery] New spawn points array:')
  console.log('  spawnPoints: [')
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const comma = i < points.length - 1 ? ',' : ''
    console.log(`    [${p[0]}, ${p[1].toFixed(1)}, ${p[2]}]${comma}`)
  }
  console.log('  ]')

  console.log('\n[spawn-discovery] SUCCESS - Ready to update world config')
  process.exit(0)
}).catch(e => {
  console.error('[spawn-discovery] ERROR:', e)
  process.exit(1)
})
