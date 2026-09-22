import * as THREE from 'three/webgpu';
import { texture, uv, attribute, int } from 'three/tsl';

export function buildArrayMaterialTSL(arrayTexture, seedMaterial) {
  const material = new THREE.MeshStandardNodeMaterial({
    roughness: seedMaterial.roughness ?? 0.8,
    metalness: seedMaterial.metalness ?? 0.0,
    side: seedMaterial.side ?? THREE.FrontSide,
    shadowSide: seedMaterial.shadowSide ?? null,
    alphaTest: seedMaterial.alphaTest ?? 0,
    transparent: seedMaterial.transparent ?? false,
  });
  material.name = 'texture-array-atlas-material-tsl';
  const layerIndex = attribute('layerIndex', 'float');
  material.colorNode = texture(arrayTexture, uv()).depth(int(layerIndex));
  material.userData.isTextureArrayAtlas = true;
  return material;
}

export default { buildArrayMaterialTSL };
