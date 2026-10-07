#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from './lib/cdp-browser.mjs'
import { assertGpu, gpuArgs } from './lib/gpu-probe.mjs'
import { vendorPinArgs } from './lib/witness-gpu.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, 'data', 'perf-run')

const argv = process.argv.slice(2)
const ARGS = new Map()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const eq = a.indexOf('=')
  if (eq > 0) ARGS.set(a.slice(2, eq), a.slice(eq + 1))
  else ARGS.set(a.slice(2), (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : true)
}
const flag = (n, d) => (ARGS.has(n) ? String(ARGS.get(n)) : String(d))
const has = (n) => ARGS.has(n)

const LABEL = flag('label', 'veg-lod-browser-' + Date.now())
const GPU = flag('gpu', 'nvidia')
const STILL_SECONDS = Number(flag('still', '4'))
const MOVE_SECONDS = Number(flag('move', '8'))
const READY_TIMEOUT_MS = Number(flag('ready-timeout', '300000'))
const VEG_WALK_MS = Number(flag('veg-walk', '240000'))
const EXTRA = flag('extra', 'at=200,0')
const [VIEW_W, VIEW_H] = String(flag('viewport', '1280x720')).split('x').map(Number)
const SCALING = !has('no-scaling')
const SCALING_COUNTS = String(flag('scaling-counts', '10000,50000')).split(',').map(Number)

const LAUNCH_VENDOR_ARGS = vendorPinArgs(GPU)

const READY = () => {
  const a = window.__app || {}
  const veg = a.vegetation || window.__veg
  return {
    hasScene: !!window.__scene,
    hasCamera: !!window.__camera,
    hasVeg: !!veg,
    vegInstances: (veg && veg.totalInstances) || 0,
    vegLoads: (veg && veg.profile && veg.profile.loads) || 0,
    vegMeshes: (veg && veg._meshes && veg._meshes.length) || 0,
    hasTerrain: !!window.__terrain,
    revealedAt: a.revealedAt || null,
    glHooks: window.__gmGlDrawCalls !== undefined,
  }
}

const COLLECT = () => {
  const found = new Set()
  window.__scene.traverse((o) => {
    const inst = o && o.userData && o.userData.lodInstancer
    if (inst) found.add(inst)
  })
  const list = [...found]
  window.__vegLodInstancers = list
  const perInstancer = list.map((i) => i.count)
  const grids = list.map((i) => i.sweepGrid)
  return {
    instancers: list.length,
    instances: perInstancer.reduce((s, n) => s + n, 0),
    minPerInstancer: perInstancer.length ? Math.min(...perInstancer) : 0,
    maxPerInstancer: perInstancer.length ? Math.max(...perInstancer) : 0,
    gridUsable: grids.filter((g) => g && g.usable).length,
    gridCells: grids.length ? Math.max(...grids.map((g) => (g && g.cells) || 0)) : 0,
    gridInstances: grids.length ? Math.max(...grids.map((g) => (g && g.instances) || 0)) : 0,
    glHooks: window.__gmGlDrawCalls !== undefined,
  }
}

const SAMPLE = (seconds) => new Promise((res) => {
  const insts = window.__vegLodInstancers || []
  const before = insts.map((i) => ({ ...i.sweepStats }))
  const cam = window.__camera
  const p0 = cam ? [cam.position.x, cam.position.y, cam.position.z] : null
  let frames = 0
  const t0 = performance.now()
  const tick = () => {
    frames++
    const dt = performance.now() - t0
    if (dt < seconds * 1000) { requestAnimationFrame(tick); return }
    const after = insts.map((i) => ({ ...i.sweepStats }))
    const p1 = cam ? [cam.position.x, cam.position.y, cam.position.z] : null
    let tests = 0, walked = 0, calls = 0, survivors = 0
    for (let k = 0; k < insts.length; k++) {
      tests += after[k].planeTests - before[k].planeTests
      walked += after[k].recordsWalked - before[k].recordsWalked
      calls += after[k].updateCalls - before[k].updateCalls
      const tiers = insts[k].tierIds
      for (let q = 0; q < tiers.length; q++) survivors += tiers[q].length
    }
    const moved = p0 && p1 ? Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) : null
    res({
      frames,
      seconds: +(dt / 1000).toFixed(2),
      updateCallsPerFrame: +(calls / frames).toFixed(2),
      planeTestsPerFrame: +(tests / frames).toFixed(1),
      recordsPerFrame: +(walked / frames).toFixed(1),
      survivors,
      cameraMovedM: moved === null ? null : +moved.toFixed(2),
    })
  }
  requestAnimationFrame(tick)
})

