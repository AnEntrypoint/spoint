// Event emitter + GPU-instanced-mesh pool slot for model-pool.js's ModelPool: Emitter (tiny pub/sub),
// InstancedSlot (one shared THREE.InstancedMesh per asset+LOD, with a GPU-driven per-instance transform
// texture and a per-instance bound-sphere frustum cull baked into the vertex shader), and the material
// patch that wires both into any material's onBeforeCompile. Split out as model-pool.js's largest
// self-contained structural block -- InstancedSlot takes `pool` as an explicit constructor param
// (dependency injection, not closure capture: only pool._frustumCache/pool._enableGpuInstanceTex are
// read, both plain property access), so it is genuinely portable with zero change to call sites.

import * as THREE from 'three';
import { CachedFrustumPlanes } from './frustum-cache.js';

const _zeroMatrix = new THREE.Matrix4().set(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0);

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

// --- InstancedPool: one shared InstancedMesh per (asset, lod) -------------
// For the unskinned LOD tier we don't need per-entity skeletons or per-entity
// SkinnedMesh shells; the mesh is in bind pose and only its TRANSFORM differs
// across entities. Wrapping them all in one InstancedMesh collapses N draw
// calls into 1, which is the only realistic path to 1000+ entities on
// commodity hardware.
class InstancedSlot {
  constructor(pool, asset, meshDescIdx, lodIdx, geo, material) {
    this.pool = pool;
    this.asset = asset;
    this.meshDescIdx = meshDescIdx;
    this.lodIdx = lodIdx;
    this.geometry = geo;
    this.material = material;
    this.capacity = 32; // grow as needed
    // Per-frame uniform — ModelPool.update writes the camera's
    // projection*view matrix into here so the vertex shader can do GPU
    // frustum culling without a CPU sphere test per entity.
    this._uniforms = { projViewMatrix: { value: new THREE.Matrix4() } };
    // Initialize frustum plane cache (shared across all slots in this pool)
    if (!pool._frustumCache) pool._frustumCache = new CachedFrustumPlanes();
    this._uniforms.frustumPlanes = { value: pool._frustumCache.getPlaneUniforms() };
    // GPU-driven per-instance transform: a float DataTexture holds each
    // instance's model matrix as 4 RGBA texels (one mat4 column per texel),
    // instance i -> texels [i*4 .. i*4+3]. The vertex shader rebuilds the
    // matrix from gl_InstanceID, so JS never re-uploads a full instance buffer
    // per frame; a single model move is one 4-texel write + a dirty flag.
    // Each slot needs its OWN instanceTex uniform, so when the GPU path is on
    // the slot must use a PER-SLOT material (the shared global FAR material
    // could only bind one slot's texture). Each slot is already its own
    // InstancedMesh = its own draw, so cloning the material adds no draw call.
    this._gpuInstanceTex = pool._enableGpuInstanceTex !== false;
    if (this._gpuInstanceTex) {
      material = material.clone();
      this._initInstanceTexture(this.capacity);
    }
    _patchInstancedSlotMaterial(material, this._uniforms);
    this.material = material;
    this.mesh = new THREE.InstancedMesh(geo, material, this.capacity);
    this.mesh.frustumCulled = false; // GPU vertex-shader handles culling
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Per-instance world-space bounding-sphere RADIUS only (r). The center is
    // always exactly the instance's own matrix translation column (verified:
    // every write site below passes me[12..14] straight from the instance's
    // world matrix, never an offset center) so the vertex shader derives it
    // from instanceMatrix[3].xyz / readInstanceMatrix(...)[3].xyz instead of
    // carrying a redundant xyz here — 4x smaller attribute + upload. Set on
    // slot acquire / update; the vertex shader reads this and collapses
    // out-of-frustum instances to NaN.
    this._boundArray = new Float32Array(this.capacity);
    this._boundAttr = new THREE.InstancedBufferAttribute(this._boundArray, 1);
    this._boundAttr.setUsage(THREE.DynamicDrawUsage);
    this.mesh.geometry.setAttribute('instanceBoundSphere', this._boundAttr);
    // Dirty-range tracking for the bound-sphere attribute, mirroring the instance
    // transform texture's addUpdateRange treatment: a single moving instance's
    // sphere write otherwise re-uploads the WHOLE capacity*4 buffer every frame
    // (see flushInstanceTexture's comment for the identical bug class).
    this._boundDirtyRuns = [];
    // Zero out all instance matrices initially so unused slots draw nothing
    // visible (zero matrix collapses to origin point).
    const zero = new THREE.Matrix4().set(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0);
    for (let i = 0; i < this.capacity; i++) this.mesh.setMatrixAt(i, zero);
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.slots = new Map(); // entity -> slot index
    this.freeSlots = []; // recycled indices
    this.nextSlot = 0;
    this._dirtySlots = new Set(); // tracks which slot indices need GPU upload
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
    // Zero its matrix so it stops drawing (collapses to origin / degenerate).
    const zero = _zeroMatrix;
    if (this._gpuInstanceTex) {
      this.setInstanceTransform(idx, zero);
    } else {
      this.mesh.setMatrixAt(idx, zero);
      this._dirtySlots.add(idx);
    }
    // Zero the bound-sphere radius so the shader treats this slot as
    // "no bound info" → also drawn at origin (zero matrix). Belt+braces.
    this._boundArray[idx] = 0;
    this._markBoundDirty(idx);
  }
  setMatrixForSlot(idx, matrix) {
    if (this._gpuInstanceTex) {
      // GPU path: write the matrix into the instance data texture. The shader
      // reads it by gl_InstanceID; we do not touch the instanceMatrix attribute.
      this.setInstanceTransform(idx, matrix);
      return;
    }
    this.mesh.setMatrixAt(idx, matrix);
    this._dirtySlots.add(idx);
  }
  // Optimization 2: Deferred matrix buffer uploads
  // Only mark needsUpdate if dirty slots exceed threshold (5-10% of capacity)
  // This reduces GPU buffer sync stalls by batching updates across multiple frames
  flushMatrixUpdates() {
    this._flushBoundAttr();
    if (this._gpuInstanceTex) { this.flushInstanceTexture(); return; }
    if (this._dirtySlots.size > 0) {
      // ALWAYS flush when there are dirty slots. The old 5%-of-capacity gate
      // skipped the GPU upload for small dirty counts but cleared _dirtySlots
      // anyway, so a released/moved instance's matrix sat un-uploaded in the CPU
      // buffer for frames — producing ghost models that pop in/out (most visible
      // when the zoom-cycle camera transitions a few entities' LOD at a time).
      this.mesh.instanceMatrix.needsUpdate = true;
      this._dirtySlots.clear();
    }
  }
  // Center is intentionally NOT stored here — it is always the instance's own
  // matrix translation, which the vertex shader already has via instanceMatrix
  // / the instance transform texture. Only the radius is CPU-tracked.
  setBoundSphereForSlot(idx, r) {
    this._boundArray[idx] = r;
    this._markBoundDirty(idx);
  }
  // Insert instance idx's touched component range into a merged disjoint-run
  // list (identical shape to _markInstanceTexDirty) so N scattered per-frame
  // movers upload O(N) components instead of O(capacity) components.
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
    // PERF: the common case (a moving instance touching/extending an already-
    // dirty run) has j > i, i.e. at least one existing [lo,hi] tuple is being
    // replaced — reuse that tuple's array in place instead of splice()'ing in
    // a freshly allocated 2-element array every call. Only allocate when this
    // is a genuinely new, disjoint run (j === i, nothing to reuse).
    if (j > i) {
      const tuple = runs[i];
      tuple[0] = mergedLo; tuple[1] = mergedHi;
      if (j - i > 1) runs.splice(i + 1, j - i - 1);
    } else {
      runs.splice(i, 0, [mergedLo, mergedHi]);
    }
  }
  // Upload only the touched component runs via addUpdateRange instead of a
  // full-buffer needsUpdate re-upload every frame any instance's bound sphere
  // changes (same fix class/rationale as flushInstanceTexture above).
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
  // --- GPU instance transform texture --------------------------------------
  // Texture layout: width = capacity*4 texels (4 per instance = a mat4's four
  // columns), height = 1. RGBA32F. instance i occupies texels [i*4 .. i*4+3].
  _initInstanceTexture(capacity) {
    const texelsPerInstance = 4;
    this._instTexWidth = capacity * texelsPerInstance;
    this._instTexData = new Float32Array(this._instTexWidth * 4);
    const tex = new THREE.DataTexture(this._instTexData, this._instTexWidth, 1, THREE.RGBAFormat, THREE.FloatType);
    // NearestFilter: exact texel reads + avoids OES_texture_float_linear
    // requirement (linear-filtering a float texture raises GL_INVALID_OPERATION).
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this._instTex = tex;
    // Reuse existing uniform objects on regrow so the material's captured
    // references (from onBeforeCompile) stay valid — only swap their .value.
    if (this._uniforms.instanceTex) {
      this._uniforms.instanceTex.value = tex;
      this._uniforms.instanceTexWidth.value = this._instTexWidth;
    } else {
      this._uniforms.instanceTex = { value: tex };
      this._uniforms.instanceTexWidth = { value: this._instTexWidth };
    }
    // Dirty-range tracking for partial uploads: a SORTED SET of disjoint [loCol,hiCol]
    // texel-column runs touched since the last flush (see setInstanceTransform/flushInstanceTexture
    // for why this replaced a single min..max span).
    this._instTexDirtyRuns = [];
  }
  // Write one instance's mat4 into its 4 texels. Marks only that instance's
  // column range dirty — a single model move costs one 4-texel write here.
  setInstanceTransform(idx, matrix) {
    const e = matrix.elements; // column-major 16 floats
    const base = idx * 4 * 4; // 4 texels * 4 channels
    // column c -> texel (idx*4 + c) -> data[base + c*4 .. +3]
    for (let c = 0; c < 4; c++) {
      const o = base + c * 4;
      const m = c * 4;
      this._instTexData[o] = e[m];
      this._instTexData[o + 1] = e[m + 1];
      this._instTexData[o + 2] = e[m + 2];
      this._instTexData[o + 3] = e[m + 3];
    }
    this._markInstanceTexDirty(idx * 4, idx * 4 + 3);
  }
  // Insert [loCol,hiCol] into the sorted disjoint-run list, merging with any overlapping/adjacent
  // run so the list stays O(distinct touched regions) rather than growing one entry per instance.
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
    // PERF: same in-place-reuse fix as _markBoundDirty above — avoid
    // allocating a fresh 2-element tuple on every instance write when an
    // existing run can be mutated in place instead.
    if (j > i) {
      const tuple = runs[i];
      tuple[0] = mergedLo; tuple[1] = mergedHi;
      if (j - i > 1) runs.splice(i + 1, j - i - 1);
    } else {
      runs.splice(i, 0, [mergedLo, mergedHi]);
    }
  }
  // Upload only the touched texel columns via THREE's addUpdateRange (three>=0.159) instead of a
  // full-width needsUpdate re-upload every frame something moved. PERF (2026-07-02, spoint consumer
  // 144fps investigation): a live stack-trace CDP profile traced texSubImage2D — a top-3 live-frame
  // cost — to three's uploadTexture->setTexture2D re-uploading this ENTIRE _instTexWidth-wide row
  // (capacity*4 texels) on every frame ANY tracked entity moved, even when only one instance's 4-texel
  // range actually changed. addUpdateRange narrows the GPU upload to the byte-exact dirty span
  // (start/count are in COMPONENTS: RGBAFormat = 4 components/texel, so texel range [lo,hi] ->
  // component range [lo*4, (hi-lo+1)*4]).
  //
  // FOLLOW-UP FIX (2026-07-02i): the original version tracked a single min..max SPAN across all
  // dirty instances in a frame. When co-moving entities land at scattered pool slot indices (the
  // normal case — slot assignment is allocation-order, not spatial/temporal locality), that span
  // silently widens to cover nearly the whole texture, degrading back to a near-full-width upload
  // with no signal that the "partial" path stopped helping. Now tracks a merged list of disjoint
  // dirty runs and issues one addUpdateRange per run, so N scattered movers upload O(N) texels
  // instead of O(capacity) texels regardless of how spread out their slot indices are.
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
      // Grow the instance data texture, preserving existing instance matrices.
      const oldData = this._instTexData;
      this._initInstanceTexture(newCap);
      this._instTexData.set(oldData); // copy old texels into the front of the new buffer
      this._instTex.needsUpdate = true;
      // Re-point the shader uniform at the new texture (same uniform object the
      // material's onBeforeCompile captured, so just swap its .value).
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
    // Grow + carry the per-instance bound-sphere radius attribute.
    const newBounds = new Float32Array(newCap);
    newBounds.set(this._boundArray);
    this._boundArray = newBounds;
    this._boundAttr = new THREE.InstancedBufferAttribute(newBounds, 1);
    this._boundAttr.setUsage(THREE.DynamicDrawUsage);
    next.geometry.setAttribute('instanceBoundSphere', this._boundAttr);
    this._boundDirtyRuns = []; // fresh attribute object, no pending partial-range upload to carry
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
}

