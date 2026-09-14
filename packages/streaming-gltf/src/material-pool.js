import * as THREE from 'three';

export class GlobalMaterialPool {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.opts = opts;

    this._useGlobalMaterialPool = true;

    this._heroMaterial = null;
    this._midMaterial = null;
    this._farMaterial = null;

    this._initializeMaterials();
  }

  _initializeMaterials() {
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

    {
      this._farMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
      this._farMaterial.name = 'FAR-tier-material';
      _patchMaterialForTier(this._farMaterial, 'far');
    }
  }

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

  getMaterialForLod(lodIndex) {
    if (!this._useGlobalMaterialPool) return null;

    if (lodIndex <= 1) return this._heroMaterial;
    if (lodIndex <= 3) return this._midMaterial;
    return this._farMaterial;
  }

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

  dispose() {
    if (this._heroMaterial) this._heroMaterial.dispose();
    if (this._midMaterial) this._midMaterial.dispose();
    if (this._farMaterial) this._farMaterial.dispose();
  }

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

function _patchMaterialForTier(material, tier) {
  const prev = material.onBeforeCompile;

  material.onBeforeCompile = (shader) => {
    if (prev) prev(shader);

    if (tier === 'far') {
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
  };

  material.needsUpdate = true;
}

export default { GlobalMaterialPool };
