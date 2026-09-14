import { Worker } from 'node:worker_threads'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveTerrainConfig, minimapDescriptor, minimapExtentOf, withTerrainSeed } from '../shared/terrainConfig.js'

const DEFAULT_MINIMAP_RES = 256
const MAX_ON_DEMAND_MINIMAP_BAKES = 64
const MINIMAP_ARTIFACT_PATH = /^\/apps\/world\/([A-Za-z0-9_-]{1,128})\.(-?\d{1,10})\.minimap\.(?:json|png)$/
const BAKE_WORKER_SOURCE = `const { parentPort, workerData } = require('node:worker_threads')
import(workerData.bakeModUrl)
  .then(m => m.bakeMinimap(workerData.opts))
  .then(r => parentPort.postMessage({ png: r.png, header: r.header }), e => parentPort.postMessage({ error: (e && e.stack) || String(e) }))`

const worldDir = () => join(process.cwd(), 'apps', 'world')
const inFlightBakes = new Map()
const onDemandBakes = new Map()
let onDemandQueue = Promise.resolve()

function bakeOffMainThread(opts) {
  const bakeModUrl = pathToFileURL(join(process.cwd(), 'scripts', 'bake-minimap.mjs')).href
  return new Promise((resolve, reject) => {
    const worker = new Worker(BAKE_WORKER_SOURCE, { eval: true, workerData: { bakeModUrl, opts } })
    worker.once('message', m => { if (m.error) reject(new Error(m.error)); else resolve(m) })
    worker.once('error', reject)
    worker.once('exit', code => reject(new Error(`minimap bake worker exited with code ${code} before replying`)))
  })
}

export function bakeMinimapIfMissing(worldName, tcfg, opts = {}) {
  const base = `${worldName}.${tcfg.seed | 0}.minimap`
  if (inFlightBakes.has(base)) return inFlightBakes.get(base)
  if (!opts.force && existsSync(join(worldDir(), `${base}.png`))) return Promise.resolve()
  const bake = bakeAndWrite(base, tcfg).finally(() => inFlightBakes.delete(base))
  inFlightBakes.set(base, bake)
  return bake
}

async function bakeAndWrite(base, tcfg) {
  const outPng = join(worldDir(), `${base}.png`)
  const t0 = Date.now()
  const { png, header } = await bakeOffMainThread({
    seed: tcfg.seed | 0, radius: tcfg.radius, reliefScale: tcfg.reliefScale, anchorDir: tcfg.anchorDir,
    extent: minimapExtentOf(tcfg),
    res: Number.isFinite(tcfg.minimapRes) ? tcfg.minimapRes : DEFAULT_MINIMAP_RES, center: tcfg.center || [0, 0],
  })
  mkdirSync(worldDir(), { recursive: true })
  writeFileSync(outPng, png)
  writeFileSync(join(worldDir(), `${base}.json`), JSON.stringify(header))
  console.log(`[minimap] baked ${base}.png (${header.N}x${header.N}, ${(png.length / 1024).toFixed(1)}KB, height ${header.minHeight}..${header.maxHeight}m) in ${Date.now() - t0}ms`)
}

export function isMinimapArtifactPath(path) {
  return MINIMAP_ARTIFACT_PATH.test(path)
}

async function bakeWorldSeedIfMissing(worldName, seed) {
  const key = `${worldName}.${seed}`
  if (existsSync(join(worldDir(), `${key}.minimap.png`)) && existsSync(join(worldDir(), `${key}.minimap.json`))) return
  const worldFile = join(worldDir(), `${worldName}.js`)
  if (!existsSync(worldFile)) return
  const mod = await import(pathToFileURL(worldFile).href)
  const tcfg = resolveTerrainConfig(withTerrainSeed(mod.default || mod, seed))
  if (!minimapDescriptor(worldName, tcfg)) return
  await bakeMinimapIfMissing(worldName, tcfg, { force: true })
}

export function bakeRequestedMinimapIfMissing(path) {
  const m = MINIMAP_ARTIFACT_PATH.exec(path)
  if (!m) return Promise.resolve()
  const worldName = m[1], seed = Number(m[2])
  if ((seed | 0) !== seed) return Promise.resolve()
  const key = `${worldName}.${seed}`
  if (onDemandBakes.has(key)) return onDemandBakes.get(key)
  if (onDemandBakes.size >= MAX_ON_DEMAND_MINIMAP_BAKES) return Promise.resolve()
  const bake = onDemandQueue.then(() => bakeWorldSeedIfMissing(worldName, seed))
  onDemandQueue = bake.catch(() => {})
  onDemandBakes.set(key, bake)
  return bake
}
