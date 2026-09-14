import * as THREE from 'three';

const SKY_DOME_INSIDE_OUT_SCALE = -5000;
const GOD_RAY_MIN_SUN_ELEVATION_DEG = -10;

export class DynamicSky {
  constructor(scene, camera, opts = {}) {
    this.scene = scene;
    this.camera = camera;
    this.enabled = opts.enabled ?? true;

    this.timeOfDayProvider = opts.timeOfDayProvider;
    this.weatherProvider = opts.weatherProvider;
    this.sunLight = opts.sunLight;

    this.cloudScale = opts.cloudScale ?? 2.0;
    this.cloudSpeed = opts.cloudSpeed ?? 0.5;
    this.cloudOffset = 0;
    this.windDirection = new THREE.Vector2(1, 0.3).normalize();

    this.rayleighCoeff = opts.rayleighCoeff ?? 1.0;
    this.mieCoeff = opts.mieCoeff ?? 0.1;
    this.skyIntensity = opts.skyIntensity ?? 1.0;

    const skyGeometry = new THREE.SphereGeometry(1, 32, 32);
    this.skyMaterial = this._createSkyMaterial();
    this.skyMesh = new THREE.Mesh(skyGeometry, this.skyMaterial);
    this.skyMesh.scale.multiplyScalar(SKY_DOME_INSIDE_OUT_SCALE);
    this.skyMesh.frustumCulled = false;
    this.scene.add(this.skyMesh);

    this.sunDiskGeometry = new THREE.SphereGeometry(0.05, 16, 16);
    this.sunDiskMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.sunDisk = new THREE.Mesh(this.sunDiskGeometry, this.sunDiskMaterial);
    this.sunDisk.scale.multiplyScalar(500);
    this.sunDisk.frustumCulled = false;
    this.scene.add(this.sunDisk);

    this.cloudGeometry = new THREE.SphereGeometry(1, 32, 32);
    this.cloudMaterial = this._createCloudMaterial();
    this.cloudMesh = new THREE.Mesh(this.cloudGeometry, this.cloudMaterial);
    this.cloudMesh.scale.multiplyScalar(-4500);
    this.cloudMesh.frustumCulled = false;
    this.scene.add(this.cloudMesh);

    this.updateTime = 0;
  }

