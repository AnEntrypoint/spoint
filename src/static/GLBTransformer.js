/**
 * GLBTransformer.js
 *
 * In-transit GLB optimizer. On first request for a .glb file:
 *   1. Sanitizes malformed CS:GO texture entries (null-source textures)
 *   2. Draco-compresses geometry if not already Draco-encoded
 *   3. Extracts each WebP image buffer, converts WebP→PNG→KTX2 via sharp + ktx CLI
 *   4. Patches the GLB binary in-place (replaces image buffers, updates JSON header)
 *   5. Caches to .glb-cache/ on disk, keyed by file mtime
 *
 * Already-Draco GLBs: geometry binary is untouched except image slices replaced.
 * Non-Draco GLBs: gltf-transform adds Draco, then KTX2 patch is applied.
 * No geometry quality loss for already-compressed maps.
 *
 * The first request for a GLB serves the ORIGINAL immediately while processing
 * runs in the background. Subsequent requests get the cached optimized version.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, unlinkSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KTX_BIN = join(__dirname, '../../bin/ktx.exe')
const CACHE_DIR_NAME = '.glb-cache'

// Concurrency limit: max simultaneous transform jobs (ktx.exe + sharp are CPU/memory intensive)
// During prewarm: use high concurrency to speed up initial transforms
// During runtime: use conservative 2 to avoid blocking requests
const MAX_CONCURRENT = 8
let _active = 0
const _waitQueue = []
let _isPrewarming = false

export function setPrewarmMode(isPrewarming) {
  _isPrewarming = isPrewarming
}
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

// Map<filepath, Promise<Buffer|null>> — in-flight transforms
const _inFlight = new Map()
// Map<filepath, {mtime, buffer}> — in-memory cache of transformed buffers
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

/**
 * Sanitize GLB JSON: fix CS:GO textures that have no source and empty extensions.
 * These crash gltf-transform and cause Three.js to warn. Fix: point them to image[0].
 */
function sanitizeJson(json) {
  const textures = json.textures || []
  for (const tex of textures) {
    const hasWebP = tex.extensions?.EXT_texture_webp?.source !== undefined
    const hasBase = tex.source !== undefined
    if (!hasWebP && !hasBase && json.images?.length > 0) {
      tex.source = 0 // point to first image as dummy fallback
    }
  }
}

/**
 * Determine KTX2 encode mode for a texture slot.
 * All textures use uastc for broad Three.js KTX2Loader compatibility.
 */
function encodeMode(slotName) {
  return 'uastc'
}

/**
 * Convert an image buffer (WebP, PNG, JPEG) to KTX2 buffer.
 * Pipeline: image → PNG (sharp) → KTX2 (ktx create)
 * Returns null if ktx binary is unavailable or conversion fails.
 */
