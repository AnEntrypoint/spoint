import * as THREE from 'three';

const COARSE_INDEX_STREAM = 1;

function _extractCoarsestIndices(clusterSet, sourceIndexArray, lod0Count) {
  const clusters = clusterSet.clusters;
  let total = 0;
  for (const c of clusters) total += c.lods[c.lods.length - 1].count;
  if (total <= 0) return null;
  const Ctor = sourceIndexArray instanceof Uint32Array || total > 65535 ? Uint32Array : Uint16Array;
  const out = new Ctor(total);
  let o = 0;
  for (const c of clusters) {
    const lod = c.lods[c.lods.length - 1];
    const streamBaseOffset = lod.stream === COARSE_INDEX_STREAM ? lod0Count : 0;
    for (let i = 0; i < lod.count; i++) out[o++] = sourceIndexArray[streamBaseOffset + lod.offset + i];
  }
  return out;
}

function _buildCoarsestGeometry(cm) {
  const idxAttr = cm.geometry.index;
  if (!idxAttr) return null;
  const coarse = _extractCoarsestIndices(cm.clusterSet, idxAttr.array, cm.lod0Count);
  if (!coarse) return null;
  const geo = new THREE.BufferGeometry();
  for (const key of ['position', 'normal', 'uv', 'tangent']) {
    const src = cm.geometry.attributes[key];
    if (src) geo.setAttribute(key, src);
  }
  geo.setIndex(new THREE.BufferAttribute(coarse, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

export class MaterialBucketBatcher {
  constructor(pool, opts = {}) {
    this.pool = pool;
    this.maxInstances = opts.maxInstances ?? 1024;
    this.maxVerts = opts.maxVerts ?? 1_500_000;
    this.maxIndex = opts.maxIndex ?? 3_000_000;
    this._buckets = new Map();
    this._entityBucket = new Map();
    this.stats = { bucketCount: 0, instanceCount: 0, drawCallsSaved: 0 };
  }

  _bucketFor(bucketKey, seedMaterial) {
    let b = this._buckets.get(bucketKey);
    if (b) return b;
    const material = Array.isArray(seedMaterial) ? seedMaterial[0] : seedMaterial;
    const mesh = new THREE.BatchedMesh(this.maxInstances, this.maxVerts, this.maxIndex, material);
    mesh.frustumCulled = false;
    mesh.perObjectFrustumCulled = true;
    mesh.sortObjects = false;
    mesh.name = `material-bucket-${bucketKey}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    b = { mesh, material, geometryIds: new Map(), instances: new Map() };
    this._buckets.set(bucketKey, b);
    if (this.pool.scene) this.pool.scene.add(mesh);
    this.stats.bucketCount = this._buckets.size;
    return b;
  }

  acquire(entity, bucketKey, sourceKey, cm, seedMaterial) {
    const b = this._bucketFor(bucketKey, seedMaterial);
    let gid = b.geometryIds.get(sourceKey);
    if (gid == null) {
      const geo = _buildCoarsestGeometry(cm);
      if (!geo) return -1;
      try {
        gid = b.mesh.addGeometry(geo);
      } catch (e) {
        b.mesh.setGeometrySize(this.maxVerts *= 2, this.maxIndex *= 2);
        gid = b.mesh.addGeometry(geo);
      }
      b.geometryIds.set(sourceKey, gid);
    }
    let id = b.instances.get(entity);
    if (id == null) {
      try {
        id = b.mesh.addInstance(gid);
      } catch (e) {
        b.mesh.setInstanceCount(this.maxInstances *= 2);
        id = b.mesh.addInstance(gid);
      }
      b.instances.set(entity, id);
      this._entityBucket.set(entity, bucketKey);
      this.stats.instanceCount++;
      this.stats.drawCallsSaved = this.stats.instanceCount - this.stats.bucketCount;
    } else {
      b.mesh.setGeometryIdAt(id, gid);
    }
    return id;
  }

  release(entity) {
    const bucketKey = this._entityBucket.get(entity);
    if (bucketKey == null) return;
    const b = this._buckets.get(bucketKey);
    if (!b) return;
    const id = b.instances.get(entity);
    if (id == null) return;
    b.instances.delete(entity);
    this._entityBucket.delete(entity);
    b.mesh.deleteInstance(id);
    this.stats.instanceCount--;
    this.stats.drawCallsSaved = Math.max(0, this.stats.instanceCount - this.stats.bucketCount);
  }

  setMatrix(entity, matrix) {
    const bucketKey = this._entityBucket.get(entity);
    if (bucketKey == null) return;
    const b = this._buckets.get(bucketKey);
    if (!b) return;
    const id = b.instances.get(entity);
    if (id == null) return;
    b.mesh.setMatrixAt(id, matrix);
  }

  has(entity) {
    return this._entityBucket.has(entity);
  }

  dispose() {
    for (const b of this._buckets.values()) {
      if (this.pool.scene) this.pool.scene.remove(b.mesh);
      b.mesh.dispose();
    }
    this._buckets.clear();
    this._entityBucket.clear();
    this.stats.bucketCount = 0;
    this.stats.instanceCount = 0;
    this.stats.drawCallsSaved = 0;
  }
}

export { _extractCoarsestIndices, _buildCoarsestGeometry };
export default { MaterialBucketBatcher };
