import { worldToScreen } from '../client/AppModuleSystem.js'
import { parseAnchorOffset, placeAnchoredPlates } from '../client/hudAnchor.js'

let failures = 0
function expect(label, got, want) {
  const ok = Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
}

class Vector3 {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z }
  project() {
    const x = this.x * 0.5, y = this.y * 0.5, z = this.z * 0.1
    this.x = x; this.y = y; this.z = z
    return this
  }
}
const THREE = { Vector3 }
const camera = { position: { x: 0, y: 0, z: 0 } }
const renderer = { domElement: { clientWidth: 800, clientHeight: 600 } }

const onscreen = worldToScreen({ x: 2, y: 2, z: 0 }, camera, renderer, THREE)
expect('worldToScreen top-right maps to canvas corner x', onscreen.x, 800)
expect('worldToScreen top-right maps to canvas corner y', onscreen.y, 0)
expect('worldToScreen top-right is onScreen', onscreen.onScreen, true)
expect('worldToScreen null camera yields null', worldToScreen({ x: 0, y: 0, z: 0 }, null, renderer, THREE), null)

expect('parseAnchorOffset absent yields default', parseAnchorOffset(null), [0, 2, 0])
expect('parseAnchorOffset parses three numbers', parseAnchorOffset('0.5 1 -0.25'), [0.5, 1, -0.25])
expect('parseAnchorOffset refuses two numbers', parseAnchorOffset('1 2'), null)
expect('parseAnchorOffset refuses non-numeric', parseAnchorOffset('1 x 3'), null)

function fakeEl(id, offset) {
  const attrs = { 'data-world-anchor': id }
  if (offset !== undefined) attrs['data-anchor-offset'] = offset
  const props = new Map()
  return {
    style: { setProperty(k, v) { props.set(k, v) }, _props: props },
    getAttribute: (k) => attrs[k] ?? null,
  }
}
const plate = fakeEl('7')
const bad = fakeEl('7', 'nope')
const missing = fakeEl('99')
const container = { querySelectorAll: () => [plate, bad, missing] }
const entities = [{ id: 7, position: [1, 0, 0] }]
const placed = placeAnchoredPlates(container, entities, camera, renderer, THREE, (p, c, r, T) => worldToScreen(p, c, r, T))
expect('one plate placed', placed, 1)
expect('placed plate is visible', plate.style.display, '')
expect('placed plate is fixed', plate.style.position, 'fixed')
expect('placed plate left from projection', plate.style.left, '600px')
expect('placed plate depth from camera', plate.style._props.get('--anchor-depth'), `${Math.hypot(1, 2)}`)
expect('malformed offset hides plate', bad.style.display, 'none')
expect('unknown entity hides plate', missing.style.display, 'none')

console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
