// GLSL source strings for octahedral-impostor-ez.js's atlas-capture MRT pass and runtime
// impostor-shader patch. Pure string constants, no dependency on the atlas-baker/material-patch
// functions -- split out as octahedral-impostor-ez.js's single largest contiguous block.
// See that file's own header for the full vendoring/attribution note (from
// @three.ez/octahedron-imposter, MIT, Andrea Gargaro).

// ----------------------------------------------------------------- GLSL ----
// Atlas capture pass (MRT): albedo + packed normal/depth. Merged basic/normal/
// depth material, GLSL3.
export const ATLAS_VERTEX = /* glsl */`
#define NORMAL
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
  varying vec3 vViewPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <normal_pars_vertex>
#include <color_pars_vertex>
varying vec2 vHighPrecisionZW;

void main() {
  #include <uv_vertex>
  #include <color_vertex>
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <defaultnormal_vertex>
  #include <normal_vertex>
  #include <begin_vertex>
  #include <displacementmap_vertex>
  #include <project_vertex>

  vHighPrecisionZW = gl_Position.zw;

#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
  vViewPosition = - mvPosition.xyz;
#endif
}`;

export const ATLAS_FRAGMENT = /* glsl */`
#define NORMAL
uniform vec3 diffuse;
uniform float opacity;
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
  varying vec3 vViewPosition;
#endif
#include <packing>
#include <normal_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <common>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
varying vec2 vHighPrecisionZW;

layout(location = 0) out vec4 gAlbedo;
layout(location = 1) out vec4 gNormalDepth;

void main() {
  vec4 diffuseColor = vec4( diffuse, opacity );
  #include <map_fragment>
  #include <color_fragment>
  #include <alphamap_fragment>
  #include <alphatest_fragment>
  #include <alphahash_fragment>

  if (diffuseColor.a <= 0.2) {
    discard;
  }

  #ifdef OPAQUE
    diffuseColor.a = 1.0;
  #endif
  #ifdef USE_TRANSMISSION
    diffuseColor.a *= material.transmissionAlpha;
  #endif
  // Stay in linear space: this target is DATA (an albedo atlas re-sampled by the runtime impostor
  // shader as a plain texture read, see IMPOSTOR_MAP_FRAGMENT), not a screen framebuffer -- encoding
  // to the renderer's OUTPUT color space (srgb) here while createAtlasRenderTarget tags the target
  // LinearSRGBColorSpace (i.e. "already linear, don't decode on sample") double-converts: bytes end
  // up sRGB-encoded but get read back as if linear, crushing every baked color toward black uniformly
  // (verified live: renderer.outputColorSpace='srgb', rt tagged LinearSRGBColorSpace, atlas sampled
  // near-black 0-47/255 across all species tiles while the same trees render correct color close-up).
  gAlbedo = diffuseColor;
  #ifdef PREMULTIPLIED_ALPHA
    gAlbedo.rgb *= gAlbedo.a;
  #endif

  #include <normal_fragment_begin>
  #include <normal_fragment_maps>

  float fragCoordZ = 0.5 * vHighPrecisionZW[ 0 ] / vHighPrecisionZW[ 1 ] + 0.5;
  gNormalDepth = vec4( packNormalToRGB( normal ), 1.0 - fragCoordZ );
}`;

