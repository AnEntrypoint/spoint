import * as THREE from 'three'

export const MAX_BENDERS = 8

export const MAX_DECALS = 8

export const UNUSED_BENDER_SLOT_XZ = 1e6

export function makeBladeGeo(segments) {
  const N = Number.isFinite(segments) && segments >= 1 ? segments | 0 : 5
  const wBase = 0.07, curve = 0.18
  const pos = [], idx = []
  const quads = [[[-1, 0], [1, 0]], [[0, -1], [0, 1]]]
  let vi = 0
  for (const [a, b] of quads) {
    for (let s = 0; s <= N; s++) {
      const v = s / N
      const w = wBase * (1 - v)
      const bend = curve * v * v
      pos.push(a[0] * w + bend, v, a[1] * w, b[0] * w + bend, v, b[1] * w)
    }
    for (let s = 0; s < N; s++) {
      const r0 = vi + s * 2, r1 = r0 + 2
      idx.push(r0, r0 + 1, r1, r0 + 1, r1 + 1, r1)
    }
    vi += (N + 1) * 2
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  g.computeBoundingSphere(); g.computeBoundingBox()
  return g
}

export function makeWind() {
  return {
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
    uniforms: {
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
    side: THREE.FrontSide,
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
      varying vec3 vWorldNormal;
      #include <common>
      #include <instanced_pars_vertex>
      void main() {
        #ifdef USE_INSTANCING_INDIRECT
          mat4 instanceMatrix = getInstancedMatrix();
        #endif
        vGrassY = position.y;
        vTint = tint;
        vInstShadow = instShadow;
        vec3 transformed = position;
        vec2 gWXZ = instanceMatrix[3].xz;
        float gv = clamp(position.y, 0.0, 1.0);
        float gw = gv * gv * 0.45;
        float gFlow = sin(dot(gWXZ, vec2(0.06, 0.045)) + uGrassTime * 1.4)
                    + 0.5 * sin(dot(gWXZ, vec2(-0.11, 0.09)) + uGrassTime * 2.3);
        float gAmp = (0.6 + 0.4 * gFlow) * gw * uGrassWind;
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
        vec3 flatNormal = normalize(mix(normalize(normal), vec3(0.0, 1.0, 0.0), 0.6));
        vWorldNormal = normalize(mat3(instanceMatrix) * mat3(modelMatrix) * flatNormal);
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(transformed, 1.0);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDir, uSunColor, uAmbient, uGrassScorchColor;
      varying float vGrassY, vTint, vInstShadow, vScorch;
      varying vec3 vWorldNormal;
      void main() {
        vec3 gLo = vec3(0.12,0.22,0.06), gHi = mix(vec3(0.34,0.55,0.16), vec3(0.45,0.5,0.14), vTint);
        float gAO = 0.6 + 0.4 * smoothstep(0.0, 0.2, vGrassY);
        vec3 baseColor = mix(gLo, gHi, clamp(vGrassY, 0.0, 1.0)) * gAO * 2.0;
        baseColor = mix(baseColor, uGrassScorchColor, vScorch);
        vec3 n = gl_FrontFacing ? vWorldNormal : -vWorldNormal;
        float ndl = max(dot(n, uSunDir), 0.0);
        vec3 lit = baseColor * (uAmbient + uSunColor * ndl * vInstShadow);
        gl_FragColor = vec4(lit, 1.0);
      }
    `
  })
  material.customProgramCacheKey = () => 'grassblade-lambert'
  return material
}
