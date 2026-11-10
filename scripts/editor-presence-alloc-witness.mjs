import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BASE_REV, materializeBase, treeUrl, installAllocHooks } from './lib/alloc-witness-hooks.mjs'

const SELF = fileURLToPath(import.meta.url)
const REL = 'client/editor/EditorPresence.js'
const COUNTED = ['Vector2', 'Vector3', 'Quaternion']
const W = 800, H = 600
const TICKS = 10

function childRun(which) {
  const out = spawnSync(process.execPath, [SELF, '--child', `--presence=${which}`], { encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 })
  if (out.error) throw new Error(`[editor-presence] ${which} child: ${out.error.message}`)
  const line = (out.stdout || '').split('\n').find(l => l.startsWith('WITNESS_JSON '))
  if (out.status !== 0 || !line) throw new Error(`[editor-presence] ${which} child exited ${out.status}\n${out.stderr || out.stdout}`)
  return JSON.parse(line.slice('WITNESS_JSON '.length))
}

function allocTotal() {
  const c = globalThis.__allocCounts
  return COUNTED.reduce((s, n) => s + c.constructed[n] + c.cloned[n], 0)
}

async function runChild(which) {
  await installAllocHooks({ countAllocations: true })
  const url = which === 'base' ? materializeBase(BASE_REV, [REL])[REL] : treeUrl(REL)
  const created = []
  let rectCalls = 0
  globalThis.document = {
    body: { appendChild() {} },
    createElement() {
      const el = { style: {}, textContent: '', appendChild() {}, remove() {} }
      created.push(el)
      return el
    },
  }
  const THREE = await import('three')
  const { createEditorPresence } = await import(url)
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 1000)
  camera.position.set(0, 8, 14)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  const entityMeshes = new Map()
  const positions = { e1: [0, 0.5, 0], e2: [3, 0.5, 1], e3: [-2, 0.5, -1] }
  for (const [id, pos] of Object.entries(positions)) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    m.position.set(...pos)
    m.updateMatrixWorld(true)
    entityMeshes.set(id, m)
  }
  const renderer = {
    domElement: {
      getBoundingClientRect() { rectCalls++; return { left: 0, top: 0, width: W, height: H } },
    },
  }
  const presence = createEditorPresence({ client: { send() {} }, MSG: { EDITOR_PRESENCE: 'EDITOR_PRESENCE' }, camera, renderer, entityMeshes })
  presence.onPresenceMessage({ clientId: 'peer-a', entityId: 'e1', dragging: true })
  presence.onPresenceMessage({ clientId: 'peer-b', entityId: 'e2', dragging: false })
  presence.onPresenceMessage({ clientId: 'peer-c', entityId: 'e3', dragging: false })
  presence.tick()
  const perTickAlloc = []
  const perTickRect = []
  for (let t = 0; t < TICKS; t++) {
    const a0 = allocTotal(), r0 = rectCalls
    presence.tick()
    perTickAlloc.push(allocTotal() - a0)
    perTickRect.push(rectCalls - r0)
  }
  const badges = created.map(el => ({ display: el.style.display ?? null, left: el.style.left ?? null, top: el.style.top ?? null, background: el.style.background ?? null, text: el.textContent }))
  presence.hide()
  return { perTickAlloc, perTickRect, badges }
}

async function main() {
  const arg = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt }
  if (process.argv.includes('--child')) {
    console.log('WITNESS_JSON ' + JSON.stringify(await runChild(arg('presence', 'tree'))))
    return
  }
  const which = arg('presence', 'tree')
  const runs = which === 'base' ? { base: childRun('base') } : { tree: childRun('tree'), base: childRun('base') }
  const target = runs[which === 'base' ? 'base' : 'tree']
  const allocs = target.perTickAlloc.reduce((a, b) => a + b, 0)
  const rects = target.perTickRect.reduce((a, b) => a + b, 0)
  const checks = []
  const report = (label, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); checks.push(ok) }
  if (which !== 'base') {
    const same = JSON.stringify(runs.tree.badges) === JSON.stringify(runs.base.badges)
    report('badge display, position, colour and label equal the base presence module', same, `${runs.tree.badges.length} badges compared`)
  }
  report('zero allocations per presence tick after warm-up', allocs === 0, `${which === 'base' ? 'base' : 'tree'}: ${allocs} constructions/clones over ${TICKS} ticks`)
  report('one viewport rect read per tick, not per remote peer', rects === TICKS, `${which === 'base' ? 'base' : 'tree'}: ${rects} getBoundingClientRect calls over ${TICKS} ticks (3 peers)`)
  const ok = checks.every(Boolean)
  console.log(ok
    ? `RESULT: PASS ${which === 'base' ? 'base' : 'tree'} editor presence: ${allocs} allocations and ${rects} rect reads over ${TICKS} ticks`
    : `RESULT: FAIL ${which === 'base' ? 'base' : 'tree'} editor presence: ${allocs} allocations and ${rects} rect reads over ${TICKS} ticks`)
  process.exitCode = ok ? 0 : 1
}

main().catch(e => { console.error(e?.stack || e); console.log('RESULT: FAIL editor presence witness threw'); process.exitCode = 1 })