// Impostor runtime chunks (patched into MeshStandardMaterial). The
// encode/decode functions implement BOTH hemi- and full-octahedron (the
// upstream full path was a TODO; filled here as the exact inverse of the JS
// octaGridToDir used by the atlas baker, so bake and render agree).
export const IMPOSTOR_PARAMS_VERTEX = /* glsl */`
#include <clipping_planes_pars_vertex>

uniform mat4 impostorTransform;
uniform float spritesPerSide;

flat varying vec4 vSpritesWeight;
flat varying vec2 vSprite1;
flat varying vec2 vSprite2;
flat varying vec2 vSprite3;
varying vec2 vSpriteUV1;
varying vec2 vSpriteUV2;
varying vec2 vSpriteUV3;

#ifdef EZ_FADE
// Per-instance crossfade amount, 0 = fully transparent (mesh-only LOD still owns this pixel) ->
// 1 = fully opaque impostor. Declared as an actual InstancedBufferAttribute (instanceFade) on the
// per-asset THREE.InstancedMesh in octahedral-impostor-ez-tier.js (mirrors the existing per-instance
// instanceMatrix, not the InstancedMesh2-only initUniformsPerInstance mechanism VegImpostorTier's
// atlasTile uses -- model-pool's tier is a plain THREE.InstancedMesh).
attribute float instanceFade;
flat varying float vFade;
#endif

#ifdef EZ_PARALLAX
// Depth-offset UV sampling (parallax-corrected impostor): each blended sprite's flat plane-projected
// UV reads as if it were a flat card, so a close-range impostor looks visibly billboard-flat versus
// the real geometry it replaces. ATLAS_FRAGMENT already packs 1.0-fragCoordZ (near=1, far=0) into
// the normalDepth atlas's alpha channel per texel; IMPOSTOR_MAP_FRAGMENT re-samples that depth at the
// flat UV first, then offsets the UV along the VIEW DIRECTION projected into EACH sprite's own
// tangent/bitangent plane basis before the real color/normal sample -- so nearer texels (larger 1-z)
// visibly shift toward the viewer, producing real per-fragment parallax instead of a flat card. The
// offset is computed in the SAME per-sprite plane basis projectToPlaneUV already builds (tangent,
// bitangent, normal), so it needs that basis passed through to the fragment stage per blended sprite.
flat varying vec3 vViewDirLocal;
flat varying vec3 vSpriteTangent1;
flat varying vec3 vSpriteBitangent1;
flat varying vec3 vSpriteTangent2;
flat varying vec3 vSpriteBitangent2;
flat varying vec3 vSpriteTangent3;
flat varying vec3 vSpriteBitangent3;
#endif

vec2 encodeDirection(vec3 direction) {
  #ifdef EZ_USE_HEMI_OCTAHEDRON
  vec3 octahedron = direction / dot(direction, sign(direction));
  return vec2(1.0 + octahedron.x + octahedron.z, 1.0 + octahedron.z - octahedron.x) * 0.5;
  #else
  // Full octahedron: inverse of octaGridToDir (y up). Normalize to the L1
  // octahedron, fold the lower hemisphere, map square [-1,1] -> grid [0,1].
  vec3 o = direction / (abs(direction.x) + abs(direction.y) + abs(direction.z));
  float ox = o.x;
  float oz = o.z;
  if (o.y < 0.0) {
    ox = (o.x >= 0.0 ? 1.0 : -1.0) * (1.0 - abs(o.z));
    oz = (o.z >= 0.0 ? 1.0 : -1.0) * (1.0 - abs(o.x));
  }
  return vec2(ox * 0.5 + 0.5, oz * 0.5 + 0.5);
  #endif
}

vec3 decodeDirection(vec2 gridIndex, vec2 spriteCountMinusOne) {
  vec2 gridUV = gridIndex / spriteCountMinusOne;

  #ifdef EZ_USE_HEMI_OCTAHEDRON
  vec3 position = vec3(gridUV.x - gridUV.y, 0.0, -1.0 + gridUV.x + gridUV.y);
  position.y = 1.0 - abs(position.x) - abs(position.z);
  #else
  vec3 position = vec3(2.0 * (gridUV.x - 0.5), 0.0, 2.0 * (gridUV.y - 0.5));
  float ax = abs(position.x);
  float az = abs(position.z);
  position.y = 1.0 - ax - az;
  if (position.y < 0.0) {
    position.x = (position.x >= 0.0 ? 1.0 : -1.0) * (1.0 - az);
    position.z = (position.z >= 0.0 ? 1.0 : -1.0) * (1.0 - ax);
  }
  #endif

  return normalize(position);
}

void computePlaneBasis(vec3 normal, out vec3 tangent, out vec3 bitangent) {
  vec3 up = vec3(0.0, 1.0, 0.0);
  if(normal.y > 0.999)
    up = vec3(-1.0, 0.0, 0.0);
  #ifndef EZ_USE_HEMI_OCTAHEDRON
  if(normal.y < -0.999)
    up = vec3(1.0, 0.0, 0.0);
  #endif
  tangent = normalize(cross(up, normal));
  bitangent = cross(normal, tangent);
}

vec3 projectVertex(vec3 normal) {
  vec3 x, y;
  computePlaneBasis(normal, x, y);
  return x * position.x + y * position.y;
}

void computeSpritesWeight(vec2 gridFract) {
  vSpritesWeight = vec4(min(1.0 - gridFract.x, 1.0 - gridFract.y), abs(gridFract.x - gridFract.y), min(gridFract.x, gridFract.y), ceil(gridFract.x - gridFract.y));
}

vec2 projectToPlaneUV(vec3 normal, vec3 tangent, vec3 bitangent, vec3 cameraPosition, vec3 viewDir) {
  float denom = dot(viewDir, normal);
  float t = -dot(cameraPosition, normal) / denom;
  vec3 hit = cameraPosition + viewDir * t;
  vec2 uv = vec2(dot(tangent, hit), dot(bitangent, hit));
  return uv + 0.5;
}

vec3 projectDirectionToBasis(vec3 dir, vec3 normal, vec3 tangent, vec3 bitangent) {
  return vec3(dot(dir, tangent), dot(dir, bitangent), dot(dir, normal));
}
`;

