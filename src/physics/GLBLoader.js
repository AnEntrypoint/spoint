import { readFileSync } from 'node:fs'

let _dracoDecoderPromise = null

async function getDracoDecoder() {
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

/**
 * Extract mesh from GLB file for physics collider creation.
 * Supports both standard and Draco-compressed meshes.
 *
 * @param {string} filepath - Path to GLB file
 * @param {number} meshIndex - Mesh index (default 0)
 * @returns {Object} {vertices, indices, vertexCount, triangleCount, name}
 * @throws {Error} If mesh cannot be extracted
 */
export function extractMeshFromGLB(filepath, meshIndex = 0) {
  console.log(`[GLBLoader] Extracting from: ${filepath}`)
  const buf = readFileSync(filepath)
  if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('Not a GLB file')

  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.toString('utf-8', 20, 20 + jsonLen))
  const binOffset = 20 + jsonLen + 8

  const mesh = json.meshes[meshIndex]
  if (!mesh) throw new Error(`Mesh index ${meshIndex} not found`)

  const prim = mesh.primitives[0]

  // Check for Draco compression and defer to async handler
  if (prim.extensions?.KHR_draco_mesh_compression) {
    throw new Error('Draco-compressed mesh detected. Use extractMeshFromGLBAsync() instead.')
  }

  // Standard uncompressed GLB mesh extraction
  const posAcc = json.accessors[prim.attributes.POSITION]
  const posView = json.bufferViews[posAcc.bufferView]
  const posOff = binOffset + (posView.byteOffset || 0) + (posAcc.byteOffset || 0)
  const vertices = new Float32Array(buf.buffer.slice(posOff, posOff + posAcc.count * 12))

  let indices = null
  if (prim.indices !== undefined) {
    const idxAcc = json.accessors[prim.indices]
    const idxView = json.bufferViews[idxAcc.bufferView]
    const idxOff = binOffset + (idxView.byteOffset || 0) + (idxAcc.byteOffset || 0)
    if (idxAcc.componentType === 5123) {
      const raw = new Uint16Array(buf.buffer.slice(idxOff, idxOff + idxAcc.count * 2))
      indices = new Uint32Array(raw)
    } else {
      indices = new Uint32Array(buf.buffer.slice(idxOff, idxOff + idxAcc.count * 4))
    }
  }

  return {
    vertices,
    indices,
    vertexCount: posAcc.count,
    triangleCount: indices ? indices.length / 3 : 0,
    name: mesh.name
  }
}

/**
 * Extract mesh from GLB file with Draco decompression support.
 * Handles both compressed and uncompressed meshes asynchronously.
 *
 * @param {string} filepath - Path to GLB file
 * @param {number} meshIndex - Mesh index (default 0)
 * @returns {Promise<Object>} {vertices, indices, vertexCount, triangleCount, name}
 */
export async function extractMeshFromGLBAsync(filepath, meshIndex = 0) {
  console.log(`[GLBLoader] Extracting (async) from: ${filepath}`)
  const buf = readFileSync(filepath)
  if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('Not a GLB file')

  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.toString('utf-8', 20, 20 + jsonLen))
  const binOffset = 20 + jsonLen + 8

  const mesh = json.meshes[meshIndex]
  if (!mesh) throw new Error(`Mesh index ${meshIndex} not found`)

  const prim = mesh.primitives[0]

  // Handle Draco-compressed mesh
  if (prim.extensions?.KHR_draco_mesh_compression) {
    return decompressDracoMesh(buf, json, prim, binOffset, mesh.name)
  }

  // Standard uncompressed extraction
  const posAcc = json.accessors[prim.attributes.POSITION]
  const posView = json.bufferViews[posAcc.bufferView]
  const posOff = binOffset + (posView.byteOffset || 0) + (posAcc.byteOffset || 0)
  const vertices = new Float32Array(buf.buffer.slice(posOff, posOff + posAcc.count * 12))

  let indices = null
  if (prim.indices !== undefined) {
    const idxAcc = json.accessors[prim.indices]
    const idxView = json.bufferViews[idxAcc.bufferView]
    const idxOff = binOffset + (idxView.byteOffset || 0) + (idxAcc.byteOffset || 0)
    if (idxAcc.componentType === 5123) {
      const raw = new Uint16Array(buf.buffer.slice(idxOff, idxOff + idxAcc.count * 2))
      indices = new Uint32Array(raw)
    } else {
      indices = new Uint32Array(buf.buffer.slice(idxOff, idxOff + idxAcc.count * 4))
    }
  }

  return {
    vertices,
    indices,
    vertexCount: posAcc.count,
    triangleCount: indices ? indices.length / 3 : 0,
    name: mesh.name
  }
}

async function decompressDracoMesh(buf, json, prim, binOffset, meshName) {
  const decoder = await getDracoDecoder()

  const dracoExt = prim.extensions.KHR_draco_mesh_compression
  const bufViewIdx = dracoExt.bufferView
  const bufView = json.bufferViews[bufViewIdx]
  const offset = binOffset + (bufView.byteOffset || 0)
  const length = bufView.byteLength
  const dracoData = buf.slice(offset, offset + length)

  // Create decoder and buffer
  const d = new decoder.Decoder()
  const db = new decoder.DecoderBuffer()

  try {
    // Initialize buffer
    const dracoArray = new Uint8Array(dracoData)
    db.Init(dracoArray, dracoArray.length)

    // Decode mesh
    const decodedGeom = d.DecodeBufferToMesh(db)
    if (!decodedGeom) {
      throw new Error('Draco decompression failed: empty result')
    }

    // Get position attribute
    const posAttrId = d.GetAttributeIdByName(decodedGeom, 'POSITION')
    if (posAttrId < 0) {
      throw new Error('No POSITION attribute in decompressed mesh')
    }

    const posAttr = d.GetAttribute(decodedGeom, posAttrId)
    const posData = d.GetAttributeFloatForAllPoints(decodedGeom, posAttr)
    const vertices = new Float32Array(posData)

    // Get indices if available
    let indices = null
    if (decodedGeom.num_faces() > 0) {
      const indicesData = d.GetTrianglesUInt32Array(decodedGeom, decodedGeom.num_faces())
      indices = new Uint32Array(indicesData)
    }

    decoder.destroy(decodedGeom)

    return {
      vertices,
      indices,
      vertexCount: decodedGeom.num_points(),
      triangleCount: decodedGeom.num_faces(),
      name: meshName
    }
  } finally {
    decoder.destroy(d)
    decoder.destroy(db)
  }
}

/**
 * Check if a GLB file has Draco-compressed meshes without attempting extraction.
 * Useful for validation and error reporting.
 * 
 * @param {string} filepath - Path to GLB file
 * @returns {Object} {hasDraco: boolean, meshes: Array<{name, hasDraco}>}
 */
export function detectDracoInGLB(filepath) {
  try {
    const buf = readFileSync(filepath)
    if (buf.toString('ascii', 0, 4) !== 'glTF') return { hasDraco: false, meshes: [] }
    
    const jsonLen = buf.readUInt32LE(12)
    const json = JSON.parse(buf.toString('utf-8', 20, 20 + jsonLen))
    
    const meshes = (json.meshes || []).map(mesh => ({
      name: mesh.name || 'unnamed',
      hasDraco: mesh.primitives?.some(p => p.extensions?.KHR_draco_mesh_compression) || false
    }))
    
    const hasDraco = meshes.some(m => m.hasDraco)
    return { hasDraco, meshes }
  } catch (e) {
    return { hasDraco: false, meshes: [], error: e.message }
  }
}