import Jolt from 'jolt-physics/wasm-compat'

const BODY_COUNT = 24
const TICKS = 600
const DT = 1 / 60
const COLLISION_STEPS = 2

function hash32(n) {
  let h = n | 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = (h ^ (h >>> 16)) >>> 0
  return h
}
function hashFloat(n) {
  return (hash32(n) % 100000) / 100000
}

async function main() {
  const J = await Jolt()

  const settings = new J.JoltSettings()
  settings.mMaxWorkerThreads = 0

  const objectLayerPairFilter = new J.ObjectLayerPairFilterTable(2)
  objectLayerPairFilter.EnableCollision(0, 1)
  objectLayerPairFilter.EnableCollision(1, 1)

  const BP_LAYER_NON_MOVING = 0
  const BP_LAYER_MOVING = 1
  const bpInterface = new J.BroadPhaseLayerInterfaceTable(2, 2)
  bpInterface.MapObjectToBroadPhaseLayer(0, new J.BroadPhaseLayer(BP_LAYER_NON_MOVING))
  bpInterface.MapObjectToBroadPhaseLayer(1, new J.BroadPhaseLayer(BP_LAYER_MOVING))

  settings.mObjectLayerPairFilter = objectLayerPairFilter
  settings.mBroadPhaseLayerInterface = bpInterface
  settings.mObjectVsBroadPhaseLayerFilter = new J.ObjectVsBroadPhaseLayerFilterTable(
    bpInterface, 2, objectLayerPairFilter, 2
  )

  const jolt = new J.JoltInterface(settings)
  const physicsSystem = jolt.GetPhysicsSystem()
  const bodyInterface = physicsSystem.GetBodyInterface()

  const groundShape = new J.BoxShape(new J.Vec3(50, 1, 50), 0.05, undefined)
  const groundSettings = new J.BodyCreationSettings(
    groundShape, new J.RVec3(0, -1, 0), new J.Quat(0, 0, 0, 1),
    J.EMotionType_Static, 0
  )
  bodyInterface.CreateAndAddBody(groundSettings, J.EActivation_DontActivate)

  const bodies = []
  for (let i = 0; i < BODY_COUNT; i++) {
    const x = (hashFloat(i * 3 + 1) - 0.5) * 20
    const y = 5 + hashFloat(i * 3 + 2) * 10
    const z = (hashFloat(i * 3 + 3) - 0.5) * 20
    const r = 0.3 + hashFloat(i * 7) * 0.4
    const shape = new J.SphereShape(r, undefined)
    const bs = new J.BodyCreationSettings(
      shape, new J.RVec3(x, y, z), new J.Quat(0, 0, 0, 1),
      J.EMotionType_Dynamic, 1
    )
    const body = bodyInterface.CreateBody(bs)
    bodyInterface.AddBody(body.GetID(), J.EActivation_Activate)
    bodies.push(body)
  }

  for (let t = 0; t < TICKS; t++) {
    jolt.Step(DT, COLLISION_STEPS)
  }

  const outP = new J.RVec3()
  const outR = new J.Quat()
  const samples = []
  for (const body of bodies) {
    const id = body.GetID()
    bodyInterface.GetPositionAndRotation(id, outP, outR)
    samples.push([outP.GetX(), outP.GetY(), outP.GetZ(), outR.GetX(), outR.GetY(), outR.GetZ(), outR.GetW()])
  }
  J.destroy(outP)
  J.destroy(outR)

  const buf = new ArrayBuffer(8)
  const dv = new DataView(buf)
  let checksum = 0n
  for (const s of samples) {
    for (const v of s) {
      dv.setFloat64(0, v, true)
      const lo = BigInt(dv.getUint32(0, true))
      const hi = BigInt(dv.getUint32(4, true))
      checksum ^= (hi << 32n) | lo
      checksum = ((checksum << 1n) | (checksum >> 63n)) & 0xffffffffffffffffn
    }
  }

  const result = {
    arch: process.arch,
    platform: process.platform,
    nodeVersion: process.version,
    bodies: BODY_COUNT,
    ticks: TICKS,
    checksum: checksum.toString(16),
    samples,
  }
  console.log(JSON.stringify(result))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
