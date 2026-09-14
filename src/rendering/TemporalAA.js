import * as THREE from 'three';

export const QualityPresets = {
  LOW: { tapCount: 2, blendMin: 0.15, blendMax: 0.6, velocityClamp: 50 },
  MEDIUM: { tapCount: 4, blendMin: 0.1, blendMax: 0.5, velocityClamp: 30 },
  HIGH: { tapCount: 8, blendMin: 0.05, blendMax: 0.4, velocityClamp: 20 },
};

export class TemporalAA {
  constructor(renderer, scene, camera, opts = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = opts.enabled ?? true;
    this.quality = opts.quality ?? 'MEDIUM';
    this.preset = QualityPresets[this.quality] || QualityPresets.MEDIUM;

    this.frameIndex = 0;
    this.haltonSequence = this._generateHaltonSequence(this.preset.tapCount);
    this.currentJitter = new THREE.Vector2();
    this.previousJitter = new THREE.Vector2();
    this.renderTargets = {
      current: new THREE.WebGLRenderTarget(
        renderer.domElement.width,
        renderer.domElement.height,
        {
          format: THREE.RGBAFormat,
          type: THREE.FloatType,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
        }
      ),
      history: new THREE.WebGLRenderTarget(
        renderer.domElement.width,
        renderer.domElement.height,
        {
          format: THREE.RGBAFormat,
          type: THREE.FloatType,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
        }
      ),
      motion: new THREE.WebGLRenderTarget(
        renderer.domElement.width,
        renderer.domElement.height,
        {
          format: THREE.RGFormat,
          type: THREE.FloatType,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
        }
      ),
    };

    this.originalProjectionMatrix = camera.projectionMatrix.clone();
    this.reprojectionMaterial = this._createReprojectionMaterial();
    this.compositeScene = new THREE.Scene();
    this.compositeQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.reprojectionMaterial
    );
    this.compositeScene.add(this.compositeQuad);
  }

  _generateHaltonSequence(tapCount) {
    const sequence = [];
    for (let i = 0; i < tapCount; i++) {
      const u = this._halton(i + 1, 2);
      const v = this._halton(i + 1, 3);
      sequence.push([u - 0.5, v - 0.5]);
    }
    return sequence;
  }

  _halton(n, base) {
    let result = 0;
    let f = 1 / base;
    let i = n;
    while (i > 0) {
      result += f * (i % base);
      i = Math.floor(i / base);
      f /= base;
    }
    return result;
  }

  _createReprojectionMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        tCurrent: { value: null },
        tHistory: { value: null },
        tMotion: { value: null },
        uResolution: { value: new THREE.Vector2() },
        uBlendMin: { value: this.preset.blendMin },
        uBlendMax: { value: this.preset.blendMax },
        uVelocityClamp: { value: this.preset.velocityClamp },
        uJitterDelta: { value: new THREE.Vector2() },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tCurrent;
        uniform sampler2D tHistory;
        uniform sampler2D tMotion;
        uniform vec2 uResolution;
        uniform float uBlendMin;
        uniform float uBlendMax;
        uniform float uVelocityClamp;
        uniform vec2 uJitterDelta;

        vec4 sampleNeighborhood(sampler2D tex, vec2 uv, vec2 offset) {
          return texture2D(tex, uv + offset / uResolution);
        }

        void main() {
          vec4 current = texture2D(tCurrent, vUv);
          vec2 motion = texture2D(tMotion, vUv).rg;

          float motionLen = length(motion);
          if (motionLen > uVelocityClamp) {
            motion = normalize(motion) * uVelocityClamp;
          }

          vec2 reprojUv = vUv - motion / uResolution;
          vec4 history = texture2D(tHistory, clamp(reprojUv, vec2(0.0), vec2(1.0)));

          float blendFactor = mix(uBlendMin, uBlendMax, clamp(motionLen / uVelocityClamp, 0.0, 1.0));

          vec4 result = mix(history, current, blendFactor);

          vec3 neighborMin = current.rgb;
          vec3 neighborMax = current.rgb;
          for (int i = -1; i <= 1; i++) {
            for (int j = -1; j <= 1; j++) {
              if (i == 0 && j == 0) continue;
              vec3 neighbor = sampleNeighborhood(tCurrent, vUv, vec2(float(i), float(j))).rgb;
              neighborMin = min(neighborMin, neighbor);
              neighborMax = max(neighborMax, neighbor);
            }
          }
          result.rgb = clamp(result.rgb, neighborMin, neighborMax);

          gl_FragColor = result;
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
  }

  updateCamera() {
    if (!this.enabled) {
      this.camera.projectionMatrix.copy(this.originalProjectionMatrix);
      return;
    }

    this.previousJitter.copy(this.currentJitter);
    const jitterIndex = this.frameIndex % this.haltonSequence.length;
    const [jx, jy] = this.haltonSequence[jitterIndex];

    const pixelWidth = 1 / this.camera.projectionMatrix.elements[0];
    const pixelHeight = 1 / this.camera.projectionMatrix.elements[5];

    this.currentJitter.set(jx * pixelWidth, jy * pixelHeight);

    const jitteredProjection = this.originalProjectionMatrix.clone();
    jitteredProjection.elements[8] += this.currentJitter.x;
    jitteredProjection.elements[9] += this.currentJitter.y;

    this.camera.projectionMatrix.copy(jitteredProjection);
  }

  computeMotionVectors() {
  }

  render(renderCallback) {
    if (!this.enabled) {
      renderCallback();
      return;
    }

    this.updateCamera();

    this.renderer.setRenderTarget(this.renderTargets.current);
    renderCallback();

    this.computeMotionVectors();

    this.reprojectionMaterial.uniforms.tCurrent.value = this.renderTargets.current.texture;
    this.reprojectionMaterial.uniforms.tHistory.value = this.renderTargets.history.texture;
    this.reprojectionMaterial.uniforms.tMotion.value = this.renderTargets.motion.texture;
    this.reprojectionMaterial.uniforms.uResolution.value.set(
      this.renderTargets.current.width,
      this.renderTargets.current.height
    );
    this.reprojectionMaterial.uniforms.uJitterDelta.value
      .subVectors(this.currentJitter, this.previousJitter);

    this.renderer.setRenderTarget(null);
    this.renderer.render(this.compositeScene, this.camera);

    const temp = this.renderTargets.history;
    this.renderTargets.history = this.renderTargets.current;
    this.renderTargets.current = temp;

    this.frameIndex++;
  }

  setQuality(quality) {
    this.quality = quality;
    this.preset = QualityPresets[quality] || QualityPresets.MEDIUM;
    this.haltonSequence = this._generateHaltonSequence(this.preset.tapCount);
    this.frameIndex = 0;

    this.reprojectionMaterial.uniforms.uBlendMin.value = this.preset.blendMin;
    this.reprojectionMaterial.uniforms.uBlendMax.value = this.preset.blendMax;
    this.reprojectionMaterial.uniforms.uVelocityClamp.value = this.preset.velocityClamp;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      this.camera.projectionMatrix.copy(this.originalProjectionMatrix);
    }
  }

  onWindowResize(width, height) {
    this.renderTargets.current.setSize(width, height);
    this.renderTargets.history.setSize(width, height);
    this.renderTargets.motion.setSize(width, height);
  }

  dispose() {
    this.renderTargets.current.dispose();
    this.renderTargets.history.dispose();
    this.renderTargets.motion.dispose();
    this.reprojectionMaterial.dispose();
    this.compositeQuad.geometry.dispose();
  }
}
