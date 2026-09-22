import * as THREE from 'three/webgpu';
import { pow, vertexColor, vec3, vec4 } from 'three/tsl';

export class GlobalMaterialPoolTSL {
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
    this._heroMaterial = new THREE.MeshStandardNodeMaterial({
      metalness: 0.0,
      roughness: 0.8,
      side: THREE.FrontSide,
      shadowSide: THREE.FrontSide,
    });
    this._heroMaterial.name = 'HERO-tier-material-tsl';

    this._midMaterial = new THREE.MeshStandardNodeMaterial({
      metalness: 0.0,
      roughness: 0.8,
      side: THREE.FrontSide,
      shadowSide: THREE.FrontSide,
    });
    this._midMaterial.name = 'MID-tier-material-tsl';

    this._farMaterial = new THREE.MeshLambertNodeMaterial({ vertexColors: false });
    this._farMaterial.name = 'FAR-tier-material-tsl';
    this._farMaterial.colorNode = vec4(pow(vertexColor().rgb, vec3(2.2)), vertexColor().a);
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
      console.error('[GlobalMaterialPoolTSL] Validation failed:', errors);
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

export default { GlobalMaterialPoolTSL };
