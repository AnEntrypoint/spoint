import { worldToScreen } from '../client/AppModuleSystem.js'

let failures = 0
function expect(label, got, want) {
  const ok = Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
}

class Vector3 {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z }
  project(camera) {
    const { x, y, z } = this
    const ndc = camera.project(x, y, z)
    this.x = ndc.x; this.y = ndc.y; this.z = ndc.z
    return this
  }
}
const THREE = { Vector3 }

const camera = {
  project: (x, y, z) => (z < 0 ? { x: x / -z, y: y / -z, z: 0.5 } : { x: 9, y: 9, z: 2 })
}
const renderer = { domElement: { clientWidth: 800, clientHeight: 600 } }

const centre = worldToScreen({ x: 0, y: 0, z: -10 }, camera, renderer, THREE)
expect('centre point x is canvas centre', centre.x, 400)
expect('centre point y is canvas centre', centre.y, 300)
expect('centre point onScreen', centre.onScreen, true)
expect('centre point depth', centre.depth, 0.5)

const off = worldToScreen({ x: 100, y: 0, z: -10 }, camera, renderer, THREE)
expect('point beyond right edge is offscreen', off.onScreen, false)
expect('point beyond right edge keeps projected x', off.x > 800, true)

const behind = worldToScreen({ x: 0, y: 0, z: 10 }, camera, renderer, THREE)
expect('point behind camera is offscreen', behind.onScreen, false)

expect('null camera yields null', worldToScreen({ x: 0, y: 0, z: 0 }, null, renderer, THREE), null)
expect('null position yields null', worldToScreen(null, camera, renderer, THREE), null)

if (failures > 0) {
  console.log(`RESULT: FAIL (${failures} checks)`)
  process.exit(1)
}
console.log('RESULT: PASS')
