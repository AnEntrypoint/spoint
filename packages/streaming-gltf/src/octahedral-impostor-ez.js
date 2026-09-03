// Octahedral impostor (lit, sprite-blended) — vendored + localized from
// @three.ez/octahedron-imposter (https://github.com/agargaro/octahedral-impostor),
// MIT License, (c) Andrea Gargaro. Ported TS -> JS, GLSL inlined, the
// full-octahedron encode/decode `// TODO` filled in (inverse of octaGridToDir),
// and the dev-only PNG export util dropped. Runtime dep: three only.
//
// vs the prior bespoke billboard impostor this captures a 2-target atlas
// (albedo + packed normal/depth), blends the 3 nearest octahedral sprites with
// per-sprite plane-projected UVs, and reconstructs normals so the impostor is
// LIT by the scene (baseType is a real MeshStandardMaterial).

import {
  GLSL3, LinearFilter, LinearMipmapLinearFilter, LinearSRGBColorSpace, Matrix4,
  Mesh, MeshStandardMaterial, NearestFilter, NearestMipMapNearestFilter,
  ObjectSpaceNormalMap, OrthographicCamera, PlaneGeometry, ShaderMaterial,
  Sphere, TangentSpaceNormalMap, UnsignedByteType, Vector2, Vector3, Vector4,
  WebGLRenderTarget,
} from 'three';
import {
  ATLAS_VERTEX, ATLAS_FRAGMENT, IMPOSTOR_PARAMS_VERTEX, IMPOSTOR_VERTEX,
  IMPOSTOR_PARAMS_FRAGMENT, IMPOSTOR_MAP_FRAGMENT, IMPOSTOR_NORMAL_FRAGMENT_BEGIN,
} from './octahedral-impostor-shaders.js';

// ------------------------------------------------------------ octa utils ----
const _absolute = new Vector3();

export function hemiOctaGridToDir(grid, target = new Vector3()) {
  target.set(grid.x - grid.y, 0, -1 + grid.x + grid.y);
  target.y = 1 - Math.abs(target.x) - Math.abs(target.z);
  return target;
}

export function octaGridToDir(grid, target = new Vector3()) {
  target.set(2 * (grid.x - 0.5), 0, 2 * (grid.y - 0.5));
  _absolute.set(Math.abs(target.x), 0, Math.abs(target.z));
  target.y = 1 - _absolute.x - _absolute.z;
  if (target.y < 0) {
    target.x = Math.sign(target.x) * (1 - _absolute.z);
    target.z = Math.sign(target.z) * (1 - _absolute.x);
  }
  return target;
}

// ------------------------------------------------ bounding sphere helper ----
const _bsTmp = new Sphere();

// Remember to updateMatrixWorld first if needed.
export function computeObjectBoundingSphere(obj, target = new Sphere(), forceCompute = false) {
  target.makeEmpty();
  traverse(obj);
  return target;

  function traverse(o) {
    if (o.isMesh) {
      const geometry = o.geometry;
      if (forceCompute || !geometry.boundingSphere) geometry.computeBoundingSphere();
      _bsTmp.copy(geometry.boundingSphere).applyMatrix4(o.matrixWorld);
      target.union(_bsTmp);
    }
    for (const child of o.children) traverse(child);
  }
}

// -------------------------------------------------------- atlas baker ----
const _camera = new OrthographicCamera();
const _bSphere = new Sphere();
const _oldScissor = new Vector4();
const _oldViewport = new Vector4();
const _coords = new Vector2();
const USERDATA_MAT_KEY = 'ez_originalMaterial';