const KEY = ({ code, down }) => {
  const fire = (target) => target.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code.replace('Key', '').toLowerCase(), bubbles: true, cancelable: true }))
  fire(window)
  fire(document)
  return true
}

const EDIT = () => new Promise((res) => {
  const insts = window.__vegLodInstancers || []
  const cam = window.__camera
  if (!insts.length) return res({ error: 'no instancers collected' })
  if (!cam) return res({ error: 'no camera in the page' })
  const inst = insts[0]
  const countBefore = inst.count
  const gridInstancesBefore = inst.sweepGrid.instances
  const survivorsBefore = inst.tierIds.reduce((s, t) => s + t.length, 0)
  const n = Math.max(1, Math.floor(countBefore * 0.1))
  for (let i = 0; i < n; i++) inst.removeInstances(i)
  inst.addInstances(n, (p) => p.position.set(4000 + (p.id % 20) * 3, 0, 4000 + Math.floor(p.id / 20) * 3))
  const a = cam.projectionMatrix.elements, b = cam.matrixWorldInverse.elements
  const me = new Float64Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
    me[c * 4 + r] = s
  }
  const plane = (x, y, z, w) => {
    const len = Math.hypot(x, y, z) || 1
    return { normal: { x: x / len, y: y / len, z: z / len }, constant: w / len }
  }
  const frustum = {
    planes: [
      plane(me[3] - me[0], me[7] - me[4], me[11] - me[8], me[15] - me[12]),
      plane(me[3] + me[0], me[7] + me[4], me[11] + me[8], me[15] + me[12]),
      plane(me[3] + me[1], me[7] + me[5], me[11] + me[9], me[15] + me[13]),
      plane(me[3] - me[1], me[7] - me[5], me[11] - me[9], me[15] - me[13]),
      plane(me[3] - me[2], me[7] - me[6], me[11] - me[10], me[15] - me[14]),
      plane(me[3] + me[2], me[7] + me[6], me[11] + me[10], me[15] + me[14]),
    ],
  }
  const before = { ...inst.sweepStats }
  inst.updateLOD(cam.position, frustum, true)
  const after = { ...inst.sweepStats }
  res({
    instancer: 0,
    countBefore,
    countAfter: inst.count,
    edited: n,
    rebuildFrameRecords: after.recordsWalked - before.recordsWalked,
    rebuildFramePlaneTests: after.planeTests - before.planeTests,
    gridInstancesBefore,
    gridInstancesAfter: inst.sweepGrid.instances,
    gridUsableAfter: !!inst.sweepGrid.usable,
    survivorsBefore,
    survivorsAfter: inst.tierIds.reduce((s, t) => s + t.length, 0),
  })
})

const SCALING_RUN = (counts) => new Promise(async (res) => {
  let THREE = window.__app && window.__app.THREE
  if (!THREE) THREE = await import('three')
  if (!THREE) THREE = await import('https://esm.sh/three@r128')
  const mod = await import('/client/core/WebGPULodInstancer.js')
  const base = new THREE.BoxGeometry(6, 12, 6)
  base.translate(0, 6, 0)
  base.computeBoundingSphere()
  const shared = base.boundingSphere.clone()
  const distances = [0, 14, 35]
  const levels = distances.map((d, i) => {
    const g = new THREE.BoxGeometry(6 - i * 1.5, 12 - i * 3, 6 - i * 1.5)
    g.translate(0, 6, 0)
    g.boundingSphere = shared.clone()
    return { geometry: g, material: new THREE.MeshStandardMaterial(), distance: d }
  })
  const shadowGeo = new THREE.BoxGeometry(1.5, 3, 1.5)
  shadowGeo.translate(0, 6, 0)
  shadowGeo.boundingSphere = shared.clone()
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000)
  const frustum = new THREE.Frustum()
  const projScreen = new THREE.Matrix4()
  const out = []
  for (const n of counts) {
    const scene = new THREE.Scene()
    const inst = mod.createWebGPULodInstancer(scene, levels, n, { windPhase: 'float', tint: 'vec3' }, {
      hysteresis: 0.12, shadowGeometry: shadowGeo, shadowMaterial: levels[0].material, shadowDistance: 35,
    })
    inst.setMeshFarDistance(90)
    const side = Math.max(1, Math.ceil(Math.sqrt(n)))
    const half = (side - 1) * 3 * 0.5
    inst.addInstances(n, (p) => p.position.set((p.id % side) * 3 - half, 0, Math.floor(p.id / side) * 3 - half))
    const before = { ...inst.sweepStats }
    let frames = 0
    const t0 = performance.now()
    for (let f = 0; f < 240; f++) {
      const travelled = 7 * (1 / 60) * f
      cam.position.set(-0.35 * (half * 2) + Math.cos(Math.PI / 4) * travelled, 1.7, -0.35 * (half * 2) + Math.sin(Math.PI / 4) * travelled)
      cam.rotation.set(0, Math.PI / 4 + 0.35 * Math.sin(f * 0.05), 0)
      cam.updateMatrixWorld(true)
      cam.updateProjectionMatrix()
      projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
      frustum.setFromProjectionMatrix(projScreen)
      inst.updateLOD(cam.position, frustum, true)
      frames++
    }
    const after = { ...inst.sweepStats }
    const ms = performance.now() - t0
    let survivors = 0
    for (const t of inst.tierIds) survivors += t.length
    out.push({
      instances: n,
      frames,
      msPerFrame: +(ms / frames).toFixed(3),
      planeTestsPerFrame: +((after.planeTests - before.planeTests) / frames).toFixed(1),
      recordsPerFrame: +((after.recordsWalked - before.recordsWalked) / frames).toFixed(1),
      survivors,
      grid: inst.sweepGrid,
    })
    inst.dispose()
  }
  res(out)
})

