import * as THREE from 'three';

function _normalizeFarGeometry(src) {
  const pos = src.getAttribute('position');
  if (!pos) return null;
  const n = pos.count;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(_asFloat32(pos), 3, false));
  const col = src.getAttribute('color');
  geo.setAttribute('color', _colorToUnorm8x4(col, n));
  if (src.index) geo.setIndex(new THREE.BufferAttribute(_asUint(src.index.array), 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

function _asFloat32(attr, itemSize) {
  const is = itemSize || attr.itemSize;
  if (attr.array instanceof Float32Array && attr.itemSize === is && !attr.normalized) return attr.array;
  const out = new Float32Array(attr.count * is);
  for (let i = 0; i < attr.count; i++) {
    if (is >= 1) out[i * is] = attr.getX(i);
    if (is >= 2) out[i * is + 1] = attr.getY(i);
    if (is >= 3) out[i * is + 2] = attr.getZ(i);
  }
  return out;
}

function _colorToUnorm8x4(col, count) {
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
    this.maxVerts = opts.maxVerts ?? 3_000_000;
    this.maxIndex = opts.maxIndex ?? 6_000_000;
    const material = new THREE.MeshBasicMaterial({ vertexColors: true });

    this._lerpTexelsPerInstance = 2;
    this._initLerpTexture(this.maxInstances);
    this._uNow = { value: 0 };

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uLerpTex = { value: this._lerpTex };
      shader.uniforms.uLerpTexW = { value: this._lerpTexW };
      shader.uniforms.uNow = this._uNow;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        #if defined( USE_COLOR_ALPHA )
          vColor.rgb = pow(vColor.rgb, vec3(2.2));
        #elif defined( USE_COLOR )
          vColor = pow(vColor, vec3(2.2));
        #endif`,
      );
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
    this.mesh.frustumCulled = false;
    this.mesh.perObjectFrustumCulled = true;
    this.mesh.sortObjects = false;
    this.mesh.name = 'batched-far-tier';
    this._geometryIds = new Map();
    this._instances = new Map();
    this._tmpColor = new THREE.Color();
  }

  _geometryIdFor(asset, meshDescIdx, lodIdx, resolvedGeo) {
    const key = `${asset.url}|${meshDescIdx}|${lodIdx}`;
    let gid = this._geometryIds.get(key);
    if (gid != null) return gid;
    const norm = _normalizeFarGeometry(resolvedGeo);
    if (!norm) return null;
    try {
      gid = this.mesh.addGeometry(norm);
    } catch (e) {
      this.mesh.setGeometrySize(this.maxVerts *= 2, this.maxIndex *= 2);
      gid = this.mesh.addGeometry(norm);
    }
    this._geometryIds.set(key, gid);
    return gid;
  }

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
      this.mesh.setGeometryIdAt(id, gid);
    }
    return id;
  }

  release(entity) {
    const id = this._instances.get(entity);
    if (id == null) return;
    this._instances.delete(entity);
    this.clearLerp(id);
    this.mesh.deleteInstance(id);
  }

  instanceIdFor(entity) {
    const id = this._instances.get(entity);
    return id == null ? -1 : id;
  }

  setMatrix(id, matrix) {
    if (id < 0) return;
    this.mesh.setMatrixAt(id, matrix);
  }

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

  updateNow(nowSec) { this._uNow.value = nowSec; }

  setLerpTarget(id, x0, y0, z0, x1, y1, z1, startSec, durSec) {
    if (id < 0) return;
    const base = id * this._lerpTexelsPerInstance * 4;
    if (base + 7 >= this._lerpData.length) return;
    this._lerpData[base] = x0; this._lerpData[base + 1] = y0; this._lerpData[base + 2] = z0; this._lerpData[base + 3] = startSec;
    this._lerpData[base + 4] = x1; this._lerpData[base + 5] = y1; this._lerpData[base + 6] = z1; this._lerpData[base + 7] = durSec;
    this._lerpTex.needsUpdate = true;
  }

  clearLerp(id) {
    if (id < 0) return;
    const base = id * this._lerpTexelsPerInstance * 4;
    if (base + 7 >= this._lerpData.length) return;
    for (let i = 0; i < 8; i++) this._lerpData[base + i] = 0;
    this._lerpTex.needsUpdate = true;
  }

  flush() { }

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
      setBoundSphereForSlot() {},
      flushMatrixUpdates() {},
      flushUpdates() {},
    };
  }
}

export default { BatchedFarTier };
