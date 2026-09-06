import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { hasDraco, hasMeshopt, stripDraco, compressMeshopt } from './GLBDraco.js'
import { applyKtx2 } from './GLBKtx2.js'
import { GLB_TRANSFORM_CODE_VERSION } from './BakeCodeVersion.js'

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

// Content-hash of the TRANSFORMED (post-meshopt/ktx2) bytes, not the source file's mtime -- see
// AGENTS.md content-hash-asset-cache-revalidation. The served ETag used to be `srcMtime.toString(16)`,
// which changes on every redeploy/fresh-checkout even when the transform output is byte-identical
// (a re-baked GLB from the same source produces the same optimized bytes), forcing every client to
// re-download an asset it already has cached. Hashing the actual output bytes means an unchanged
// transform result keeps the SAME address across redeploys, so both the browser's conditional-GET
// (If-None-Match -> 304) and client/ModelCache.js's IndexedDB HEAD-revalidation genuinely cache-hit.
// Same fnv-1a algorithm as StaticHandler.js's contentHashETag / SnapshotEncoder.js's dirty-detection
// (non-cryptographic, fast, adequate for a weak validator). Cached per filepath keyed by mtime so a
// warm process only hashes each transform result once.
const _hashCache = new Map() // filepath -> { mtime, hash }
function contentHash(buffer) {
  let hash = 2166136261
  for (let i = 0; i < buffer.length; i++) { hash ^= buffer[i]; hash = Math.imul(hash, 16777619) }
  return (hash >>> 0).toString(16)
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

// Exported for StaticHandler.js: the on-disk transformed output path doubles as the base name for
// StaticCache's content-hash-keyed compressed sibling (<cachePath>.br/.gz + .meta).
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
    // Strip Draco on read — Three.js Draco decode causes 300MB/s heap spike and OOM
    // on large maps. Draco is a read-only legacy-import path from here: the asset is
    // decoded once here and re-encoded as meshopt below, never re-written as Draco.
    const stripped = await stripDraco(current)
    if (stripped) current = stripped
  }
  // Standardize new/re-encoded output on meshopt (weld+reorder+quantize+
  // EXT_meshopt_compression in one gltf-transform meshopt() transform) -- see
  // AGENTS.md meshopt-standardization-draco-legacy-only. VRM is INCLUDED here (no longer
  // gated): GLBDraco.js's getIO() now registers VRM0Passthrough/VRMCVrmPassthrough
  // (GLBVrmPassthrough.js), real gltf-transform Extension subclasses that round-trip the
  // whole opaque `extensions.VRM`/`extensions.VRMC_vrm` block byte-identically through
  // Document.read()/write() -- see glb-transform-vrm-extension-passthrough-registration.
  // A prior version of this comment claimed VRM was "safe on VRM too" without the
  // registration in place, which was live-DISPROVEN (the extension silently vanished on
  // every serve) and worked around by excluding VRM from this step entirely; that
  // exclusion is now removed because the actual gap (missing Extension registration) is
  // fixed, verified via a real meshopt() round-trip of apps/tps-game/cleetus.vrm: node/mesh
  // document order and count are unchanged by weld/reorder/quantize (so VRM's raw
  // node-index bone/collider/firstPerson references stay valid), and the written VRM JSON
  // block is deep-equal to the source. See GLBVrmPassthrough.js for the full analysis.
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

// Shared by getTransformed (sync, fire-and-forget -- prewarm/kickoff callers that must never block)
// and getTransformedAsync (awaits the in-flight bake -- request-serving callers that must never
// race it). Both read the same mem/disk cache first and only kick off a new bake when neither hits;
// returns the bake's own Promise when one is already running (or was just started) so a caller that
// needs the correct final bytes can await it, or null-fast-path in the cache-hit case.
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

// Content-hash for the CURRENT transform result of filepath, if already resolved synchronously
// (mem or disk cache hit) -- returns null while a bake is in-flight, matching getTransformed's own
// null-while-baking contract, so callers (StaticHandler's ETag path) fall back to the caller-supplied
// default the same way they already handle a transform cache miss.
export function getTransformedHash(filepath) {
  const mtime = statSync(filepath).mtimeMs
  const result = _getOrStartTransform(filepath, mtime)
  if (!result.buffer) return null
  return hashFor(filepath, mtime, result.buffer)
}

// Async variant paired with getTransformedAsync: awaits the in-flight bake (if any) then returns the
// content hash of the final, settled buffer -- never a stale/mid-bake value.
export async function getTransformedHashAsync(filepath) {
  const buffer = await getTransformedAsync(filepath)
  if (!buffer) return null
  const mtime = statSync(filepath).mtimeMs
  return hashFor(filepath, mtime, buffer)
}

// Request-serving variant of getTransformed: a cache-hit resolves synchronously same as above, but a
// cache-miss AWAITS the bake (either just-started or already in-flight from a concurrent request/the
// boot-time prewarm) instead of returning null and letting the caller fall through to serving the
// untransformed source file. Fixes static-transform-cold-boot-request-race -- StaticHandler.js's old
// getTransformed(fp)-returns-null-mid-bake fallthrough served the raw, unoptimized GLB/VRM with an
// `immutable` 24h cache header for any request racing that file's own transform (a fresh upload via
// /upload-model, an editor-replaced asset, or -- pre-boot -- any request landing in the httpServer's
// tiny listen-before-prewarm-settles window on a build without this fix). The transform is IDEMPOTENT
// and mtime-gated (re-checks the mem/disk cache post-await, matching what a fresh getTransformed call
// would see), so this never re-runs a bake that already finished while awaiting -- it just reads the
// same result every other caller of that in-flight promise will see.
export async function getTransformedAsync(filepath) {
  const mtime = statSync(filepath).mtimeMs
  const result = _getOrStartTransform(filepath, mtime)
  if (result.buffer) return result.buffer
  await result.promise
  // Re-stat: a concurrent editor replace mid-bake could have moved mtime again: re-checking from
  // scratch (not trusting the just-awaited promise's closure-captured mtime) means a second bake
  // kicks off transparently for the new mtime rather than serving a result for a now-stale one.
  const freshMtime = statSync(filepath).mtimeMs
  if (freshMtime !== mtime) return getTransformedAsync(filepath)
  const post = _getOrStartTransform(filepath, freshMtime)
  return post.buffer || null
}

// Prewarm an explicit file list (the models the loaded worldDef actually references, plus the
// shared client/anim-lib.glb every client needs before ASSETS_DONE) -- the bounded, awaited half of
// boot prewarm; the whole-apps/-tree scan below stays the backgrounded remainder (see ServerBoot.js).
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
