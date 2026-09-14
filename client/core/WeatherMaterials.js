import * as THREE from 'three'

export function makeStreakGeo() {
  const halfWidth = 0.012, streakLength = 0.55
  const pos = new Float32Array([
    -halfWidth, 0, 0, halfWidth, 0, 0, halfWidth, -streakLength, 0,
    -halfWidth, 0, 0, halfWidth, -streakLength, 0, -halfWidth, -streakLength, 0,
  ])
  const uv = new Float32Array([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0])
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.computeBoundingSphere(); g.computeBoundingBox()
  return g
}

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

export function makeRainMaterial() {
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
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

export function makeSplashMaterial() {
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0.8, 0.85, 0.92) }, uLifeS: { value: 0.4 } },
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