async function waitReady(page) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let last = null
  let nextLog = 0
  while (Date.now() < deadline) {
    last = await page.evaluate(READY).catch((e) => ({ evalError: String(e && e.message || e) }))
    if (last && last.hasScene && last.hasCamera && last.hasTerrain && last.revealedAt) return last
    if (Date.now() >= nextLog) { nextLog = Date.now() + 30000; console.log('[veg-lod-browser] waiting: ' + JSON.stringify(last)) }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('page never became ready: ' + JSON.stringify(last))
}

async function walkUntilVegetation(page, budgetMs) {
  const deadline = Date.now() + budgetMs
  let last = null
  let nextLog = 0
  await page.evaluate(KEY, { code: 'KeyW', down: true })
  while (Date.now() < deadline) {
    last = await page.evaluate(READY).catch((e) => ({ evalError: String(e && e.message || e) }))
    if (last && last.vegInstances > 0) break
    if (Date.now() >= nextLog) { nextLog = Date.now() + 15000; console.log('[veg-lod-browser] walking for vegetation: ' + JSON.stringify(last)) }
    await new Promise((r) => setTimeout(r, 2000))
  }
  await page.evaluate(KEY, { code: 'KeyW', down: false })
  return last
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const port = String(20000 + Math.floor(Math.random() * 20000))
  process.env.PORT = port
  process.env.WORLD = 'tps-game'
  process.env.SPOINT_NO_WATCH = '1'
  if (!has('prewarm')) process.env.SPOINT_SKIP_PREWARM = '1'
  const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
  const server = await boot()
  console.log('[veg-lod-browser] server up on ' + port)

  const args = [...gpuArgs({ accelerated: true }), ...LAUNCH_VENDOR_ARGS]
  const browser = await chromium.launch({ headless: true, args })
  const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H } })
  const failures = []
  try {
    const url = `http://localhost:${port}/?singleplayer&webgpu=1&world=tps-game&${EXTRA}&v=${Date.now()}`
    console.log('[veg-lod-browser] navigating ' + url)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })
    const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: GPU })
    console.log('[veg-lod-browser] gpu: ' + JSON.stringify({ rasterizer: gpu.rasterizer, renderer: gpu.renderer, adapter: gpu.adapter }))
    const ready = await waitReady(page)
    console.log('[veg-lod-browser] ready: ' + JSON.stringify(ready))
    if (ready.glHooks) failures.push('gm GL draw-hook wrappers are installed in the page (__gmGlDrawCalls present): draw-call counts and timings are inflated')

    const walked = await walkUntilVegetation(page, VEG_WALK_MS)
    console.log('[veg-lod-browser] after walk: ' + JSON.stringify(walked))
    if (!(walked && walked.vegInstances > 0)) failures.push(`world vegetation never populated (vegInstances=${walked && walked.vegInstances}): the page is not a loaded vegetation scene`)

    const shape = await page.evaluate(COLLECT)
    console.log('[veg-lod-browser] instancers: ' + JSON.stringify(shape))
    if (shape.instancers === 0) failures.push('no LOD instancers found in the live scene graph')
    if (shape.instances === 0) failures.push('LOD instancers carry zero instances')

    const still = await page.evaluate(SAMPLE, STILL_SECONDS)
    console.log('[veg-lod-browser] still: ' + JSON.stringify(still))

    await page.evaluate(KEY, { code: 'KeyW', down: true })
    const moving = await page.evaluate(SAMPLE, MOVE_SECONDS)
    await page.evaluate(KEY, { code: 'KeyW', down: false })
    console.log('[veg-lod-browser] moving: ' + JSON.stringify(moving))
    if (!(moving.cameraMovedM > 1)) failures.push(`camera did not move during the moving phase (cameraMovedM=${moving.cameraMovedM}): the sweep guard may still be firing`)
    if (!(moving.planeTestsPerFrame > 0)) failures.push('moving phase recorded zero plane tests: updateLOD did not sweep')
    if (!(moving.recordsPerFrame > 0)) failures.push('moving phase recorded zero records walked: updateLOD did not sweep')
    if (!(moving.recordsPerFrame <= shape.instances)) failures.push(`records walked per frame ${moving.recordsPerFrame} exceeds total instances ${shape.instances}`)

    let scaling = null
    let scalingCost = null
    if (SCALING) {
      scaling = await page.evaluate(SCALING_RUN, SCALING_COUNTS).catch((e) => ({ error: String(e && e.message || e) }))
      console.log('[veg-lod-browser] scaling: ' + JSON.stringify(scaling))
      if (Array.isArray(scaling)) {
        const [a, b] = scaling
        if (a && b) {
          const countRatio = b.instances / a.instances
          const survivorRatio = b.survivors / a.survivors
          const recordsRatio = b.recordsPerFrame / a.recordsPerFrame
          console.log(`[veg-lod-browser] ratios: counts ${countRatio.toFixed(2)} survivors ${survivorRatio.toFixed(2)} records ${recordsRatio.toFixed(2)}`)
          if (recordsRatio > countRatio) failures.push(`records walked grew faster than instance count (${recordsRatio.toFixed(2)} vs ${countRatio.toFixed(2)}): cost is not decoupled from total instances`)
          const costRatio = b.msPerFrame / a.msPerFrame
          const costGapToSurvivor = Math.abs(Math.log(costRatio / survivorRatio))
          const costGapToCount = Math.abs(Math.log(costRatio / countRatio))
          console.log(`[veg-lod-browser] cost ratios: counts ${countRatio.toFixed(2)} survivors ${survivorRatio.toFixed(2)} ms/frame ${costRatio.toFixed(2)} (gap to survivors ${costGapToSurvivor.toFixed(3)}, gap to count ${costGapToCount.toFixed(3)})`)
          scalingCost = { countRatio, survivorRatio, costRatio: +costRatio.toFixed(2), costGapToSurvivor: +costGapToSurvivor.toFixed(3), costGapToCount: +costGapToCount.toFixed(3) }
          if (costGapToSurvivor >= costGapToCount) failures.push(`updateLOD ms/frame ratio ${costRatio.toFixed(2)} is no closer to the survivor ratio ${survivorRatio.toFixed(2)} than to the count ratio ${countRatio.toFixed(2)}: cost still tracks total instances`)
        }
      } else failures.push('in-page scaling phase failed: ' + JSON.stringify(scaling))
    }

    const edit = await page.evaluate(EDIT).catch((e) => ({ error: String(e && e.message || e) }))
    console.log('[veg-lod-browser] placement-edit: ' + JSON.stringify(edit))
    if (edit.error) failures.push('placement-edit phase failed: ' + edit.error)
    else {
      if (!(edit.rebuildFrameRecords > 0)) failures.push(`the single frame after a placement edit walked ${edit.rebuildFrameRecords} records: the sweep did not run`)
      if (edit.gridInstancesAfter !== edit.countAfter) failures.push(`one frame after an edit that left ${edit.countAfter} instances the index still describes ${edit.gridInstancesAfter}: not rebuilt within one frame`)
    }

    const payload = { label: LABEL, url, gpu: { rasterizer: gpu.rasterizer, renderer: gpu.renderer, adapter: gpu.adapter }, ready, shape, still, moving, scaling, scalingCost, edit, failures }
    const outPath = resolve(OUT_DIR, LABEL + '.json')
    writeFileSync(outPath, JSON.stringify(payload, null, 2))
    console.log('json: ' + outPath)
  } finally {
    for (const step of [() => page.close(), () => browser.close(), () => server.stop()]) {
      try { await Promise.resolve(step()).catch(() => {}) } catch (_) {}
    }
  }
  if (failures.length) for (const f of failures) console.log('FAIL: ' + f)
  console.log('RESULT: ' + (failures.length ? 'FAIL' : 'PASS'))
  process.exit(failures.length ? 1 : 0)
}

main().catch((e) => { console.log('FAIL: ' + (e && e.message || e)); console.log((e && e.stack) || ''); console.log('RESULT: FAIL'); process.exit(1) })
