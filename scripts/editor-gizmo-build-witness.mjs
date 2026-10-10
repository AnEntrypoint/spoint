import { Ray, Vector3 } from 'three'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const TWO_PI = Math.PI * 2
const AXES = ['x', 'y', 'z']
const DEFAULT_MODULE_URL = new URL('../client/editor/EditorGizmoBuild.js', import.meta.url).href
const moduleArg = process.argv.find((arg) => arg.startsWith('--module='))
const MODULE_URL = moduleArg ? pathToFileURL(resolve(moduleArg.slice('--module='.length))).href : DEFAULT_MODULE_URL

let passes = 0
let failures = 0

function expect(name, ok, detail) {
  if (ok) {
    passes++
    process.stdout.write(`[PASS] ${name}\n`)
  } else {
    failures++
    process.stdout.write(`[FAIL] ${name}${detail === undefined ? '' : ` -- ${detail}`}\n`)
  }
}

const vec = (x, y, z) => new Vector3(x, y, z)
const meshWithRadius = (radius) => ({ userData: { custom: { radius } } })
const meshesOf = (object) => {
  const meshes = []
  object.traverse((node) => { if (node.isMesh) meshes.push(node) })
  return meshes
}
const axesOf = (meshes) => meshes.map((mesh) => mesh.userData.gizmoAxis).sort().join(',')
const mod2Pi = (angle) => ((angle % TWO_PI) + TWO_PI) % TWO_PI
const angularGap = (a, b) => {
  const gap = Math.abs(a - b)
  return Math.min(gap, TWO_PI - gap)
}

function checkGizmoBuilders(G) {
  const GIZMOS = [
    { mode: 'translate', build: G.buildTranslateGizmo, parts: [['shaft', 'CylinderGeometry'], ['cap', 'ConeGeometry']] },
    { mode: 'rotate', build: G.buildRotateGizmo, parts: [['ring', 'TorusGeometry']] },
    { mode: 'scale', build: G.buildScaleGizmo, parts: [['shaft', 'CylinderGeometry'], ['box', 'BoxGeometry']] },
  ]
  for (const { mode, build, parts } of GIZMOS) {
    const gizmo = build()
    const everyMesh = meshesOf(gizmo)
    const drawn = everyMesh.filter((mesh) => mesh.userData.isHitProxy !== true)
    const proxies = everyMesh.filter((mesh) => mesh.userData.isHitProxy === true)
    expect(`${mode}: group is tagged isGizmo with mode '${mode}'`, gizmo.isGroup === true && gizmo.userData.isGizmo === true && gizmo.userData.mode === mode, JSON.stringify(gizmo.userData))
    for (const [label, type] of parts) {
      const found = drawn.filter((mesh) => mesh.geometry.type === type)
      expect(`${mode}: one ${label} per axis, each carrying its gizmoAxis`, found.length === AXES.length && axesOf(found) === AXES.join(','), `${found.length} ${type} with axes [${axesOf(found)}]`)
    }
    expect(`${mode}: no drawn mesh outside the ${parts.map(([label]) => label).join(' and ')} set`, drawn.length === parts.length * AXES.length, `${drawn.length} drawn mesh(es)`)
    expect(`${mode}: drawn parts are visible`, drawn.every((mesh) => mesh.visible === true))
    expect(`${mode}: one hit proxy per axis, tagged isHitProxy with its gizmoAxis`, proxies.length === AXES.length && axesOf(proxies) === AXES.join(','), `${proxies.length} proxy(ies) with axes [${axesOf(proxies)}]`)
    expect(`${mode}: hit proxies are invisible on the mesh and on the material`, proxies.every((mesh) => mesh.visible === false && mesh.material.visible === false))
  }
}

function checkRadiusGizmo(G) {
  const N = G.RADIUS_HANDLE_COUNT
  for (const radius of [2.5, 6]) {
    const gizmo = G.buildRadiusGizmo(radius)
    const everyMesh = meshesOf(gizmo)
    const tagged = everyMesh.filter((mesh) => mesh.userData.gizmoAxis === 'radius')
    const rings = tagged.filter((mesh) => mesh.geometry.type === 'TorusGeometry')
    const knobs = tagged.filter((mesh) => mesh.geometry.type === 'SphereGeometry')
    const angles = knobs.map((knob) => mod2Pi(Math.atan2(knob.position.z, knob.position.x)))
    const evenlySpaced = Array.from({ length: N }, (_, i) => (i / N) * TWO_PI).every((target) => angles.some((angle) => angularGap(angle, target) < 1e-9))
    expect(`buildRadiusGizmo(${radius}): group is tagged isRadiusGizmo`, gizmo.isGroup === true && gizmo.userData.isRadiusGizmo === true)
    expect(`buildRadiusGizmo(${radius}): exactly one radius-tagged ring of radius ${radius}`, rings.length === 1 && rings[0].geometry.parameters.radius === radius, `${rings.length} ring(s)`)
    expect(`buildRadiusGizmo(${radius}): ${N} radius-tagged knobs and no other mesh`, knobs.length === N && tagged.length === everyMesh.length && everyMesh.length === N + 1, `${knobs.length} knob(s) of ${everyMesh.length} mesh(es)`)
    expect(`buildRadiusGizmo(${radius}): every knob sits on the XZ circle of radius ${radius}`, knobs.every((knob) => Math.abs(knob.position.y) < 1e-9 && Math.abs(Math.hypot(knob.position.x, knob.position.z) - radius) < 1e-9))
    expect(`buildRadiusGizmo(${radius}): knobs evenly spaced at 2*pi/${N}`, evenlySpaced && angles.length === N)
  }
}

