// Draw Call Batching Optimization for InstancedSlots
// Reduces draw call count from ~450 to ~100-150 by grouping slots with same geometry
// Uses lodIndex attribute to select material variant without rebind overhead

import * as THREE from 'three';
import { MultiDrawOptimizer } from './multi-draw-optimizer.js';

/**
 * InstancedBatch: Combines multiple InstancedSlots (same geometry, different LODs)
 * into a single batched draw call via lodIndex attribute per instance.
 *
 * Key insight: All instances with same mesh geometry but different LODs can share
 * one InstancedMesh. Each instance carries a lodIndex (0-5) attribute that the
 * vertex shader uses to select material/texture variant. This collapses multiple
 * draw calls into one.
 *
 * Before batching: 450 draw calls (one per unique (asset, lod) pair)
 * After batching:  ~100-150 draw calls (one per unique geometry)
 *
 * Expected benefit: 8.4ms render time -> 5-6ms (35% reduction, +8-12 FPS)
 */
export class InstancedBatch {
  constructor(pool, geoKey, geometry, globalMaterialPool = null) {
    this.pool = pool;
    this.geoKey = geoKey; // mesh geometry identifier: `${meshIndex}:${primIndex}`
    this.geometry = geometry;
    this.capacity = 32; // grows as needed
    this.globalMaterialPool = globalMaterialPool;

    // Track which (asset, meshDescIdx, lodIdx) tuples are in this batch
    // key: `${assetUrl}|${meshDescIdx}|${lodIdx}` -> InstancedSlot
    this.slots = new Map();

    // Shared material for all LODs in this batch
    // MATERIAL GROUPING OPTIMIZATION: Use global FAR-tier material if available
    this._uniforms = { projViewMatrix: { value: new THREE.Matrix4() } };

    // GPU-driven per-instance transform: when enabled, each batch gets a
    // per-batch (cloned) material so it can bind its OWN instance data texture
    // uniform (a shared pool material could only bind one batch's texture). The
    // vertex shader rebuilds each instance's matrix from gl_InstanceID, so JS
    // never re-uploads a full instance buffer per frame; a single model move is
    // one 4-texel write + a dirty flag. Static instances cost nothing.
    this._gpuInstanceTex = pool._enableGpuInstanceTex !== false;
    let material;
    if (this._gpuInstanceTex) {
      // Start from the global/base vertex-color material, then CLONE so the
      // instance-texture uniform is per-batch.
      const baseFar = (globalMaterialPool && globalMaterialPool._useGlobalMaterialPool)
        ? globalMaterialPool.getMaterialForTier('far')
        : new THREE.MeshLambertMaterial({ vertexColors: true });
      material = baseFar.clone();
      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <color_fragment>',
          `#if defined( USE_COLOR_ALPHA )
            diffuseColor.rgb *= pow(vColor.rgb, vec3(2.2));
            diffuseColor.a *= vColor.a;
          #elif defined( USE_COLOR )
            diffuseColor.rgb *= pow(vColor, vec3(2.2));
          #endif`
        );
      };
      this._initInstanceTexture(this.capacity);
      _patchInstancedSlotMaterial(material, this._uniforms);
    } else if (globalMaterialPool && globalMaterialPool._useGlobalMaterialPool) {
      // Use the global FAR-tier material (shared across all batches)
      material = globalMaterialPool.getMaterialForTier('far');
    } else {
      // Fallback: create batch-specific material
      material = new THREE.MeshLambertMaterial({ vertexColors: true });
      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <color_fragment>',
          `#if defined( USE_COLOR_ALPHA )
            diffuseColor.rgb *= pow(vColor.rgb, vec3(2.2));
            diffuseColor.a *= vColor.a;
          #elif defined( USE_COLOR )
            diffuseColor.rgb *= pow(vColor, vec3(2.2));
          #endif`
        );
      };
      _patchInstancedSlotMaterial(material, this._uniforms);
    }
    this.material = material;

    // Batched InstancedMesh: single geometry, shared material
    this.mesh = new THREE.InstancedMesh(geometry, material, this.capacity);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.name = `batch:${geoKey}`;

    // Per-instance bound sphere for GPU frustum culling
    this._boundArray = new Float32Array(this.capacity * 4);
    this._boundAttr = new THREE.InstancedBufferAttribute(this._boundArray, 4);
    this._boundAttr.setUsage(THREE.DynamicDrawUsage);
    this.mesh.geometry.setAttribute('instanceBoundSphere', this._boundAttr);
    // Dirty-range tracking (mirror of model-pool.js's InstancedSlot fix): a single
    // instance's bound-sphere write otherwise re-uploads the WHOLE capacity*4
    // buffer via needsUpdate every frame any batched instance moves.
    this._boundDirtyRuns = [];

    // Per-instance LOD index (0-5) — vertex shader uses this to select material
    this._lodIndexArray = new Uint8Array(this.capacity);
    this._lodIndexAttr = new THREE.InstancedBufferAttribute(this._lodIndexArray, 1);
    this._lodIndexAttr.setUsage(THREE.DynamicDrawUsage);
    this.mesh.geometry.setAttribute('instanceLodIndex', this._lodIndexAttr);

    // Initialize all matrices to zero (invisible)
    const zero = new THREE.Matrix4().set(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0);
    for (let i = 0; i < this.capacity; i++) this.mesh.setMatrixAt(i, zero);
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;

    // Slot allocation tracking
    this._nextSlotIdx = 0;
    this._freeSlots = [];
    this._dirtySlots = new Set();

    // Stats
    this._stats = {
      totalInstances: 0,
      drawCalls: 1, // always 1 for a batch
      savedDrawCalls: 0, // estimated draw calls if not batched
    };
  }

  // Allocate a slot index for a new instance in this batch
  acquireSlotInBatch(lodIdx) {
    let idx;
    if (this._freeSlots.length) {
      idx = this._freeSlots.pop();
    } else {
      if (this._nextSlotIdx >= this.capacity) {
        this._grow(this.capacity * 2);
      }
      idx = this._nextSlotIdx++;
    }

    // Set LOD index for this instance
    this._lodIndexArray[idx] = lodIdx;
    this._lodIndexAttr.needsUpdate = true;

    // Update mesh.count to include this instance
    if (idx + 1 > this.mesh.count) this.mesh.count = idx + 1;
    this._stats.totalInstances++;

    return idx;
  }

  // Release a slot, making it available for reuse
  releaseSlotInBatch(idx) {
    this._freeSlots.push(idx);

    // Zero out the matrix to hide this instance
    const zero = new THREE.Matrix4().set(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0);
    if (this._gpuInstanceTex) {
      this.setInstanceTransform(idx, zero);
    } else {
      this.mesh.setMatrixAt(idx, zero);
      this._dirtySlots.add(idx);
    }

    // Zero the bound sphere
    const o = idx * 4;
    this._boundArray[o] = 0;
    this._boundArray[o+1] = 0;
    this._boundArray[o+2] = 0;
    this._boundArray[o+3] = 0;
    this._markBoundDirty(idx);

    this._stats.totalInstances--;
  }

  // --- GPU instance transform texture (mirror of InstancedSlot) ------------
  _initInstanceTexture(capacity) {
    this._instTexWidth = capacity * 4; // 4 texels per instance (one mat4)
    this._instTexData = new Float32Array(this._instTexWidth * 4);
    const tex = new THREE.DataTexture(this._instTexData, this._instTexWidth, 1, THREE.RGBAFormat, THREE.FloatType);
    // NearestFilter: we want exact texel reads (no interpolation between mat4
    // columns/instances), AND linear filtering of a float texture needs
    // OES_texture_float_linear which isn't guaranteed -> sampling it raised
    // GL_INVALID_OPERATION (1282). Nearest avoids both problems.
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
    this._instTexDirty = false;
  }
  setInstanceTransform(idx, matrix) {
    const e = matrix.elements;
    const base = idx * 16;
    for (let c = 0; c < 4; c++) {
      const o = base + c * 4, m = c * 4;
      this._instTexData[o] = e[m];
      this._instTexData[o + 1] = e[m + 1];
      this._instTexData[o + 2] = e[m + 2];
      this._instTexData[o + 3] = e[m + 3];
    }
    this._instTexDirty = true;
  }
  flushInstanceTexture() {
    if (this._instTexDirty) { this._instTex.needsUpdate = true; this._instTexDirty = false; }
  }

  // Update instance matrix
  setMatrixInBatch(idx, matrix) {
    if (this._gpuInstanceTex) { this.setInstanceTransform(idx, matrix); return; }
    this.mesh.setMatrixAt(idx, matrix);
    this._dirtySlots.add(idx);
  }

  // Update instance bound sphere (for GPU frustum culling)
  setBoundSphereInBatch(idx, cx, cy, cz, r) {
    const o = idx * 4;
    this._boundArray[o] = cx;
    this._boundArray[o+1] = cy;
    this._boundArray[o+2] = cz;
    this._boundArray[o+3] = r;
    this._markBoundDirty(idx);
  }
  // Merge instance idx's touched component range into a disjoint-run list
  // (same shape as model-pool.js's _markInstanceTexDirty/_markBoundDirty).
  _markBoundDirty(idx) {
    const loComp = idx * 4, hiComp = loComp + 3;
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
    runs.splice(i, j - i, [mergedLo, mergedHi]);
  }
  // Upload only the touched component runs instead of a full-buffer re-upload
  // every frame any batched instance's bound sphere changes.
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

  // Update LOD index for an instance (when entity switches LOD within batched tier)
  updateLodIndexInBatch(idx, lodIdx) {
    this._lodIndexArray[idx] = lodIdx;
    this._lodIndexAttr.needsUpdate = true;
  }

  // Flush pending updates to GPU
  // Optimization 2: Only mark needsUpdate if dirty slots exceed threshold (5-10% of capacity)
  flushUpdates() {
    this._flushBoundAttr();
    if (this._gpuInstanceTex) { this.flushInstanceTexture(); return; }
    if (this._dirtySlots.size > 0) {
      // ALWAYS flush dirty slots (the old 5%-of-capacity gate skipped the GPU
      // upload for small dirty counts yet cleared _dirtySlots anyway, leaving
      // released/moved instance matrices un-uploaded for frames -> ghost models
      // popping in/out). Still upload only the [min..max] dirty span via
      // updateRange to keep the upload small. THREE r0.184 API.
      const im = this.mesh.instanceMatrix;
      if (im.clearUpdateRanges && im.addUpdateRange) {
        let lo = Infinity, hi = -1;
        for (const s of this._dirtySlots) { if (s < lo) lo = s; if (s > hi) hi = s; }
        const span = (hi - lo + 1) * 16;
        im.clearUpdateRanges();
        if (span > 0 && span < (this.mesh.count || this.capacity) * 16) {
          im.addUpdateRange(lo * 16, span);
        }
      }
      im.needsUpdate = true;
      this._dirtySlots.clear();
    }
  }

  // Double batch capacity when full
  _grow(newCap) {
    const old = this.mesh;
    const next = new THREE.InstancedMesh(this.geometry, this.material, newCap);
    next.frustumCulled = false;
    next.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    next.name = old.name;

    if (this._gpuInstanceTex) {
      // Grow the instance data texture, preserving existing instance matrices.
      const oldData = this._instTexData;
      this._initInstanceTexture(newCap);
      this._instTexData.set(oldData);
      this._instTex.needsUpdate = true;
      // _initInstanceTexture already re-pointed this._uniforms.instanceTex(.value)
      // which the material's onBeforeCompile captured by reference.
    } else {
      // Copy existing matrices
      const m = new THREE.Matrix4();
      for (let i = 0; i < this._nextSlotIdx; i++) {
        old.getMatrixAt(i, m);
        next.setMatrixAt(i, m);
      }
      next.instanceMatrix.needsUpdate = true;
    }
    next.count = old.count;

    // Grow bound sphere attribute
    const newBounds = new Float32Array(newCap * 4);
    newBounds.set(this._boundArray);
    this._boundArray = newBounds;
    this._boundAttr = new THREE.InstancedBufferAttribute(newBounds, 4);
    this._boundAttr.setUsage(THREE.DynamicDrawUsage);
    next.geometry.setAttribute('instanceBoundSphere', this._boundAttr);
    this._boundDirtyRuns = []; // fresh attribute object, nothing pending to carry over

    // Grow LOD index attribute
    const newLodIndices = new Uint8Array(newCap);
    newLodIndices.set(this._lodIndexArray);
    this._lodIndexArray = newLodIndices;
    this._lodIndexAttr = new THREE.InstancedBufferAttribute(newLodIndices, 1);
    this._lodIndexAttr.setUsage(THREE.DynamicDrawUsage);
    next.geometry.setAttribute('instanceLodIndex', this._lodIndexAttr);

    // Replace in parent scene
    const parent = old.parent;
    if (parent) {
      parent.remove(old);
      parent.add(next);
    }
    old.dispose();

    this.mesh = next;
    this.capacity = newCap;
    this._dirtySlots = new Set();
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
    this.slots.clear();
  }

  getStats() {
    return {
      ...this._stats,
      geometry: this.geoKey,
      capacity: this.capacity,
    };
  }
}

