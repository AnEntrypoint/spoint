import { PhysicsWorld } from '../src/physics/World.js'
import { checksumBodies } from '../src/netcode/LockstepChecksum.js'

const peerId = process.argv[2]
const isCheater = process.argv[3] === 'cheat'
const totalTicks = Number(process.argv[4] || 90)
const checksumIntervalTicks = Number(process.argv[5] || 10)

async function main() {
  const physics = new PhysicsWorld({ gravity: [0, -9.81, 0] })
  await physics.init()

  const bodyIds = []
  for (let i = 0; i < 5; i++) {
    const id = physics.addBody('sphere', 0.5, [i * 2 - 4, 10 + i, 0], 'dynamic')
    bodyIds.push(id)
  }

  for (let tick = 1; tick <= totalTicks; tick++) {
    physics.step(1 / 60)

    if (isCheater && tick === 45) {
      const cheatBodyId = bodyIds[2]
      physics._repositionBody(cheatBodyId, [999, 999, 999], null, true)
    }

    if (tick % checksumIntervalTicks === 0) {
      const snap = physics.snapshotBodies()
      const checksum = checksumBodies(tick, snap)
      process.stdout.write(JSON.stringify({ peerId, tick, checksum }) + '\n')
    }
  }

  process.exit(0)
}

main().catch(err => {
  process.stderr.write('peer error: ' + (err && err.stack || err) + '\n')
  process.exit(1)
})
