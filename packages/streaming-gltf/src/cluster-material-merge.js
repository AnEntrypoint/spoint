// Static-geometry material merging for cluster-LOD assets.
//
// Real problem measured live via client/core/RuntimeStats.js's drawCallAudit(scene,
// renderer): env-sillos alone spawns 96 separate ClusterLodMesh instances (one per
// source mesh in the baked GLB, see model-pool.js Entity._bootstrap), and 15 of
// their materials are ALREADY shared object-identity (m.material, same THREE
// Material instance) across 2-10 of those instances each -- yet every instance
// still issues its own separate draw call(s), because each is its own ClusterLodMesh
// with its own geometry.
//
// Every cluster-LOD mesh is static by construction: packages/streaming-gltf/AGENTS.md
// states skinned/morph-target primitives are explicitly excluded from the cluster-LOD
// bake path ("cluster-LOD is static-only"). So the "static, non-dynamic, non-animated"
// condition this merge is scoped to is satisfied for every entry model-pool.js's
// asset.clusterMeshes array can ever contain -- the real, remaining grouping key is
// material object identity, exactly what drawCallAudit already measures.
//
// This module runs ONCE per asset, at asset-prepare time (before any Entity spawns),
// on asset.clusterMeshes -- so the merge is amortized across every instance of that
// asset (matching the existing sharing model: N Entities of the same asset already
// share cm.geometry/cm.clusterSet before this merge; after it, entities share the
// merged record instead of N separate per-material records).
//
// WHAT GETS MERGED, PRECISELY: for every group of >=2 clusterMeshes entries sharing
// the exact same `material` object, concatenate:
//   - vertex attributes (position/normal/uv/tangent), with each source mesh's own
//     node-local transform (captured BEFORE attachClusterLod ran, i.e. the mesh's
//     matrixWorld within the glTF scene graph) baked into position (full affine
//     transform) and normal/tangent (linear part only, normals via the inverse-
//     transpose normal matrix, renormalized -- correct under non-uniform scale).
//   - the combined [LOD0|coarse] index streams, per-source vertex-index-offset
//     applied, promoted to Uint32 if the combined vertex/index range needs it.
//   - clusterSet.clusters[] records, with each cluster's lods[].offset shifted by
//     the RUNNING PER-STREAM (LOD0-stream vs coarse-stream, tracked independently
//     -- meshlet-codec.js's stream:0|1 tagging means offsets are stream-relative,
//     not buffer-global) offset, and aabb/sphere transformed by that source mesh's
//     own baked transform (so cluster spatial data is correct in the MERGED mesh's
//     local frame, since the merged ClusterLodMesh has one matrixWorld and its
//     _render transforms every cluster's aabb/sphere by it).
//
// This preserves ClusterLodMesh's real per-cluster frustum-cull + LOD-select
// mechanism completely unchanged -- merge only concatenates cluster RECORDS, it
// does not alter per-cluster semantics, so the merged mesh still frustum-culls and
// LOD-selects each original cluster independently, just via ONE shared geometry/
// draw-call-issuing object instead of N.

import * as THREE from 'three';

const _m3 = new THREE.Matrix3();
const _v3 = new THREE.Vector3();
const _identity = new THREE.Matrix4();

// True when `m` is (numerically) the identity matrix -- mirrors model-pool.js
// Entity._bootstrap's isRelIdentity fast-path check (relToRoot.equals(_identityMatrix)),
// so a source mesh with no additional node offset skips the transform math entirely
// and just copies, avoiding float round-off drift on the common case (most static
// props sit at their glTF-authored node transform with no extra offset).
function _isIdentity(m) {
  return m.equals(_identity);
}

