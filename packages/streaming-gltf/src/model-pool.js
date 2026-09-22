import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from './draco-loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { GlobalMaterialPool } from './material-pool.js';
import { GlobalMaterialPoolTSL } from './material-poolTSL.js';
import { createVertexColorNodeMaterial } from './model-poolTSL.js';
import { ClusterLodMesh, attachClusterLod } from './cluster-lod-mesh.js';
import { CLUSTER_LOD_EXTRA_KEY, lod0OnlyClusterLodExtras } from './meshlet-codec.js';
import { mergeClusterMeshesByMaterial } from './cluster-material-merge.js';
import { isArrayAtlasCandidate, buildTextureArray, buildArrayMaterial, tagGeometryLayer } from './texture-array-atlas.js';
import { buildArrayMaterialTSL } from './texture-array-atlasTSL.js';
import { applyLowTierMaterials, setThreeRef as setLowTierThreeRef } from './material-tier-swap.js';
setLowTierThreeRef(THREE);
import { applyKtx2DeviceTierCap } from './ktx2-mip-cap.js';
import { DeferredLoadQueue } from './deferred-load-queue.js';
import { LodUnloadManager } from './lod-unload-manager.js';
import { applyGridDecimate } from './grid-decimate.js';
import { Emitter, InstancedSlot, _patchInstancedSlotMaterial, _zeroMatrix } from './model-pool-instanced-slot.js';
import { BatchedFarTier } from './batched-far-tier.js';
import { MaterialBucketBatcher } from './material-bucket-batcher.js';
import { OctahedralImpostorEzTier } from './octahedral-impostor-ez-tier.js';
import { OcclusionQueryTier } from './occlusion-query-tier.js';

function _perInstanceGeometry(geo) {
  const g = new THREE.BufferGeometry();
  g.attributes = geo.attributes;
  g.morphAttributes = geo.morphAttributes;
  g.morphTargetsRelative = geo.morphTargetsRelative;
  g.index = geo.index;
  g.boundingBox = geo.boundingBox;
  g.boundingSphere = geo.boundingSphere;
  if (geo.groups && geo.groups.length) g.groups = geo.groups;
  return g;
}

const _sharedDracoLoader = new DRACOLoader();

let _sharedKtx2Loader = null;
function _ensureKtx2Loader(renderer) {
  if (_sharedKtx2Loader || !renderer) return _sharedKtx2Loader;
  _sharedKtx2Loader = new KTX2Loader()
    .setTranscoderPath(new URL('./basis/', import.meta.url).href)
    .detectSupport(renderer);
  return _sharedKtx2Loader;
}

function _lodWorkerUrl() {
  const url = new URL('./lod-worker.js', import.meta.url);
  url.searchParams.set('three', import.meta.resolve('three'));
  url.searchParams.set('gltfLoader', import.meta.resolve('three/addons/loaders/GLTFLoader.js'));
  url.searchParams.set('meshoptDecoder', import.meta.resolve('three/addons/libs/meshopt_decoder.module.js'));
  url.searchParams.set('dracoLoader', new URL('./draco-loader.js', import.meta.url).href);
  return url;
}

export function ensureSharedKtx2Loader(renderer) {
  return _ensureKtx2Loader(renderer);
}

const _LOD_KEY_STRIDE = 1024;
const DEFAULT_FAR_TRI_CAP = 400;
const TIER_EXIT_HYSTERESIS_PX = 2;
const UA_MOBILE_VRAM_MB = 512;
const UA_DESKTOP_VRAM_MB = 2048;
const FALLBACK_VRAM_MB = 1024;
const CAMERA_ROTATION_HALF_DEGREE_DOT_EPSILON = 0.0005;
const HERO_ENTITY_COST_MS = 0.15;
const MID_ENTITY_COST_MS = 0.08;
const VRAM_CRITICAL_COOLDOWN_FRAMES = 120;
const BUDGET_ADJUST_COOLDOWN_FRAMES = 60;

const _tmpV3 = new THREE.Vector3();
const _tmpV3b = new THREE.Vector3();
const _tmpSphere = new THREE.Sphere();
const _identityMatrix = new THREE.Matrix4();

const CLUSTER_BUILD_INITIAL_CHUNK = 24;
const CLUSTER_BUILD_PER_FRAME = 12;
const CLUSTER_BUILD_MAX_PER_FRAME = 48;

function _maxAbsScale(scale) {
  return Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
}

function _makeLoader(includeVrm) {
  const l = new GLTFLoader();
  l.setMeshoptDecoder(MeshoptDecoder);
  l.setDRACOLoader(_sharedDracoLoader);
  if (_sharedKtx2Loader) l.setKTX2Loader(_sharedKtx2Loader);
  if (includeVrm) l.register((parser) => new VRMLoaderPlugin(parser));
  return l;
}

const _MAX_VRM_PARSE_CONCURRENT = 4;
let _vrmParseActive = 0;
const _vrmParseQueue = [];
function _acquireVrmParseSlot() {
  if (_vrmParseActive < _MAX_VRM_PARSE_CONCURRENT) { _vrmParseActive++; return Promise.resolve(); }
  return new Promise((r) => _vrmParseQueue.push(r));
}
function _releaseVrmParseSlot() {
  _vrmParseActive--;
  const next = _vrmParseQueue.shift();
  if (next) { _vrmParseActive++; next(); }
}
function _optimizeVrmScene(scene, assetUrl) {
  for (const [name, optimize] of [['removeUnnecessaryVertices', VRMUtils.removeUnnecessaryVertices], ['combineSkeletons', VRMUtils.combineSkeletons]]) {
    try {
      optimize(scene);
    } catch (err) {
      console.warn(`[asset] ${assetUrl}: VRMUtils.${name} failed (${(err && err.message) || err}); keeping the unoptimized VRM scene`);
    }
  }
}

async function _parseOwnVrm(rootBytes, assetUrl) {
  await _acquireVrmParseSlot();
  try {
    const loader = _makeLoader(true);
    const gltf = await new Promise((resolve, reject) => {
      loader.parse(rootBytes.buffer.slice(rootBytes.byteOffset, rootBytes.byteOffset + rootBytes.byteLength), '', resolve, reject);
    });
    const vrm = gltf.userData?.vrm || null;
    if (vrm) _optimizeVrmScene(vrm.scene, assetUrl);
    return { vrm, scene: vrm ? vrm.scene : gltf.scene };
  } finally {
    _releaseVrmParseSlot();
  }
}

class Asset {
  constructor(pool, url) {
    this.pool = pool;
    this.url = url;
    this.state = 'pending';
    this.error = null;
    this.baseDir = url.endsWith('/') ? url : url.replace(/[^/]+$/, '');
    this.meshLodDescs = [];
    this.texLodDescs = [];
    this.geoCache = new Map();
    this.texCache = new Map();
    this.rootGltf = null;
    this.rootBytes = null;
    this.hasVRM = false;
    this.byteWeights = new Map();
    this._rootLoader = _makeLoader(true);
    this._lodLoader = _makeLoader(false);
    this.ready = this._load();
  }

  async _fetchBytes(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const lacksGlbMagic = buf.byteLength < 4 || (buf[0] !== 0x67 || buf[1] !== 0x6c || buf[2] !== 0x54 || buf[3] !== 0x46);
    if (lacksGlbMagic) {
      throw new Error(`fetch ${url}: response is not a valid GLB (bad magic; got ${buf.byteLength} byte(s), possibly an HTML error page or truncated download)`);
    }
    this.pool._trackBytes(this.url, url, buf.byteLength);
    return buf;
  }

  async _loadCoarseClusterIndices(parser, primitiveKey, info) {
    if (!(info.coarseAccessorIndex >= 0)) return { coarse: null, extras: info.extras };
    try {
      const accessor = await parser.getDependency('accessor', info.coarseAccessorIndex);
      return { coarse: accessor.array, extras: info.extras };
    } catch (err) {
      const reason = String((err && err.message) || err);
      console.error(`[asset] ${this.url}: coarse cluster-LOD index accessor ${info.coarseAccessorIndex} (primitive ${primitiveKey}) failed to load (${reason}); rendering LOD0 only`);
      this.clusterLodFallbacks.push({ primitive: primitiveKey, coarseAccessorIndex: info.coarseAccessorIndex, reason });
      return { coarse: null, extras: lod0OnlyClusterLodExtras(info.extras) };
    }
  }

