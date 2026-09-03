// Meshlet cluster-LOD codec ("EP_cluster_lod").
//
// UV-Aware Spatial Clustering with Hierarchical Index Packing. The whole mesh is
// divided into spatially coherent meshlets (clusters of <=maxTris triangles); for
// each cluster a hierarchy of UV-aware simplified LODs is generated; all clusters
// and their LODs are packed into ONE unified, reordered vertex buffer + one index
// buffer ordered [cluster0:lod0,lod1,..][cluster1:lod0,..]... so a GPU fetching a
// cluster's chosen LOD pulls a tiny contiguous block. Per (cluster,lod) we record
// {offset,count} into the index buffer plus a per-cluster AABB + bounding sphere,
// so the renderer can frustum-cull clusters and pick a LOD per cluster, then issue
// the visible index sub-ranges via WEBGL_multi_draw in a single draw call.
//
// The unified buffer is a STANDARD vertex/index buffer: a stock glTF viewer that
// ignores extras.EP_cluster_lod just draws the whole index buffer = LOD0 of every
// cluster = the full-resolution mesh. The cluster metadata lives only in extras
// (JSON) so the GLB stays 100% valid.
//
// BUILDER (buildClusterLod) lazily imports meshoptimizer and runs at bake time.
// The metadata SCHEMA + the reader (parseClusterLod) are dependency-free and run
// in the browser.

// v2: sphere center is no longer stored (it was only ever used as a cheap
// distance proxy for LOD selection, never the cull test -- the AABB is the real
// cull test and is untouched). The runtime derives center from the AABB midpoint
// at parse time instead; only radius is still baked. parseClusterLod stays
// backward-compatible with v1 payloads (sphere.length===4, stored center kept).
export const CLUSTER_LOD_VERSION = 2;
export const CLUSTER_LOD_EXTRA_KEY = 'EP_cluster_lod';

// ---------------------------------------------------------------- builder ----

let _meshopt = null;
async function _ensureMeshopt() {
  if (_meshopt) return _meshopt;
  const { MeshoptClusterizer, MeshoptSimplifier } = await import('meshoptimizer');
  await MeshoptClusterizer.ready;
  await MeshoptSimplifier.ready;
  _meshopt = { MeshoptClusterizer, MeshoptSimplifier };
  return _meshopt;
}

// Synthesize a sequential index for non-indexed triangle soup (some primitives
// arrive non-indexed). A raw sequential index has no shared edges so simplify
// cannot reduce it; callers that need real decimation should weld first, but
// clustering + LOD0 still work on the soup.
function _seqIndex(vertCount) {
  const ix = new Uint32Array(vertCount);
  for (let i = 0; i < vertCount; i++) ix[i] = i;
  return ix;
}

