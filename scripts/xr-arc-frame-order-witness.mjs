import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { createXRWidgets } from '../client/xr/XRWidgets.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const app = readFileSync(ROOT + 'client/app.js', 'utf8').split('\n')

const indexOfLine = (needle, from = 0) => {
  for (let i = from; i < app.length; i++) if (app[i].includes(needle)) return i
  return -1
}

const xrUpdate = indexOfLine('xrSystem?.update(ctx.res.frameDt, local)')
let enclosing = null
for (let i = xrUpdate; i >= 0; i--) {
  const m = /^function (\w+)\(/.exec(app[i])
  if (m) { enclosing = m[1]; break }
}
const animateAt = indexOfLine('function animate(ts)')
const frameRun = indexOfLine('frameGraph.run(_graphCtx)', animateAt)
const renderRun = indexOfLine('renderGraph.run(_graphCtx)', animateAt)
const sectionsWired = indexOfLine('createRenderGraph(buildFrameSectionNodes()') >= 0

const orderOk = xrUpdate > 0 && enclosing === 'buildFrameSectionNodes' && animateAt >= 0 && frameRun > animateAt && renderRun > frameRun && sectionsWired

function build({ withFloor, updateMatrices }) {
  const scene = new THREE.Scene()
  if (withFloor) {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial())
    floor.rotation.x = -Math.PI / 2
    floor.position.y = 2
    scene.add(floor)
  }
  if (updateMatrices) scene.updateMatrixWorld(true)
  const widgets = createXRWidgets(scene, new THREE.PerspectiveCamera(), { teleportEnabled: true, vignetteEnabled: false }, () => true)
  widgets.initTeleport()
  widgets.updateTeleportArc({ origin: new THREE.Vector3(0, 3, 0), direction: new THREE.Vector3(0, -0.5, -0.866).normalize(), trigger: false })
  return scene.getObjectByName('teleportMarker')
}

const beforeRender = build({ withFloor: true, updateMatrices: false })
const afterRender = build({ withFloor: true, updateMatrices: true })
const lagOk = beforeRender.visible === false && afterRender.visible === true && Math.abs(afterRender.position.y - 2.02) < 1e-4

console.log(`app.js: xrSystem.update at line ${xrUpdate + 1}, inside ${enclosing}; animate line ${animateAt + 1}; frameGraph.run line ${frameRun + 1}; renderGraph.run line ${renderRun + 1}; sections wired=${sectionsWired}`)
console.log(`no matrix update yet: marker visible=${beforeRender.visible} (a mesh with no render has no valid world matrix)`)
console.log(`after a matrix update: marker visible=${afterRender.visible} y=${afterRender.position.y}`)
const pass = orderOk && lagOk
console.log(`RESULT: ${pass ? 'PASS' : 'FAIL'} the arc runs in the frame section before the render, and reads the matrices the previous render left`)
process.exitCode = pass ? 0 : 1
