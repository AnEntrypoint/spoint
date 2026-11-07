import * as THREE from 'three'
import { createXRWidgets } from '../client/xr/XRWidgets.js'

const FLOOR_Y = 2
const MARKER_LIFT_M = 0.02
const TOLERANCE_M = 1e-4
const AIM_ORIGIN = new THREE.Vector3(0, 3, 0)
const AIM_DIRECTION = new THREE.Vector3(0, -0.5, -0.866).normalize()

function build({ withFloor }) {
  const scene = new THREE.Scene()
  if (withFloor) {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial())
    floor.rotation.x = -Math.PI / 2
    floor.position.y = FLOOR_Y
    scene.add(floor)
  }
  scene.updateMatrixWorld(true)
  const camera = new THREE.PerspectiveCamera()
  const widgets = createXRWidgets(scene, camera, { teleportEnabled: true, vignetteEnabled: false }, () => true)
  widgets.initTeleport()
  widgets.updateTeleportArc({ origin: AIM_ORIGIN, direction: AIM_DIRECTION, trigger: false })
  return scene.getObjectByName('teleportMarker')
}

const withFloor = build({ withFloor: true })
const markerY = withFloor.position.y
const expectedY = FLOOR_Y + MARKER_LIFT_M
const floorOk = withFloor.visible && Math.abs(markerY - expectedY) < TOLERANCE_M

const noFloor = build({ withFloor: false })
const voidOk = noFloor.visible === false

console.log(`floor marker visible=${withFloor.visible} y=${markerY} expected=${expectedY}`)
console.log(`no-floor marker visible=${noFloor.visible} (expected false: no ground, no teleport target)`)
const pass = floorOk && voidOk
console.log(`RESULT: ${pass ? 'PASS' : 'FAIL'} teleport marker sits on the scene surface it hits, and no-surface shows no target`)
process.exitCode = pass ? 0 : 1
