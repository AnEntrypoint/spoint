// Grass blade geometry + wind/material factories for Grass.js's createGrass(). Pure builders --
// no per-instance streaming/chunk-management state, split out as that file's largest contiguous
// self-contained block. See Grass.js's own header for the full LOD/bend/decal design rationale.

import * as THREE from 'three'

// Player/actor bend: a small fixed-size array of nearby world-space XZ positions the vertex shader
// pushes blades radially away from (base-anchored, same tip-weighted falloff as the wind bend below),
// springing back upright once a bender leaves each blade's influence radius. MAX_BENDERS caps the
// uniform array size (and the per-frame CPU cost of building it) -- grass render distance is tens of
// metres, so a handful of nearby players/actors is the realistic max ever influencing one visible
// blade simultaneously; RenderGraph.nodes.js's foliage-lod-sync feeds only the nearest MAX_BENDERS
// actors within grassBendRadius of the local player, sorted by distance, so the cap silently degrades
// (farthest excess actors just don't bend grass) rather than ever overflowing the array.
export const MAX_BENDERS = 8

// Burn/flatten decals: a small fixed-size array of nearby scorch-stamp centers (world-space XZ, same
// space as uBenderPosXZ above), each with its own radius+strength, that the vertex shader shrinks and
// re-tints blades within. Distinct from the bender system above: benders are TRANSIENT (rebuilt fresh
// every frame from live actor positions, zero persisted state, springs back the instant an actor
// leaves), decals are PERSISTENT (backed by src/terrain/GrassDecal.js's sparse cell-Map world-state
// store -- once markScorched is called the effect stays until an explicit clear/regrowth, independent
// of any actor being nearby). MAX_DECALS caps the uniform array + per-frame nearest-stamp scan cost,
// same rationale as MAX_BENDERS: grass render distance is tens of metres so only a handful of decals
// are ever in view at once; nearestStamps() silently degrades (farthest excess decals just don't
// apply) rather than overflowing.
export const MAX_DECALS = 8

// 2 crossed tapered triangles (one along x, one along z), base at y=0, tip at y=1 (scaled per instance).
// Multi-segment curved ribbon blade (bends along its length under wind), two crossed quads for silhouette volume, one shared geometry across all instances.
// N is parameterized for the 2-geometry-tier LOD built in createGrass (Grass.js): N=5 near (curved, 20
// tris/blade), N=1 mid (flat crossed quad, 4 tris/blade -- the curve term still bakes in via the
// tip-only bend so a 1-segment blade still leans, it just can't bow mid-blade). Beyond the mid tier's
// cutoff blade curvature is genuinely invisible (sub-pixel at >15m per the PRD row); the THIRD (far) tier
// named by the task is deliberately the existing chunk-unload boundary + vertex-shader ring-fade, not a
// third real geometry -- see Grass.js's createGrass LOD block comment for the full scope-choice rationale.
export function makeBladeGeo(segments) {
  const N = Number.isFinite(segments) && segments >= 1 ? segments | 0 : 5
  const wBase = 0.07, curve = 0.18   // base half-width, baked forward arc (m at tip)
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
    // uBenderPosXZ: MAX_BENDERS packed (x,z) pairs (world XZ, same space as instanceMatrix). Unused
    // slots hold a position far outside any real chunk so their falloff term is always ~0 (cheaper than
    // branching per-slot in the shader). uBenderCount lets the loop skip empty slots outright.
    uBenderPosXZ: { value: new Float32Array(MAX_BENDERS * 2).fill(1e6) },
    uBenderCount: { value: 0 },
    uGrassBendRadius: { value: 2.2 },
    uGrassBendStrength: { value: 1.4 },
    // uDecalPosXZRS: MAX_DECALS packed (x,z,radius,strength) quads. Unused slots hold radius=0 so their
    // influence term is always exactly 0 regardless of position (cheaper/safer than a sentinel-distance
    // trick since radius, not distance, gates the falloff here). uDecalCount lets the loop skip empty
    // slots outright, same pattern as uBenderCount.
    uDecalPosXZRS: { value: new Float32Array(MAX_DECALS * 4) },
    uDecalCount: { value: 0 },
    uGrassScorchShrink: { value: 0.15 },   // blade scale multiplier at full scorch influence (near-flattened, not fully zero -- a scorched patch still has stubble)
    uGrassScorchColor: { value: new THREE.Color(0.22, 0.15, 0.06) },   // dry/burnt tint blended in at full influence
  }
}

