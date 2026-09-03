// on-demand cluster-LOD baker for the streaming-gltf ModelPool renderer; output kept under the legacy 'model.progressive.glb' name for cache-layout compat

import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname, basename, resolve as resolvePath, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const CACHE_DIR_NAME = '.progressive-cache'
const ROOT_NAME = 'model.progressive.glb'
const MAX_CONCURRENT = 2

// Cache-key must invalidate on ANY change to the bake pipeline's own geometry-correctness
// logic, not just the source GLB's bytes -- a content hash of the source alone lets a
// pre-fix bake sit on disk forever after the bake code changes, since getProgressive()
// only ever checks "does a file already exist at this path" (see the degenerate-triangle
// investigation: 12/13 on-disk .progressive-cache/ bakes predated a real bake-pipeline fix
// by days, one predated it by 183 seconds, and every one kept being served with zero
// invalidation because the bake-code hash was never part of the cache key at all).
const _BAKE_SRC_FILES = [
  '../../packages/streaming-gltf/tools/bake-cluster.mjs',
  '../../packages/streaming-gltf/src/meshlet-codec.js',
  '../../packages/streaming-gltf/src/cluster-lod-mesh.js',
  '../../packages/streaming-gltf/src/material-convergence.js',
]
const _thisDir = dirname(fileURLToPath(import.meta.url))
function _bakeCodeVersion() {
  const h = createHash('sha1')
  for (const rel of _BAKE_SRC_FILES) {
    const p = resolvePath(_thisDir, rel)
    h.update(rel)
    h.update(readFileSync(p))
  }
  return h.digest('hex').slice(0, 12)
}
const BAKE_CODE_VERSION = _bakeCodeVersion()

let _active = 0
const _waitQueue = []
const _inFlight = new Map()   // srcPath -> Promise<string outDir>
const _ready = new Map()      // srcPath -> { hash, outDir }

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

function _hashFile(filepath) {
  return createHash('sha1').update(readFileSync(filepath)).digest('hex').slice(0, 16)
}

