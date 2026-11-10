import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { installAllocHooks, materializeBase, treeUrl, sampledAllocationBytes } from './lib/alloc-witness-hooks.mjs'

const SELF = fileURLToPath(import.meta.url)
const ROOT = resolve(SELF, '..', '..')
const PRE_REV = '20e9389'
const WORLD = resolve(ROOT, 'apps/world/tps-game.js')
const MODULES = {
  grass: { rel: 'client/core/Grass.js', factory: 'createGrass', pattern: /client\/core\/Grass\.js$/ },
  rocks: { rel: 'client/core/Rocks.js', factory: 'createRocks', pattern: /client\/core\/Rocks\.js$/ },
}
const FUNCTIONS = new Set(['applyOcclusion', 'applyOcclusionToCell'])
const RENDER_DISTANCE_M = 40
const DT = 0.016
const WARM_MAX = 800
const STILL_UPDATES = 60
const WARM_CALLS = 300
const DIGEST_CALLS = 120
const SAMPLED_CALLS = 50
const SAMPLED_WINDOWS = 3

function childRun(mod, which) {
  const out = spawnSync(process.execPath, ['--no-turbo-inlining', SELF, '--child', `--module=${mod}`, `--occ=${which}`], { encoding: 'utf8', timeout: 480000, maxBuffer: 64 * 1024 * 1024 })
  if (out.error) throw new Error(`[occlusion] ${mod} ${which} child: ${out.error.message}`)
  const line = (out.stdout || '').split('\n').find(l => l.startsWith('WITNESS_JSON '))
  if (out.status !== 0 || !line) throw new Error(`[occlusion] ${mod} ${which} child exited ${out.status}\n${out.stderr || out.stdout}`)
  return JSON.parse(line.slice('WITNESS_JSON '.length))
}

const yieldTurn = () => new Promise(r => setTimeout(r, 0))

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
  const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
  return { frame, anchorField: sampler.anchorField, worldSeed: (tcfg.seed ?? 0) | 0 }
}

function grassState(api) {
  const h = createHash('sha256')
  for (const key of [...api._cells.keys()].sort()) {
    const c = api._cells.get(key)
    h.update(`${key}:${c.occluded === true ? 1 : 0}\n`)
    if (c.pending) continue
    for (const en of c.entries) {
      if (!en) continue
      const mesh = en.near ? api._im : api._imMid
      h.update(mesh.getVisibilityAt(en.id) ? '1' : '0')
    }
  }
  return h.digest('hex')
}

function rocksState(api) {
  const h = createHash('sha256')
  const bm = api._bm
  for (let id = 0; id < bm._instanceInfo.length; id++) {
    if (!bm._instanceInfo[id].active) continue
    h.update(bm.getVisibleAt(id) ? '1' : '0')
  }
  return h.digest('hex')
}

