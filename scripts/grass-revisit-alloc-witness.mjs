import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { installAllocHooks, materializeBase, treeUrl, sampledAllocationBytes } from './lib/alloc-witness-hooks.mjs'

const SELF = fileURLToPath(import.meta.url)
const ROOT = resolve(SELF, '..', '..')
const REL = 'client/core/Grass.js'
const PRE_REV = '20e9389'
const WORLD = resolve(ROOT, 'apps/world/tps-game.js')
const RENDER_DISTANCE_M = 40
const DT = 0.016
const STEP_M = 1
const AMP_M = 10
const WARM_MAX = 800
const STILL_UPDATES = 60
const WARM_MOVES = 600
const DIGEST_MOVES = 120
const SAMPLED_MOVES = 50
const SAMPLED_WINDOWS = 3
const PATTERN = /client\/core\/Grass\.js$/
const REVISIT_FUNCTIONS = new Set(['revisitNearLod', 'applyRevisitGroup', 'scanLoadedCell', 'scanChunk', 'flipPush', 'clearFlips', 'idxPush', 'addBlades', 'removeBlades', 'moveClumpsToLod', 'placeAddedBlade', 'placeMovedBlade', 'writeBlade', 'scanCellAtPose', 'clumpLodNearAt'])

function childRun(which) {
  const out = spawnSync(process.execPath, ['--no-turbo-inlining', SELF, '--child', `--grass=${which}`], { encoding: 'utf8', timeout: 480000, maxBuffer: 64 * 1024 * 1024 })
  if (out.error) throw new Error(`[grass-revisit] ${which} child: ${out.error.message}`)
  const line = (out.stdout || '').split('\n').find(l => l.startsWith('WITNESS_JSON '))
  if (out.status !== 0 || !line) throw new Error(`[grass-revisit] ${which} child exited ${out.status}\n${out.stderr || out.stdout}`)
  return JSON.parse(line.slice('WITNESS_JSON '.length))
}

const yieldTurn = () => new Promise(r => setTimeout(r, 0))
const pathX = i => { const period = 2 * AMP_M, t = i % period; return (t <= AMP_M ? t : period - t) - AMP_M / 2 }

function stateDigest(g) {
  const h = createHash('sha256')
  for (const key of [...g._cells.keys()].sort()) {
    const c = g._cells.get(key)
    h.update(`${key}:${c.pending ? 'pending' : `${c.count}:${c.onCount}`}\n`)
    if (!c.pending) { h.update(c.on); h.update(c.lod) }
  }
  h.update(`${g.totalInstances}:${g.nearInstances}`)
  return h.digest('hex')
}

async function worldFrame() {
  const { loadWorldModule } = await import(resolve(ROOT, 'src/sdk/WorldLocator.js'))
  const { createPlanetFrame } = await import(resolve(ROOT, 'src/terrain/PlanetFrame.js'))
  const { terrainCarvesOf, terrainHashVersionOf } = await import(resolve(ROOT, 'src/shared/terrainConfig.js'))
  const { createHeightSampler } = await import('mapspinner/height-cpu')
  const world = await loadWorldModule(WORLD)
  const tcfg = world.terrain
  const sampler = createHeightSampler({ radius: tcfg.radius, seed: tcfg.seed, reliefScale: tcfg.reliefScale, hashVersion: terrainHashVersionOf(tcfg), carves: terrainCarvesOf(tcfg) })
  const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
  return { frame, anchorField: sampler.anchorField, worldSeed: (tcfg.seed ?? 0) | 0 }
}

function stubRenderer() {
  const gl = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 1 : () => 1)), set: (t, k, v) => { t[k] = v; return true } })
  return { isWebGPURenderer: false, render() {}, domElement: {}, getContext: () => gl, getParameter: () => 1, capabilities: { isWebGL2: true, maxTextures: 16, maxAnisotropy: 4 }, extensions: { get: () => ({}), has: () => true }, info: { memory: {}, render: {} } }
}

