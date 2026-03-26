import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const _ktxCandidates = [
  join(__dirname, '../../bin/ktx.exe'),
  join(__dirname, '../../bin/ktx'),
  '/usr/bin/ktx',
  '/usr/local/bin/ktx',
]
export const KTX_BIN = _ktxCandidates.find(p => existsSync(p)) || _ktxCandidates[0]
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
  let downscaled = null
  try { downscaled = await sharp(imageBuffer).resize(256, 256, { fit: 'inside', withoutEnlargement: true }).png().toBuffer() } catch { }
  if (!existsSync(KTX_BIN)) return downscaled ? { buf: downscaled, mimeType: 'image/png' } : null
  const tmp = join(tmpdir(), `${tmpBase}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const pngPath = tmp + '.png', ktxPath = tmp + '.ktx2'
  try {
    if (downscaled) await sharp(downscaled).toFile(pngPath)
    else await sharp(imageBuffer).resize(256, 256, { fit: 'inside', withoutEnlargement: true }).png().toFile(pngPath)
    const result = spawnSync(KTX_BIN, ['create', '--format', 'R8G8B8A8_SRGB', '--encode', mode, '--generate-mipmap', pngPath, ktxPath], { timeout: 30000, windowsHide: true })
    if (result.status !== 0 || !existsSync(ktxPath)) return downscaled ? { buf: downscaled, mimeType: 'image/png' } : null
    return { buf: readFileSync(ktxPath), mimeType: 'image/ktx2' }
  } catch { return downscaled ? { buf: downscaled, mimeType: 'image/png' } : null
  } finally {
    try { if (existsSync(pngPath)) unlinkSync(pngPath) } catch {}
    try { if (existsSync(ktxPath)) unlinkSync(ktxPath) } catch {}
  }
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
  const replacements = new Map()
  for (let i = 0; i < images.length; i++) {
    const img = images[i]; if (!CONVERTIBLE.has(img.mimeType)) continue
    const bvIdx = img.bufferView; if (bvIdx === undefined) continue
    const bv = bufferViews[bvIdx]; if (!bv) continue
    const result = await imageToKtx2(originalBin.slice(bv.byteOffset, bv.byteOffset + bv.byteLength), encodeMode(imageSlotHints.get(i)), `img${i}`)
    if (result) replacements.set(bvIdx, result)
  }
  if (replacements.size === 0) return null
  const hasKtx2 = [...replacements.values()].some(r => r.mimeType === 'image/ktx2')
  const sortedIdxs = Array.from({ length: bufferViews.length }, (_, i) => i).sort((a, b) => (bufferViews[a].byteOffset || 0) - (bufferViews[b].byteOffset || 0))
  const newBufViews = bufferViews.map(bv => ({ ...bv })); const newChunks = []; let newOffset = 0
  for (const idx of sortedIdxs) {
    const bv = bufferViews[idx]; const pad = (4 - (newOffset % 4)) % 4
    if (pad > 0) { newChunks.push(Buffer.alloc(pad, 0)); newOffset += pad }
    if (replacements.has(idx)) {
      const { buf: rb } = replacements.get(idx); newChunks.push(rb)
      newBufViews[idx] = { ...bv, byteOffset: newOffset, byteLength: rb.length }; newOffset += rb.length
    } else {
      const chunk = originalBin.slice(bv.byteOffset, bv.byteOffset + bv.byteLength)
      newChunks.push(chunk); newBufViews[idx] = { ...bv, byteOffset: newOffset }; newOffset += chunk.length
    }
  }
  const newImages = images.map((img, i) => {
    const bvIdx = img.bufferView
    if (!CONVERTIBLE.has(img.mimeType) || bvIdx === undefined || !replacements.has(bvIdx)) return img
    return { ...img, mimeType: replacements.get(bvIdx).mimeType }
  })
  const newTextures = (json.textures || []).map(tex => {
    if (!hasKtx2) return tex
    const webpSrc = tex.extensions?.EXT_texture_webp?.source
    if (webpSrc !== undefined) {
      const img = images[webpSrc]
      if (!img || !CONVERTIBLE.has(img.mimeType) || !replacements.has(img.bufferView) || replacements.get(img.bufferView).mimeType !== 'image/ktx2') return tex
      const { EXT_texture_webp, ...otherExts } = tex.extensions || {}
      return { ...tex, source: undefined, extensions: { ...otherExts, KHR_texture_basisu: { source: webpSrc } } }
    }
    const plainSrc = tex.source
    if (plainSrc !== undefined) {
      const img = images[plainSrc]
      if (!img || !CONVERTIBLE.has(img.mimeType) || img.mimeType === 'image/webp' || !replacements.has(img.bufferView) || replacements.get(img.bufferView).mimeType !== 'image/ktx2') return tex
      return { ...tex, source: undefined, extensions: { ...(tex.extensions || {}), KHR_texture_basisu: { source: plainSrc } } }
    }
    return tex
  })
  const extsUsed = hasKtx2 ? [...new Set([...(json.extensionsUsed || []).filter(e => e !== 'EXT_texture_webp'), 'KHR_texture_basisu'])] : (json.extensionsUsed || []).filter(e => e !== 'EXT_texture_webp')
  const extsRequired = hasKtx2 ? [...new Set([...(json.extensionsRequired || []).filter(e => e !== 'EXT_texture_webp'), 'KHR_texture_basisu'])] : (json.extensionsRequired || []).filter(e => e !== 'EXT_texture_webp')
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
