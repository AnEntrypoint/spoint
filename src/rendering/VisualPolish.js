import * as THREE from 'three';

// Visual Polish -- improvements to post-processing and rendering quality
// Includes: SSAO quality tuning, bloom threshold optimization, motion blur (optional),
// and color grading adjustments.

// SSAO Quality Presets -- tuned for visual quality while maintaining performance
export const SSAOPresets = {
  LOW: {
    kernelRadius: 0.5,
    kernelSize: 8,
    bias: 0.01,
    power: 1.5,
    scale: 0.5,
  },
  MEDIUM: {
    kernelRadius: 1.0,
    kernelSize: 16,
    bias: 0.0075,
    power: 2.0,
    scale: 1.0,
  },
  HIGH: {
    kernelRadius: 2.0,
    kernelSize: 32,
    bias: 0.005,
    power: 2.5,
    scale: 1.5,
  },
};

// Bloom threshold tuning for different lighting conditions and quality tiers
export const BloomPresets = {
  LOW: {
    threshold: 0.8,
    smoothWidth: 0.4,
    intensity: 0.5,
    radius: 0.5,
  },
  MEDIUM: {
    threshold: 0.7,
    smoothWidth: 0.4,
    intensity: 0.8,
    radius: 0.8,
  },
  HIGH: {
    threshold: 0.65,
    smoothWidth: 0.2,
    intensity: 1.0,
    radius: 1.0,
  },
  ULTRA: {
    threshold: 0.6,
    smoothWidth: 0.1,
    intensity: 1.2,
    radius: 1.2,
  },
};

// Motion Blur -- optional cinematic motion blur effect
export class MotionBlur {
  constructor(scene, camera, renderer, opts = {}) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.enabled = opts.enabled ?? false;
    this.strength = opts.strength ?? 0.5; // 0-1
    this.samples = opts.samples ?? 8; // Number of blur samples
    this.renderTarget = new THREE.WebGLRenderTarget(
      renderer.domElement.width,
      renderer.domElement.height,
      {
        format: THREE.RGBAFormat,
        type: THREE.FloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      }
    );

    this.velocityMaterial = this._createVelocityMaterial();
    this.blurMaterial = this._createBlurMaterial();
    this.previousViewMatrix = camera.matrixWorldInverse.clone();
  }

  _createVelocityMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        uPrevViewMatrix: { value: this.camera.matrixWorldInverse.clone() },
      },
      vertexShader: `
        varying vec3 vPos;
        varying vec4 vPrevPos;

        uniform mat4 uPrevViewMatrix;

        void main() {
          vPos = position;
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          vPrevPos = projectionMatrix * (uPrevViewMatrix * worldMatrix * vec4(position, 1.0));
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        varying vec3 vPos;
        varying vec4 vPrevPos;

        void main() {
          vec2 uv = gl_FragCoord.xy / vec2(1920.0, 1080.0);
          vec2 prevUv = (vPrevPos.xy / vPrevPos.w) * 0.5 + 0.5;
          vec2 velocity = uv - prevUv;
          gl_FragColor = vec4(velocity, 0.0, 1.0);
        }
      `,
      transparent: false,
      depthWrite: true,
    });
  }

  _createBlurMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tVelocity: { value: null },
        uStrength: { value: this.strength },
        uSampleCount: { value: this.samples },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision mediump float;
        varying vec2 vUv;
        uniform sampler2D tColor;
        uniform sampler2D tVelocity;
        uniform float uStrength;
        uniform int uSampleCount;

        void main() {
          vec4 baseColor = texture2D(tColor, vUv);
          vec2 velocity = texture2D(tVelocity, vUv).rg * uStrength;

          vec3 blurred = baseColor.rgb;
          for (int i = 1; i < 8; i++) {
            float t = float(i) / float(uSampleCount);
            vec2 sampleUv = vUv + velocity * t;
            blurred += texture2D(tColor, sampleUv).rgb;
          }
          blurred /= float(uSampleCount);

          gl_FragColor = vec4(blurred, baseColor.a);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
  }

  update() {
    if (!this.enabled) return;

    this.previousViewMatrix.copy(this.camera.matrixWorldInverse);
  }

  apply(renderCallback) {
    if (!this.enabled) {
      renderCallback();
      return;
    }

    this.renderer.setRenderTarget(this.renderTarget);
    renderCallback();
    this.renderer.setRenderTarget(null);

    // Apply motion blur to the rendered scene
    // This is a placeholder; full implementation would composite the blur onto canvas
  }

  setStrength(strength) {
    this.strength = THREE.MathUtils.clamp(strength, 0, 1);
    this.blurMaterial.uniforms.uStrength.value = this.strength;
  }

  dispose() {
    this.renderTarget.dispose();
    this.velocityMaterial.dispose();
    this.blurMaterial.dispose();
  }
}

