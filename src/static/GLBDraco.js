export function hasDraco(jsonChunk) {
  return (jsonChunk.extensionsUsed || []).includes('KHR_draco_mesh_compression')
}

export async function applyDraco(inputBuffer) {
  try {
    const { NodeIO } = await import('@gltf-transform/core')
    const { draco } = await import('@gltf-transform/functions')
    const { KHRDracoMeshCompression } = await import('@gltf-transform/extensions')
    const draco3d = await import('draco3d')
    const encoderModule = await draco3d.createEncoderModule({})
    const decoderModule = await draco3d.createDecoderModule({})
    const io = new NodeIO()
      .registerExtensions([KHRDracoMeshCompression])
      .registerDependencies({ 'draco3d.encoder': encoderModule, 'draco3d.decoder': decoderModule })
    const document = await io.readBinary(new Uint8Array(inputBuffer))
    await document.transform(draco({ method: 'edgebreaker' }))
    const out = await io.writeBinary(document)
    return Buffer.from(out)
  } catch (e) {
    console.warn('[glb-transform] draco failed:', e.message)
    return null
  }
}
