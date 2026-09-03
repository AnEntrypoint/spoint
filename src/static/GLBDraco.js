export function hasDraco(jsonChunk) {
  return (jsonChunk.extensionsUsed || []).includes('KHR_draco_mesh_compression')
}

export function hasMeshopt(jsonChunk) {
  return (jsonChunk.extensionsUsed || []).includes('EXT_meshopt_compression')
}

// Draco stays registered for DECODE only (a legacy import may still arrive
// Draco-compressed and needs stripDraco below to read it) -- this repo standardizes
// all NEW/re-encoded output on meshopt (see compressMeshopt), Draco is never
// applied to output here anymore. See AGENTS.md meshopt-standardization row.
//
// VRM0Passthrough/VRMCVrmPassthrough (see GLBVrmPassthrough.js) register real passthrough
// Extension subclasses for VRM 0.x (`extensions.VRM`) and VRM 1.0 (`extensions.VRMC_vrm`) so
// Document.read()/write() round-trip the whole opaque VRM block byte-identically instead of
// silently dropping it -- fixes glb-transform-vrm-extension-passthrough-registration. Verified
// (real cleetus.vrm, real meshopt() transform) that node/mesh document order and count are
// unchanged by weld/reorder/quantize, so VRM's raw node-index bone/collider/firstPerson
// references stay valid; see GLBVrmPassthrough.js's module comment for the full analysis
// including the one real internal hazard found (quantize() disposes+recreates the Skin
// property with an identical joint list, harmless for index-based VRM references) and the
// forward-looking caveat (only safe for node/mesh-order-preserving transforms).
//
// KHRMeshQuantization is registered here for the same reason: gltf-transform's own
// quantize() (called internally by compressMeshopt's meshopt() transform for virtually
// every asset) calls document.createExtension(KHRMeshQuantization).setRequired(true)
// whenever it packs an accessor to a non-FLOAT componentType, but an Extension that
// exists only in the in-memory Document and isn't registered on this NodeIO gets
// silently dropped from the written extensionsUsed/extensionsRequired arrays (writer.ts's
// "Some extensions were not registered for I/O, and will not be written" path) even
// though the actual quantized accessor bytes ARE written -- a spec-compliance gap (base
// glTF 2.0 requires POSITION/NORMAL/etc as FLOAT unless this extension declares
// otherwise) that three.js tolerates today (GLTFMeshQuantizationExtension is a no-op
// presence marker; three's accessor decode already honors componentType+normalized
// regardless) but a strict/validating loader is entitled to reject. Fixes
// glb-transform-khr-mesh-quantization-not-registered. Pure additive declaration fix --
// registering it does not change any accessor/buffer bytes, only whether the
// already-quantized output correctly self-declares as such.
let _io = null
async function getIO() {
  if (!_io) {
    const { NodeIO } = await import('@gltf-transform/core')
    const { KHRDracoMeshCompression, EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization } = await import('@gltf-transform/extensions')
    const { VRM0Passthrough, VRMCVrmPassthrough } = await import('./GLBVrmPassthrough.js')
    const draco3d = await import('draco3d')
    const { MeshoptEncoder, MeshoptDecoder } = await import('meshoptimizer')
    const [decoderModule, encoderModule] = await Promise.all([
      draco3d.createDecoderModule({}),
      draco3d.createEncoderModule({}),
      MeshoptEncoder.ready,
      MeshoptDecoder.ready
    ])
    _io = new NodeIO()
      .registerExtensions([KHRDracoMeshCompression, EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization, VRM0Passthrough, VRMCVrmPassthrough])
      .registerDependencies({
        'draco3d.decoder': decoderModule,
        'draco3d.encoder': encoderModule,
        'meshopt.decoder': MeshoptDecoder,
        'meshopt.encoder': MeshoptEncoder
      })
  }
  return _io
}

