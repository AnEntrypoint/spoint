import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BASE_REV, materializeBase, treeUrl, installAllocHooks, sampledAllocationBytes } from './lib/alloc-witness-hooks.mjs'

const SELF = fileURLToPath(import.meta.url)
const EDITOR_RELS = ['client/editor/editor.js', 'client/editor/EditorGizmoBuild.js', 'client/editor/WaypointPath.js']
const COUNTED = ['Vector2', 'Vector3', 'Quaternion']
const W = 800, H = 600
const ENTITIES = [
  ['e1', [0, 0.5, 0], {}],
  ['e2', [3, 0.5, 1], {}],
  ['e3', [-2, 0.5, -1], { _trigger: true, radius: 3 }],
]
const PATH = [[6, 2], [12, 5], [18, 8], [25, 3], [31, -4], [40, -10]]
const FRAMES = 5
const WARM_FRAMES = 300
const SAMPLED_FRAMES = 50
const EDITOR_PATTERN = /client\/editor\/(editor|EditorGizmoBuild|WaypointPath)\.js$/
const WAYPOINT_NODES = [
  { id: 'e1', position: [0, 0.5, 0], custom: { _waypoint: true, order: 0 } },
  { id: 'e2', position: [3, 0.5, 1], custom: { _waypoint: true, order: 1 } },
  { id: 'e3', position: [-2, 0.5, -1], custom: { _waypoint: true, order: 2 } },
]
const SCENARIOS = [
  ...['translate', 'rotate', 'scale'].flatMap(mode => ['world', 'local'].flatMap(space => ['active', 'centroid'].map(pivot => ({ name: `${mode}/${space}/${pivot}/single`, mode, space, pivot, selected: ['e1'], handle: 'axis' })))),
  ...['translate', 'rotate', 'scale'].map(mode => ({ name: `${mode}/world/centroid/multi`, mode, space: 'world', pivot: 'centroid', selected: ['e1', 'e2', 'e3'], handle: 'axis' })),
  { name: 'translate/world/active/radius', mode: 'translate', space: 'world', pivot: 'active', selected: ['e3'], handle: 'radius' },
]

function childRun(which, part) {
  const out = spawnSync(process.execPath, [SELF, `--child=${part}`, `--editor=${which}`], { encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 })
  if (out.error) throw new Error(`[editor-drag-alloc] ${part} ${which} child: ${out.error.message}`)
  if (process.env.ALLOC_SITES === '1') process.stderr.write(out.stderr || '')
  const line = (out.stdout || '').split('\n').find(l => l.startsWith('WITNESS_JSON '))
  if (out.status !== 0 || !line) {
    throw new Error(`[editor-drag-alloc] ${part} ${which} child exited ${out.status}\n${out.stderr || out.stdout}`)
  }
  return JSON.parse(line.slice('WITNESS_JSON '.length))
}

async function runChild(part, which) {
  await installAllocHooks({ countAllocations: part === 'editor' })
  const urls = which === 'base' ? materializeBase(BASE_REV, EDITOR_RELS) : Object.fromEntries(EDITOR_RELS.map(r => [r, treeUrl(r)]))
  const canvases = { n: 0 }
  const ctx2d = { clearRect() {}, beginPath() {}, arc() {}, fill() {}, fillText() {}, fillStyle: '', font: '', textAlign: '', textBaseline: '' }
  const element = () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {}, setAttribute() {}, addEventListener() {}, removeEventListener() {}, getContext: () => ctx2d })
  globalThis.document = {
    addEventListener() {}, removeEventListener() {}, body: { appendChild() {} },
    createElement(tag) { if (tag === 'canvas') canvases.n++; return element() },
  }
  const THREE = await import('three')
  if (part === 'waypoint') return runWaypoint(THREE, urls, canvases)
  return runEditor(THREE, urls)
}

function allocTotal() {
  const c = globalThis.__allocCounts
  return COUNTED.reduce((s, n) => s + c.constructed[n] + c.cloned[n], 0)
}

function makeWorld(THREE) {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 1000)
  camera.position.set(0, 8, 14)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  const meshes = new Map()
  for (const [id, pos, custom] of ENTITIES) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    m.position.set(...pos)
    m.userData.custom = { ...custom }
    m.userData.isEditable = true
    meshes.set(id, m)
    scene.add(m)
  }
  const renderer = { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }), addEventListener() {}, removeEventListener() {}, style: {} } }
  return { scene, camera, meshes, renderer }
}

