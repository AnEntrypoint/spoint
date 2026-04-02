export function hasDraco(jsonChunk) {
  return (jsonChunk.extensionsUsed || []).includes('KHR_draco_mesh_compression')
}

let _io = null
async function getIO() {
  if (!_io) {
    const { NodeIO } = await import('@gltf-transform/core')
    const { KHRDracoMeshCompression, EXTTextureWebP } = await import('@gltf-transform/extensions')
    const draco3d = await import('draco3d')
    const [decoderModule, encoderModule] = await Promise.all([
      draco3d.createDecoderModule({}),
      draco3d.createEncoderModule({})
    ])
    _io = new NodeIO()
      .registerExtensions([KHRDracoMeshCompression, EXTTextureWebP])
      .registerDependencies({ 'draco3d.decoder': decoderModule, 'draco3d.encoder': encoderModule })
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

export async function applyDraco(inputBuffer) {
  try {
    const io = await getIO()
    const { draco } = await import('@gltf-transform/functions')
    const document = await io.readBinary(new Uint8Array(inputBuffer))
    await document.transform(draco({ method: 'edgebreaker' }))
    const out = await io.writeBinary(document)
    return Buffer.from(out)
  } catch (e) {
    console.warn('[glb-transform] draco failed:', e.message)
    return null
  }
}
