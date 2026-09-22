import * as THREE from 'three';
import { CachedFrustumPlanes } from './frustum-cache.js';
import { createInstancedSlotCullTSL, applyInstancedSlotCullPositionNode, resizeInstancedSlotCull, syncInstancedSlotCullBounds } from './instanced-slot-cull-tsl.js';

const _zeroMatrix = new THREE.Matrix4().set(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0);
const INITIAL_SLOT_CAPACITY = 32;
const TEXELS_PER_INSTANCE = 4;
const FLOATS_PER_TEXEL = 4;

class Emitter {
  constructor() { this._listeners = new Map(); }
  on(ev, fn) {
    let s = this._listeners.get(ev);
    if (!s) { s = new Set(); this._listeners.set(ev, s); }
    s.add(fn);
    return () => s.delete(fn);
  }
  emit(ev, payload) {
    const s = this._listeners.get(ev);
    if (!s) return;
    for (const fn of s) {
      try { fn(payload); } catch (e) { console.error(`[ModelPool] listener for ${ev} threw`, e); }
    }
  }
}

class InstancedSlot {
  constructor(pool, asset, meshDescIdx, lodIdx, geo, material) {
    this.pool = pool;
    this.asset = asset;
    this.meshDescIdx = meshDescIdx;
    this.lodIdx = lodIdx;
    this.geometry = geo;
    this.material = material;
    this.capacity = INITIAL_SLOT_CAPACITY;
    this._uniforms = { projViewMatrix: { value: new THREE.Matrix4() } };
    if (!pool._frustumCache) pool._frustumCache = new CachedFrustumPlanes();
    this._uniforms.frustumPlanes = { value: pool._frustumCache.getPlaneUniforms() };
    this._webgpuCull = null;
    if (material.isNodeMaterial) {
      this._gpuInstanceTex = false;
      material = material.clone();
      this._webgpuCull = createInstancedSlotCullTSL(this.capacity, pool._frustumCache.getPlaneUniforms());
      applyInstancedSlotCullPositionNode(material, this._webgpuCull);
    } else {
      this._gpuInstanceTex = pool._enableGpuInstanceTex !== false;
      if (this._gpuInstanceTex) {
        material = material.clone();
        this._initInstanceTexture(this.capacity);
      }
      _patchInstancedSlotMaterial(material, this._uniforms);
    }
    this.material = material;
    this.mesh = new THREE.InstancedMesh(geo, material, this.capacity);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._boundArray = new Float32Array(this.capacity);
    this._boundAttr = new THREE.InstancedBufferAttribute(this._boundArray, 1);
    this._boundAttr.setUsage(THREE.DynamicDrawUsage);
    this.mesh.geometry.setAttribute('instanceBoundSphere', this._boundAttr);
    this._boundDirtyRuns = [];
    const zero = new THREE.Matrix4().set(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0);
    for (let i = 0; i < this.capacity; i++) this.mesh.setMatrixAt(i, zero);
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.slots = new Map();
    this.freeSlots = [];
    this.nextSlot = 0;
    this._dirtySlots = new Set();
  }