  async _load() {
    this.state = 'loading';
    try {
      const rootBytes = await this._fetchBytes(this.url);
      const gltf = await new Promise((resolve, reject) => {
        this._rootLoader.parse(rootBytes.buffer, '', resolve, reject);
      });
      this.rootGltf = gltf;
      this.hasVRM = !!gltf.userData?.vrm;
      this._lowTierMaterialStats = applyLowTierMaterials(gltf.scene, this.pool._deviceInfo);
      this.rootBytes = this.hasVRM ? rootBytes : null;
      const json = gltf.parser.json;
      const ext = json?.extensions?.EP_progressive_lod ?? json?.extras?.LOCAL_progressive;
      if (ext) {
        const kindRank = { unskinned: 0, vertcolor: 1, textured: 2 };
        for (const m of ext.meshes) {
          const sorted = [...m.lods].sort((a, b) => {
            const ra = kindRank[a.kind || 'textured'] ?? 2;
            const rb = kindRank[b.kind || 'textured'] ?? 2;
            if (ra !== rb) return ra - rb;
            return (a.ratio || 0) - (b.ratio || 0);
          });
          this.meshLodDescs.push({ meshIndex: m.meshIndex, primIndex: m.primIndex, lods: sorted });
        }
        for (const t of ext.textures || []) {
          const sortedT = [...t.lods].sort((a, b) => a.width - b.width);
          this.texLodDescs.push({ textureIndex: t.textureIndex, name: t.name, lods: sortedT });
        }
      }

      this.clusterLod = null;
      const clusterLodByPrimitive = new Map();
      json.meshes?.forEach((m, meshIdx) => {
        m.primitives?.forEach((prim, primIdx) => {
          const ex = prim.extras && prim.extras[CLUSTER_LOD_EXTRA_KEY];
          if (ex) clusterLodByPrimitive.set(`${meshIdx}:${primIdx}`, { extras: prim.extras, coarseAccessorIndex: ex.coarseIndexAccessor });
        });
      });
      if (clusterLodByPrimitive.size) this.clusterLod = clusterLodByPrimitive;

      this.clusterMeshes = null;
      this.clusterLodFallbacks = [];
      this.clusterMergeStats = null;
      if (this.clusterLod) {
        this.clusterMeshes = [];
        const meshMatrices = [];
        const meshes = [];
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((c) => { if (c.isMesh) meshes.push(c); });
        const assoc = gltf.parser.associations;
        for (const m of meshes) {
          const a = assoc?.get(m);
          if (!a || a.meshes === undefined) continue;
          const key = `${a.meshes}:${a.primitives ?? 0}`;
          const info = this.clusterLod.get(key);
          if (!info) continue;
          const { coarse, extras } = await this._loadCoarseClusterIndices(gltf.parser, key, info);
          let attached;
          try {
            attached = attachClusterLod(m.geometry, extras, coarse, m.matrixWorld.elements);
          } catch (err) {
            throw new Error(`${this.url}: cluster-LOD attach failed for primitive ${key} (coarse accessor ${info.coarseAccessorIndex}): ${(err && err.message) || err}`, { cause: err });
          }
          if (attached) {
            this.clusterMeshes.push({ geometry: m.geometry, material: m.material, clusterSet: attached.clusterSet, lod0Count: attached.lod0Count, materialBucket: attached.clusterSet.materialBucket || null });
            meshMatrices.push(m.matrixWorld.clone());
          }
        }

        if (this.pool?._textureArrayAtlas && this.clusterMeshes.length > 1) {
          const byShape = new Map();
          const materialsSeen = new Set();
          for (const cm of this.clusterMeshes) {
            const mat = cm.material;
            if (!mat || materialsSeen.has(mat)) continue;
            materialsSeen.add(mat);
            if (!isArrayAtlasCandidate(mat)) continue;
            const key = 'basecolor';
            if (!byShape.has(key)) byShape.set(key, []);
            byShape.get(key).push({ material: mat, texture: mat.map });
          }
          for (const entries of byShape.values()) {
            const built = buildTextureArray(entries);
            if (!built) continue;
            const seedMaterial = entries[0].material;
            const arrayMaterial = (this.pool?.renderer && this.pool.renderer.isWebGPURenderer)
              ? buildArrayMaterialTSL(built.arrayTexture, seedMaterial, { tintCompose: this.pool._tintCompose })
              : buildArrayMaterial(built.arrayTexture, seedMaterial);
            for (const cm of this.clusterMeshes) {
              const layerIdx = built.layerOf.get(cm.material);
              if (layerIdx == null) continue;
              tagGeometryLayer(cm.geometry, layerIdx);
              cm.material = arrayMaterial;
            }
          }
        }

        if (this.pool?._mergeStaticMaterials !== false && this.clusterMeshes.length > 1) {
          const beforeCount = this.clusterMeshes.length;
          const merged = mergeClusterMeshesByMaterial(this.clusterMeshes, meshMatrices);
          this.clusterMeshes = merged;
          this.clusterMergeStats = {
            beforeCount,
            afterCount: merged.length,
            mergedGroups: merged.filter((m) => (m._sourceIndices || []).length > 1).length,
          };
        }
      }
      let meshIdx = 0;
      gltf.scene.traverse((c) => {
        if (c.isMesh) {
          const desc = this.meshLodDescs[meshIdx];
          if (desc) {
            const inlineLodIdx = desc.lods.findIndex((l) => l.inline);
            if (inlineLodIdx >= 0) {
              this.geoCache.set(`${desc.meshIndex}:${desc.primIndex}:${inlineLodIdx}`, c.geometry);
            }
          }
          meshIdx++;
        }
      });
      gltf.scene.traverse((c) => {
        if (!c.isMesh || !c.material) return;
        const slots = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];
        for (const s of slots) {
          const tex = c.material[s];
          if (!tex || !tex.image) continue;
          const desc = this.texLodDescs.find((d) => d.name === tex.name);
          if (desc) {
            const inlineIdx = desc.lods.findIndex((l) => l.inline);
            if (inlineIdx >= 0) {
              this.texCache.set(`${desc.textureIndex}:${inlineIdx}`, tex.image);
            }
          }
        }
      });
      this.state = 'ready';
    } catch (e) {
      this.state = 'error';
      this.error = e;
      throw e;
    }
  }

  async ensureMeshLod(meshDescIdx, lodIdx) {
    const desc = this.meshLodDescs[meshDescIdx];
    if (!desc) return null;
    const target = desc.lods[lodIdx];
    if (!target) return null;
    const key = `${desc.meshIndex}:${desc.primIndex}:${lodIdx}`;
    const cached = this.geoCache.get(key);
    if (cached) return cached;
    if (target.inline) return null;
    return this.pool._enqueue(`${this.url}#${key}`, async () => {
      const stillCached = this.geoCache.get(key);
      if (stillCached) return stillCached;
      const fullUrl = this.baseDir + target.path;
      if (this.pool._workers.length) {
        try {
          const sloppyCap = (target.kind === 'unskinned') ? (this.pool._farTriCap ?? DEFAULT_FAR_TRI_CAP) : 0;
          const payload = await this.pool._workerFetchLod(fullUrl, target.decodeAABB, sloppyCap);
          this.pool._trackBytes(this.url, fullUrl, payload.bytes);
          let geo = ModelPool._buildGeometryFromPayload(payload);
          if (target.kind === 'unskinned') applyGridDecimate(geo, this.pool._farTriCap ?? DEFAULT_FAR_TRI_CAP, THREE.BufferAttribute);
          this.geoCache.set(key, geo);
          this.byteWeights.set(key, payload.bytes);
          return geo;
        } catch (e) {
          console.warn('[asset] worker decode failed, fallback main thread', e);
        }
      }
      try {
        const bytes = await this._fetchBytes(fullUrl);
        const gltf = await new Promise((resolve, reject) => {
          this._lodLoader.parse(bytes.buffer, '', resolve, reject);
        });
        let srcMesh = null;
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((c) => { if (c.isMesh && !srcMesh) srcMesh = c; });
        let geo = srcMesh?.geometry;
        if (geo) {
          _bakeQuantizeDecode(geo, srcMesh.matrixWorld, target.decodeAABB);
          if (target.kind === 'unskinned') applyGridDecimate(geo, this.pool._farTriCap ?? DEFAULT_FAR_TRI_CAP, THREE.BufferAttribute);
          this.geoCache.set(key, geo);
          this.byteWeights.set(key, bytes.byteLength);
        }
        return geo;
      } catch (e) {
        console.warn(`[asset] LOD mesh ${key} failed to load (${e.message}), using previous LOD`);
        if (lodIdx > 0) {
          return await this.ensureMeshLod(meshDescIdx, lodIdx - 1);
        }
        return null;
      }
    });
  }

  async ensureTexLod(texDescIdx, lodIdx) {
    const desc = this.texLodDescs[texDescIdx];
    if (!desc) return null;
    const target = desc.lods[lodIdx];
    if (!target) return null;
    const key = `${desc.textureIndex}:${lodIdx}`;
    const cached = this.texCache.get(key);
    if (cached) return cached;
    if (target.inline) return null;
    return this.pool._enqueue(`${this.url}#tex:${key}`, async () => {
      const stillCached = this.texCache.get(key);
      if (stillCached) return stillCached;
      const bytes = await this._fetchBytes(this.baseDir + target.path);
      const blob = new Blob([bytes], { type: target.mime || 'image/webp' });
      const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
      this.texCache.set(key, bmp);
      this.byteWeights.set(`tex:${key}`, bytes.byteLength);
      return bmp;
    });
  }

  evictMeshLod(meshDescIdx, lodIdx) {
    const desc = this.meshLodDescs[meshDescIdx];
    if (!desc) return null;
    const key = `${desc.meshIndex}:${desc.primIndex}:${lodIdx}`;
    const target = desc.lods[lodIdx];
    if (!target || target.inline) return null;
    const geo = this.geoCache.get(key);
    if (!geo) return null;
    geo.dispose();
    this.geoCache.delete(key);
    this.byteWeights.delete(key);
    return this.pool._untrackBytes(this.url, this.baseDir + target.path);
  }
  evictTexLod(texDescIdx, lodIdx) {
    const desc = this.texLodDescs[texDescIdx];
    if (!desc) return null;
    const key = `${desc.textureIndex}:${lodIdx}`;
    const target = desc.lods[lodIdx];
    if (!target || target.inline) return null;
    const bmp = this.texCache.get(key);
    if (!bmp) return null;
    if (bmp.close) bmp.close();
    this.texCache.delete(key);
    this.byteWeights.delete(`tex:${key}`);
    return this.pool._untrackBytes(this.url, this.baseDir + target.path);
  }

  dispose() {
    const vrm = this.rootGltf?.userData?.vrm;
    if (vrm) VRMUtils.deepDispose(this.rootGltf.scene);
    for (const geo of this.geoCache.values()) geo?.dispose?.();
    for (const bmp of this.texCache.values()) bmp?.close?.();
    this.geoCache.clear();
    this.texCache.clear();
    this.byteWeights.clear();
    this.rootBytes = null;
    this.rootGltf = null;
    this.state = 'disposed';
  }
}

function _bakeQuantizeDecode(geo, matrix, decodeAABB) {
  const m = matrix;
  const isIdentity = !decodeAABB && (
    m.elements[0] === 1 && m.elements[5] === 1 && m.elements[10] === 1 &&
    m.elements[12] === 0 && m.elements[13] === 0 && m.elements[14] === 0 &&
    m.elements[1] === 0 && m.elements[2] === 0 && m.elements[4] === 0 &&
    m.elements[6] === 0 && m.elements[8] === 0 && m.elements[9] === 0
  );
  if (!decodeAABB && !isIdentity) {
    for (const semKey of ['position', 'normal', 'tangent']) {
      const a = geo.attributes[semKey];
      if (!a) continue;
      const out = new Float32Array(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) {
        if (a.itemSize >= 1) out[i * a.itemSize + 0] = a.getX(i);
        if (a.itemSize >= 2) out[i * a.itemSize + 1] = a.getY(i);
        if (a.itemSize >= 3) out[i * a.itemSize + 2] = a.getZ(i);
        if (a.itemSize >= 4) out[i * a.itemSize + 3] = a.getW(i);
      }
      geo.setAttribute(semKey, new THREE.BufferAttribute(out, a.itemSize, false));
    }
    geo.applyMatrix4(m);
  } else if (decodeAABB) {
    const { min, max } = decodeAABB;
    const pos = geo.attributes.position;
    if (pos) {
      let smnX = Infinity, smxX = -Infinity;
      let smnY = Infinity, smxY = -Infinity;
      let smnZ = Infinity, smxZ = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (x < smnX) smnX = x; if (x > smxX) smxX = x;
        if (y < smnY) smnY = y; if (y > smxY) smxY = y;
        if (z < smnZ) smnZ = z; if (z > smxZ) smxZ = z;
      }
      const r = (a, b) => (b - a < 1e-9 ? 1 : b - a);
      const sx = (max[0] - min[0]) / r(smnX, smxX);
      const sy = (max[1] - min[1]) / r(smnY, smxY);
      const sz = (max[2] - min[2]) / r(smnZ, smxZ);
      const out = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        out[i * 3 + 0] = (pos.getX(i) - smnX) * sx + min[0];
        out[i * 3 + 1] = (pos.getY(i) - smnY) * sy + min[1];
        out[i * 3 + 2] = (pos.getZ(i) - smnZ) * sz + min[2];
      }
      geo.setAttribute('position', new THREE.BufferAttribute(out, 3, false));
      for (const semKey of ['normal', 'tangent']) {
        const a = geo.attributes[semKey];
        if (!a) continue;
        const o = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < a.count; i++) {
          if (a.itemSize >= 1) o[i * a.itemSize + 0] = a.getX(i);
          if (a.itemSize >= 2) o[i * a.itemSize + 1] = a.getY(i);
          if (a.itemSize >= 3) o[i * a.itemSize + 2] = a.getZ(i);
          if (a.itemSize >= 4) o[i * a.itemSize + 3] = a.getW(i);
        }
        geo.setAttribute(semKey, new THREE.BufferAttribute(o, a.itemSize, false));
      }
    }
  }
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
}

class Entity extends Emitter {
  constructor(pool, asset, opts) {
    super();
    this.pool = pool;
    this.asset = asset;
    this.id = ++pool._nextEntityId;
    this.opts = opts || {};
    this.root = new THREE.Object3D();
    this.root.name = `entity_${this.id}_${asset.url.split('/').pop()}`;
    if (opts.position) this.root.position.fromArray(opts.position);
    if (opts.rotation) this.root.quaternion.setFromEuler(new THREE.Euler().fromArray(opts.rotation));
    if (opts.scale) this.root.scale.setScalar(opts.scale);
    if (opts.static) {
      this.root.updateMatrix();
      this.root.matrixAutoUpdate = false;
      this.root.matrixWorldNeedsUpdate = true;
    }
    this.trackedMeshes = [];
    this.animationMixer = null;
    this.animationClips = [];
    this.animationAction = null;
    this.vrm = null;
    this._lastInFrustum = true;
    this._cachedFrustumVisible = true;
    this._frustumCheckInterval = 0;
    this._firstFrustumTest = true;
    this._lastScreenPx = null;
    this._allInstanced = false;
    this._disposed = false;
    this._sceneParent = null;
    this._detached = false;
    this.ready = this._bootstrap();
  }

  async _bootstrap() {
    try {
      await this.asset.ready;
      if (this._disposed) return;
      let cloned;
      if (this.asset.hasVRM && this.asset.rootBytes) {
        const own = await _parseOwnVrm(this.asset.rootBytes, this.asset.url);
        if (this._disposed) { VRMUtils.deepDispose(own.scene); return; }
        this.vrm = own.vrm;
        cloned = own.scene;
      } else {
        cloned = _cloneSkinned(this.asset.rootGltf.scene);
        this.vrm = null;
      }
      this.root.add(cloned);
      this.root.updateMatrixWorld(true);
      const _rootInv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
      if (this.asset.clusterMeshes && this.asset.clusterMeshes.length) {
        const meshOrderC = [];
        cloned.traverse((c) => { if (c.isMesh) meshOrderC.push(c); });
        this.clusterMeshes = [];
        const total = this.asset.clusterMeshes.length;
        const initialChunk = Math.min(total, CLUSTER_BUILD_INITIAL_CHUNK);
        this._buildClusterMeshRange(meshOrderC, _rootInv, 0, initialChunk);
        if (initialChunk < total) {
          this.pool._queueClusterBuild(this, meshOrderC, _rootInv, initialChunk, total);
        }
        this.emit('ready', this);
        return;
      }

      const meshOrder = [];
      cloned.traverse((c) => { if (c.isMesh) meshOrder.push(c); });
      for (let i = 0; i < this.asset.meshLodDescs.length; i++) {
        const desc = this.asset.meshLodDescs[i];
        const mesh = meshOrder[i] || meshOrder[0];
        if (!mesh) continue;
        const inlineLodIdx = desc.lods.findIndex((l) => l.inline);
        mesh.updateWorldMatrix(true, false);
        const relToRoot = new THREE.Matrix4().multiplyMatrices(_rootInv, mesh.matrixWorld);
        const isRelIdentity = relToRoot.equals(_identityMatrix);
        this.trackedMeshes.push({
          meshDescIdx: i,
          currentLod: inlineLodIdx >= 0 ? inlineLodIdx : 0,
          mesh,
          _meshLocalToRoot: isRelIdentity ? null : relToRoot,
          baseIsSkinnedMesh: !!mesh.isSkinnedMesh,
          baseMaterial: mesh.material,
          baseSkeleton: mesh.skeleton || null,
          parent: mesh.parent,
          texState: this.asset.texLodDescs.map(() => ({ currentLod: 0 })),
          _texDescIdxs: _meshTexDescIdxs(mesh.material, this.asset.texLodDescs),
          vcMaterial: null,
          _instancedSlot: null,
          _instancedSlotIdx: -1,
          _instancedBoundRadius: null,
          _matrixNeedsUpdate: false,
          _precomputedTexLods: null,
          _wantKey: '',
          _wantKeyIdx: -1,
          _allTexIdxs: null,
        });
      }
      const animations = this.asset.rootGltf.animations || [];
      if (animations.length) {
        this.animationClips = animations;
        this.animationMixer = new THREE.AnimationMixer(cloned);
        const desiredIdx = Math.min(this.opts.animationIndex ?? 0, animations.length - 1);
        this.animationAction = this.animationMixer.clipAction(animations[desiredIdx]);
        this.animationAction.setLoop(THREE.LoopRepeat).play();
      }
      this.emit('ready', this);
    } catch (e) {
      this.emit('error', e);
    }
  }