// Color grading and tone mapping improvements
export class ColorGradeController {
  constructor(scene, camera, renderer, opts = {}) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;

    // Color grading parameters
    this.exposure = opts.exposure ?? 1.0;
    this.saturation = opts.saturation ?? 1.0;
    this.contrast = opts.contrast ?? 1.0;
    this.shadowTint = opts.shadowTint ?? new THREE.Color(0xffffff);
    this.highlightTint = opts.highlightTint ?? new THREE.Color(0xffffff);

    this.gradingMaterial = this._createGradingMaterial();
  }

  _createGradingMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        uExposure: { value: this.exposure },
        uSaturation: { value: this.saturation },
        uContrast: { value: this.contrast },
        uShadowTint: { value: this.shadowTint },
        uHighlightTint: { value: this.highlightTint },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision mediump float;
        varying vec2 vUv;
        uniform sampler2D tScene;
        uniform float uExposure;
        uniform float uSaturation;
        uniform float uContrast;
        uniform vec3 uShadowTint;
        uniform vec3 uHighlightTint;

        vec3 rgb2hsv(vec3 c) {
          vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
          vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
          vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
          float d = q.x - min(q.w, q.y);
          float e = 1.0e-10;
          return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
        }

        vec3 hsv2rgb(vec3 c) {
          vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
          vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
          return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
        }

        void main() {
          vec4 color = texture2D(tScene, vUv);

          color.rgb *= uExposure;

          vec3 hsv = rgb2hsv(color.rgb);
          hsv.y *= uSaturation;
          color.rgb = hsv2rgb(hsv);

          color.rgb = mix(vec3(0.5), color.rgb, uContrast);

          float luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
          color.rgb = mix(color.rgb, color.rgb * uShadowTint, 1.0 - luminance);
          color.rgb = mix(color.rgb, color.rgb * uHighlightTint, luminance);

          gl_FragColor = color;
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
  }

  setExposure(value) {
    this.exposure = value;
    this.gradingMaterial.uniforms.uExposure.value = value;
  }

  setSaturation(value) {
    this.saturation = value;
    this.gradingMaterial.uniforms.uSaturation.value = value;
  }

  setContrast(value) {
    this.contrast = value;
    this.gradingMaterial.uniforms.uContrast.value = value;
  }

  setShadowTint(color) {
    this.shadowTint.copy(color);
    this.gradingMaterial.uniforms.uShadowTint.value.copy(color);
  }

  setHighlightTint(color) {
    this.highlightTint.copy(color);
    this.gradingMaterial.uniforms.uHighlightTint.value.copy(color);
  }

  dispose() {
    this.gradingMaterial.dispose();
  }
}

// Configure visual quality tier (integrates all visual polish components)
export class VisualQualityTier {
  static LOW = 'LOW';
  static MEDIUM = 'MEDIUM';
  static HIGH = 'HIGH';
  static ULTRA = 'ULTRA';

  static getConfig(tier) {
    const configs = {
      LOW: {
        ssao: SSAOPresets.LOW,
        bloom: BloomPresets.LOW,
        motionBlur: { enabled: false },
        shadowQuality: 'LOW',
        exposure: 1.0,
        saturation: 0.95,
        contrast: 0.95,
      },
      MEDIUM: {
        ssao: SSAOPresets.MEDIUM,
        bloom: BloomPresets.MEDIUM,
        motionBlur: { enabled: false },
        shadowQuality: 'MEDIUM',
        exposure: 1.0,
        saturation: 1.0,
        contrast: 1.0,
      },
      HIGH: {
        ssao: SSAOPresets.HIGH,
        bloom: BloomPresets.HIGH,
        motionBlur: { enabled: false, strength: 0.3 },
        shadowQuality: 'HIGH',
        exposure: 1.05,
        saturation: 1.05,
        contrast: 1.05,
      },
      ULTRA: {
        ssao: SSAOPresets.HIGH,
        bloom: BloomPresets.ULTRA,
        motionBlur: { enabled: true, strength: 0.4 },
        shadowQuality: 'ULTRA',
        exposure: 1.1,
        saturation: 1.1,
        contrast: 1.1,
      },
    };

    return configs[tier] || configs.MEDIUM;
  }

  static apply(scene, camera, renderer, tier) {
    const config = this.getConfig(tier);
    return config;
  }
}

export default {
  SSAOPresets,
  BloomPresets,
  MotionBlur,
  ColorGradeController,
  VisualQualityTier,
};
