import { PhysicsWorld } from '../physics/World.js'
import worldConfig from '../../apps/world/index.js'

async function validateSpawnPoints() {
  console.log('[validate] Validating spawn points...')

  const world = new PhysicsWorld(worldConfig)
  await world.init()

  try {
    await world.addStaticTrimeshAsync('./apps/maps/aim_sillos.glb', { position: [0, 0, 0] })
  } catch (e) {
    console.error('[validate] Failed to load map:', e.message)
    world.destroy()
    return false
  }

  const spawnPoints = worldConfig.spawnPoints
  console.log(`[validate] Checking ${spawnPoints.length} spawn points...`)

  let valid = 0
  let invalid = 0
  const issues = []

  for (let i = 0; i < spawnPoints.length; i++) {
    const [x, y, z] = spawnPoints[i]

    let isOk = true
    const checks = []

    if (x < -30 || x > 30) {
      checks.push(`X=${x} out of map bounds [-26, 26]`)
      isOk = false
    }
    if (z < -55 || z > 15) {
      checks.push(`Z=${z} out of map bounds [-53, 12]`)
      isOk = false
    }
    if (y < -10 || y > 5) {
      checks.push(`Y=${y} out of reasonable range [-10, 5]`)
      isOk = false
    }

    const hit = world.raycast([x, y + 10, z], [0, -1, 0], 20)
    const terrainY = hit.hit ? hit.position[1] : null

    if (!hit.hit) {
      checks.push(`No terrain found below spawn point`)
      isOk = false
    } else if (Math.abs(y - terrainY) > 1.5) {
      checks.push(`Spawn Y=${y.toFixed(2)} is ${Math.abs(y - terrainY).toFixed(2)} units from terrain Y=${terrainY.toFixed(2)}`)
      isOk = false
    }

    if (isOk) {
      valid++
    } else {
      invalid++
      issues.push({ index: i, point: [x, y, z], checks })
      if (invalid <= 5) {
        console.log(`  [${i}] INVALID: ${checks.join('; ')}`)
      }
    }
  }

  world.destroy()

  console.log(`\n[validate] RESULTS:`)
  console.log(`  Valid: ${valid}/${spawnPoints.length}`)
  console.log(`  Invalid: ${invalid}/${spawnPoints.length}`)

  if (invalid > 0 && invalid <= 10) {
    console.log('\n[validate] Issues:')
    issues.forEach(i => {
      console.log(`  [${i.index}] [${i.point[0]}, ${i.point[1]}, ${i.point[2]}]: ${i.checks.join('; ')}`)
    })
  }

  if (valid === spawnPoints.length) {
    console.log('\n[validate] SUCCESS - All spawn points are valid!')
    return true
  } else {
    console.log(`\n[validate] WARNING - ${invalid} invalid spawn points`)
    return false
  }
}

validateSpawnPoints().then(ok => {
  process.exit(ok ? 0 : 1)
}).catch(e => {
  console.error('[validate] ERROR:', e)
  process.exit(1)
})
