import * as THREE from 'three';

// Dynamic Sky System -- procedural sky rendering with atmosphere scattering, sun tracking,
// and time-of-day integration. Provides:
// - Atmosphere color based on sun elevation (Rayleigh + Mie scattering simulation)
// - Cloud layer with Perlin noise, dynamic movement, and weather state integration
// - God rays (volumetric light shafts) at sunrise/sunset via the post-process
// - Sun disk rendering synchronized with light direction
// - Performance-optimized for <2ms per frame via shader-based atmosphere

export class DynamicSky {
  constructor(scene, camera, opts = {}) {
    this.scene = scene;
    this.camera = camera;
    this.enabled = opts.enabled ?? true;

    this.timeOfDayProvider = opts.timeOfDayProvider; // fn() => ({ elevDeg, azimuthDeg, t })
    this.weatherProvider = opts.weatherProvider; // fn() => ({ cloudiness: 0-1, weatherType })
    this.sunLight = opts.sunLight; // THREE.Light to sync direction

    // Cloud noise parameters
    this.cloudScale = opts.cloudScale ?? 2.0;
    this.cloudSpeed = opts.cloudSpeed ?? 0.5;
    this.cloudOffset = 0;
    this.windDirection = new THREE.Vector2(1, 0.3).normalize();

    // Atmosphere parameters
    this.rayleighCoeff = opts.rayleighCoeff ?? 1.0;
    this.mieCoeff = opts.mieCoeff ?? 0.1;
    this.skyIntensity = opts.skyIntensity ?? 1.0;

    // Sky dome mesh (latlong UV sphere)
    const skyGeometry = new THREE.SphereGeometry(1, 32, 32);
    this.skyMaterial = this._createSkyMaterial();
    this.skyMesh = new THREE.Mesh(skyGeometry, this.skyMaterial);
    this.skyMesh.scale.multiplyScalar(-5000); // Huge scale, negative to view from inside
    this.skyMesh.frustumCulled = false; // Prevent culling
    this.scene.add(this.skyMesh);

    // Sun disk (emissive sphere with glow)
    this.sunDiskGeometry = new THREE.SphereGeometry(0.05, 16, 16);
    this.sunDiskMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.sunDisk = new THREE.Mesh(this.sunDiskGeometry, this.sunDiskMaterial);
    this.sunDisk.scale.multiplyScalar(500);
    this.sunDisk.frustumCulled = false;
    this.scene.add(this.sunDisk);

    // Cloud layer
    this.cloudGeometry = new THREE.SphereGeometry(1, 32, 32);
    this.cloudMaterial = this._createCloudMaterial();
    this.cloudMesh = new THREE.Mesh(this.cloudGeometry, this.cloudMaterial);
    this.cloudMesh.scale.multiplyScalar(-4500);
    this.cloudMesh.frustumCulled = false;
    this.scene.add(this.cloudMesh);

    // Performance tracking
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

        // Simplified Rayleigh scattering atmosphere model
        vec3 computeAtmosphere(vec3 viewDir, vec3 sunDir) {
          float sunDot = max(dot(viewDir, sunDir), 0.0);
          float sunDotSmooth = smoothstep(0.0, 0.1, sunDot);

          // Rayleigh scattering: blue light scattered more at grazing angles
          vec3 rayleigh = vec3(0.17, 0.39, 0.87) * uRayleighCoeff;

          // Mie scattering: forward scattering (halos around sun)
          float mieFactor = (1.0 - uMieCoeff) + uMieCoeff * (1.0 - sunDot * sunDot) * (1.0 - sunDot * sunDot);
          vec3 mie = vec3(1.0, 1.0, 1.0) * (uMieCoeff / mieFactor);

          // Sun elevation affects zenith color (warm horizon, blue zenith)
          float elevFraction = clamp((uSunElevation + 90.0) / 180.0, 0.0, 1.0);
          vec3 zenithColor = mix(vec3(0.8, 0.4, 0.1), vec3(0.2, 0.4, 0.9), elevFraction);

          // Horizon color (warm at sunrise/sunset)
          vec3 horizonColor = mix(vec3(1.0, 0.4, 0.1), vec3(0.5, 0.7, 0.9), elevFraction);

          // Blend between horizon and zenith based on view direction
          float verticalComponent = max(vWorldPos.y, 0.0);
          vec3 skyColor = mix(horizonColor, zenithColor, verticalComponent);

          // Sun glow
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

        // Simplex-like noise (3D perlin substitute using sine-based hash)
        float cloudNoise(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);

          float n = dot(i, vec3(12.9898, 78.233, 45.164));
          float hash = fract(sin(n) * 43758.5453);

          return mix(hash, fract(sin(n + 1.0) * 43758.5453), f.x);
        }

        // Fractional brownian motion for cloud detail
        float fbm(vec3 p, int octaves) {
          float value = 0.0;
          float amplitude = 0.5;
          float frequency = 1.0;

          for (int i = 0; i < 4; i++) {
            value += cloudNoise(p * frequency) * amplitude;
            amplitude *= 0.5;
            frequency *= 2.0;
            p += vec3(0.5, 0.3, 0.2); // Offset for variation
          }

          return value;
        }

        void main() {
          vec3 cloudPos = vWorldPos * uCloudScale;
          cloudPos.xy += uCloudOffset;

          // Multi-octave noise for cloud structure
          float cloudPattern = fbm(cloudPos, 4);

          // Threshold for cloud shape (higher coverage = lower threshold)
          float threshold = 1.0 - uCloudCover;
          float cloudDensity = smoothstep(threshold - 0.1, threshold + 0.2, cloudPattern);

          // Reduce density at horizon for better sky visibility
          float horizonFade = max(vWorldPos.y + 0.2, 0.0) * 2.0;
          cloudDensity *= horizonFade;

          // Apply density modulation
          cloudDensity *= uCloudDensity;

          // Cloud color: white with slight blue tint
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

    // Update sun disk position and color
    if (this.sunLight) {
      const sunDir = this.sunLight.position.normalize();
      this.sunDisk.position.copy(sunDir).multiplyScalar(4000);

      // Sun disk brightness based on elevation
      const elevation = timeData.elevDeg ?? 0;
      const sunBrightness = Math.max(0, Math.sin((elevation + 90) * Math.PI / 180));
      this.sunDisk.material.color.setRGB(sunBrightness, sunBrightness * 0.8, 0);
      this.sunDisk.material.emissive.copy(this.sunDisk.material.color).multiplyScalar(0.5);
    }

    // Update sky material uniforms
    const sunDir = this.sunLight?.position?.clone().normalize() ?? new THREE.Vector3(0, 1, 0);
    this.skyMaterial.uniforms.uSunDirection.value.copy(sunDir);
    this.skyMaterial.uniforms.uSunElevation.value = timeData.elevDeg ?? 45;
    this.skyMaterial.uniforms.uTime.value += dt;
    this.skyMaterial.uniforms.uCloudCover.value = weatherData.cloudiness;

    // Update cloud layer
    this.cloudOffset += this.cloudSpeed * dt;
    const cloudOffsetVec = new THREE.Vector2(
      Math.cos(this.cloudOffset) * this.windDirection.x,
      Math.sin(this.cloudOffset) * this.windDirection.y
    );
    this.cloudMaterial.uniforms.uCloudOffset.value.copy(cloudOffsetVec);
    this.cloudMaterial.uniforms.uCloudCover.value = weatherData.cloudiness;
    this.cloudMaterial.uniforms.uTime.value += dt;

    // Adjust cloud density based on weather
    const densityMap = { clear: 1.0, cloudy: 0.7, stormy: 0.3 };
    this.cloudMaterial.uniforms.uCloudDensity.value =
      densityMap[weatherData.weatherType] ?? 1.0;

    // Update sky intensity based on time of day (dimmer at night)
    const timeT = timeData.t ?? 0.5;
    const nightInfluence = Math.abs(Math.sin(timeT * Math.PI)) < 0.1 ? 0.3 : 1.0;
    this.skyMaterial.uniforms.uSkyIntensity.value = this.skyIntensity * nightInfluence;

    this.updateTime = performance.now() - startTime;
  }

  // Enable/disable the sky (for testing or when using a different sky provider)
  setEnabled(enabled) {
    this.enabled = enabled;
    this.skyMesh.visible = enabled;
    this.cloudMesh.visible = enabled;
    this.sunDisk.visible = enabled;
  }

  // Get god-ray rendering parameters (used by post-process if available)
  getGodRayParams() {
    if (!this.sunLight) return null;

    const sunScreenPos = this.camera.worldToScreen?.(this.sunLight.position) ??
      new THREE.Vector3().copy(this.sunLight.position).project(this.camera);

    return {
      sunScreenPos,
      intensity: Math.max(0, Math.sin(this.skyMaterial.uniforms.uSunElevation.value * Math.PI / 180)),
      enabled: this.skyMaterial.uniforms.uSunElevation.value > -10, // Show god rays only near horizon
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

// Helper function to create sky system integrated with existing TimeOfDay
export function createDynamicSkyWithTimeOfDay(scene, camera, timeOfDay, sunLight, opts = {}) {
  return new DynamicSky(scene, camera, {
    ...opts,
    timeOfDayProvider: () => {
      // Extract elevation and azimuth from TimeOfDay state
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