function patchTextureSources(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const jsonLen = view.getUint32(12, true)
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'))
  let changed = false
  for (const tex of json.textures || []) { if (tex.source === undefined) { tex.source = 0; changed = true } }
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
  out.writeUInt32LE(0x46546C67, p); p+=4; out.writeUInt32LE(2, p); p+=4; out.writeUInt32LE(tl, p); p+=4
  out.writeUInt32LE(pjBuf.length, p); p+=4; out.writeUInt32LE(0x4E4F534A, p); p+=4
  pjBuf.copy(out, p); p+=pjBuf.length
  out.writeUInt32LE(binBuf.length, p); p+=4; out.writeUInt32LE(0x004E4942, p); p+=4
  binBuf.copy(out, p)
  return out
}

export async function stripDraco(inputBuffer) {
  try {
    const io = await getIO()
    const patched = patchTextureSources(Buffer.from(inputBuffer))
    const doc = await io.readBinary(new Uint8Array(patched))
    doc.getRoot().listExtensionsUsed()
      .filter(e => e.extensionName === 'KHR_draco_mesh_compression')
      .forEach(e => e.dispose())
    return Buffer.from(await io.writeBinary(doc))
  } catch (e) {
    console.warn('[glb-transform] draco strip failed:', e.message)
    return null
  }
}

let _meshoptEncoderPromise = null
let _meshoptDecoderPromise = null
function getMeshoptEncoder() {
  if (!_meshoptEncoderPromise) {
    _meshoptEncoderPromise = import('meshoptimizer').then(async m => {
      await m.MeshoptEncoder.ready
      return m.MeshoptEncoder
    })
  }
  return _meshoptEncoderPromise
}
function getMeshoptDecoder() {
  if (!_meshoptDecoderPromise) {
    _meshoptDecoderPromise = import('meshoptimizer').then(async m => {
      await m.MeshoptDecoder.ready
      return m.MeshoptDecoder
    })
  }
  return _meshoptDecoderPromise
}

// weld (merge duplicate vertices) + reorder (meshopt vertex/index cache
// optimization) + quantize (pack attributes to lower-precision integer formats via
// KHR_mesh_quantization) + EXT_meshopt_compression (actual byte-level compression of
// the quantized/reordered buffers) -- gltf-transform's own `meshopt()` production
// transform, replacing the former weld+quantize+reorder+Draco-re-encode combo. This
// repo standardizes ALL new/re-encoded GLB/VRM output on meshopt, never Draco (Draco
// stays a read-only decode path for legacy imports via stripDraco/hasDraco above --
// see AGENTS.md meshopt-standardization-draco-legacy-only). Applied to VRM too: none
// of weld/reorder/quantize/meshopt-encode decode compressed geometry (that was
// Draco's OOM-risk path, which stayed VRM-excluded when Draco was still an output
// option); they only restructure/re-pack/compress already-decoded vertex data, which
// is exactly what gltf-transform's own CLI `optimize --compress meshopt` preset does.
export async function compressMeshopt(inputBuffer) {
  try {
    const io = await getIO()
    const { meshopt } = await import('@gltf-transform/functions')
    const encoder = await getMeshoptEncoder()
    const decoder = await getMeshoptDecoder()
    const document = await io.readBinary(new Uint8Array(inputBuffer))
    // Defensive strip: a KHR_draco_mesh_compression primitive's accessors are opaque
    // to meshopt()'s weld/reorder/quantize passes (it can't restructure vertex data it
    // can't read), so meshopt() silently no-ops on those primitives and leaves the
    // stale Draco extensionsUsed entry in the written output -- a caller that (bug, or
    // future refactor) hands compressMeshopt a still-Draco-compressed document, instead
    // of stripDraco-then-compressMeshopt, must not be able to produce output that
    // claims both extensions / still carries Draco. Disposing here makes "output is
    // never Draco" hold structurally, not just by caller-ordering discipline.
    const dracoExt = document.getRoot().listExtensionsUsed().find(e => e.extensionName === 'KHR_draco_mesh_compression')
    if (dracoExt) dracoExt.dispose()
    await document.transform(meshopt({ encoder, decoder, level: 'high' }))
    const out = await io.writeBinary(document)
    return Buffer.from(out)
  } catch (e) {
    console.warn('[glb-transform] meshopt compress failed:', e.message)
    return null
  }
}
