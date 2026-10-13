#!/usr/bin/env node
// Shadow cost probe attachment pin (gpu-free).
//
// On the WebGPU path three's Renderer.shadowMap is { enabled, transmitted, type }: it has no
// needsUpdate and no render, so installShadowCostProbe's old guard -- return early unless
// typeof renderer.shadowMap.render === 'function' -- never installed there and returned undefined.
// Nothing set window.__shadowCost, so app.js's per-frame `if (!window.__shadowCost) return` and
// every read of it were silent: an unattached instrument and a measured zero were the same output,
// which is how a shadow cost came to be quoted with no probe behind it.
//
// This witness installs the real module against three renderer shapes -- three's node renderer,
// three's legacy renderer that owns a renderer-level shadow pass, and a renderer with neither -- and
// fails unless the first two attach and the third is refused WITH a reason. Each arm proves it
// counted by contrast: the main pass must add no sample and, on the legacy arm, a pass with
// needsUpdate false must add none either. It also pins that client/app.js no longer writes
// renderer.shadowMap.needsUpdate at all.
//
// It does NOT measure shadow cost: it proves the instrument is attached before any cost is read.
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
globalThis.window = globalThis.window || {}

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} (${detail})`)
}

// A fresh module instance per arm: the latch lives at module scope, so one process can otherwise
// only ever install once and the second arm would silently be the first one's answer.
const loadProbe = (n) => import('../client/core/ShadowCostProbe.js?arm=' + n)

const scene = { traverse() {} }
const camera = { isCamera: true, name: 'main' }
const makeLights = (count) => {
  const out = []
  for (let i = 0; i < count; i++) out.push({ name: 'cascade' + i, castShadow: true, shadow: { camera: { isCamera: true, name: 'shadow' + i }, needsUpdate: false, autoUpdate: false, mapSize: { width: 1024, height: 1024 } } })
  return out
}

// three's node renderer: no renderer-level shadow pass, and the per-light pass reaches it as
// render(scene, light.shadow.camera).
function makeNodeRenderer(lights, log) {
  return {
    shadowMap: { enabled: true, transmitted: false, type: 1 },
    render(s, c) { log.push(c); return undefined },
    info: { render: { calls: 0, triangles: 0, frame: 0 } },
  }
}

// three's legacy renderer: it owns WebGLShadowMap.render(lights, scene, camera).
function makeLegacyRenderer(log) {
  const shadowMap = { enabled: true, autoUpdate: false, needsUpdate: false, type: 1 }
  shadowMap.render = function (lights, s, c) { log.push({ lights, scene: s, camera: c }) }
  return { shadowMap, render() { return undefined }, info: { render: { calls: 0, triangles: 0, frame: 0 } } }
}

let perLightSamples = 0
let perLightCalls = 0
let legacySamples = 0
let legacyArmed = false
let perLightArmed = false

async function armPerLight() {
  const mod = await loadProbe('node')
  const lights = makeLights(3)
  const log = []
  const renderer = makeNodeRenderer(lights, log)
  const handle = mod.installShadowCostProbe(renderer, scene, camera, { lights })

  check('three\'s node renderer shadowMap attaches the probe', !!(handle && handle.attached === true), `attached=${handle && handle.attached} backend=${handle && handle.backend} reason=${handle && handle.reason}`)
  check('the node renderer arm is the per-light pass, not the renderer-level one', !!handle && handle.backend === 'per-light-shadow-pass', `backend=${handle && handle.backend}`)
  check('window.__shadowCost is the installed handle, so app.js stops returning early', !!handle && globalThis.window.__shadowCost === handle, `typeof=${typeof globalThis.window.__shadowCost}`)

  renderer.render(scene, camera)
  const afterMain = handle.stats().samples
  check('the main pass adds no sample, so the pass count is attribution and not a counter', afterMain === 0, `samples=${afterMain} after 1 main pass`)

  for (const l of lights) renderer.render(scene, l.shadow.camera)
  perLightSamples = handle.stats().samples
  perLightCalls = log.length
  check('one shadow camera render per cascade is counted as one pass each', perLightSamples === 3, `samples=${perLightSamples} of ${lights.length} cascade(s)`)
  check('the wrapped render still calls through to the renderer', perLightCalls === 4, `render call(s)=${perLightCalls}`)

  perLightArmed = handle.arm()
  check('arm() on the per-light arm refuses instead of pretending to arm the split', perLightArmed === false, `arm()=${perLightArmed} isArmed()=${handle.isArmed()}`)
  check('the per-light handle reports the split as unsupported', handle.splitSupported === false, `splitSupported=${handle.splitSupported}`)
  return { handle, backend: handle && handle.backend }
}

async function armLegacy() {
  const mod = await loadProbe('legacy')
  const lights = makeLights(3)
  const log = []
  const renderer = makeLegacyRenderer(log)
  const handle = mod.installShadowCostProbe(renderer, scene, camera, { lights })

  check('the legacy renderer-level shadow pass attaches the probe', !!(handle && handle.attached === true), `attached=${handle && handle.attached} backend=${handle && handle.backend}`)
  check('the legacy arm is the renderer-level pass', !!handle && handle.backend === 'renderer-shadow-pass', `backend=${handle && handle.backend}`)

  renderer.shadowMap.needsUpdate = false
  renderer.shadowMap.render(lights, scene, camera)
  const notAsked = handle.stats().samples
  check('a pass the renderer was not asked for adds no sample', notAsked === 0, `samples=${notAsked} with needsUpdate=false`)

  renderer.shadowMap.needsUpdate = true
  renderer.shadowMap.render(lights, scene, camera)
  legacySamples = handle.stats().samples
  check('a pass the renderer was asked for is counted', legacySamples === 1, `samples=${legacySamples} with needsUpdate=true`)

  legacyArmed = handle.arm()
  check('arm() on the legacy arm arms the split it owns', legacyArmed === true && handle.isArmed() === true, `arm()=${legacyArmed} isArmed()=${handle.isArmed()}`)
  return { handle, backend: handle && handle.backend }
}

async function armNeither() {
  const mod = await loadProbe('none')
  const handle = mod.installShadowCostProbe({ shadowMap: { enabled: true, type: 1 } }, scene, camera, null)
  check('a renderer with no shadow pass and no render() is refused, not silently installed', !!handle && handle.attached === false, `attached=${handle && handle.attached}`)
  check('the refusal carries a reason, so it cannot be quoted as a measured zero', !!handle && typeof handle.reason === 'string' && handle.reason.length > 0, `reason=${JSON.stringify(handle && handle.reason)}`)
  check('the refusal still exposes window.__shadowCost, so the reader sees attached:false', !!handle && globalThis.window.__shadowCost === handle && globalThis.window.__shadowCost.stats().attached === false, `attached=${handle && globalThis.window.__shadowCost && globalThis.window.__shadowCost.stats().attached}`)
  return handle
}

function pinAppWrites() {
  let app = ''
  let pipeline = ''
  try {
    app = readFileSync(resolve(ROOT, 'client', 'app.js'), 'utf8')
    pipeline = readFileSync(resolve(ROOT, 'client', 'core', 'ShadowPipeline.js'), 'utf8')
  } catch (e) {
    console.log('RESULT: FAIL client/app.js or client/core/ShadowPipeline.js unreadable: ' + e.message)
    process.exit(1)
  }
  const dead = app.split('renderer.shadowMap.needsUpdate').length - 1
  const routed = app.split('requestShadowRedraw(').length - 1
  check('client/app.js writes renderer.shadowMap.needsUpdate nowhere', dead === 0, `${dead} write(s)`)
  check('client/app.js routes every shadow redraw request through requestShadowRedraw', routed >= 3, `${routed} call site(s)`)
  check('client/core/ShadowPipeline.js exports requestShadowRedraw', /export function requestShadowRedraw/.test(pipeline), 'export present=' + /export function requestShadowRedraw/.test(pipeline))
  return { dead, routed }
}

const perLight = await armPerLight()
const legacy = await armLegacy()
await armNeither()
const app = pinAppWrites()

console.log(`[shadow-cost-probe-attach] install arm(s): ${perLight.backend} attached with ${perLightSamples} counted shadow pass(es) over ${perLightCalls} render call(s), ${legacy.backend} attached with ${legacySamples} counted pass(es) splitArm=${legacyArmed}, and a renderer with neither is refused; client/app.js carries ${app.dead} renderer.shadowMap.needsUpdate write(s) and ${app.routed} requestShadowRedraw call site(s)`)
console.log(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} label=shadow-cost-probe-attach -- ${failed} failure(s) over 3 install arm(s) and the client/app.js write pin`)
process.exit(failed === 0 ? 0 : 1)