function _cacheRoot(srcPath) {
  const dir = join(dirname(srcPath), CACHE_DIR_NAME)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function _outDir(srcPath, hash) {
  return join(_cacheRoot(srcPath), `${basename(srcPath, '.glb')}-${hash}-${BAKE_CODE_VERSION}`)
}

// strips (a) a dangling/out-of-range texture.sampler ref and (b) a material textureInfo pointing at a
// SOURCELESS texture (no .source and no EXT_texture_webp.source -- a genuinely malformed texture entry,
// live-hit on apps/maps/deathrun_kosova.glb: 8/27 textures carry neither) -- both cases make
// gltf-transform's ReaderContext.setTextureInfo build a null internal Texture and crash calling
// .setMagFilter() on it. Case (b) is fixed by dropping the referencing material's textureInfo entry
// entirely (baseColorTexture/normalTexture/etc), not the texture array slot itself, since other
// textures[] indices past it are still referenced by index and must not shift.
function _sanitizeForBake(srcPath, outDir) {
  try {
    const b = readFileSync(srcPath)
    if (b.length < 20 || b.readUInt32LE(0) !== 0x46546c67) return srcPath  // not a binary glTF
    const jsonLen = b.readUInt32LE(12)
    const json = JSON.parse(b.slice(20, 20 + jsonLen).toString())
    const samplers = json.samplers || []
    const textures = json.textures || []
    const images = json.images || []
    let needsFix = false
    const sourceless = new Set()
    for (let i = 0; i < textures.length; i++) {
      const t = textures[i]
      if (!t) continue
      if (t.sampler !== undefined && (t.sampler < 0 || t.sampler >= samplers.length || samplers[t.sampler] == null)) {
        needsFix = true
      }
      const webpSrc = t.extensions?.EXT_texture_webp?.source
      const src = webpSrc !== undefined ? webpSrc : t.source
      if (src === undefined || src === null || src < 0 || src >= images.length) {
        sourceless.add(i); needsFix = true
      }
    }
    if (!needsFix) return srcPath
    for (const t of textures) { if (t && t.sampler !== undefined) delete t.sampler }
    if (sourceless.size) {
      const stripRef = (holder, key) => { if (holder && holder[key] && sourceless.has(holder[key].index)) delete holder[key] }
      for (const m of json.materials || []) {
        if (m.pbrMetallicRoughness) {
          stripRef(m.pbrMetallicRoughness, 'baseColorTexture')
          stripRef(m.pbrMetallicRoughness, 'metallicRoughnessTexture')
        }
        stripRef(m, 'normalTexture'); stripRef(m, 'occlusionTexture'); stripRef(m, 'emissiveTexture')
        const sg = m.extensions?.KHR_materials_pbrSpecularGlossiness
        if (sg) { stripRef(sg, 'diffuseTexture'); stripRef(sg, 'specularGlossinessTexture') }
      }
      console.log(`[progressive] sanitized ${basename(srcPath)} (dropped ${sourceless.size} sourceless texture ref(s))`)
    }
    let nj = JSON.stringify(json); while (nj.length % 4 !== 0) nj += ' '
    const jb = Buffer.from(nj)
    const binStart = 20 + jsonLen
    const binLen = b.readUInt32LE(binStart)
    const binBuf = b.slice(binStart + 8, binStart + 8 + binLen)
    const total = 12 + 8 + jb.length + 8 + binBuf.length
    const out = Buffer.alloc(total)
    out.write('glTF', 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8)
    out.writeUInt32LE(jb.length, 12); out.writeUInt32LE(0x4E4F534A, 16); jb.copy(out, 20)
    let o = 20 + jb.length
    out.writeUInt32LE(binBuf.length, o); out.writeUInt32LE(0x004E4942, o + 4); binBuf.copy(out, o + 8)
    mkdirSync(outDir, { recursive: true })
    const sanePath = join(outDir, 'source.sanitized.glb')
    writeFileSync(sanePath, out)
    console.log(`[progressive] sanitized ${basename(srcPath)} before bake`)
    return sanePath
  } catch (e) {
    console.warn(`[progressive] sanitize skipped for ${basename(srcPath)}: ${e.message}`)
    return srcPath
  }
}

// lazy import so a missing optional toolchain degrades to "no baked output" instead of crashing at startup
let _bakeFn = null
async function _getBake() {
  if (_bakeFn) return _bakeFn
  const mod = await import('streaming-gltf/bake')
  const bakeCluster = mod.bakeCluster
  _bakeFn = async (srcPath, outDir) => {
    mkdirSync(outDir, { recursive: true })
    const bakeSrc = _sanitizeForBake(srcPath, outDir)
    await bakeCluster(bakeSrc, join(outDir, ROOT_NAME))
  }
  return _bakeFn
}

// synchronous + non-blocking so the static handler can fall through to serving the plain GLB while the bake runs
export function getProgressive(srcPath) {
  let hash
  try { hash = _hashFile(srcPath) } catch { return null }
  const ready = _ready.get(srcPath)
  if (ready && ready.hash === hash) return ready.outDir

  const outDir = _outDir(srcPath, hash)
  const rootOut = join(outDir, ROOT_NAME)
  if (existsSync(rootOut)) {
    _ready.set(srcPath, { hash, outDir })
    return outDir
  }
  if (!_inFlight.has(srcPath)) {
    const p = (async () => {
      await _acquireSlot()
      try {
        const bake = await _getBake()
        const t0 = Date.now()
        console.log(`[progressive] baking ${basename(srcPath)}`)
        await bake(srcPath, outDir)
        _ready.set(srcPath, { hash, outDir })
        console.log(`[progressive] done ${basename(srcPath)} in ${Date.now() - t0}ms`)
        return outDir
      } catch (e) {
        console.warn(`[progressive] bake failed ${basename(srcPath)}: ${e.message}`)
        return null
      } finally {
        _inFlight.delete(srcPath)
        _releaseSlot()
      }
    })()
    _inFlight.set(srcPath, p)
  }
  return null
}

export async function ensureProgressive(srcPath) {
  const ready = getProgressive(srcPath)
  if (ready) return ready
  if (_inFlight.has(srcPath)) return _inFlight.get(srcPath)
  return null
}

// fire-and-forget; failures degrade to the client's legacy path
export function prewarmProgressive(srcPaths) {
  let started = 0
  for (const fp of srcPaths) {
    if (!fp || !existsSync(fp)) continue
    getProgressive(fp)
    started++
  }
  if (started) console.log(`[progressive] prewarming ${started} model(s)`)
}

// Pure path-containment check, split out of resolveBakedFile so it is unit-testable without paying
// for a real bake (getProgressive needs a real source GLB + streaming-gltf/bake). Exported so the
// test imports and exercises this EXACT function -- never a parallel reimplementation that could
// silently drift from the real guard.
export function isContainedPath(outDir, relative) {
  const fp = resolvePath(join(outDir, relative))
  const baseResolved = resolvePath(outDir)
  return fp === baseResolved || fp.startsWith(baseResolved + sep)
}

// `relative` comes from the request URL -- must reject anything resolving outside outDir or a `../../` payload escapes the bake dir
export function resolveBakedFile(srcPath, relative) {
  const outDir = getProgressive(srcPath)
  if (!outDir) return null
  if (!isContainedPath(outDir, relative)) return null
  const fp = resolvePath(join(outDir, relative))
  if (!existsSync(fp) || !statSync(fp).isFile()) return null
  return fp
}
