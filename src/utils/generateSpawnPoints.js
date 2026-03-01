import { PhysicsWorld } from '../physics/World.js'
import worldConfig from '../../apps/world/index.js'

async function generateSpawnPoints() {
  console.log('[spawn-gen] Starting spawn point generation...')

  const world = new PhysicsWorld(worldConfig)
  await world.init()

  try {
    await world.addStaticTrimeshAsync('./apps/maps/aim_sillos.glb', { position: [0, 0, 0] })
    console.log('[spawn-gen] Map loaded')
  } catch (e) {
    console.error('[spawn-gen] Failed to load map:', e)
    world.destroy()
    return null
  }

  console.log('[spawn-gen] Sampling map surface...')

  const allPoints = []
  const gridSpacing = 1.5

  for (let x = -26; x <= 26; x += gridSpacing) {
    for (let z = -53; z <= 12; z += gridSpacing) {
      const hit = world.raycast([x, 50, z], [0, -1, 0], 100)
      if (hit.hit && hit.position && hit.position[1] > -10) {
        const y = Math.max(-8, hit.position[1] + 0.5)
        allPoints.push({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, z: Math.round(z * 100) / 100 })
      }
    }
  }

  console.log(`[spawn-gen] Found ${allPoints.length} surface points`)

  if (allPoints.length === 0) {
    console.error('[spawn-gen] No surface points found')
    world.destroy()
    return null
  }

  const stats = {
    minY: Math.min(...allPoints.map(p => p.y)),
    maxY: Math.max(...allPoints.map(p => p.y)),
    avgY: allPoints.reduce((sum, p) => sum + p.y, 0) / allPoints.length
  }
  console.log(`[spawn-gen] Surface Y range: [${stats.minY.toFixed(2)}, ${stats.maxY.toFixed(2)}], avg: ${stats.avgY.toFixed(2)}`)

  console.log('[spawn-gen] Clustering into spawn regions...')

  const cols = 11
  const rows = 7
  const gridCols = Math.ceil((26 - (-26)) / (cols + 1))
  const gridRows = Math.ceil((12 - (-53)) / (rows + 1))

  const spawnPoints = []
  const minSpacing = 3

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const regionX = -26 + col * gridCols
      const regionZ = -53 + row * gridRows
      const regionRadius = Math.max(gridCols, gridRows) / 2

      let best = null
      let bestDist = Infinity

      for (const point of allPoints) {
        const distX = point.x - regionX
        const distZ = point.z - regionZ
        const dist = Math.sqrt(distX * distX + distZ * distZ)

        if (dist < bestDist) {
          bestDist = dist
          best = point
        }
      }

      if (best) {
        let isFar = true
        for (const existing of spawnPoints) {
          const dx = best.x - existing[0]
          const dz = best.z - existing[2]
          const spacing = Math.sqrt(dx * dx + dz * dz)
          if (spacing < minSpacing) {
            isFar = false
            break
          }
        }

        if (isFar) {
          spawnPoints.push([best.x, best.y, best.z])
        }
      }
    }
  }

  const fallback = allPoints.slice(0, 77 - spawnPoints.length)
  for (const point of fallback) {
    if (spawnPoints.length >= 77) break
    spawnPoints.push([point.x, point.y, point.z])
  }

  world.destroy()

  console.log(`\n[spawn-gen] Generated ${spawnPoints.length} spawn points`)
  console.log('[spawn-gen] First 15 spawn points:')
  for (let i = 0; i < Math.min(15, spawnPoints.length); i++) {
    const [x, y, z] = spawnPoints[i]
    console.log(`  [${i}] [${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}]`)
  }

  return spawnPoints
}

generateSpawnPoints().then(points => {
  if (!points || points.length === 0) {
    console.error('[spawn-gen] FAILED')
    process.exit(1)
  }

  console.log('\n[spawn-gen] JavaScript array for apps/world/index.js:')
  console.log('  spawnPoints: [')
  for (let i = 0; i < points.length; i++) {
    const [x, y, z] = points[i]
    const comma = i < points.length - 1 ? ',' : ''
    console.log(`    [${x}, ${y}, ${z}]${comma}`)
  }
  console.log('  ],')

  console.log('\n[spawn-gen] SUCCESS')
  process.exit(0)
}).catch(e => {
  console.error('[spawn-gen] ERROR:', e)
  process.exit(1)
})
