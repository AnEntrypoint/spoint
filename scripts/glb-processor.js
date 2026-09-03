#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createRequire } from 'node:module'
import sharp from 'sharp'
import { NodeIO } from '@gltf-transform/core'
import { KHRDracoMeshCompression, EXTTextureWebP } from '@gltf-transform/extensions'
import { applyKtx2 } from '../src/static/GLBKtx2.js'

const require = createRequire(import.meta.url)

export const MAX_TEX = 256
const CONVERTIBLE = new Set(['image/webp', 'image/png', 'image/jpeg'])

let _io = null
async function getIO() {
  if (!_io) {
    const draco3d = require('draco3d')
    const [decoderModule, encoderModule] = await Promise.all([
      draco3d.createDecoderModule(),
      draco3d.createEncoderModule()
    ])
    _io = new NodeIO()
      .registerExtensions([KHRDracoMeshCompression, EXTTextureWebP])
      .registerDependencies({ 'draco3d.decoder': decoderModule, 'draco3d.encoder': encoderModule })
  }
  return _io
}

export function detectDraco(buf) {
  try {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    if (view.getUint32(0, true) !== 0x46546C67) return false
    const jsonLen = view.getUint32(12, true)
    const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'))
    return (json.extensionsUsed || []).includes('KHR_draco_mesh_compression')
  } catch { return false }
}

// Patch textures missing source so gltf-transform doesn't crash on EXT_texture_webp-only textures
function patchTextureSources(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const jsonLen = view.getUint32(12, true)
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'))
  let changed = false
  for (const tex of json.textures || []) {
    if (tex.source === undefined) { tex.source = 0; changed = true }
  }
  if (!changed) return buf
  const pjStr = JSON.stringify(json)
  const pjPad = (4 - (pjStr.length % 4)) % 4
  const pjBuf = Buffer.alloc(pjStr.length + pjPad, 0x20)
  Buffer.from(pjStr).copy(pjBuf)
  const binStart = 20 + jsonLen + 8
  const binLen = view.getUint32(20 + jsonLen, true)
  const binBuf = buf.slice(binStart, binStart + binLen)
  const tl = 12 + 8 + pjBuf.length + 8 + binBuf.length
  const out = Buffer.alloc(tl)
  let p = 0
  out.writeUInt32LE(0x46546C67, p); p+=4
  out.writeUInt32LE(2, p); p+=4
  out.writeUInt32LE(tl, p); p+=4
  out.writeUInt32LE(pjBuf.length, p); p+=4
  out.writeUInt32LE(0x4E4F534A, p); p+=4
  pjBuf.copy(out, p); p+=pjBuf.length
  out.writeUInt32LE(binBuf.length, p); p+=4
  out.writeUInt32LE(0x004E4942, p); p+=4
  binBuf.copy(out, p)
  return out
}

// Exported for scripts/prep-edge-collider-assets.mjs (edge-cf-draco-glb-collider-not-yet-edge-safe):
// a real build-time-only Draco->plain re-encode, isolated from processGLB's texture-downscale
// concerns so an edge/DO asset-prep pass can strip JUST the Draco extension without also touching
// texture size/format (that stays optimize-models.js's job for the gh-pages static-asset path).
export async function stripDraco(buf) {
  const io = await getIO()
  const patched = patchTextureSources(buf)
  const doc = await io.readBinary(new Uint8Array(patched))
  doc.getRoot().listExtensionsUsed()
    .filter(e => e.extensionName === 'KHR_draco_mesh_compression')
    .forEach(e => e.dispose())
  return Buffer.from(await io.writeBinary(doc))
}

