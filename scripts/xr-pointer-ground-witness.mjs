import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { createXRWidgets } from '../client/xr/XRWidgets.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TOLERANCE_M = 1e-4
const LIFT_M = 0.02
const BOX_TOP_Y = 1
const FLOOR_Y = 0

function build({ pointerFlag }) {
  const scene = new THREE.Scene()
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial())
  floor.rotation.x = -Math.PI / 2
  floor.position.y = FLOOR_Y
  scene.add(floor)
  const hand = new THREE.Mesh(new THREE.BoxGeometry(50, BOX_TOP_Y, 50), new THREE.MeshBasicMaterial())
  hand.position.y = BOX_TOP_Y / 2
  if (pointerFlag) hand.userData.xrPointer = true
  scene.add(hand)
  scene.updateMatrixWorld(true)
  const widgets = createXRWidgets(scene, new THREE.PerspectiveCamera(), { teleportEnabled: true, vignetteEnabled: false }, () => true)
  widgets.initTeleport()
  widgets.updateTeleportArc({ origin: new THREE.Vector3(0, 3, 0), direction: new THREE.Vector3(0, -0.5, -0.866).normalize(), trigger: false })
  return scene.getObjectByName('teleportMarker')
}

const flagged = build({ pointerFlag: true })
const unflagged = build({ pointerFlag: false })
const flaggedOk = flagged.visible && Math.abs(flagged.position.y - (FLOOR_Y + LIFT_M)) < TOLERANCE_M
const sensitiveOk = unflagged.visible && Math.abs(unflagged.position.y - (BOX_TOP_Y + LIFT_M)) < TOLERANCE_M

const source = readFileSync(ROOT + 'client/xr/XRSystem.js', 'utf8')
const pointerCalls = (source.match(/addPointerObject\(/g) ?? []).length
const directAdds = /scene\.add\((ctrl|grip|hand|arReticle)\)/.test(source)
const sourceOk = pointerCalls === 5 && !directAdds

console.log(`flagged pointer object: marker y=${flagged.position.y} expected floor ${FLOOR_Y + LIFT_M}`)
console.log(`unflagged same box: marker y=${unflagged.position.y} expected box top ${BOX_TOP_Y + LIFT_M} (proves the box is hit when not excluded)`)
console.log(`XRSystem.js: addPointerObject occurrences=${pointerCalls} (definition + 4 call sites), direct scene.add of pointer objects=${directAdds}`)
const pass = flaggedOk && sensitiveOk && sourceOk
console.log(`RESULT: ${pass ? 'PASS' : 'FAIL'} controller, grip, hand and reticle objects are excluded from the teleport ground probe`)
process.exitCode = pass ? 0 : 1
