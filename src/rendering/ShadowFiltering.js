import * as THREE from 'three';

export function installEnhancedShadowFiltering() {
  const originalShadowmapSampler = THREE.ShaderChunk.shadowmap_pars_fragment;

  const improvedShadowmapSampler = `
    #ifdef USE_SHADOWMAP
      uniform sampler2D directionalShadowMap[MAX_DIR_LIGHTS];
      varying vec4 vDirectionalShadowCoord[MAX_DIR_LIGHTS];
      struct DirectionalLightShadow {
        float shadowBias;
        float shadowNormalBias;
        float shadowRadius;
        vec2 shadowMapSize;
        float shadowCameraNear;
        float shadowCameraFar;
      };
      uniform DirectionalLightShadow directionalLightShadows[MAX_DIR_LIGHTS];
      float texture2DCompare(sampler2D depths, vec2 coord, float compare) {
        return step(compare, texture2D(depths, coord).r);
      }
      float texture2DShadowLerp(sampler2D depths, vec2 size, vec2 uv, float compare) {
        const vec2 offset = vec2(0.0, 1.0);
        vec2 centroidUV = floor(uv * size + 0.5) / size;
        float lb = texture2DCompare(depths, centroidUV + offset.xx / size, compare);
        float lt = texture2DCompare(depths, centroidUV + offset.xy / size, compare);
        float rb = texture2DCompare(depths, centroidUV + offset.yx / size, compare);
        float rt = texture2DCompare(depths, centroidUV + offset.yy / size, compare);
        vec2 f = fract(uv * size + 0.5);
        float a = mix(lb, lt, f.y);
        float b = mix(rb, rt, f.y);
        return mix(a, b, f.x);
      }
      float getShadow(sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord) {
        float shadow = 1.0;
        shadowCoord.xyz /= shadowCoord.w;
        shadowCoord.z += shadowBias;
        bvec4 inFrustumVec = bvec4(shadowCoord.x >= 0.0, shadowCoord.x <= 1.0, shadowCoord.y >= 0.0, shadowCoord.y <= 1.0);
        bool inFrustum = all(inFrustumVec);
        bvec2 frustumTestVec = bvec2(inFrustum, shadowCoord.z <= 1.0);
        bool frustumTest = all(frustumTestVec);
        if (frustumTest) {
          vec2 poissonDisk[9] = vec2[](
            vec2(-1.0, -1.0), vec2(0.0, -1.0), vec2(1.0, -1.0),
            vec2(-1.0,  0.0), vec2(0.0,  0.0), vec2(1.0,  0.0),
            vec2(-1.0,  1.0), vec2(0.0,  1.0), vec2(1.0,  1.0)
          );
          shadow = 0.0;
          for (int i = 0; i < 9; i++) {
            vec2 sampleCoord = shadowCoord.xy + poissonDisk[i] * shadowRadius / shadowMapSize;
            shadow += texture2DCompare(shadowMap, sampleCoord, shadowCoord.z);
          }
          shadow /= 9.0;
        }
        return shadow;
      }
    #endif
  `;

  if (THREE.ShaderChunk.shadowmap_pars_fragment) {
  }
}

export function computeAdaptiveShadowBias(sunLight, surfaceNormal) {
  const lightDir = new THREE.Vector3().copy(sunLight.position).normalize();
  const cosAngle = Math.max(0, lightDir.dot(surfaceNormal));

  const baseBias = 0.003;
  const adaptiveScale = 1.0 - (cosAngle * 0.7);
  return baseBias * adaptiveScale;
}

export function configureShadowQuality(renderer, quality = 'MEDIUM') {
  const configs = {
    LOW: {
      mapSize: 1024,
      pcfType: THREE.PCFShadowMap,
      radius: 1.0,
      bias: 0.002,
      normalBias: 0.01,
    },
    MEDIUM: {
      mapSize: 2048,
      pcfType: THREE.PCFShadowMap,
      radius: 1.5,
      bias: 0.001,
      normalBias: 0.005,
    },
    HIGH: {
      mapSize: 4096,
      pcfType: THREE.PCFShadowMap,
      radius: 2.0,
      bias: 0.0005,
      normalBias: 0.002,
    },
  };

  const config = configs[quality] || configs.MEDIUM;

  renderer.shadowMap.type = config.pcfType;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = true;

  return config;
}

export function applyShadowConfig(light, config) {
  if (!light.shadow) return;

  light.shadow.mapSize.set(config.mapSize, config.mapSize);
  light.shadow.radius = config.radius;
  light.shadow.bias = config.bias;
  light.shadow.normalBias = config.normalBias;
  light.castShadow = true;
}

export class ShadowQualityTier {
  static LOW = 'LOW';
  static MEDIUM = 'MEDIUM';
  static HIGH = 'HIGH';
  static ULTRA = 'ULTRA';

  static getConfig(tier) {
    const tiers = {
      LOW: {
        directionalMapSize: 1024,
        cascadeCount: 1,
        pcfRadius: 1.0,
        shadowBias: 0.003,
        normalBias: 0.015,
      },
      MEDIUM: {
        directionalMapSize: 2048,
        cascadeCount: 2,
        pcfRadius: 1.5,
        shadowBias: 0.001,
        normalBias: 0.008,
      },
      HIGH: {
        directionalMapSize: 2048,
        cascadeCount: 3,
        pcfRadius: 2.0,
        shadowBias: 0.0007,
        normalBias: 0.004,
      },
      ULTRA: {
        directionalMapSize: 4096,
        cascadeCount: 3,
        pcfRadius: 2.5,
        shadowBias: 0.0005,
        normalBias: 0.002,
      },
    };

    return tiers[tier] || tiers.MEDIUM;
  }

  static apply(renderer, sun, tier) {
    const config = this.getConfig(tier);

    renderer.shadowMap.type = THREE.PCFShadowMap;

    if (sun && sun.shadow) {
      sun.shadow.mapSize.set(config.directionalMapSize, config.directionalMapSize);
      sun.shadow.radius = config.pcfRadius;
      sun.shadow.bias = config.shadowBias;
      sun.shadow.normalBias = config.normalBias;
    }

    return config;
  }
}

export default {
  installEnhancedShadowFiltering,
  computeAdaptiveShadowBias,
  configureShadowQuality,
  applyShadowConfig,
  ShadowQualityTier,
};