// Build the MRT capture material that mirrors a source material's maps but
// outputs albedo (location 0) + packed normal/depth (location 1).
function _makeCaptureMaterial(material) {
  const hasMap = !!material.map;
  const hasAlphaMap = !!material.alphaMap;
  const hasNormalMap = !!material.normalMap;
  const hasBumpMap = !!material.bumpMap;
  const hasDisplacementMap = !!material.displacementMap;
  const hasAlphaTest = material.alphaTest > 0;

  const uniforms = {
    diffuse: { value: material.color },
    opacity: { value: material.opacity },
  };
  if (hasAlphaTest) uniforms.alphaTest = { value: material.alphaTest };
  if (hasMap) { uniforms.map = { value: material.map }; uniforms.mapTransform = { value: material.map.matrix }; }
  if (hasAlphaMap) { uniforms.alphaMap = { value: material.alphaMap }; uniforms.alphaMapTransform = { value: material.alphaMap.matrix }; }
  if (hasNormalMap) { uniforms.normalMap = { value: material.normalMap }; uniforms.normalScale = { value: material.normalScale }; uniforms.normalMapTransform = { value: material.normalMap.matrix }; }
  if (hasBumpMap) { uniforms.bumpMap = { value: material.bumpMap }; uniforms.bumpScale = { value: material.bumpScale }; uniforms.bumpMapTransform = { value: material.bumpMap.matrix }; }
  if (hasDisplacementMap) { uniforms.displacementMap = { value: material.displacementMap }; uniforms.displacementScale = { value: material.displacementScale }; uniforms.displacementBias = { value: material.displacementBias }; uniforms.displacementMapTransform = { value: material.displacementMap.matrix }; }

  const defines = {};
  if (hasMap || hasAlphaMap || hasNormalMap || hasBumpMap || hasDisplacementMap) defines.USE_UV = '';
  if (material.vertexColors) defines.USE_COLOR = '';

  const shaderMaterial = new ShaderMaterial({
    uniforms, defines, vertexShader: ATLAS_VERTEX, fragmentShader: ATLAS_FRAGMENT, glslVersion: GLSL3,
    transparent: material.transparent, side: material.side, alphaHash: material.alphaHash,
    depthFunc: material.depthFunc, depthWrite: material.depthWrite, depthTest: material.depthTest,
    vertexColors: material.vertexColors, precision: material.precision, visible: material.visible,
  });

  shaderMaterial.onBeforeCompile = (shader) => {
    if (hasMap) { shader.map = true; shader.mapUv = 'uv'; }
    if (hasAlphaMap) { shader.alphaMap = true; shader.alphaMapUv = 'uv'; }
    if (hasNormalMap) {
      shader.normalMap = true; shader.normalMapUv = 'uv';
      shader.normalMapTangentSpace = material.normalMapType === TangentSpaceNormalMap;
      shader.normalMapObjectSpace = material.normalMapType === ObjectSpaceNormalMap;
    }
    if (hasBumpMap) { shader.bumpMap = true; shader.bumpMapUv = 'uv'; }
    if (hasDisplacementMap) { shader.displacementMap = true; shader.displacementMapUv = 'uv'; }
    shader.flatShading = material.flatShading;
    shader.alphaTest = hasAlphaTest;
  };

  return shaderMaterial;
}

function _overrideTargetMaterial(target) {
  target.traverse((mesh) => {
    if (mesh.material) {
      const material = mesh.material;
      mesh.userData[USERDATA_MAT_KEY] = material;
      mesh.material = Array.isArray(material) ? material.map((m) => _makeCaptureMaterial(m)) : _makeCaptureMaterial(material);
    }
  });
}

function _restoreTargetMaterial(target) {
  target.traverse((mesh) => {
    if (mesh.userData[USERDATA_MAT_KEY]) {
      mesh.material = mesh.userData[USERDATA_MAT_KEY];
      delete mesh.userData[USERDATA_MAT_KEY];
    }
  });
}

