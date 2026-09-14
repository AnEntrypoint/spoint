import * as THREE from 'three';

export const DecalType = {
  BULLET_HOLE: 'bulletHole',
  BLOOD_SPLATTER: 'bloodSplatter',
  BURN_MARK: 'burnMark',
  FOOTPRINT: 'footprint',
  EXPLOSION: 'explosion',
};

const DecalTypeConfigs = {
  [DecalType.BULLET_HOLE]: {
    atlasIndex: 0,
    lifetime: 30,
    blendMode: THREE.NormalBlending,
    sizeRange: [0.1, 0.15],
    depthOffset: 0.01,
  },
  [DecalType.BLOOD_SPLATTER]: {
    atlasIndex: 1,
    lifetime: 60,
    blendMode: THREE.NormalBlending,
    sizeRange: [0.2, 0.4],
    depthOffset: 0.008,
  },
  [DecalType.BURN_MARK]: {
    atlasIndex: 2,
    lifetime: 90,
    blendMode: THREE.MultiplyBlending,
    sizeRange: [0.15, 0.3],
    depthOffset: 0.005,
  },
  [DecalType.FOOTPRINT]: {
    atlasIndex: 3,
    lifetime: 45,
    blendMode: THREE.NormalBlending,
    sizeRange: [0.25, 0.35],
    depthOffset: 0.003,
  },
  [DecalType.EXPLOSION]: {
    atlasIndex: 4,
    lifetime: 15,
    blendMode: THREE.AdditiveBlending,
    sizeRange: [0.5, 1.0],
    depthOffset: 0.02,
  },
};

export class Decal {
  constructor(position, normal, type, age = 0) {
    this.position = position.clone();
    this.normal = normal.clone().normalize();
    this.type = type;
    this.age = age;
    this.active = true;

    const config = DecalTypeConfigs[type];
    this.lifetime = config.lifetime;
    this.blendMode = config.blendMode;
    this.size = THREE.MathUtils.lerp(config.sizeRange[0], config.sizeRange[1], Math.random());
    this.atlasIndex = config.atlasIndex;
    this.depthOffset = config.depthOffset;

    this.tangent = new THREE.Vector3();
    this.bitangent = new THREE.Vector3();
    this._computeTangentBasis();
  }

  _computeTangentBasis() {
    const upVec = Math.abs(this.normal.y) < 0.9 ?
      new THREE.Vector3(0, 1, 0) :
      new THREE.Vector3(1, 0, 0);

    this.tangent.crossVectors(upVec, this.normal).normalize();
    this.bitangent.crossVectors(this.normal, this.tangent).normalize();
  }

  getTransformMatrix() {
    const matrix = new THREE.Matrix4();
    const position = this.position;
    const scale = this.size;

    matrix.elements[0] = this.tangent.x * scale;
    matrix.elements[1] = this.tangent.y * scale;
    matrix.elements[2] = this.tangent.z * scale;

    matrix.elements[4] = this.bitangent.x * scale;
    matrix.elements[5] = this.bitangent.y * scale;
    matrix.elements[6] = this.bitangent.z * scale;

    matrix.elements[8] = this.normal.x * scale;
    matrix.elements[9] = this.normal.y * scale;
    matrix.elements[10] = this.normal.z * scale;

    matrix.elements[12] = position.x;
    matrix.elements[13] = position.y;
    matrix.elements[14] = position.z;

    return matrix;
  }

  update(dt) {
    this.age += dt;
    this.active = this.age < this.lifetime;
  }

  getAlpha() {
    const fadeStart = this.lifetime * 0.75;
    if (this.age < fadeStart) return 1.0;
    return 1.0 - ((this.age - fadeStart) / (this.lifetime - fadeStart));
  }
}

export class DecalRenderer {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.enabled = opts.enabled ?? true;

    this.decals = [];
    this.maxDecals = opts.maxDecals ?? 500;

