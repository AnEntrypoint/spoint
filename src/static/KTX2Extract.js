// Extracts standalone, independently HTTP-addressable .ktx2 files from an already KTX2-baked GLB
// (GLBTransformer/GLBKtx2's applyKtx2 embeds transcoded KTX2 images directly in the GLB binary chunk,
// which has no per-texture URL -- fine for a whole-file GLTFLoader fetch, but unusable for a client
// that wants to range-request just the low-res mip of ONE texture before the rest of the model has
// even started downloading). This module walks the GLB's own JSON chunk (same manual glTF-binary
// parse GLBKtx2.applyKtx2 already does -- gltf-transform/three's own loaders assume a `fetch`-able
// buffer, not a raw Buffer+manual chunk walk, so hand-parsing here avoids a heavy dependency for a
// handful of uint32 reads), finds every image whose bufferView holds real image/ktx2 bytes (post
// applyKtx2, referenced via KHR_texture_basisu), and slices each one out as its own Buffer -- a real
// standalone KTX2 file (12-byte identifier + 17-uint32 header + level index + DFD + KVD + level data),
// byte-identical to what basisu/toktx would have written standalone, since applyKtx2 already wrote a
// complete valid KTX2 container into that bufferView (see GLBKtx2.imageToKtx2 -> `ktx create`).
//
// Cached by (srcPath mtime) alongside the existing .glb-cache directory GLBTransformer already
// maintains, so extraction only re-runs when the source model changes, matching the house
// getTransformed/getProgressive caching convention.

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

// Manual glTF-binary chunk walk -- same shape as GLBKtx2.applyKtx2's own parse, kept independent
// (not imported from there) since this reads the ALREADY-TRANSFORMED buffer (post applyKtx2, whose
// own json shape -- KHR_texture_basisu, re-packed bufferViews -- differs from the pre-transform input
// applyKtx2 itself parses) rather than the original source GLB.
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

// Returns [{ imageIndex, buf }] -- one real standalone KTX2 Buffer per image/ktx2 image in the GLB.
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
    // sanity: real KTX2 12-byte identifier (0xAB 'KTX' 20 0xBB 0x0D 0x0A 0x1A 0x0A)
    if (ktx2Buf.length < 12 || ktx2Buf[0] !== 0xAB || ktx2Buf[1] !== 0x4B) continue
    out.push({ imageIndex: i, buf: ktx2Buf })
  }
  return out
}

const _inFlight = new Map()
const _ready = new Map() // srcPath -> { mtime, dir, indices:number[] }

// Synchronous + non-blocking, matching getProgressive's contract: returns the ready cache dir + which
// image indices actually extracted, or null while extraction is still running / GLB has no KTX2 images.
export function getKtx2Extracted(srcPath) {
  let mtime
  try { mtime = statSync(srcPath).mtimeMs } catch { return null }
  const ready = _ready.get(srcPath)
  if (ready && ready.mtime === mtime) return ready

  if (_inFlight.has(srcPath)) return null
  const promise = (async () => {
    try {
      // getTransformed is itself synchronous-return-null-while-baking; poll via its own in-flight
      // promise pattern isn't exposed, so drive it the same way StaticHandler's callers do: call it,
      // and if it returns null (still baking / no source), skip this pass -- the next request retries.
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
