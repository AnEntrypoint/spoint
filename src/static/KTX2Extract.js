import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { getTransformed } from './GLBTransformer.js'
import { KTX2_EXTRACT_CODE_VERSION } from './BakeCodeVersion.js'

const CACHE_DIR_NAME = '.ktx2-cache'

function _cacheDir(srcPath) {
  const dir = join(dirname(srcPath), CACHE_DIR_NAME, basename(srcPath, '.glb'))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function _parseGlbJsonAndBin(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (buf.length < 20 || view.getUint32(0, true) !== 0x46546C67) return null
  const jsonLen = view.getUint32(12, true)
  let json
  try { json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8')) } catch { return null }
  const binChunkOffset = 20 + jsonLen
  if (buf.length <= binChunkOffset + 8) return { json, bin: null }
  const binLen = view.getUint32(binChunkOffset, true)
  const binStart = binChunkOffset + 8
  const bin = buf.slice(binStart, binStart + binLen)
  return { json, bin }
}

export function extractKtx2Images(transformedGlbBuf) {
  const parsed = _parseGlbJsonAndBin(Buffer.from(transformedGlbBuf))
  if (!parsed || !parsed.bin) return []
  const { json, bin } = parsed
  const images = json.images || []
  const bufferViews = json.bufferViews || []
  const out = []
  for (let i = 0; i < images.length; i++) {
    const img = images[i]
    if (img.mimeType !== 'image/ktx2') continue
    const bvIdx = img.bufferView
    if (bvIdx === undefined) continue
    const bv = bufferViews[bvIdx]
    if (!bv) continue
    const ktx2Buf = bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength)
    const lacksKtx2Identifier = ktx2Buf.length < 12 || ktx2Buf[0] !== 0xAB || ktx2Buf[1] !== 0x4B
    if (lacksKtx2Identifier) continue
    out.push({ imageIndex: i, buf: ktx2Buf })
  }
  return out
}

const _inFlight = new Map()
const _ready = new Map()

export function getKtx2Extracted(srcPath) {
  let mtime
  try { mtime = statSync(srcPath).mtimeMs } catch { return null }
  const ready = _ready.get(srcPath)
  if (ready && ready.mtime === mtime) return ready

  if (_inFlight.has(srcPath)) return null
  const promise = (async () => {
    try {
      const transformed = getTransformed(srcPath)
      if (!transformed) return
      const dir = _cacheDir(srcPath)
      const metaPath = join(dir, 'meta.json')
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
          if (meta.srcMtime === mtime && meta.codeVersion === KTX2_EXTRACT_CODE_VERSION) {
            _ready.set(srcPath, { mtime, dir, indices: meta.indices }); return
          }
        } catch {}
      }
      const extracted = extractKtx2Images(transformed)
      const indices = []
      for (const { imageIndex, buf } of extracted) {
        writeFileSync(join(dir, `${imageIndex}.ktx2`), buf)
        indices.push(imageIndex)
      }
      writeFileSync(metaPath, JSON.stringify({ srcMtime: mtime, codeVersion: KTX2_EXTRACT_CODE_VERSION, indices }))
      _ready.set(srcPath, { mtime, dir, indices })
    } catch (e) {
      console.warn(`[ktx2-extract] failed ${basename(srcPath)}: ${e.message}`)
    } finally {
      _inFlight.delete(srcPath)
    }
  })()
  _inFlight.set(srcPath, promise)
  return null
}

export function resolveKtx2File(srcPath, imageIndex) {
  const ready = getKtx2Extracted(srcPath)
  if (!ready) return null
  const idx = Number(imageIndex)
  if (!Number.isInteger(idx) || !ready.indices.includes(idx)) return null
  const fp = join(ready.dir, `${idx}.ktx2`)
  return existsSync(fp) ? fp : null
}
