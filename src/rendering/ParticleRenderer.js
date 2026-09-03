import * as THREE from 'three';

export const BlendMode = {
  NORMAL: 'normal',
  ADDITIVE: 'additive',
  MULTIPLY: 'multiply'
};

export class ParticleRenderer {
  constructor(scene, camera, config = {}) {
    this.scene = scene;
    this.camera = camera;
    this.blendMode = config.blendMode ?? BlendMode.ADDITIVE;
    this.textureAtlas = config.textureAtlas ?? null;
    this.maxParticles = config.maxParticles ?? 10000;

    this.geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(this.maxParticles * 3);
    this.sizes = new Float32Array(this.maxParticles);
    this.colors = new Uint8Array(this.maxParticles * 4);
    this.rotations = new Float32Array(this.maxParticles);
    this.uvs = new Float32Array(this.maxParticles * 2);

    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 4, true));
    this.geometry.setAttribute('rotation', new THREE.BufferAttribute(this.rotations, 1));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        texture: { value: null },
        textureAtlas: { value: this.textureAtlas },
        atlasGridSize: { value: new THREE.Vector2(4, 4) }
      },
      vertexShader: this.vertexShader,
      fragmentShader: this.fragmentShader,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true
    });

    if (this.blendMode === BlendMode.ADDITIVE) {
      this.material.blending = THREE.AdditiveBlending;
    } else if (this.blendMode === BlendMode.MULTIPLY) {
      this.material.blending = THREE.MultiplyBlending;
    }

    this.points = new THREE.Points(this.geometry, this.material);
    this.scene.add(this.points);

    this.particleCount = 0;
    this.lodDistance = config.lodDistance ?? 100;
    this.lodFactor = config.lodFactor ?? 0.5;
  }

  update(particles, camera) {
    let visibleCount = 0;
    const cameraPos = camera.position;

    for (let i = 0; i < particles.length; i++) {
      const particle = particles[i];

      if (!particle.active) continue;

      const dx = particle.position[0] - cameraPos.x;
      const dy = particle.position[1] - cameraPos.y;
      const dz = particle.position[2] - cameraPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      let sizeMultiplier = 1;
      if (dist > this.lodDistance) {
        sizeMultiplier = Math.max(0.25, this.lodFactor);
      }

      const idx = visibleCount;
      if (idx >= this.maxParticles) break;

      this.positions[idx * 3] = particle.position[0];
      this.positions[idx * 3 + 1] = particle.position[1];
      this.positions[idx * 3 + 2] = particle.position[2];

      this.sizes[idx] = particle.size * sizeMultiplier * 100;

      this.colors[idx * 4] = particle.color[0];
      this.colors[idx * 4 + 1] = particle.color[1];
      this.colors[idx * 4 + 2] = particle.color[2];
      this.colors[idx * 4 + 3] = particle.color[3];

      this.rotations[idx] = particle.rotation;

      const t = Math.min(particle.age / Math.max(particle.lifetime, 0.01), 1);
      const atlasIdx = Math.floor(t * 16);
      const gridX = atlasIdx % 4;
      const gridY = Math.floor(atlasIdx / 4);

      this.uvs[idx * 2] = (gridX + 0.5) / 4;
      this.uvs[idx * 2 + 1] = (gridY + 0.5) / 4;

      visibleCount++;
    }

    this.particleCount = visibleCount;

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.size.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.geometry.attributes.rotation.needsUpdate = true;
    this.geometry.attributes.uv.needsUpdate = true;

    this.geometry.setDrawRange(0, visibleCount);
  }

  setTexture(texture) {
    this.material.uniforms.texture.value = texture;
  }

  setTextureAtlas(textureAtlas, gridSize = 4) {
    this.material.uniforms.textureAtlas.value = textureAtlas;
    this.material.uniforms.atlasGridSize.value.set(gridSize, gridSize);
  }

  setBlendMode(mode) {
    this.blendMode = mode;
    if (mode === BlendMode.ADDITIVE) {
      this.material.blending = THREE.AdditiveBlending;
    } else if (mode === BlendMode.MULTIPLY) {
      this.material.blending = THREE.MultiplyBlending;
    } else {
      this.material.blending = THREE.NormalBlending;
    }
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.scene.remove(this.points);
  }

  vertexShader = `
    attribute float size;
    attribute vec4 color;
    attribute float rotation;
    attribute vec2 uv;

    varying vec4 vColor;
    varying vec2 vUv;

    void main() {
      gl_PointSize = size;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      vColor = color / 255.0;
      vUv = uv;
    }
  `;

  fragmentShader = `
    uniform sampler2D texture;
    uniform sampler2D textureAtlas;
    uniform vec2 atlasGridSize;

    varying vec4 vColor;
    varying vec2 vUv;

    void main() {
      vec2 uv = gl_PointCoord;
      uv = uv * (1.0 / atlasGridSize) + vUv - (0.5 / atlasGridSize);

      vec4 texColor;
      if (textureAtlas != null) {
        texColor = texture2D(textureAtlas, uv);
      } else if (texture != null) {
        texColor = texture2D(texture, gl_PointCoord);
      } else {
        float dist = length(gl_PointCoord - 0.5) * 2.0;
        texColor = vec4(1.0, 1.0, 1.0, smoothstep(1.0, 0.0, dist));
      }

      gl_FragColor = texColor * vColor;
    }
  `;
}
