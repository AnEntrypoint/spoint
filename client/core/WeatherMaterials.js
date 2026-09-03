// Pure geometry/material factories for Weather.js's rain/snow/splash/far-sheet InstancedMesh2 tiers.
// No per-instance simulation state -- these build shared geometry buffers and ShaderMaterials once,
// consumed by createWeather()'s stateful update loop in Weather.js itself.

import * as THREE from 'three'

// Streak quad: a thin vertical billboard-ish quad (not a full 3D cylinder -- rain streaks read as a
// 2D motion-blurred line from any practical viewing angle, matching the cheap-shading discipline
// Grass.js documents for its own Lambert-lite material). Built once, shared across all instances.
export function makeStreakGeo() {
  const w = 0.012, h = 0.55 // half-width negligible, tall thin quad in local Y (falls along -Y)
  const pos = new Float32Array([
    -w, 0, 0, w, 0, 0, w, -h, 0,
    -w, 0, 0, w, -h, 0, -w, -h, 0,
  ])
  const uv = new Float32Array([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0])
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.computeBoundingSphere(); g.computeBoundingBox()
  return g
}

// Splash ring: a small flat quad billboard, GPU-expanded+faded in the shader from droplet-recycle time
// (see makeSplashMaterial) rather than real ring geometry -- cheaper than a torus/segmented-ring mesh
// for a sub-half-second cosmetic pulse.
export function makeSplashGeo() {
  const s = 0.5
  const pos = new Float32Array([-s, 0, -s, s, 0, -s, s, 0, s, -s, 0, -s, s, 0, s, -s, 0, s])
  const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1])
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.computeBoundingSphere(); g.computeBoundingBox()
  return g
}

// Rain streak material: per-instance fall-streak alpha, faces the camera around the vertical axis only
// (billboarded in Y, matching how real rain is seen -- always "hanging" vertically regardless of view
// yaw) via a per-instance yaw baked into the instance matrix at spawn (see Weather.js's
// _respawnDroplet), refreshed only when the camera's OWN yaw changes enough to matter (see update()'s
// _lastCamYaw gate) rather than every frame -- rain streaks are thin enough that sub-degree billboard
// error is imperceptible.
export function makeRainMaterial() {
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    // uOpacity 0.35 (this system's original, never-tuned default) read as barely-visible against a
    // bright sky/ambient background: the fragment shader already multiplies this ceiling down further
    // by vFade (edge falloff, ~0 at the streak's own left/right edge) and streak (~0 at the streak's
    // own top/bottom), so a center-pixel best case never exceeds 0.35 and most of the visible quad sits
    // well under it -- compare snow's own uOpacity of 0.8 (makeSnowMaterial below) for a much simpler,
    // smaller particle. Raised to read clearly while still staying a translucent streak, not an opaque line.
    uniforms: { uColor: { value: new THREE.Color(0.72, 0.78, 0.86) }, uOpacity: { value: 0.6 } },
    vertexShader: `
      varying vec2 vUv;
      varying float vFade;
      void main() {
        vUv = uv;
        // fade the quad edges (uv.x) so the streak reads as a soft line, not a hard-edged rectangle
        vFade = 1.0 - abs(uv.x * 2.0 - 1.0);
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor; uniform float uOpacity;
      varying vec2 vUv; varying float vFade;
      void main() {
        float streak = smoothstep(0.0, 0.15, vUv.y) * smoothstep(1.0, 0.85, vUv.y);
        float a = uOpacity * vFade * (0.3 + 0.7 * streak);
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  })
  material.customProgramCacheKey = () => 'weather-rain-streak'
  return material
}

// Splash material: a soft radial ring that expands + fades over its own per-instance lifetime
// (uSplashTime holds the SHARED clock value at spawn, per-instance via initUniformsPerInstance --
// elapsed = uTime - spawnTime, matching Grass.js's windPhase-style per-instance uniform pattern).
export function makeSplashMaterial() {
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0.8, 0.85, 0.92) }, uLifeS: { value: 0.4 } },
    // instancedmesh2-instanceindex-undeclared-identifier-vegetation-shader: initUniformsPerInstance's
    // (see the call below) windPhase/spawnTime-style texel-fetch injection needs the instanceIndex
    // vertex attribute in scope, normally free via THREE's own '#include <batching_pars_vertex>' but
    // absent from this hand-written ShaderMaterial -- same class of real live GL compile failure as
    // Grass.js/SSAO.js/Vegetation.js's addShadowLOD sites (ERROR 0:83 'instanceIndex' : undeclared
    // identifier, caught live via a WebGL2RenderingContext.prototype.compileShader monkeypatch, real
    // booted server + weather splash particles streamed in during real gameplay, PORT=8250).
    // '#include <instanced_pars_vertex>' declares instanceIndex + getInstancedMatrix(); the raw
    // instanceMatrix attribute is a dummy zero-length buffer under InstancedMesh2's always-on
    // USE_INSTANCING_INDIRECT mode (the real per-instance matrix lives in matricesTexture), so the
    // pre-existing raw instanceMatrix read below was also silently wrong -- fixed by locally shadowing
    // it with the real computed matrix.
    vertexShader: `
      uniform float uTime, uLifeS;
      varying vec2 vUv; varying float vAlpha;
      #include <instanced_pars_vertex>
      void main() {
        #ifdef USE_INSTANCING_INDIRECT
          mat4 instanceMatrix = getInstancedMatrix();
        #endif
        vUv = uv;
        float age = clamp((uTime - spawnTime) / uLifeS, 0.0, 1.0);
        vAlpha = (1.0 - age) * step(0.0, spawnTime);
        float scale = mix(0.15, 1.0, age);
        vec3 p = position * scale;
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying vec2 vUv; varying float vAlpha;
      void main() {
        float d = distance(vUv, vec2(0.5));
        float ring = smoothstep(0.5, 0.38, d) - smoothstep(0.38, 0.28, d);
        float a = ring * vAlpha * 0.5;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  })
  material.customProgramCacheKey = () => 'weather-splash-ring'
  return material
}