  _buildClusterMeshRange(meshOrderC, _rootInv, start, end) {
    const clusterMeshes = this.asset.clusterMeshes;
    for (let i = start; i < end; i++) {
      const cm = clusterMeshes[i];
      const srcIndices = cm._sourceIndices || [i];
      const isMerged = srcIndices.length > 1;
      const consumedNodes = srcIndices.map((si) => meshOrderC[si]).filter(Boolean);
      const src = consumedNodes[0] || meshOrderC[0];
      if (!src) continue;
      const clmGeometry = new THREE.BufferGeometry();
      clmGeometry.attributes = cm.geometry.attributes;
      clmGeometry.morphAttributes = cm.geometry.morphAttributes;
      clmGeometry.index = cm.geometry.index;
      clmGeometry.boundingBox = cm.geometry.boundingBox;
      clmGeometry.boundingSphere = cm.geometry.boundingSphere;
      const clm = new ClusterLodMesh(clmGeometry, cm.material, cm.clusterSet, {
        lod0Count: cm.lod0Count,
      });
      clm.castShadow = true;
      clm.receiveShadow = true;
      clm.materialBucket = cm.materialBucket || null;
      if (isMerged) {
      } else {
        src.updateWorldMatrix(true, false);
        clm.applyMatrix4(new THREE.Matrix4().multiplyMatrices(_rootInv, src.matrixWorld));
      }
      this.root.add(clm);
      for (const node of consumedNodes) node.removeFromParent();
      clmGeometry.setDrawRange(0, Infinity);
      this.clusterMeshes.push(clm);
    }
  }

  _slotWorldMatrix(tm) {
    const rel = tm._meshLocalToRoot;
    if (!rel) return this.root.matrixWorld;
    if (!this._slotMtx) this._slotMtx = new THREE.Matrix4();
    return this._slotMtx.multiplyMatrices(this.root.matrixWorld, rel);
  }

  async _applyLod(tm, wantIdx, screenPx = 0) {
    if (this._disposed) return;
    if (wantIdx === tm.currentLod) return;
    const desc = this.asset.meshLodDescs[tm.meshDescIdx];
    if (!desc) return;
    const target = desc.lods[wantIdx];
    if (!target) return;
    let geo;
    if (target.inline) {
      geo = this.asset.geoCache.get(`${desc.meshIndex}:${desc.primIndex}:${wantIdx}`);
    } else {
      const cachedGeo = this.asset.geoCache.get(`${desc.meshIndex}:${desc.primIndex}:${wantIdx}`);
      if (cachedGeo) {
        geo = cachedGeo;
      } else {
        tm._lodWantIdx = wantIdx;
        this.pool._enqueueLodWarm(this.asset, tm.meshDescIdx, wantIdx, this._currentDistance);
        const droppingToCheaper = wantIdx < tm.currentLod;
        const haveRenderable = tm.mesh && tm.mesh.geometry && tm.mesh.geometry.attributes.position;
        if (droppingToCheaper || !haveRenderable) {
          geo = await this.asset.ensureMeshLod(tm.meshDescIdx, wantIdx);
          if (this._disposed || !geo) return;
          tm._lodWantIdx = -1;
        } else {
          return;
        }
      }
    }
    if (this._disposed || !geo) return;
    if (wantIdx === tm.currentLod) return;
    const kind = target.kind || 'textured';
    const wantSkinned = kind !== 'unskinned' && tm.baseIsSkinnedMesh;
    const haveSkinned = !!tm.mesh.isSkinnedMesh;

    const wantInstanced = kind === 'unskinned';
    const haveInstanced = tm._instancedSlot != null;
    if (wantInstanced) {
      const slot = this.pool._getInstancedSlot(this.asset, tm.meshDescIdx, wantIdx);
      if (slot) {
        tm.mesh.visible = false;
        if (haveInstanced && (tm._instancedSlot !== slot)) {
          tm._instancedSlot.releaseSlot(this);
        }
        if (!haveInstanced || tm._instancedSlot !== slot) {
          tm._instancedSlot = slot;
          tm._instancedSlotIdx = slot.acquireSlot(this);
          tm._matrixNeedsUpdate = true;
        }
        {
          this.root.updateMatrixWorld(true);
          const worldMat = this._slotWorldMatrix(tm);
          slot.setMatrixForSlot(tm._instancedSlotIdx, worldMat);
          tm._matrixNeedsUpdate = false;
          const sphere = geo.boundingSphere;
          if (sphere) {
            const scale = _maxAbsScale(this.root.scale);
            tm._instancedBoundRadius = sphere.radius;
            slot.setBoundSphereForSlot(tm._instancedSlotIdx, sphere.radius * scale);
          }
        }
        tm.currentLod = wantIdx;
        tm._precomputedTexLods = _precomputeAllTexLods(this.asset, screenPx);
        this.emit('lod-changed', { entity: this, meshDescIdx: tm.meshDescIdx, lod: wantIdx, kind, instanced: true });
        return;
      }
    } else if (haveInstanced) {
      tm._instancedSlot.releaseSlot(this);
      tm._instancedSlot = null;
      tm._instancedSlotIdx = -1;
      tm.mesh.visible = true;
    }
    let mat;
    if (kind === 'textured') {
      mat = tm.baseMaterial;
    } else {
      if (!tm.vcMaterial) {
        const m = new THREE.MeshLambertMaterial({ vertexColors: true });
        m.onBeforeCompile = (shader) => {
          shader.vertexShader = shader.vertexShader.replace(
            '#include <color_vertex>',
            `#include <color_vertex>
            #if defined( USE_COLOR_ALPHA )
              vColor.rgb = pow(vColor.rgb, vec3(2.2));
            #elif defined( USE_COLOR )
              vColor = pow(vColor, vec3(2.2));
            #endif`
          );
        };
        tm.vcMaterial = m;
      }
      mat = tm.vcMaterial;
    }
    if (wantSkinned === haveSkinned) {
      tm.mesh.geometry = _perInstanceGeometry(geo);
      tm.mesh.material = mat;
    } else {
      const parent = tm.mesh.parent || tm.parent;
      let next;
      const _geo = _perInstanceGeometry(geo);
      if (wantSkinned) {
        next = new THREE.SkinnedMesh(_geo, mat);
        if (tm.baseSkeleton) next.bind(tm.baseSkeleton);
      } else {
        next = new THREE.Mesh(_geo, mat);
      }
      next.frustumCulled = false;
      next.position.copy(tm.mesh.position);
      next.quaternion.copy(tm.mesh.quaternion);
      next.scale.copy(tm.mesh.scale);
      next.name = tm.mesh.name;
      if (parent) {
        parent.remove(tm.mesh);
        parent.add(next);
      }
      tm.mesh = next;
    }
    tm.currentLod = wantIdx;
    tm._precomputedTexLods = _precomputeAllTexLods(this.asset, screenPx);
    this.emit('lod-changed', { entity: this, meshDescIdx: tm.meshDescIdx, lod: wantIdx, kind });
  }

  async _applyTexLod(tm, tdIdx, wantIdx) {
    if (this._disposed) return;
    const tState = tm.texState[tdIdx];
    if (!tState || wantIdx === tState.currentLod) return;
    const desc = this.asset.texLodDescs[tdIdx];
    if (!desc) return;
    let bmp;
    const target = desc.lods[wantIdx];
    if (target.inline) {
      bmp = this.asset.texCache.get(`${desc.textureIndex}:${wantIdx}`);
    } else {
      bmp = await this.asset.ensureTexLod(tdIdx, wantIdx);
    }
    if (this._disposed || !bmp) return;
    if (wantIdx === tState.currentLod) return;
    const mat = tm.mesh.material;
    if (mat === tm.baseMaterial) {
      const targets = _findMaterialSlots(mat, desc);
      const farLod = wantIdx >= 3;
      const aniso = this.pool._maxAnisotropy ??
        (this.pool._maxAnisotropy = _capAnisotropyByDeviceTier(
          Math.min(8, this.pool.renderer?.capabilities?.getMaxAnisotropy?.() ?? 1),
          this.pool.deviceInfo));
      for (const tex of targets) {
        tex.dispose();
        tex.image = bmp;
        if (farLod) {
          tex.minFilter = THREE.LinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.generateMipmaps = false;
          tex.anisotropy = 1;
        } else {
          tex.anisotropy = aniso;
        }
        tex.needsUpdate = true;
      }
    }
    tState.currentLod = wantIdx;
  }

  _maybeDetach() {
    if (this._detached || this._disposed) return;
    if (!this.trackedMeshes.length) return;
    for (const tm of this.trackedMeshes) {
      if (!tm._instancedSlot) {
        this._allInstanced = false;
        return;
      }
    }
    this._allInstanced = true;
    const parent = this.root.parent;
    if (!parent) return;
    this._sceneParent = parent;
    parent.remove(this.root);
    this._detached = true;
  }
  _maybeReattach() {
    if (!this._detached || this._disposed) return;
    let allInstanced = true;
    for (const tm of this.trackedMeshes) {
      if (!tm._instancedSlot) { allInstanced = false; break; }
    }
    if (allInstanced) return;
    this._allInstanced = false;
    if (this._sceneParent) {
      this._sceneParent.add(this.root);
      this.root.matrixWorldNeedsUpdate = true;
    }
    this._detached = false;
  }

