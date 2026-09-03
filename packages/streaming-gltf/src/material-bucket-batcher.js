// material-bucket-batcher.js -- the runtime consumer for material-convergence.js's
// bake-time output (materialConvergenceReport / collapseTrivialMaterialVariants /
// stampMaterialBucketKeys). See that file's header for the full scope note; this
// is the FIRST reachable tier of the "BatchedMesh/InstancedMesh2 runtime consumer
// for the index" the module explicitly deferred.
//
// SCOPE (honest, not the full texture-array-atlas vision): a full texture-array-
// atlas + uber-shader pass needs UV remapping, texture packing, KTX2 array-layer
// encoding, and a per-instance material-index attribute feeding a shared uber
// shader -- real, multi-week rendering work this file does NOT attempt. What this
// file DOES do, for real: cluster-LOD assets baked with an EXACT matching
// EP_material_bucket hash (see meshlet-codec.js's buildClusterLodExtra /
// parseClusterLod) -- meaning they are PROVEN to render identically, same texture
// bytes + same PBR factors, not merely similar -- share ONE real THREE.BatchedMesh
// draw call at their COARSEST available cluster LOD tier. This mirrors
// batched-far-tier.js's BatchedFarTier exactly (same slotAdapter interface,
// same "far/low-detail tier is where per-instance draw-call reduction matters
// most, per-cluster fine LOD selection is preserved for near/hero detail" design),
// generalized from "one BatchedMesh per discrete-LOD far asset" to "one
// BatchedMesh per material-convergence bucket across N distinct cluster-LOD
// assets". Near/hero-detail draws keep going through ClusterLodMesh's real
// per-cluster frustum-cull + hysteresis LOD selection UNCHANGED -- this tier only
// ever holds an entity's WHOLE coarsest-LOD draw, swapped in/out exactly like the
// octahedral-impostor final-LOD tier already does (see model-pool.js Entity._update's
// pool._useImpostorFinalLod screenPx gate, the established precedent this reuses).
//
// Why coarsest-LOD-only, not every LOD: BatchedMesh's per-instance geometry
// (setGeometryIdAt) already gives a synchronous swap primitive, but registering
// EVERY cluster's EVERY LOD tier as a separate BatchedMesh geometry per entity
// would multiply the shared vertex/index buffer budget by lodCount for zero
// benefit at the far distance this tier is gated to -- coarsest is the one tier
// where "draw the whole entity as a single low-poly blob" and "share one draw
// call across many distinct assets" are simultaneously true and simultaneously
// cheap. This is a strict superset win over the status quo (cluster entities
// currently have ZERO cross-asset batching at ANY distance -- useBatchedFarTier
// only ever wired into the discrete-LOD/meshLodDescs path, never clusterMeshes).

import * as THREE from 'three';

// Concatenate every cluster's COARSEST available LOD index range (last entry in
// cluster.lods) into one flat index array referencing the mesh's existing shared
// vertex attributes. Returns null when the mesh has no usable coarse data (a
// mesh with lodCount===1 has no separate coarse tier -- its "coarsest" IS LOD0,
// still valid to batch, just not smaller than the hero draw).
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
    const base = lod.stream === 1 ? lod0Count : 0; // stream 0 = LOD0 region, 1 = coarse region (matches _byteOffset in cluster-lod-mesh.js)
    for (let i = 0; i < lod.count; i++) out[o++] = sourceIndexArray[base + lod.offset + i];
  }
  return out;
}

// Build a standalone (non-shared-index) BufferGeometry holding just the coarsest
// draw for one cluster mesh, suitable for THREE.BatchedMesh.addGeometry. Vertex
// attributes are referenced AS-IS (BatchedMesh copies attribute data into its own
// shared buffers on addGeometry, so sharing the source TypedArray here costs no
// extra CPU-side memory beyond the new index array).
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
    // One BatchedMesh PER material bucket (each bucket has visually distinct
    // texture content, so each needs its own real material -- unlike
    // BatchedFarTier's single unlit-vertex-color material shared by every far
    // asset, a bucket batcher must actually sample the bucket's real texture).
    // bucketKey -> { mesh, material, geometryIds: Map<sourceKey, gid>, instances: Map<entity, id> }
    this._buckets = new Map();
    this._entityBucket = new Map(); // entity -> bucketKey (release needs to find the right bucket)
    // Live stats for the browser/exec_js witness surface (parity with the other
    // tiers' `stats`/`this.pool.stats` conventions in this file).
    this.stats = { bucketCount: 0, instanceCount: 0, drawCallsSaved: 0 };
  }

  // Real materials are per-bucket (distinct texture content per bucket), built
  // once from the FIRST cluster mesh's own material seen for that bucket --
  // every later addition to the same bucket is, by the bucket-hash contract,
  // provably rendering-identical, so reusing the first member's THREE.Material
  // is correct, not an approximation.
  _bucketFor(bucketKey, seedMaterial) {
    let b = this._buckets.get(bucketKey);
    if (b) return b;
    // A ClusterLodMesh's .material can be a single-element ARRAY (GLTFLoader
    // sometimes assigns mesh.material=[mat] even for a one-primitive mesh) --
    // THREE.BatchedMesh has no multi-material/geometry-groups draw path (its
    // own internal geometry.groups always stays empty; it dispatches purely
    // via _multiDrawStarts/_multiDrawCounts), so handing it an array material
    // doesn't throw but silently makes it undrawable: WebGLRenderer's
    // projectObject only pushes a Mesh into the render list, for an array
    // material, by iterating geometry.groups -- an empty groups array means
    // that loop body never runs, so the object is NEVER added to the render
    // list and NEVER draws, with no error anywhere (confirmed live: 0 draw
    // calls despite correct geometry/instances/frustum/visibility state).
    // Unwrap to the single real material so BatchedMesh gets what it expects.
    const material = Array.isArray(seedMaterial) ? seedMaterial[0] : seedMaterial;
    const mesh = new THREE.BatchedMesh(this.maxInstances, this.maxVerts, this.maxIndex, material);
    mesh.frustumCulled = false;
    mesh.perObjectFrustumCulled = true;
    mesh.sortObjects = false;
    mesh.name = `material-bucket-${bucketKey}`;
    // Same real gap as ClusterLodMesh (see model-pool.js's own comment): THREE.Object3D defaults
    // both to false, so this far-tier BatchedMesh silently never cast a shadow onto anything and
    // never received one -- an entity swapping into this tier at distance would visibly lose its
    // shadow interaction the instant it crossed the material-bucket threshold.
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    b = { mesh, material, geometryIds: new Map(), instances: new Map() };
    this._buckets.set(bucketKey, b);
    if (this.pool.scene) this.pool.scene.add(mesh);
    this.stats.bucketCount = this._buckets.size;
    return b;
  }

  // Register (once per distinct source cluster mesh) + acquire an instance.
  // `sourceKey` scopes geometry reuse to one entity's own asset+meshIndex (every
  // OTHER entity sharing that exact asset reuses the same registered geometry id,
  // matching BatchedFarTier's asset-keyed geometryId cache).
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
      // Every instance added past the first for a given bucket is one draw call
      // this tier collapsed vs. the per-entity ClusterLodMesh baseline.
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
