import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { materializeBase, treeUrl, sampledAllocationBytes } from './lib/alloc-witness-hooks.mjs'

const SELF = fileURLToPath(import.meta.url)
const REL = 'client/xr/XRSystem.js'
const PRE_REV = '20e9389'
const STATIC_FRAMES = 200
const MOVING_FRAMES = 50
const WARM_CALLS = 3000
const SAMPLED_CALLS = 50

function childRun(which) {
  const out = spawnSync(process.execPath, [SELF, '--child', `--xr=${which}`], { encoding: 'utf8', timeout: 240000, maxBuffer: 64 * 1024 * 1024 })
  if (out.error) throw new Error(`[xr-system] ${which} child: ${out.error.message}`)
  const line = (out.stdout || '').split('\n').find(l => l.startsWith('WITNESS_JSON '))
  if (out.status !== 0 || !line) throw new Error(`[xr-system] ${which} child exited ${out.status}\n${out.stderr || out.stdout}`)
  return JSON.parse(line.slice('WITNESS_JSON '.length))
}

async function runChild(which) {
  globalThis.XRRigidTransform = class { constructor(position, orientation) { this.position = position; this.orientation = orientation } }
  const stats = { offsetCalls: 0 }
  let current = null
  const base = {
    getOffsetReferenceSpace(transform) {
      stats.offsetCalls++
      return { offsetOf: [transform.position.x, transform.position.y, transform.position.z], base }
    },
  }
  const listeners = new Map()
  const controller = () => ({
    position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), add() {}, addEventListener() {},
    getWorldPosition() { return this.position }, getWorldDirection() { return { multiplyScalar() { return this } } },
  })
  const renderer = {
    domElement: { style: {} },
    xr: {
      isPresenting: true,
      addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn) },
      getReferenceSpace() { return base },
      setReferenceSpace(space) { current = space },
      getSession() { return null },
      getController: controller,
      getHand() { return null },
      setFoveation() {},
      getFrame() { return null },
    },
  }
  const url = which === 'base' ? materializeBase(PRE_REV, [REL])[REL] : treeUrl(REL)
  const { createXRSystem } = await import(url)
  const sys = createXRSystem(renderer, new THREE.Scene(), new THREE.PerspectiveCamera())
  const local = { position: [0, 0, 0], crouch: 0 }
  sys.setupSessionListeners(() => local, () => 1, { yaw: 0 })
  for (const fn of listeners.get('sessionstart') ?? []) fn()
  await new Promise(r => setTimeout(r, 150))
  const beforeStatic = stats.offsetCalls
  for (let f = 0; f < STATIC_FRAMES; f++) sys.syncVRPosition(local)
  const staticCalls = stats.offsetCalls - beforeStatic
  const digest = createHash('sha256')
  const beforeMoving = stats.offsetCalls
  for (let f = 0; f < MOVING_FRAMES; f++) {
    local.position[0] = f * 0.1
    sys.syncVRPosition(local)
    digest.update(JSON.stringify(current?.offsetOf ?? null) + '\n')
  }
  const movingCalls = stats.offsetCalls - beforeMoving
  const input = {}
  const handler = {}
  for (let w = 0; w < WARM_CALLS; w++) sys.handleSettingsInput(input, handler)
  const settingsBytes = await sampledAllocationBytes(() => { for (let c = 0; c < SAMPLED_CALLS; c++) sys.handleSettingsInput(input, handler) }, /client\/xr\/XRSystem\.js$/)
  return { staticCalls, movingCalls, digest: digest.digest('hex'), settingsBytes }
}

async function main() {
  const arg = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt }
  if (process.argv.includes('--child')) {
    console.log('WITNESS_JSON ' + JSON.stringify(await runChild(arg('xr', 'tree'))))
    return
  }
  const which = arg('xr', 'tree')
  const runs = which === 'base' ? { base: childRun('base') } : { tree: childRun('tree'), base: childRun('base') }
  const target = runs[which === 'base' ? 'base' : 'tree']
  const rows = []
  const add = (label, ok, detail) => { rows.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`) }
  const name = which === 'base' ? 'base' : 'tree'
  add('an unchanged XR origin is not re-applied on a frame (no offset reference space made)', target.staticCalls === 0, `${name}: ${target.staticCalls} offset reference spaces over ${STATIC_FRAMES} static frames`)
  if (which !== 'base') add('a moving origin is applied on every moving frame, with the same origin as before', runs.tree.movingCalls === runs.base.movingCalls && runs.tree.digest === runs.base.digest, `tree ${runs.tree.movingCalls} applied, base ${runs.base.movingCalls} applied, digests ${runs.tree.digest === runs.base.digest ? 'equal' : 'differ'}`)
  add('zero sampled bytes in the settings input per call while the panel is hidden, after warm-up', target.settingsBytes === 0, `${name}: ${target.settingsBytes} sampled bytes over ${SAMPLED_CALLS} calls after ${WARM_CALLS} warm-up calls`)
  const ok = rows.every(Boolean)
  console.log(ok
    ? `RESULT: PASS ${name} XR system per-frame work: ${target.staticCalls} origin re-applies over ${STATIC_FRAMES} static frames, ${target.settingsBytes} settings bytes`
    : `RESULT: FAIL ${name} XR system per-frame work: ${target.staticCalls} origin re-applies over ${STATIC_FRAMES} static frames, ${target.settingsBytes} settings bytes`)
  process.exitCode = ok ? 0 : 1
}

main().catch(e => { console.error(e?.stack || e); console.log('RESULT: FAIL XR system witness threw'); process.exitCode = 1 })