// Hand-written Lambert-ish ShaderMaterial: replaces MeshStandardMaterial's full PBR (GGX specular,
// env IBL, real shadow-map PCF) with the cheap lighting model grass actually needs -- the fragment
// shader already discards most of the PBR output by overriding color and flattening the normal 60%
// toward up, so paying for GGX/IBL/PCF per fragment across tens of thousands of overlapping blades was
// pure waste. FrontSide only (was DoubleSide): back faces are flipped via gl_FrontFacing in the
// fragment stage instead of being drawn a second time, halving rasterized fragments for away-facing
// blades while keeping the same two-crossed-quad silhouette. No alphaTest (blades are geometric, not
// alpha-cutout) and no real shadow-map sampling (see uInstShadow -- a per-instance cached terrain-shadow
// scalar set once per blade instance, sampled in the vertex shader, never a per-fragment PCF fetch).
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
    // no alphaTest: blades are opaque triangle geometry, alphaTest would defeat early-Z for nothing gained
    vertexShader: `
      uniform float uGrassTime, uGrassWind, uGrassRing;
      uniform vec2 uGrassWindDir, uCamPosXZ;
      uniform vec2 uBenderPosXZ[${MAX_BENDERS}];
      uniform int uBenderCount;
      uniform float uGrassBendRadius, uGrassBendStrength;
      // uDecalPosXZRS: packed (x,z,radius,strength) per decal -- burn/flatten world-state, see
      // src/terrain/GrassDecal.js. Unlike the bender loop above (radius is a single shared uniform),
      // each decal carries its OWN radius+strength since real-world stamps (a small vehicle track vs a
      // large explosion crater) vary in both.
      uniform vec4 uDecalPosXZRS[${MAX_DECALS}];
      uniform int uDecalCount;
      uniform float uGrassScorchShrink;
      uniform vec3 uGrassScorchColor;
      // windPhase/tint/instShadow are NOT declared here -- InstancedMesh2.initUniformsPerInstance's
      // material patch (wrapping this material's onBeforeCompile/customProgramCacheKey, see Uniforms.js
      // + SquareDataTexture.getUniformsVertexGLSL) injects their float name; global declarations and
      // per-instance texel-fetch assignment itself, ahead of this shader's own void main() body.
      // instShadow: per-instance cached terrain-shadow scalar (0=fully shadowed .. 1=fully lit), set once
      // per blade instance at placement time from the terrain-slope self-shadow approximation in
      // src/terrain/GrassPlacement.js -- never a real per-fragment shadow-map PCF fetch.
      //
      // instancedmesh2-instanceindex-undeclared-identifier-vegetation-shader: InstancedMesh2's per-instance
      // uniform injection (the windPhase/instShadow/tint texel-fetch above) ALSO needs the instanceIndex
      // vertex attribute in scope -- normally provided for free by THREE's own ShaderLib templates via
      // '#include <batching_pars_vertex>' (which @three.ez's ShaderChunk.js concatenates its own
      // instanced_pars_vertex chunk onto), but this is a hand-written raw ShaderMaterial with NEITHER
      // include, so instanceIndex was genuinely undeclared -- real live GL compile failure caught via a
      // WebGL2RenderingContext.prototype.compileShader monkeypatch (ERROR 0:86/0:177 'instanceIndex' :
      // undeclared identifier), reproduced live at PORT=8250 after ~29s of real gameplay streaming grass
      // chunks in. '#include <instanced_pars_vertex>' (resolved by THREE's own resolveIncludes, which runs
      // on every material's final shader string, ShaderMaterial included) declares BOTH instanceIndex and
      // getInstancedMatrix(). This InstancedMesh2 also always sets USE_INSTANCING_INDIRECT (see
      // InstancedMesh2.js _onBeforeCompile), which makes the raw instanceMatrix ATTRIBUTE a dummy
      // zero-length buffer (the real per-instance matrix lives in matricesTexture instead) -- so every
      // pre-existing raw instanceMatrix read below was ALSO silently wrong (would have rendered
      // degenerate/zeroed blade transforms once the instanceIndex fix alone made this shader compile);
      // fixed by locally shadowing instanceMatrix with the real computed matrix, the same pattern THREE's
      // own instanced_vertex chunk uses for its built-in ShaderLib materials.
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
        // Player/actor bend: radial push AWAY from each nearby bender's XZ position, same tip-weighted
        // falloff (gw, 0 at base / max at tip) as the wind sway above so blades pivot from their planted
        // base rather than translating whole -- and springs back to upright the instant a bender's
        // distance exceeds uGrassBendRadius (a pure per-frame function of live bender position, no
        // stored/animated spring state needed: the blade IS upright whenever no bender is close, and
        // smoothstep gives a soft, non-snappy edge rather than a hard cutoff).
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
        // Bent blades lean rather than stretch: pull the tip down proportional to how far it swept
        // sideways, same small-angle approximation as a rigid pivot (keeps blade length ~constant).
        transformed.y -= length(bendXZ) * gw * 0.35;
        // Burn/flatten decal: unlike the bend loop above (a radial push), scorch is a pure SCALE-DOWN
        // (shorter/thinner blade) + tint shift toward uGrassScorchColor -- no directional displacement,
        // since a scorched patch has no "away from" direction the way a walked-through blade does.
        // Per-decal falloff uses each stamp's own radius (smoothstep, soft edge matching GrassDecal.js's
        // cosine-falloff intent closely enough for a cheap GPU approximation), strength scales its peak.
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
        // flatten toward up, same 60% blend as before, computed once here (object-space, cheap) and
        // carried to the fragment stage as a varying instead of touched per-fragment
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
        // Scorch tint: blend toward the dry/burnt color at full decal influence, same vScorch scalar
        // that already shrank blade scale in the vertex stage.
        baseColor = mix(baseColor, uGrassScorchColor, vScorch);
        // gl_FrontFacing flip: with FrontSide-only draw the two crossed quads still need a lit back
        // face when viewed from behind, so mirror the normal instead of relying on a second draw pass.
        vec3 n = gl_FrontFacing ? vWorldNormal : -vWorldNormal;
        // cheap Lambert-ish diffuse + baked/approximate AO, no GGX specular lobe, no env IBL sample --
        // the flattened normal already means a full PBR BRDF evaluation would mostly reduce to this.
        float ndl = max(dot(n, uSunDir), 0.0);
        // per-instance cached terrain-shadow value stands in for a real shadow-map PCF fetch
        vec3 lit = baseColor * (uAmbient + uSunColor * ndl * vInstShadow);
        gl_FragColor = vec4(lit, 1.0);
      }
    `
  })
  material.customProgramCacheKey = () => 'grassblade-lambert'
  return material
}
