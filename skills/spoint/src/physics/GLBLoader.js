import { readFileSync } from 'node:fs'

export function extractMeshFromGLB(filepath, meshIndex = 0) {
  const buf = readFileSync(filepath)
  if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('Not a GLB file')
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.toString('utf-8', 20, 20 + jsonLen))
  const binOffset = 20 + jsonLen + 8
  const mesh = json.meshes[meshIndex]
  if (!mesh) throw new Error(`Mesh index ${meshIndex} not found`)
  const prim = mesh.primitives[0]
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
  return { vertices, indices, vertexCount: posAcc.count, triangleCount: indices ? indices.length / 3 : 0, name: mesh.name }
}
