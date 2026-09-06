import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

// sharp is optionalDependencies (heavy native build) -- a plain `npm install` may not have it.
// Lazy + cached so a missing sharp only disables KTX2/texture-downscale bake (imageToKtx2 below
// already returns null on any resize failure, which its own caller treats as "skip this image"),
// never a hard crash of the whole GLB-transform/static-handler pipeline at import time.
let _sharpPromise = null
function _loadSharp() {
  if (!_sharpPromise) _sharpPromise = import('sharp').then(m => m.default || m).catch(() => null)
  return _sharpPromise
}

const __dirname = dirname(fileURLToPath(import.meta.url))
// Platform-filtered: the repo ships bin/ktx.exe (a Windows PE binary). On Linux/macOS existsSync()
// found it, imageToKtx2 treated the encoder as available, spawnSync failed, and every image fell
// through to the PNG fallback -- the mechanism behind every map GLB inflating 2-3x on a Linux deploy.
const _ktxCandidates = process.platform === 'win32'
  ? [join(__dirname, '../../bin/ktx.exe')]
  : [join(__dirname, '../../bin/ktx'), '/usr/bin/ktx', '/usr/local/bin/ktx']
export const KTX_BIN = _ktxCandidates.find(p => existsSync(p)) || _ktxCandidates[0]
let _ktxRunnable = null
// True only when the resolved binary exists AND actually runs here (probed once per process).
export function ktxAvailable() {
  if (_ktxRunnable !== null) return _ktxRunnable
  if (!existsSync(KTX_BIN)) return (_ktxRunnable = false)
  try { const r = spawnSync(KTX_BIN, ['--version'], { timeout: 10000, windowsHide: true }); _ktxRunnable = r.status === 0 } catch { _ktxRunnable = false }
  return _ktxRunnable
}
export const CONVERTIBLE = new Set(['image/webp', 'image/png', 'image/jpeg'])

export function encodeMode(slotName) {
  return slotName === 'normal' ? 'uastc' : 'basis-lz'
}

export function sanitizeJson(json) {
  for (const tex of json.textures || []) {
    const hasWebP = tex.extensions?.EXT_texture_webp?.source !== undefined
    if (!hasWebP && tex.source === undefined && json.images?.length > 0) tex.source = 0
  }
}