  _update(camera, viewportHeight, dt, globalCeilingLod, frustum, animationThrottleDistance) {
    if (this._disposed) return { distance: Infinity, screenPx: 0, tier: 'far' };
    if (this.clusterMeshes && this.clusterMeshes.length) {
      if (this.root.matrixAutoUpdate) this.root.updateMatrixWorld();
      if (this.animationMixer) this.animationMixer.update(dt);
      if (this.pool._useImpostorFinalLod || this.pool._useMaterialBucketBatching) {
        const clm = this.clusterMeshes[0];
        const sphere = clm.geometry?.boundingSphere;
        if (sphere) {
          const world = _tmpV3.copy(sphere.center).applyMatrix4(clm.matrixWorld);
          const dist = camera.position.distanceTo(world);
          const scaleLen = _maxAbsScale(this.root.scale);
          const radius = sphere.radius * scaleLen;
          const fovTanHalf = this.pool._fovTanHalf || Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
          const halfWorld = fovTanHalf * (dist > 0.0001 ? dist : 0.0001);
          const screenPx = (radius / halfWorld) * viewportHeight;
          const movable = this.root.matrixAutoUpdate || this._boundDirty;
          const impostorHandled = this.pool._useImpostorFinalLod && this._updateImpostor(screenPx, world, radius, movable);
          if (impostorHandled) return { distance: dist, screenPx, tier: 'impostor' };
          if (this.pool._useMaterialBucketBatching) {
            const bucketHandled = this._updateMaterialBucketTier(screenPx, movable);
            if (bucketHandled) return { distance: dist, screenPx, tier: 'material-bucket' };
          }
          return { distance: dist, screenPx, tier: 'cluster' };
        }
      }
      return { distance: 0, screenPx: 9999, tier: 'cluster' };
    }
    let primaryMesh = this.trackedMeshes[0]?.mesh;
    if (!primaryMesh) return { distance: Infinity, screenPx: 0, tier: 'far' };
    const _movable = this.root.matrixAutoUpdate || this._boundDirty;
    if (!_movable && !this.pool._cameraMoved && this._allInstanced && this._lastUpdateResult
        && this._lastCeilingLod === globalCeilingLod) {
      return this._lastUpdateResult;
    }
    if (!this._sceneParent && this.root.parent) this._sceneParent = this.root.parent;
    if (this.root.matrixWorldNeedsUpdate || this.root.matrixAutoUpdate) {
      this.root.updateMatrixWorld(true);
    }
    const sphere = primaryMesh.geometry?.boundingSphere;
    if (!sphere) return { distance: Infinity, screenPx: 0, tier: 'far' };
    const world = _tmpV3.setFromMatrixPosition(primaryMesh.matrixWorld);
    const scaleLen = _maxAbsScale(this.root.scale);
    const radius = sphere.radius * scaleLen;
    const movable = this.root.matrixAutoUpdate || this._boundDirty;
    let inFrustum = this._lastInFrustum;
    if (this._allInstanced) {
      inFrustum = true;
    } else if (this.pool._enableFrustumCulling) {
      const effectiveInterval = movable ? 0 : this.pool._dynamicFrustumCheckInterval;
      if (this._firstFrustumTest || this._frustumCheckInterval <= 0 || movable) {
        _tmpSphere.set(world, radius);
        inFrustum = frustum ? frustum.intersectsSphere(_tmpSphere) : true;
        this._frustumCheckInterval = effectiveInterval;
        this._lastInFrustum = inFrustum;
        this._cachedFrustumVisible = inFrustum;
        this._firstFrustumTest = false;
      } else {
        this._frustumCheckInterval--;
      }
    } else {
      inFrustum = true;
    }
    if (this.root.visible !== inFrustum) this.root.visible = inFrustum;
    if (!inFrustum) {
      if (!movable) {
        this._cachedFrustumVisible = false;
        this._maybeReattach();
        this._maybeDetach();
        return { distance: Infinity, screenPx: 0, tier: 'far' };
      }
      for (const tm of this.trackedMeshes) {
        if (tm._instancedSlot && tm._instancedSlotIdx >= 0 && (movable || tm._matrixNeedsUpdate)) {
          tm._instancedSlot.setMatrixForSlot(tm._instancedSlotIdx, this._slotWorldMatrix(tm));
          tm._matrixNeedsUpdate = false;
        }
      }
      this._maybeReattach();
      this._maybeDetach();
      return { distance: Infinity, screenPx: 0, tier: 'far' };
    }
    const dist = camera.position.distanceTo(world);
    let screenPx = 0;
    if (this._lastScreenPx != null && !movable && !this.pool._cameraMoved) {
      screenPx = this._lastScreenPx;
    } else {
      const fovTanHalf = this.pool._fovTanHalf || Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      const halfWorld = fovTanHalf * (dist > 0.0001 ? dist : 0.0001);
      screenPx = (radius / halfWorld) * viewportHeight;
      this._lastScreenPx = screenPx;
    }
    const tinyOnScreen = screenPx < 4;
    const base = this.pool._subPixelCullPx ?? 2;
    const cullPx = this._subPixelCulled ? base + 1 : base;
    const wantSubPixelCull = screenPx > 0 && screenPx < cullPx;
    if (wantSubPixelCull !== this._subPixelCulled) {
      this._subPixelCulled = wantSubPixelCull;
      for (const tm of this.trackedMeshes) {
        if (tm._instancedSlot && tm._instancedSlotIdx >= 0) {
          tm._instancedSlot.setMatrixForSlot(tm._instancedSlotIdx, wantSubPixelCull ? _zeroMatrix : this._slotWorldMatrix(tm));
        } else if (tm.mesh) {
          tm.mesh.visible = !wantSubPixelCull;
        }
      }
    }
    let impostorHandled = false;
    if (this.pool._useImpostorFinalLod) {
      impostorHandled = (!this._subPixelCulled)
        ? this._updateImpostor(screenPx, world, radius, movable)
        : (this._impostorActive ? (this._exitImpostor(), false) : false);
    }
    if (!impostorHandled) {
      const lodEpochChanged = this._lodPickEpoch !== this.pool._lodEpoch;
      if (lodEpochChanged) this._lodPickEpoch = this.pool._lodEpoch;
      if (!tinyOnScreen && !this._subPixelCulled && lodEpochChanged) {
        for (const tm of this.trackedMeshes) {
          const desc = this.asset.meshLodDescs[tm.meshDescIdx];
          if (!desc) continue;
          const targetIdx = _pickMeshLod(desc.lods, screenPx, globalCeilingLod, this.pool._use3LodSystem, this.pool._lodDistanceScale, tm.currentLod);
          const targetLod = desc.lods[targetIdx];
          let targetResident = false;
          if (targetLod) {
            if (targetLod.inline) targetResident = true;
            else {
              if (tm._wantKeyIdx !== targetIdx) {
                tm._wantKey = `${desc.meshIndex}:${desc.primIndex}:${targetIdx}`;
                tm._wantKeyIdx = targetIdx;
              }
              targetResident = this.asset.geoCache.has(tm._wantKey);
            }
          }
          if (tm._lodWantIdx === targetIdx && !targetResident) {
          } else if (targetIdx !== tm.currentLod && !tm._lodPending) {
            if (tm._pendingLodTarget === targetIdx) {
              tm._lodConfirm = (tm._lodConfirm || 0) + 1;
            } else {
              tm._pendingLodTarget = targetIdx;
              tm._lodConfirm = 1;
            }
            const needed = this.pool._lodSwitchConfirmFrames ?? 4;
            if (tm._lodConfirm >= needed) {
              tm._lodConfirm = 0;
              tm._pendingLodTarget = -1;
              tm._lodPending = true;
              const px = screenPx;
              this._applyLod(tm, targetIdx, px).finally(() => { tm._lodPending = false; });
            }
          } else if (targetIdx === tm.currentLod) {
            tm._lodWantIdx = -1;
            tm._pendingLodTarget = -1; tm._lodConfirm = 0;
          }
          if (!tm._instancedSlot && this.pool._enableTextureLod && tm._precomputedTexLods) {
            const idxs = (tm._texDescIdxs && tm._texDescIdxs.length)
              ? tm._texDescIdxs
              : (tm._allTexIdxs || (tm._allTexIdxs = tm.texState.map((_, i) => i)));
            for (const ti of idxs) {
              const tWant = tm._precomputedTexLods[ti];
              if (tWant != null && tWant !== tm.texState[ti].currentLod) {
                this._applyTexLod(tm, ti, tWant);
              }
            }
          }
        }
      }
    }
    if (!impostorHandled) for (const tm of this.trackedMeshes) {
      if (tm._instancedSlot && tm._instancedSlotIdx >= 0) {
        let slotWM = null;
        if (!this._subPixelCulled && (movable || tm._matrixNeedsUpdate)) {
          slotWM = this._slotWorldMatrix(tm);
          tm._instancedSlot.setMatrixForSlot(tm._instancedSlotIdx, slotWM);
          tm._matrixNeedsUpdate = false;
        }
        if (!this._subPixelCulled && movable && tm._instancedBoundRadius != null) {
          const scale = _maxAbsScale(this.root.scale);
          tm._instancedSlot.setBoundSphereForSlot(
            tm._instancedSlotIdx,
            tm._instancedBoundRadius * scale,
          );
        }
      }
    }
    if (movable) {
      this._lastScreenPx = null;
    }
    this._boundDirty = false;
    this._maybeReattach();
    this._maybeDetach();
    const hasAnimConsumer = !!this.animationMixer || !!this.vrm?.update;
    const anyInstanced = hasAnimConsumer
      ? (this._allInstanced || this.trackedMeshes.some((tm) => !!tm._instancedSlot))
      : false;
    if (this.animationMixer && !anyInstanced) {
      if (this.pool._enableAnimThrottle) {
        if (dist > 40) {
        } else if (dist > 20) {
          if ((this._animTickCounter = ((this._animTickCounter || 0) + 1)) % 4 === 0) {
            this.animationMixer.update(dt * 4);
          }
        } else if (dist > 10) {
          if ((this._animTickCounter = ((this._animTickCounter || 0) + 1)) % 2 === 0) {
            this.animationMixer.update(dt * 2);
          }
        } else {
          this.animationMixer.update(dt);
        }
      } else {
        this.animationMixer.update(dt);
      }
    }
    if (this.vrm?.update && this.opts.driveVrm !== false && dist < animationThrottleDistance && !anyInstanced) this.vrm.update(dt);
    this._currentDistance = dist;
    const r = this._updateResult || (this._updateResult = { distance: 0, screenPx: 0, tier: 'unassigned' });
    r.distance = dist; r.screenPx = screenPx; r.tier = 'unassigned';
    this._lastUpdateResult = r;
    this._lastCeilingLod = globalCeilingLod;
    return r;
  }

  _updateImpostor(screenPx, world, worldRadius, movable) {
    const tier = this.pool._getImpostorTier();
    if (!tier) return false;
    const onPx = this.pool._impostorPx ?? 14;
    const fadeMode = this.pool._impostorFade === true;
    const fadeBand = fadeMode ? Math.max(0.001, this.pool._impostorFadeBandPx || 6) : 0;
    const acquirePx = fadeMode ? (onPx + fadeBand) : onPx;
    const enterPx = this._impostorActive ? acquirePx + TIER_EXIT_HYSTERESIS_PX : acquirePx;
    if (!(screenPx > 0 && screenPx < enterPx)) {
      if (this._impostorActive) this._exitImpostor();
      return false;
    }
    const desc = this.pool._impostorTier && this.pool._impostorTier.hasAsset(this.asset)
      ? this.pool._impostorTier._assetLayers.get(this.asset.url)
      : null;
    if (!desc) {
      if (this._impostorActive) this._exitImpostor();
      this.pool._queueImpostorBake(this.asset, this);
      return false;
    }
    if (!this._impostorActive) {
      const wc = _tmpV3b.copy(desc.center).applyMatrix4(this.root.matrixWorld);
      const s = _maxAbsScale(this.root.scale);
      const wr = desc.radius * s;
      if (!fadeMode) this._setTrackedDrawsHidden(true);
      this._impostorActive = true;
      this._impostorFullyFaded = false;
      this.pool._impostorActiveCount++;
      this._impostorId = tier.acquire(this, desc.layer, wc.x, wc.y, wc.z, wr);
    } else if (movable) {
      const wc = _tmpV3b.copy(desc.center).applyMatrix4(this.root.matrixWorld);
      const s = _maxAbsScale(this.root.scale);
      const wr = desc.radius * s;
      tier.setCenter(this._impostorId, wc.x, wc.y, wc.z, wr);
    }
    if (this._impostorId < 0) return false;
    if (!fadeMode) return true;
    const t = 1 - Math.min(1, Math.max(0, (screenPx - onPx) / fadeBand));
    if (typeof tier.setFade === 'function') tier.setFade(this._impostorId, t);
    if (t >= 1) {
      if (!this._impostorFullyFaded) {
        this._impostorFullyFaded = true;
        this._setTrackedDrawsHidden(true);
      }
      return true;
    }
    if (this._impostorFullyFaded) {
      this._impostorFullyFaded = false;
      this._setTrackedDrawsHidden(false);
    }
    return false;
  }

  _exitImpostor() {
    if (!this._impostorActive) return;
    if (this.pool._impostorTier) this.pool._impostorTier.release(this);
    this._impostorActive = false;
    this._impostorFullyFaded = false;
    this._impostorId = -1;
    this.pool._impostorActiveCount = Math.max(0, this.pool._impostorActiveCount - 1);
    this._setTrackedDrawsHidden(false);
  }

  _updateMaterialBucketTier(screenPx, movable) {
    const batcher = this.pool._getMaterialBucketBatcher();
    if (!batcher) return false;
    const bucket = this.clusterMeshes[0]?.materialBucket;
    if (!bucket) return false;
    for (let i = 1; i < this.clusterMeshes.length; i++) {
      if (this.clusterMeshes[i].materialBucket !== bucket) return false;
    }
    const onPx = this.pool._materialBucketPx;
    const enterPx = this._bucketActive ? onPx + TIER_EXIT_HYSTERESIS_PX : onPx;
    if (!(screenPx > 0 && screenPx < enterPx)) {
      if (this._bucketActive) this._exitMaterialBucket();
      return false;
    }
    if (!this._bucketActive) {
      this._setTrackedDrawsHidden(true);
      const cm = this.clusterMeshes[0];
      const sourceKey = `${this.asset.url}|0`;
      const id = batcher.acquire(this, bucket, sourceKey, cm, cm.material);
      if (id < 0) { this._setTrackedDrawsHidden(false); return false; }
      this._bucketActive = true;
      batcher.setMatrix(this, this.root.matrixWorld);
    } else if (movable) {
      batcher.setMatrix(this, this.root.matrixWorld);
    }
    return this._bucketActive;
  }

  _exitMaterialBucket() {
    if (!this._bucketActive) return;
    if (this.pool._materialBucketBatcher) this.pool._materialBucketBatcher.release(this);
    this._bucketActive = false;
    this._setTrackedDrawsHidden(false);
  }

  _setTrackedDrawsHidden(hidden) {
    const cull = hidden || this._subPixelCulled;
    for (const tm of this.trackedMeshes) {
      if (tm._instancedSlot && tm._instancedSlotIdx >= 0) {
        tm._instancedSlot.setMatrixForSlot(tm._instancedSlotIdx, cull ? _zeroMatrix : this._slotWorldMatrix(tm));
      } else if (tm.mesh) {
        tm.mesh.visible = !cull;
      }
    }
    if (this.clusterMeshes) {
      for (const clm of this.clusterMeshes) clm.visible = !cull;
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._impostorActive && this.pool._impostorTier) this.pool._impostorTier.release(this);
    if (this._bucketActive && this.pool._materialBucketBatcher) this.pool._materialBucketBatcher.release(this);
    this.root.parent?.remove(this.root);
    this._sceneParent = null;
    this._detached = false;
    if (this.animationAction) this.animationAction.stop();
    this.animationMixer = null;
    this.animationAction = null;
    if (this.vrm) VRMUtils.deepDispose(this.vrm.scene);
    this.vrm = null;
    for (const tm of this.trackedMeshes) {
      if (tm._instancedSlot) tm._instancedSlot.releaseSlot(this);
      if (tm.vcMaterial) tm.vcMaterial.dispose();
    }
    this.trackedMeshes = [];
    if (this.pool._occlusionTier) this.pool._occlusionTier.release(this);
    this.pool._entities.delete(this);
    this.emit('disposed', this);
  }
}

function _cloneSkinned(source) {
  const sourceToClone = new Map();
  const cloneRoot = _cloneObject3D(source, sourceToClone);
  cloneRoot.traverse((cm) => {
    if (!cm.isSkinnedMesh) return;
    let sourceSm = null;
    for (const [s, c] of sourceToClone) {
      if (c === cm) { sourceSm = s; break; }
    }
    if (!sourceSm) return;
    const srcSkel = sourceSm.skeleton;
    if (!srcSkel) return;
    const newBones = srcSkel.bones.map((b) => sourceToClone.get(b) || b);
    const newSkel = new THREE.Skeleton(newBones, srcSkel.boneInverses);
    cm.bind(newSkel, cm.bindMatrix);
  });
  return cloneRoot;
}

function _cloneObject3D(src, sourceToClone) {
  let copy;
  if (src.isSkinnedMesh) {
    copy = new THREE.SkinnedMesh(_perInstanceGeometry(src.geometry), src.material);
    copy.bindMode = src.bindMode;
    copy.bindMatrix.copy(src.bindMatrix);
    copy.bindMatrixInverse.copy(src.bindMatrixInverse);
  } else if (src.isMesh) {
    copy = new THREE.Mesh(_perInstanceGeometry(src.geometry), src.material);
  } else if (src.isBone) {
    copy = new THREE.Bone();
  } else {
    copy = new THREE.Object3D();
  }
  copy.name = src.name;
  copy.position.copy(src.position);
  copy.quaternion.copy(src.quaternion);
  copy.scale.copy(src.scale);
  copy.matrixAutoUpdate = src.matrixAutoUpdate;
  copy.visible = src.visible;
  copy.frustumCulled = src.frustumCulled;
  sourceToClone.set(src, copy);
  for (const child of src.children) {
    copy.add(_cloneObject3D(child, sourceToClone));
  }
  return copy;
}

const _LOD_THRESHOLDS_3 = [50, 25, 10];
const _LOD_INDICES_3 = [0, 2, 4];
const _LOD_THRESHOLDS_5 = [80, 200, 400, 800, 1400];
const _LOD_INDICES_5 = [0, 1, 2, 3, 4];

