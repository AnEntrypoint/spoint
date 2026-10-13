import * as THREE from 'three'
import { makeClumpAlphaTexture } from './GrassClump.js'
import { TERRAIN_DEFAULTS as TD } from '/node_modules/mapspinner/src/terrain-defaults.js'
import { ATM_RAYLEIGH } from '/node_modules/mapspinner/src/atmosphere-transmittance-lut.js'
import { ATM_SOLAR_IRRADIANCE } from '/node_modules/mapspinner/src/tsl/sky-tsl.js'
import {
  vegetationAmbientDelta, NIGHT_FILL, INV_PI, ACES_FILMIC, DISPLAY_GAMMA_INV, LUMA,
} from '/node_modules/mapspinner/src/tsl/terrain-ambient-shared.js'

export const MAX_BENDERS = 8

export const MAX_DECALS = 8

export const UNUSED_BENDER_SLOT_XZ = 1e6

export const GRASS_ALPHA_CUTOFF = 0.6

export const GRASS_GROUND_TINT = 0.85

export const GRASS_TIP_GROUND_MIX = 1.0

export const GRASS_TIP_GROUND_GAIN = 1.1

export const GRASS_LOOK_SAT = 1.0

export const GRASS_BLADE_VARIATION = 0.8

export const GRASS_LOCAL_VARIATION = 0.6

export const GRASS_LUMA = [0.299, 0.587, 0.114]

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
    uGrassTime: { value: 0 }, uGrassWind: { value: 0.25 }, uGrassWindDir: { value: new THREE.Vector2(0.8, 0.6) },
    uCamPosXZ: { value: new THREE.Vector2(0, 0) }, uGrassRing: { value: 61.6 }, uGrassSat: { value: 1.0 },
    uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() }, uSunColor: { value: new THREE.Color(1, 1, 0.96) },
    uAmbient: { value: new THREE.Color(0.32, 0.36, 0.4) },
    uBenderPosXZ: { value: new Float32Array(MAX_BENDERS * 2).fill(UNUSED_BENDER_SLOT_XZ) },
    uBenderCount: { value: 0 },
    uGrassBendRadius: { value: 1.1 },
    uGrassBendStrength: { value: 0.35 },
    uDecalPosXZRS: { value: new Float32Array(MAX_DECALS * 4) },
    uDecalCount: { value: 0 },
    uGrassScorchShrink: { value: 0.15 },
    uGrassScorchColor: { value: new THREE.Color(0.22, 0.15, 0.06) },
    uGrassAmbMul: { value: new THREE.Vector3(0, 0, 0) },
    uGrassAmbAdd: { value: new THREE.Vector3(0, 0, 0) },
    uGrassNightFill: { value: new THREE.Vector3(0, 0, 0) },
    uGrassGrade: { value: new THREE.Vector4(1, TD.exposure, TD.lookSat, TD.lookContrast) },
  }
}

const GRASS_SUN_REF_INTENSITY = 1.5
const GRASS_NIGHT_FLOOR = 0.18
const GRASS_TERM_WIDTH = 0.45
const GRASS_EXPOSURE = 1.05
const GRASS_GAIN_NIGHT = 0.45
const GRASS_GAIN_DUSK = 1.08
const GRASS_GAIN_DAY = 0.67
const GRASS_GAIN_ELEV_SPAN = 0.92

// The filmic curve written out with the coefficients terrain-ambient-shared.js exports, so the
// legacy grass shader cannot grow a second copy of a number the terrain grade owns.
const grassAcesGlsl = (v) =>
  `clamp((${v}) * ((${v}) * ${ACES_FILMIC[0]} + ${ACES_FILMIC[1]}) / ((${v}) * ((${v}) * ${ACES_FILMIC[2]} + ${ACES_FILMIC[3]}) + ${ACES_FILMIC[4]}), 0.0, 1.0)`