export async function imageToKtx2(imageBuffer, mode = 'basis-lz', tmpBase = 'tex') {
  let pngBuf = null
  const sharp = await _loadSharp()
  const haveKtx = ktxAvailable()
  if (sharp) {
    try {
      const img = sharp(imageBuffer)
      if (!haveKtx) {
        // No ktx CLI (the common deploy case): the only transform left is the 256px downscale. An
        // image already within that box needs no re-encode at all -- returning null keeps the
        // source bytes (its own webp/jpeg/png, same pixels the client would get from a re-encode).
        // Root-caused live: every map GLB inflated +63..+188% because this fallback re-emitted 45
        // downscaled images as PNG (2.69 MB) in place of 156 KB of webp.
        const meta = await img.metadata()
        if (meta.width && meta.height && meta.width <= 256 && meta.height <= 256) return null
        // Downscale needed. For a webp source (its texture already declares EXT_texture_webp) lossless
        // WebP carries the identical downscaled pixels PNG would, at a fraction of the bytes; png/jpeg
        // sources keep the PNG fallback below so their plain `source` reference stays spec-valid.
        if (meta.format === 'webp') {
          const webpBuf = await img.resize(256, 256, { fit: 'inside', withoutEnlargement: true }).webp({ lossless: true, effort: 4 }).toBuffer()
          return { buf: webpBuf, mimeType: 'image/webp' }
        }
      }
      pngBuf = await img.resize(256, 256, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()
    } catch { }
  }
  if (!pngBuf) return null
  const base = join(tmpdir(), `${tmpBase}_${Date.now()}`)
  const inFile = `${base}.png`, outFile = `${base}.ktx2`
  const { writeFileSync } = await import('node:fs')
  try {
    writeFileSync(inFile, pngBuf)
    // Real `ktx create --encode` (libktx CLI v4.x) only accepts 'basis-lz' or 'uastc' -- 'etc1s' is NOT
    // a valid --encode value (confirmed live: `ktx create --encode etc1s ...` -> "fatal: Invalid encode
    // codec: 'etc1s'", exit 1, no output file -- this silently made EVERY call fall through to the
    // plain-PNG fallback below, so no KTX2 texture was ever actually produced by this pipeline despite
    // encodeMode() already correctly choosing 'basis-lz'/'uastc' as the MODE; the bug was only in this
    // enc-to-CLI-flag mapping). 'basis-lz' is the correct CLI value for encodeMode()'s 'basis-lz' mode
    // (ETC1S/BasisLZ supercompression), matching the mode value's own name instead of a stale synonym.
    const enc = mode === 'uastc' ? 'uastc' : 'basis-lz'
    // Real `ktx create` usage is `ktx create [OPTION...] <input-file...> <output-file>` -- input(s)
    // BEFORE the single output file, confirmed via `ktx create --help`'s own usage line. The previous
    // [outFile, inFile] order was backwards: v4.4.2 reported "Open of <outFile> failed. No such file or
    // directory" (status 4) because it tried to OPEN the (nonexistent, meant-to-be-created) first
    // positional arg as an input image -- so this also silently produced zero real KTX2 output on every
    // call, on top of the --encode etc1s bug above. Fixed order verified live: status 0, real valid
    // KTX2 identifier bytes in a genuinely-created output file.
    // --generate-mipmap builds a real mip chain (level 0 = full-res, descending to 1x1) instead of the
    // single-level output every prior call silently produced -- a KTX2 file with only levelCount=1 has
    // nothing for a progressive mip-streaming client (client/core/ProgressiveKTX2.js) to progressively
    // fetch: the entire "fetch coarsest mip first, upgrade to sharper ones over time" premise requires
    // a real multi-level container. Confirmed live via parseKtx2Header on a real ktx-cli-produced file:
    // a 64x64 test image produces levelCount=7 (64->1px, standard full mip chain) with --generate-mipmap
    // vs levelCount=1 without it.
    // windowsHide: true -- without it, every ktx.exe invocation pops a visible console window on
    // Windows (a console subprocess with no window of its own still gets one from the OS unless
    // explicitly suppressed). prewarmProgressive can invoke this once per texture across many
    // models on server boot; live-witnessed thousands of flashing windows making the machine
    // unusable for minutes when boot (and its prewarm pass) ran repeatedly in quick succession.
    const r = spawnSync(KTX_BIN, ['create', '--format', 'R8G8B8A8_UNORM', '--encode', enc, '--generate-mipmap', inFile, outFile], { timeout: 30000, windowsHide: true })
    if (r.status === 0 && existsSync(outFile)) {
      const ktx2Buf = readFileSync(outFile)
      return { buf: ktx2Buf, mimeType: 'image/ktx2' }
    }
  } catch { } finally {
    try { unlinkSync(inFile) } catch { }
    try { unlinkSync(outFile) } catch { }
  }
  return { buf: pngBuf, mimeType: 'image/png' }
}

export async function applyKtx2(inputBuffer) {
  const buf = Buffer.from(inputBuffer)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (view.getUint32(0, true) !== 0x46546C67) return null
  const jsonLen = view.getUint32(12, true)
  let json; try { json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8')) } catch { return null }
  const binChunkOffset = 20 + jsonLen
  if (buf.length <= binChunkOffset + 8) return null
  const binStart = binChunkOffset + 8
  const originalBin = buf.slice(binStart, binStart + view.getUint32(binChunkOffset, true))
  sanitizeJson(json)
  const images = json.images || [], bufferViews = json.bufferViews || []
  const imageSlotHints = new Map()
  for (const mat of json.materials || []) {
    const slots = { normalTexture: 'normal', occlusionTexture: 'occlusion', emissiveTexture: 'emissive' }
    const pbrSlots = { baseColorTexture: 'baseColor', metallicRoughnessTexture: 'metallicRoughness' }
    const pbr = mat.pbrMetallicRoughness || {}
    for (const [key, hint] of Object.entries({ ...slots, ...pbrSlots })) {
      const src = (key in slots ? mat : pbr)[key]; const texIdx = src?.index; if (texIdx === undefined) continue
      const tex = json.textures?.[texIdx]; const imgIdx = tex?.extensions?.EXT_texture_webp?.source ?? tex?.source
      if (imgIdx !== undefined) imageSlotHints.set(imgIdx, hint)
    }
  }
  for (const mp of json.extensions?.VRM?.materialProperties || []) {
    const bumpIdx = mp.textureProperties?._BumpMap; if (bumpIdx === undefined) continue
    const tex = json.textures?.[bumpIdx]; const imgIdx = tex?.extensions?.EXT_texture_webp?.source ?? tex?.source
    if (imgIdx !== undefined) imageSlotHints.set(imgIdx, 'normal')
  }
  // A bufferView carrying EXT_meshopt_compression stores its REAL compressed-data location/length in
  // the extension object (ext.byteOffset/ext.byteLength) -- the outer bufferView.byteOffset/byteLength
  // are spec-mandated fallback values for viewers that don't understand the extension and are NOT where
  // the compressed bytes actually live (see khronos EXT_meshopt_compression spec: "the byteOffset and
  // byteLength properties of bufferView MUST be ignored" when this extension is present). This repack
  // loop must read/write through the extension's own offset/length for any such view, or it silently
  // copies the wrong byte range and corrupts every meshopt-compressed geometry buffer in the asset --
  // live-reproduced: 100% of aim_sillos.glb's 368 meshopt bufferViews failed MeshoptDecoder.decodeGltfBuffer
  // with "Malformed buffer data: -1" in the browser after this pass ran, root-caused to exactly this
  // outer-vs-extension byteOffset/byteLength mismatch (see cluster-merge-live-server-bake-confirmed-
  // browser-screenshot-gap PRD row / AGENTS.md).
  function _meshoptExt(bv) { return bv.extensions && bv.extensions.EXT_meshopt_compression }
  function _dataRange(bv) { const ext = _meshoptExt(bv); return ext ? { offset: ext.byteOffset || 0, length: ext.byteLength } : { offset: bv.byteOffset || 0, length: bv.byteLength } }

  const replacements = new Map()
  for (let i = 0; i < images.length; i++) {
    const img = images[i]; if (!CONVERTIBLE.has(img.mimeType)) continue
    const bvIdx = img.bufferView; if (bvIdx === undefined) continue
    const bv = bufferViews[bvIdx]; if (!bv) continue
    const { offset, length } = _dataRange(bv)
    const result = await imageToKtx2(originalBin.slice(offset, offset + length), encodeMode(imageSlotHints.get(i)), `img${i}`)
    if (result) replacements.set(bvIdx, result)
  }
  if (replacements.size === 0) return null
  const hasKtx2 = [...replacements.values()].some(r => r.mimeType === 'image/ktx2')
  const sortedIdxs = Array.from({ length: bufferViews.length }, (_, i) => i).sort((a, b) => _dataRange(bufferViews[a]).offset - _dataRange(bufferViews[b]).offset)
  const newBufViews = bufferViews.map(bv => ({ ...bv })); const newChunks = []; let newOffset = 0
  for (const idx of sortedIdxs) {
    const bv = bufferViews[idx]; const pad = (4 - (newOffset % 4)) % 4
    if (pad > 0) { newChunks.push(Buffer.alloc(pad, 0)); newOffset += pad }
    if (replacements.has(idx)) {
      const { buf: rb } = replacements.get(idx); newChunks.push(rb)
      newBufViews[idx] = { ...bv, byteOffset: newOffset, byteLength: rb.length }; newOffset += rb.length
    } else {
      const { offset, length } = _dataRange(bv)
      const chunk = originalBin.slice(offset, offset + length)
      newChunks.push(chunk)
      const ext = _meshoptExt(bv)
      if (ext) {
        // Real compressed data relocates to newOffset; the outer byteOffset/byteLength stay as
        // spec-fallback bookkeeping (left untouched -- no reader that understands the extension
        // consults them), only the extension's own offset moves. byteLength is unchanged (a raw
        // byte copy, not a re-encode).
        newBufViews[idx] = { ...bv, extensions: { ...bv.extensions, EXT_meshopt_compression: { ...ext, byteOffset: newOffset } } }
      } else {
        newBufViews[idx] = { ...bv, byteOffset: newOffset }
      }
      newOffset += chunk.length
    }
  }
  const newImages = images.map((img, i) => {
    const bvIdx = img.bufferView
    if (!CONVERTIBLE.has(img.mimeType) || bvIdx === undefined || !replacements.has(bvIdx)) return img
    return { ...img, mimeType: replacements.get(bvIdx).mimeType }
  })
  const newTextures = (json.textures || []).map(tex => {
    const webpSrc = tex.extensions?.EXT_texture_webp?.source
    if (webpSrc !== undefined) {
      // Image kept as webp (untouched small source, or the lossless-webp downscale): the texture's
      // existing EXT_texture_webp reference is still exactly right -- leave it alone.
      if (newImages[webpSrc] && newImages[webpSrc].mimeType === 'image/webp') return tex
      if (hasKtx2) {
        const img = images[webpSrc]
        if (img && CONVERTIBLE.has(img.mimeType) && replacements.has(img.bufferView) && replacements.get(img.bufferView).mimeType === 'image/ktx2') {
          const { EXT_texture_webp, ...otherExts } = tex.extensions || {}
          return { ...tex, source: undefined, extensions: { ...otherExts, KHR_texture_basisu: { source: webpSrc } } }
        }
      }
      const { EXT_texture_webp, ...otherExts } = tex.extensions || {}
      const remainingExts = Object.keys(otherExts).length ? otherExts : undefined
      return { ...tex, source: webpSrc, extensions: remainingExts }
    }
    if (hasKtx2) {
      const plainSrc = tex.source
      if (plainSrc !== undefined) {
        const img = images[plainSrc]
        if (img && CONVERTIBLE.has(img.mimeType) && img.mimeType !== 'image/webp' && replacements.has(img.bufferView) && replacements.get(img.bufferView).mimeType === 'image/ktx2') {
          return { ...tex, source: undefined, extensions: { ...(tex.extensions || {}), KHR_texture_basisu: { source: plainSrc } } }
        }
      }
    }
    if (tex.source === undefined) return { ...tex, source: 0, extensions: undefined }
    return tex
  })
  const webpRemains = newImages.some(img => img && img.mimeType === 'image/webp')
  const dropWebp = (list) => webpRemains ? list : list.filter(e => e !== 'EXT_texture_webp')
  const extsUsed = hasKtx2 ? [...new Set([...dropWebp(json.extensionsUsed || []), 'KHR_texture_basisu'])] : dropWebp(json.extensionsUsed || [])
  const extsRequired = hasKtx2 ? [...new Set([...dropWebp(json.extensionsRequired || []), 'KHR_texture_basisu'])] : dropWebp(json.extensionsRequired || [])
  const newJson = { ...json, extensionsUsed: extsUsed, extensionsRequired: extsRequired, bufferViews: newBufViews, images: newImages, textures: newTextures, buffers: [{ byteLength: newOffset }] }
  const jsonStr = JSON.stringify(newJson); const jsonPad = (4 - (jsonStr.length % 4)) % 4
  const jsonBuf = Buffer.alloc(jsonStr.length + jsonPad, 0x20); Buffer.from(jsonStr).copy(jsonBuf)
  const newBin = Buffer.concat(newChunks); const binPad = (4 - (newBin.length % 4)) % 4
  const newBinPadded = Buffer.alloc(newBin.length + binPad, 0); newBin.copy(newBinPadded)
  const totalLen = 12 + 8 + jsonBuf.length + 8 + newBinPadded.length
  const out = Buffer.alloc(totalLen); let pos = 0
  out.writeUInt32LE(0x46546C67, pos); pos += 4; out.writeUInt32LE(2, pos); pos += 4
  out.writeUInt32LE(totalLen, pos); pos += 4; out.writeUInt32LE(jsonBuf.length, pos); pos += 4
  out.writeUInt32LE(0x4E4F534A, pos); pos += 4; jsonBuf.copy(out, pos); pos += jsonBuf.length
  out.writeUInt32LE(newBinPadded.length, pos); pos += 4; out.writeUInt32LE(0x004E4942, pos); pos += 4
  newBinPadded.copy(out, pos)
  return out
}