    this.atlasTexture = opts.atlasTexture;
    this.atlasGridSize = opts.atlasGridSize ?? 4;

    this.instancedMaterial = this._createInstancedMaterial();
    this.instancedMesh = null;
    this._updateInstancedMesh();

    this.raycaster = new THREE.Raycaster();
    this.raycasterPlanes = opts.raycasterPlanes ?? [];

    this.updateTime = 0;
  }

  _createInstancedMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uAtlasTexture: { value: this.atlasTexture },
        uAtlasGridSize: { value: this.atlasGridSize },
        uTime: { value: 0 },
      },
      vertexShader: `
        #define MAX_DECALS 500

        uniform sampler2D uAtlasTexture;
        uniform float uAtlasGridSize;

        // Per-instance attributes
        attribute vec3 aPosition;
        attribute vec4 aQuatRotation;
        attribute float aSize;
        attribute float aAtlasIdx;
        attribute float aAlpha;

        varying vec2 vUv;
        varying float vAlpha;
        varying vec3 vNormal;

        vec3 rotateByQuat(vec3 v, vec4 q) {
          return v + 2.0 * cross(cross(v, q.xyz) + q.w * v, q.xyz);
        }

        void main() {
          // Decode atlas index to UV offset
          float gridIdx = floor(aAtlasIdx);
          float gridX = mod(gridIdx, uAtlasGridSize);
          float gridY = floor(gridIdx / uAtlasGridSize);
          vec2 atlasUvOffset = vec2(gridX, gridY) / uAtlasGridSize;

          // UV for this vertex (quad corner)
          vUv = (uv / uAtlasGridSize) + atlasUvOffset;

          // Position: local quad -> world via decal transform
          vec3 posWorld = aPosition + (position * aSize);
          posWorld = rotateByQuat(posWorld - aPosition, aQuatRotation) + aPosition;

          gl_Position = projectionMatrix * modelViewMatrix * vec4(posWorld, 1.0);

          vAlpha = aAlpha;
          vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        }
      `,
      fragmentShader: `
        precision mediump float;

        uniform sampler2D uAtlasTexture;

        varying vec2 vUv;
        varying float vAlpha;
        varying vec3 vNormal;

        void main() {
          vec4 texColor = texture2D(uAtlasTexture, vUv);

          // Discard fully transparent texels (helps with alpha-to-coverage on edges)
          if (texColor.a < 0.1) discard;

          // Apply instance alpha (fade out effect)
          texColor.a *= vAlpha;

          gl_FragColor = texColor;
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
  }

  _updateInstancedMesh() {
    if (this.instancedMesh) {
      this.scene.remove(this.instancedMesh);
      this.instancedMesh.geometry.dispose();
    }

    const quadGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array([
      -0.5, 0, -0.5,
      0.5, 0, -0.5,
      0.5, 0, 0.5,
      -0.5, 0, 0.5,
    ]);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    const uvs = new Float32Array([
      0, 0,
      1, 0,
      1, 1,
      0, 1,
    ]);

    quadGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    quadGeometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    quadGeometry.setIndex(new THREE.BufferAttribute(indices, 1));

    const instancedPositions = new Float32Array(this.maxDecals * 3);
    const instancedQuats = new Float32Array(this.maxDecals * 4);
    const instancedSizes = new Float32Array(this.maxDecals);
    const instancedAtlasIndices = new Float32Array(this.maxDecals);
    const instancedAlphas = new Float32Array(this.maxDecals);

    quadGeometry.setAttribute('aPosition', new THREE.InstancedBufferAttribute(instancedPositions, 3));
    quadGeometry.setAttribute('aQuatRotation', new THREE.InstancedBufferAttribute(instancedQuats, 4));
    quadGeometry.setAttribute('aSize', new THREE.InstancedBufferAttribute(instancedSizes, 1));
    quadGeometry.setAttribute('aAtlasIdx', new THREE.InstancedBufferAttribute(instancedAtlasIndices, 1));
    quadGeometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(instancedAlphas, 1));

    this.instancedMesh = new THREE.InstancedMesh(quadGeometry, this.instancedMaterial, this.maxDecals);
    this.scene.add(this.instancedMesh);
  }

  placeDecal(position, direction, type = DecalType.BULLET_HOLE, targets = null) {
    if (!this.enabled || this.decals.length >= this.maxDecals) return null;

    this.raycaster.set(position, direction.normalize());
    const targetList = targets ?? this.raycasterPlanes;
    const intersects = this.raycaster.intersectObjects(targetList, true);

    if (intersects.length === 0) return null;

    const hit = intersects[0];
    const decal = new Decal(hit.point, hit.face.normal, type);

    this.decals.push(decal);
    return decal;
  }

  placeDecalDirect(position, normal, type = DecalType.BULLET_HOLE) {
    if (!this.enabled || this.decals.length >= this.maxDecals) return null;

    const decal = new Decal(position, normal, type);
    this.decals.push(decal);
    return decal;
  }

  update(dt) {
    const startTime = performance.now();

    if (!this.enabled) {
      this.updateTime = performance.now() - startTime;
      return;
    }

    for (let i = this.decals.length - 1; i >= 0; i--) {
      this.decals[i].update(dt);
      if (!this.decals[i].active) {
        this.decals.splice(i, 1);
      }
    }

    if (this.instancedMesh) {
      const positions = this.instancedMesh.geometry.attributes.aPosition.array;
      const quats = this.instancedMesh.geometry.attributes.aQuatRotation.array;
      const sizes = this.instancedMesh.geometry.attributes.aSize.array;
      const atlasIndices = this.instancedMesh.geometry.attributes.aAtlasIdx.array;
      const alphas = this.instancedMesh.geometry.attributes.aAlpha.array;

      for (let i = 0; i < this.decals.length; i++) {
        const decal = this.decals[i];
        positions[i * 3] = decal.position.x;
        positions[i * 3 + 1] = decal.position.y;
        positions[i * 3 + 2] = decal.position.z;

        quats[i * 4] = 0;
        quats[i * 4 + 1] = 0;
        quats[i * 4 + 2] = 0;
        quats[i * 4 + 3] = 1;

        sizes[i] = decal.size;
        atlasIndices[i] = decal.atlasIndex;
        alphas[i] = decal.getAlpha();
      }

      this.instancedMesh.geometry.attributes.aPosition.needsUpdate = true;
      this.instancedMesh.geometry.attributes.aSize.needsUpdate = true;
      this.instancedMesh.geometry.attributes.aAtlasIdx.needsUpdate = true;
      this.instancedMesh.geometry.attributes.aAlpha.needsUpdate = true;

      this.instancedMesh.count = this.decals.length;
    }

    this.updateTime = performance.now() - startTime;
  }

  setRaycasterTargets(objects) {
    this.raycasterPlanes = objects;
  }

  clear() {
    this.decals.length = 0;
    if (this.instancedMesh) {
      this.instancedMesh.count = 0;
    }
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (this.instancedMesh) {
      this.instancedMesh.visible = enabled;
    }
  }

  dispose() {
    this.decals.length = 0;
    if (this.instancedMesh) {
      this.scene.remove(this.instancedMesh);
      this.instancedMesh.geometry.dispose();
      this.instancedMesh.material.dispose();
    }
    this.instancedMaterial.dispose();
  }
}

export async function createDecalRendererWithAtlas(scene, atlasImagePath, opts = {}) {
  const textureLoader = new THREE.TextureLoader();
  const atlasTexture = await new Promise((resolve, reject) => {
    textureLoader.load(atlasImagePath, resolve, undefined, reject);
  });

  return new DecalRenderer(scene, {
    ...opts,
    atlasTexture,
    atlasGridSize: opts.atlasGridSize ?? 4,
  });
}
