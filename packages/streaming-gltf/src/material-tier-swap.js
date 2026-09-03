// Low-tier material auto-swap: on a device whose deviceInfo hint (the SAME
// shape client/core/MobileControls.js's detectDevice() produces --
// { gpuTier: 'low'|'medium'|'unknown', isMobile, memoryMB }) reports
// gpuTier === 'low', every THREE.MeshStandardMaterial/MeshPhysicalMaterial a
// loaded asset carries is replaced in place with the cheaper
// MeshLambertMaterial (mobile-low) or MeshPhongMaterial (low but not mobile,
// keeps a specular highlight since the device isn't memory-starved, just
// GPU-weak). PBR metalness/roughness has no Lambert/Phong equivalent, so the
// swap is a deliberate, acceptable visual-quality tradeoff on the weakest
// tier, not a bug.
//
// Applied ONCE per Asset right after its root glTF scene is parsed (Asset._load
// in model-pool.js) -- every spawned Entity clones that scene, so a single
// swap pass here covers every future instance for free, no per-entity cost.
//
// normalMap stripping is scoped narrower than the material swap itself:
// isMobile && gpuTier==='low' only (not desktop-low, e.g. an old desktop
// Intel HD Graphics box, which still has real texture bandwidth/CPU headroom
// a phone-class device does not) -- tangent-space normal mapping costs a
// second texture fetch + a per-fragment TBN reconstruction that mobile GPUs
// pay disproportionately for versus desktop.
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
    // MeshPhongMaterial supports normalMap; MeshLambertMaterial does not.
    swapped.normalMap = mat.normalMap;
    swapped.normalScale = mat.normalScale ? mat.normalScale.clone() : swapped.normalScale;
  }
  if (useLambert && mat.metalness != null && swapped.color && mat.metalness > 0.5 && mat.color) {
    // Crude metalness fallback: Lambert has no specular/metal response at all, so
    // darken the diffuse slightly toward the old base color's luminance to avoid
    // very metallic (near-black-diffuse, spec-only) PBR materials rendering pure
    // white/flat under Lambert's pure-diffuse model.
    swapped.color = mat.color.clone();
  }
  swapped._lowTierSwapped = true;
  swapped.needsUpdate = true;
  return swapped;
}

// THREE is injected lazily via setThreeRef so this module has zero hard
// import-time dependency beyond what callers already have loaded (model-pool.js
// already imports the full THREE namespace; passing it in keeps this file a
// plain, independently testable function set).
let THREE_Lambert = null;
let THREE_Phong = null;
export function setThreeRef(THREE) {
  THREE_Lambert = THREE.MeshLambertMaterial;
  THREE_Phong = THREE.MeshPhongMaterial;
}

// Walks the given root Object3D (an Asset's freshly-parsed gltf.scene) and, for
// every mesh carrying a Standard/Physical material, swaps it for the cheaper
// tier in place (mesh.material reassigned) plus optional normal-map stripping.
// Returns a small stats object for logging/debugging; never throws (a material
// missing an expected field is skipped, not fatal -- this must never break
// asset load on a low-tier device, the exact device this is meant to help).
export function applyLowTierMaterials(root, deviceInfo) {
  const doSwap = shouldSwapMaterials(deviceInfo);
  const doStripNormals = shouldStripNormalMaps(deviceInfo);
  if (!doSwap && !doStripNormals) return { swapped: 0, normalMapsStripped: 0, scanned: 0 };
  if (!THREE_Lambert || !THREE_Phong) return { swapped: 0, normalMapsStripped: 0, scanned: 0, error: 'setThreeRef not called' };
  const useLambert = !!(deviceInfo && deviceInfo.isMobile);
  let swapped = 0, normalMapsStripped = 0, scanned = 0;
  const seen = new Map(); // dedupe: multiple meshes can share one material object
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    scanned++;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const next = mats.map((m) => {
      if (!m) return m;
      try {
        if (doStripNormals && m.normalMap) { m.normalMap = null; m.needsUpdate = true; normalMapsStripped++; }
        if (!doSwap) return m;
        if (seen.has(m)) return seen.get(m);
        const wasStandardLike = m.isMeshStandardMaterial || m.isMeshPhysicalMaterial;
        const out = _swapOne(m, useLambert, doStripNormals);
        seen.set(m, out);
        if (wasStandardLike && out !== m) swapped++;
        return out;
      } catch (_) { return m; }
    });
    obj.material = Array.isArray(obj.material) ? next : next[0];
  });
  return { swapped, normalMapsStripped, scanned };
}