// One attribute stream description: {name, array(Float32Array|TypedArray),
// itemSize, normalized}. POSITION is required and must be name 'position'.
//
// opts:
//   maxVertices (64), maxTriangles (128), minTriangles (max(1,maxTriangles>>2)),
//   coneOrFillWeight (0.5),
//   lodRatios ([1, 0.5, 0.25]) - target index fraction per LOD relative to the
//     cluster's LOD0 triangle count,
//   lodError (0.05) - relative target error passed to simplify,
//   uvAware (true) - weight TEXCOORD_0 in the QEM so UV seams are preserved.
//
// Returns:
//   {
//     vertexCount, attributes: [{name,itemSize,normalized, array}],  // unified, reordered
//     index: Uint32Array,                                            // unified
//     clusters: [{ aabb:[minx,miny,minz,maxx,maxy,maxz],
//                  sphere:[cx,cy,cz,r],
//                  lods:[{offset,count}] }],   // offset/count into `index`
//     lodCount,
//   }
export async function buildClusterLod(geo, opts = {}) {
  const { MeshoptClusterizer: C, MeshoptSimplifier: S } = await _ensureMeshopt();

  const maxVertices = opts.maxVertices || 64;
  const maxTriangles = opts.maxTriangles || 128;
  const minTriangles = opts.minTriangles || Math.max(1, maxTriangles >> 2);
  const fillWeight = opts.coneOrFillWeight != null ? opts.coneOrFillWeight : 0.5;
  const lodRatios = opts.lodRatios || [1, 0.5, 0.25];
  const lodError = opts.lodError != null ? opts.lodError : 0.05;
  const uvAware = opts.uvAware !== false;

  const attrs = geo.attributes;
  const posAttr = attrs.find((a) => a.name === 'position');
  if (!posAttr) throw new Error('buildClusterLod: missing position attribute');
  const srcVertCount = posAttr.array.length / posAttr.itemSize;

  // meshopt wants tightly packed Float32 xyz with stride in FLOATS.
  const position =
    posAttr.array instanceof Float32Array && posAttr.itemSize === 3
      ? posAttr.array
      : _toFloat32Vec3(posAttr.array, posAttr.itemSize);

  const index = geo.index ? _toUint32(geo.index) : _seqIndex(srcVertCount);

  // UV stream for attribute-aware simplify (preserves texture mapping).
  const uvAttr = uvAware ? attrs.find((a) => a.name === 'uv' || a.name === 'texcoord_0') : null;
  const uvArr = uvAttr ? _toFloat32(uvAttr.array, uvAttr.itemSize, 2) : null;

  // 1. Spatial clustering into meshlets.
  const mb = C.buildMeshletsSpatial(
    index,
    position,
    3,
    maxVertices,
    minTriangles,
    maxTriangles,
    fillWeight
  );
  const bounds = C.computeMeshletBounds(mb, position, 3);

  // 2..3. Per cluster: LOD0 = the cluster's own triangles (global vertex ids);
  // LOD1..N = UV-aware simplifications. Pack everything into a fresh, reordered
  // unified vertex buffer (vertices appended in first-seen order across the
  // packed index stream -> contiguous per cluster for GPU fetch locality).
  const lodCount = lodRatios.length;
  const remap = new Int32Array(srcVertCount).fill(-1); // old vid -> new vid
  // new vid -> old vid; grown as a typed array (avoids boxed-number push churn on
  // multi-million-vertex meshes). Capacity bounded by srcVertCount (no vertex is
  // appended twice).
  const newOrder = new Uint32Array(srcVertCount);
  let newOrderLen = 0;
  // TWO index streams so a stock viewer drawing primitive.indices renders exactly
  // the full-res mesh: index0 = LOD0 of every cluster (-> primitive.indices);
  // indexCoarse = LOD1..N (-> a sidecar accessor referenced from extras). A
  // cluster's lods[0].offset/count index into index0; lods[1..] into indexCoarse.
  // `stream:0|1` tags which buffer the range lives in. Both are growable typed
  // arrays (Grow) rather than JS arrays: the index streams reach millions of
  // entries, and Array.push of boxed numbers + a trailing Uint32Array.from copy was
  // the dominant JS cost on large meshes.
  const index0 = new _Grow();
  const indexCoarse = new _Grow();
  const clusters = [];

  // Append `glob[0..n)` (global vertex ids) to `stream`, remapping each to the
  // shared vertex table, and return {offset, count, stream:streamTag}.
  const appendTo = (stream, streamTag, glob, n) => {
    const offset = stream.length;
    for (let i = 0; i < n; i++) {
      const old = glob[i];
      let nv = remap[old];
      if (nv === -1) {
        nv = newOrderLen;
        remap[old] = nv;
        newOrder[newOrderLen++] = old;
      }
      stream.push(nv);
    }
    return { offset, count: n, stream: streamTag };
  };

  const uvW = uvArr ? _uvWeights(uvAttr) : null;
  // Reusable per-cluster scratch (clusters are <=maxVertices verts, <=maxTriangles
  // tris, so these fixed caps never overflow). Reused across all meshlets to avoid
  // 4 typed-array allocations per cluster.
  const localPos = new Float32Array(maxVertices * 3);
  const localUv = uvArr ? new Float32Array(maxVertices * 2) : null;
  const maxLocalIdx = maxTriangles * 3;
  const lod0LocalU32 = new Uint32Array(maxLocalIdx);
  const glob = new Uint32Array(maxLocalIdx);
  for (let m = 0; m < mb.meshletCount; m++) {
    const mesh = C.extractMeshlet(mb, m);
    const clusterVerts = mesh.vertices; // global vertex ids in this meshlet (<=maxVertices)

    // Fill the COMPACT per-cluster vertex table (positions + uvs) so simplify runs
    // against tiny arrays, not the full-mesh arrays. Passing the whole 500k-vertex
    // position array per cluster per LOD is O(clusters * lods * totalVerts) and
    // pathologically slow on large meshes — local tables make each simplify O(64).
    const lv = clusterVerts.length;
    for (let i = 0; i < lv; i++) {
      const g = clusterVerts[i];
      localPos[i * 3] = position[g * 3]; localPos[i * 3 + 1] = position[g * 3 + 1]; localPos[i * 3 + 2] = position[g * 3 + 2];
      if (localUv) { localUv[i * 2] = uvArr[g * 2]; localUv[i * 2 + 1] = uvArr[g * 2 + 1]; }
    }
    const localPosV = lv === maxVertices ? localPos : localPos.subarray(0, lv * 3);
    const localUvV = !localUv ? null : (lv === maxVertices ? localUv : localUv.subarray(0, lv * 2));
    // LOD0 as LOCAL indices (into clusterVerts); mesh.triangles are already local.
    const lod0Local = mesh.triangles; // Uint8Array of local vertex ids
    const l0n = lod0Local.length;
    for (let i = 0; i < l0n; i++) lod0LocalU32[i] = lod0Local[i];
    const lod0LocalV = lod0LocalU32.subarray(0, l0n);

    const lods = [];
    let prevLocal = lod0LocalV;
    for (let l = 0; l < lodCount; l++) {
      let local;
      if (l === 0) {
        local = lod0LocalV;
      } else {
        const tRaw = Math.round(l0n * lodRatios[l]);
        const targetIdx = Math.max(3, tRaw - (tRaw % 3));
        if (targetIdx >= prevLocal.length) {
          local = prevLocal;
        } else {
          const [si] = localUvV
            ? S.simplifyWithAttributes(prevLocal, localPosV, 3, localUvV, 2, uvW, null, targetIdx, lodError, ['LockBorder'])
            : S.simplify(prevLocal, localPosV, 3, targetIdx, lodError, ['LockBorder']);
          local = si.length >= 3 ? si : prevLocal;
        }
      }
      prevLocal = local;
      // map local ids -> global ids into the shared scratch, then append
      const ln = local.length;
      for (let i = 0; i < ln; i++) glob[i] = clusterVerts[local[i]];
      lods.push(l === 0 ? appendTo(index0, 0, glob, ln) : appendTo(indexCoarse, 1, glob, ln));
    }

    const b = bounds[m];
    // AABB from the cluster's LOD0 vertices (global ids via clusterVerts).
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < l0n; i++) {
      const v = clusterVerts[lod0Local[i]];
      const x = position[v * 3], y = position[v * 3 + 1], z = position[v * 3 + 2];
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    clusters.push({
      aabb: [mnx, mny, mnz, mxx, mxy, mxz],
      sphere: [b.centerX, b.centerY, b.centerZ, b.radius],
      lods,
    });
  }

  // 4. Build the reordered unified attribute buffers in newOrder.
  const newVertCount = newOrderLen;
  const outAttrs = attrs.map((a) => {
    const Ctor = a.array.constructor;
    const src = a.array;
    const sz = a.itemSize;
    const out = new Ctor(newVertCount * sz);
    for (let nv = 0; nv < newVertCount; nv++) {
      const base = newOrder[nv] * sz;
      const obase = nv * sz;
      for (let c = 0; c < sz; c++) out[obase + c] = src[base + c];
    }
    return { name: a.name, itemSize: sz, normalized: !!a.normalized, array: out };
  });

  // Emit Uint16 index buffers when the unified vertex table fits in 16 bits (the
  // common small/medium mesh case) -- up to 2x smaller shipped accessor data.
  // gltf-transform's Accessor.setArray() infers componentType from the TypedArray
  // class (UNSIGNED_SHORT vs UNSIGNED_INT), so this is a pure schema/size win with
  // no extra tag needed: the runtime (attachClusterLod in cluster-lod-mesh.js)
  // already re-derives its own combined-buffer index width dynamically from the
  // actual max vertex/index value present at load time, independent of whichever
  // width the source accessor used, so both widths round-trip correctly.
  const idxCtor = newVertCount <= 65536 ? Uint16Array : Uint32Array;
  return {
    vertexCount: newVertCount,
    attributes: outAttrs,
    index: index0.toTyped(idxCtor), // LOD0 of all clusters -> primitive.indices (stock full-res draw)
    indexCoarse: indexCoarse.toTyped(idxCtor), // LOD1..N -> sidecar accessor referenced from extras
    clusters,
    lodCount,
  };
}

