// batched-far-tier.js — FAR/unskinned tier rendered through a single
// THREE.BatchedMesh so hundreds of DISTINCT model geometries collapse into ONE
// draw call (renderer-native multi-draw, with graceful per-draw fallback when
// ANGLE_multi_draw is absent).
//
// Why: at 500 distinct models the measured bottleneck was ~734 draw calls
// (one InstancedBatch per distinct far asset). BatchedMesh draws many distinct
// geometries in a single bind/submit. It also does per-instance CPU frustum
// culling internally and supports SYNCHRONOUS LOD swaps via setGeometryIdAt —
// which removes the async slot-acquire / deferred-queue machinery that caused
// the "models disappear on LOD change" bugs.
//
// Integration: this exposes the same slot-ish interface the Entity code already
// calls on an instanced slot (acquireSlot / releaseSlot / setMatrixForSlot /
// setBoundSphereForSlot), so model-pool can route the unskinned tier here with
// minimal change. One BatchedMesh per vertex-color material class (we use one).

import * as THREE from 'three';

// Normalize a far geometry to the schema BatchedMesh requires (the schema is
// frozen by the first geometry added, so every geometry must match exactly in
// attribute set, itemSize and normalized flag). We force ONLY the attributes the
// far material actually reads:
//   position f32x3, color u8x4 (NORMALIZED -- baked once at add time; this
//   sub-14px tier's color precision loss at 8 bits/channel is imperceptible).
// The far material is UNLIT MeshBasicMaterial with vertexColors and no map, so it
// samples NEITHER normal NOR uv (no lighting math, no texture coords). Uploading
// them was dead per-vertex fetch bandwidth + VRAM (~20 bytes/vertex) across the
// dominant far tier, so we strip them along with everything else (uv1, tangent,
// the per-batch instanced attrs). If the far material ever regains lighting or a
// map, restore the attribute(s) it needs here.
function _normalizeFarGeometry(src) {
  const pos = src.getAttribute('position');
  if (!pos) return null;
  const n = pos.count;
  const geo = new THREE.BufferGeometry();
  // position
  geo.setAttribute('position', new THREE.BufferAttribute(_asFloat32(pos), 3, false));
  // color — unify to f32x4 non-normalized (matches the vertex-color gamma path).
  const col = src.getAttribute('color');
  geo.setAttribute('color', _colorToFloat4(col, n));
  // index (all far geometries are indexed in this asset set)
  if (src.index) geo.setIndex(new THREE.BufferAttribute(_asUint(src.index.array), 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

function _asFloat32(attr, itemSize) {
  const is = itemSize || attr.itemSize;
  // De-normalize integer/normalized data into plain float positions/uvs.
  if (attr.array instanceof Float32Array && attr.itemSize === is && !attr.normalized) return attr.array;
  const out = new Float32Array(attr.count * is);
  for (let i = 0; i < attr.count; i++) {
    if (is >= 1) out[i * is] = attr.getX(i);
    if (is >= 2) out[i * is + 1] = attr.getY(i);
    if (is >= 3) out[i * is + 2] = attr.getZ(i);
  }
  return out;
}

// Produce a Uint8 itemSize-4 NORMALIZED color array regardless of the source
// layout (missing -> white; itemSize 3 -> alpha 1; normalized int -> 0..1
// floats read back through get*() which three.js already denormalizes to
// 0..1 for normalized source attributes). This tier is sub-14px on screen
// (far/instanced dots) where 8-bit-per-channel color precision loss is
// imperceptible; colors are baked ONCE here at geometry-normalize time, never
// touched per-frame, so this is a pure init-time repack. The `true` (5th
// three.js BufferAttribute normalized flag) maps the stored 0..255 byte back
// to 0.0..1.0 in the shader's attribute read transparently -- verified the
// consuming shader only touches the stock <color_vertex> chunk (plain
// `vColor = color` / `vColor *= color` read) plus a pow() on the already-read
// vColor varying, with no assumption about the underlying storage type, so
// this needs zero shader changes.
function _colorToFloat4(col, count) {
  const out = new Uint8Array(count * 4);
  if (!col) { out.fill(255); return new THREE.BufferAttribute(out, 4, true); }
  const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let i = 0; i < count; i++) {
    const r = col.getX(i);
    const g = col.itemSize >= 2 ? col.getY(i) : r;
    const b = col.itemSize >= 3 ? col.getZ(i) : r;
    const a = col.itemSize >= 4 ? col.getW(i) : 1;
    out[i * 4 + 0] = clamp255(r);
    out[i * 4 + 1] = clamp255(g);
    out[i * 4 + 2] = clamp255(b);
    out[i * 4 + 3] = clamp255(a);
  }
  return new THREE.BufferAttribute(out, 4, true);
}

function _asUint(arr) {
  if (arr instanceof Uint32Array || arr instanceof Uint16Array) return arr;
  return new Uint32Array(arr);
}

export class BatchedFarTier {
  constructor(pool, opts = {}) {
    this.pool = pool;
    this.maxInstances = opts.maxInstances ?? 4096;
    this.maxVerts = opts.maxVerts ?? 3_000_000; // > surveyed 2.2M; Uint32 idx auto
    this.maxIndex = opts.maxIndex ?? 6_000_000; // > surveyed 4.5M
    // UNLIT vertex-color material (MeshBasicMaterial). Far/instanced dots don't
    // need lighting; unlit also removes the Lambert lighting dependency that was
    // making batched far models render dark/black (the "off-screen"/empty-screen
    // symptom was actually near-black models being counted as background). Unlit
    // shows the baked vertex colors directly. Also cheaper fragment cost (fill).
    const material = new THREE.MeshBasicMaterial({ vertexColors: true });

    // ---- On-GPU position lerp -------------------------------------------
    // Per-instance interpolation data lives in a parallel float texture indexed
    // by the BatchedMesh instance id (getIndirectIndex(gl_DrawID) in r0.170).
    // 2 texels/instance: texel0 = pos0.xyz + startTime(.w), texel1 = pos1.xyz +
    // duration(.w). When duration>0 the vertex shader OVERRIDES the batching
    // matrix's translation column with mix(pos0,pos1,t) where t = clamp((uNow -
    // startTime)/duration, 0, 1) — rotation/scale from setMatrixAt are kept.
    // The CPU writes these 2 texels only on a sparse setTarget and bumps a single
    // uNow uniform once per frame: entities in flight cost ZERO per-frame matrix
    // writes (the whole interpolation runs on the GPU).
    this._lerpTexelsPerInstance = 2;
    this._initLerpTexture(this.maxInstances);
    this._uNow = { value: 0 };

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uLerpTex = { value: this._lerpTex };
      shader.uniforms.uLerpTexW = { value: this._lerpTexW };
      shader.uniforms.uNow = this._uNow;
      // sRGB->linear decode moved PER-FRAGMENT -> PER-VERTEX (cheap on low-poly far).
      shader.vertexShader = shader.vertexShader.replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        #if defined( USE_COLOR_ALPHA )
          vColor.rgb = pow(vColor.rgb, vec3(2.2));
        #elif defined( USE_COLOR )
          vColor = pow(vColor, vec3(2.2));
        #endif`,
      );
      // Declare the lerp sampler + uNow (pars), and a texelFetch helper.
      shader.vertexShader = shader.vertexShader.replace(
        '#include <batching_pars_vertex>',
        `#include <batching_pars_vertex>
        uniform sampler2D uLerpTex;
        uniform float uLerpTexW;
        uniform float uNow;
        vec4 _lerpTexel(int idx) {
          int w = int(uLerpTexW);
          return texelFetch(uLerpTex, ivec2(idx % w, idx / w), 0);
        }`,
      );
      // After <batching_vertex> defines batchingMatrix, override its translation
      // column with the GPU-lerped position when this instance has an active
      // target (duration > 0). batchId = getIndirectIndex(gl_DrawID).
      shader.vertexShader = shader.vertexShader.replace(
        '#include <batching_vertex>',
        `#include <batching_vertex>
        #ifdef USE_BATCHING
        {
          int _bId = int(getIndirectIndex(gl_DrawID));
          int _base = _bId * 2;
          vec4 _p0 = _lerpTexel(_base);
          vec4 _p1 = _lerpTexel(_base + 1);
          float _dur = _p1.w;
          if (_dur > 0.0) {
            float _t = clamp((uNow - _p0.w) / _dur, 0.0, 1.0);
            vec3 _lp = mix(_p0.xyz, _p1.xyz, _t);
            batchingMatrix[3].xyz = _lp;
          }
        }
        #endif`,
      );
    };
    this.material = material;
    this.mesh = new THREE.BatchedMesh(this.maxInstances, this.maxVerts, this.maxIndex, material);
    this.mesh.frustumCulled = false;          // object-level; we cull per instance
    this.mesh.perObjectFrustumCulled = true;  // CPU per-instance sphere cull in onBeforeRender
    this.mesh.sortObjects = false;            // opaque, depth-test handles order; saves CPU
    this.mesh.name = 'batched-far-tier';
    // geometryId cache: `${assetUrl}|${meshDescIdx}|${lodIdx}` -> geometryId
    this._geometryIds = new Map();
    // entity -> instanceId
    this._instances = new Map();
    this._tmpColor = new THREE.Color();
  }

  // Lazily register a (resolved) far geometry; returns its BatchedMesh geometryId.
  _geometryIdFor(asset, meshDescIdx, lodIdx, resolvedGeo) {
    const key = `${asset.url}|${meshDescIdx}|${lodIdx}`;
    let gid = this._geometryIds.get(key);
    if (gid != null) return gid;
    const norm = _normalizeFarGeometry(resolvedGeo);
    if (!norm) return null;
    try {
      gid = this.mesh.addGeometry(norm);
    } catch (e) {
      // Out of reserved space → grow the shared buffers and retry once.
      this.mesh.setGeometrySize(this.maxVerts *= 2, this.maxIndex *= 2);
      gid = this.mesh.addGeometry(norm);
    }
    this._geometryIds.set(key, gid);
    return gid;
  }

  // Entity-facing: acquire an instance for this entity at the given geometry.
  // Returns an instanceId (used as the "slot index" by the entity code).
  acquire(entity, asset, meshDescIdx, lodIdx, resolvedGeo) {
    const gid = this._geometryIdFor(asset, meshDescIdx, lodIdx, resolvedGeo);
    if (gid == null) return -1;
    let id = this._instances.get(entity);
    if (id == null) {
      try {
        id = this.mesh.addInstance(gid);
      } catch (e) {
        this.mesh.setInstanceCount(this.maxInstances *= 2);
        id = this.mesh.addInstance(gid);
      }
      this._instances.set(entity, id);
    } else {
      // LOD change within the far tier == synchronous geometry swap. This is the
      // whole point: no release/re-acquire, no async load, no disappear.
      this.mesh.setGeometryIdAt(id, gid);
    }
    return id;
  }

  release(entity) {
    const id = this._instances.get(entity);
    if (id == null) return;
    this._instances.delete(entity);
    this.clearLerp(id); // don't let a recycled instance id inherit stale motion
    this.mesh.deleteInstance(id);
  }

  // Instance id for an entity (used by the pool to target GPU lerp). -1 if none.
  instanceIdFor(entity) {
    const id = this._instances.get(entity);
    return id == null ? -1 : id;
  }

  setMatrix(id, matrix) {
    if (id < 0) return;
    this.mesh.setMatrixAt(id, matrix);
  }

  // Allocate the per-instance lerp texture (RGBA32F, 2 texels/instance). texelFetch
  // ignores filtering, but NearestFilter + no mipmaps avoids the float-linear GL
  // error path. Square texture sized to hold maxInstances*2 texels.
  _initLerpTexture(maxInstances) {
    const texelCount = maxInstances * this._lerpTexelsPerInstance;
    const w = Math.max(1, Math.ceil(Math.sqrt(texelCount)));
    this._lerpTexW = w;
    this._lerpData = new Float32Array(w * w * 4);
    const tex = new THREE.DataTexture(this._lerpData, w, w, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this._lerpTex = tex;
  }

  // Push the per-frame clock to the shader (the ONLY per-frame CPU->GPU write
  // for in-flight far entities). nowSec is a monotonic seconds value.
  updateNow(nowSec) { this._uNow.value = nowSec; }

  // Record a GPU lerp for instance `id`: interpolate translation pos0->pos1 over
  // [startSec, startSec+durSec]. Writes 2 texels; the shader does the rest.
  setLerpTarget(id, x0, y0, z0, x1, y1, z1, startSec, durSec) {
    if (id < 0) return;
    const base = id * this._lerpTexelsPerInstance * 4;
    if (base + 7 >= this._lerpData.length) return; // out of range (pre-grow safety)
    this._lerpData[base] = x0; this._lerpData[base + 1] = y0; this._lerpData[base + 2] = z0; this._lerpData[base + 3] = startSec;
    this._lerpData[base + 4] = x1; this._lerpData[base + 5] = y1; this._lerpData[base + 6] = z1; this._lerpData[base + 7] = durSec;
    this._lerpTex.needsUpdate = true;
  }

  // Clear any active lerp for an instance (duration=0 -> shader leaves the
  // batching matrix translation as setMatrixAt set it). Used on release/recycle.
  clearLerp(id) {
    if (id < 0) return;
    const base = id * this._lerpTexelsPerInstance * 4;
    if (base + 7 >= this._lerpData.length) return;
    for (let i = 0; i < 8; i++) this._lerpData[base + i] = 0;
    this._lerpTex.needsUpdate = true;
  }

  // No-op stubs: BatchedMesh culls per instance itself from per-geometry bounds.
  flush() { /* BatchedMesh uploads matrices via its own dirty tracking */ }

  // Per-(asset,meshDescIdx,lodIdx) adapter implementing the slot interface the
  // Entity code calls (acquireSlot/releaseSlot/setMatrixForSlot/
  // setBoundSphereForSlot). It carries the resolved geometry so acquire can add
  // it to the shared BatchedMesh, and exposes `mesh` (the shared BatchedMesh)
  // for scene attachment + flush. All adapters for one tier share one mesh.
  slotAdapter(asset, meshDescIdx, lodIdx, resolvedGeo) {
    const tier = this;
    return {
      _batchedFar: true,
      mesh: tier.mesh,
      asset, meshDescIdx, lodIdx,
      acquireSlot(entity) {
        return tier.acquire(entity, asset, meshDescIdx, lodIdx, resolvedGeo);
      },
      releaseSlot(entity) { tier.release(entity); },
      setMatrixForSlot(id, matrix) { tier.setMatrix(id, matrix); },
      // BatchedMesh culls per instance from per-geometry bounds; bound-sphere
      // seeding is a no-op here (kept for interface compatibility).
      setBoundSphereForSlot() {},
      flushMatrixUpdates() {},
      flushUpdates() {},
    };
  }
}

export default { BatchedFarTier };