  _createSkyMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uSunElevation: { value: 45 },
        uRayleighCoeff: { value: this.rayleighCoeff },
        uMieCoeff: { value: this.mieCoeff },
        uSkyIntensity: { value: this.skyIntensity },
        uCloudCover: { value: 0.3 },
        uTime: { value: 0 },
      },
      vertexShader: `
        varying vec3 vWorldPos;
        varying vec3 vSunDirection;

        void main() {
          vWorldPos = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision mediump float;
        varying vec3 vWorldPos;

        uniform vec3 uSunDirection;
        uniform float uSunElevation;
        uniform float uRayleighCoeff;
        uniform float uMieCoeff;
        uniform float uSkyIntensity;
        uniform float uCloudCover;
        uniform float uTime;

        vec3 computeAtmosphere(vec3 viewDir, vec3 sunDir) {
          float sunDot = max(dot(viewDir, sunDir), 0.0);
          float sunDotSmooth = smoothstep(0.0, 0.1, sunDot);

          vec3 rayleigh = vec3(0.17, 0.39, 0.87) * uRayleighCoeff;

          float mieFactor = (1.0 - uMieCoeff) + uMieCoeff * (1.0 - sunDot * sunDot) * (1.0 - sunDot * sunDot);
          vec3 mie = vec3(1.0, 1.0, 1.0) * (uMieCoeff / mieFactor);

          float elevFraction = clamp((uSunElevation + 90.0) / 180.0, 0.0, 1.0);
          vec3 zenithColor = mix(vec3(0.8, 0.4, 0.1), vec3(0.2, 0.4, 0.9), elevFraction);

          vec3 horizonColor = mix(vec3(1.0, 0.4, 0.1), vec3(0.5, 0.7, 0.9), elevFraction);

          float verticalComponent = max(vWorldPos.y, 0.0);
          vec3 skyColor = mix(horizonColor, zenithColor, verticalComponent);

          vec3 sunGlow = sunDotSmooth * vec3(1.0, 0.8, 0.4) * (1.0 - abs(uSunElevation) / 90.0);

          return (skyColor * rayleigh + sunGlow * mie) * uSkyIntensity;
        }

        void main() {
          vec3 atm = computeAtmosphere(vWorldPos, uSunDirection);
          gl_FragColor = vec4(atm, 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
    });
  }

  _createCloudMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uCloudCover: { value: 0.5 },
        uCloudDensity: { value: 1.0 },
        uTime: { value: 0 },
        uCloudOffset: { value: new THREE.Vector2(0, 0) },
        uWindDirection: { value: new THREE.Vector2(1, 0.3).normalize() },
        uCloudScale: { value: 2.0 },
      },
      vertexShader: `
        varying vec3 vWorldPos;

        void main() {
          vWorldPos = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision mediump float;
        varying vec3 vWorldPos;

        uniform float uCloudCover;
        uniform float uCloudDensity;
        uniform float uTime;
        uniform vec2 uCloudOffset;
        uniform vec2 uWindDirection;
        uniform float uCloudScale;

        float cloudNoise(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);

          float n = dot(i, vec3(12.9898, 78.233, 45.164));
          float hash = fract(sin(n) * 43758.5453);

          return mix(hash, fract(sin(n + 1.0) * 43758.5453), f.x);
        }

        float fbm(vec3 p, int octaves) {
          float value = 0.0;
          float amplitude = 0.5;
          float frequency = 1.0;

          for (int i = 0; i < 4; i++) {
            value += cloudNoise(p * frequency) * amplitude;
            amplitude *= 0.5;
            frequency *= 2.0;
            p += vec3(0.5, 0.3, 0.2);
          }

          return value;
        }

        void main() {
          vec3 cloudPos = vWorldPos * uCloudScale;
          cloudPos.xy += uCloudOffset;

          float cloudPattern = fbm(cloudPos, 4);

          float threshold = 1.0 - uCloudCover;
          float cloudDensity = smoothstep(threshold - 0.1, threshold + 0.2, cloudPattern);

          float horizonFade = max(vWorldPos.y + 0.2, 0.0) * 2.0;
          cloudDensity *= horizonFade;

          cloudDensity *= uCloudDensity;

          vec3 cloudColor = vec3(0.95, 0.96, 0.98);
          vec3 shadowColor = vec3(0.3, 0.3, 0.4);
          vec3 finalColor = mix(shadowColor, cloudColor, cloudDensity);

          gl_FragColor = vec4(finalColor, cloudDensity);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
      transparent: true,
      blending: THREE.NormalBlending,
    });
  }

  update(dt) {
    const startTime = performance.now();

    if (!this.enabled || !this.timeOfDayProvider) {
      this.updateTime = performance.now() - startTime;
      return;
    }

    const timeData = this.timeOfDayProvider();
    const weatherData = this.weatherProvider?.() ?? { cloudiness: 0.3, weatherType: 'clear' };

    if (this.sunLight) {
      const sunDir = this.sunLight.position.normalize();
      this.sunDisk.position.copy(sunDir).multiplyScalar(4000);

      const elevation = timeData.elevDeg ?? 0;
      const sunBrightness = Math.max(0, Math.sin((elevation + 90) * Math.PI / 180));
      this.sunDisk.material.color.setRGB(sunBrightness, sunBrightness * 0.8, 0);
      this.sunDisk.material.emissive.copy(this.sunDisk.material.color).multiplyScalar(0.5);
    }

    const sunDir = this.sunLight?.position?.clone().normalize() ?? new THREE.Vector3(0, 1, 0);
    this.skyMaterial.uniforms.uSunDirection.value.copy(sunDir);
    this.skyMaterial.uniforms.uSunElevation.value = timeData.elevDeg ?? 45;
    this.skyMaterial.uniforms.uTime.value += dt;
    this.skyMaterial.uniforms.uCloudCover.value = weatherData.cloudiness;

    this.cloudOffset += this.cloudSpeed * dt;
    const cloudOffsetVec = new THREE.Vector2(
      Math.cos(this.cloudOffset) * this.windDirection.x,
      Math.sin(this.cloudOffset) * this.windDirection.y
    );
    this.cloudMaterial.uniforms.uCloudOffset.value.copy(cloudOffsetVec);
    this.cloudMaterial.uniforms.uCloudCover.value = weatherData.cloudiness;
    this.cloudMaterial.uniforms.uTime.value += dt;

    const densityMap = { clear: 1.0, cloudy: 0.7, stormy: 0.3 };
    this.cloudMaterial.uniforms.uCloudDensity.value =
      densityMap[weatherData.weatherType] ?? 1.0;

    const timeT = timeData.t ?? 0.5;
    const nightInfluence = Math.abs(Math.sin(timeT * Math.PI)) < 0.1 ? 0.3 : 1.0;
    this.skyMaterial.uniforms.uSkyIntensity.value = this.skyIntensity * nightInfluence;

    this.updateTime = performance.now() - startTime;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.skyMesh.visible = enabled;
    this.cloudMesh.visible = enabled;
    this.sunDisk.visible = enabled;
  }

  getGodRayParams() {
    if (!this.sunLight) return null;

    const sunScreenPos = this.camera.worldToScreen?.(this.sunLight.position) ??
      new THREE.Vector3().copy(this.sunLight.position).project(this.camera);

    return {
      sunScreenPos,
      intensity: Math.max(0, Math.sin(this.skyMaterial.uniforms.uSunElevation.value * Math.PI / 180)),
      enabled: this.skyMaterial.uniforms.uSunElevation.value > GOD_RAY_MIN_SUN_ELEVATION_DEG,
    };
  }

  dispose() {
    this.skyGeometry?.dispose?.();
    this.skyMaterial.dispose();
    this.skyMesh.geometry.dispose();

    this.sunDiskGeometry.dispose();
    this.sunDiskMaterial.dispose();

    this.cloudGeometry.dispose();
    this.cloudMaterial.dispose();
    this.cloudMesh.geometry.dispose();

    this.scene.remove(this.skyMesh);
    this.scene.remove(this.sunDisk);
    this.scene.remove(this.cloudMesh);
  }
}

export function createDynamicSkyWithTimeOfDay(scene, camera, timeOfDay, sunLight, opts = {}) {
  return new DynamicSky(scene, camera, {
    ...opts,
    timeOfDayProvider: () => {
      const state = timeOfDay.getState?.() ?? {};
      return {
        elevDeg: state.sunElevationDeg ?? 45,
        azimuthDeg: state.sunAzimuthDeg ?? 0,
        t: state.dayFraction ?? 0.5,
      };
    },
    sunLight,
  });
}
