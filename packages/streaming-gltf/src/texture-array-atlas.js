// texture-array-atlas.js -- runtime prop-set consolidation via a shared
// TEXTURE ARRAY (THREE.DataArrayTexture), not a packed 2D atlas.
//
// WHY NOT A 2D ATLAS (measured, not assumed -- see the row's own witness_evidence
// for the real numbers): a classic atlas packs N textures into sub-rectangles of
// one larger page and remaps each primitive's UVs into that sub-rectangle. That
// remap is only safe when every primitive samples its texture within [0,1] (a
// single non-repeating tile) -- REPEAT-wrapped/tiled UVs sampled outside [0,1]
// would bleed into a NEIGHBOURING packed texture's pixels once co-located on one
// page. A real measurement of apps/maps/aim_sillos.glb (env-sillos, the prop set
// this row targets) found ZERO of its 47 materials safe for that: every single
// one has at least one primitive whose TEXCOORD_0 span exceeds [0,1], several by
// 10-800x (typical Source-engine-style level tiling). A 2D atlas would therefore
// require a full UV-unwrap + re-bake pass (a real, separate, much larger
// undertaking) to be safe -- out of scope for a bounded slice.
//
// A texture ARRAY sidesteps the hazard entirely: each source texture keeps its
// OWN layer, addressed as `texture(sampler2DArray, vec3(uv, layer))` in the
// fragment shader. Per-layer sampling still wraps/repeats independently within
// that layer exactly as a standalone 2D texture would -- there is no shared UV
// space between layers to bleed across. The only real constraint is every layer
// must share one width/height (source images are padded into the array's max
// dimensions), which costs some wasted VRAM for smaller textures but changes
// zero rendering behavior (no UV remap, no seams).
//
// SCOPE (measured against env-sillos, generalizes to any prop set matching the
// same shape): applies only to BASECOLOR-ONLY materials (no normal/metallic-
// roughness/emissive/occlusion texture slot) -- confirmed 45/45 textures and
// 47/47 materials in env-sillos are basecolor-only, so this is not a hypothetical
// restriction for the target asset. A material with any other texture slot is
// left untouched (passed through as its own singleton group) rather than
// approximated.
//
// This module builds the CPU-side plan (grouping + the packed DataArrayTexture +
// per-source layer index) from an array of {material, texture} entries taken from
// already-loaded THREE materials (model-pool.js's asset-prepare step, where real
// decoded THREE.Texture images already exist -- no second image-decode pass).
// Wiring this into model-pool.js's clusterMeshes so cluster-material-merge.js's
// existing material-object-identity grouping collapses the now-materially-shared
// meshes into fewer ClusterLodMesh draw calls is a separate, sibling concern
// (see model-pool.js's applyTextureArrayConsolidation for the runtime wiring).

import * as THREE from 'three';

const LAYER_INDEX_ATTR = 'layerIndex';

// A material qualifies for array-consolidation when it has exactly one texture
// slot in use (basecolor) and no others -- the shape measured for env-sillos.
// Anything else (normal maps, MR, emissive, vertex colors interacting with a
// second slot) is left alone; approximating those would risk visible fidelity
// loss this pass is not scoped to evaluate.
export function isArrayAtlasCandidate(material) {
  if (!material || !material.isMeshStandardMaterial && !material.isMeshBasicMaterial && !material.isMeshLambertMaterial && !material.isMeshPhongMaterial) return false;
  if (!material.map) return false;
  const otherSlots = ['normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap', 'displacementMap', 'clearcoatMap', 'clearcoatNormalMap'];
  for (const slot of otherSlots) {
    if (material[slot]) return false;
  }
  if (material.map.isDataArrayTexture || material.map.isCompressedArrayTexture) return false; // already consolidated
  return true;
}

// Draw a THREE.Texture's decoded image (HTMLImageElement / ImageBitmap / Canvas
// -- whichever TextureLoader/ImageBitmapLoader produced, all are valid
// CanvasRenderingContext2D.drawImage sources) into one layer slice of a shared
// RGBA8 Uint8Array, resized (nearest via drawImage's own bilinear scale) to
// (layerW, layerH) if its native size differs. Returns false (layer left
// zero-filled/transparent) if the source image isn't decoded/drawable yet --
// callers should only run this after the source textures report a real image
// (model-pool.js's asset-prepare already awaits the GLTFLoader parse, so this
// is expected to always succeed for a normal load; the false path is a
// defensive fallback, not a silently-accepted common case).
function _drawLayer(ctx, image, layerW, layerH, dst, layerIdx) {
  if (!image || !(image.width || image.videoWidth)) return false;
  ctx.clearRect(0, 0, layerW, layerH);
  ctx.drawImage(image, 0, 0, layerW, layerH);
  const px = ctx.getImageData(0, 0, layerW, layerH).data;
  dst.set(px, layerIdx * layerW * layerH * 4);
  return true;
}

