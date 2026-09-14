import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

let _sharpPromise = null
function _loadSharp() {
  if (!_sharpPromise) _sharpPromise = import('sharp').then(m => m.default || m).catch(() => null)
  return _sharpPromise
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const _ktxCandidates = process.platform === 'win32'
  ? [join(__dirname, '../../bin/ktx.exe')]
  : [join(__dirname, '../../bin/ktx'), '/usr/bin/ktx', '/usr/local/bin/ktx']
export const KTX_BIN = _ktxCandidates.find(p => existsSync(p)) || _ktxCandidates[0]
let _ktxRunnable = null
export function ktxAvailable() {
  if (_ktxRunnable !== null) return _ktxRunnable
  if (!existsSync(KTX_BIN)) return (_ktxRunnable = false)
  try { const r = spawnSync(KTX_BIN, ['--version'], { timeout: 10000, windowsHide: true }); _ktxRunnable = r.status === 0 } catch { _ktxRunnable = false }
  return _ktxRunnable
}
export const CONVERTIBLE = new Set(['image/webp', 'image/png', 'image/jpeg'])
const TEXTURE_DOWNSCALE_MAX_PX = 256

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
        const meta = await img.metadata()
        const fitsDownscaleBox = meta.width && meta.height && meta.width <= TEXTURE_DOWNSCALE_MAX_PX && meta.height <= TEXTURE_DOWNSCALE_MAX_PX
        if (fitsDownscaleBox) return null
        if (meta.format === 'webp') {
          const webpBuf = await img.resize(TEXTURE_DOWNSCALE_MAX_PX, TEXTURE_DOWNSCALE_MAX_PX, { fit: 'inside', withoutEnlargement: true }).webp({ lossless: true, effort: 4 }).toBuffer()
          return { buf: webpBuf, mimeType: 'image/webp' }
        }
      }
      pngBuf = await img.resize(TEXTURE_DOWNSCALE_MAX_PX, TEXTURE_DOWNSCALE_MAX_PX, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()
    } catch { }
  }
  if (!pngBuf) return null
  const base = join(tmpdir(), `${tmpBase}_${Date.now()}`)
  const inFile = `${base}.png`, outFile = `${base}.ktx2`
  const { writeFileSync } = await import('node:fs')
  try {
    writeFileSync(inFile, pngBuf)
    const enc = mode === 'uastc' ? 'uastc' : 'basis-lz'
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
