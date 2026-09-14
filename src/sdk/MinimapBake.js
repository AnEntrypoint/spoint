import { Worker } from 'node:worker_threads'
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveTerrainConfig, minimapDescriptor, minimapExtentOf, minimapResOf, minimapBakeParams, withTerrainSeed } from '../shared/terrainConfig.js'
import { MINIMAP_BAKE_CODE_VERSION } from '../static/BakeCodeVersion.js'

const MAX_ON_DEMAND_MINIMAP_BAKES = 64
const MINIMAP_ARTIFACT_PATH = /^\/apps\/world\/([A-Za-z0-9_-]{1,128})\.(-?\d{1,10})\.minimap\.(?:json|png)$/
const BAKE_WORKER_SOURCE = `const { parentPort, workerData } = require('node:worker_threads')
import(workerData.bakeModUrl)
  .then(m => m.bakeMinimap(workerData.opts))
  .then(r => parentPort.postMessage({ png: r.png, header: r.header }), e => parentPort.postMessage({ error: (e && e.stack) || String(e) }))`

const worldDir = () => join(process.cwd(), 'apps', 'world')
const inFlightBakes = new Map()
const backgroundBakes = new Map()
const onDemandBakes = new Map()
let onDemandQueue = Promise.resolve()

function readMinimapHeader(base) {
  try { return JSON.parse(readFileSync(join(worldDir(), `${base}.json`), 'utf8')) } catch { return null }
}

function sameArray(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
}

export function isMinimapStale(header, tcfg) {
  if (!header) return true
  if (header.codeVersion !== MINIMAP_BAKE_CODE_VERSION) return true
  const params = minimapBakeParams(tcfg)
  if (header.radius !== params.radius) return true
  if ((header.reliefScale ?? null) !== params.reliefScale) return true
  if (header.extent !== params.extent) return true
  if (header.N !== params.res) return true
  if (!sameArray(header.anchorDir, params.anchorDir)) return true
  if (!sameArray(header.center, params.center)) return true
  return false
}

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
  const exists = existsSync(join(worldDir(), `${base}.png`))
  if (opts.force || !exists) {
    const bake = bakeAndWrite(base, tcfg).finally(() => inFlightBakes.delete(base))
    inFlightBakes.set(base, bake)
    return bake
  }
  if (!isMinimapStale(readMinimapHeader(base), tcfg)) return Promise.resolve()
  if (!backgroundBakes.has(base)) {
    const bake = bakeAndWrite(base, tcfg)
      .catch(e => console.error(`[minimap] background re-bake of ${base} failed:`, e?.message || e))
      .finally(() => backgroundBakes.delete(base))
    backgroundBakes.set(base, bake)
  }
  return Promise.resolve()
}

async function bakeAndWrite(base, tcfg) {
  const outPng = join(worldDir(), `${base}.png`)
  const outJson = join(worldDir(), `${base}.json`)
  const t0 = Date.now()
  const { png, header } = await bakeOffMainThread({
    seed: tcfg.seed | 0, radius: tcfg.radius, reliefScale: tcfg.reliefScale, anchorDir: tcfg.anchorDir,
    extent: minimapExtentOf(tcfg),
    res: minimapResOf(tcfg), center: tcfg.center || [0, 0],
  })
  mkdirSync(worldDir(), { recursive: true })
  const tmpTag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const tmpPng = `${outPng}.tmp-${tmpTag}`
  const tmpJson = `${outJson}.tmp-${tmpTag}`
  writeFileSync(tmpPng, png)
  writeFileSync(tmpJson, JSON.stringify(header))
  renameSync(tmpPng, outPng)
  renameSync(tmpJson, outJson)
  console.log(`[minimap] baked ${base}.png (${header.N}x${header.N}, ${(png.length / 1024).toFixed(1)}KB, height ${header.minHeight}..${header.maxHeight}m, codeVersion ${header.codeVersion}) in ${Date.now() - t0}ms`)
}

export function isMinimapArtifactPath(path) {
  return MINIMAP_ARTIFACT_PATH.test(path)
}

async function bakeWorldSeedIfMissing(worldName, seed) {
  const worldFile = join(worldDir(), `${worldName}.js`)
  if (!existsSync(worldFile)) return
  const mod = await import(pathToFileURL(worldFile).href)
  const tcfg = resolveTerrainConfig(withTerrainSeed(mod.default || mod, seed))
  if (!minimapDescriptor(worldName, tcfg)) return
  await bakeMinimapIfMissing(worldName, tcfg)
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
