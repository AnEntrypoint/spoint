let _meshoptDecoderPromise = null

export async function getMeshoptDecoder() {
  if (!_meshoptDecoderPromise) {
    try {
      const meshopt = await import('meshoptimizer')
      _meshoptDecoderPromise = meshopt.MeshoptDecoder
      await _meshoptDecoderPromise.ready
    } catch(e) {
      throw new Error(`Failed to load Meshopt decoder: ${e.message}`)
    }
  }
  return _meshoptDecoderPromise
}

export async function extractMeshWithMeshopt(buf, json, prim, binOffset, meshName) {
  const decoder = await getMeshoptDecoder()

  const posAcc = json.accessors[prim.attributes.POSITION]
  const posView = json.bufferViews[posAcc.bufferView]
  const posExt = posView.extensions?.EXT_meshopt_compression

  if (!posExt) throw new Error('Position buffer view has no EXT_meshopt_compression extension')

  const posSrcOff = binOffset + (posExt.byteOffset || 0)
  const posSrc = new Uint8Array(buf.buffer.slice(posSrcOff, posSrcOff + posExt.byteLength))

  const numVertices = posExt.count
  const stride = posExt.byteStride || 12
  const posDst = new Uint8Array(numVertices * stride)
  decoder.decodeGltfBuffer(posDst, numVertices, stride, posSrc, posExt.mode || 'ATTRIBUTES', posExt.filter || 'NONE')

  const vertices = new Float32Array(numVertices * 3)

  if (stride === 8 && posAcc.normalized && posAcc.componentType === 5122) {
    const raw = new Int16Array(posDst.buffer)
    for (let i = 0; i < numVertices; i++) {
      vertices[i * 3] = raw[i * 4] / 32767.0
      vertices[i * 3 + 1] = raw[i * 4 + 1] / 32767.0
      vertices[i * 3 + 2] = raw[i * 4 + 2] / 32767.0
    }
  } else if (stride === 12) {
    vertices.set(new Float32Array(posDst.buffer))
  } else {
    const floats = new Float32Array(posDst.buffer)
    for (let i = 0; i < numVertices; i++) {
      vertices[i * 3] = floats[i * (stride / 4)]
      vertices[i * 3 + 1] = floats[i * (stride / 4) + 1]
      vertices[i * 3 + 2] = floats[i * (stride / 4) + 2]
    }
  }

  let indices = null
  if (prim.indices !== undefined) {
    const idxAcc = json.accessors[prim.indices]
    const idxView = json.bufferViews[idxAcc.bufferView]
    const idxExt = idxView.extensions?.EXT_meshopt_compression

    if (idxExt) {
      const idxSrcOff = binOffset + (idxExt.byteOffset || 0)
      const idxSrc = new Uint8Array(buf.buffer.slice(idxSrcOff, idxSrcOff + idxExt.byteLength))
      const idxStride = idxExt.byteStride || 2
      const numIndices = idxExt.count
      const idxDst = new Uint8Array(numIndices * idxStride)
      decoder.decodeGltfBuffer(idxDst, numIndices, idxStride, idxSrc, idxExt.mode || 'TRIANGLES', idxExt.filter || 'NONE')
      indices = idxAcc.componentType === 5123
        ? new Uint32Array(new Uint16Array(idxDst.buffer))
        : new Uint32Array(idxDst.buffer)
    } else {
      const idxOff = binOffset + (idxView.byteOffset || 0) + (idxAcc.byteOffset || 0)
      indices = idxAcc.componentType === 5123
        ? new Uint32Array(new Uint16Array(buf.buffer.slice(idxOff, idxOff + idxAcc.count * 2)))
        : new Uint32Array(buf.buffer.slice(idxOff, idxOff + idxAcc.count * 4))
    }
  }

  return { vertices, indices, vertexCount: numVertices, triangleCount: indices ? indices.length / 3 : 0, name: meshName }
}