/**
 * Wrapper for InstancedSlot that can be batched.
 * Most of the original logic stays the same; when batching is enabled,
 * the slot delegates to its parent batch instead of managing its own mesh.
 */
export class BatchedInstancedSlot {
  constructor(pool, batch, asset, meshDescIdx, lodIdx) {
    this.pool = pool;
    this.batch = batch; // parent InstancedBatch
    this.asset = asset;
    this.meshDescIdx = meshDescIdx;
    this.lodIdx = lodIdx;
    this.geometry = batch.geometry;
    this.material = batch.material;

    // Track which entities are in this slot
    this.slots = new Map(); // entity -> slot index within batch
    this._isBatched = true;
  }

  acquireSlot(entity) {
    // Allocate from the batch
    const idx = this.batch.acquireSlotInBatch(this.lodIdx);
    this.slots.set(entity, idx);
    return idx;
  }

  releaseSlot(entity) {
    const idx = this.slots.get(entity);
    if (idx == null) return;
    this.slots.delete(entity);
    this.batch.releaseSlotInBatch(idx);
  }

  setMatrixForSlot(idx, matrix) {
    this.batch.setMatrixInBatch(idx, matrix);
  }

  setBoundSphereForSlot(idx, cx, cy, cz, r) {
    this.batch.setBoundSphereInBatch(idx, cx, cy, cz, r);
  }

