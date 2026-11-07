import * as THREE from 'three'
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from '../client/vendor/three-mesh-bvh.module.js'
import { createXRWidgets } from '../client/xr/XRWidgets.js'

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

const scene = new THREE.Scene()
const terrain = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000, 400, 400), new THREE.MeshBasicMaterial())
terrain.rotation.x = -Math.PI / 2
scene.add(terrain)
const prop = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
prop.position.set(5, 1, 5)
scene.add(prop)
scene.updateMatrixWorld(true)

const terrainTriangles = terrain.geometry.index.count / 3
const beforeInit = terrain.geometry.boundsTree === undefined
const widgets = createXRWidgets(scene, new THREE.PerspectiveCamera(), { teleportEnabled: true, vignetteEnabled: false }, () => true)
widgets.initTeleport()
const warmed = terrain.geometry.boundsTree !== undefined
const propSkipped = prop.geometry.boundsTree === undefined

console.log(`terrain triangles=${terrainTriangles}; boundsTree before initTeleport=${beforeInit ? 'absent' : 'present'}; after initTeleport=${warmed ? 'built' : 'absent'}; 12-triangle prop skipped=${propSkipped}`)
const pass = beforeInit && warmed && propSkipped
console.log(`RESULT: ${pass ? 'PASS' : 'FAIL'} the teleport ground trees for large terrain are built at initTeleport, so the first aim does not pay the build`)
process.exitCode = pass ? 0 : 1
