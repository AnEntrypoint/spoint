#!/usr/bin/env node
/**
 * optimize-models.js
 *
 * Build-time GPU memory optimizer for GLB/VRM files.
 * Downscales embedded textures larger than 1K using sharp.
 * Run during CI/CD before deploying to static hosting.
 *
 * Usage: node scripts/optimize-models.js <dir> [dir2 ...]
 *
 * Replaces files in-place with texture-downscaled versions.
 * Reduces GPU VRAM consumption proportionally to resolution reduction.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import sharp from 'sharp'

const MAX_TEX = 1024  // max texture edge length after downscale
const CONVERTIBLE = new Set(['image/webp', 'image/png', 'image/jpeg'])

async function processGLB(inputBuf) {
  const buf = Buffer.from(inputBuf)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (view.getUint32(0, true) !== 0x46546C67) return null

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

  // Downscale only images that exceed MAX_TEX
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

  if (replacements.size === 0) return null

  // Rebuild binary section with replaced image buffers
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

  // Update mimeTypes to png and strip WebP extension (textures now plain PNG)
  const newImages = images.map(img => {
    const bvIdx = img.bufferView
    if (!CONVERTIBLE.has(img.mimeType) || bvIdx === undefined || !replacements.has(bvIdx)) return img
    return { ...img, mimeType: 'image/png' }
  })

  const newTextures = (json.textures || []).map(tex => {
    const webpSrc = tex.extensions?.EXT_texture_webp?.source
    if (webpSrc === undefined) return tex
    const img = images[webpSrc]
    if (!img || !replacements.has(img.bufferView)) return tex
    const { EXT_texture_webp, ...otherExts } = tex.extensions || {}
    const remainingExts = Object.keys(otherExts).length ? otherExts : undefined
    return { ...tex, source: webpSrc, extensions: remainingExts }
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

  return out
}

async function optimizeDir(dir) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const fp = join(dir, e.name)
    if (e.isDirectory()) { await optimizeDir(fp); continue }
    if (!e.isFile() || (!e.name.endsWith('.glb') && !e.name.endsWith('.vrm'))) continue
    const original = readFileSync(fp)
    const t0 = Date.now()
    const optimized = await processGLB(original)
    if (optimized) {
      writeFileSync(fp, optimized)
      const savedKB = (original.length - optimized.length) / 1024
      console.log(`[optimize] ${basename(fp)}: ${(original.length/1024).toFixed(0)}KB → ${(optimized.length/1024).toFixed(0)}KB (${savedKB > 0 ? '-' : '+'}${Math.abs(savedKB).toFixed(0)}KB) in ${Date.now()-t0}ms`)
    } else {
      console.log(`[optimize] ${basename(fp)}: textures already ≤${MAX_TEX}px, skipped`)
    }
  }
}

async function optimizePath(p) {
  let stat
  try { stat = statSync(p) } catch { console.warn(`[optimize] not found: ${p}`); return }
  if (stat.isDirectory()) { await optimizeDir(p); return }
  if (!p.endsWith('.glb') && !p.endsWith('.vrm')) return
  const original = readFileSync(p)
  const t0 = Date.now()
  const optimized = await processGLB(original)
  if (optimized) {
    writeFileSync(p, optimized)
    const savedKB = (original.length - optimized.length) / 1024
    console.log(`[optimize] ${basename(p)}: ${(original.length/1024).toFixed(0)}KB → ${(optimized.length/1024).toFixed(0)}KB (${savedKB > 0 ? '-' : '+'}${Math.abs(savedKB).toFixed(0)}KB) in ${Date.now()-t0}ms`)
  } else {
    console.log(`[optimize] ${basename(p)}: textures already ≤${MAX_TEX}px, skipped`)
  }
}

const paths = process.argv.slice(2)
if (paths.length === 0) { console.error('Usage: node scripts/optimize-models.js <dir|file> [...]'); process.exit(1) }
console.log(`[optimize] GPU memory optimization: downscaling textures >${MAX_TEX}px...`)
for (const p of paths) await optimizePath(p)
console.log('[optimize] done')
