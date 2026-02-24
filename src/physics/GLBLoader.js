import { readFileSync } from 'node:fs'

/**
 * Extract mesh from GLB file for physics collider creation.
 * 
 * NOTE: Draco-compressed meshes require decompression before vertex extraction.
 * This function detects Draco compression and provides clear error guidance.
 * 
 * @param {string} filepath - Path to GLB file
 * @param {number} meshIndex - Mesh index (default 0)
 * @returns {Object} {vertices, indices, vertexCount, triangleCount, name}
 * @throws {Error} If mesh is Draco-compressed or invalid
 */
export function extractMeshFromGLB(filepath, meshIndex = 0) {
  const buf = readFileSync(filepath)
  if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('Not a GLB file')
  
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.toString('utf-8', 20, 20 + jsonLen))
  const binOffset = 20 + jsonLen + 8
  
  const mesh = json.meshes[meshIndex]
  if (!mesh) throw new Error(`Mesh index ${meshIndex} not found`)
  
  const prim = mesh.primitives[0]
  
  // Check for Draco compression - this is the critical issue
  if (prim.extensions?.KHR_draco_mesh_compression) {
    const dracoExt = prim.extensions.KHR_draco_mesh_compression
    const bufViewIdx = dracoExt.bufferView
    throw new Error(
      `Cannot extract collider from Draco-compressed mesh '${mesh.name}'. \n\n` +
      `SOLUTION: Use gltfpack to decompress the model before physics import:\n` +
      `  gltfpack -i model.glb -o model-uncompressed.glb -noq\n\n` +
      `Or mark this model as 'no-physics' in entity config and use trigger colliders instead.`
    )
  }
  
  // Standard uncompressed GLB mesh extraction
  const posAcc = json.accessors[prim.attributes.POSITION]
  const posView = json.bufferViews[posAcc.bufferView]
  const posOff = binOffset + (posView.byteOffset || 0) + (posAcc.byteOffset || 0)
  const vertices = new Float32Array(buf.buffer.slice(buf.byteOffset + posOff, buf.byteOffset + posOff + posAcc.count * 12))
  
  let indices = null
  if (prim.indices !== undefined) {
    const idxAcc = json.accessors[prim.indices]
    const idxView = json.bufferViews[idxAcc.bufferView]
    const idxOff = binOffset + (idxView.byteOffset || 0) + (idxAcc.byteOffset || 0)
    if (idxAcc.componentType === 5123) {
      const raw = new Uint16Array(buf.buffer.slice(buf.byteOffset + idxOff, buf.byteOffset + idxOff + idxAcc.count * 2))
      indices = new Uint32Array(raw)
    } else {
      indices = new Uint32Array(buf.buffer.slice(buf.byteOffset + idxOff, buf.byteOffset + idxOff + idxAcc.count * 4))
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