// Allocate the 2-target (albedo + packed normalDepth) atlas render target.
export function createAtlasRenderTarget(atlasSize) {
  const rt = new WebGLRenderTarget(atlasSize, atlasSize, { count: 2, generateMipmaps: true });
  rt.textures[0].minFilter = LinearMipmapLinearFilter;
  rt.textures[0].magFilter = LinearFilter;
  rt.textures[0].type = UnsignedByteType;
  rt.textures[0].colorSpace = LinearSRGBColorSpace;
  rt.textures[1].minFilter = NearestMipMapNearestFilter;
  rt.textures[1].magFilter = NearestFilter;
  rt.textures[1].type = UnsignedByteType;
  rt.textures[1].colorSpace = LinearSRGBColorSpace;
  return rt;
}

// Render octahedral cells [cellStart, cellStart+cellCount) of `target` into
// `renderTarget`, framing the ortho camera on `bSphere`. Renderer state is
// saved/restored each call (autoClear stays on so each cell's render clears its
// own scissor region) -> safe to interleave with the main render loop for
// INCREMENTAL baking (no whole-atlas stall). Returns cells rendered.
export function renderAtlasCells(renderer, target, renderTarget, opts) {
  const { atlasSize, countPerSide, bSphere, cameraFactor = 1, useHemiOctahedron, cellStart, cellCount } = opts;
  const countMinusOne = countPerSide - 1;
  const spriteSize = atlasSize / countPerSide;
  const total = countPerSide * countPerSide;
  const end = Math.min(cellStart + cellCount, total);

  const oldPixelRatio = renderer.getPixelRatio();
  const oldScissorTest = renderer.getScissorTest();
  const oldClearAlpha = renderer.getClearAlpha();
  const oldTarget = renderer.getRenderTarget();
  renderer.getScissor(_oldScissor);
  renderer.getViewport(_oldViewport);

  _camera.left = -bSphere.radius; _camera.right = bSphere.radius;
  _camera.top = bSphere.radius; _camera.bottom = -bSphere.radius;
  _camera.zoom = cameraFactor; _camera.near = 0.001; _camera.far = bSphere.radius * 2 + 0.001;
  _camera.updateProjectionMatrix();

  renderer.setRenderTarget(renderTarget);
  renderer.setScissorTest(true);
  renderer.setPixelRatio(1);
  renderer.setClearAlpha(0);

  _overrideTargetMaterial(target);
  for (let k = cellStart; k < end; k++) {
    const col = k % countPerSide, row = Math.floor(k / countPerSide);
    _coords.set(col / countMinusOne, row / countMinusOne);
    if (useHemiOctahedron) hemiOctaGridToDir(_coords, _camera.position);
    else octaGridToDir(_coords, _camera.position);
    _camera.position.setLength(bSphere.radius * cameraFactor).add(bSphere.center);
    _camera.lookAt(bSphere.center);
    const xOffset = (col / countPerSide) * atlasSize;
    const yOffset = (row / countPerSide) * atlasSize;
    renderer.setViewport(xOffset, yOffset, spriteSize, spriteSize);
    renderer.setScissor(xOffset, yOffset, spriteSize, spriteSize);
    renderer.render(target, _camera);
  }
  _restoreTargetMaterial(target);

  renderer.setRenderTarget(oldTarget);
  renderer.setScissorTest(oldScissorTest);
  renderer.setViewport(_oldViewport.x, _oldViewport.y, _oldViewport.z, _oldViewport.w);
  renderer.setScissor(_oldScissor.x, _oldScissor.y, _oldScissor.z, _oldScissor.w);
  renderer.setPixelRatio(oldPixelRatio);
  renderer.setClearAlpha(oldClearAlpha);
  return end - cellStart;
}