function checkEntityRadius(G) {
  expect('_entityRadius returns a finite positive radius as given', G._entityRadius(meshWithRadius(7.5)) === 7.5)
  const UNUSABLE = [['NaN', NaN], ['+Infinity', Infinity], ['-Infinity', -Infinity], ['zero', 0], ['negative', -4]]
  for (const [label, value] of UNUSABLE) {
    const got = G._entityRadius(meshWithRadius(value))
    expect(`_entityRadius falls back to 3 for a ${label} radius`, got === 3, `got ${got}`)
  }
  expect('_entityRadius falls back to 3 for a mesh without a custom radius', G._entityRadius({ userData: {} }) === 3 && G._entityRadius(null) === 3)
}

function checkClosestPoint(G) {
  const cases = [
    { name: 'ray along +X at height 5 meets the Y axis at (0,5,0)', ray: new Ray(vec(3, 5, 0), vec(1, 0, 0)), origin: vec(0, 0, 0), axis: vec(0, 1, 0), want: vec(0, 5, 0) },
    { name: 'skew ray along +Z meets the Y axis at (0,2,0)', ray: new Ray(vec(1, 2, 3), vec(0, 0, 1)), origin: vec(0, 0, 0), axis: vec(0, 1, 0), want: vec(0, 2, 0) },
    { name: 'non-unit axis and ray direction still give (0,2,0)', ray: new Ray(vec(1, 2, 3), vec(0, 0, 5)), origin: vec(0, 0, 0), axis: vec(0, 2, 0), want: vec(0, 2, 0) },
    { name: 'Z axis through (10,0,0) against a ray along +X gives (10,0,7)', ray: new Ray(vec(0, 4, 7), vec(1, 0, 0)), origin: vec(10, 0, 0), axis: vec(0, 0, 1), want: vec(10, 0, 7) },
  ]
  for (const c of cases) {
    const got = G._closestPointOnAxisLine(c.ray, c.origin, c.axis)
    expect(`_closestPointOnAxisLine: ${c.name}`, got.distanceTo(c.want) < 1e-9, `got (${got.x}, ${got.y}, ${got.z})`)
  }
  const probe = cases[0]
  const before = [probe.ray.origin, probe.ray.direction, probe.origin, probe.axis].map((v) => v.clone())
  G._closestPointOnAxisLine(probe.ray, probe.origin, probe.axis)
  const after = [probe.ray.origin, probe.ray.direction, probe.origin, probe.axis]
  expect('_closestPointOnAxisLine leaves its ray, origin and axis unchanged', after.every((v, i) => v.equals(before[i])))

  let seed = 20261010
  const unit = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const randomVec = () => vec(unit() * 20 - 10, unit() * 20 - 10, unit() * 20 - 10)
  const SEEDED = 40
  const failing = []
  for (let i = 0; i < SEEDED; i++) {
    const origin = randomVec()
    const axis = randomVec()
    const ray = new Ray(randomVec(), randomVec())
    const point = G._closestPointOnAxisLine(ray, origin, axis)
    const along = point.clone().sub(origin)
    const offAxis = along.clone().sub(axis.clone().multiplyScalar(along.dot(axis) / axis.dot(axis)))
    const rayPoint = ray.origin.clone().addScaledVector(ray.direction, point.clone().sub(ray.origin).dot(ray.direction) / ray.direction.dot(ray.direction))
    const gap = rayPoint.clone().sub(point)
    const onAxis = offAxis.length() <= 1e-9 * (1 + along.length())
    const nearest = Math.abs(gap.dot(axis)) <= 1e-9 * (1 + axis.length() * gap.length())
    if (!onAxis || !nearest) failing.push(i)
  }
  expect(`_closestPointOnAxisLine: ${SEEDED} seeded configurations return the axis point nearest the ray`, failing.length === 0, `failing configuration(s) ${failing.join(',')}`)
}

async function main() {
  process.stdout.write(`module: ${MODULE_URL}\n`)
  process.stdout.write(`run: ${new Date().toISOString()}\n`)
  expect('no window, document or matchMedia global in this process', typeof globalThis.window === 'undefined' && typeof globalThis.document === 'undefined' && typeof globalThis.matchMedia === 'undefined')
  const G = await import(MODULE_URL)
  for (const name of ['buildTranslateGizmo', 'buildRotateGizmo', 'buildScaleGizmo', 'buildRadiusGizmo', '_entityRadius', '_closestPointOnAxisLine']) {
    expect(`exports ${name} as a function`, typeof G[name] === 'function', typeof G[name])
  }
  expect('exports RADIUS_HANDLE_COUNT as a positive integer', Number.isInteger(G.RADIUS_HANDLE_COUNT) && G.RADIUS_HANDLE_COUNT > 0, String(G.RADIUS_HANDLE_COUNT))
  checkGizmoBuilders(G)
  checkRadiusGizmo(G)
  checkEntityRadius(G)
  checkClosestPoint(G)
  process.stdout.write(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} -- ${passes} of ${passes + failures} check(s) passed\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  process.stdout.write(`[FAIL] witness aborted -- ${error && error.message}\n`)
  process.stdout.write('RESULT: FAIL -- witness aborted before every check ran\n')
  process.exitCode = 1
})