export const IMPOSTOR_VERTEX = /* glsl */`
#ifdef EZ_FADE
vFade = instanceFade;
#endif
vec2 spritesMinusOne = vec2(spritesPerSide - 1.0);

#if defined USE_INSTANCING || defined USE_INSTANCING_INDIRECT
mat4 transformedInstanceMatrix = instanceMatrix * impostorTransform;
vec3 cameraPosLocal = (inverse(transformedInstanceMatrix * modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
#else
vec3 cameraPosLocal = (inverse(impostorTransform * modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
#endif

vec3 cameraDir = normalize(cameraPosLocal);

vec3 projectedVertex = projectVertex(cameraDir);
vec3 viewDirLocal = normalize(projectedVertex - cameraPosLocal);

vec2 grid = encodeDirection(cameraDir) * spritesMinusOne;
vec2 gridFloor = min(floor(grid), spritesMinusOne);

vec2 gridFract = fract(grid);

computeSpritesWeight(gridFract);

vSprite1 = gridFloor;
vSprite2 = min(vSprite1 + mix(vec2(0.0, 1.0), vec2(1.0, 0.0), vSpritesWeight.w), spritesMinusOne);
vSprite3 = min(vSprite1 + vec2(1.0), spritesMinusOne);

vec3 spriteNormal1 = decodeDirection(vSprite1, spritesMinusOne);
vec3 spriteNormal2 = decodeDirection(vSprite2, spritesMinusOne);
vec3 spriteNormal3 = decodeDirection(vSprite3, spritesMinusOne);

vec3 planeX1, planeY1, planeX2, planeY2, planeX3, planeY3;
computePlaneBasis(spriteNormal1, planeX1, planeY1);
computePlaneBasis(spriteNormal2, planeX2, planeY2);
computePlaneBasis(spriteNormal3, planeX3, planeY3);

vSpriteUV1 = projectToPlaneUV(spriteNormal1, planeX1, planeY1, cameraPosLocal, viewDirLocal);
vSpriteUV2 = projectToPlaneUV(spriteNormal2, planeX2, planeY2, cameraPosLocal, viewDirLocal);
vSpriteUV3 = projectToPlaneUV(spriteNormal3, planeX3, planeY3, cameraPosLocal, viewDirLocal);

#ifdef EZ_PARALLAX
vViewDirLocal = viewDirLocal;
vSpriteTangent1 = planeX1; vSpriteBitangent1 = planeY1;
vSpriteTangent2 = planeX2; vSpriteBitangent2 = planeY2;
vSpriteTangent3 = planeX3; vSpriteBitangent3 = planeY3;
#endif

vec4 mvPosition = vec4(projectedVertex, 1.0);

#if defined USE_INSTANCING || defined USE_INSTANCING_INDIRECT
    mvPosition = transformedInstanceMatrix * mvPosition;
# else
    mvPosition = impostorTransform * mvPosition;
#endif

mvPosition = modelViewMatrix * mvPosition;

gl_Position = projectionMatrix * mvPosition;
`;