function handleScreen(THREE, world, scenario) {
  const v = new THREE.Vector3()
  if (scenario.handle === 'radius') {
    const group = world.scene.children.find(o => o.userData.isRadiusGizmo)
    const knob = group.children.find(c => c.userData.gizmoAxis === 'radius' && c.geometry.type === 'SphereGeometry')
    knob.getWorldPosition(v)
  } else {
    const group = world.scene.children.find(o => o.userData.isGizmo)
    group.updateMatrixWorld(true)
    const proxy = group.children.find(c => c.userData.isHitProxy && c.userData.gizmoAxis === 'x')
    proxy.updateMatrixWorld(true)
    if (scenario.mode === 'rotate') proxy.localToWorld(v.set(1, 0, 0))
    else proxy.localToWorld(v.set(0, 0.65, 0))
  }
  world.scene.updateMatrixWorld(true)
  const p = v.clone().project(world.camera)
  return { x: (p.x + 1) / 2 * W, y: (1 - p.y) / 2 * H }
}

function snapshot(meshes) {
  return [...meshes].map(([id, m]) => ({ id, p: m.position.toArray(), q: m.quaternion.toArray(), s: m.scale.toArray(), r: m.userData.custom.radius ?? null }))
}

function ringMatchesFresh(THREE, world) {
  const group = world.scene.children.find(o => o.userData.isRadiusGizmo)
  const radius = world.meshes.get('e3').userData.custom.radius
  const fresh = new THREE.TorusGeometry(radius, 0.03, 6, 48).attributes.position.array
  const live = group.children[0].geometry.attributes.position.array
  return live.length === fresh.length && live.every((x, i) => x === fresh[i])
}

async function runEditor(THREE, urls) {
  const { createEditor } = await import(urls['client/editor/editor.js'])
  const results = []
  for (const scenario of SCENARIOS) {
    const world = makeWorld(THREE)
    const machine = { isEditor: true, gizmoMode: scenario.mode, snapOn: false, snapSize: 1, isPlaytesting: false, send() {}, subscribe() { return { unsubscribe() {} } } }
    const ed = createEditor({ scene: world.scene, camera: world.camera, renderer: world.renderer, client: { send() {} }, entityMeshes: world.meshes, playerStates: new Map(), machine, onCommitEdit: null, onEmptyDrag() {}, raycastHitPoint: null, isLocked: () => false, floatingOrigin: null, onDestroyEntities() {} })
    ed.setGizmoSpace(scenario.space)
    ed.setPivotMode(scenario.pivot)
    for (const id of scenario.selected.slice(1)) ed.extraSelectedIds.add(id)
    ed.selectEntity(scenario.selected[0], null, { preserveExtras: true })
    const ptr = globalThis.__ptrDrag
    const base = { button: 0, shiftKey: false, altKey: false, ctrlKey: false, cancelable: false, preventDefault() {} }
    const start = handleScreen(THREE, world, scenario)
    ptr.onStart({ ...base, clientX: start.x, clientY: start.y })
    const moves = []
    for (const [dx, dy] of PATH) {
      const before = allocTotal()
      globalThis.__allocCounts.window = true
      ptr.onMove({ ...base, clientX: start.x + dx, clientY: start.y + dy })
      globalThis.__allocCounts.window = false
      const alloc = allocTotal() - before
      moves.push({ t: snapshot(world.meshes), alloc, ring: scenario.handle === 'radius' ? ringMatchesFresh(THREE, world) : null })
    }
    ptr.onEnd({ ...base, clientX: start.x + PATH.at(-1)[0], clientY: start.y + PATH.at(-1)[1] }, false)
    ed.updateWaypointPath(WAYPOINT_NODES)
    for (let w = 0; w < WARM_FRAMES; w++) ed.updateGizmo()
    const frames = []
    for (let f = 0; f < FRAMES; f++) {
      const before = allocTotal()
      ed.updateGizmo()
      frames.push(allocTotal() - before)
    }
    const frameBytes = await sampledAllocationBytes(() => { for (let f = 0; f < SAMPLED_FRAMES; f++) ed.updateGizmo() }, EDITOR_PATTERN)
    ed.destroy()
    results.push({ name: scenario.name, moves, frames, frameBytes })
  }
  return { part: 'editor', scenarios: results, sites: globalThis.__allocCounts.sites }
}

async function runWaypoint(THREE, urls, canvases) {
  const { createWaypointPathOverlay } = await import(urls['client/editor/WaypointPath.js'])
  const scene = new THREE.Scene()
  let adds = 0
  const add = scene.add.bind(scene)
  scene.add = (...o) => { adds++; return add(...o) }
  const overlay = createWaypointPathOverlay({ scene, entityMeshes: new Map() })
  const nodes = (x2) => [
    { id: 'w1', position: [0, 0, 0], custom: { _waypoint: true, order: 0 } },
    { id: 'w2', position: [x2, 0, 0], custom: { _waypoint: true, order: 1 } },
    { id: 'w3', position: [8, 0, 0], custom: { _waypoint: true, order: 2 } },
  ]
  const probe = (fn) => { const a0 = adds, c0 = canvases.n; fn(); return { adds: adds - a0, canvases: canvases.n - c0 } }
  const first = probe(() => overlay.update(nodes(4), 'w1'))
  const same = probe(() => overlay.update(nodes(4), 'w1'))
  const moved = probe(() => overlay.update(nodes(5), 'w1'))
  const sameAfterMove = probe(() => overlay.update(nodes(5), 'w1'))
  return { part: 'waypoint', first, same, moved, sameAfterMove }
}

