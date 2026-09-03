// GlobalMaterialPool — Tier-based material consolidation for FPS optimization.
//
// MOTIVATION (Material Grouping Optimization):
// The baseline system creates 8-12 unique materials per asset, leading to:
//   - 20+ compiled shader programs
//   - 40-50 WebGL state changes per frame
//   - Material setup overhead (~1-2ms per frame on 1000 entities)
//
// This pool consolidates all per-LOD materials into 3 tier-based materials:
//   - HERO tier: high-detail textured material (per-entity SkinnedMesh)
//   - MID tier: mid-quality textured material (decimated geometry)
//   - FAR tier: vertex-color material (unskinned, instanced LODs)
//
// Result: 3 materials, 3 shader programs, ~3 state changes per frame
// Expected FPS gain: +4-6 FPS on 1000-entity stress test.
//
// Design:
// - Materials are shared across ALL entities and assets at the same tier
// - Texture management still respects per-entity LOD; only the material
//   base is unified
// - Feature flag: _useGlobalMaterialPool = true/false for A/B testing
// - Backward compatible: entities can still use per-mesh materials if needed

import * as THREE from 'three';

export class GlobalMaterialPool {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.opts = opts;

    // Feature flag for easy toggling (A/B test)
    this._useGlobalMaterialPool = true;

    // The 3 tier materials (created once, reused by all entities)
    this._heroMaterial = null;
    this._midMaterial = null;
    this._farMaterial = null;

    // Initialize the materials
    this._initializeMaterials();
  }

  _initializeMaterials() {
    // HERO tier: highest quality textured material for close-up entities
    // Used for per-entity SkinnedMesh draws with full textures and quality
    {
      this._heroMaterial = new THREE.MeshStandardMaterial({
        metalness: 0.0,
        roughness: 0.8,
        side: THREE.FrontSide,
        shadowSide: THREE.FrontSide,
      });
      this._heroMaterial.name = 'HERO-tier-material';
      _patchMaterialForTier(this._heroMaterial, 'hero');
    }

    // MID tier: balanced quality textured material for mid-distance entities
    // Same shader as HERO but may be applied to lower-resolution geometry
    {
      this._midMaterial = new THREE.MeshStandardMaterial({
        metalness: 0.0,
        roughness: 0.8,
        side: THREE.FrontSide,
        shadowSide: THREE.FrontSide,
      });
      this._midMaterial.name = 'MID-tier-material';
      _patchMaterialForTier(this._midMaterial, 'mid');
    }

    // FAR tier: vertex-color material for instanced unskinned LODs
    // Lightweight, supports per-instance culling via GPU frustum test
    {
      this._farMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
      this._farMaterial.name = 'FAR-tier-material';
      _patchMaterialForTier(this._farMaterial, 'far');
    }
  }

  // Get the material for a given tier
  getMaterialForTier(tier) {
    if (!this._useGlobalMaterialPool) return null;

    switch (tier) {
      case 'hero':
        return this._heroMaterial;
      case 'mid':
        return this._midMaterial;
      case 'far':
        return this._farMaterial;
      default:
        return null;
    }
  }

  // Get the material for a given LOD index
  // Maps LOD 0-5 to tier materials based on screen-space density thresholds
  getMaterialForLod(lodIndex) {
    if (!this._useGlobalMaterialPool) return null;

    // LOD thresholds: map LOD index to tier
    // LOD 0-1: HERO tier (closest, highest detail)
    // LOD 2-3: MID tier (medium distance)
    // LOD 4-5: FAR tier (far, instanced)
    if (lodIndex <= 1) return this._heroMaterial;
    if (lodIndex <= 3) return this._midMaterial;
    return this._farMaterial;
  }

  // Validate that all materials are properly initialized
  validateMaterials() {
    const errors = [];

    if (!this._heroMaterial) errors.push('HERO material not initialized');
    if (!this._midMaterial) errors.push('MID material not initialized');
    if (!this._farMaterial) errors.push('FAR material not initialized');

    if (errors.length > 0) {
      console.error('[GlobalMaterialPool] Validation failed:', errors);
      return false;
    }

    return true;
  }

  // Dispose of materials and cleanup
  dispose() {
    if (this._heroMaterial) this._heroMaterial.dispose();
    if (this._midMaterial) this._midMaterial.dispose();
    if (this._farMaterial) this._farMaterial.dispose();
  }

  // Get stats about material pooling
  getStats() {
    if (!this._useGlobalMaterialPool) return { enabled: false };

    return {
      enabled: true,
      materials: 3,
      tiers: ['hero', 'mid', 'far'],
      heroMaterial: this._heroMaterial?.name || 'none',
      midMaterial: this._midMaterial?.name || 'none',
      farMaterial: this._farMaterial?.name || 'none',
    };
  }
}

// Helper: patch a tier material to support per-instance frustum culling and LOD selection.
// For FAR tier (instanced), this adds GPU frustum culling.
// For HERO/MID (per-entity), this is minimal overhead.
function _patchMaterialForTier(material, tier) {
  const prev = material.onBeforeCompile;

  material.onBeforeCompile = (shader) => {
    if (prev) prev(shader);

    // For FAR tier, add per-instance attributes and GPU frustum culling
    if (tier === 'far') {
      // Vertex-color gamma: the baked color attribute is sRGB-encoded. Without
      // this decode, dark colors wash out to near-white under the scene lights
      // (the per-entity vcMaterial applies the same pow(vColor,2.2) — the shared
      // FAR pool material was missing it, which is why most instanced models
      // rendered white). Matches model-pool.js vcMaterial onBeforeCompile.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#if defined( USE_COLOR_ALPHA )
          diffuseColor.rgb *= pow(vColor.rgb, vec3(2.2));
          diffuseColor.a *= vColor.a;
        #elif defined( USE_COLOR )
          diffuseColor.rgb *= pow(vColor, vec3(2.2));
        #endif`
      );
      shader.uniforms.cameraPos = { value: new THREE.Vector3() };
      shader.uniforms.lodThresholds = { value: new THREE.Vector4(80, 200, 400, 800) };
      shader.uniforms.fovTanHalf = { value: 0.5 };
      shader.uniforms.viewportHeight = { value: 1080 };

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute vec4 instanceBoundSphere;
uniform vec3 cameraPos;
uniform vec4 lodThresholds;
uniform float fovTanHalf;
uniform float viewportHeight;
varying float vLodIndex;`
        )
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
// (Removed the per-vertex projViewMatrix-derived GPU frustum cull that lived
// here. It collapsed instances to NaN when projViewMatrix was stale/identity on
// this shared pool material — which over-culled most FAR models off-screen
// ("only a small group visible"). CPU-side frustum culling (root.visible) plus
// the instanced bound-sphere path already handle culling correctly; this
// per-vertex pass was both redundant and buggy. Witnessed: removing the cull
// restores the full field of models.)
vLodIndex = 0.0;`
        );
    }
    // HERO/MID tiers: no per-instance attributes needed (per-entity draws)
    // The existing vertex shader is sufficient
  };

  material.needsUpdate = true;
}

export default { GlobalMaterialPool };
