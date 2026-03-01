import { PhysicsWorld } from '../physics/World.js'
import { extractAllMeshesFromGLBAsync } from '../physics/GLBLoader.js'
import worldConfig from '../../apps/world/index.js'

async function debugMapGeometry() {
  console.log('[debug-map] Loading map geometry...')

  const meshData = await extractAllMeshesFromGLBAsync('./apps/maps/aim_sillos.glb')
  console.log('[debug-map] Mesh data:', {
    vertexCount: meshData.vertexCount,
    triangleCount: meshData.triangleCount,
  })

  const verts = meshData.vertices
  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  let minZ = Infinity, maxZ = -Infinity

  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i], y = verts[i+1], z = verts[i+2]
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
  }

  console.log('[debug-map] Mesh bounds:')
  console.log(`  X: [${minX.toFixed(2)}, ${maxX.toFixed(2)}]`)
  console.log(`  Y: [${minY.toFixed(2)}, ${maxY.toFixed(2)}]`)
  console.log(`  Z: [${minZ.toFixed(2)}, ${maxZ.toFixed(2)}]`)

  console.log('\n[debug-map] Spawn point X,Z ranges:')
  const spawnXs = worldConfig.spawnPoints.map(p => p[0])
  const spawnZs = worldConfig.spawnPoints.map(p => p[2])
  console.log(`  X: [${Math.min(...spawnXs)}, ${Math.max(...spawnXs)}]`)
  console.log(`  Z: [${Math.min(...spawnZs)}, ${Math.max(...spawnZs)}]`)

  console.log('\n[debug-map] Checking if spawn points are within map bounds...')
  const inBounds = worldConfig.spawnPoints.filter(p => {
    const x = p[0], z = p[2]
    const xOk = x >= minX && x <= maxX
    const zOk = z >= minZ && z <= maxZ
    return xOk && zOk
  }).length

  console.log(`  ${inBounds}/${worldConfig.spawnPoints.length} spawn points are within X,Z bounds`)

  if (inBounds < worldConfig.spawnPoints.length) {
    console.log('\n[debug-map] Out-of-bounds spawn points:')
    worldConfig.spawnPoints.forEach((p, i) => {
      const x = p[0], z = p[2]
      const xOk = x >= minX && x <= maxX
      const zOk = z >= minZ && z <= maxZ
      if (!xOk || !zOk) {
        console.log(`  [${i}] (${x}, ${z})${!xOk ? ' X out of bounds' : ''}${!zOk ? ' Z out of bounds' : ''}`)
      }
    })
  }

  console.log('\n[debug-map] Testing raycast with physics world...')
  const world = new PhysicsWorld(worldConfig)
  await world.init()

  const mapEntity = { position: [0, 0, 0] }
  await world.addStaticTrimeshAsync('./apps/maps/aim_sillos.glb', mapEntity)

  const testPoints = [
    [0, 100, 0],
    [-850, 100, -80],
    [950, 100, 880],
    [0, 50, 0],
    [0, 30, 0],
    [0, 10, 0],
  ]

  console.log('\n[debug-map] Test raycasts from high altitude downward:')
  for (const [x, y, z] of testPoints) {
    const hit = world.raycast([x, y, z], [0, -1, 0], 200)
    const status = hit.hit ? `HIT at Y=${hit.position[1].toFixed(2)}` : 'MISS'
    console.log(`  Raycast from (${x}, ${y}, ${z}): ${status}`)
  }

  console.log('\n[debug-map] Test raycasts from below upward:')
  for (const [x, y, z] of testPoints) {
    const hit = world.raycast([x, 0, z], [0, 1, 0], 200)
    const status = hit.hit ? `HIT at Y=${hit.position[1].toFixed(2)}` : 'MISS'
    console.log(`  Raycast from (${x}, 0, ${z}) upward: ${status}`)
  }

  world.destroy()
  console.log('[debug-map] Done')
}

debugMapGeometry().catch(e => {
  console.error('[debug-map] ERROR:', e)
  process.exit(1)
})