// Flatten a BufferAttribute OR InterleavedBufferAttribute into a fresh, tightly-
// packed Float32Array of exactly count*itemSize values. Reading `.array` directly
// is only safe for a plain (non-interleaved) Float32 BufferAttribute -- on an
// InterleavedBufferAttribute, `.array` is the ENTIRE shared interleaved buffer
// backing every attribute of that stream (position+normal+uv... all in one
// typed array), not a clean per-attribute slice, and its element count/byte
// layout has nothing to do with this attribute's own count*itemSize. Cluster-LOD
// source geometries loaded via THREE.GLTFLoader commonly ARE interleaved (glTF's
// own bufferView-sharing convention), so treating `.array` as this attribute's
// flat data silently reads garbage/out-of-range values and can make a later
// same-size assumption throw (observed live: `Float32Array.set` "offset is out
// of bounds" once a merge group's running vertOffset walked past the small
// per-attribute allocation sized off entries[0]'s NOMINAL itemSize while an
// interleaved source's raw `.array` was actually the whole multi-attribute
// buffer). packages/streaming-gltf/src/lod-worker.js's own bake path hits the
// exact same interleaved-vs-array hazard and already established the fix this
// mirrors: `isInterleavedBufferAttribute` (or any non-Float32 backing store)
// goes through the per-vertex `.getX/getY/getZ/getW` accessor API, which THREE
// implements correctly for both plain and interleaved attributes; only a
// confirmed plain Float32 BufferAttribute takes the fast byte-copy path.
function _flattenAttribute(attr) {
  const { count, itemSize } = attr;
  if (!attr.isInterleavedBufferAttribute && attr.array instanceof Float32Array) {
    // Plain, already-flat, already-Float32 -- copy out (never alias the source
    // geometry's own live buffer; callers mutate the returned array in place).
    return Float32Array.from(attr.array);
  }
  const out = new Float32Array(count * itemSize);
  for (let i = 0; i < count; i++) {
    if (itemSize >= 1) out[i * itemSize + 0] = attr.getX(i);
    if (itemSize >= 2) out[i * itemSize + 1] = attr.getY(i);
    if (itemSize >= 3) out[i * itemSize + 2] = attr.getZ(i);
    if (itemSize >= 4) out[i * itemSize + 3] = attr.getW(i);
  }
  return out;
}

// Bake `matrix` into a fresh copy of a position/normal/tangent attribute array.
// kind: 'position' | 'normal' | 'tangent' | other (copied as-is, e.g. uv).
function _bakeAttribute(name, srcArray, itemSize, matrix, normalMatrix) {
  const count = srcArray.length / itemSize;
  const out = new Float32Array(srcArray.length);
  if (name === 'position') {
    for (let i = 0; i < count; i++) {
      const o = i * itemSize;
      _v3.set(srcArray[o], srcArray[o + 1], srcArray[o + 2]).applyMatrix4(matrix);
      out[o] = _v3.x; out[o + 1] = _v3.y; out[o + 2] = _v3.z;
      for (let c = 3; c < itemSize; c++) out[o + c] = srcArray[o + c];
    }
  } else if (name === 'normal') {
    for (let i = 0; i < count; i++) {
      const o = i * itemSize;
      _v3.set(srcArray[o], srcArray[o + 1], srcArray[o + 2]).applyMatrix3(normalMatrix).normalize();
      out[o] = _v3.x; out[o + 1] = _v3.y; out[o + 2] = _v3.z;
      for (let c = 3; c < itemSize; c++) out[o + c] = srcArray[o + c];
    }
  } else if (name === 'tangent') {
    // Tangent transforms covariantly like position's linear part (NOT the
    // inverse-transpose normal matrix -- only normals need that contravariant
    // correction under non-uniform scale). itemSize is 4 (xyz + handedness w);
    // w is copied unchanged.
    for (let i = 0; i < count; i++) {
      const o = i * itemSize;
      _v3.set(srcArray[o], srcArray[o + 1], srcArray[o + 2]).transformDirection(matrix).normalize();
      out[o] = _v3.x; out[o + 1] = _v3.y; out[o + 2] = _v3.z;
      for (let c = 3; c < itemSize; c++) out[o + c] = srcArray[o + c];
    }
  } else {
    out.set(srcArray);
  }
  return out;
}

