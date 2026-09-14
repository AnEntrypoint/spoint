export function shouldSwapMaterials(deviceInfo) {
  return !!deviceInfo && deviceInfo.gpuTier === 'low';
}

export function shouldStripNormalMaps(deviceInfo) {
  return !!deviceInfo && deviceInfo.gpuTier === 'low' && deviceInfo.isMobile === true;
}

const _copyKeys = [
  'color', 'map', 'lightMap', 'lightMapIntensity', 'aoMap', 'aoMapIntensity',
  'emissive', 'emissiveMap', 'emissiveIntensity', 'alphaMap', 'envMap',
  'combine', 'reflectivity', 'refractionRatio', 'wireframe', 'wireframeLinewidth',
  'specularMap', 'transparent', 'opacity', 'side', 'alphaTest', 'alphaHash',
  'depthTest', 'depthWrite', 'toneMapped', 'vertexColors', 'fog', 'flatShading',
  'skinning', 'morphTargets', 'morphNormals', 'polygonOffset', 'polygonOffsetFactor',
  'polygonOffsetUnits', 'name', 'userData',
];

function _swapOne(mat, useLambert, stripNormalMaps) {
  if (!mat || mat._lowTierSwapped) return mat;
  const isStandardLike = mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial;
  if (!isStandardLike) return mat;
  const Ctor = useLambert ? THREE_Lambert : THREE_Phong;
  const swapped = new Ctor();
  for (const k of _copyKeys) {
    if (mat[k] !== undefined) swapped[k] = mat[k];
  }
  if (!stripNormalMaps && mat.normalMap && !useLambert) {
    swapped.normalMap = mat.normalMap;
    swapped.normalScale = mat.normalScale ? mat.normalScale.clone() : swapped.normalScale;
  }
  if (useLambert && mat.metalness != null && swapped.color && mat.metalness > 0.5 && mat.color) {
    swapped.color = mat.color.clone();
  }
  swapped._lowTierSwapped = true;
  swapped.needsUpdate = true;
  return swapped;
}

let THREE_Lambert = null;
let THREE_Phong = null;
export function setThreeRef(THREE) {
  THREE_Lambert = THREE.MeshLambertMaterial;
  THREE_Phong = THREE.MeshPhongMaterial;
}

export function applyLowTierMaterials(root, deviceInfo) {
  const doSwap = shouldSwapMaterials(deviceInfo);
  const doStripNormals = shouldStripNormalMaps(deviceInfo);
  if (!doSwap && !doStripNormals) return { swapped: 0, normalMapsStripped: 0, scanned: 0 };
  if (!THREE_Lambert || !THREE_Phong) throw new Error('applyLowTierMaterials: setThreeRef(THREE) must be called before a low-tier swap');
  const useLambert = !!(deviceInfo && deviceInfo.isMobile);
  let swapped = 0, normalMapsStripped = 0, scanned = 0;
  const swappedByOriginal = new Map();
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    scanned++;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const next = mats.map((m) => {
      if (!m) return m;
      if (doStripNormals && m.normalMap) { m.normalMap = null; m.needsUpdate = true; normalMapsStripped++; }
      if (!doSwap) return m;
      if (swappedByOriginal.has(m)) return swappedByOriginal.get(m);
      const wasStandardLike = m.isMeshStandardMaterial || m.isMeshPhysicalMaterial;
      const out = _swapOne(m, useLambert, doStripNormals);
      swappedByOriginal.set(m, out);
      if (wasStandardLike && out !== m) swapped++;
      return out;
    });
    obj.material = Array.isArray(obj.material) ? next : next[0];
  });
  return { swapped, normalMapsStripped, scanned };
}