// Growable Uint32 buffer: amortized O(1) push without boxed-number JS-array churn.
class _Grow {
  constructor(cap = 1024) { this.buf = new Uint32Array(cap); this.length = 0; }
  push(v) {
    if (this.length === this.buf.length) {
      const next = new Uint32Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = v;
  }
  toUint32() { return this.buf.subarray(0, this.length).slice(); }
  // Copy into a differently-typed array (e.g. Uint16Array) when every stored value
  // fits -- caller (buildClusterLod) already guarantees this via newVertCount.
  toTyped(Ctor) {
    if (Ctor === Uint32Array) return this.toUint32();
    const out = new Ctor(this.length);
    out.set(this.buf.subarray(0, this.length));
    return out;
  }
}

// UV weights: heavier weight = stronger penalty on collapsing edges that distort
// UVs, which keeps texture mapping intact (the "UV-aware" penalty).
function _uvWeights(uvAttr) {
  const n = uvAttr ? Math.min(uvAttr.itemSize, 2) : 2;
  const w = [];
  for (let i = 0; i < n; i++) w.push(0.5);
  return w;
}

function _toUint32(arr) {
  return arr instanceof Uint32Array ? arr : Uint32Array.from(arr);
}
function _toFloat32Vec3(arr, itemSize) {
  const n = arr.length / itemSize;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = arr[i * itemSize];
    out[i * 3 + 1] = arr[i * itemSize + 1];
    out[i * 3 + 2] = arr[i * itemSize + 2];
  }
  return out;
}
function _toFloat32(arr, itemSize, want) {
  if (arr instanceof Float32Array && itemSize === want) return arr;
  const n = arr.length / itemSize;
  const out = new Float32Array(n * want);
  for (let i = 0; i < n; i++) for (let c = 0; c < want; c++) out[i * want + c] = arr[i * itemSize + c] || 0;
  return out;
}