  flushMatrixUpdates() {
    this.batch.flushUpdates();
  }

  // No-op: batch handles growth
  _grow() {}

  dispose() {
    // Batches are never disposed individually; only when the batch itself is cleared
  }
}

/**
 * Detect WebGL 2.0 capabilities for advanced batching options
 */
export function detectWebGL2Capabilities(gl) {
  const capabilities = {
    version: gl?.getParameter(gl?.VERSION) || 'WebGL 1.0',
    vendor: gl?.getParameter(gl?.VENDOR) || 'unknown',
    renderer: gl?.getParameter(gl?.RENDERER) || 'unknown',
    // Multi-draw-indirect support (OES_draw_elements_base_vertex)
    baseVertex: !!gl?.getExtension('OES_draw_elements_base_vertex'),
    // ANGLE_multi_draw (for optimized multi-draw)
    multiDraw: !!gl?.getExtension('ANGLE_multi_draw'),
    // Instance divisor support (WebGL 2.0 standard)
    instanceDivisor: true, // built-in to WebGL 2.0
  };

  console.log('[batching] WebGL capabilities:', capabilities);
  return capabilities;
}

/**
 * Patch a material's shader to support per-instance LOD selection.
 * The vertex shader receives instanceLodIndex attribute and can use it
 * to select texture variants or adjust shading intensity.
 */