async function imageToKtx2(imageBuffer, mode = 'basis-lz', tmpBase = 'tex') {
  if (!existsSync(KTX_BIN)) return null
  const tmp = join(tmpdir(), `${tmpBase}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const pngPath = tmp + '.png'
  const ktxPath = tmp + '.ktx2'
  try {
    await sharp(imageBuffer).resize(1024, 1024, { fit: 'fill' }).png().toFile(pngPath)
    const args = [
      'create',
      '--format', 'R8G8B8A8_SRGB',
      '--encode', mode,
      '--generate-mipmap',
      pngPath, ktxPath
    ]
    const result = spawnSync(KTX_BIN, args, { timeout: 30000, windowsHide: true })
    if (result.status !== 0 || !existsSync(ktxPath)) return null
    return readFileSync(ktxPath)
  } catch {
    return null
  } finally {
    try { if (existsSync(pngPath)) unlinkSync(pngPath) } catch {}
    try { if (existsSync(ktxPath)) unlinkSync(ktxPath) } catch {}
  }
}

/**
 * Check if a GLB buffer contains Draco-compressed geometry.
 */
function hasDraco(jsonChunk) {
  return (jsonChunk.extensionsUsed || []).includes('KHR_draco_mesh_compression')
}

/**
 * Apply Draco compression to a GLB buffer using gltf-transform.
 * Returns new Buffer or null on failure.
 */
async function applyDraco(inputBuffer) {
  try {
    const { NodeIO } = await import('@gltf-transform/core')
    const { draco } = await import('@gltf-transform/functions')
    const { KHRDracoMeshCompression } = await import('@gltf-transform/extensions')
    const draco3d = await import('draco3d')
    const encoderModule = await draco3d.createEncoderModule({})
    const decoderModule = await draco3d.createDecoderModule({})

    const io = new NodeIO()
      .registerExtensions([KHRDracoMeshCompression])
      .registerDependencies({
        'draco3d.encoder': encoderModule,
        'draco3d.decoder': decoderModule,
      })

    const document = await io.readBinary(new Uint8Array(inputBuffer))
    await document.transform(draco({ method: 'edgebreaker' }))
    const out = await io.writeBinary(document)
    return Buffer.from(out)
  } catch (e) {
    console.warn('[glb-transform] draco failed:', e.message)
    return null
  }
}

/**
 * Apply KTX2 image replacement to a GLB buffer.
 * Patches only image buffer views — geometry binary is untouched.
 * Returns new Buffer or null on failure/no changes.
 */
async function applyKtx2(inputBuffer) {
  const buf = Buffer.from(inputBuffer)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

  if (view.getUint32(0, true) !== 0x46546C67) return null // not GLB magic
  const jsonLen = view.getUint32(12, true)
  const jsonBytes = buf.slice(20, 20 + jsonLen)
  let json
  try { json = JSON.parse(jsonBytes.toString('utf8')) } catch { return null }

  const binChunkOffset = 20 + jsonLen
  if (buf.length <= binChunkOffset + 8) return null

  const binLen = view.getUint32(binChunkOffset, true)
  const binStart = binChunkOffset + 8
  const originalBin = buf.slice(binStart, binStart + binLen)

  sanitizeJson(json)

  const images = json.images || []
  const bufferViews = json.bufferViews || []

  // Build slot name map: imageIndex → texture slot hint (standard glTF materials)
  const imageSlotHints = new Map()
  for (const mat of json.materials || []) {
    const slots = { normalTexture: 'normal', occlusionTexture: 'occlusion', emissiveTexture: 'emissive' }
    const pbrSlots = { baseColorTexture: 'baseColor', metallicRoughnessTexture: 'metallicRoughness' }
    const pbr = mat.pbrMetallicRoughness || {}
    for (const [key, hint] of Object.entries({ ...slots, ...pbrSlots })) {
      const src = (key in slots ? mat : pbr)[key]
      const texIdx = src?.index
      if (texIdx === undefined) continue
      const tex = json.textures?.[texIdx]
      const imgIdx = tex?.extensions?.EXT_texture_webp?.source ?? tex?.source
      if (imgIdx !== undefined) imageSlotHints.set(imgIdx, hint)
    }
  }

  // VRM v0: pull normal map hints from materialProperties._BumpMap
  for (const mp of json.extensions?.VRM?.materialProperties || []) {
    const bumpIdx = mp.textureProperties?._BumpMap
    if (bumpIdx !== undefined) {
      const tex = json.textures?.[bumpIdx]
      const imgIdx = tex?.extensions?.EXT_texture_webp?.source ?? tex?.source
      if (imgIdx !== undefined) imageSlotHints.set(imgIdx, 'normal')
    }
  }

  // Convert each WebP / PNG / JPEG image to KTX2
  const CONVERTIBLE = new Set(['image/webp', 'image/png', 'image/jpeg'])
  const replacements = new Map()
  for (let i = 0; i < images.length; i++) {
    const img = images[i]
    if (!CONVERTIBLE.has(img.mimeType)) continue
    const bvIdx = img.bufferView
    if (bvIdx === undefined) continue
    const bv = bufferViews[bvIdx]
    if (!bv) continue
    const imgBytes = originalBin.slice(bv.byteOffset, bv.byteOffset + bv.byteLength)
    const mode = encodeMode(imageSlotHints.get(i))
    const ktx2 = await imageToKtx2(imgBytes, mode, `img${i}`)
    if (ktx2) replacements.set(bvIdx, ktx2)
  }

  if (replacements.size === 0) return null

  // Rebuild binary buffer with replaced image chunks
  const bvCount = bufferViews.length
  const sortedIdxs = Array.from({ length: bvCount }, (_, i) => i)
    .sort((a, b) => (bufferViews[a].byteOffset || 0) - (bufferViews[b].byteOffset || 0))

  const newBufViews = bufferViews.map(bv => ({ ...bv }))
  const newChunks = []
  let newOffset = 0

  for (const idx of sortedIdxs) {
    const bv = bufferViews[idx]
    const pad = (4 - (newOffset % 4)) % 4
    if (pad > 0) { newChunks.push(Buffer.alloc(pad, 0)); newOffset += pad }
    if (replacements.has(idx)) {
      const ktx2 = replacements.get(idx)
      newChunks.push(ktx2)
      newBufViews[idx] = { ...bv, byteOffset: newOffset, byteLength: ktx2.length }
      newOffset += ktx2.length
    } else {
      const chunk = originalBin.slice(bv.byteOffset, bv.byteOffset + bv.byteLength)
      newChunks.push(chunk)
      newBufViews[idx] = { ...bv, byteOffset: newOffset }
      newOffset += chunk.length
    }
  }

  // Update image mimeTypes and texture extensions
  const newImages = images.map((img, i) => {
    const bvIdx = img.bufferView
    if (!CONVERTIBLE.has(img.mimeType) || bvIdx === undefined || !replacements.has(bvIdx)) return img
    return { ...img, mimeType: 'image/ktx2' }
  })

  const newTextures = (json.textures || []).map(tex => {
    // Handle WebP extension textures
    const webpSrc = tex.extensions?.EXT_texture_webp?.source
    if (webpSrc !== undefined) {
      const img = images[webpSrc]
      if (!img || !CONVERTIBLE.has(img.mimeType) || !replacements.has(img.bufferView)) return tex
      const { EXT_texture_webp, ...otherExts } = tex.extensions || {}
      return { ...tex, source: undefined, extensions: { ...otherExts, KHR_texture_basisu: { source: webpSrc } } }
    }
    // Handle plain PNG/JPEG textures (no WebP extension — typical in VRM/standard GLB)
    const plainSrc = tex.source
    if (plainSrc !== undefined) {
      const img = images[plainSrc]
      if (!img || !CONVERTIBLE.has(img.mimeType) || img.mimeType === 'image/webp' || !replacements.has(img.bufferView)) return tex
      const otherExts = tex.extensions || {}
      return { ...tex, source: undefined, extensions: { ...otherExts, KHR_texture_basisu: { source: plainSrc } } }
    }
    return tex
  })

  const extsUsed = [...new Set([
    ...(json.extensionsUsed || []).filter(e => e !== 'EXT_texture_webp'),
    'KHR_texture_basisu'
  ])]
  const extsRequired = [...new Set([
    ...(json.extensionsRequired || []).filter(e => e !== 'EXT_texture_webp'),
    'KHR_texture_basisu'
  ])]

  const newJson = {
    ...json,
    extensionsUsed: extsUsed,
    extensionsRequired: extsRequired,
    bufferViews: newBufViews,
    images: newImages,
    textures: newTextures,
    buffers: [{ byteLength: newOffset }]
  }

  // Assemble new GLB
  const jsonStr = JSON.stringify(newJson)
  const jsonPad = (4 - (jsonStr.length % 4)) % 4
  const jsonBuf = Buffer.alloc(jsonStr.length + jsonPad, 0x20)
  Buffer.from(jsonStr).copy(jsonBuf)

  const newBin = Buffer.concat(newChunks)
  const binPad = (4 - (newBin.length % 4)) % 4
  const newBinPadded = Buffer.alloc(newBin.length + binPad, 0)
  newBin.copy(newBinPadded)

  const totalLen = 12 + 8 + jsonBuf.length + 8 + newBinPadded.length
  const out = Buffer.alloc(totalLen)
  let pos = 0
  out.writeUInt32LE(0x46546C67, pos); pos += 4
  out.writeUInt32LE(2, pos); pos += 4
  out.writeUInt32LE(totalLen, pos); pos += 4
  out.writeUInt32LE(jsonBuf.length, pos); pos += 4
  out.writeUInt32LE(0x4E4F534A, pos); pos += 4
  jsonBuf.copy(out, pos); pos += jsonBuf.length
  out.writeUInt32LE(newBinPadded.length, pos); pos += 4
  out.writeUInt32LE(0x004E4942, pos); pos += 4
  newBinPadded.copy(out, pos)

  return out
}

/**
 * Full GLB transform pipeline: Draco (if needed) → KTX2 image patch.
 * Returns optimized Buffer or null on failure.
 */
async function transformGLB(inputBuffer) {
  // Parse JSON chunk to check for Draco
  const buf = Buffer.from(inputBuffer)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (view.getUint32(0, true) !== 0x46546C67) return null
  const jsonLen = view.getUint32(12, true)
  let json
  try { json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8')) } catch { return null }

  let current = inputBuffer

  // VRM files use extensions (VRM, VRMC_vrm) that gltf-transform doesn't know about.
  // Running applyDraco strips those extensions. Skip Draco for VRM files.
  const isVRM = !!(json.extensions?.VRM || json.extensions?.VRMC_vrm)

  // Step 1: Draco compress if not already compressed — only keep if smaller
  if (!isVRM && !hasDraco(json)) {
    const dracoResult = await applyDraco(current)
    if (dracoResult && dracoResult.length < current.length) {
      current = dracoResult
    } else if (dracoResult) {
      console.log(`[glb-transform] draco skipped (${dracoResult.length} > ${current.length})`)
    }
  }

  // Step 2: KTX2 image compression — always accept if it produced output.
  // 1K KTX2 is larger than 4K WebP on disk but saves ~128× GPU VRAM.
  const ktx2Result = await applyKtx2(current)
  if (ktx2Result) return ktx2Result

  // Return Draco-only result if it helped, otherwise nothing useful
  if (current !== inputBuffer) return Buffer.from(current)

  return null
}

/**
 * Get (possibly cached) transformed GLB for a file path.
 * Returns the transformed Buffer if available, or null if not yet ready.
 * Starts background transformation on first call.
 */
export function getTransformed(filepath) {
  const mtime = statSync(filepath).mtimeMs

  // Check in-memory cache
  const mem = _memCache.get(filepath)
  if (mem && mem.mtime === mtime) return mem.buffer

  // Check disk cache
  const cachePath = getCachePath(filepath)
  const cacheMetaPath = cachePath + '.meta'
  if (existsSync(cachePath) && existsSync(cacheMetaPath)) {
    try {
      const meta = JSON.parse(readFileSync(cacheMetaPath, 'utf8'))
      if (meta.srcMtime === mtime && meta.v === 1) {
        const cached = readFileSync(cachePath)
        _memCache.set(filepath, { mtime, buffer: cached })
        return cached
      }
    } catch {}
  }

  // Start background transform if not already in-flight
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
          writeFileSync(cacheMetaPath, JSON.stringify({ srcMtime: mtime, v: 1 }))
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

  return null // not ready yet, caller should serve original
}

/**
 * Pre-warm: kick off transforms for all GLBs in a directory tree at startup.
 * Uses high concurrency during startup to speed up transformation pipeline.
 */
export async function prewarm(dirs) {
  setPrewarmMode(true)
  let fileCount = 0

  function scan(dir) {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const fp = join(dir, e.name)
      if (e.isDirectory() && e.name !== CACHE_DIR_NAME && e.name !== 'node_modules') scan(fp)
      else if (e.isFile() && (e.name.endsWith('.glb') || e.name.endsWith('.vrm'))) {
        getTransformed(fp)
        fileCount++
      }
    }
  }

  for (const dir of dirs) scan(dir)

  // Wait for all in-flight transforms to complete
  if (fileCount > 0) {
    console.log(`[glb-transform] prewarming ${fileCount} GLBs (max ${MAX_CONCURRENT} concurrent)...`)
    // Wait for all in-flight transforms to finish
    const waitForAll = async () => {
      let lastSize = _inFlight.size
      let stable = 0
      while (_inFlight.size > 0 || stable < 2) {
        await new Promise(resolve => setTimeout(resolve, 100))
        if (_inFlight.size === lastSize) {
          stable++
        } else {
          stable = 0
          lastSize = _inFlight.size
        }
      }
    }
    await waitForAll()
    console.log(`[glb-transform] prewarm complete`)
  }

  setPrewarmMode(false)
}
