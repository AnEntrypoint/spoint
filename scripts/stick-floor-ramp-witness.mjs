import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const href = rel => pathToFileURL(path.join(ROOT, rel)).href

await installSpecifierHooks()
const { CharacterManager } = await import(href('src/physics/CharacterManager.js'))
const { createCollisionMirror } = await import(href('src/client/CollisionMirror.js'))
const { predictCharacterStep } = await import(href('src/shared/characterStep.js'))
const { DEFAULT_MOVEMENT } = await import(href('src/shared/movement.js'))

const STICK_M = 0.5
const GROUNDED_MIN = 0.9
const RAMP_DEG = 5
const RAMP_LEN_M = 40
const WALK_S = 6
const DT = 1 / 60
const HALF_HEIGHT_M = 1.0
const RADIUS_M = 0.4
const EDGE_M = 200
const CELL_M = 2
const ZHALF_M = 40
const BOTTOM_M = -4
const WINDOW = { x0: 2, x1: RAMP_LEN_M - 2 }

const rampTop = x => {
  if (x < 0) return 0
  if (x < RAMP_LEN_M) return -x * Math.tan(RAMP_DEG * Math.PI / 180)
  return -RAMP_LEN_M * Math.tan(RAMP_DEG * Math.PI / 180)
}

const triangles = []
for (let x = -60; x < 120; x += CELL_M) {
  for (let z = -ZHALF_M; z < ZHALF_M; z += CELL_M) {
    const a = [x, rampTop(x), z], b = [x + CELL_M, rampTop(x + CELL_M), z]
    const c = [x + CELL_M, rampTop(x + CELL_M), z + CELL_M], d = [x, rampTop(x), z + CELL_M]
    triangles.push([...a, ...c, ...b], [...a, ...d, ...c])
  }
}
const verts = new Float32Array(triangles.flat())

const groundedFraction = async stickM => {
  const realInit = CharacterManager.prototype.init
  CharacterManager.prototype.init = function (J, jolt, ps) {
    realInit.call(this, J, jolt, ps)
    this._updateSettings.mStickToFloorStepDown = new J.Vec3(0, -stickM, 0)
  }
  const mirror = createCollisionMirror()
  await mirror.configure({ radius: RADIUS_M, halfHeight: HALF_HEIGHT_M, crouchHalfHeight: 0.45, maxSlopeAngle: 0.7854, maxStepHeight: 0.4, stickToFloorDistance: stickM, mass: 120, gravity: [0, -9.81, 0], tileM: 16, marginM: 3, forgetRing: 2 })
  CharacterManager.prototype.init = realInit
  for (let tx = -5; tx <= 8; tx++) for (let tz = -4; tz <= 3; tz++) mirror.onTile({ tx, tz, h: 0, v: new Uint8Array(verts.buffer.slice(0)) })
  const state = { position: [-10, HALF_HEIGHT_M + RADIUS_M, 0], velocity: [0, 0, 0], onGround: false, groundNormal: null, groundY: NaN }
  const env = { collider: { step: (s, inp, dt, g, wg) => { mirror.covers(s.position); mirror.step(s, inp, dt, g, wg) } }, gravityY: -9.81, ground: null, wedged: false, groundNormal: null, walls: null, wallExtentM: 0, wedgeNormal: null }
  const input = { forward: true, yaw: Math.PI / 2 }
  const window = []
  for (let i = 0; i < Math.round(WALK_S / DT); i++) {
    predictCharacterStep(state, input, DEFAULT_MOVEMENT, DT, env)
    if (state.position[0] > WINDOW.x0 && state.position[0] < WINDOW.x1) window.push(!!state.onGround)
  }
  const airborne = window.filter(g => !g).length
  return { samples: window.length, airborne, fraction: window.length ? (window.length - airborne) / window.length : 0 }
}

const withStick = await groundedFraction(STICK_M)
const withoutStick = await groundedFraction(0)
const pass = withStick.samples > 0 && withStick.fraction >= GROUNDED_MIN
console.log(`ramp ${RAMP_DEG} deg over ${RAMP_LEN_M} m, walk ${WALK_S} s at sprint-free default movement`)
console.log(`stick ${STICK_M} m: ${withStick.samples} samples, ${withStick.airborne} airborne, grounded ${withStick.fraction.toFixed(4)}`)
console.log(`stick 0 m: ${withoutStick.samples} samples, ${withoutStick.airborne} airborne, grounded ${withoutStick.fraction.toFixed(4)}`)
console.log(pass
  ? `RESULT: PASS the ${STICK_M} m stick-to-floor keeps the character grounded on a ${RAMP_DEG} deg ramp (${withStick.fraction.toFixed(4)} >= ${GROUNDED_MIN}); removing it drops grounded to ${withoutStick.fraction.toFixed(4)}`
  : `RESULT: FAIL the ${STICK_M} m stick-to-floor grounds ${withStick.fraction.toFixed(4)} of samples on a ${RAMP_DEG} deg ramp, below ${GROUNDED_MIN}`)
process.exit(pass ? 0 : 1)