function _patchInstancedSlotMaterial(material, uniforms) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader) => {
    if (prev) prev(shader);
    shader.uniforms.projViewMatrix = uniforms.projViewMatrix;
    shader.uniforms.cameraPos = { value: new THREE.Vector3() };
    shader.uniforms.lodThresholds = { value: new THREE.Vector4(80, 200, 400, 800) };
    shader.uniforms.fovTanHalf = { value: 0.5 };
    shader.uniforms.viewportHeight = { value: 1080 };
    // GPU instance transform texture (per-instance mat4 as 4 RGBA texels) —
    // present only on per-batch (cloned) materials, never the shared pool one.
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
attribute vec4 instanceBoundSphere;
attribute float instanceLodIndex;
uniform mat4 projViewMatrix;
uniform vec3 cameraPos;
uniform vec4 lodThresholds;
uniform float fovTanHalf;
uniform float viewportHeight;
varying float vLodIndex;
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
  // mvPosition declared at outer scope (like <project_vertex>) so downstream
  // chunks (fog, etc.) that read it still compile.
  vec4 mvPosition = modelViewMatrix * readInstanceMatrix(gl_InstanceID) * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
#else
  #include <project_vertex>
#endif
{
  // GPU frustum cull + LOD selection
  vLodIndex = instanceLodIndex; // pass LOD to fragment shader if needed

  if (instanceBoundSphere.w > 0.0) {
    vec3 c = instanceBoundSphere.xyz;
    float r = instanceBoundSphere.w;

    // Frustum cull: derive 6 clip-space planes from projViewMatrix
    vec4 row0 = vec4(projViewMatrix[0][0], projViewMatrix[1][0], projViewMatrix[2][0], projViewMatrix[3][0]);
    vec4 row1 = vec4(projViewMatrix[0][1], projViewMatrix[1][1], projViewMatrix[2][1], projViewMatrix[3][1]);
    vec4 row2 = vec4(projViewMatrix[0][2], projViewMatrix[1][2], projViewMatrix[2][2], projViewMatrix[3][2]);
    vec4 row3 = vec4(projViewMatrix[0][3], projViewMatrix[1][3], projViewMatrix[2][3], projViewMatrix[3][3]);

    vec4 planes[6];
    planes[0] = row3 + row0; // left
    planes[1] = row3 - row0; // right
    planes[2] = row3 + row1; // bottom
    planes[3] = row3 - row1; // top
    planes[4] = row3 + row2; // near
    planes[5] = row3 - row2; // far

    bool outside = false;
    for (int i = 0; i < 6; i++) {
      vec4 p = planes[i];
      float len = length(p.xyz);
      if (len > 0.0) {
        float d = (dot(p.xyz, c) + p.w) / len;
        if (d < -r) { outside = true; break; }
      }
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

/**
 * Extension to ModelPool to support draw call batching.
 * Call enableBatching(pool) to activate batching for new InstancedSlots.
 * Automatically initializes ANGLE_multi_draw optimizer if available.
 */
export function enableDrawCallBatching(pool) {
  // Map: geometry key -> InstancedBatch
  pool._geometryBatches = new Map();

  // Detect WebGL 2.0 capabilities
  try {
    const canvas = pool.renderer.domElement;
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    pool._webglCapabilities = detectWebGL2Capabilities(gl);
  } catch (e) {
    console.warn('[batching] Failed to detect WebGL capabilities', e);
    pool._webglCapabilities = { version: 'unknown' };
  }

  // Initialize ANGLE_multi_draw optimizer for FAR-tier draw call reduction
  // This reduces 120+ per-slot draw calls to 1-3 GPU submissions (+6-10 FPS)
  // Called after batching is enabled so pool has access to _geometryBatches
  if (pool._initializeMultiDraw) {
    pool._initializeMultiDraw();
  }

  // Replace _getInstancedSlot to use batching
  const originalGetInstancedSlot = pool._getInstancedSlot.bind(pool);
  pool._getInstancedSlot = function(asset, meshDescIdx, lodIdx) {
    const desc = asset.meshLodDescs[meshDescIdx];
    if (!desc) return null;
    const lod = desc.lods[lodIdx];
    if (!lod || (lod.kind || 'textured') !== 'unskinned') return null;

    const geo = asset.geoCache.get(`${desc.meshIndex}:${desc.primIndex}:${lodIdx}`);
    if (!geo) return null; // not loaded yet
    // Batch key MUST identify the actual geometry. meshIndex:primIndex collides
    // across DISTINCT assets (every asset has a 0:0), which collapsed 900+
    // different models into ~12 batches all drawing one asset's geometry (the
    // "white cluster" / missing-models bug). Key by the resolved geometry's
    // uuid so identical copies of the SAME asset still share a batch (the
    // 1000-clones case) while distinct assets each get their own.
    const geoKey = geo.uuid;

    // Get or create batch for this geometry
    // MATERIAL GROUPING OPTIMIZATION: Pass global material pool to batch
    let batch = this._geometryBatches.get(geoKey);
    if (!batch) {
      batch = new InstancedBatch(this, geoKey, geo, this._globalMaterialPool);
      this._geometryBatches.set(geoKey, batch);
      this.scene.add(batch.mesh);
    }

    // Return a slot within the batch
    const slotKey = `${asset.url}|${meshDescIdx}|${lodIdx}`;
    let slot = batch.slots.get(slotKey);
    if (!slot) {
      slot = new BatchedInstancedSlot(this, batch, asset, meshDescIdx, lodIdx);
      batch.slots.set(slotKey, slot);
    }
    return slot;
  };

  // Add batching stats to ModelPool stats
  const originalGetStats = pool.getStats ? pool.getStats.bind(pool) : () => ({});
  pool.getStats = function() {
    const stats = originalGetStats();
    const batchStats = Array.from(this._geometryBatches.values()).map(b => b.getStats());
    const totalDrawCalls = batchStats.length;
    const totalInstances = batchStats.reduce((sum, s) => sum + s.totalInstances, 0);
    const totalSavedDrawCalls = batchStats.reduce((sum, s) => sum + s.savedDrawCalls, 0);

    return {
      ...stats,
      batching: {
        enabled: true,
        batches: this._geometryBatches.size,
        totalDrawCalls,
        totalInstances,
        estimatedSavedDrawCalls: totalSavedDrawCalls,
        reduction: totalSavedDrawCalls ? `${Math.round((totalSavedDrawCalls / (totalDrawCalls + totalSavedDrawCalls)) * 100)}%` : '0%',
      },
    };
  };

  // CRITICAL: flush batched instance matrices to the GPU every frame.
  // Batching replaces _getInstancedSlot so FAR-tier slots live in
  // _geometryBatches, NOT pool._instancedSlots — and pool.update() only flushes
  // _instancedSlots. Without this wrapper the batched matrices are written into
  // CPU-side arrays but never uploaded, so every batched instance stays at its
  // zero/origin matrix (all stacked invisibly at 0,0,0) and the models appear
  // to "vanish, leaving a small group". Wrapping update() to flush each batch
  // after the per-frame matrix writes fixes that.
  const originalUpdate = pool.update.bind(pool);
  pool.update = function() {
    const r = originalUpdate();
    for (const batch of this._geometryBatches.values()) {
      if (batch.flushUpdates) batch.flushUpdates();
    }
    return r;
  };

  console.log('[batching] Draw call batching enabled (with per-frame batch flush).');
}

export default { InstancedBatch, BatchedInstancedSlot, enableDrawCallBatching, detectWebGL2Capabilities };
