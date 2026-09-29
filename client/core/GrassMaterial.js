import * as THREE from 'three'
import { makeClumpAlphaTexture } from './GrassClump.js'

export const MAX_BENDERS = 8

export const MAX_DECALS = 8

export const UNUSED_BENDER_SLOT_XZ = 1e6

export const GRASS_ALPHA_CUTOFF = 0.3

export const GRASS_NOISE_GLSL = `
      float grassHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float grassNoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(grassHash(i), grassHash(i + vec2(1.0, 0.0)), u.x),
                   mix(grassHash(i + vec2(0.0, 1.0)), grassHash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
`

export function makeWind() {
  return {
    uClumpTex: { value: makeClumpAlphaTexture() },
    uGrassBase: { value: new THREE.Color(0.19, 0.25, 0.11) },
    uGrassTip1: { value: new THREE.Color(0.61, 0.83, 0.55) },
    uGrassTip2: { value: new THREE.Color(0.12, 0.21, 0.16) },
    uGrassTime: { value: 0 }, uGrassWind: { value: 1 }, uGrassWindDir: { value: new THREE.Vector2(0.8, 0.6) },
    uCamPosXZ: { value: new THREE.Vector2(0, 0) }, uGrassRing: { value: 44 },
    uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() }, uSunColor: { value: new THREE.Color(1, 1, 0.96) },
    uAmbient: { value: new THREE.Color(0.32, 0.36, 0.4) },
    uBenderPosXZ: { value: new Float32Array(MAX_BENDERS * 2).fill(UNUSED_BENDER_SLOT_XZ) },
    uBenderCount: { value: 0 },
    uGrassBendRadius: { value: 2.2 },
    uGrassBendStrength: { value: 1.4 },
    uDecalPosXZRS: { value: new Float32Array(MAX_DECALS * 4) },
    uDecalCount: { value: 0 },
    uGrassScorchShrink: { value: 0.15 },
    uGrassScorchColor: { value: new THREE.Color(0.22, 0.15, 0.06) },
  }
}