function smoothstepUnit(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function grassLightGain(sunElevY) {
  if (sunElevY <= 0) {
    const t = Math.min(1, Math.max(0, (sunElevY + GRASS_GAIN_ELEV_SPAN) / GRASS_GAIN_ELEV_SPAN))
    return GRASS_GAIN_NIGHT + (GRASS_GAIN_DUSK - GRASS_GAIN_NIGHT) * t
  }
  const t = Math.min(1, sunElevY / GRASS_GAIN_ELEV_SPAN)
  return GRASS_GAIN_DUSK + (GRASS_GAIN_DAY - GRASS_GAIN_DUSK) * t
}

function grassWindowNum(name, fallback) {
  const v = typeof window === 'undefined' ? undefined : window['__' + name]
  return Number.isFinite(v) ? v : fallback
}

export function setGrassSun(wind, sun) {
  wind.uSunDir.value.set(sun.dir[0], sun.dir[1], sun.dir[2]).normalize()
  const dayShade = (GRASS_NIGHT_FLOOR + (1 - GRASS_NIGHT_FLOOR) * smoothstepUnit(-GRASS_TERM_WIDTH, GRASS_TERM_WIDTH, sun.dir[1])) * GRASS_EXPOSURE
  const gain = grassLightGain(sun.dir[1])
  const sunK = (Number.isFinite(sun.sunIntensity) ? sun.sunIntensity / GRASS_SUN_REF_INTENSITY : 1) * dayShade * gain
  wind.uSunColor.value.setHex(sun.sunColor).multiplyScalar(sunK)
  // Grass is lit by its own uniforms, so it never saw the two ambient terms the terrain model
  // carries and the standard-lit path does not: the tinted sky irradiance and the albedo-independent
  // AMBIENT_FLOOR_ADD. Both come from terrain-ambient-shared.js -- the module terrain-lighting-tsl.js
  // reads -- so the ground and the grass growing out of it cannot drift apart. uAmbient is left at
  // the irradiance the scene ambient already delivers (ambientColor * ambientIntensity / pi) and the
  // delta carries the rest, which is what keeps them equal instead of double counted.
  const amb = wind.uAmbient.value.setHex(sun.ambientColor)
    .multiplyScalar((Number.isFinite(sun.ambientIntensity) ? sun.ambientIntensity : 1) * INV_PI)
  const muS = Number.isFinite(sun.elevDeg) ? Math.sin(sun.elevDeg * Math.PI / 180) : sun.dir[1]
  const d = vegetationAmbientDelta({
    muS,
    skyFill: grassWindowNum('skyFill', TD.skyFill),
    solar: ATM_SOLAR_IRRADIANCE,
    rayleigh: ATM_RAYLEIGH,
    ambIrr: [amb.r, amb.g, amb.b],
    termWidth: grassWindowNum('termWidth', TD.termWidth),
    nightFloor: grassWindowNum('nightFloor', TD.nightFloor),
  })
  wind.uGrassAmbMul.value.set(d.albedoMul[0], d.albedoMul[1], d.albedoMul[2])
  wind.uGrassAmbAdd.value.set(d.add[0], d.add[1], d.add[2])
  const nightFillScale = grassWindowNum('nightLights', TD.nightLights) * (1 - d.dayShade) * (1 - d.nightAmt)
  wind.uGrassNightFill.value.set(NIGHT_FILL[0] * nightFillScale, NIGHT_FILL[1] * nightFillScale, NIGHT_FILL[2] * nightFillScale)
  wind.uGrassGrade.value.set(
    d.dayShade,
    grassWindowNum('exposure', TD.exposure),
    grassWindowNum('lookSat', TD.lookSat),
    grassWindowNum('lookContrast', TD.lookContrast),
  )
  wind.uGrassSat.value = GRASS_LOOK_SAT
}

export function makeGrassMaterial(wind) {
  const material = new THREE.ShaderMaterial({
    fog: true,
    transparent: true,
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
      uGrassSat: wind.uGrassSat,
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
      uGrassScorchColor: wind.uGrassScorchColor,
      uGrassAmbMul: wind.uGrassAmbMul,
      uGrassAmbAdd: wind.uGrassAmbAdd,
      uGrassNightFill: wind.uGrassNightFill,
      uGrassGrade: wind.uGrassGrade
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
      varying float vGrassY, vTint, vInstShadow, vScorch, vLocalNoise;
      varying vec3 vWorldNormal, vToCamera, vGround;
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
        vTint = groundTint.w;
        vInstShadow = windShadow.y;
        vGround = groundTint.xyz;
        vec3 transformed = position;
        vec2 gWXZ = instanceMatrix[3].xz;
        vLocalNoise = grassNoise(gWXZ * 1.0);
        float gv = clamp(position.y, 0.0, 1.0);
        float gw = gv * gv * 0.45;
        float gGust = grassNoise(gWXZ * 0.11 + uGrassWindDir * uGrassTime * 0.35);
        float gFlow = sin(dot(gWXZ, vec2(0.06, 0.045)) + gGust * 5.5 + uGrassTime * 1.4)
                    + 0.5 * sin(dot(gWXZ, vec2(-0.11, 0.09)) + uGrassTime * 2.3);
        float gAmp = (0.2 + 0.25 * gFlow) * gw * uGrassWind;
        float gph = uGrassTime * 2.2 + windShadow.x;
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
        transformed.y -= length(bendXZ) * gw * 0.12;
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
        float gFade = 1.0 - smoothstep(uGrassRing * 0.55, uGrassRing, gDist);
        transformed.y *= gFade; transformed.x *= mix(0.5, 1.0, gFade); transformed.z *= mix(0.5, 1.0, gFade);
        vWorldNormal = normalize(mat3(modelMatrix) * normalize(instanceMatrix[1].xyz));
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
      uniform vec3 uGrassAmbMul, uGrassAmbAdd, uGrassNightFill;
      uniform vec4 uGrassGrade;
      uniform sampler2D uClumpTex;
      uniform float uGrassSat;
      varying float vGrassY, vTint, vInstShadow, vScorch, vLocalNoise;
      varying vec3 vWorldNormal, vToCamera, vGround;
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
        vec3 baseRoot = mix(uGrassBase, vGround, ${GRASS_GROUND_TINT.toFixed(2)});
        float bladeJitter = clamp(1.0 + ${GRASS_BLADE_VARIATION.toFixed(2)} * (2.0 * vTint - 1.0) + ${GRASS_LOCAL_VARIATION.toFixed(2)} * (2.0 * vLocalNoise - 1.0), 0.2, 1.25);
        vec3 tipGround = mix(tip, vGround * ${GRASS_TIP_GROUND_GAIN.toFixed(2)} * bladeJitter, ${GRASS_TIP_GROUND_MIX.toFixed(2)});
        vec3 baseColor = mix(baseRoot, tipGround, along);
        baseColor *= mix(0.78, 1.1, smoothstep(0.55, 1.0, blade));
        baseColor *= 0.62 + 0.38 * smoothstep(0.0, 0.3, vUv.y);
        baseColor = mix(baseColor, uGrassScorchColor, vScorch);
        vec3 n = normalize(vWorldNormal);
        float ndl = max(dot(n, uSunDir), 0.0);
        float wrap = ndl;
        vec3 viewDir = normalize(vToCamera);
        float backlit = pow(clamp(dot(viewDir, -uSunDir), 0.0, 1.0), 3.0) * vUv.y;
        vec3 lit = baseColor * (uAmbient + uSunColor * wrap * vInstShadow);
        lit += baseColor * uSunColor * backlit * 0.55 * vInstShadow;
        lit += baseColor * uGrassAmbMul + uGrassAmbAdd;
        lit = mix(vec3(dot(lit, vec3(0.299, 0.587, 0.114))), lit, uGrassSat);
        vec3 gLit = (lit * uGrassGrade.x + uGrassNightFill) * uGrassGrade.y;
        vec3 graded = ${grassAcesGlsl('gLit')};
        graded = mix(vec3(dot(graded, vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]}))), graded, uGrassGrade.z);
        graded = clamp((graded - 0.5) * uGrassGrade.w + 0.5, 0.0, 1.0);
        graded = pow(graded, vec3(${DISPLAY_GAMMA_INV.toFixed(6)}));
        gl_FragColor = vec4(graded, clamp(blade * 1.25, 0.0, 1.0) * 0.92);
        #include <fog_fragment>
      }
    `
  })
  material.customProgramCacheKey = () => 'grassclump-fluffy'
  return material
}
