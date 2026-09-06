import * as THREE from 'three'
import { polygonizeCaveVolume, loadCaveCarveLayer } from '/src/terrain/CaveSDF.js'

function buildVolumeMesh(vol, res, material) {
  const mesh = polygonizeCaveVolume(vol, res)
  if (mesh.vc === 0) return null
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(mesh.positions.slice(), 3))
  g.setIndex(new THREE.BufferAttribute(mesh.indices.slice(0, mesh.ic), 1))
  g.computeVertexNormals()
  g.computeBoundingBox()
  g.computeBoundingSphere()
  const obj = new THREE.Mesh(g, material)
  obj.matrixAutoUpdate = false
  obj.updateMatrix()
  return obj
}

export function createCaveMeshes({ scene, cfg, res = 24 }) {
  const group = new THREE.Group()
  group.name = 'cave-meshes'
  const material = new THREE.MeshStandardMaterial({ color: 0x2a2a2c, roughness: 0.95, metalness: 0.0, side: THREE.BackSide })
  const objects = []
  const volumesSpec = Array.isArray(cfg) ? cfg : []
  const layer = loadCaveCarveLayer({ version: 2, volumes: volumesSpec })
  for (const vol of layer.volumes) {
    const obj = buildVolumeMesh(vol, res, material)
    if (obj) { group.add(obj); objects.push(obj) }
  }
  if (scene) scene.add(group)

  function dispose() {
    for (const obj of objects) { obj.geometry.dispose(); scene && scene.remove(obj) }
    objects.length = 0
    scene && scene.remove(group)
    material.dispose()
  }

  const api = { group, objects, dispose, get volumeCount() { return objects.length } }
  if (typeof window !== 'undefined') window.__caveMeshes = api
  return api
}