// Wholesale one-shot atlas bake (used by the OctahedralImpostor convenience
// class). For the runtime tier prefer createAtlasRenderTarget + renderAtlasCells
// driven incrementally.
// params: { renderer, target, useHemiOctahedron, textureSize?=2048,
//           spritesPerSide?=16, cameraFactor?=1 } -> { renderTarget, albedo, normalDepth }
export function createTextureAtlas(params) {
  const { renderer, target, useHemiOctahedron } = params;
  if (!renderer) throw new Error('createTextureAtlas: "renderer" is mandatory.');
  if (!target) throw new Error('createTextureAtlas: "target" is mandatory.');
  if (useHemiOctahedron == null) throw new Error('createTextureAtlas: "useHemiOctahedron" is mandatory.');
  const atlasSize = params.textureSize ?? 2048;
  const countPerSide = params.spritesPerSide ?? 16;
  computeObjectBoundingSphere(target, _bSphere, true);
  const renderTarget = createAtlasRenderTarget(atlasSize);
  renderAtlasCells(renderer, target, renderTarget, {
    atlasSize, countPerSide, bSphere: _bSphere, cameraFactor: params.cameraFactor ?? 1,
    useHemiOctahedron, cellStart: 0, cellCount: countPerSide * countPerSide,
  });
  return { renderTarget, albedo: renderTarget.textures[0], normalDepth: renderTarget.textures[1] };
}

// ---------------------------------------------- impostor material patch ----
// params: CreateTextureAtlasParams + { baseType?=MeshStandardMaterial,
//          transparent?, alphaClamp?=0.4, transform?:Matrix4 }
// Returns a `baseType` material whose shader samples the octahedral atlas.
export function createOctahedralImpostorMaterial(params) {
  if (!params) throw new Error('createOctahedralImpostorMaterial: parameters is required.');
  if (params.useHemiOctahedron == null) throw new Error('createOctahedralImpostorMaterial: useHemiOctahedron is required.');

  const BaseType = params.baseType ?? MeshStandardMaterial;
  // Accept a pre-baked atlas (incremental tier path) or bake one now (convenience).
  const { albedo, normalDepth } = (params.albedo && params.normalDepth)
    ? { albedo: params.albedo, normalDepth: params.normalDepth }
    : createTextureAtlas(params);

  const material = new BaseType();
  material.isOctahedralImpostorMaterial = true;
  material.transparent = params.transparent ?? false;
  material.map = albedo;
  material.normalMap = normalDepth;

  material.ezImpostorDefines = {};
  if (params.useHemiOctahedron) material.ezImpostorDefines.EZ_USE_HEMI_OCTAHEDRON = true;
  if (params.transparent) material.ezImpostorDefines.EZ_TRANSPARENT = true;
  material.ezImpostorDefines.EZ_USE_NORMAL = true;
  // ATLAS-OF-ATLASES: a SHARED cross-species impostor reads its species' tile from one mega atlas.
  // Per-instance `atlasTile` (a float species index, provided via InstancedMesh2.initUniformsPerInstance)
  // -> the sprite UV is remapped into that tile. Default OFF so the per-species impostors are unchanged.
  if (params.atlasTile) material.ezImpostorDefines.EZ_ATLAS_TILE = true;
  // CHEAP FAR TIER (vp-impostor-shader-cost): sample 1 octa view instead of blending 3 -> ~3x less
  // fragment fetch cost for the farthest impostors, accepting slight view-popping. Default OFF so the
  // per-species / near impostors keep the full 3-sprite blend.
  if (params.farSingleSprite) material.ezImpostorDefines.EZ_FAR_SINGLE_SPRITE = true;
  // DITHERED MESH<->IMPOSTOR CROSSFADE: reads a per-instance `instanceFade` attribute (see
  // ezFadeDither in IMPOSTOR_PARAMS_FRAGMENT) and stochastically discards (1-fade) of the billboard's
  // own pixels -- fades the impostor IN while the real mesh LOD it's replacing stays fully opaque
  // behind it, so the eventual hard cut of the real mesh (once fade reaches 1) lands fully occluded
  // and invisible. Default OFF (screenPx-hysteresis hard cut, unchanged) -- opt-in via params.fade.
  if (params.fade) material.ezImpostorDefines.EZ_FADE = true;
  // PARALLAX-CORRECTED IMPOSTORS: depth-offset UV sampling using the normalDepth atlas's existing
  // packed alpha channel (1-fragCoordZ, see ATLAS_FRAGMENT) so a close-range impostor shows real
  // per-fragment surface relief instead of reading flat/billboard-like. Default OFF (flat sampling,
  // byte-behaviour-unchanged) -- opt-in via params.parallax; params.parallaxScale tunes the offset
  // magnitude in cell-local UV units (default 0.3, empirically small enough to stay inside a sprite's
  // own atlas cell for typical foliage/prop-scale relief while still being visibly non-flat close up).
  if (params.parallax) material.ezImpostorDefines.EZ_PARALLAX = true;

  material.ezImpostorUniforms = {
    spritesPerSide: { value: params.spritesPerSide ?? 16 },
    alphaClamp: { value: params.alphaClamp ?? 0.4 },
    impostorTransform: { value: params.transform ?? new Matrix4() },
    uAtlasGridSide: { value: params.atlasGridSide ?? 1 },
    uAtlasTileScale: { value: 1 / (params.atlasGridSide ?? 1) },
    uParallaxScale: { value: params.parallaxScale ?? 0.3 },
  };

  overrideMaterialCompilation(material);
  return material;
}