function parentEditor(names) {
  const runs = {}
  for (const w of names) runs[w] = childRun(w, 'editor')
  return runs
}

function report(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`)
  return ok
}

async function main() {
  const arg = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt }
  const child = arg('child', null)
  const which = arg('editor', 'tree')
  if (child) {
    const payload = await runChild(child, which)
    console.log('WITNESS_JSON ' + JSON.stringify(payload))
    return
  }
  const names = which === 'base' ? ['base'] : ['tree', 'base']
  const editor = parentEditor(names)
  const waypoint = Object.fromEntries(names.map(w => [w, childRun(w, 'waypoint')]))
  const target = which === 'base' ? 'base' : 'tree'
  const checks = []
  if (which !== 'base') {
    const same = SCENARIOS.every((s, i) => JSON.stringify(editor.tree.scenarios[i].moves.map(m => m.t)) === JSON.stringify(editor.base.scenarios[i].moves.map(m => m.t)))
    checks.push(report('transforms equal the base editor on every move', same, `${SCENARIOS.length} scenarios, ${PATH.length} moves each`))
  }
  const rings = editor[target].scenarios.flatMap(s => s.moves.map(m => m.ring)).filter(r => r !== null)
  checks.push(report('radius ring geometry equals a freshly built torus after every move', rings.length > 0 && rings.every(Boolean), `${target}: ${rings.filter(Boolean).length} of ${rings.length} radius moves match`))
  if (process.env.ALLOC_SITES === '1') {
    for (const [site, n] of Object.entries(editor[target].sites).sort((a, b) => b[1] - a[1])) console.log(`site ${n} ${site}`)
  }
  const frameAllocs = editor[target].scenarios.map(s => s.frames.slice(1).reduce((n, a) => n + a, 0))
  const frameTotal = frameAllocs.reduce((a, b) => a + b, 0)
  checks.push(report('zero editor allocations per frame after the first frame (updateGizmo with waypoints)', frameTotal === 0, `${target}: ${frameTotal} constructions/clones over ${SCENARIOS.length} scenarios x ${FRAMES - 1} frames (per scenario ${frameAllocs.join(',')})`))
  const frameBytes = editor[target].scenarios.map(s => s.frameBytes)
  const frameByteTotal = frameBytes.reduce((a, b) => a + b, 0)
  checks.push(report('zero sampled bytes allocated by editor code per frame (updateGizmo with waypoints)', frameByteTotal === 0, `${target}: ${frameByteTotal} sampled bytes over ${SCENARIOS.length} scenarios x ${SAMPLED_FRAMES} frames (per scenario ${frameBytes.join(',')}), after ${WARM_FRAMES} warm-up frames`))
  const allocs = editor[target].scenarios.map(s => s.moves.slice(1).reduce((n, m) => n + m.alloc, 0))
  const total = allocs.reduce((a, b) => a + b, 0)
  checks.push(report('zero editor allocations per move after the first move', total === 0, `${target}: ${total} constructions/clones across ${SCENARIOS.length} scenarios (per scenario ${allocs.join(',')})`))
  const wp = waypoint[target]
  checks.push(report('waypoint: identical update after a rebuild does not rebuild', wp.sameAfterMove.adds === 0, `${target}: scene.add on identical update after a move = ${wp.sameAfterMove.adds}, first build = ${wp.first.adds}`))
  checks.push(report('waypoint: moved point rebuilds once', wp.moved.adds === 1, `${target}: scene.add on moved update = ${wp.moved.adds}`))
  checks.push(report('waypoint: rebuild creates no label canvas', wp.moved.canvases === 0, `${target}: canvases created on rebuild = ${wp.moved.canvases} (first build created ${wp.first.canvases})`))
  const ok = checks.every(Boolean)
  const label = target === 'base' ? 'base editor 48541f5 (negative control, expected to FAIL)' : 'tree editor'
  console.log(ok ? `RESULT: PASS ${label} drag and waypoint overlay: ${total} allocations per move after warm-up, identical transforms, one rebuild per change` : `RESULT: FAIL ${label} drag and waypoint overlay: ${total} allocations per move after warm-up, waypoint sameAfterMove=${wp.sameAfterMove.adds} moved=${wp.moved.adds} canvases=${wp.moved.canvases}`)
  process.exitCode = ok ? 0 : 1
}

main().catch(e => { console.error(e?.stack || e); console.log('RESULT: FAIL editor drag witness threw'); process.exitCode = 1 })
