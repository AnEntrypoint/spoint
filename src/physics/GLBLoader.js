import { buildNodeTransforms, applyTransformMatrix } from './GLBMath.js'
import { decompressDracoMesh } from './DracoDecompressor.js'
import { extractMeshWithMeshopt } from './MeshoptDecompressor.js'

export const SKIP_MATS = new Set(['aaatrigger', '{invisible', 'playerclip', 'clip', 'nodraw', 'trigger', 'sky', 'toolsclip', 'toolsplayerclip', 'toolsnodraw', 'toolsskybox', 'toolstrigger'])

let _readFileSync = null
try { if (typeof process !== 'undefined' && process.versions?.node) { const m = await import('node:fs'); _readFileSync = m.readFileSync } } catch {}

function readGLBSync(filepath) {
  if (!_readFileSync) throw new Error('readFileSync not available — use URL-based async methods in browser')
  const buf = _readFileSync(filepath)
  if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('Not a GLB file')
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.toString('utf-8', 20, 20 + jsonLen))
  return { buf, json, binOffset: 20 + jsonLen + 8 }
}

async function readGLBAsync(pathOrUrl) {
  if (_readFileSync && !pathOrUrl.startsWith('http') && !pathOrUrl.startsWith('/')) {
    return readGLBSync(pathOrUrl)
  }
  const res = await fetch(pathOrUrl)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${pathOrUrl}`)
  const ab = await res.arrayBuffer()
  const view = new DataView(ab)
  const jsonLen = view.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 20, jsonLen)))
  return { buf: new Uint8Array(ab), json, binOffset: 20 + jsonLen + 8 }
}

function readGLB(filepath) { return readGLBSync(filepath) }

export function extractStandardMesh(buf, json, prim, binOffset, meshName) {
  const posAcc = json.accessors[prim.attributes.POSITION]
  const posView = json.bufferViews[posAcc.bufferView]
  const posOff = binOffset + (posView.byteOffset || 0) + (posAcc.byteOffset || 0)
  const vertices = new Float32Array(buf.buffer.slice(posOff, posOff + posAcc.count * 12))
  let indices = null
  if (prim.indices !== undefined) {
    const idxAcc = json.accessors[prim.indices]
    const idxView = json.bufferViews[idxAcc.bufferView]
    const idxOff = binOffset + (idxView.byteOffset || 0) + (idxAcc.byteOffset || 0)
    indices = idxAcc.componentType === 5123
      ? new Uint32Array(new Uint16Array(buf.buffer.slice(idxOff, idxOff + idxAcc.count * 2)))
      : new Uint32Array(buf.buffer.slice(idxOff, idxOff + idxAcc.count * 4))
  }
  return { vertices, indices, vertexCount: posAcc.count, triangleCount: indices ? indices.length / 3 : 0, name: meshName }
}

export function extractMeshFromGLB(filepath, meshIndex = 0) {
  const { buf, json, binOffset } = readGLB(filepath)
  const mesh = json.meshes?.[meshIndex]
  if (!mesh) throw new Error(`Mesh index ${meshIndex} not found`)
  const prim = mesh.primitives[0]
  if (prim.extensions?.KHR_draco_mesh_compression) throw new Error('Draco-compressed mesh detected. Use extractMeshFromGLBAsync() instead.')
  if (json.bufferViews?.some(bv => bv.extensions?.EXT_meshopt_compression)) throw new Error('Meshopt-compressed mesh detected. Decompress with gltfpack first.')
  const result = extractStandardMesh(buf, json, prim, binOffset, mesh.name)
  const nodeIdx = (json.nodes || []).findIndex(n => n.mesh === meshIndex)
  if (nodeIdx >= 0) result.vertices = applyTransformMatrix(result.vertices, buildNodeTransforms(json)[nodeIdx])
  return result
}

export async function extractMeshFromGLBAsync(filepath, meshIndex = 0) {
  const { buf, json, binOffset } = await readGLBAsync(filepath)
  if (!json.meshes?.length) throw new Error('GLB has no meshes')
  const mesh = json.meshes[meshIndex]
  if (!mesh) throw new Error(`Mesh index ${meshIndex} not found`)
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
  if (nodeIdx >= 0) result.vertices = applyTransformMatrix(result.vertices, buildNodeTransforms(json)[nodeIdx])
  return result
}

export async function extractAllMeshesFromGLBAsync(filepath) {
  const { buf, json, binOffset } = await readGLBAsync(filepath)
  const nodeTransforms = buildNodeTransforms(json)
  const materials = json.materials || []
  const allVertices = [], allIndices = []
  let vertexOffset = 0, totalTriangles = 0

  for (let meshIdx = 0; meshIdx < (json.meshes || []).length; meshIdx++) {
    const mesh = json.meshes[meshIdx]
    const nodeIdx = (json.nodes || []).findIndex(n => n.mesh === meshIdx)
    const worldTransform = nodeIdx >= 0 ? nodeTransforms[nodeIdx] : null
    for (let primIdx = 0; primIdx < mesh.primitives.length; primIdx++) {
      const prim = mesh.primitives[primIdx]
      const matName = prim.material !== undefined ? (materials[prim.material]?.name || '') : ''
      if (SKIP_MATS.has(matName)) continue
      let result
      try {
        result = prim.extensions?.KHR_draco_mesh_compression
          ? await decompressDracoMesh(buf, json, prim, binOffset, mesh.name)
          : extractStandardMesh(buf, json, prim, binOffset, mesh.name)
      } catch (e) { console.warn(`[GLBLoader] Skipping mesh[${meshIdx}] prim[${primIdx}]: ${e.message}`); continue }
      if (!result.indices || result.triangleCount === 0) continue
      const verts = worldTransform ? applyTransformMatrix(result.vertices, worldTransform) : result.vertices
      allVertices.push(verts)
      const remapped = new Uint32Array(result.indices.length)
      for (let i = 0; i < result.indices.length; i++) remapped[i] = result.indices[i] + vertexOffset
      allIndices.push(remapped)
      vertexOffset += result.vertexCount
      totalTriangles += result.triangleCount
    }
  }

  if (allVertices.length === 0) throw new Error('No valid mesh primitives found in GLB')
  const combinedVertices = new Float32Array(vertexOffset * 3)
  let vOff = 0
  for (const v of allVertices) { combinedVertices.set(v, vOff); vOff += v.length }
  const combinedIndices = new Uint32Array(totalTriangles * 3)
  let iOff = 0
  for (const idx of allIndices) { combinedIndices.set(idx, iOff); iOff += idx.length }
  return { vertices: combinedVertices, indices: combinedIndices, vertexCount: vertexOffset, triangleCount: totalTriangles }
}

export function detectDracoInGLB(filepath) {
  try {
    const { json } = readGLB(filepath)
    const hasMeshoptGlobally = (json.bufferViews || []).some(bv => bv.extensions?.EXT_meshopt_compression)
    const meshes = (json.meshes || []).map(mesh => ({
      name: mesh.name || 'unnamed',
      hasDraco: mesh.primitives?.some(p => p.extensions?.KHR_draco_mesh_compression) || false,
      hasMeshopt: hasMeshoptGlobally || mesh.primitives?.some(p => p.extensions?.EXT_meshopt_compression) || false
    }))
    return { hasDraco: meshes.some(m => m.hasDraco), hasMeshopt: meshes.some(m => m.hasMeshopt), meshes }
  } catch (e) {
    return { hasDraco: false, hasMeshopt: false, meshes: [], error: e.message }
  }
}
