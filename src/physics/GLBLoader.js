import { readFileSync } from 'node:fs'

let _dracoDecoderPromise = null
let _meshoptDecoderPromise = null

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

async function getMeshoptDecoder() {
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

  // Check for meshopt compression (not supported)
  const hasMeshopt = json.bufferViews?.some(bv => bv.extensions?.EXT_meshopt_compression) ||
    json.meshes.some(m => m.primitives.some(p => p.extensions?.EXT_meshopt_compression))
  if (hasMeshopt) {
    throw new Error('Meshopt-compressed mesh detected. Decompress with gltfpack first: gltfpack -i input.glb -o output.glb -noq')
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

  const result = {
    vertices,
    indices,
    vertexCount: posAcc.count,
    triangleCount: indices ? indices.length / 3 : 0,
    name: mesh.name
  }

  const nodeIdx = (json.nodes || []).findIndex(n => n.mesh === meshIndex)
  if (nodeIdx >= 0) {
    const worldMatrix = buildNodeTransforms(json)[nodeIdx]
    result.vertices = applyTransformMatrix(result.vertices, worldMatrix)
  }

  return result
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

  if (!json.meshes || json.meshes.length === 0) throw new Error('GLB has no meshes')
  const mesh = json.meshes[meshIndex]
  if (!mesh) throw new Error(`Mesh index ${meshIndex} not found`)
  if (!mesh.primitives || mesh.primitives.length === 0) throw new Error(`Mesh ${meshIndex} has no primitives`)

  const prim = mesh.primitives[0]

  let result

  if (prim.extensions?.KHR_draco_mesh_compression) {
    result = await decompressDracoMesh(buf, json, prim, binOffset, mesh.name)
  } else if (json.bufferViews?.some(bv => bv.extensions?.EXT_meshopt_compression)) {
    result = await extractMeshWithMeshopt(buf, json, prim, binOffset, mesh.name)
  } else {
    result = extractStandardMesh(buf, json, prim, binOffset, mesh.name)
  }

  const nodeIdx = (json.nodes || []).findIndex(n => n.mesh === meshIndex)
  if (nodeIdx >= 0) {
    const worldMatrix = buildNodeTransforms(json)[nodeIdx]
    result.vertices = applyTransformMatrix(result.vertices, worldMatrix)
  }

  return result
}

function extractStandardMesh(buf, json, prim, binOffset, meshName) {
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
    name: meshName
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

  const d = new decoder.Decoder()
  const db = new decoder.DecoderBuffer()
  const decodedGeom = new decoder.Mesh()

  try {
    const dracoArray = new Uint8Array(dracoData)
    db.Init(dracoArray, dracoArray.length)

    const status = d.DecodeBufferToMesh(db, decodedGeom)
    if (!status.ok()) {
      throw new Error(`Draco decompression failed: ${status.error_msg()}`)
    }

    const posAttrId = d.GetAttributeId(decodedGeom, decoder.POSITION)
    if (posAttrId < 0) {
      throw new Error('No POSITION attribute in decompressed mesh')
    }

    const posAttr = d.GetAttribute(decodedGeom, posAttrId)
    const numPoints = decodedGeom.num_points()
    const posData = new decoder.DracoFloat32Array()
    d.GetAttributeFloatForAllPoints(decodedGeom, posAttr, posData)
    
    const vertices = new Float32Array(numPoints * 3)
    for (let i = 0; i < numPoints * 3; i++) {
      vertices[i] = posData.GetValue(i)
    }

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

    return {
      vertices,
      indices,
      vertexCount: numPoints,
      triangleCount: numFaces,
      name: meshName
    }
  } finally {
    decoder.destroy(decodedGeom)
    decoder.destroy(d)
    decoder.destroy(db)
  }
}

async function extractMeshWithMeshopt(buf, json, prim, binOffset, meshName) {
  const decoder = await getMeshoptDecoder()
  
  const posAcc = json.accessors[prim.attributes.POSITION]
  const posView = json.bufferViews[posAcc.bufferView]
  const posExt = posView.extensions?.EXT_meshopt_compression
  
  if (!posExt) {
    throw new Error('Position buffer view has no EXT_meshopt_compression extension')
  }
  
  const posSrcOff = binOffset + (posExt.byteOffset || 0)
  const posSrcLen = posExt.byteLength
  const posSrc = new Uint8Array(buf.buffer.slice(posSrcOff, posSrcOff + posSrcLen))
  
  const numVertices = posExt.count
  const stride = posExt.byteStride || 12
  const posDst = new Uint8Array(numVertices * stride)
  
  const mode = posExt.mode || 'ATTRIBUTES'
  const filter = posExt.filter || 'NONE'
  decoder.decodeGltfBuffer(posDst, numVertices, stride, posSrc, mode, filter)
  
  const vertices = new Float32Array(numVertices * 3)
  
  // Handle normalized INT16 positions (common in meshopt-compressed models)
  // Normalized INT16: float = raw / 32767.0
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
      const idxSrcLen = idxExt.byteLength
      const idxSrc = new Uint8Array(buf.buffer.slice(idxSrcOff, idxSrcOff + idxSrcLen))
      
      const idxStride = idxExt.byteStride || 2
      const numIndices = idxExt.count
      const idxDst = new Uint8Array(numIndices * idxStride)
      
      const idxMode = idxExt.mode || 'TRIANGLES'
      const idxFilter = idxExt.filter || 'NONE'
      decoder.decodeGltfBuffer(idxDst, numIndices, idxStride, idxSrc, idxMode, idxFilter)
      
      if (idxAcc.componentType === 5123) {
        indices = new Uint32Array(new Uint16Array(idxDst.buffer))
      } else {
        indices = new Uint32Array(idxDst.buffer)
      }
    } else {
      const idxOff = binOffset + (idxView.byteOffset || 0) + (idxAcc.byteOffset || 0)
      if (idxAcc.componentType === 5123) {
        indices = new Uint32Array(new Uint16Array(buf.buffer.slice(idxOff, idxOff + idxAcc.count * 2)))
      } else {
        indices = new Uint32Array(buf.buffer.slice(idxOff, idxOff + idxAcc.count * 4))
      }
    }
  }
  
  return {
    vertices,
    indices,
    vertexCount: numVertices,
    triangleCount: indices ? indices.length / 3 : 0,
    name: meshName
  }
}