export async function processGLB(inputBuf) {
  let buf = Buffer.from(inputBuf)
  const view0 = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (view0.getUint32(0, true) !== 0x46546C67) return null

  const hasDraco = detectDraco(buf)

  // Strip Draco first — must happen before texture rewrite since bufferView indices change
  if (hasDraco) buf = await stripDraco(buf)

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const jsonLen = view.getUint32(12, true)
  let json
  try { json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8')) } catch { return null }

  const binChunkOffset = 20 + jsonLen
  if (buf.length <= binChunkOffset + 8) return null
  const binLen = view.getUint32(binChunkOffset, true)
  const binStart = binChunkOffset + 8
  const originalBin = buf.slice(binStart, binStart + binLen)

  const images = json.images || []
  const bufferViews = json.bufferViews || []

  const replacements = new Map()
  for (let i = 0; i < images.length; i++) {
    const img = images[i]
    if (!CONVERTIBLE.has(img.mimeType)) continue
    const bvIdx = img.bufferView
    if (bvIdx === undefined) continue
    const bv = bufferViews[bvIdx]
    if (!bv) continue
    const imgBytes = originalBin.slice(bv.byteOffset, bv.byteOffset + bv.byteLength)
    try {
      const meta = await sharp(imgBytes).metadata()
      if ((meta.width || 0) <= MAX_TEX && (meta.height || 0) <= MAX_TEX) continue
      const downscaled = await sharp(imgBytes)
        .resize(MAX_TEX, MAX_TEX, { fit: 'inside', withoutEnlargement: true })
        .png().toBuffer()
      replacements.set(bvIdx, downscaled)
    } catch { }
  }

  const needsTextureFix = (json.textures || []).some(t => t.extensions?.EXT_texture_webp?.source !== undefined || t.source === undefined)
  // Enforcement gate (ktx2-basis-enforcement-glb-processor): a GLB carrying ANY convertible image
  // (webp/png/jpeg) must always reach the applyKtx2() bake below, even when neither a texture
  // downscale nor a webp/missing-source fix nor a Draco strip was needed -- the previous early
  // returns here (`replacements.size===0 && !needsTextureFix` with no draco -> null, i.e. "already
  // optimized, skip entirely") silently bypassed KTX2/BASIS compression for the common case of a
  // GLB whose only outstanding work IS the KTX2 bake, live-reproduced with a synthetic minimal GLB
  // (64x64 PNG, valid source, no draco): processGLB returned null, meaning optimize-models.js (the
  // offline dist bake this script drives) would ship that GLB with zero KTX2/BASIS compression even
  // though the live-serve path (GLBTransformer.transformGLB) unconditionally calls the same
  // applyKtx2 and would have compressed it. hasConvertibleImage below is genuinely independent of
  // hasDraco/needsTextureFix/replacements so this only widens the enforcement gate, never narrows
  // any existing behavior.
  const hasConvertibleImage = images.some(img => CONVERTIBLE.has(img.mimeType))
  if (replacements.size === 0 && !needsTextureFix && !hasDraco && !hasConvertibleImage) return null

  const sortedIdxs = Array.from({ length: bufferViews.length }, (_, i) => i)
    .sort((a, b) => (bufferViews[a].byteOffset || 0) - (bufferViews[b].byteOffset || 0))

  const newBufViews = bufferViews.map(bv => ({ ...bv }))
  const newChunks = []
  let newOffset = 0

  for (const idx of sortedIdxs) {
    const bv = bufferViews[idx]
    const pad = (4 - (newOffset % 4)) % 4
    if (pad > 0) { newChunks.push(Buffer.alloc(pad, 0)); newOffset += pad }
    if (replacements.has(idx)) {
      const rbuf = replacements.get(idx)
      newChunks.push(rbuf)
      newBufViews[idx] = { ...bv, byteOffset: newOffset, byteLength: rbuf.length }
      newOffset += rbuf.length
    } else {
      const chunk = originalBin.slice(bv.byteOffset, bv.byteOffset + bv.byteLength)
      newChunks.push(chunk)
      newBufViews[idx] = { ...bv, byteOffset: newOffset }
      newOffset += chunk.length
    }
  }

  const newImages = images.map(img => {
    const bvIdx = img.bufferView
    if (!CONVERTIBLE.has(img.mimeType) || bvIdx === undefined || !replacements.has(bvIdx)) return img
    return { ...img, mimeType: 'image/png' }
  })

  const newTextures = (json.textures || []).map(tex => {
    const webpSrc = tex.extensions?.EXT_texture_webp?.source
    if (webpSrc !== undefined) {
      const { EXT_texture_webp, ...otherExts } = tex.extensions || {}
      const remainingExts = Object.keys(otherExts).length ? otherExts : undefined
      return { ...tex, source: webpSrc, extensions: remainingExts }
    }
    if (tex.source === undefined) return { ...tex, source: 0, extensions: undefined }
    return tex
  })

  const extsUsed = (json.extensionsUsed || []).filter(e => e !== 'EXT_texture_webp')
  const extsRequired = (json.extensionsRequired || []).filter(e => e !== 'EXT_texture_webp')

  const newJson = { ...json, extensionsUsed: extsUsed, extensionsRequired: extsRequired, bufferViews: newBufViews, images: newImages, textures: newTextures, buffers: [{ byteLength: newOffset }] }

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
  try {
    const r = await applyKtx2(out)
    if (r) return r
  } catch (e) {
    // Not silently swallowed: applyKtx2 itself already falls back to plain-PNG per-image on any
    // ktx-binary-unavailable/encode failure (imageToKtx2's own try/catch, see GLBKtx2.js), so a
    // throw HERE means something upstream of that per-image fallback broke (a JSON/bufferView
    // repack bug, not a missing `ktx` binary) -- worth a visible warning so CI doesn't quietly ship
    // an unenforced GLB.
    console.warn('[glb-processor] applyKtx2 failed, shipping without KTX2/BASIS:', e.message)
  }
  return out
}