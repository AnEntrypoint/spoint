const _cache = new Map()

function materialKey(mat) {
  return [
    mat.type,
    mat.color?.getHexString() ?? '',
    mat.map?.uuid ?? '',
    mat.normalMap?.uuid ?? '',
    mat.roughnessMap?.uuid ?? '',
    mat.metalnessMap?.uuid ?? '',
    mat.emissiveMap?.uuid ?? '',
    mat.aoMap?.uuid ?? '',
    mat.alphaMap?.uuid ?? '',
    mat.roughness ?? '',
    mat.metalness ?? '',
    mat.emissive?.getHexString() ?? '',
    mat.emissiveIntensity ?? '',
    mat.transparent ? 1 : 0,
    mat.alphaTest ?? '',
    mat.side ?? '',
    mat.depthWrite ? 1 : 0,
    mat.morphTargets ? 1 : 0,
  ].join('|')
}

export function deduplicateMaterial(mat) {
  const key = materialKey(mat)
  const cached = _cache.get(key)
  if (cached) return cached
  _cache.set(key, mat)
  return mat
}

export function deduplicateScene(scene) {
  scene.traverse(node => {
    if (!node.isMesh) return
    if (Array.isArray(node.material)) {
      node.material = node.material.map(deduplicateMaterial)
    } else if (node.material) {
      node.material = deduplicateMaterial(node.material)
    }
  })
}

export function clearMaterialCache() {
  _cache.clear()
}
