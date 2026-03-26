import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { hasDraco, applyDraco } from './GLBDraco.js'
import { applyKtx2 } from './GLBKtx2.js'

const CACHE_DIR_NAME = '.glb-cache'
const MAX_CONCURRENT = 4
let _active = 0
const _waitQueue = []

export function setPrewarmMode(_) {}

function _acquireSlot() {
  return new Promise(resolve => {
    if (_active < MAX_CONCURRENT) { _active++; resolve() }
    else _waitQueue.push(resolve)
  })
}
function _releaseSlot() {
  const next = _waitQueue.shift()
  if (next) next()
  else _active--
}

const _inFlight = new Map()
const _memCache = new Map()

function getCacheDir(glbPath) {
  const dir = dirname(glbPath)
  const cache = join(dir, CACHE_DIR_NAME)
  if (!existsSync(cache)) mkdirSync(cache, { recursive: true })
  return cache
}

function getCachePath(glbPath) {
  return join(getCacheDir(glbPath), basename(glbPath))
}

async function transformGLB(inputBuffer) {
  const buf = Buffer.from(inputBuffer)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (view.getUint32(0, true) !== 0x46546C67) return null
  const jsonLen = view.getUint32(12, true)
  let json; try { json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8')) } catch { return null }
  let current = inputBuffer
  const isVRM = !!(json.extensions?.VRM || json.extensions?.VRMC_vrm)
  if (!isVRM && !hasDraco(json)) {
    const dracoResult = await applyDraco(current)
    if (dracoResult && dracoResult.length < current.length) current = dracoResult
    else if (dracoResult) console.log(`[glb-transform] draco skipped (${dracoResult.length} > ${current.length})`)
  }
  const ktx2Result = await applyKtx2(current)
  if (ktx2Result) return ktx2Result
  if (current !== inputBuffer) return Buffer.from(current)
  return null
}

export function getTransformed(filepath) {
  const mtime = statSync(filepath).mtimeMs
  const mem = _memCache.get(filepath)
  if (mem && mem.mtime === mtime) return mem.buffer
  const cachePath = getCachePath(filepath)
  const cacheMetaPath = cachePath + '.meta'
  if (existsSync(cachePath) && existsSync(cacheMetaPath)) {
    try {
      const meta = JSON.parse(readFileSync(cacheMetaPath, 'utf8'))
      if (meta.srcMtime === mtime && meta.v === 3) {
        const cached = readFileSync(cachePath)
        _memCache.set(filepath, { mtime, buffer: cached })
        return cached
      }
    } catch {}
  }
  if (!_inFlight.has(filepath)) {
    const promise = (async () => {
      await _acquireSlot()
      try {
        const inputBuf = readFileSync(filepath)
        const t0 = Date.now()
        console.log(`[glb-transform] starting ${basename(filepath)}`)
        const transformed = await transformGLB(inputBuf)
        if (transformed) {
          writeFileSync(cachePath, transformed)
          writeFileSync(cacheMetaPath, JSON.stringify({ srcMtime: mtime, v: 3 }))
          _memCache.set(filepath, { mtime, buffer: transformed })
          const pct = Math.round((1 - transformed.length / inputBuf.length) * 100)
          console.log(`[glb-transform] done ${basename(filepath)} ${(inputBuf.length/1024).toFixed(0)}KB → ${(transformed.length/1024).toFixed(0)}KB (${pct > 0 ? '-' : '+'}${Math.abs(pct)}%) in ${Date.now()-t0}ms`)
        } else {
          console.log(`[glb-transform] skipped ${basename(filepath)} (no changes or error)`)
        }
      } catch (e) {
        console.warn(`[glb-transform] error ${basename(filepath)}:`, e.message)
      } finally {
        _inFlight.delete(filepath)
        _releaseSlot()
      }
    })()
    _inFlight.set(filepath, promise)
  }
  return null
}

export async function prewarm(dirs) {
  const promises = []
  function scan(dir) {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const fp = join(dir, e.name)
      if (e.isDirectory() && e.name !== CACHE_DIR_NAME && e.name !== 'node_modules') scan(fp)
      else if (e.isFile() && (e.name.endsWith('.glb') || e.name.endsWith('.vrm'))) {
        getTransformed(fp)
        if (_inFlight.has(fp)) promises.push(_inFlight.get(fp))
      }
    }
  }
  for (const dir of dirs) scan(dir)
  if (promises.length > 0) {
    console.log(`[glb-transform] prewarming ${promises.length} models (max ${MAX_CONCURRENT} concurrent)...`)
    await Promise.allSettled(promises)
    console.log('[glb-transform] prewarm complete')
  }
}