async function runChild(mod, which) {
  const spec = MODULES[mod]
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : (k === 'measureText' ? () => ({ width: 0 }) : () => {})), set: (t, k, v) => { t[k] = v; return true } }), style: {} }), body: { appendChild() {} } }
  process.env.SPOINT_NO_WATCH = '1'
  process.env.SPOINT_SKIP_PREWARM = '1'
  await installAllocHooks()
  const THREE = await import('three')
  const url = which === 'base' ? materializeBase(PRE_REV, [spec.rel])[spec.rel] : treeUrl(spec.rel)
  const factory = (await import(url))[spec.factory]
  const { frame, anchorField, worldSeed } = await worldFrame()
  const api = await factory({ renderer: stubRenderer(), scene: new THREE.Scene(), frame, anchorField, cfg: { grassRenderDistance: RENDER_DISTANCE_M, grassPlacementLod: false }, worldSeed, placedModels: [] })
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500)
  let stable = 0, last = -1, updates = 0
  while (updates < WARM_MAX && stable < STILL_UPDATES) {
    api.update(DT, camera, [0, 0, 0], undefined)
    updates++
    await yieldTurn()
    const n = api.totalInstances
    stable = n === last ? stable + 1 : 0
    last = n
  }
  const proxies = api.getOcclusionCandidates()
  const keys = proxies.map(p => p.key).sort()
  const geometries = new Set(proxies.map(p => p.root.children[0].geometry.uuid)).size
  const state = spec.factory === 'createGrass' ? grassState : rocksState
  const setFor = k => new Set(keys.filter((_, idx) => (idx + k) % (2 + (k % 4)) === 0))
  const total = WARM_CALLS + DIGEST_CALLS + SAMPLED_WINDOWS * SAMPLED_CALLS
  const sets = []
  for (let k = 0; k < total; k++) sets.push(setFor(k))
  for (let w = 0; w < WARM_CALLS; w++) api.applyOcclusion(sets[w])
  const digest = createHash('sha256')
  const perCall = new Set()
  for (let d = 0; d < DIGEST_CALLS; d++) {
    api.applyOcclusion(sets[WARM_CALLS + d])
    const s = state(api)
    perCall.add(s)
    digest.update(s + '\n')
  }
  const windows = []
  for (let w = 0; w < SAMPLED_WINDOWS; w++) {
    const base = WARM_CALLS + DIGEST_CALLS + w * SAMPLED_CALLS
    windows.push(await sampledAllocationBytes(() => { for (let k = 0; k < SAMPLED_CALLS; k++) api.applyOcclusion(sets[base + k]) }, spec.pattern, { own: true, functions: FUNCTIONS }))
  }
  return { proxies: proxies.length, geometries, digest: digest.digest('hex'), distinctStates: perCall.size, windows, bytes: Math.min(...windows), updates }
}

function checksFor(mod, runs) {
  const rows = []
  const tree = runs.tree, base = runs.base
  const label = mod
  if (tree) {
    rows.push(['state after each apply equals the pre-change occlusion', tree.digest === base.digest, `${label}: ${DIGEST_CALLS} applies, digests ${tree.digest === base.digest ? 'equal' : 'differ'}, ${tree.distinctStates} distinct states`])
    rows.push(['the applies change instance visibility (not vacuous)', tree.distinctStates > 1, `${label}: ${tree.distinctStates} distinct states over ${DIGEST_CALLS} applies`])
    rows.push(['every occlusion proxy shares one box geometry', tree.geometries === 1, `${label}: ${tree.geometries} geometry(ies) over ${tree.proxies} proxies (base ${base.geometries})`])
  }
  const target = tree || base
  const name = tree ? 'tree' : 'base'
  rows.push(['zero sampled bytes allocated by the occlusion apply after warm-up (lowest of three windows)', target.bytes === 0, `${label} ${name}: windows ${target.windows.join(', ')} sampled bytes over ${SAMPLED_CALLS} applies after ${WARM_CALLS} warm-up applies`])
  return rows
}

async function main() {
  const arg = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt }
  if (process.argv.includes('--child')) {
    console.log('WITNESS_JSON ' + JSON.stringify(await runChild(arg('module', 'grass'), arg('occ', 'tree'))))
    process.exit(0)
  }
  const which = arg('occ', 'tree')
  const mods = Object.keys(MODULES)
  const allRows = []
  const summary = []
  for (const mod of mods) {
    const runs = which === 'base' ? { base: childRun(mod, 'base') } : { tree: childRun(mod, 'tree'), base: childRun(mod, 'base') }
    for (const [label, ok, detail] of checksFor(mod, runs)) {
      allRows.push(ok)
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`)
    }
    summary.push(`${mod} ${which === 'base' ? 'base' : 'tree'} ${runs[which === 'base' ? 'base' : 'tree'].bytes} B`)
  }
  const ok = allRows.every(Boolean)
  const name = which === 'base' ? 'base' : 'tree'
  console.log(ok
    ? `RESULT: PASS ${name} occlusion proxies (${mods.join(', ')}): ${summary.join('; ')} sampled bytes per ${SAMPLED_CALLS} applies, one shared box geometry, state equal to the pre-change apply`
    : `RESULT: FAIL ${name} occlusion proxies (${mods.join(', ')}): ${summary.join('; ')} sampled bytes per ${SAMPLED_CALLS} applies`)
  process.exitCode = ok ? 0 : 1
}

main().catch(e => { console.error(e?.stack || e); console.log('RESULT: FAIL occlusion proxy witness threw'); process.exitCode = 1 })
