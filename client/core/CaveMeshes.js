import * as THREE from 'three'
import { polygonizeCaveVolume, loadCaveCarveLayer } from '/src/terrain/CaveSDF.js'

// All cave volumes share ONE material and never move, so they are merged into ONE BufferGeometry /
// ONE Mesh (one draw, one scene child, one frustum test) instead of one Mesh per volume. Vertex
// normals are computed on the merged geometry: no index ever references a vertex of another volume
// (each volume's index range is offset by its own vertex base), so the per-vertex face-adjacency
// computeVertexNormals() sees is identical to the per-volume result -- byte-identical normals.
function buildMergedGeometry(volumes, res) {
  const parts = []
  let vc = 0, ic = 0
  for (const vol of volumes) {
    const mesh = polygonizeCaveVolume(vol, res)
    if (mesh.vc === 0) continue
    parts.push(mesh)
    vc += mesh.vc; ic += mesh.ic
  }
  if (parts.length === 0) return { geometry: null, volumeCount: 0 }
  const positions = new Float32Array(vc * 3)
  const indices = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic)
  let vBase = 0, iBase = 0
  for (const mesh of parts) {
    positions.set(mesh.positions.subarray(0, mesh.vc * 3), vBase * 3)
    const src = mesh.indices
    for (let i = 0; i < mesh.ic; i++) indices[iBase + i] = src[i] + vBase
    vBase += mesh.vc; iBase += mesh.ic
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setIndex(new THREE.BufferAttribute(indices, 1))
  g.computeVertexNormals()
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return { geometry: g, volumeCount: parts.length }
}

export function createCaveMeshes({ scene, cfg, res = 24 }) {
  const group = new THREE.Group()
  group.name = 'cave-meshes'
  const material = new THREE.MeshStandardMaterial({ color: 0x2a2a2c, roughness: 0.95, metalness: 0.0, side: THREE.BackSide })
  const objects = []
  const volumesSpec = Array.isArray(cfg) ? cfg : []
  const layer = loadCaveCarveLayer({ version: 2, volumes: volumesSpec })
  const { geometry, volumeCount } = buildMergedGeometry(layer.volumes, res)
  if (geometry) {
    const obj = new THREE.Mesh(geometry, material)
    obj.matrixAutoUpdate = false
    obj.updateMatrix()
    group.add(obj); objects.push(obj)
  }
  if (scene) scene.add(group)

  function dispose() {
    for (const obj of objects) { obj.geometry.dispose(); scene && scene.remove(obj) }
    objects.length = 0
    scene && scene.remove(group)
    material.dispose()
  }

  // volumeCount reports the number of polygonized volumes folded into the single merged mesh (the
  // pre-merge per-volume mesh count), not objects.length (now 0 or 1).
  const api = { group, objects, dispose, get volumeCount() { return objects.length ? volumeCount : 0 } }
  if (typeof window !== 'undefined') window.__caveMeshes = api
  return api
}