/**
 * Extract ALL meshes and ALL primitives from a GLB file and combine them into
 * a single flat vertex/index buffer suitable for a trimesh collider.
 * Handles Draco-compressed primitives. Used for map collision where the GLB
 * may have dozens of meshes each with many primitives.
 *
 * @param {string} filepath - Path to GLB file
 * @returns {Promise<Object>} {vertices: Float32Array, indices: Uint32Array, vertexCount, triangleCount}
 */
export async function extractAllMeshesFromGLBAsync(filepath) {
  console.log(`[GLBLoader] Extracting ALL meshes from: ${filepath}`)
  const buf = readFileSync(filepath)
  if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('Not a GLB file')

  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.toString('utf-8', 20, 20 + jsonLen))
  const binOffset = 20 + jsonLen + 8

  const allVertices = []
  const allIndices = []
  let vertexOffset = 0
  let totalTriangles = 0

  // Build a node->transform map for node hierarchy
  const nodeTransforms = buildNodeTransforms(json)
  const materials = json.materials || []
  // Source Engine / CS:GO invisible/trigger materials — exclude from physics
  const SKIP_MATS = new Set(['aaatrigger', '{invisible', 'playerclip', 'clip', 'nodraw', 'trigger', 'sky', 'toolsclip', 'toolsplayerclip', 'toolsnodraw', 'toolsskybox', 'toolstrigger'])

  for (let meshIdx = 0; meshIdx < (json.meshes || []).length; meshIdx++) {
    const mesh = json.meshes[meshIdx]
    // Find node referencing this mesh to get its world transform
    const nodeIdx = (json.nodes || []).findIndex(n => n.mesh === meshIdx)
    const worldTransform = nodeIdx >= 0 ? nodeTransforms[nodeIdx] : null

    for (let primIdx = 0; primIdx < mesh.primitives.length; primIdx++) {
      const prim = mesh.primitives[primIdx]
      // Skip invisible/trigger materials that should not have physics collision
      const matName = prim.material !== undefined ? (materials[prim.material]?.name || '') : ''
      if (SKIP_MATS.has(matName)) continue
      let result
      try {
        if (prim.extensions?.KHR_draco_mesh_compression) {
          result = await decompressDracoMesh(buf, json, prim, binOffset, mesh.name)
        } else {
          result = extractStandardMesh(buf, json, prim, binOffset, mesh.name)
        }
      } catch (e) {
        console.warn(`[GLBLoader] Skipping mesh[${meshIdx}] prim[${primIdx}]: ${e.message}`)
        continue
      }

      if (!result.indices || result.triangleCount === 0) continue

      // Apply world transform to vertices if present
      let verts = result.vertices
      if (worldTransform) {
        verts = applyTransformMatrix(result.vertices, worldTransform)
      }

      allVertices.push(verts)
      // Remap indices by current vertex offset
      const remapped = new Uint32Array(result.indices.length)
      for (let i = 0; i < result.indices.length; i++) {
        remapped[i] = result.indices[i] + vertexOffset
      }
      allIndices.push(remapped)
      vertexOffset += result.vertexCount
      totalTriangles += result.triangleCount
    }
  }

  if (allVertices.length === 0) throw new Error('No valid mesh primitives found in GLB')

  // Concatenate all vertex and index arrays
  const totalVerts = vertexOffset
  const combinedVertices = new Float32Array(totalVerts * 3)
  let vOff = 0
  for (const v of allVertices) { combinedVertices.set(v, vOff); vOff += v.length }

  const combinedIndices = new Uint32Array(totalTriangles * 3)
  let iOff = 0
  for (const idx of allIndices) { combinedIndices.set(idx, iOff); iOff += idx.length }

  console.log(`[GLBLoader] Combined: ${totalVerts} vertices, ${totalTriangles} triangles from ${allIndices.length} primitives`)
  return { vertices: combinedVertices, indices: combinedIndices, vertexCount: totalVerts, triangleCount: totalTriangles }
}