// Patch a material so its vertex shader receives a per-instance bound-sphere
// attribute and a per-frame projViewMatrix uniform, then collapses any
// instance outside the camera frustum to a NaN clip-space position so the GPU
// early-rejects it. Frustum planes are pre-normalized on the CPU, so the cull
// is a branch-free dot product per plane with no per-vertex sqrt/divide.
// Wraps any existing onBeforeCompile so the vertex-color gamma patch on the
// fragment side still runs.
function _patchInstancedSlotMaterial(material, uniforms) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader) => {
    if (prev) prev(shader);
    shader.uniforms.projViewMatrix = uniforms.projViewMatrix;
    // 6 pre-computed, unit-normalized frustum planes (normal.xyz + constant.w),
    // updated once per frame on the CPU. The vertex shader uses them directly.
    shader.uniforms.frustumPlanes = uniforms.frustumPlanes;
    // GPU instance transform texture (per-instance mat4 as 4 RGBA texels).
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
  // 4 texels per instance; fetch by pixel center. height = 1.
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
  // GPU-driven transform: rebuild this instance's model matrix from the
  // instance data texture (by gl_InstanceID) instead of the instanceMatrix
  // attribute. mvPosition is declared at outer scope (exactly like the stock
  // <project_vertex> chunk) so downstream chunks that read it still compile.
  mat4 instMat = readInstanceMatrix(gl_InstanceID);
  vec4 mvPosition = modelViewMatrix * instMat * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vec3 instCenter = instMat[3].xyz;
#else
  #include <project_vertex>
  vec3 instCenter = instanceMatrix[3].xyz;
#endif
{
  // GPU per-instance frustum cull.
  // frustumPlanes are pre-normalized CPU-side (THREE.Frustum emits unit
  // normals), so the plane equation reduces to dot(n, c) + w >= -r with no
  // per-vertex sqrt/divide. (Removed the old length()/division — it was
  // normalizing an already-unit vector. Also removed the dead lodLutTexture
  // fetch + vLodIndex varying: LOD selection happens CPU-side, the varying
  // was written but never read by any fragment shader.)
  // Center is NOT a separate attribute: it is always exactly the instance's
  // own model-matrix translation column, read directly from whichever
  // transform path is active above (verified CPU-side: every JS write site
  // passes the instance's own worldMat translation, never an offset center).
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