// Transform a local-space AABB (as the flat [minx,miny,minz,maxx,maxy,maxz] array
// meshlet-codec.js stores) by `matrix`, re-fitting axis-aligned bounds under
// rotation (matches ClusterLodMesh._render's own _box.applyMatrix4 pattern).
const _box = new THREE.Box3();
function _transformAabb(aabb, matrix) {
  _box.min.set(aabb[0], aabb[1], aabb[2]);
  _box.max.set(aabb[3], aabb[4], aabb[5]);
  _box.applyMatrix4(matrix);
  return [_box.min.x, _box.min.y, _box.min.z, _box.max.x, _box.max.y, _box.max.z];
}

function _transformSphere(sphere, matrix, scale) {
  _v3.set(sphere[0], sphere[1], sphere[2]).applyMatrix4(matrix);
  return [_v3.x, _v3.y, _v3.z, sphere[3] * scale];
}

function _maxScaleOf(matrix) {
  const e = matrix.elements;
  const sq0 = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
  const sq1 = e[4] * e[4] + e[5] * e[5] + e[6] * e[6];
  const sq2 = e[8] * e[8] + e[9] * e[9] + e[10] * e[10];
  return Math.sqrt(Math.max(sq0, sq1, sq2));
}

// Merge one group (>=2 entries) of clusterMeshes records sharing the same material
// into a single {geometry, material, clusterSet, lod0Count, materialBucket} record.
// `entries`: [{ geometry, material, clusterSet, lod0Count, materialBucket, matrix }]
// where `matrix` is the source mesh's OWN node-local transform (identity if none).
function _mergeGroup(entries) {
  const material = entries[0].material;

  // Attribute set = intersection of names present on every source geometry (a
  // missing attribute on any one source cannot be synthesized, so it is dropped
  // from the merge output entirely rather than left partially undefined).
  let attrNames = null;
  for (const e of entries) {
    const names = Object.keys(e.geometry.attributes);
    attrNames = attrNames === null ? new Set(names) : new Set(names.filter((n) => attrNames.has(n)));
  }
  if (!attrNames || !attrNames.has('position')) return null;

  // Pass 1: totals, per-source baked attribute arrays, per-source vertex-index
  // offset and per-stream (LOD0 vs coarse) index offset.
  let totalVerts = 0;
  let lod0TotalIdx = 0, coarseTotalIdx = 0;
  const perSource = [];
  for (const e of entries) {
    const posAttr = e.geometry.attributes.position;
    const vcount = posAttr.count;
    const matrix = e.matrix;
    const identity = _isIdentity(matrix);
    let normalMatrix = null;
    let scale = 1;
    if (!identity) {
      normalMatrix = _m3.getNormalMatrix(matrix);
      scale = _maxScaleOf(matrix);
    }
    const baked = {};
    for (const name of attrNames) {
      const attr = e.geometry.attributes[name];
      const flat = _flattenAttribute(attr); // never read attr.array raw -- see _flattenAttribute's own comment (interleaved-buffer hazard)
      baked[name] = identity
        ? flat
        : _bakeAttribute(name, flat, attr.itemSize, matrix, normalMatrix);
    }
    const idxAttr = e.geometry.index;
    if (!idxAttr) return null; // cluster-LOD meshes are always indexed; bail out of the whole merge if not

    perSource.push({
      e, vcount, baked,
      vertOffset: totalVerts,
      lod0Offset: lod0TotalIdx,
      coarseOffset: coarseTotalIdx,
      idxArray: idxAttr.array,
      identity, matrix, scale,
    });
    totalVerts += vcount;

    // Count this source's own LOD0-stream / coarse-stream index totals from its
    // cluster records (authoritative -- do not assume the full index array splits
    // evenly, lod0Count is the real boundary).
    let srcLod0 = 0, srcCoarse = 0;
    for (const c of e.clusterSet.clusters) {
      for (const lod of c.lods) {
        if (lod.stream === 1) srcCoarse += lod.count; else srcLod0 += lod.count;
      }
    }
    lod0TotalIdx += srcLod0;
    coarseTotalIdx += srcCoarse;
  }

  if (totalVerts === 0) return null;

  // Dtype: promote to Uint32 if the combined vertex count needs it, OR (matching
  // attachClusterLod's own dual-check discipline) any real index value in either
  // stream exceeds 65535 -- a vertex-count check alone can miss a malformed/
  // hand-baked coarse accessor whose indices exceed the nominal count.
  let needsU32 = totalVerts > 65535;
  if (!needsU32) {
    outer: for (const ps of perSource) {
      const arr = ps.idxArray;
      for (let i = 0; i < arr.length; i++) { if (arr[i] > 65535) { needsU32 = true; break outer; } }
    }
  }
  const IdxCtor = needsU32 ? Uint32Array : Uint16Array;

  // Pass 2: allocate merged attribute buffers + copy baked per-source data in.
  const mergedAttrs = {};
  for (const name of attrNames) {
    const itemSize = entries[0].geometry.attributes[name].itemSize;
    const arr = new Float32Array(totalVerts * itemSize);
    for (const ps of perSource) {
      arr.set(ps.baked[name], ps.vertOffset * itemSize);
    }
    mergedAttrs[name] = { array: arr, itemSize };
  }

  // Pass 3: build merged [LOD0|coarse] index buffer + shift+concatenate cluster
  // records. lod0-stream indices land in [0, lod0TotalIdx); coarse-stream indices
  // land in [lod0TotalIdx, lod0TotalIdx+coarseTotalIdx) -- matching attachClusterLod's
  // own concatenation convention (combined = [lod0 | coarse], lod0Count = boundary).
  const mergedIndex = new IdxCtor(lod0TotalIdx + coarseTotalIdx);
  const mergedClusters = [];
  let lod0Write = 0, coarseWrite = lod0TotalIdx;

  for (const ps of perSource) {
    const { e, vertOffset, idxArray } = ps;
    for (const c of e.clusterSet.clusters) {
      const newLods = [];
      for (const lod of c.lods) {
        const srcBase = lod.stream === 1 ? e.lod0Count : 0; // element offset within the SOURCE's own combined buffer
        const destWriteStart = lod.stream === 1 ? coarseWrite : lod0Write;
        for (let i = 0; i < lod.count; i++) {
          mergedIndex[destWriteStart + i] = idxArray[srcBase + lod.offset + i] + vertOffset;
        }
        const newOffset = destWriteStart - (lod.stream === 1 ? lod0TotalIdx : 0);
        newLods.push({ offset: newOffset, count: lod.count, stream: lod.stream });
        if (lod.stream === 1) coarseWrite += lod.count; else lod0Write += lod.count;
      }
      const aabb = ps.identity ? c.aabb : _transformAabb(c.aabb, ps.matrix);
      const sphere = ps.identity ? c.sphere : _transformSphere(c.sphere, ps.matrix, ps.scale);
      mergedClusters.push({ aabb, sphere, lods: newLods });
    }
  }

  // Same coincident-vertex defense as attachClusterLod's own combine step (see that
  // function's comment in cluster-lod-mesh.js): a source vertex baked here can end up
  // at the exact same position as a different source's vertex after the affine
  // transform bake above, forming a NEW degenerate triangle this merge just created
  // that no per-primitive check upstream could have seen.
  const EPS = 1e-6;
  const mergedPosArr = mergedAttrs.position.array;
  for (let i = 0; i + 2 < mergedIndex.length; i += 3) {
    const a = mergedIndex[i], b = mergedIndex[i + 1], c = mergedIndex[i + 2];
    const ax = mergedPosArr[a * 3], ay = mergedPosArr[a * 3 + 1], az = mergedPosArr[a * 3 + 2];
    const bx = mergedPosArr[b * 3], by = mergedPosArr[b * 3 + 1], bz = mergedPosArr[b * 3 + 2];
    const cx = mergedPosArr[c * 3], cy = mergedPosArr[c * 3 + 1], cz = mergedPosArr[c * 3 + 2];
    const e1 = Math.hypot(ax - bx, ay - by, az - bz);
    const e2 = Math.hypot(bx - cx, by - cy, bz - cz);
    const e3 = Math.hypot(ax - cx, ay - cy, az - cz);
    if (e1 < EPS || e2 < EPS || e3 < EPS) { mergedIndex[i + 1] = a; mergedIndex[i + 2] = a; }
  }

  const geometry = new THREE.BufferGeometry();
  for (const name of attrNames) {
    const { array, itemSize } = mergedAttrs[name];
    geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
  }
  geometry.setIndex(new THREE.BufferAttribute(mergedIndex, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const clusterSet = { clusters: mergedClusters, materialBucket: entries[0].clusterSet.materialBucket || null };

  return {
    geometry,
    material,
    clusterSet,
    lod0Count: lod0TotalIdx,
    materialBucket: entries[0].materialBucket || null,
    _mergedSourceCount: entries.length,
    // Original clusterMeshes indices (pre-merge, traversal order) this record
    // consumes -- callers (Entity._bootstrap) use this instead of a positional
    // cursor walk, since merged output order is grouped by material and no
    // longer matches original traversal order.
    _sourceIndices: entries.map((e) => e._origIndex).sort((a, b) => a - b),
  };
}

// Public entry point. `clusterMeshes`: the asset-level array model-pool.js's
// _prepareAsset builds (each entry {geometry, material, clusterSet, lod0Count,
// materialBucket}). `nodeMatrices`: parallel array of each entry's own node-local
// THREE.Matrix4 (identity if the node has no additional transform relative to
// whatever frame the merge should output in -- for env-sillos-style single-Entity
// assets this is the glTF scene-local node transform, matching what
// Entity._bootstrap already computes per-mesh via _rootInv * src.matrixWorld).
//
// Returns a NEW array, same length semantics as input is not guaranteed (merged
// groups collapse to 1 entry each) -- ungrouped (size-1 material groups) entries
// pass through with their original geometry/matrix UNCHANGED (still needs the
// per-instance geometry.id wrapping model-pool.js's Entity._bootstrap already does,
// this module does not touch that).
//
// A source entry whose merge would be unsafe (missing index, missing position, zero
// vertices) is excluded from merging and returned as its own single-entry "group"
// unchanged, rather than silently dropped -- merging is a pure optimization, never
// allowed to lose geometry.
export function mergeClusterMeshesByMaterial(clusterMeshes, nodeMatrices) {
  if (!clusterMeshes || !clusterMeshes.length) return clusterMeshes || [];

  const byMaterial = new Map(); // material -> indices[]
  for (let i = 0; i < clusterMeshes.length; i++) {
    const mat = clusterMeshes[i].material;
    let list = byMaterial.get(mat);
    if (!list) { list = []; byMaterial.set(mat, list); }
    list.push(i);
  }

  const out = [];
  const consumed = new Set();
  for (const [, indices] of byMaterial) {
    if (indices.length < 2) continue; // nothing to merge for a singleton material group
    const entries = indices.map((i) => ({
      ...clusterMeshes[i],
      matrix: (nodeMatrices && nodeMatrices[i]) || _identity,
      _origIndex: i,
    }));
    const merged = _mergeGroup(entries);
    if (merged) {
      out.push(merged);
      for (const i of indices) consumed.add(i);
    }
    // merged === null (unsafe group, e.g. missing index/position on a member):
    // leave every member of this group unconsumed -> falls through to the
    // pass-through loop below, each kept as its own unmerged entry. No geometry
    // is ever silently dropped.
  }

  for (let i = 0; i < clusterMeshes.length; i++) {
    if (!consumed.has(i)) out.push({ ...clusterMeshes[i], _sourceIndices: [i] });
  }

  // Stable, traversal-consistent order: ascending by each record's own lowest
  // original index. mergeClusterMeshesByMaterial's own output otherwise groups
  // merged records first (Map iteration order) then pass-throughs -- callers
  // (Entity._bootstrap) that need to correlate a record back to the cloned
  // scene's mesh nodes rely on _sourceIndices directly, not positional order,
  // but sorting here keeps the array's iteration order intuitive for debugging/
  // drawCallAudit and avoids any accidental positional-order assumption elsewhere.
  out.sort((a, b) => a._sourceIndices[0] - b._sourceIndices[0]);

  return out;
}

export { _mergeGroup, _bakeAttribute, _transformAabb, _transformSphere };
export default { mergeClusterMeshesByMaterial };