// Build one shared DataArrayTexture from a list of {material, texture} entries
// (already grouped as array-atlas candidates by the caller). Every source image
// is resized into the group's max width/height so all layers share one shape
// (THREE.DataArrayTexture requires uniform dimensions across layers).
//
// Returns { arrayTexture, layerOf: Map<material, layerIndex> } or null if the
// group is too small to be worth consolidating (<2 members) or the environment
// has no canvas 2D context available (non-browser / headless-without-canvas --
// fails safe by leaving the group unconsolidated rather than throwing).
export function buildTextureArray(entries) {
  if (!entries || entries.length < 2) return null;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;

  let maxW = 1, maxH = 1;
  for (const { texture } of entries) {
    const img = texture.image;
    const w = img ? (img.width || img.videoWidth || 0) : 0;
    const h = img ? (img.height || img.videoHeight || 0) : 0;
    if (w > maxW) maxW = w;
    if (h > maxH) maxH = h;
  }
  // Cap array-layer dimension: an unbounded max would let one oversized outlier
  // texture blow up every OTHER layer's VRAM footprint (all layers share one
  // shape). 1024 covers every real texture seen in env-sillos (max 512) with
  // headroom; a source texture larger than this is downsampled into the array,
  // never upsampled beyond it.
  maxW = Math.min(maxW, 1024);
  maxH = Math.min(maxH, 1024);

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
  if (drawn === 0) return null; // nothing decodable -- fail safe, no consolidation

  const arrayTexture = new THREE.DataArrayTexture(data, maxW, maxH, layerCount);
  arrayTexture.format = THREE.RGBAFormat;
  arrayTexture.type = THREE.UnsignedByteType;
  // Preserve REPEAT wrap per-layer (the real, measured UV shape for env-sillos --
  // see this file's header). Sampling wraps within a layer's own [0,1] UV space,
  // never across layers, so this is exactly as safe as each source texture's own
  // original wrap mode.
  arrayTexture.wrapS = THREE.RepeatWrapping;
  arrayTexture.wrapT = THREE.RepeatWrapping;
  arrayTexture.minFilter = THREE.LinearMipmapLinearFilter;
  arrayTexture.magFilter = THREE.LinearFilter;
  arrayTexture.generateMipmaps = true;
  // Colorspace: basecolor textures are authored sRGB; GLTFLoader already set this
  // on each source texture, carry the same convention forward for the array.
  arrayTexture.colorSpace = THREE.SRGBColorSpace;
  arrayTexture.needsUpdate = true;

  return { arrayTexture, layerOf, width: maxW, height: maxH, layerCount };
}

// Build ONE shared MeshStandardMaterial that samples `arrayTexture` by a
// per-vertex `layerIndex` attribute instead of the stock single `map` sampler.
// Every geometry using this material must carry a `layerIndex` BufferAttribute
// (see tagGeometryLayer below) -- without it the shader falls back to layer 0
// (a defined, visible failure mode, never a black/NaN draw).
//
// Base color factor / roughness / metalness scalars are read from `seedMaterial`
// (the first group member) -- env-sillos's real materials all use the glTF
// default 1.0 factors with the visual variation carried entirely by the texture,
// confirmed via this row's factor-variance check finding zero differing factors
// among any shared-texture group; a future asset with real per-material factor
// variance on an array-consolidated group would need per-instance factor
// attributes too, out of scope here since env-sillos doesn't exercise it.
export function buildArrayMaterial(arrayTexture, seedMaterial) {
  const material = new THREE.MeshStandardMaterial({
    roughness: seedMaterial.roughness ?? 0.8,
    metalness: seedMaterial.metalness ?? 0.0,
    side: seedMaterial.side ?? THREE.FrontSide,
    shadowSide: seedMaterial.shadowSide ?? null,
    alphaTest: seedMaterial.alphaTest ?? 0,
    transparent: seedMaterial.transparent ?? false,
    // A real (unused-for-sampling) 2D `map` reference is required so THREE's
    // WebGLPrograms parameter builder emits USE_MAP + the MAP_UV vertex-UV-set
    // define (WebGLProgram.js: `parameters.mapUv` is derived from material.map
    // being set) -- without it `vMapUv` never gets assigned in uv_vertex, and our
    // onBeforeCompile map_fragment override (which reads `vMapUv`) fails to
    // compile with "MAP_UV undeclared" (a real error hit and fixed this session,
    // not a hypothetical). seedMaterial.map is any one of the group's own source
    // textures -- three still allocates its texture unit/sampler declaration for
    // it, but map_fragment below is fully replaced to sample uArrayMap instead,
    // so the stock sampler's actual pixel content is never read.
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
    // USE_MAP/vMapUv are already compiled correctly by three's own WebGLPrograms
    // parameter builder because `material.map` is set (see the constructor above)
    // -- no manual #define needed. The map_fragment override above replaces the
    // stock single-sampler read with the array-texture read; the stock `map`
    // sampler itself is allocated (a real GL texture unit + uniform) but its
    // pixel content is never sampled by the shader we ship.
  };
  material.needsUpdate = true;
  material.userData.isTextureArrayAtlas = true;
  return material;
}

// Stamp a constant-per-vertex `layerIndex` attribute onto `geometry` (every
// vertex gets the same value -- one geometry always belongs to exactly one
// source material/layer). Cheap (one Float32Array the size of the vertex
// count) and safe to call once at asset-prepare time, before the geometry is
// shared read-only across every spawned Entity instance of this asset.
export function tagGeometryLayer(geometry, layerIndex) {
  const count = geometry.attributes.position ? geometry.attributes.position.count : 0;
  if (!count) return;
  const arr = new Float32Array(count).fill(layerIndex);
  geometry.setAttribute(LAYER_INDEX_ATTR, new THREE.BufferAttribute(arr, 1));
}

export { LAYER_INDEX_ATTR };
export default { isArrayAtlasCandidate, buildTextureArray, buildArrayMaterial, tagGeometryLayer, LAYER_INDEX_ATTR };
