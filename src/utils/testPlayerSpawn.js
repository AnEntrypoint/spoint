import { PhysicsWorld } from '../physics/World.js'
import worldConfig from '../../apps/world/index.js'

async function testPlayerSpawn() {
  console.log('[test-spawn] Testing player spawn integration...')

  const world = new PhysicsWorld(worldConfig)
  await world.init()

  try {
    await world.addStaticTrimeshAsync('./apps/maps/aim_sillos.glb', { position: [0, 0, 0] })
  } catch (e) {
    console.error('[test-spawn] Failed to load map:', e.message)
    world.destroy()
    return false
  }

  const playerConfig = worldConfig.player
  const spawnPoints = worldConfig.spawnPoints

  console.log(`[test-spawn] Player config: capsule R=${playerConfig.capsuleRadius}, H=${playerConfig.capsuleHalfHeight}`)
  console.log(`[test-spawn] Testing ${Math.min(5, spawnPoints.length)} spawn locations...`)

  const testIndices = [0, Math.floor(spawnPoints.length / 4), Math.floor(spawnPoints.length / 2), Math.floor(3 * spawnPoints.length / 4), spawnPoints.length - 1]

  let passCount = 0

  for (const idx of testIndices) {
    if (idx >= spawnPoints.length) continue

    const [spawnX, spawnY, spawnZ] = spawnPoints[idx]

    const playerId = `test-player-${idx}`
    const capsuleId = world.addBody(
      'capsule',
      [playerConfig.capsuleRadius, playerConfig.capsuleHalfHeight],
      [spawnX, spawnY, spawnZ],
      'dynamic',
      { mass: playerConfig.mass }
    )

    if (!capsuleId) {
      console.log(`  [${idx}] FAIL: Could not create capsule at (${spawnX}, ${spawnY}, ${spawnZ})`)
      continue
    }

    world.step(0.016)

    const bodyPos = world.getBodyPosition(capsuleId)
    const dy = bodyPos[1] - spawnY

    const isGrounded = dy < 0.5 && dy >= -0.5

    if (isGrounded) {
      console.log(`  [${idx}] PASS: Spawned at (${spawnX.toFixed(1)}, ${spawnY.toFixed(1)}, ${spawnZ.toFixed(1)}) -> settled at Y=${bodyPos[1].toFixed(2)}`)
      passCount++
    } else {
      console.log(`  [${idx}] FAIL: Spawned at Y=${spawnY.toFixed(1)} but settled at Y=${bodyPos[1].toFixed(2)} (diff=${dy.toFixed(2)})`)
    }

    world.removeBody(capsuleId)
  }

  world.destroy()

  const passRate = passCount / testIndices.length
  console.log(`\n[test-spawn] Results: ${passCount}/${testIndices.length} spawn tests passed (${(passRate * 100).toFixed(0)}%)`)

  if (passRate >= 0.8) {
    console.log('[test-spawn] SUCCESS - Player spawn integration working!')
    return true
  } else {
    console.log('[test-spawn] WARNING - Some spawn points failed physics validation')
    return false
  }
}

testPlayerSpawn().then(ok => {
  process.exit(ok ? 0 : 1)
}).catch(e => {
  console.error('[test-spawn] ERROR:', e)
  process.exit(1)
})