// Snow flake quad: a small flat square (not a thin streak like rain -- snow falls slowly enough to read
// as a soft round dot/blob, not a motion-blurred line), billboarded FULLY toward the camera (both yaw
// AND pitch, unlike rain's yaw-only vertical hang) since a flat square only reads correctly face-on.
export function makeFlakeGeo() {
  const s = 0.05
  const pos = new Float32Array([-s, -s, 0, s, -s, 0, s, s, 0, -s, -s, 0, s, s, 0, -s, s, 0])
  const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1])
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.computeBoundingSphere(); g.computeBoundingBox()
  return g
}

// Snow flake material: soft radial falloff (round dot, not a hard-edged square), full camera-facing
// billboard done via the instance quaternion (set once per frame, see Weather.js's update() -- unlike
// rain's cheap yaw-only refresh, full billboarding is unavoidable for a flat square viewed from any pitch).
export function makeSnowMaterial() {
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(0.95, 0.97, 1.0) }, uOpacity: { value: 0.8 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor; uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        float d = distance(vUv, vec2(0.5));
        float a = uOpacity * smoothstep(0.5, 0.15, d);
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  })
  material.customProgramCacheKey = () => 'weather-snow-flake'
  return material
}

// Far billboard-sheet tier material: identical visual language to the near-tier material it mirrors
// (rain streak or snow flake) but with a distance-based fade baked in (uFadeNear/uFadeFar, per-instance
// distance computed in the vertex shader from view-space Z) so the far sheet's own outer edge (where its
// own box wrap would otherwise produce a visible "wall" of particles popping in/out) fades smoothly
// instead of hard-cutting -- the one extra bit of shader work this cheap tier needs since it deliberately
// has no per-instance CPU-side fade bookkeeping (see Weather.js's tier-shape comment: far tier is
// Y-fall + wrap ONLY, no per-particle state beyond position).
export function makeFarSheetMaterial(baseColor, opacity, roundDot) {
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: baseColor.clone() }, uOpacity: { value: opacity },
      uFadeNear: { value: 40 }, uFadeFar: { value: 90 },
    },
    vertexShader: `
      varying vec2 vUv; varying float vDist;
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vDist = -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor; uniform float uOpacity, uFadeNear, uFadeFar;
      varying vec2 vUv; varying float vDist;
      void main() {
        float shape = ${roundDot ? 'smoothstep(0.5, 0.15, distance(vUv, vec2(0.5)))' : '(smoothstep(0.0, 0.15, vUv.y) * smoothstep(1.0, 0.85, vUv.y) * (1.0 - abs(vUv.x * 2.0 - 1.0)))'};
        float fadeIn = smoothstep(uFadeNear, uFadeNear + 8.0, vDist);
        float fadeOut = 1.0 - smoothstep(uFadeFar - 10.0, uFadeFar, vDist);
        float a = uOpacity * shape * fadeIn * fadeOut;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  })
  material.customProgramCacheKey = () => `weather-far-sheet-${roundDot ? 'snow' : 'rain'}`
  return material
}