// --------------------------------------------------------- extras schema ----

// Build the JSON metadata object stored at primitive.extras[CLUSTER_LOD_EXTRA_KEY].
// Stock viewers ignore extras and draw the full index buffer (= LOD0 of all
// clusters = full mesh). For meshes with very many clusters the caller may instead
// store the bounds/offset/count arrays as a packed glTF accessor and reference it
// here (packed:true); the inline form below is the simple JSON path.
// `coarseIndexAccessor` is the glTF accessor index for the LOD1..N index buffer
// (set by the baker after it creates that accessor). lods entries are
// [offset, count, stream] where stream 0 = primitive.indices (LOD0), 1 = the
// coarse accessor.
// materialBucket: optional short hash string (see material-convergence.js's
// stampMaterialBucketKeys / MATERIAL_BUCKET_EXTRAS_KEY) identifying this
// primitive's material's rendering-relevant convergence bucket. Two cluster
// primitives -- even in DIFFERENT baked GLBs -- carrying the same materialBucket
// render identically (same texture content + PBR factors), which is the signal
// src/material-bucket-batcher.js's runtime BatchedMesh consumer keys on to
// collapse their coarsest-LOD draws into one shared draw call. Omitted (absent
// key, not null) for bakes that predate this field or ran without a resolvable
// material -- parseClusterLod treats that as "not a batching candidate",
// never as a crash/validation failure (purely additive metadata).
export function buildClusterLodExtra(result, coarseIndexAccessor = -1, materialBucket = null) {
  const extra = {
    version: CLUSTER_LOD_VERSION,
    clusterCount: result.clusters.length,
    lodCount: result.lodCount,
    coarseIndexAccessor,
    coarseIndexCount: result.indexCoarse.length,
    clusters: result.clusters.map((c) => ({
      aabb: c.aabb.map(_round),
      // v2: radius-only -- center is re-derived from the AABB midpoint by the
      // reader (parseClusterLod), since it was only ever used as a LOD-distance
      // proxy (the AABB midpoint is well within the existing LOD hysteresis
      // tolerance vs. the "true" bounding-sphere center).
      sphere: [_round(c.sphere[3])],
      lods: c.lods.map((l) => [l.offset, l.count, l.stream]),
    })),
  };
  if (materialBucket) extra.materialBucket = materialBucket;
  return extra;
}
function _round(v) {
  return Math.round(v * 1e4) / 1e4;
}

