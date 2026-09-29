import * as THREE from 'three'

export function makeSeedAttributes(capacity, fillSeed) {
  const seed = new Float32Array(capacity * 4)
  const seed2 = new Float32Array(capacity * 2)
  for (let i = 0; i < capacity; i++) fillSeed(i, seed, seed2)
  return {
    aSeed: new THREE.InstancedBufferAttribute(seed, 4),
    aSeed2: new THREE.InstancedBufferAttribute(seed2, 2),
  }
}

export function makeFieldGeometry(base, seeds) {
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.index = base.index
  for (const name of Object.keys(base.attributes)) geometry.setAttribute(name, base.attributes[name])
  geometry.setAttribute('aSeed', seeds.aSeed)
  geometry.setAttribute('aSeed2', seeds.aSeed2)
  geometry.instanceCount = 0
  return geometry
}

export function makeFieldMesh(geometry, material) {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.visible = false
  return mesh
}

export function fillRainSeed(i, seed) {
  seed[i * 4] = Math.random()
  seed[i * 4 + 1] = Math.random()
  seed[i * 4 + 2] = 0.85 + Math.random() * 0.3
  seed[i * 4 + 3] = Math.random()
}

export function fillSnowSeed(i, seed, seed2) {
  seed[i * 4] = Math.random()
  seed[i * 4 + 1] = Math.random()
  seed[i * 4 + 2] = 0.7 + Math.random() * 0.6
  seed[i * 4 + 3] = Math.random()
  seed2[i * 2] = Math.random() * Math.PI * 2
  seed2[i * 2 + 1] = 0.75 + Math.random() * 0.5
}