/**
 * Build world-space 4x4 transform matrices for every node in the scene graph.
 * Returns an array indexed by node index.
 */
function buildNodeTransforms(json) {
  const nodes = json.nodes || []
  const matrices = new Array(nodes.length).fill(null)

  function getMatrix(nodeIdx) {
    if (matrices[nodeIdx] !== null) return matrices[nodeIdx]
    const node = nodes[nodeIdx]
    let local = mat4Identity()
    if (node.matrix) {
      local = node.matrix.slice()
    } else {
      const t = node.translation || [0, 0, 0]
      const r = node.rotation || [0, 0, 0, 1]
      const s = node.scale || [1, 1, 1]
      local = mat4TRS(t, r, s)
    }
    // Find parent
    const parentIdx = nodes.findIndex((n, i) => i !== nodeIdx && (n.children || []).includes(nodeIdx))
    if (parentIdx >= 0) {
      local = mat4Mul(getMatrix(parentIdx), local)
    }
    matrices[nodeIdx] = local
    return local
  }

  for (let i = 0; i < nodes.length; i++) getMatrix(i)
  return matrices
}

function mat4Identity() {
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
}

function mat4TRS(t, r, s) {
  const [qx, qy, qz, qw] = r
  const [sx, sy, sz] = s
  const x2=qx+qx, y2=qy+qy, z2=qz+qz
  const xx=qx*x2, xy=qx*y2, xz=qx*z2
  const yy=qy*y2, yz=qy*z2, zz=qz*z2
  const wx=qw*x2, wy=qw*y2, wz=qw*z2
  return [
    (1-(yy+zz))*sx, (xy+wz)*sx,    (xz-wy)*sx,    0,
    (xy-wz)*sy,     (1-(xx+zz))*sy,(yz+wx)*sy,    0,
    (xz+wy)*sz,     (yz-wx)*sz,    (1-(xx+yy))*sz,0,
    t[0], t[1], t[2], 1
  ]
}

function mat4Mul(a, b) {
  const out = new Array(16)
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[row + k*4] * b[k + col*4]
      out[row + col*4] = sum
    }
  }
  return out
}

function applyTransformMatrix(vertices, m) {
  const count = vertices.length / 3
  const out = new Float32Array(vertices.length)
  for (let i = 0; i < count; i++) {
    const x = vertices[i*3], y = vertices[i*3+1], z = vertices[i*3+2]
    out[i*3]   = m[0]*x + m[4]*y + m[8]*z  + m[12]
    out[i*3+1] = m[1]*x + m[5]*y + m[9]*z  + m[13]
    out[i*3+2] = m[2]*x + m[6]*y + m[10]*z + m[14]
  }
  return out
}

/**
 * Check if a GLB file has Draco-compressed meshes without attempting extraction.
 * Useful for validation and error reporting.
 * 
 * @param {string} filepath - Path to GLB file
 * @returns {Object} {hasDraco: boolean, hasMeshopt: boolean, meshes: Array<{name, hasDraco, hasMeshopt}>}
 */
export function detectDracoInGLB(filepath) {
  try {
    const buf = readFileSync(filepath)
    if (buf.toString('ascii', 0, 4) !== 'glTF') return { hasDraco: false, hasMeshopt: false, meshes: [] }
    
    const jsonLen = buf.readUInt32LE(12)
    const json = JSON.parse(buf.toString('utf-8', 20, 20 + jsonLen))
    
    const bufferViewHasMeshopt = (bv) => bv.extensions?.EXT_meshopt_compression
    const hasMeshoptGlobally = (json.bufferViews || []).some(bufferViewHasMeshopt)
    
    const meshes = (json.meshes || []).map(mesh => {
      const hasDraco = mesh.primitives?.some(p => p.extensions?.KHR_draco_mesh_compression) || false
      const hasMeshopt = hasMeshoptGlobally || mesh.primitives?.some(p => p.extensions?.EXT_meshopt_compression) || false
      return { name: mesh.name || 'unnamed', hasDraco, hasMeshopt }
    })
    
    return {
      hasDraco: meshes.some(m => m.hasDraco),
      hasMeshopt: meshes.some(m => m.hasMeshopt),
      meshes
    }
  } catch (e) {
    return { hasDraco: false, hasMeshopt: false, meshes: [], error: e.message }
  }
}