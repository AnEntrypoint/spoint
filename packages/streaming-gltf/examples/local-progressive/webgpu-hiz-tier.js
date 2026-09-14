import * as THREE from 'three';
import { Fn, If, instancedArray, instanceIndex, uint, textureLoad, ivec2, int, uniform, float } from 'three/tsl';

const _box = new THREE.Box3();
const _mat = new THREE.Matrix4();
const _v4 = new THREE.Vector4();

const MAX_CANDIDATES = 4096;

export class WebGpuHizTier {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.minCandidates = opts.minCandidates ?? 64;
    this.supported_ = !!(renderer && renderer.isWebGPURenderer && renderer.backend && renderer.backend.isWebGPUBackend);
    this._records = new Map();
    this._freeList = [];
    this._nextIndex = 0;
    this._capacity = MAX_CANDIDATES;
    this._depthTexture = null;
    this._kernelBuilt = false;
    this.stats = { queried: 0, occluded: 0, resolved: 0, supported: this.supported_ };
    if (this.supported_) this._initBuffers();
  }

  supported() {
    return this.supported_;
  }

  bindDepthTexture(depthTexture) {
    this._depthTexture = depthTexture;
    if (this.supported_ && !this._kernelBuilt) this._buildKernel();
  }

  _initBuffers() {
    this._aabbBuffer = instancedArray(this._capacity, 'vec4');
    this._visBuffer = instancedArray(this._capacity, 'uint');
    this._aabbCPU = new Float32Array(this._capacity * 4);
    this._visCPU = new Uint32Array(this._capacity).fill(1);
  }

  _buildKernel() {
    const depthTex = this._depthTexture;
    const texSize = uniform(new THREE.Vector2(1, 1));
    this._texSizeUniform = texSize;
    this._debugBuffer = instancedArray(this._capacity, 'float');
    this._debugCPU = new Float32Array(this._capacity);
    this._debugTexelBuffer = instancedArray(this._capacity, 'float');
    this._debugTexelCPU = new Float32Array(this._capacity);
    if (this.renderer.getDrawingBufferSize) {
      const sz = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      texSize.value.set(Math.max(1, sz.x), Math.max(1, sz.y));
    }
    this._testKernel = Fn(() => {
      const aabb = this._aabbBuffer.element(instanceIndex);
      const degenerate = aabb.x.greaterThanEqual(aabb.z);
      If(degenerate, () => {
        this._visBuffer.element(instanceIndex).assign(uint(1));
      }).Else(() => {
        const toTexel = (ndcX, ndcY) => {
          const u = ndcX.add(1).mul(0.5).mul(texSize.x);
          const v = float(1).sub(ndcY.add(1).mul(0.5)).mul(texSize.y);
          return ivec2(int(u), int(v));
        };
        const cx = aabb.x.add(aabb.z).mul(0.5);
        const cy = aabb.y.add(aabb.w).mul(0.5);
        const texel4 = toTexel(cx, cy);
        const d0 = textureLoad(depthTex, toTexel(aabb.x, aabb.y), 0).r;
        const d1 = textureLoad(depthTex, toTexel(aabb.z, aabb.y), 0).r;
        const d2 = textureLoad(depthTex, toTexel(aabb.x, aabb.w), 0).r;
        const d3 = textureLoad(depthTex, toTexel(aabb.z, aabb.w), 0).r;
        const d4 = textureLoad(depthTex, texel4, 0).r;
        const nearestSampledDepth = d0.min(d1).min(d2).min(d3).min(d4);
        this._debugBuffer.element(instanceIndex).assign(d4);
        this._debugTexelBuffer.element(instanceIndex).assign(float(texel4.x).add(float(texel4.y).mul(0.0001)));
        this._visBuffer.element(instanceIndex).assign(uint(1));
      });
    })().compute(this._capacity);
    this._kernelBuilt = true;
  }

  runQueries(camera, candidates) {
    if (!this.supported_ || !candidates.length) return;
    if (!this._depthTexture) return;
    if (!this._candDepthBuffer) this._candDepthBuffer = instancedArray(this._capacity, 'float');
    if (!this._candDepthCPU) this._candDepthCPU = new Float32Array(this._capacity);
    let queried = 0;
    for (const entity of candidates) {
      let idx = this._records.get(entity);
      if (idx == null) {
        idx = this._freeList.length ? this._freeList.pop() : this._nextIndex++;
        if (idx >= this._capacity) continue;
        this._records.set(entity, idx);
      }
      _box.setFromObject(entity.root);
      if (_box.isEmpty()) { this._aabbCPU[idx * 4] = 1; this._aabbCPU[idx * 4 + 2] = 0; continue; }
      this._writeScreenAABB(idx, _box, camera);
      queried++;
    }
    this._aabbBuffer.value.set(this._aabbCPU);
    this._candDepthBuffer.value.set(this._candDepthCPU);
    this.renderer.compute(this._testKernel, [Math.ceil(this._capacity / 64)]);
    this.renderer.getArrayBufferAsync(this._visBuffer.value).then((buf) => {
      this._visCPU.set(new Uint32Array(buf));
      let occluded = 0;
      for (const idx of this._records.values()) if (this._visCPU[idx] === 0) occluded++;
      this.stats.resolved = this._records.size;
      this.stats.occluded = occluded;
    }).catch(() => { });
    if (this._debugBuffer) {
      this.renderer.getArrayBufferAsync(this._debugBuffer.value).then((buf) => {
        this._debugCPU.set(new Float32Array(buf));
      }).catch(() => {});
    }
    if (this._debugTexelBuffer) {
      this.renderer.getArrayBufferAsync(this._debugTexelBuffer.value).then((buf) => {
        this._debugTexelCPU.set(new Float32Array(buf));
      }).catch(() => {});
    }
    this.stats.queried = queried;
  }

  _writeScreenAABB(idx, box, camera) {
    _mat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const corners = [
      [box.min.x, box.min.y, box.min.z], [box.max.x, box.min.y, box.min.z],
      [box.min.x, box.max.y, box.min.z], [box.max.x, box.max.y, box.min.z],
      [box.min.x, box.min.y, box.max.z], [box.max.x, box.min.y, box.max.z],
      [box.min.x, box.max.y, box.max.z], [box.max.x, box.max.y, box.max.z],
    ];
    let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity, mnNdcZ = Infinity;
    let behindCamera = false;
    for (const [x, y, z] of corners) {
      _v4.set(x, y, z, 1).applyMatrix4(_mat);
      if (_v4.w <= 1e-6) { behindCamera = true; break; }
      const nx = _v4.x / _v4.w, ny = _v4.y / _v4.w, nz = _v4.z / _v4.w;
      if (nx < mnX) mnX = nx; if (nx > mxX) mxX = nx;
      if (ny < mnY) mnY = ny; if (ny > mxY) mxY = ny;
      if (nz < mnNdcZ) mnNdcZ = nz;
    }
    if (behindCamera) { mnX = -1; mnY = -1; mxX = 1; mxY = 1; mnNdcZ = 0; }
    this._aabbCPU[idx * 4] = mnX; this._aabbCPU[idx * 4 + 1] = mnY;
    this._aabbCPU[idx * 4 + 2] = mxX; this._aabbCPU[idx * 4 + 3] = mxY;
    this._candDepthCPU[idx] = (mnNdcZ + 1) * 0.5;
  }

  isOccluded(entity) {
    const idx = this._records.get(entity);
    if (idx == null) return false;
    return this._visCPU[idx] === 0;
  }

  release(entity) {
    const idx = this._records.get(entity);
    if (idx == null) return;
    this._records.delete(entity);
    this._freeList.push(idx);
  }

  dispose() {
    this._records.clear();
    this._freeList.length = 0;
  }
}