export const IMPOSTOR_PARAMS_FRAGMENT = /* glsl */`
#include <clipping_planes_pars_fragment>

uniform float spritesPerSide;
uniform float alphaClamp;

#ifdef EZ_USE_ORM
uniform sampler2D ormMap;
#endif

flat varying vec4 vSpritesWeight;
flat varying vec2 vSprite1;
flat varying vec2 vSprite2;
flat varying vec2 vSprite3;
varying vec2 vSpriteUV1;
varying vec2 vSpriteUV2;
varying vec2 vSpriteUV3;

#ifdef EZ_PARALLAX
uniform float uParallaxScale;
flat varying vec3 vViewDirLocal;
flat varying vec3 vSpriteTangent1;
flat varying vec3 vSpriteBitangent1;
flat varying vec3 vSpriteTangent2;
flat varying vec3 vSpriteBitangent2;
flat varying vec3 vSpriteTangent3;
flat varying vec3 vSpriteBitangent3;

// Depth-offset UV: sample the packed depth (normalMap.a = 1-fragCoordZ, near=1/far=0) at the flat
// (pre-atlas-tile-remap, i.e. this sprite's OWN [cellBase, cellBase+cellSize] atlas cell) UV, then push
// the UV opposite the view direction proportional to (depth - 0.5) so nearer texels shift toward the
// viewer -- the standard parallax-offset-mapping trick, applied per blended sprite in ITS OWN
// tangent/bitangent plane basis (each of the 3 blended sprites has a different view-aligned plane, so
// the offset direction differs per sprite). Clamped to cellBase..cellBase+cellSize -- NOT [0,1] --
// so the offset can never sample a neighboring octahedral cell (or, once EZ_ATLAS_TILE is active,
// bleed into a different asset's tile of the mega atlas): worst case the sample clamps flat at this
// sprite's own cell edge, a bounded stretch artifact rather than a wrong-view/wrong-asset sample.
vec2 parallaxOffsetUV(vec2 uv, vec2 cellBase, float cellSize, vec3 tangent, vec3 bitangent, vec3 normal) {
  float depth = texture(normalMap, uv).a; // 1 = nearest, 0 = farthest within this sprite's capture
  vec3 viewTS = vec3(dot(vViewDirLocal, tangent), dot(vViewDirLocal, bitangent), dot(vViewDirLocal, normal));
  vec2 offset = viewTS.xy * ((depth - 0.5) * uParallaxScale);
  return clamp(uv + offset, cellBase, cellBase + vec2(cellSize));
}
#endif

#ifdef EZ_USE_NORMAL
vec3 blendNormals(vec2 uv1, vec2 uv2, vec2 uv3) {
  // inline the unpack (rgb*2-1) instead of three's unpackRGBToNormal: this function is injected at
  // the clipping_planes_pars_fragment slot which is AFTER #include <packing> is consumed, so the
  // helper is undeclared there (witnessed: 'unpackRGBToNormal no matching overloaded function').
  vec3 normalDepth1 = texture(normalMap, uv1).rgb * 2.0 - 1.0;
  vec3 normalDepth2 = texture(normalMap, uv2).rgb * 2.0 - 1.0;
  vec3 normalDepth3 = texture(normalMap, uv3).rgb * 2.0 - 1.0;
  return normalize(normalDepth1.xyz * vSpritesWeight.x + normalDepth2.xyz * vSpritesWeight.y + normalDepth3.xyz * vSpritesWeight.z);
}
#endif

vec2 getUV(vec2 uv_f, vec2 frame, float frame_size) {
  uv_f = clamp(uv_f, vec2(0), vec2(1));
  uv_f =  frame_size * (frame + uv_f);
  return clamp(uv_f, vec2(0), vec2(1));
}

#ifdef EZ_ATLAS_TILE
uniform float uAtlasGridSide;
uniform float uAtlasTileScale;
// NOTE: the per-instance atlasTile varying is declared by InstancedMesh2 initUniformsPerInstance
// just before main(), so the tile remap is done INLINE in IMPOSTOR_MAP_FRAGMENT (inside main, where
// atlasTile is in scope) -- NOT in a global helper here (which precedes that declaration).
#endif

#ifdef EZ_FADE
flat varying float vFade;
// Screen-space interleaved-gradient-noise dithered discard (Jorge Jimenez, "Next Generation Post
// Processing in Call of Duty: Advanced Warfare") -- a fixed per-pixel threshold pattern independent
// of world/object position, so it applies uniformly to a camera-facing billboard with no seams
// between its 3 blended sprite samples. Threshold-vs-fade (not multiply-into-alpha) keeps the draw
// fully OPAQUE (depthWrite stays on, no back-to-front sort, no translucency blend cost) -- the
// stipple pattern is the entire crossfade, same technique as three's own alphaHash but screen-space
// instead of world-space (a billboard's world position doesn't vary across its own face the way a
// hashed mesh surface needs).
float ezFadeDither(vec2 fragCoord) {
  return fract(52.9829189 * fract(dot(fragCoord, vec2(0.06711056, 0.00583715))));
}
#endif
`;