function _pickMeshLod(lods, screenPx, ceilingIdx, use3LodSystem = false, lodScale = 1, curLod = -1) {
  let thresholds, lodIndices;
  if (use3LodSystem && lods.length >= 5) {
    thresholds = _LOD_THRESHOLDS_3;
    lodIndices = _LOD_INDICES_3;
  } else {
    thresholds = _LOD_THRESHOLDS_5;
    lodIndices = _LOD_INDICES_5;
  }

  const effPx = screenPx * lodScale;

  const deadBandFraction = 0.18;
  let curIdx = -1;
  if (curLod >= 0) { const p = lodIndices.indexOf(curLod); if (p >= 0) curIdx = p; }
  let i = 0;
  for (let t = 0; t < thresholds.length; t++) {
    const thr = thresholds[t];
    const goingUpBoundary = curIdx <= t;
    const eff = goingUpBoundary ? thr * (1 + deadBandFraction) : thr * (1 - deadBandFraction);
    if (effPx > eff) i++; else break;
  }
  if (ceilingIdx != null) i = Math.min(i, ceilingIdx);
  const clampedIdx = Math.min(i, lodIndices.length - 1);
  return use3LodSystem ? lodIndices[clampedIdx] : clampedIdx;
}
function _pickTexLod(lods, screenPx) {
  const target = Math.max(64, screenPx);
  let bestIdx = 0;
  for (let i = 0; i < lods.length; i++) {
    if (lods[i].width <= target * 2) bestIdx = i;
  }
  return bestIdx;
}

function _precomputeAllTexLods(asset, screenPx) {
  const result = {};
  for (let tdIdx = 0; tdIdx < asset.texLodDescs.length; tdIdx++) {
    const desc = asset.texLodDescs[tdIdx];
    if (desc) result[tdIdx] = _pickTexLod(desc.lods, screenPx);
  }
  return result;
}

const _MAT_TEX_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];

function _meshTexDescIdxs(mat, texLodDescs) {
  const idxs = [];
  if (!mat || !texLodDescs) return idxs;
  const names = new Set();
  for (const slot of _MAT_TEX_SLOTS) {
    const t = mat[slot];
    if (t && t.name) names.add(t.name);
  }
  if (!names.size) return idxs;
  for (let i = 0; i < texLodDescs.length; i++) {
    const d = texLodDescs[i];
    if (d && d.name && names.has(d.name)) idxs.push(i);
  }
  return idxs;
}

function _findMaterialSlots(mat, texEntry) {
  if (!mat) return [];
  const out = new Set();
  for (const slot of _MAT_TEX_SLOTS) {
    const t = mat[slot];
    if (!t) continue;
    const tname = t.name || '';
    if (tname && texEntry.name && tname === texEntry.name) out.add(t);
  }
  if (out.size) return [...out];
  const nm = (texEntry.name || '').toLowerCase();
  if (nm.includes('normal') && mat.normalMap) out.add(mat.normalMap);
  if ((nm.includes('metallic') || nm.includes('roughness'))) {
    if (mat.roughnessMap) out.add(mat.roughnessMap);
    if (mat.metalnessMap) out.add(mat.metalnessMap);
  }
  return [...out];
}

export function _capAnisotropyByDeviceTier(capRequested, deviceInfoHint) {
  if (!deviceInfoHint || typeof deviceInfoHint !== 'object') return capRequested;
  const { gpuTier, isMobile } = deviceInfoHint;
  if (gpuTier === 'low') return Math.min(capRequested, isMobile ? 1 : 2);
  if (isMobile && gpuTier !== 'medium') return Math.min(capRequested, 2);
  return capRequested;
}

function _detectAvailableVRAM(deviceInfoHint) {
  if (deviceInfoHint && typeof deviceInfoHint === 'object') {
    const { gpuTier, memoryMB, isMobile } = deviceInfoHint;
    if (gpuTier === 'low') return isMobile ? 512 : 1024;
    if (gpuTier === 'medium') {
      if (memoryMB > 0) return Math.floor(Math.min(memoryMB, 16384) * 0.5);
      return isMobile ? 1024 : 2048;
    }
  }

  if (typeof navigator !== 'undefined' && navigator.deviceMemory) {
    const systemRamGB = navigator.deviceMemory;
    return Math.floor(systemRamGB * 512);
  }

  try {
    if (typeof window !== 'undefined' && window.navigator) {
      const ua = window.navigator.userAgent.toLowerCase();
      if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
        return UA_MOBILE_VRAM_MB;
      }
      return UA_DESKTOP_VRAM_MB;
    }
  } catch (e) {
  }

  return FALLBACK_VRAM_MB;
}