async function runChild(which) {
  const noopCtx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (k === 'measureText' ? () => ({ width: 0 }) : () => {})), set: (t, k, v) => { t[k] = v; return true } })
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => noopCtx, style: {} }), body: { appendChild() {} } }
  process.env.SPOINT_NO_WATCH = '1'
  process.env.SPOINT_SKIP_PREWARM = '1'
  await installAllocHooks()
  const THREE = await import('three')
  const url = which === 'base' ? materializeBase(PRE_REV, [REL])[REL] : treeUrl(REL)
  const { createGrass } = await import(url)
  const { frame, anchorField, worldSeed } = await worldFrame()
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500)
  const g = await createGrass({ renderer: stubRenderer(), scene, frame, anchorField, cfg: { grassRenderDistance: RENDER_DISTANCE_M, grassPlacementLod: false }, worldSeed, placedModels: [] })
  let move = 0
  const step = () => { g.update(DT, camera, [pathX(move) * STEP_M, 0, 0], undefined); move++ }
  let stable = 0, last = -1, updates = 0
  while (updates < WARM_MAX && (stable < STILL_UPDATES || [...g._cells.values()].some(c => c.pending))) {
    g.update(DT, camera, [0, 0, 0], undefined)
    updates++
    await yieldTurn()
    const n = g._cells.size
    stable = n === last ? stable + 1 : 0
    last = n
  }
  for (let w = 0; w < WARM_MOVES; w++) step()
  const revisits0 = g.profile.lodRevisits
  const digest = createHash('sha256')
  const perMove = []
  for (let d = 0; d < DIGEST_MOVES; d++) {
    step()
    const s = stateDigest(g)
    perMove.push(s)
    digest.update(s + '\n')
  }
  const revisits = g.profile.lodRevisits - revisits0
  const windows = []
  for (let k = 0; k < SAMPLED_WINDOWS; k++) windows.push(await sampledAllocationBytes(() => { for (let s = 0; s < SAMPLED_MOVES; s++) step() }, PATTERN, { own: true, functions: REVISIT_FUNCTIONS }))
  const bytes = Math.min(...windows)
  const libraryBytes = await sampledAllocationBytes(() => { for (let s = 0; s < SAMPLED_MOVES; s++) step() }, PATTERN)
  return {
    libraryBytes,
    cells: g._cells.size,
    warmUpdates: updates,
    totalInstances: g.totalInstances,
    nearInstances: g.nearInstances,
    digest: digest.digest('hex'),
    distinctStates: new Set(perMove).size,
    revisits,
    bytes,
    windows,
  }
}

async function main() {
  const arg = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt }
  if (process.argv.includes('--child')) {
    console.log('WITNESS_JSON ' + JSON.stringify(await runChild(arg('grass', 'tree'))))
    process.exit(0)
  }
  const which = arg('grass', 'tree')
  const runs = which === 'base' ? { base: childRun('base') } : { tree: childRun('tree'), base: childRun('base') }
  const target = runs[which === 'base' ? 'base' : 'tree']
  const name = which === 'base' ? 'base' : 'tree'
  const rows = []
  const add = (label, ok, detail) => { rows.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`) }
  if (which !== 'base') {
    add('blade near and mid state equals the pre-change revisit after every move', runs.tree.digest === runs.base.digest, `${DIGEST_MOVES} moves, digests ${runs.tree.digest === runs.base.digest ? 'equal' : 'differ'}, tree ${runs.tree.distinctStates} distinct states, base ${runs.base.distinctStates}`)
    add('the moves exercise the revisit (LOD revisits happen and change state)', runs.tree.revisits > 0 && runs.tree.distinctStates > 1, `tree ${runs.tree.revisits} revisits over ${DIGEST_MOVES} moves, ${runs.tree.distinctStates} distinct states`)
  }
  add('zero sampled bytes allocated by the revisit functions per move after warm-up (lowest of three windows)', target.bytes === 0, `${name}: windows ${target.windows.join(', ')} sampled bytes over ${SAMPLED_MOVES} moves after ${WARM_MOVES} warm-up moves (${target.cells} cells, ${target.totalInstances} instances); info: ${target.libraryBytes} bytes inclusive of the InstancedMesh2 add and remove calls, not gated`)
  const ok = rows.every(Boolean)
  console.log(ok
    ? `RESULT: PASS ${name} grass LOD revisit: ${target.bytes} sampled bytes over ${SAMPLED_MOVES} moves, state equal to the pre-change revisit after each of ${DIGEST_MOVES} moves`
    : `RESULT: FAIL ${name} grass LOD revisit: ${target.bytes} sampled bytes over ${SAMPLED_MOVES} moves`)
  process.exitCode = ok ? 0 : 1
}

main().catch(e => { console.error(e?.stack || e); console.log('RESULT: FAIL grass revisit witness threw'); process.exitCode = 1 })
