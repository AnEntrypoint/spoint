/*! @license MIT (c) Andrea Gargaro -- vendored from @three.ez/octahedron-imposter (https://github.com/agargaro/octahedral-impostor) */

export const ATLAS_VERTEX = `
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

export const ATLAS_FRAGMENT = `
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
  gAlbedo = diffuseColor;
  #ifdef PREMULTIPLIED_ALPHA
    gAlbedo.rgb *= gAlbedo.a;
  #endif

  #include <normal_fragment_begin>
  #include <normal_fragment_maps>

  float fragCoordZ = 0.5 * vHighPrecisionZW[ 0 ] / vHighPrecisionZW[ 1 ] + 0.5;
  gNormalDepth = vec4( packNormalToRGB( normal ), 1.0 - fragCoordZ );
}`;

export const IMPOSTOR_PARAMS_VERTEX = `
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
attribute float instanceFade;
flat varying float vFade;
#endif

#ifdef EZ_PARALLAX
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

export const IMPOSTOR_VERTEX = `
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

export const IMPOSTOR_PARAMS_FRAGMENT = `
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

vec2 parallaxOffsetUV(vec2 uv, vec2 cellBase, float cellSize, vec3 tangent, vec3 bitangent, vec3 normal) {
  float depth = texture(normalMap, uv).a;
  vec3 viewTS = vec3(dot(vViewDirLocal, tangent), dot(vViewDirLocal, bitangent), dot(vViewDirLocal, normal));
  vec2 offset = viewTS.xy * ((depth - 0.5) * uParallaxScale);
  return clamp(uv + offset, cellBase, cellBase + vec2(cellSize));
}
#endif

#ifdef EZ_USE_NORMAL
vec3 blendNormals(vec2 uv1, vec2 uv2, vec2 uv3) {
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
#endif

#ifdef EZ_FADE
flat varying float vFade;
float ezFadeDither(vec2 fragCoord) {
  return fract(52.9829189 * fract(dot(fragCoord, vec2(0.06711056, 0.00583715))));
}
#endif
`;

export const IMPOSTOR_MAP_FRAGMENT = `
float spriteSize = 1.0 / spritesPerSide;

vec2 uv1 = getUV(vSpriteUV1, vSprite1, spriteSize);
vec2 uv2 = getUV(vSpriteUV2, vSprite2, spriteSize);
vec2 uv3 = getUV(vSpriteUV3, vSprite3, spriteSize);

#ifdef EZ_PARALLAX
uv1 = parallaxOffsetUV(uv1, vSprite1 * spriteSize, spriteSize, vSpriteTangent1, vSpriteBitangent1, normalize(cross(vSpriteTangent1, vSpriteBitangent1)));
uv2 = parallaxOffsetUV(uv2, vSprite2 * spriteSize, spriteSize, vSpriteTangent2, vSpriteBitangent2, normalize(cross(vSpriteTangent2, vSpriteBitangent2)));
uv3 = parallaxOffsetUV(uv3, vSprite3 * spriteSize, spriteSize, vSpriteTangent3, vSpriteBitangent3, normalize(cross(vSpriteTangent3, vSpriteBitangent3)));
#endif
#ifdef EZ_ATLAS_TILE
vec2 ezTileBase = vec2(mod(atlasTile, uAtlasGridSide), floor(atlasTile / uAtlasGridSide));
uv1 = (ezTileBase + uv1) * uAtlasTileScale;
uv2 = (ezTileBase + uv2) * uAtlasTileScale;
uv3 = (ezTileBase + uv3) * uAtlasTileScale;
#endif

vec4 sprite1, sprite2, sprite3;
float test = 1.0 - alphaClamp;

#ifdef EZ_FAR_SINGLE_SPRITE
{
  vec2 uvBest = uv1;
  if (vSpritesWeight.y >= vSpritesWeight.x && vSpritesWeight.y >= vSpritesWeight.z) uvBest = uv2;
  else if (vSpritesWeight.z >= vSpritesWeight.x && vSpritesWeight.z >= vSpritesWeight.y) uvBest = uv3;
  sprite1 = texture(map, uvBest);
  if (sprite1.a <= alphaClamp) discard;
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
if (ezFadeDither(gl_FragCoord.xy) > vFade) discard;
#endif

#ifndef EZ_TRANSPARENT
blendedColor = vec4(vec3(blendedColor.rgb) / blendedColor.a, 1.0);
#endif
`;

export const IMPOSTOR_NORMAL_FRAGMENT_BEGIN = `
#ifdef EZ_FAR_SINGLE_SPRITE
vec3 normal = texture(normalMap, uv1).rgb * 2.0 - 1.0;
#else
vec3 normal = blendNormals(uv1, uv2, uv3);
#endif
vec3 nonPerturbedNormal = normal;
`;
