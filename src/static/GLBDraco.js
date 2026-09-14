export function hasDraco(jsonChunk) {
  return (jsonChunk.extensionsUsed || []).includes('KHR_draco_mesh_compression')
}

export function hasMeshopt(jsonChunk) {
  return (jsonChunk.extensionsUsed || []).includes('EXT_meshopt_compression')
}

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

export async function compressMeshopt(inputBuffer) {
  try {
    const io = await getIO()
    const { meshopt } = await import('@gltf-transform/functions')
    const encoder = await getMeshoptEncoder()
    const decoder = await getMeshoptDecoder()
    const document = await io.readBinary(new Uint8Array(inputBuffer))
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