// ----------------------------------------------------------------- reader ----

// Parse extras.EP_cluster_lod into a normalized ClusterSet. Dependency-free,
// browser-safe. Returns null when the extra is absent/invalid (caller falls back
// to full-draw = stock behavior).
// Structural validation for one raw cluster entry from possibly-hand-edited or
// corrupted extras JSON. A truncated/malformed aabb, sphere, or lods entry would
// otherwise silently produce NaN/undefined that corrupts frustum culling and
// draw ranges far downstream (attachClusterLod, ClusterLodMesh) instead of
// failing loud at the one place that actually understands the schema.
function _isValidRawCluster(c) {
  if (!c || typeof c !== 'object') return false;
  if (!Array.isArray(c.aabb) || c.aabb.length !== 6 || !c.aabb.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  // v1 sphere = [cx,cy,cz,r] (stored center); v2 sphere = [r] (radius-only, center
  // derived from the AABB midpoint below).
  if (!Array.isArray(c.sphere) || (c.sphere.length !== 4 && c.sphere.length !== 1) || !c.sphere.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  if (!Array.isArray(c.lods) || !c.lods.length) return false;
  for (const l of c.lods) {
    const offset = Array.isArray(l) ? l[0] : l?.offset;
    const count = Array.isArray(l) ? l[1] : l?.count;
    if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0) return false;
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return false;
  }
  return true;
}

export function parseClusterLod(extras) {
  const meta = extras && extras[CLUSTER_LOD_EXTRA_KEY];
  if (!meta || !Array.isArray(meta.clusters) || !meta.clusters.length) return null;
  // Fail-open (same contract as the length/array checks above): any structurally
  // malformed cluster entry invalidates the whole payload rather than letting
  // NaN/undefined values propagate into culling/draw-range math.
  if (!meta.clusters.every(_isValidRawCluster)) return null;
  const clusters = meta.clusters.map((c) => {
    // v1 sphere = [cx,cy,cz,r] (center as-baked); v2 sphere = [r] (radius-only) --
    // derive center from the AABB midpoint once here at parse time (cheap, not
    // per-frame). The AABB midpoint is well within the existing LOD-selection
    // hysteresis tolerance vs. the "true" bounding-sphere center it replaces.
    const sphere = c.sphere.length === 4
      ? c.sphere
      : [
          (c.aabb[0] + c.aabb[3]) * 0.5,
          (c.aabb[1] + c.aabb[4]) * 0.5,
          (c.aabb[2] + c.aabb[5]) * 0.5,
          c.sphere[0],
        ];
    return {
      aabb: c.aabb,
      sphere,
      lods: c.lods.map((l) =>
        Array.isArray(l)
          ? { offset: l[0], count: l[1], stream: l[2] || 0 }
          : { offset: l.offset, count: l.count, stream: l.stream || 0 }
      ),
    };
  });
  return {
    version: meta.version || 1,
    lodCount: meta.lodCount || (clusters[0] && clusters[0].lods.length) || 1,
    coarseIndexAccessor: meta.coarseIndexAccessor != null ? meta.coarseIndexAccessor : -1,
    coarseIndexCount: meta.coarseIndexCount || 0,
    // Optional (see buildClusterLodExtra's comment) -- absent on bakes that
    // predate this field. Consumers must treat null/undefined as "not a
    // known batching candidate", never coerce to a falsy-but-valid bucket id.
    materialBucket: typeof meta.materialBucket === 'string' && meta.materialBucket ? meta.materialBucket : null,
    clusters,
  };
}