export class ModelPool extends Emitter {
  constructor(opts = {}) {
    super();
    this.scene = opts.scene;
    this.renderer = opts.renderer;
    this.camera = opts.camera;
    if (this.renderer) {
      const ktx2Loader = _ensureKtx2Loader(this.renderer);
      if (ktx2Loader) applyKtx2DeviceTierCap(ktx2Loader, opts.deviceInfo);
    }
    this.targetFps = opts.targetFps ?? 50;
    this._tintCompose = typeof opts.tintCompose === 'function' ? opts.tintCompose : null;
    this._globalMaterialPool = (this.renderer && this.renderer.isWebGPURenderer)
      ? new GlobalMaterialPoolTSL(this.renderer, opts)
      : new GlobalMaterialPool(this.renderer, opts);
    this._globalMaterialPool._useGlobalMaterialPool = opts.useGlobalMaterialPool !== false;
    this._useBatchedFarTier = opts.useBatchedFarTier === true;
    this._batchedFarTier = null;
    this._useMaterialBucketBatching = opts.useMaterialBucketBatching === true;
    this._materialBucketBatcher = null;
    this._materialBucketPx = opts.materialBucketPx ?? (opts.impostorPx ?? 14) * 3;
    this._useImpostorFinalLod = opts.useImpostorFinalLod === true;
    this._impostorTier = null;
    this._useOcclusionQuery = opts.useOcclusionQuery === true;
    this._occlusionTier = null;
    this._occlusionMinCandidates = opts.occlusionMinCandidates ?? 64;
    this._mergeStaticMaterials = opts.mergeStaticMaterials !== false;
    this._textureArrayAtlas = opts.textureArrayAtlas === true;
    this._impostorPx = opts.impostorPx ?? 14;
    this._impostorGrid = opts.impostorGrid ?? 8;
    this._impostorCellBudget = opts.impostorCellBudget ?? 4;
    this._impostorBakeQueue = new Map();
    this._impostorTextureSize = opts.impostorTextureSize ?? 1024;
    this._impostorMaxAssets = opts.impostorMaxAssets ?? 64;
    this._impostorHemiOcta = opts.impostorHemiOcta === true;
    this._impostorFade = opts.impostorFade === true;
    this._impostorFadeBandPx = opts.impostorFadeBandPx ?? 6;
    this._impostorParallax = opts.impostorParallax === true;
    this._impostorParallaxScale = opts.impostorParallaxScale ?? 0.3;
    if (this._useImpostorFinalLod) this._getImpostorTier();
    this._impostorActiveCount = 0;
    this._enableGpuInstanceTex = opts.enableGpuInstanceTex === true;
    this._lodDistanceScale = 1;
    this._lodWarmQueue = new Map();
    this._lodWarmInFlight = 0;
    this._lodWarmMaxInFlight = opts.lodWarmMaxInFlight ?? 3;
    this._lodWarmPerFrame = opts.lodWarmPerFrame ?? 2;
    this._gpuWarmPending = [];
    this._spawnQueue = [];
    this._spawnPerFrame = opts.spawnPerFrame ?? 4;
    this._spawnMaxPerFrame = opts.spawnMaxPerFrame ?? 24;
    this._clusterBuildQueue = [];
    this._clusterBuildPerFrame = opts.clusterBuildPerFrame ?? CLUSTER_BUILD_PER_FRAME;
    this._clusterBuildMaxPerFrame = opts.clusterBuildMaxPerFrame ?? CLUSTER_BUILD_MAX_PER_FRAME;
    this._deferredLoadQueue = new DeferredLoadQueue(opts.maxConcurrentDefers ?? 2);
    this._enableDeferredStreaming = opts.enableDeferredStreaming !== false;
    this._estimatedVramMB = _detectAvailableVRAM(opts.deviceInfo);
    this.deviceInfo = opts.deviceInfo || null;
    this._deviceInfo = this.deviceInfo;
    const safeByteBudget = Math.floor((this._estimatedVramMB * 0.65) * 1024 * 1024);
    this.byteBudget = opts.byteBudget ?? safeByteBudget;
    this._lodUnloadManager = new LodUnloadManager(opts.vramBudgetMB ?? (this.byteBudget / (1024 * 1024)));
    this._budgetAdjustmentCooldown = 0;
    this._vramRatioMonitor = {
      currentRatio: 0,
      peakRatio: 0,
      lastAdjustmentRatio: 0,
      adjustmentCooldown: 0,
    };
    this._vramThresholdWarning = 0.78;
    this._vramThresholdCritical = 0.85;
    this._vramThresholdSafe = 0.45;
    this.maxConcurrentFetches = opts.maxConcurrentFetches ?? 6;
    this.animationThrottleDistance = opts.animationThrottleDistance ?? 15;
    this._assets = new Map();
    this._entities = new Set();
    this._movers = new Map();
    this._farLerpState = new Map();
    this._nextEntityId = 0;
    this._totalBytes = 0;
    this._byteLog = new Map();
    this._loadQueue = new Map();
    this._inFlight = 0;
    this._pending = [];
    this._fpsEma = 60;
    this._lastTick = performance.now();
    this._fpsGoodFrames = 0;
    this._budgetLowFrames = 0;
    this._currentCeilingLod = 4;
    this._frustum = new THREE.Frustum();
    this._tmpMatrix = new THREE.Matrix4();
    this._frustumCheckInterval = 5;
    this._dynamicFrustumCheckInterval = 5;
    this._lastFrameMovingCount = 0;
    this._heroBudgetMs = 2.0;
    this._midBudgetMs = 4.0;
    this._heroDist = 20;
    this._midDist = 60;
    this._heroFrameTimeMs = 0;
    this._midFrameTimeMs = 0;
    this._entityDistances = [];
    this._stats = { fps: 0, entities: 0, drawCalls: 0, ceilingLod: null, bytes: 0, assets: 0, inFlight: 0, hero: 0, mid: 0, far: 0, heroBudgetMs: 0, midBudgetMs: 0 };
    this._instancedSlots = new Map();
    this.heroPx = opts.heroPx ?? 200;
    this.midPx = opts.midPx ?? 120;
    this.heroCap = opts.heroCap ?? 3;
    this._enableFrustumCulling = true;
    this._enableTextureLod = true;
    this._enableAnimThrottle = true;
    this._use3LodSystem = opts.use3LodSystem === true;
    this._workerCount = opts.workerCount ?? Math.max(2, Math.min(8, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4) - 1));
    this._workers = [];
    this._workerRR = 0;
    this._workerPending = new Map();
    this._workerNextId = 0;
    if (this._workerCount > 0 && typeof Worker !== 'undefined') {
      try {
        const workerUrl = _lodWorkerUrl();
        for (let i = 0; i < this._workerCount; i++) {
          const w = new Worker(workerUrl, { type: 'module' });
          w.addEventListener('message', (ev) => {
            const m = ev.data;
            if (m && m.id === 0) {
              if (m.warn) console.warn('[pool]', m.warn);
              if (!m.ready) return;
              if (m.ok) {
                console.log(`[pool] worker ready (three r${m.three})`);
                return;
              }
              console.error('[pool] worker init failed, removing it from LOD decode rotation:', m.error);
              this._workers = this._workers.filter((x) => x !== w);
              return;
            }
            this._onWorkerMessage(m);
          });
          w.addEventListener('error', (e) => {
            const detail = {
              message: e.message || '(no message)',
              filename: e.filename || '(no filename)',
              lineno: e.lineno,
              colno: e.colno,
              error: e.error ? (e.error.stack || String(e.error)) : '(no error obj)',
              workerUrl: String(workerUrl),
            };
            console.error('[pool] worker error', JSON.stringify(detail));
          });
          w.addEventListener('messageerror', (e) => console.error('[pool] worker messageerror', String(e)));
          this._workers.push(w);
        }
      } catch (e) {
        console.warn('[pool] worker init failed, falling back to main-thread decode', e);
        this._workers = [];
      }
    }

  }

  get ceilingLod() {
    return this._currentCeilingLod;
  }
  set ceilingLod(val) {
    this._currentCeilingLod = val === 5 ? null : (val != null ? val : null);
  }

  get frustumCheckInterval() {
    return this._frustumCheckInterval;
  }
  set frustumCheckInterval(val) {
    this._frustumCheckInterval = val;
    if (val === 0) {
      this._dynamicFrustumCheckInterval = 5;
    }
  }

  _onWorkerMessage(msg) {
    const pend = this._workerPending.get(msg.id);
    if (!pend) return;
    this._workerPending.delete(msg.id);
    if (msg.ok) pend.resolve(msg.payload);
    else pend.reject(new Error(msg.error || 'worker decode failed'));
  }

  _workerFetchLod(url, decodeAABB, sloppyCap = 0) {
    if (!this._workers.length) return null;
    const id = ++this._workerNextId;
    const slot = this._workerRR % this._workers.length;
    const w = this._workers[slot];
    this._workerRR = (slot + 1) % this._workers.length;
    return new Promise((resolve, reject) => {
      this._workerPending.set(id, { resolve, reject });
      w.postMessage({ id, url, decodeAABB, sloppyCap });
    });
  }

  static _buildGeometryFromPayload(payload) {
    const geo = new THREE.BufferGeometry();
    for (const k of Object.keys(payload.attrs)) {
      const a = payload.attrs[k];
      const isFloat = a.array instanceof Float32Array;
      const normalized = isFloat ? false : !!a.normalized;
      geo.setAttribute(k, new THREE.BufferAttribute(a.array, a.itemSize, normalized));
    }
    if (payload.index) {
      geo.setIndex(new THREE.BufferAttribute(payload.index, 1));
    }
    if (payload.boundingSphere) {
      geo.boundingSphere = new THREE.Sphere(
        new THREE.Vector3().fromArray(payload.boundingSphere.center),
        payload.boundingSphere.radius
      );
    }
    if (payload.boundingBox) {
      geo.boundingBox = new THREE.Box3(
        new THREE.Vector3().fromArray(payload.boundingBox.min),
        new THREE.Vector3().fromArray(payload.boundingBox.max)
      );
    }
    return geo;
  }

  _enqueueLodWarm(asset, meshDescIdx, lodIdx, dist) {
    const desc = asset.meshLodDescs[meshDescIdx];
    if (!desc) return;
    const t = desc.lods[lodIdx];
    if (!t || t.inline) return;
    const key = `${asset.url}#${desc.meshIndex}:${desc.primIndex}:${lodIdx}`;
    if (asset.geoCache.has(`${desc.meshIndex}:${desc.primIndex}:${lodIdx}`)) return;
    const ex = this._lodWarmQueue.get(key);
    if (ex) { if (dist < ex.dist) ex.dist = dist; return; }
    this._lodWarmQueue.set(key, { asset, meshDescIdx, lodIdx, dist });
  }

  setTarget(entity, x, y, z, durationMs = 300, nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
    if (!entity || entity._disposed) return;
    let sx, sy, sz;
    const cur = this._movers.get(entity);
    const farCur = this._farLerpState && this._farLerpState.get(entity);
    if (cur) {
      const t = cur.dur > 0 ? Math.min(1, Math.max(0, (nowMs - cur.start) / cur.dur)) : 1;
      sx = cur.x0 + (cur.x1 - cur.x0) * t;
      sy = cur.y0 + (cur.y1 - cur.y0) * t;
      sz = cur.z0 + (cur.z1 - cur.z0) * t;
    } else if (farCur) {
      const t = farCur.dur > 0 ? Math.min(1, Math.max(0, (nowMs - farCur.start) / farCur.dur)) : 1;
      sx = farCur.x0 + (farCur.x1 - farCur.x0) * t;
      sy = farCur.y0 + (farCur.y1 - farCur.y0) * t;
      sz = farCur.z0 + (farCur.z1 - farCur.z0) * t;
    } else {
      const p = entity.root.position;
      sx = p.x; sy = p.y; sz = p.z;
    }
    if (durationMs <= 0) {
      this._movers.delete(entity);
      if (this._farLerpState) this._farLerpState.delete(entity);
      this._clearFarLerp(entity);
      this._applyEntityPosition(entity, x, y, z);
      return;
    }
    if (this._setFarLerp(entity, sx, sy, sz, x, y, z, nowMs / 1000, durationMs / 1000)) {
      this._movers.delete(entity);
      this._farLerpState.set(entity, { x0: sx, y0: sy, z0: sz, x1: x, y1: y, z1: z, start: nowMs, dur: durationMs });
      entity.root.position.set(sx, sy, sz);
      return;
    }
    this._movers.set(entity, { x0: sx, y0: sy, z0: sz, x1: x, y1: y, z1: z, start: nowMs, dur: durationMs });
  }

  _setFarLerp(entity, x0, y0, z0, x1, y1, z1, startSec, durSec) {
    const tier = this._batchedFarTier;
    if (!tier) return false;
    if (!entity.trackedMeshes || entity.trackedMeshes.length === 0) return false;
    const id = tier.instanceIdFor(entity);
    if (id < 0) return false;
    for (const tm of entity.trackedMeshes) {
      if (!tm._instancedSlot || !tm._instancedSlot._batchedFar) return false;
    }
    tier.setLerpTarget(id, x0, y0, z0, x1, y1, z1, startSec, durSec);
    return true;
  }

  shiftFloatingOrigin(dx, dy, dz) {
    for (const m of this._movers.values()) { m.x0 += dx; m.y0 += dy; m.z0 += dz; m.x1 += dx; m.y1 += dy; m.z1 += dz; }
    if (this._farLerpState) {
      const tier = this._batchedFarTier;
      for (const [entity, m] of this._farLerpState) {
        m.x0 += dx; m.y0 += dy; m.z0 += dz; m.x1 += dx; m.y1 += dy; m.z1 += dz;
        if (tier) {
          const id = tier.instanceIdFor(entity);
          if (id >= 0 && typeof tier.setLerpTarget === 'function') tier.setLerpTarget(id, m.x0, m.y0, m.z0, m.x1, m.y1, m.z1, m.start / 1000, m.dur / 1000);
        }
      }
    }
  }

  _clearFarLerp(entity) {
    if (this._farLerpState) this._farLerpState.delete(entity);
    const tier = this._batchedFarTier;
    if (!tier) return;
    const id = tier.instanceIdFor(entity);
    if (id >= 0) tier.clearLerp(id);
  }

  _applyEntityPosition(entity, x, y, z) {
    entity.root.position.set(x, y, z);
    entity.root.updateMatrix();
    entity.root.updateMatrixWorld(true);
    for (const tm of entity.trackedMeshes) {
      if (tm._instancedSlot && tm._instancedSlotIdx != null && tm._instancedSlotIdx >= 0) {
        tm._instancedSlot.setMatrixForSlot(tm._instancedSlotIdx, entity._slotWorldMatrix(tm));
      }
    }
  }

  setRotation(entity, qx, qy, qz, qw) {
    if (!entity || entity._disposed || !entity.root) return;
    entity.root.quaternion.set(qx, qy, qz, qw);
    entity.root.updateMatrix();
    entity.root.updateMatrixWorld(true);
    for (const tm of entity.trackedMeshes) {
      if (tm._instancedSlot && tm._instancedSlotIdx != null && tm._instancedSlotIdx >= 0) {
        tm._instancedSlot.setMatrixForSlot(tm._instancedSlotIdx, entity._slotWorldMatrix(tm));
      }
    }
  }

  _drainMovers(nowMs) {
    if (this._movers.size === 0) return;
    for (const [entity, m] of this._movers) {
      if (entity._disposed) { this._movers.delete(entity); continue; }
      const t = m.dur > 0 ? Math.min(1, Math.max(0, (nowMs - m.start) / m.dur)) : 1;
      const x = m.x0 + (m.x1 - m.x0) * t;
      const y = m.y0 + (m.y1 - m.y0) * t;
      const z = m.z0 + (m.z1 - m.z0) * t;
      this._applyEntityPosition(entity, x, y, z);
      if (t >= 1) this._movers.delete(entity);
    }
  }

  _drainLodWarm() {
    if (this._lodWarmQueue.size === 0) return;
    const target = this.targetFps || 60;
    let starts;
    if (this._fpsEma >= target + 5) starts = this._lodWarmPerFrame * 2;
    else if (this._fpsEma >= target - 8) starts = this._lodWarmPerFrame;
    else starts = 1;
    while (starts-- > 0 && this._lodWarmInFlight < this._lodWarmMaxInFlight && this._lodWarmQueue.size) {
      let bestKey = null, bestDist = Infinity;
      for (const [k, v] of this._lodWarmQueue) { if (v.dist < bestDist) { bestDist = v.dist; bestKey = k; } }
      if (bestKey == null) break;
      const item = this._lodWarmQueue.get(bestKey);
      this._lodWarmQueue.delete(bestKey);
      this._lodWarmInFlight++;
      Promise.resolve(item.asset.ensureMeshLod(item.meshDescIdx, item.lodIdx))
        .then((geo) => { if (geo && !geo.__gpuWarmed) this._gpuWarmPending.push(geo); })
        .catch(() => {})
        .finally(() => { this._lodWarmInFlight--; });
    }
  }

  _drainGpuWarm() {
    if (!this._gpuWarmPending.length) return;
    const target = this.targetFps || 60;
    let budget;
    if (this._fpsEma >= target + 5) budget = 8;
    else if (this._fpsEma >= target - 8) budget = 3;
    else budget = 1;
    while (budget-- > 0 && this._gpuWarmPending.length) {
      const geo = this._gpuWarmPending.shift();
      if (geo && !geo.__gpuWarmed) this._gpuWarmGeometry(geo);
    }
  }

  _gpuWarmGeometry(geo) {
    if (!geo || geo.__gpuWarmed) return;
    if (!this._warmScene) {
      this._warmScene = new THREE.Scene();
      this._warmCam = new THREE.Camera();
      this._warmMat = new THREE.MeshBasicMaterial();
      this._warmMesh = new THREE.Mesh(undefined, this._warmMat);
      this._warmMesh.frustumCulled = false;
      this._warmScene.add(this._warmMesh);
      this._warmTarget = new THREE.WebGLRenderTarget(1, 1);
    }
    const prevTarget = this.renderer.getRenderTarget();
    this._warmMesh.geometry = geo;
    this.renderer.setRenderTarget(this._warmTarget);
    try {
      this.renderer.render(this._warmScene, this._warmCam);
      geo.__gpuWarmed = true;
    } catch (err) {
      this._gpuWarmFailures = (this._gpuWarmFailures || 0) + 1;
      console.warn(`[pool] GPU warm-up draw failed for geometry ${geo.uuid} (${(err && err.message) || err}); its buffers upload on first real draw`);
    } finally {
      this.renderer.setRenderTarget(prevTarget);
      this._warmMesh.geometry = undefined;
    }
  }

  _queueImpostorBake(asset, entity) {
    if (!this._impostorBakeQueue) this._impostorBakeQueue = new Map();
    if (this._impostorTier && this._impostorTier.hasAsset(asset)) return;
    if (!this._impostorBakeQueue.has(asset.url)) this._impostorBakeQueue.set(asset.url, entity);
  }

  _drainImpostorBakes() {
    const q = this._impostorBakeQueue;
    const tier = this._impostorTier;
    if (!q || q.size === 0 || !tier) return;
    const fps = this._fpsEma || 60;
    const target = this.targetFps || 50;
    let budget = this._impostorCellBudget;
    if (fps > target + 10) budget = this._impostorCellBudget * 2;
    else if (fps < target) budget = Math.max(1, this._impostorCellBudget >> 1);
    for (const [url, entity] of q) {
      if (budget <= 0) break;
      if (!entity || entity._disposed) { q.delete(url); continue; }
      if (tier.hasAsset(entity.asset)) { q.delete(url); continue; }
      budget -= tier.bakeChunk(entity.asset, entity.root, budget);
      if (tier.hasAsset(entity.asset)) q.delete(url);
    }
  }

  runOcclusionQueries() {
    if (!this._useOcclusionQuery) return;
    const tier = this._getOcclusionTier();
    if (!tier) return;
    const candidates = this._occlusionCandidates;
    if (!candidates || candidates.length < this._occlusionMinCandidates) return;
    tier.runQueries(this.camera, candidates);
  }

  _getOcclusionTier() {
    if (!this._useOcclusionQuery) return null;
    if (this.renderer && this.renderer.isWebGPURenderer && !this._occlusionTier && !this._webgpuTierLoading) {
      this._webgpuTierLoading = true;
      import('./webgpu-hiz-tier.js').then(({ WebGpuHizTier }) => {
        this._webgpuTierLoading = false;
        if (!this._useOcclusionQuery || this._occlusionTier) return;
        const gpuTier = new WebGpuHizTier(this.renderer, { minCandidates: this._occlusionMinCandidates });
        if (gpuTier.supported()) {
          this._occlusionTier = gpuTier;
        } else {
        }
      }).catch((err) => {
        this._webgpuTierLoading = false;
        if (typeof console !== 'undefined') console.warn('[model-pool] webgpu-hiz-tier.js dynamic import failed:', err);
        if (this._useOcclusionQuery && !this._occlusionTier && this.renderer && !this.renderer.isWebGPURenderer) {
          this._occlusionTier = new OcclusionQueryTier(this.renderer, { minCandidates: this._occlusionMinCandidates });
          if (!this._occlusionTier.supported()) { this._occlusionTier = null; this._useOcclusionQuery = false; }
        }
      });
      return null;
    }
    if (this.renderer && this.renderer.isWebGPURenderer) return this._occlusionTier;
    if (!this._occlusionTier) {
      if (!this.renderer) return null;
      this._occlusionTier = new OcclusionQueryTier(this.renderer, { minCandidates: this._occlusionMinCandidates });
      if (!this._occlusionTier.supported()) {
        this._occlusionTier = null;
        this._useOcclusionQuery = false;
      }
    }
    return this._occlusionTier;
  }

  _getImpostorTier() {
    if (!this._useImpostorFinalLod) return null;
    if (!this._impostorTier) {
      if (!this.renderer || !this.scene) return null;
      this._impostorTier = new OctahedralImpostorEzTier(this.renderer, {
        grid: this._impostorGrid,
        textureSize: this._impostorTextureSize,
        maxImpostorAssets: this._impostorMaxAssets,
        useHemiOctahedron: this._impostorHemiOcta,
        fade: this._impostorFade,
        parallax: this._impostorParallax,
        parallaxScale: this._impostorParallaxScale,
      });
      this.scene.add(this._impostorTier.mesh);
    }
    return this._impostorTier;
  }

  _getMaterialBucketBatcher() {
    if (!this._useMaterialBucketBatching) return null;
    if (!this._materialBucketBatcher) {
      if (!this.scene) return null;
      this._materialBucketBatcher = new MaterialBucketBatcher(this);
    }
    return this._materialBucketBatcher;
  }

  _getInstancedSlot(asset, meshDescIdx, lodIdx) {
    const desc = asset.meshLodDescs[meshDescIdx];
    if (!desc) return null;
    const lod = desc.lods[lodIdx];
    if (!lod || (lod.kind || 'textured') !== 'unskinned') return null;
    const key = `${asset.url}|${meshDescIdx}|${lodIdx}`;
    let slot = this._instancedSlots.get(key);
    if (slot) return slot;
    const geo = asset.geoCache.get(`${desc.meshIndex}:${desc.primIndex}:${lodIdx}`);
    if (!geo) return null;

    if (this._useBatchedFarTier) {
      if (!this._batchedFarTier) {
        this._batchedFarTier = new BatchedFarTier(this);
        this.scene.add(this._batchedFarTier.mesh);
      }
      const adapter = this._batchedFarTier.slotAdapter(asset, meshDescIdx, lodIdx, geo);
      this._instancedSlots.set(key, adapter);
      return adapter;
    }

    let mat;
    if (this._globalMaterialPool._useGlobalMaterialPool) {
      mat = this._globalMaterialPool.getMaterialForTier('far');
    } else if (this.renderer && this.renderer.isWebGPURenderer) {
      mat = createVertexColorNodeMaterial({ tintCompose: this._tintCompose });
    } else {
      mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      mat.onBeforeCompile = (shader) => {
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
    }

    slot = new InstancedSlot(this, asset, meshDescIdx, lodIdx, geo, mat);
    this._instancedSlots.set(key, slot);

    this.scene.add(slot.mesh);
    return slot;
  }

  async _resolveAsset(url) {
    let a = this._assets.get(url);
    if (!a) {
      a = new Asset(this, url);
      this._assets.set(url, a);
      a.ready.then(() => this.emit('asset-ready', a)).catch((e) => this.emit('asset-error', { asset: a, error: e }));
    }
    return a;
  }

  spawn(url, opts = {}) {
    if (!url) throw new Error('spawn(): url required');
    if (typeof url !== 'string') throw new TypeError(`spawn(): url must be a string, got ${typeof url}`);
    const assetPromise = this._resolveAsset(url);
    const placeholder = { _disposed: false };
    const proxy = new Emitter();
    proxy.root = new THREE.Object3D();
    proxy.root.name = `pending_${++this._nextEntityId}`;
    proxy.actualEntity = null;
    proxy.dispose = () => {
      placeholder._disposed = true;
      if (proxy.actualEntity) proxy.actualEntity.dispose();
      else proxy.root.parent?.remove(proxy.root);
    };
    assetPromise.then((asset) => {
      if (placeholder._disposed) return;
      this._spawnQueue.push({ asset, opts, proxy, placeholder });
    }).catch((e) => proxy.emit('error', e));
    return proxy;
  }

  _materializeSpawn(item) {
    const { asset, opts, proxy, placeholder } = item;
    if (placeholder._disposed) return;
    const actualEntity = new Entity(this, asset, opts);
    this._entities.add(actualEntity);
    const parent = proxy.root.parent;
    if (parent) {
      parent.add(actualEntity.root);
      parent.remove(proxy.root);
    }
    actualEntity.on('ready', (e) => proxy.emit('ready', e));
    actualEntity.on('lod-changed', (e) => proxy.emit('lod-changed', e));
    actualEntity.on('disposed', (e) => proxy.emit('disposed', e));
    actualEntity.on('error', (e) => proxy.emit('error', e));
    proxy.actualEntity = actualEntity;
    proxy.root = actualEntity.root;
  }

  _drainSpawnQueue() {
    if (this._spawnQueue.length === 0) return;
    const target = this.targetFps || 60;
    let starts;
    if (this._fpsEma >= target + 5) starts = this._spawnMaxPerFrame;
    else if (this._fpsEma >= target - 8) starts = this._spawnPerFrame;
    else starts = 1;
    starts = Math.min(starts, this._spawnMaxPerFrame);
    while (starts-- > 0 && this._spawnQueue.length > 0) {
      const item = this._spawnQueue.shift();
      try { this._materializeSpawn(item); } catch (e) { item.proxy.emit('error', e); }
    }
  }

  _queueClusterBuild(entity, meshOrderC, rootInv, next, total) {
    this._clusterBuildQueue.push({ entity, meshOrderC, rootInv, next, total });
  }

  _drainClusterBuild() {
    if (this._clusterBuildQueue.length === 0) return;
    const target = this.targetFps || 60;
    let budget;
    if (this._fpsEma >= target + 5) budget = this._clusterBuildMaxPerFrame;
    else if (this._fpsEma >= target - 8) budget = this._clusterBuildPerFrame;
    else budget = 1;
    budget = Math.min(budget, this._clusterBuildMaxPerFrame);
    let qi = 0;
    while (budget > 0 && this._clusterBuildQueue.length > 0) {
      if (qi >= this._clusterBuildQueue.length) qi = 0;
      const item = this._clusterBuildQueue[qi];
      if (item.entity._disposed) { this._clusterBuildQueue.splice(qi, 1); continue; }
      const chunkEnd = Math.min(item.total, item.next + budget);
      const built = chunkEnd - item.next;
      try { item.entity._buildClusterMeshRange(item.meshOrderC, item.rootInv, item.next, chunkEnd); }
      catch (e) { item.entity.emit('error', e); this._clusterBuildQueue.splice(qi, 1); continue; }
      item.next = chunkEnd;
      budget -= built;
      if (item.next >= item.total) { this._clusterBuildQueue.splice(qi, 1); continue; }
      qi++;
    }
  }

  update() {
    const tUpdate0 = performance.now();
    const now = tUpdate0;
    const dt = (now - this._lastTick) / 1000;
    this._lastTick = now;
    if (this._useImpostorFinalLod) this._drainImpostorBakes();
    const instFps = dt > 0 ? 1 / dt : 60;
    this._fpsEma = this._fpsEma * 0.85 + instFps * 0.15;

    this._drainSpawnQueue();
    this._drainClusterBuild();

    if (this._batchedFarTier) this._batchedFarTier.updateNow(now / 1000);

    this._drainMovers(now);

    const totalEntities = this._entities.size;
    const prevMoving = this._lastFrameMovingCount || 0;
    const sceneStaticnessPercent = totalEntities > 0 ? ((totalEntities - prevMoving) / totalEntities) * 100 : 100;
    this._dynamicFrustumCheckInterval = prevMoving === 0 ? 10 : (sceneStaticnessPercent >= 95 ? 8 : 5);
    let movingCount = 0;
    const target = this.targetFps;
    const entityCount = this._entities.size;
    const adjustFreq = entityCount > 500 ? 6 : entityCount > 200 ? 10 : 20;
    const knobStep = entityCount > 500 ? 30 : 20;
    const midPxMax = entityCount > 500 ? 250 : 200;

    if (this._lodDistanceScale == null) this._lodDistanceScale = 1;
    const lowBand = target - Math.max(6, target * 0.06);
    const highBand = target + Math.max(8, target * 0.10);
    const SCALE_MIN = 0.15, SCALE_MAX = 1.6;
    if (!this._lodAdjustCountdown) this._lodAdjustCountdown = 4;
    if (--this._lodAdjustCountdown <= 0) {
      this._lodAdjustCountdown = 4;
      if (this._fpsEma < lowBand && this._lodDistanceScale > SCALE_MIN) {
        const deficit = Math.min(1, (lowBand - this._fpsEma) / Math.max(1, lowBand));
        this._lodDistanceScale = Math.max(SCALE_MIN, this._lodDistanceScale * (1 - 0.06 - 0.1 * deficit));
        this.emit('budget-adjust', { reason: 'fps-low-loddist', lodDistanceScale: this._lodDistanceScale, fps: this._fpsEma });
      } else if (this._fpsEma > highBand && this._lodDistanceScale < SCALE_MAX) {
        this._lodDistanceScale = Math.min(SCALE_MAX, this._lodDistanceScale * 1.04);
        this.emit('budget-adjust', { reason: 'fps-high-loddist', lodDistanceScale: this._lodDistanceScale, fps: this._fpsEma });
      }
    }

    if (!this._fpsAdjustCountdown) this._fpsAdjustCountdown = adjustFreq;
    this._fpsAdjustCountdown--;
    if (this._fpsAdjustCountdown <= 0) {
      this._fpsAdjustCountdown = adjustFreq;
      if (this._fpsEma < target - 5) {
        let changed = false;
        if (this.midPx < midPxMax) {
          this.midPx = Math.min(midPxMax, this.midPx + knobStep);
          changed = true;
        } else if (this.heroCap > 5) {
          this.heroCap = Math.max(5, this.heroCap - 5);
          changed = true;
        }
        if (changed) this.emit('budget-adjust', {
          reason: 'fps-sustained-low', midPx: this.midPx, heroCap: this.heroCap, fps: this._fpsEma,
        });
      } else if (this._fpsEma > target + 5) {
        let changed = false;
        if (this.heroCap < 20) {
          this.heroCap = Math.min(20, this.heroCap + 5);
          changed = true;
        } else if (this.midPx > 50) {
          this.midPx = Math.max(50, this.midPx - 10);
          changed = true;
        }
        if (changed) this.emit('budget-adjust', {
          reason: 'fps-headroom', midPx: this.midPx, heroCap: this.heroCap, fps: this._fpsEma,
        });
      }
    }
    const tFrustum0 = performance.now();
    this.camera.updateMatrixWorld();
    this._tmpMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._tmpMatrix);
    if (this._frustumCache) {
      this._frustumCache.updatePlanes(this.camera, this._frustum);
    }
    this._fovTanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    {
      const cp = this.camera.position;
      const lp = this._lastCamPos || (this._lastCamPos = { x: Infinity, y: 0, z: 0, fov: 0, qx: 0, qy: 0, qz: 0, qw: 1 });
      const cq = this.camera.quaternion;
      const qDot = cq.x * lp.qx + cq.y * lp.qy + cq.z * lp.qz + cq.w * lp.qw;
      const rotated = (1 - Math.abs(qDot)) > CAMERA_ROTATION_HALF_DEGREE_DOT_EPSILON;
      const moved = Math.abs(cp.x - lp.x) > 1e-3 || Math.abs(cp.y - lp.y) > 1e-3 || Math.abs(cp.z - lp.z) > 1e-3 || this.camera.fov !== lp.fov || rotated;
      this._cameraMoved = moved;
      if (moved) { lp.x = cp.x; lp.y = cp.y; lp.z = cp.z; lp.fov = this.camera.fov; lp.qx = cq.x; lp.qy = cq.y; lp.qz = cq.z; lp.qw = cq.w; }
      if (this._lodEpoch == null) { this._lodEpoch = 1; this._lastLodScale = this._lodDistanceScale; this._cameraMoved = true; }
      const scaleNow = this._lodDistanceScale || 1;
      const scaleChanged = Math.abs(scaleNow - (this._lastLodScale ?? scaleNow)) > 0.04;
      if (moved || scaleChanged) { this._lodEpoch++; this._lastLodScale = scaleNow; }
    }
    const vh = this.renderer.domElement.clientHeight;
    for (const slot of this._instancedSlots.values()) {
      if (slot._uniforms) slot._uniforms.projViewMatrix.value = this._tmpMatrix;
    }
    const tFrustum1 = performance.now();

    const estimatedVramBytes = this._estimatedVramMB * 1024 * 1024;
    this._vramRatioMonitor.currentRatio = estimatedVramBytes > 0 ? this._totalBytes / estimatedVramBytes : 0;
    this._vramRatioMonitor.peakRatio = Math.max(this._vramRatioMonitor.peakRatio, this._vramRatioMonitor.currentRatio);

    if (this._vramRatioMonitor.adjustmentCooldown > 0) {
      this._vramRatioMonitor.adjustmentCooldown--;
    }

    if (this._vramRatioMonitor.currentRatio > this._vramThresholdCritical) {
      if (this._vramRatioMonitor.adjustmentCooldown === 0) {
        const nextCeil = (this._currentCeilingLod ?? 5) - 1;
        if (nextCeil >= 0 && this._currentCeilingLod !== nextCeil) {
          this._currentCeilingLod = nextCeil;
          console.warn(`[VRAM] ratio ${(this._vramRatioMonitor.currentRatio * 100).toFixed(1)}% > ${(this._vramThresholdCritical * 100).toFixed(0)}% — reduced LOD ceiling to ${nextCeil}`);
          this.emit('vram-critical', {
            ratio: this._vramRatioMonitor.currentRatio,
            bytes: this._totalBytes,
            estimatedVramMB: this._estimatedVramMB,
            action: 'reduce-lod-ceiling',
          });
        }
        if (this.midPx < 250) {
          const oldMidPx = this.midPx;
          this.midPx = Math.min(250, this.midPx + 20);
          console.warn(`[VRAM] increased midPx from ${oldMidPx} to ${this.midPx} to reduce VRAM pressure`);
        }
        this._vramRatioMonitor.adjustmentCooldown = VRAM_CRITICAL_COOLDOWN_FRAMES;
        this._vramRatioMonitor.lastAdjustmentRatio = this._vramRatioMonitor.currentRatio;
      }
    }
    else if (this._vramRatioMonitor.currentRatio > this._vramThresholdWarning && this._vramRatioMonitor.currentRatio <= this._vramThresholdCritical) {
      if (this._vramRatioMonitor.adjustmentCooldown === 0) {
        console.warn(`[VRAM] warning: ratio ${(this._vramRatioMonitor.currentRatio * 100).toFixed(1)}% — approaching critical threshold`);
        this.emit('vram-warning', {
          ratio: this._vramRatioMonitor.currentRatio,
          bytes: this._totalBytes,
          estimatedVramMB: this._estimatedVramMB,
        });
        this._vramRatioMonitor.adjustmentCooldown = 60;
      }
    }

    this._heroFrameTimeMs = 0;
    this._midFrameTimeMs = 0;
    let visible = 0;

    let ents = this._distEntities;
    let dists = this._distValues;
    let order = this._distOrder;
    const cap = this._entities.size;
    if (!ents || ents.length < cap) {
      ents = this._distEntities = new Array(cap);
      dists = this._distValues = new Float64Array(cap);
      order = this._distOrder = new Int32Array(cap);
    }
    let n = 0;
    const stream = this._enableDeferredStreaming;
    if (stream) this._lodUnloadManager.resetVisibility();
    const occTier = this._useOcclusionQuery ? this._getOcclusionTier() : null;
    this._occlusionCandidates = this._occlusionCandidates || [];
    this._occlusionCandidates.length = 0;
    for (const e of this._entities) {
      if (e._disposed) continue;
      if (occTier && occTier.isOccluded(e)) {
        if (e.root.visible) e.root.visible = false;
        if (stream) this._lodUnloadManager.markInvisible(e);
        this._occlusionCandidates.push(e);
        continue;
      }
      if (e.root.matrixAutoUpdate || e._boundDirty) movingCount++;
      const result = e._update(this.camera, vh, dt, this._currentCeilingLod, this._frustum, this.animationThrottleDistance);
      const { distance, screenPx } = result;
      if (screenPx > 0) {
        visible++;
        if (occTier) this._occlusionCandidates.push(e);
      }
      if (distance < Infinity) {
        ents[n] = e; dists[n] = distance; n++;
      }
      if (stream) {
        if (e.root.visible) this._lodUnloadManager.markVisible(e);
        else this._lodUnloadManager.markInvisible(e);
      }
    }
    this._distCount = n;
    this._lastFrameMovingCount = movingCount;

    const sortOrder = order.subarray(0, n);
    const orderStable = !this._cameraMoved && movingCount === 0 && n === this._lastSortN;
    if (!orderStable) {
      for (let i = 0; i < n; i++) order[i] = i;
      sortOrder.sort((a, b) => dists[a] - dists[b]);
      this._lastSortN = n;
    }

    let hero = 0, mid = 0, far = 0;
    for (let k = 0; k < n; k++) {
      const idx = sortOrder[k];
      const entity = ents[idx];
      const distance = dists[idx];
      let assignedTier;
      if (distance < this._heroDist && this._heroFrameTimeMs < this._heroBudgetMs) {
        assignedTier = 'hero';
        this._heroFrameTimeMs += HERO_ENTITY_COST_MS;
        hero++;
      } else if (distance < this._midDist && this._midFrameTimeMs < this._midBudgetMs) {
        assignedTier = 'mid';
        this._midFrameTimeMs += MID_ENTITY_COST_MS;
        mid++;
      } else {
        assignedTier = 'far';
        far++;
      }
      entity._assignedTier = assignedTier;
    }

    const heroUtilization = this._heroBudgetMs > 0 ? this._heroFrameTimeMs / this._heroBudgetMs : 0;
    const midUtilization = this._midBudgetMs > 0 ? this._midFrameTimeMs / this._midBudgetMs : 0;

    if (heroUtilization > 1.1) {
      this._heroDist = Math.max(5, this._heroDist - 2);
    } else if (heroUtilization < 0.5 && hero > 0) {
      this._heroDist = Math.min(50, this._heroDist + 1);
    }

    if (midUtilization > 1.1) {
      this._midDist = Math.max(20, this._midDist - 3);
    } else if (midUtilization < 0.5 && mid > 0) {
      this._midDist = Math.min(100, this._midDist + 2);
    }
    for (const slot of this._instancedSlots.values()) {
      slot.flushMatrixUpdates();
    }
    if (this._impostorTier) this._impostorTier.flush();
    const tEntities1 = performance.now();

    if (this._enableDeferredStreaming) {
      if (!this._unloadScanCounter) this._unloadScanCounter = 5;
      this._unloadScanCounter--;
      if (this._unloadScanCounter <= 0) {
        if (this._lodUnloadManager.vramBudgetBytes !== this.byteBudget) {
          this._lodUnloadManager.vramBudgetBytes = this.byteBudget;
          this._lodUnloadManager.vramBudgetMB = this.byteBudget / (1024 * 1024);
        }
        this._lodUnloadManager.scanForUnload(this._assets, this._totalBytes);
        this._unloadScanCounter = 5;
      }
    }

    this._stats.hero = hero;
    this._stats.mid = mid;
    this._stats.far = far;
    this._stats.heroBudgetTarget = this._heroBudgetMs;
    this._stats.midBudgetTarget = this._midBudgetMs;

    this._statsCosmeticCountdown = (this._statsCosmeticCountdown || 0) - 1;
    if (this._statsCosmeticCountdown <= 0) {
      this._statsCosmeticCountdown = 6;
      this._stats.heroBudgetMs = parseFloat(this._heroFrameTimeMs.toFixed(2));
      this._stats.midBudgetMs = parseFloat(this._midFrameTimeMs.toFixed(2));
      this._stats.heroDist = parseFloat(this._heroDist.toFixed(1));
      this._stats.midDist = parseFloat(this._midDist.toFixed(1));
      this._stats.tierSummary = `HERO: ${hero}/${this._heroCap} (${this._heroFrameTimeMs.toFixed(1)}ms), MID: ${mid} (${this._midFrameTimeMs.toFixed(1)}ms), FAR: ${far} (0ms)`;
    }

    this._stats.msFrustum = tFrustum1 - tFrustum0;
    this._stats.msEntities = tEntities1 - tFrustum1;
    const tBudget0 = performance.now();
    this._enforceBudget();
    const tBudget1 = performance.now();
    this._drainLodWarm();
    this._drainGpuWarm();
    if (this._totalBytes > this.byteBudget && this.midPx < 200) {
      this.midPx = Math.min(200, this.midPx + 5);
      this.emit('budget-adjust', { reason: 'over-budget', midPx: this.midPx, bytes: this._totalBytes, budget: this.byteBudget });
    }
    this._stats.fps = this._fpsEma;
    this._stats.entities = this._entities.size;
    this._stats.visible = visible;
    this._stats.drawCalls = this.renderer.info?.render?.calls ?? 0;
    this._stats.ceilingLod = this._currentCeilingLod;
    this._stats.bytes = this._totalBytes;
    this._stats.assets = this._assets.size;
    this._stats.inFlight = this._inFlight;
    this._stats.msBudget = tBudget1 - tBudget0;
    this._stats.msTotal = performance.now() - tUpdate0;
    this._stats.midPx = this.midPx;
    this._stats.heroCap = this.heroCap;
    this._stats.vram = {
      currentRatio: this._vramRatioMonitor.currentRatio,
      peakRatio: this._vramRatioMonitor.peakRatio,
      estimatedVramMB: this._estimatedVramMB,
      usedMB: this._totalBytes / (1024 * 1024),
    };
    this.emit('fps', this._stats);
  }

  setVramBudgetMB(mb) {
    if (!Number.isFinite(mb) || mb <= 0) return this.byteBudget;
    const bytes = Math.floor(mb * 1024 * 1024);
    this.byteBudget = bytes;
    this._lodUnloadManager.vramBudgetBytes = bytes;
    this._lodUnloadManager.vramBudgetMB = mb;
    this._budgetAdjustmentCooldown = BUDGET_ADJUST_COOLDOWN_FRAMES;
    return bytes;
  }

  getStats() {
    const stats = this._stats;
    stats.impostors = this._impostorActiveCount;
    stats.impostorLayers = this._impostorTier ? this._impostorTier._nextLayer : 0;
    stats.materialBucketInstances = this._materialBucketBatcher ? this._materialBucketBatcher.stats.instanceCount : 0;
    stats.materialBucketCount = this._materialBucketBatcher ? this._materialBucketBatcher.stats.bucketCount : 0;
    stats.materialBucketDrawCallsSaved = this._materialBucketBatcher ? this._materialBucketBatcher.stats.drawCallsSaved : 0;
    if ((this._subStatsCountdown = (this._subStatsCountdown || 0) - 1) <= 0) {
      this._subStatsCountdown = 6;
      if (this._globalMaterialPool) stats.materialPooling = this._globalMaterialPool.getStats();
      if (this._deferredLoadQueue) stats.deferredLoading = this._deferredLoadQueue.getStats();
      if (this._lodUnloadManager) stats.unloadManager = this._lodUnloadManager.getStats();
      if (this._occlusionTier) stats.occlusion = this._occlusionTier.stats;
    }
    return stats;
  }

  _trackBytes(assetUrl, url, bytes) {
    this._totalBytes += bytes;
    let log = this._byteLog.get(assetUrl);
    if (!log) { log = new Map(); this._byteLog.set(assetUrl, log); }
    log.set(url, bytes);
  }
  _untrackBytes(assetUrl, url) {
    const log = this._byteLog.get(assetUrl);
    if (!log) return 0;
    const b = log.get(url) || 0;
    this._totalBytes -= b;
    log.delete(url);
    return b;
  }
  _enforceBudget() {
    if (this._totalBytes <= this.byteBudget) return;
    if (!this._enforceBudgetCounter) this._enforceBudgetCounter = 0;
    if (this._enforceBudgetCounter > 0) { this._enforceBudgetCounter--; return; }
    this._enforceBudgetCounter = 5;
    const inUse = new Map();
    for (const e of this._entities) {
      const asset = e.asset;
      let u = inUse.get(asset.url);
      if (!u) { u = { mesh: new Set(), tex: new Set() }; inUse.set(asset.url, u); }
      const nMesh = asset.meshLodDescs.length;
      const nTex = asset.texLodDescs.length;
      const uMesh = u.mesh, uTex = u.tex;
      for (const tm of e.trackedMeshes) {
        const mdi = tm.meshDescIdx;
        if (mdi >= 0 && mdi < nMesh) uMesh.add(mdi * _LOD_KEY_STRIDE + tm.currentLod);
        const texState = tm.texState;
        const nt = texState.length < nTex ? texState.length : nTex;
        for (let ti = 0; ti < nt; ti++) uTex.add(ti * _LOD_KEY_STRIDE + texState[ti].currentLod);
      }
    }
    let evicted = 0;
    for (const asset of this._assets.values()) {
      const u = inUse.get(asset.url);
      if (asset.geoCache.size > 0) {
        const uMesh = u ? u.mesh : null;
        const meshDescs = asset.meshLodDescs;
        for (let di = 0; di < meshDescs.length; di++) {
          const lods = meshDescs[di].lods;
          const base = di * _LOD_KEY_STRIDE;
          for (let li = 0; li < lods.length; li++) {
            if (lods[li].inline) continue;
            if (uMesh !== null && uMesh.has(base + li)) continue;
            if (asset.evictMeshLod(di, li) !== null) evicted++;
          }
        }
      }
      if (asset.texCache.size > 0) {
        const uTex = u ? u.tex : null;
        const texDescs = asset.texLodDescs;
        for (let di = 0; di < texDescs.length; di++) {
          const lods = texDescs[di].lods;
          const base = di * _LOD_KEY_STRIDE;
          for (let li = 0; li < lods.length; li++) {
            if (lods[li].inline) continue;
            if (uTex !== null && uTex.has(base + li)) continue;
            if (asset.evictTexLod(di, li) !== null) evicted++;
          }
        }
      }
      if (this._totalBytes <= this.byteBudget) break;
    }
    if (evicted) this.emit('budget-pressure', { evicted, total: this._totalBytes, budget: this.byteBudget });

    const ratio = this._totalBytes / (this._estimatedVramMB * 1024 * 1024);
    if (ratio > 0.7) {
      this.byteBudget = Math.floor(this.byteBudget * 0.9);
      this._budgetAdjustmentCooldown = BUDGET_ADJUST_COOLDOWN_FRAMES;
      this.emit('budget-warning', { ratio, newBudget: this.byteBudget, estimatedVramMB: this._estimatedVramMB });
    } else if (ratio < 0.4 && this._budgetAdjustmentCooldown === 0) {
      this._budgetLowFrames++;
      if (this._budgetLowFrames >= 10) {
        const safeByteBudget = Math.floor((this._estimatedVramMB * 0.65) * 1024 * 1024);
        if (this.byteBudget < safeByteBudget) {
          this.byteBudget = Math.min(this.byteBudget * 1.05, safeByteBudget);
          this._budgetAdjustmentCooldown = BUDGET_ADJUST_COOLDOWN_FRAMES;
          this._budgetLowFrames = 0;
          this.emit('budget-relaxed', { ratio, newBudget: this.byteBudget });
        }
      }
    } else {
      this._budgetLowFrames = 0;
    }

    if (this._budgetAdjustmentCooldown > 0) {
      this._budgetAdjustmentCooldown--;
    }
  }

  _enqueue(key, run) {
    const existing = this._loadQueue.get(key);
    if (existing) return existing;
    const p = new Promise((resolve, reject) => {
      const task = { key, run, resolve, reject };
      if (this._inFlight < this.maxConcurrentFetches) this._runTask(task);
      else this._pending.push(task);
    });
    this._loadQueue.set(key, p);
    p.finally(() => this._loadQueue.delete(key));
    return p;
  }
  async _runTask(task) {
    this._inFlight++;
    try {
      const r = await task.run();
      task.resolve(r);
    } catch (e) {
      task.reject(e);
    } finally {
      this._inFlight--;
      if (this._pending.length && this._inFlight < this.maxConcurrentFetches) {
        this._runTask(this._pending.shift());
      }
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const e of [...this._entities]) e.dispose();
    for (const asset of this._assets.values()) asset.dispose();
    this._assets.clear();
    this._loadQueue.clear();
    if (this._impostorTier) {
      if (this.scene && this._impostorTier.mesh) this.scene.remove(this._impostorTier.mesh);
      this._impostorTier.dispose();
      this._impostorTier = null;
    }
    if (this._batchedFarTier) {
      const m = this._batchedFarTier.mesh;
      if (this.scene && m) this.scene.remove(m);
      m?.geometry?.dispose?.();
      m?.material?.dispose?.();
      m?.dispose?.();
      this._batchedFarTier = null;
    }
    if (this._materialBucketBatcher) {
      this._materialBucketBatcher.dispose();
      this._materialBucketBatcher = null;
    }
  }
}
