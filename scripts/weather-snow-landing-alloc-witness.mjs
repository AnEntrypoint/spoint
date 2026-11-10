import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { installAllocHooks, materializeBase, treeUrl, sampledAllocationBytes } from './lib/alloc-witness-hooks.mjs'

const SELF = fileURLToPath(import.meta.url)
const ROOT = resolve(SELF, '..', '..')
const REL = 'client/core/Weather.js'
const PRE_REV = '20e9389'
const WORLD = resolve(ROOT, 'apps/world/tps-game.js')
const PATTERN = /client\/core\/Weather\.js$/
const FUNCTIONS = new Set(['_updateGpuFields', '_randomDiscPoint', '_groundInsideFallWindow'])
const DT = 0.016
const RNG_SEED = 7
const WARM_UPDATES = 300
const DIGEST_UPDATES = 120
const SAMPLED_UPDATES = 50
const SAMPLED_WINDOWS = 3

function childRun(which) {
  const out = spawnSync(process.execPath, ['--no-turbo-inlining', SELF, '--child', `--weather=${which}`], { encoding: 'utf8', timeout: 480000, maxBuffer: 64 * 1024 * 1024 })
  if (out.error) throw new Error(`[weather-snow] ${which} child: ${out.error.message}`)
  const line = (out.stdout || '').split('\n').find(l => l.startsWith('WITNESS_JSON '))
  if (out.status !== 0 || !line) throw new Error(`[weather-snow] ${which} child exited ${out.status}\n${out.stderr || out.stdout}`)
  return JSON.parse(line.slice('WITNESS_JSON '.length))
}

function stubRenderer() {
  const gl = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 1 : () => 1)), set: (t, k, v) => { t[k] = v; return true } })
  return { isWebGPURenderer: false, render() {}, domElement: {}, getContext: () => gl, getParameter: () => 1, capabilities: { isWebGL2: true, maxTextures: 16, maxAnisotropy: 4 }, extensions: { get: () => ({}), has: () => true }, info: { memory: {}, render: {} } }
}

async function worldFrame() {
  const { loadWorldModule } = await import(resolve(ROOT, 'src/sdk/WorldLocator.js'))
  const { createPlanetFrame } = await import(resolve(ROOT, 'src/terrain/PlanetFrame.js'))
  const { terrainCarvesOf, terrainHashVersionOf } = await import(resolve(ROOT, 'src/shared/terrainConfig.js'))
  const { createHeightSampler } = await import('mapspinner/height-cpu')
  const world = await loadWorldModule(WORLD)
  const tcfg = world.terrain
  const sampler = createHeightSampler({ radius: tcfg.radius, seed: tcfg.seed, reliefScale: tcfg.reliefScale, hashVersion: terrainHashVersionOf(tcfg), carves: terrainCarvesOf(tcfg) })
  return createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
}

async function runChild(which) {
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : (k === 'measureText' ? () => ({ width: 0 }) : () => {})), set: (t, k, v) => { t[k] = v; return true } }), style: {} }), body: { appendChild() {} } }
  process.env.SPOINT_NO_WATCH = '1'
  process.env.SPOINT_SKIP_PREWARM = '1'
  let seed = RNG_SEED
  Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  await installAllocHooks()
  const THREE = await import('three')
  const url = which === 'base' ? materializeBase(PRE_REV, [REL])[REL] : treeUrl(REL)
  const { createWeather } = await import(url)
  const frame = await worldFrame()
  seed = RNG_SEED
  const weather = createWeather({ renderer: stubRenderer(), scene: new THREE.Scene(), frame, cfg: { type: 'snow', intensity: 1 } })
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500)
  camera.position.set(0, frame.groundHeightLocal(0, 0) + 2, 0)
  camera.updateMatrixWorld(true)
  let landings = []
  const accum = weather._snowAccum
  const original = accum.markScorched.bind(accum)
  accum.markScorched = (x, z, r, s) => { landings.push(`${x},${z},${r},${s}`); return original(x, z, r, s) }
  for (let w = 0; w < WARM_UPDATES; w++) { weather.update(DT, camera, undefined); landings = [] }
  const digest = createHash('sha256')
  let totalLandings = 0, updatesWithLandings = 0
  for (let d = 0; d < DIGEST_UPDATES; d++) {
    landings = []
    weather.update(DT, camera, undefined)
    totalLandings += landings.length
    if (landings.length) updatesWithLandings++
    digest.update(landings.join(';') + '\n')
  }
  const windows = []
  for (let w = 0; w < SAMPLED_WINDOWS; w++) {
    windows.push(await sampledAllocationBytes(() => { for (let s = 0; s < SAMPLED_UPDATES; s++) { landings.length = 0; weather.update(DT, camera, undefined) } }, PATTERN, { own: true, functions: FUNCTIONS }))
  }
  return { digest: digest.digest('hex'), totalLandings, updatesWithLandings, windows, bytes: Math.min(...windows) }
}

function checksFor(runs) {
  const rows = []
  const tree = runs.tree, base = runs.base
  if (tree) {
    rows.push(['the snow landings equal the pre-change landings in position, radius and strength, every update', tree.digest === base.digest, `${DIGEST_UPDATES} updates, ${tree.totalLandings} landings, digests ${tree.digest === base.digest ? 'equal' : 'differ'}`])
    rows.push(['the landing path runs (not vacuous)', tree.updatesWithLandings > 0, `${tree.updatesWithLandings} of ${DIGEST_UPDATES} updates landed snow`])
  }
  if (tree) {
    rows.push(['the landing change allocates less than the pre-change landing loop (lowest of three windows)', tree.bytes < base.bytes, `tree windows ${tree.windows.join(', ')} vs base windows ${base.windows.join(', ')} sampled bytes over ${SAMPLED_UPDATES} updates; the tree's remaining ${tree.bytes} B is boxing of doubles that cross non-inlined calls (markScorched in GrassDecal, _exactGround, _groundInsideFallWindow) and uniform value writes, present before this change; info only`])
  } else {
    rows.push(['the pre-change snow landing loop is the negative control and must be above the tree', false, `base: windows ${base.windows.join(', ')} sampled bytes over ${SAMPLED_UPDATES} updates after ${WARM_UPDATES} warm-up updates; run without the tree, so nothing is compared`])
  }
  return rows
}

async function main() {
  const arg = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt }
  if (process.argv.includes('--child')) {
    console.log('WITNESS_JSON ' + JSON.stringify(await runChild(arg('weather', 'tree'))))
    process.exit(0)
  }
  const which = arg('weather', 'tree')
  const runs = which === 'base' ? { base: childRun('base') } : { tree: childRun('tree'), base: childRun('base') }
  const rows = []
  for (const [label, ok, detail] of checksFor(runs)) {
    rows.push(ok)
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`)
  }
  const target = runs[which === 'base' ? 'base' : 'tree']
  const name = which === 'base' ? 'base' : 'tree'
  const ok = rows.every(Boolean)
  console.log(ok
    ? `RESULT: PASS ${name} snow landings: ${target.bytes} sampled bytes per ${SAMPLED_UPDATES} updates, ${target.totalLandings} landings over ${DIGEST_UPDATES} updates equal the pre-change landings`
    : `RESULT: FAIL ${name} snow landings: ${target.bytes} sampled bytes per ${SAMPLED_UPDATES} updates`)
  process.exitCode = ok ? 0 : 1
}

main().catch(e => { console.error(e?.stack || e); console.log('RESULT: FAIL weather snow witness threw'); process.exitCode = 1 })