export const IMPOSTOR_MAP_FRAGMENT = /* glsl */`
float spriteSize = 1.0 / spritesPerSide;

vec2 uv1 = getUV(vSpriteUV1, vSprite1, spriteSize);
vec2 uv2 = getUV(vSpriteUV2, vSprite2, spriteSize);
vec2 uv3 = getUV(vSpriteUV3, vSprite3, spriteSize);

#ifdef EZ_PARALLAX
// Cell base = vSpriteN * spriteSize (same math getUV uses internally for the frame term), computed
// here explicitly so the offset can be clamped to THIS sprite's own cell -- applied pre-atlas-tile-
// remap so it composes correctly with EZ_ATLAS_TILE below (that remap is a pure affine reindex of the
// already-cell-clamped uv into the mega atlas, so offsetting first then remapping == remapping the
// offset cell).
uv1 = parallaxOffsetUV(uv1, vSprite1 * spriteSize, spriteSize, vSpriteTangent1, vSpriteBitangent1, normalize(cross(vSpriteTangent1, vSpriteBitangent1)));
uv2 = parallaxOffsetUV(uv2, vSprite2 * spriteSize, spriteSize, vSpriteTangent2, vSpriteBitangent2, normalize(cross(vSpriteTangent2, vSpriteBitangent2)));
uv3 = parallaxOffsetUV(uv3, vSprite3 * spriteSize, spriteSize, vSpriteTangent3, vSpriteBitangent3, normalize(cross(vSpriteTangent3, vSpriteBitangent3)));
#endif
#ifdef EZ_ATLAS_TILE
// remap each sprite uv into this instance's tile of the mega atlas (atlasTile = species index, in
// scope here inside main). Both the colour samples below AND blendNormals(uv1,uv2,uv3) use these.
vec2 ezTileBase = vec2(mod(atlasTile, uAtlasGridSide), floor(atlasTile / uAtlasGridSide));
uv1 = (ezTileBase + uv1) * uAtlasTileScale;
uv2 = (ezTileBase + uv2) * uAtlasTileScale;
uv3 = (ezTileBase + uv3) * uAtlasTileScale;
#endif

vec4 sprite1, sprite2, sprite3;
float test = 1.0 - alphaClamp;

#ifdef EZ_FAR_SINGLE_SPRITE
// CHEAP FAR PATH (vp-impostor-shader-cost): sample ONLY the single nearest octahedral view (no
// 3-way sprite blend). This is the FARTHEST impostor tier where the ~3x fragment cost of blending
// (3 albedo + 3 normal texture fetches per fragment) buys almost no visible quality -- the tree is a
// few pixels tall. The tradeoff is slight view-popping as the camera orbits (the impostor snaps
// between octa views instead of cross-fading); acceptable at extreme distance. LEVER: enable via the
// material farSingleSprite:true option (define EZ_FAR_SINGLE_SPRITE) for the far/shared tier; the
// nearer impostors keep the full 3-sprite blend below. Picks whichever sprite has the max weight so
// it tracks the dominant view rather than always sprite1.
{
  vec2 uvBest = uv1;
  if (vSpritesWeight.y >= vSpritesWeight.x && vSpritesWeight.y >= vSpritesWeight.z) uvBest = uv2;
  else if (vSpritesWeight.z >= vSpritesWeight.x && vSpritesWeight.z >= vSpritesWeight.y) uvBest = uv3;
  sprite1 = texture(map, uvBest);
  if (sprite1.a <= alphaClamp) discard;
  // collapse uv1..uv3 to the chosen view so blendNormals (below) also samples once-ish via weights.
  uv1 = uvBest; uv2 = uvBest; uv3 = uvBest;
  sprite2 = sprite1; sprite3 = sprite1;
}
#else
if (vSpritesWeight.x >=  test) {
  sprite1 = texture(map, uv1);
  if (sprite1.a <= alphaClamp) discard;
  sprite2 = texture(map, uv2);
  sprite3 = texture(map, uv3);
} else if (vSpritesWeight.y >=  test) {
  sprite2 = texture(map, uv2);
  if (sprite2.a <= alphaClamp) discard;
  sprite1 = texture(map, uv1);
  sprite3 = texture(map, uv3);
} else if (vSpritesWeight.z >=  test) {
  sprite3 = texture(map, uv3);
  if (sprite3.a <= alphaClamp) discard;
  sprite1 = texture(map, uv1);
  sprite2 = texture(map, uv2);
} else {
  sprite1 = texture(map, uv1);
  sprite2 = texture(map, uv2);
  sprite3 = texture(map, uv3);
}
#endif

vec4 blendedColor = sprite1 * vSpritesWeight.x + sprite2 * vSpritesWeight.y + sprite3 * vSpritesWeight.z;

if (blendedColor.a <= alphaClamp) discard;

#ifdef EZ_FADE
// vFade in [0,1]: dither out the fraction (1-vFade) of pixels so the billboard is stochastically
// 0% .. 100% covered across its own face. depthWrite/depthTest are untouched (still fully opaque
// where it DOES draw), so this composes correctly with the real mesh's own opaque draw behind it --
// unlike an alpha-blended fade there is no draw-order dependency between the two LODs.
if (ezFadeDither(gl_FragCoord.xy) > vFade) discard;
#endif

#ifndef EZ_TRANSPARENT
blendedColor = vec4(vec3(blendedColor.rgb) / blendedColor.a, 1.0);
#endif
`;

export const IMPOSTOR_NORMAL_FRAGMENT_BEGIN = /* glsl */`
#ifdef EZ_FAR_SINGLE_SPRITE
// CHEAP FAR PATH (D1): sample ONE normal instead of blending 3. In single-sprite mode uv1 was
// collapsed to the chosen best-sprite uv (IMPOSTOR_MAP_FRAGMENT), so one fetch matches the colour
// path. Replicate blendNormals' inline unpack (rgb*2-1) using texture() (GLSL3, not texture2D).
vec3 normal = texture(normalMap, uv1).rgb * 2.0 - 1.0;
#else
vec3 normal = blendNormals(uv1, uv2, uv3);
#endif
vec3 nonPerturbedNormal = normal;
`;