export function makeGrassMaterial(wind) {
  const material = new THREE.ShaderMaterial({
    fog: true,
    side: THREE.DoubleSide,
    uniforms: {
      ...THREE.UniformsLib.fog,
      uClumpTex: wind.uClumpTex,
      uGrassBase: wind.uGrassBase,
      uGrassTip1: wind.uGrassTip1,
      uGrassTip2: wind.uGrassTip2,
      uGrassTime: wind.uGrassTime,
      uGrassWind: wind.uGrassWind,
      uGrassWindDir: wind.uGrassWindDir,
      uCamPosXZ: wind.uCamPosXZ,
      uGrassRing: wind.uGrassRing,
      uSunDir: wind.uSunDir,
      uSunColor: wind.uSunColor,
      uAmbient: wind.uAmbient,
      uBenderPosXZ: wind.uBenderPosXZ,
      uBenderCount: wind.uBenderCount,
      uGrassBendRadius: wind.uGrassBendRadius,
      uGrassBendStrength: wind.uGrassBendStrength,
      uDecalPosXZRS: wind.uDecalPosXZRS,
      uDecalCount: wind.uDecalCount,
      uGrassScorchShrink: wind.uGrassScorchShrink,
      uGrassScorchColor: wind.uGrassScorchColor
    },
    vertexShader: `
      uniform float uGrassTime, uGrassWind, uGrassRing;
      uniform vec2 uGrassWindDir, uCamPosXZ;
      uniform vec2 uBenderPosXZ[${MAX_BENDERS}];
      uniform int uBenderCount;
      uniform float uGrassBendRadius, uGrassBendStrength;
      uniform vec4 uDecalPosXZRS[${MAX_DECALS}];
      uniform int uDecalCount;
      uniform float uGrassScorchShrink;
      uniform vec3 uGrassScorchColor;
      varying float vGrassY, vTint, vInstShadow, vScorch;
      varying vec3 vWorldNormal, vToCamera;
      varying vec2 vUv, vFieldXZ;
      #include <common>
      #include <fog_pars_vertex>
      #include <instanced_pars_vertex>
      ${GRASS_NOISE_GLSL}
      void main() {
        #ifdef USE_INSTANCING_INDIRECT
          mat4 instanceMatrix = getInstancedMatrix();
        #endif
        vGrassY = position.y;
        vUv = uv;
        vTint = tint;
        vInstShadow = instShadow;
        vec3 transformed = position;
        vec2 gWXZ = instanceMatrix[3].xz;
        float gv = clamp(position.y, 0.0, 1.0);
        float gw = gv * gv * 0.45;
        float gGust = grassNoise(gWXZ * 0.11 + uGrassWindDir * uGrassTime * 0.35);
        float gFlow = sin(dot(gWXZ, vec2(0.06, 0.045)) + gGust * 5.5 + uGrassTime * 1.4)
                    + 0.5 * sin(dot(gWXZ, vec2(-0.11, 0.09)) + uGrassTime * 2.3);
        float gAmp = (0.55 + 0.4 * gFlow) * gw * uGrassWind;
        float gph = uGrassTime * 2.2 + windPhase;
        vec2 gWdir = normalize(uGrassWindDir + 1e-4);
        transformed.x += (gWdir.x * gAmp) + sin(gph) * gw * 0.25 * uGrassWind;
        transformed.z += (gWdir.y * gAmp) + cos(gph * 0.7) * gw * 0.25 * uGrassWind;
        vec2 bendXZ = vec2(0.0);
        for (int bi = 0; bi < ${MAX_BENDERS}; bi++) {
          if (bi >= uBenderCount) break;
          vec2 toBlade = gWXZ - uBenderPosXZ[bi];
          float bd = length(toBlade);
          float bInfluence = 1.0 - smoothstep(0.0, uGrassBendRadius, bd);
          if (bInfluence > 0.0) {
            vec2 bDir = bd > 1e-4 ? toBlade / bd : vec2(1.0, 0.0);
            bendXZ += bDir * bInfluence * uGrassBendStrength;
          }
        }
        transformed.x += bendXZ.x * gw;
        transformed.z += bendXZ.y * gw;
        transformed.y -= length(bendXZ) * gw * 0.35;
        float scorch = 0.0;
        for (int di = 0; di < ${MAX_DECALS}; di++) {
          if (di >= uDecalCount) break;
          vec4 dc = uDecalPosXZRS[di];
          float dRadius = dc.z;
          if (dRadius <= 0.0) continue;
          float dd = distance(gWXZ, dc.xy);
          float dInfluence = (1.0 - smoothstep(0.0, dRadius, dd)) * clamp(dc.w, 0.0, 1.0);
          scorch = max(scorch, dInfluence);
        }
        vScorch = scorch;
        float scorchScale = mix(1.0, uGrassScorchShrink, scorch);
        transformed.y *= scorchScale; transformed.x *= scorchScale; transformed.z *= scorchScale;
        float gDist = length(gWXZ - uCamPosXZ);
        float gFade = 1.0 - smoothstep(uGrassRing * 0.7, uGrassRing, gDist);
        transformed.y *= gFade; transformed.x *= mix(0.5, 1.0, gFade); transformed.z *= mix(0.5, 1.0, gFade);
        vec3 flatNormal = normalize(mix(normalize(normal), vec3(0.0, 1.0, 0.0), 0.75));
        vWorldNormal = normalize(mat3(instanceMatrix) * mat3(modelMatrix) * flatNormal);
        vec4 instPos = instanceMatrix * vec4(transformed, 1.0);
        vFieldXZ = instPos.xz;
        vec4 mvPosition = modelViewMatrix * instPos;
        vToCamera = cameraPosition - (modelMatrix * instPos).xyz;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDir, uSunColor, uAmbient, uGrassScorchColor, uGrassBase, uGrassTip1, uGrassTip2;
      uniform sampler2D uClumpTex;
      varying float vGrassY, vTint, vInstShadow, vScorch;
      varying vec3 vWorldNormal, vToCamera;
      varying vec2 vUv, vFieldXZ;
      #include <common>
      #include <fog_pars_fragment>
      ${GRASS_NOISE_GLSL}
      void main() {
        float blade = texture2D(uClumpTex, vUv).r;
        if (blade < ${GRASS_ALPHA_CUTOFF.toFixed(2)}) discard;
        float fieldNoise = grassNoise(vFieldXZ * 0.085);
        float variation = clamp(fieldNoise * 0.65 + vTint * 0.35, 0.0, 1.0);
        vec3 tip = mix(uGrassTip1, uGrassTip2, variation);
        float along = smoothstep(0.0, 0.95, vUv.y);
        vec3 baseColor = mix(uGrassBase, tip, along);
        baseColor *= mix(0.78, 1.1, smoothstep(0.55, 1.0, blade));
        baseColor *= 0.62 + 0.38 * smoothstep(0.0, 0.3, vUv.y);
        baseColor = mix(baseColor, uGrassScorchColor, vScorch);
        vec3 n = normalize(vWorldNormal);
        float ndl = max(dot(n, uSunDir), 0.0);
        float wrap = 0.4 + 0.6 * ndl;
        vec3 viewDir = normalize(vToCamera);
        float backlit = pow(clamp(dot(viewDir, -uSunDir), 0.0, 1.0), 3.0) * vUv.y;
        vec3 lit = baseColor * (uAmbient + uSunColor * wrap * vInstShadow);
        lit += baseColor * uSunColor * backlit * 0.55 * vInstShadow;
        gl_FragColor = vec4(lit, 1.0);
        #include <fog_fragment>
      }
    `
  })
  material.customProgramCacheKey = () => 'grassclump-fluffy'
  return material
}
