import * as THREE from 'three';

const LAYER_INDEX_ATTR = 'layerIndex';
const MIN_CONSOLIDATION_GROUP_SIZE = 2;
const MAX_ARRAY_LAYER_DIM = 1024;

export function isArrayAtlasCandidate(material) {
  if (!material || !material.isMeshStandardMaterial && !material.isMeshBasicMaterial && !material.isMeshLambertMaterial && !material.isMeshPhongMaterial) return false;
  if (!material.map) return false;
  const nonBasecolorSlots = ['normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap', 'displacementMap', 'clearcoatMap', 'clearcoatNormalMap'];
  for (const slot of nonBasecolorSlots) {
    if (material[slot]) return false;
  }
  if (material.map.isDataArrayTexture || material.map.isCompressedArrayTexture) return false;
  return true;
}

function _drawLayer(ctx, image, layerW, layerH, dst, layerIdx) {
  if (!image || !(image.width || image.videoWidth)) return false;
  ctx.clearRect(0, 0, layerW, layerH);
  ctx.drawImage(image, 0, 0, layerW, layerH);
  const px = ctx.getImageData(0, 0, layerW, layerH).data;
  dst.set(px, layerIdx * layerW * layerH * 4);
  return true;
}

export function buildTextureArray(entries) {
  if (!entries || entries.length < MIN_CONSOLIDATION_GROUP_SIZE) return null;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;

  let maxW = 1, maxH = 1;
  for (const { texture } of entries) {
    const img = texture.image;
    const w = img ? (img.width || img.videoWidth || 0) : 0;
    const h = img ? (img.height || img.videoHeight || 0) : 0;
    if (w > maxW) maxW = w;
    if (h > maxH) maxH = h;
  }
  maxW = Math.min(maxW, MAX_ARRAY_LAYER_DIM);
  maxH = Math.min(maxH, MAX_ARRAY_LAYER_DIM);

  const canvas = document.createElement('canvas');
  canvas.width = maxW;
  canvas.height = maxH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const layerCount = entries.length;
  const data = new Uint8Array(maxW * maxH * 4 * layerCount);
  const layerOf = new Map();
  let drawn = 0;
  for (let i = 0; i < entries.length; i++) {
    const { material, texture } = entries[i];
    const ok = _drawLayer(ctx, texture.image, maxW, maxH, data, i);
    if (ok) drawn++;
    layerOf.set(material, i);
  }
  if (drawn === 0) return null;

  const arrayTexture = new THREE.DataArrayTexture(data, maxW, maxH, layerCount);
  arrayTexture.format = THREE.RGBAFormat;
  arrayTexture.type = THREE.UnsignedByteType;
  arrayTexture.wrapS = THREE.RepeatWrapping;
  arrayTexture.wrapT = THREE.RepeatWrapping;
  arrayTexture.minFilter = THREE.LinearMipmapLinearFilter;
  arrayTexture.magFilter = THREE.LinearFilter;
  arrayTexture.generateMipmaps = true;
  arrayTexture.colorSpace = THREE.SRGBColorSpace;
  arrayTexture.needsUpdate = true;

  return { arrayTexture, layerOf, width: maxW, height: maxH, layerCount };
}

export function buildArrayMaterial(arrayTexture, seedMaterial) {
  const material = new THREE.MeshStandardMaterial({
    roughness: seedMaterial.roughness ?? 0.8,
    metalness: seedMaterial.metalness ?? 0.0,
    side: seedMaterial.side ?? THREE.FrontSide,
    shadowSide: seedMaterial.shadowSide ?? null,
    alphaTest: seedMaterial.alphaTest ?? 0,
    transparent: seedMaterial.transparent ?? false,
    map: seedMaterial.map,
  });
  material.name = 'texture-array-atlas-material';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uArrayMap = { value: arrayTexture };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float layerIndex;
varying float vLayerIndex;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vLayerIndex = layerIndex;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
precision highp sampler2DArray;
uniform sampler2DArray uArrayMap;
varying float vLayerIndex;`
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture( uArrayMap, vec3( vMapUv, vLayerIndex ) );
  #ifdef DECODE_VIDEO_TEXTURE
    sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );
  #endif
  diffuseColor *= sampledDiffuseColor;
#endif`
      );
  };
  material.needsUpdate = true;
  material.userData.isTextureArrayAtlas = true;
  return material;
}

export function tagGeometryLayer(geometry, layerIndex) {
  const count = geometry.attributes.position ? geometry.attributes.position.count : 0;
  if (!count) return;
  const arr = new Float32Array(count).fill(layerIndex);
  geometry.setAttribute(LAYER_INDEX_ATTR, new THREE.BufferAttribute(arr, 1));
}

export { LAYER_INDEX_ATTR };
export default { isArrayAtlasCandidate, buildTextureArray, buildArrayMaterial, tagGeometryLayer, LAYER_INDEX_ATTR };
