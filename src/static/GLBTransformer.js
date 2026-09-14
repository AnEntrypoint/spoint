import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { hasDraco, hasMeshopt, stripDraco, compressMeshopt } from './GLBDraco.js'
import { applyKtx2 } from './GLBKtx2.js'
import { GLB_TRANSFORM_CODE_VERSION } from './BakeCodeVersion.js'
import { fnv1aBytes } from '../shared/fnv1a.js'

const CACHE_DIR_NAME = '.glb-cache'
const MAX_CONCURRENT = 4
let _active = 0
const _waitQueue = []

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

const _hashCache = new Map()
function contentHash(buffer) {
  return fnv1aBytes(buffer).toString(16)
}
function hashFor(filepath, mtime, buffer) {
  const cached = _hashCache.get(filepath)
  if (cached && cached.mtime === mtime) return cached.hash
  const hash = contentHash(buffer)
  _hashCache.set(filepath, { mtime, hash })
  return hash
}

function getCacheDir(glbPath) {
  const dir = dirname(glbPath)
  const cache = join(dir, CACHE_DIR_NAME)
  if (!existsSync(cache)) mkdirSync(cache, { recursive: true })
  return cache
}

export function getCachePath(glbPath) {
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
  if (!isVRM && hasDraco(json)) {
    const stripped = await stripDraco(current)
    if (stripped) current = stripped
  }
  if (!hasMeshopt(json)) {
    const meshoptResult = await compressMeshopt(current)
    if (meshoptResult && meshoptResult.length < current.length) current = meshoptResult
    else if (meshoptResult) console.log(`[glb-transform] meshopt skipped (${meshoptResult.length} > ${current.length})`)
  }
  const ktx2Result = await applyKtx2(current)
  if (ktx2Result) return ktx2Result
  if (current !== inputBuffer) return Buffer.from(current)
  return null
}

function _getOrStartTransform(filepath, mtime) {
  const mem = _memCache.get(filepath)
  if (mem && mem.mtime === mtime) return { buffer: mem.buffer }
  const cachePath = getCachePath(filepath)
  const cacheMetaPath = cachePath + '.meta'
  if (existsSync(cachePath) && existsSync(cacheMetaPath)) {
    try {
      const meta = JSON.parse(readFileSync(cacheMetaPath, 'utf8'))
      if (meta.srcMtime === mtime && meta.codeVersion === GLB_TRANSFORM_CODE_VERSION) {
        const cached = readFileSync(cachePath)
        _memCache.set(filepath, { mtime, buffer: cached })
        return { buffer: cached }
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
          writeFileSync(cacheMetaPath, JSON.stringify({ srcMtime: mtime, codeVersion: GLB_TRANSFORM_CODE_VERSION }))
          _memCache.set(filepath, { mtime, buffer: transformed })
          const pct = Math.round((1 - transformed.length / inputBuf.length) * 100)
          console.log(`[glb-transform] done ${basename(filepath)} ${(inputBuf.length/1024).toFixed(0)}KB -> ${(transformed.length/1024).toFixed(0)}KB (${pct > 0 ? '-' : '+'}${Math.abs(pct)}%) in ${Date.now()-t0}ms`)
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
  return { promise: _inFlight.get(filepath) }
}

export function getTransformed(filepath) {
  const mtime = statSync(filepath).mtimeMs
  const result = _getOrStartTransform(filepath, mtime)
  return result.buffer || null
}

export function getTransformedHash(filepath) {
  const mtime = statSync(filepath).mtimeMs
  const result = _getOrStartTransform(filepath, mtime)
  if (!result.buffer) return null
  return hashFor(filepath, mtime, result.buffer)
}

export async function getTransformedHashAsync(filepath) {
  const buffer = await getTransformedAsync(filepath)
  if (!buffer) return null
  const mtime = statSync(filepath).mtimeMs
  return hashFor(filepath, mtime, buffer)
}

export async function getTransformedAsync(filepath) {
  const mtime = statSync(filepath).mtimeMs
  const result = _getOrStartTransform(filepath, mtime)
  if (result.buffer) return result.buffer
  await result.promise
  const freshMtime = statSync(filepath).mtimeMs
  if (freshMtime !== mtime) return getTransformedAsync(filepath)
  const post = _getOrStartTransform(filepath, freshMtime)
  return post.buffer || null
}

export async function prewarmFiles(files, label = 'referenced') {
  const promises = []
  for (const fp of files) {
    try {
      if (!existsSync(fp) || !statSync(fp).isFile()) continue
      getTransformed(fp)
      if (_inFlight.has(fp)) promises.push(_inFlight.get(fp))
    } catch (e) { console.warn(`[glb-transform] prewarm skip ${basename(fp)}:`, e.message) }
  }
  if (promises.length > 0) {
    console.log(`[glb-transform] prewarming ${promises.length} ${label} model(s) (max ${MAX_CONCURRENT} concurrent)...`)
    await Promise.allSettled(promises)
    console.log(`[glb-transform] ${label} prewarm complete`)
  }
  return promises.length
}

export async function prewarm(dirs) {
  const promises = []
  function scan(dir) {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const fp = join(dir, e.name)
      if (e.isDirectory() && e.name !== CACHE_DIR_NAME && e.name !== '.progressive-cache' && e.name !== 'node_modules') scan(fp)
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
