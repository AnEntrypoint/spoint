import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const src = (f) => readFileSync(join(ROOT, 'client/xr', f), 'utf8')
const widgetsSrc = src('XRWidgets.js'), controlsSrc = src('XRControls.js'), systemSrc = src('XRSystem.js')

let failures = 0
const results = []
function check(id, name, ok, detail) {
  if (!ok) failures++
  results.push(`${ok ? 'PASS' : 'FAIL'} ${id} ${name} :: ${detail}`)
}

const { createXRWidgets } = await import(join(ROOT, 'client/xr/XRWidgets.js'))
const { XRControls } = await import(join(ROOT, 'client/xr/XRControls.js'))

check('KISS-1', 'no xstate import or fadeMachine in XRWidgets', !/xstate|createMachine|fadeMachine/.test(widgetsSrc), 'static source scan')
const scene = { added: [], add(o) { this.added.push(o) } }
const camera = { added: [], add(o) { this.added.push(o) } }
let moveResult = false
const w = createXRWidgets(scene, camera, { snapTurnAngle: 30, smoothTurnSpeed: 2, vignetteEnabled: false, playerHeight: 1.6, teleportEnabled: true }, () => moveResult)
w.initTeleport()
w.updateTeleportArc({ origin: { x: 0, y: 2, z: 0 }, direction: { x: 0, y: -1, z: 0 }, trigger: true })
check('KISS-2', 'teleport pending after trigger', w.isTeleporting === true, `isTeleporting=${w.isTeleporting}`)
w.updateFade(0.05)
const quad = camera.added[camera.added.length - 1]
const midOpacity = quad?.material?.opacity
await new Promise((r) => setTimeout(r, 260))
w.updateFade(0.05)
const afterAbort = quad?.material?.opacity
check('KISS-2', 'aborted teleport leaves no fade behind', midOpacity > 0 && afterAbort === 0 && w.isTeleporting === false,
  `opacityMidFade=${midOpacity} opacityAfterAbort=${afterAbort} isTeleporting=${w.isTeleporting}`)

const marker = (name) => scene.added.find((o) => o.name === name)
const hitYs = []
for (const oy of [1.7, 5]) {
  w.updateTeleportArc({ origin: { x: 0, y: oy, z: 0 }, direction: { x: 0, y: -1, z: 0 }, trigger: false })
  hitYs.push(marker('teleportMarker').position.y)
}
check('KISS-7', 'marker y independent of origin height (hardcoded ground)', hitYs[0] === hitYs[1],
  `markerY(originY=1.7)=${hitYs[0]} markerY(originY=5)=${hitYs[1]}`)
check('KISS-7', 'dead idx<positions.length guard removed', !/idx < positions\.length/.test(widgetsSrc), 'static source scan')

const xc = new XRControls({ placementMode: true })
check('KISS-3', 'placeAtCamera / getPlacementInfo / options.scale absent',
  typeof xc.placeAtCamera === 'undefined' && typeof xc.getPlacementInfo === 'undefined' && xc.options.scale === undefined,
  `placeAtCamera=${typeof xc.placeAtCamera} getPlacementInfo=${typeof xc.getPlacementInfo} options=${JSON.stringify(xc.options)}`)
check('KISS-4', 'reticleVisible mirror and placeAnchor absent', !('reticleVisible' in xc) && typeof xc.placeAnchor === 'undefined',
  `reticleVisible=${'reticleVisible' in xc} placeAnchor=${typeof xc.placeAnchor}`)
check('KISS-5', 'no plane mesh surface on XRControls', typeof xc.onPlanesDetected === 'undefined' && !/planeMeshes|planes\s*=/.test(controlsSrc),
  `onPlanesDetected=${typeof xc.onPlanesDetected}`)

check('KISS-6', 'no absolute-clock modulo gates in XRSystem', !/%\s*66|%\s*100/.test(systemSrc) && /Elapsed\s*\+=\s*step/.test(systemSrc),
  'static source scan: accumulator "+= step" present, "% 66" and "% 100" absent')

check('KISS-8', 'widgets holds no handsDetected copy', !/handsDetected/.test(widgetsSrc), 'static source scan of XRWidgets.js')
check('KISS-8', 'wristUI read through one object (no three aliases)', !/wristUICanvas|wristUIContext/.test(widgetsSrc), 'static source scan')

check('KISS-9', 'no _tmp1/_tmp2 scratch vectors', !/_tmp1|_tmp2/.test(widgetsSrc), 'static source scan')

check('KISS-10', 'no __freshnessProbe export in XRWidgets', !/__freshnessProbe/.test(widgetsSrc), 'static source scan')

console.log(results.join('\n'))
console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