function overrideMaterialCompilation(material) {
  const onBeforeCompileBase = material.onBeforeCompile;

  material.onBeforeCompile = (shader, renderer) => {
    shader.defines = { ...shader.defines, ...material.ezImpostorDefines };
    shader.uniforms = { ...shader.uniforms, ...material.ezImpostorUniforms };

    shader.vertexShader = shader.vertexShader
      .replace('#include <clipping_planes_pars_vertex>', IMPOSTOR_PARAMS_VERTEX)
      .replace('#include <project_vertex>', IMPOSTOR_VERTEX);

    shader.fragmentShader = shader.fragmentShader
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `${IMPOSTOR_MAP_FRAGMENT}\n vec4 diffuseColor = vec4( diffuse, opacity );`)
      .replace('#include <clipping_planes_pars_fragment>', IMPOSTOR_PARAMS_FRAGMENT)
      .replace('#include <normal_fragment_begin>', IMPOSTOR_NORMAL_FRAGMENT_BEGIN)
      .replace('#include <normal_fragment_maps>', '// #include <normal_fragment_maps>')
      .replace('#include <map_fragment>', 'diffuseColor *= blendedColor;');

    onBeforeCompileBase?.call(material, shader, renderer);
  };

  const customProgramCacheKeyBase = material.customProgramCacheKey;
  material.customProgramCacheKey = () => {
    const d = material.ezImpostorDefines;
    return `ez_${!!d.EZ_USE_HEMI_OCTAHEDRON}_${!!material.transparent}_${!!d.EZ_USE_NORMAL}_${!!d.EZ_USE_ORM}_${!!d.EZ_ATLAS_TILE}_${!!d.EZ_FAR_SINGLE_SPRITE}_${!!d.EZ_FADE}_${!!d.EZ_PARALLAX}_${customProgramCacheKeyBase.call(material)}`;
  };
}

// ------------------------------------------------------- impostor mesh ----
// A camera-facing quad whose material samples the octahedral atlas. Pass either
// an already-built impostor material, or atlas params (incl. `target`) to bake.
export class OctahedralImpostor extends Mesh {
  constructor(materialOrParams) {
    super(new PlaneGeometry(), null);

    if (!materialOrParams.isOctahedralImpostorMaterial) {
      const mesh = materialOrParams.target;
      const sphere = computeObjectBoundingSphere(mesh, new Sphere(), true);
      const scale = sphere.radius * 2;
      materialOrParams.transform = new Matrix4().makeScale(scale, scale, scale).setPosition(sphere.center.clone());
      materialOrParams = createOctahedralImpostorMaterial(materialOrParams);
    }

    this.material = materialOrParams;
  }

  clone() {
    const impostor = new OctahedralImpostor(this.material);
    impostor.scale.copy(this.scale);
    impostor.position.copy(this.position);
    return impostor;
  }
}
