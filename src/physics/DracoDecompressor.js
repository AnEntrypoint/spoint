let _dracoDecoderPromise = null

export async function getDracoDecoder() {
  if (!_dracoDecoderPromise) {
    try {
      const dracoGltf = await import('draco3dgltf')
      _dracoDecoderPromise = dracoGltf.createDecoderModule()
    } catch(e) {
      throw new Error(`Failed to load Draco decoder: ${e.message}`)
    }
  }
  return _dracoDecoderPromise
}

export async function decompressDracoMesh(buf, json, prim, binOffset, meshName) {
  const decoder = await getDracoDecoder()

  const dracoExt = prim.extensions.KHR_draco_mesh_compression
  const bufView = json.bufferViews[dracoExt.bufferView]
  const offset = binOffset + (bufView.byteOffset || 0)
  const dracoData = buf.slice(offset, offset + bufView.byteLength)

  const d = new decoder.Decoder()
  const db = new decoder.DecoderBuffer()
  const decodedGeom = new decoder.Mesh()

  try {
    const dracoArray = new Uint8Array(dracoData)
    db.Init(dracoArray, dracoArray.length)

    const status = d.DecodeBufferToMesh(db, decodedGeom)
    if (!status.ok()) throw new Error(`Draco decompression failed: ${status.error_msg()}`)

    const posAttrId = d.GetAttributeId(decodedGeom, decoder.POSITION)
    if (posAttrId < 0) throw new Error('No POSITION attribute in decompressed mesh')

    const posAttr = d.GetAttribute(decodedGeom, posAttrId)
    const numPoints = decodedGeom.num_points()
    const posData = new decoder.DracoFloat32Array()
    d.GetAttributeFloatForAllPoints(decodedGeom, posAttr, posData)

    const vertices = new Float32Array(numPoints * 3)
    for (let i = 0; i < numPoints * 3; i++) vertices[i] = posData.GetValue(i)

    let indices = null
    const numFaces = decodedGeom.num_faces()
    if (numFaces > 0) {
      indices = new Uint32Array(numFaces * 3)
      const faceIndices = new decoder.DracoUInt32Array()
      for (let i = 0; i < numFaces; i++) {
        d.GetFaceFromMesh(decodedGeom, i, faceIndices)
        indices[i * 3] = faceIndices.GetValue(0)
        indices[i * 3 + 1] = faceIndices.GetValue(1)
        indices[i * 3 + 2] = faceIndices.GetValue(2)
      }
      decoder.destroy(faceIndices)
    }

    decoder.destroy(posData)
    decoder.destroy(status)

    return { vertices, indices, vertexCount: numPoints, triangleCount: numFaces, name: meshName }
  } finally {
    decoder.destroy(decodedGeom)
    decoder.destroy(d)
    decoder.destroy(db)
  }
}