  acquireSlot(entity) {
    let idx;
    if (this.freeSlots.length) idx = this.freeSlots.pop();
    else {
      if (this.nextSlot >= this.capacity) this._grow(this.capacity * 2);
      idx = this.nextSlot++;
    }
    this.slots.set(entity, idx);
    if (idx + 1 > this.mesh.count) this.mesh.count = idx + 1;
    return idx;
  }
  releaseSlot(entity) {
    const idx = this.slots.get(entity);
    if (idx == null) return;
    this.slots.delete(entity);
    this.freeSlots.push(idx);
    const zero = _zeroMatrix;
    if (this._gpuInstanceTex) {
      this.setInstanceTransform(idx, zero);
    } else {
      this.mesh.setMatrixAt(idx, zero);
      this._dirtySlots.add(idx);
    }
    this._boundArray[idx] = 0;
    this._markBoundDirty(idx);
  }
  setMatrixForSlot(idx, matrix) {
    if (this._gpuInstanceTex) {
      this.setInstanceTransform(idx, matrix);
      return;
    }
    this.mesh.setMatrixAt(idx, matrix);
    this._dirtySlots.add(idx);
  }
  flushMatrixUpdates() {
    this._flushBoundAttr();
    if (this._gpuInstanceTex) { this.flushInstanceTexture(); return; }
    if (this._webgpuCull) {
      syncInstancedSlotCullBounds(this._webgpuCull, this.mesh.instanceMatrix.array, this._boundArray);
    }
    if (this._dirtySlots.size > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this._dirtySlots.clear();
    }
  }
  setBoundSphereForSlot(idx, r) {
    this._boundArray[idx] = r;
    this._markBoundDirty(idx);
  }
  _markBoundDirty(idx) {
    const loComp = idx, hiComp = idx;
    const runs = this._boundDirtyRuns;
    let i = 0;
    while (i < runs.length && runs[i][1] < loComp - 1) i++;
    let mergedLo = loComp, mergedHi = hiComp;
    let j = i;
    while (j < runs.length && runs[j][0] <= hiComp + 1) {
      if (runs[j][0] < mergedLo) mergedLo = runs[j][0];
      if (runs[j][1] > mergedHi) mergedHi = runs[j][1];
      j++;
    }
    if (j > i) {
      const tuple = runs[i];
      tuple[0] = mergedLo; tuple[1] = mergedHi;
      if (j - i > 1) runs.splice(i + 1, j - i - 1);
    } else {
      runs.splice(i, 0, [mergedLo, mergedHi]);
    }
  }
  _flushBoundAttr() {
    const runs = this._boundDirtyRuns;
    if (runs.length > 0) {
      if (typeof this._boundAttr.addUpdateRange === 'function') {
        this._boundAttr.clearUpdateRanges();
        for (const [lo, hi] of runs) this._boundAttr.addUpdateRange(lo, hi - lo + 1);
      }
      this._boundAttr.needsUpdate = true;
      runs.length = 0;
    }
  }
  _initInstanceTexture(capacity) {
    const texelsPerInstance = 4;
    this._instTexWidth = capacity * texelsPerInstance;
    this._instTexData = new Float32Array(this._instTexWidth * 4);
    const tex = new THREE.DataTexture(this._instTexData, this._instTexWidth, 1, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this._instTex = tex;
    if (this._uniforms.instanceTex) {
      this._uniforms.instanceTex.value = tex;
      this._uniforms.instanceTexWidth.value = this._instTexWidth;
    } else {
      this._uniforms.instanceTex = { value: tex };
      this._uniforms.instanceTexWidth = { value: this._instTexWidth };
    }
    this._instTexDirtyRuns = [];
  }
  setInstanceTransform(idx, matrix) {
    const colMajor = matrix.elements;
    const base = idx * TEXELS_PER_INSTANCE * FLOATS_PER_TEXEL;
    for (let c = 0; c < 4; c++) {
      const o = base + c * 4;
      const m = c * 4;
      this._instTexData[o] = colMajor[m];
      this._instTexData[o + 1] = colMajor[m + 1];
      this._instTexData[o + 2] = colMajor[m + 2];
      this._instTexData[o + 3] = colMajor[m + 3];
    }
    this._markInstanceTexDirty(idx * 4, idx * 4 + 3);
  }
  _markInstanceTexDirty(loCol, hiCol) {
    const runs = this._instTexDirtyRuns;
    let i = 0;
    while (i < runs.length && runs[i][1] < loCol - 1) i++;
    let mergedLo = loCol, mergedHi = hiCol;
    let j = i;
    while (j < runs.length && runs[j][0] <= hiCol + 1) {
      if (runs[j][0] < mergedLo) mergedLo = runs[j][0];
      if (runs[j][1] > mergedHi) mergedHi = runs[j][1];
      j++;
    }
    if (j > i) {
      const tuple = runs[i];
      tuple[0] = mergedLo; tuple[1] = mergedHi;
      if (j - i > 1) runs.splice(i + 1, j - i - 1);
    } else {
      runs.splice(i, 0, [mergedLo, mergedHi]);
    }
  }
  flushInstanceTexture() {
    const runs = this._instTexDirtyRuns;
    if (runs.length > 0) {
      if (typeof this._instTex.addUpdateRange === 'function') {
        this._instTex.clearUpdateRanges();
        for (const [lo, hi] of runs) this._instTex.addUpdateRange(lo * 4, (hi - lo + 1) * 4);
      }
      this._instTex.needsUpdate = true;
      runs.length = 0;
    }
  }
  _grow(newCap) {
    const old = this.mesh;
    const next = new THREE.InstancedMesh(this.geometry, this.material, newCap);
    next.frustumCulled = false;
    next.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (this._gpuInstanceTex) {
      const oldData = this._instTexData;
      this._initInstanceTexture(newCap);
      this._instTexData.set(oldData);
      this._instTex.needsUpdate = true;
      this._uniforms.instanceTex.value = this._instTex;
      this._uniforms.instanceTexWidth.value = this._instTexWidth;
    } else {
      const m = new THREE.Matrix4();
      for (let i = 0; i < this.nextSlot; i++) {
        old.getMatrixAt(i, m);
        next.setMatrixAt(i, m);
      }
      next.instanceMatrix.needsUpdate = true;
    }
    next.count = old.count;
    const newBounds = new Float32Array(newCap);
    newBounds.set(this._boundArray);
    this._boundArray = newBounds;
    this._boundAttr = new THREE.InstancedBufferAttribute(newBounds, 1);
    this._boundAttr.setUsage(THREE.DynamicDrawUsage);
    next.geometry.setAttribute('instanceBoundSphere', this._boundAttr);
    this._boundDirtyRuns = [];
    const parent = old.parent;
    if (parent) {
      parent.remove(old);
      parent.add(next);
    }
    old.dispose();
    this.mesh = next;
    this.capacity = newCap;
    this._dirtySlots = new Set();
    if (this._webgpuCull) {
      resizeInstancedSlotCull(this.material, this._webgpuCull, newCap, this.pool._frustumCache.getPlaneUniforms());
      syncInstancedSlotCullBounds(this._webgpuCull, this.mesh.instanceMatrix.array, this._boundArray);
    }
  }
}

function _patchInstancedSlotMaterial(material, uniforms) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader) => {
    if (prev) prev(shader);
    shader.uniforms.projViewMatrix = uniforms.projViewMatrix;
    shader.uniforms.frustumPlanes = uniforms.frustumPlanes;
    if (uniforms.instanceTex) {
      shader.uniforms.instanceTex = uniforms.instanceTex;
      shader.uniforms.instanceTexWidth = uniforms.instanceTexWidth;
      shader.defines = shader.defines || {};
      shader.defines.USE_GPU_INSTANCE_TEX = '';
    }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float instanceBoundSphere;
uniform mat4 projViewMatrix;
uniform vec4 frustumPlanes[6];
#ifdef USE_GPU_INSTANCE_TEX
uniform sampler2D instanceTex;
uniform float instanceTexWidth;
mat4 readInstanceMatrix(int id) {
  float base = float(id) * 4.0;
  vec4 c0 = texture2D(instanceTex, vec2((base + 0.5) / instanceTexWidth, 0.5));
  vec4 c1 = texture2D(instanceTex, vec2((base + 1.5) / instanceTexWidth, 0.5));
  vec4 c2 = texture2D(instanceTex, vec2((base + 2.5) / instanceTexWidth, 0.5));
  vec4 c3 = texture2D(instanceTex, vec2((base + 3.5) / instanceTexWidth, 0.5));
  return mat4(c0, c1, c2, c3);
}
#endif`
      )
      .replace(
        '#include <project_vertex>',
        `#ifdef USE_GPU_INSTANCE_TEX
  mat4 instMat = readInstanceMatrix(gl_InstanceID);
  vec4 mvPosition = modelViewMatrix * instMat * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vec3 instCenter = instMat[3].xyz;
#else
  #include <project_vertex>
  vec3 instCenter = instanceMatrix[3].xyz;
#endif
{
  if (instanceBoundSphere > 0.0) {
    vec3 c = instCenter;
    float r = instanceBoundSphere;
    bool outside = false;
    for (int i = 0; i < 6; i++) {
      vec4 p = frustumPlanes[i];
      if (dot(p.xyz, c) + p.w < -r) { outside = true; break; }
    }
    if (outside) {
      gl_Position = vec4(0.0/0.0, 0.0/0.0, 0.0/0.0, 0.0/0.0) * 0.0;
      return;
    }
  }
}`
      );
  };
  material.needsUpdate = true;
}

export { Emitter, InstancedSlot, _patchInstancedSlotMaterial, _zeroMatrix };
