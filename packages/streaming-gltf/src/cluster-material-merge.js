import * as THREE from 'three';

const _m3 = new THREE.Matrix3();
const _v3 = new THREE.Vector3();
const _identity = new THREE.Matrix4();

function _isIdentity(m) {
  return m.equals(_identity);
}

function _flattenAttribute(attr) {
  const { count, itemSize } = attr;
  if (!attr.isInterleavedBufferAttribute && attr.array instanceof Float32Array) {
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

function _mergeGroup(entries) {
  const material = entries[0].material;

  let attrNames = null;
  for (const e of entries) {
    const names = Object.keys(e.geometry.attributes);
    attrNames = attrNames === null ? new Set(names) : new Set(names.filter((n) => attrNames.has(n)));
  }
  if (!attrNames || !attrNames.has('position')) return null;

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
      const flat = _flattenAttribute(attr);
      baked[name] = identity
        ? flat
        : _bakeAttribute(name, flat, attr.itemSize, matrix, normalMatrix);
    }
    const idxAttr = e.geometry.index;
    if (!idxAttr) return null;

    perSource.push({
      e, vcount, baked,
      vertOffset: totalVerts,
      lod0Offset: lod0TotalIdx,
      coarseOffset: coarseTotalIdx,
      idxArray: idxAttr.array,
      identity, matrix, scale,
    });
    totalVerts += vcount;

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

  let needsU32 = totalVerts > 65535;
  if (!needsU32) {
    outer: for (const ps of perSource) {
      const arr = ps.idxArray;
      for (let i = 0; i < arr.length; i++) { if (arr[i] > 65535) { needsU32 = true; break outer; } }
    }
  }
  const IdxCtor = needsU32 ? Uint32Array : Uint16Array;

  const mergedAttrs = {};
  for (const name of attrNames) {
    const itemSize = entries[0].geometry.attributes[name].itemSize;
    const arr = new Float32Array(totalVerts * itemSize);
    for (const ps of perSource) {
      arr.set(ps.baked[name], ps.vertOffset * itemSize);
    }
    mergedAttrs[name] = { array: arr, itemSize };
  }

  const mergedIndex = new IdxCtor(lod0TotalIdx + coarseTotalIdx);
  const mergedClusters = [];
  let lod0Write = 0, coarseWrite = lod0TotalIdx;

  for (const ps of perSource) {
    const { e, vertOffset, idxArray } = ps;
    for (const c of e.clusterSet.clusters) {
      const newLods = [];
      for (const lod of c.lods) {
        const srcBase = lod.stream === 1 ? e.lod0Count : 0;
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

  const COINCIDENT_EDGE_EPS = 1e-6;
  const mergedPosArr = mergedAttrs.position.array;
  for (let i = 0; i + 2 < mergedIndex.length; i += 3) {
    const a = mergedIndex[i], b = mergedIndex[i + 1], c = mergedIndex[i + 2];
    const ax = mergedPosArr[a * 3], ay = mergedPosArr[a * 3 + 1], az = mergedPosArr[a * 3 + 2];
    const bx = mergedPosArr[b * 3], by = mergedPosArr[b * 3 + 1], bz = mergedPosArr[b * 3 + 2];
    const cx = mergedPosArr[c * 3], cy = mergedPosArr[c * 3 + 1], cz = mergedPosArr[c * 3 + 2];
    const e1 = Math.hypot(ax - bx, ay - by, az - bz);
    const e2 = Math.hypot(bx - cx, by - cy, bz - cz);
    const e3 = Math.hypot(ax - cx, ay - cy, az - cz);
    if (e1 < COINCIDENT_EDGE_EPS || e2 < COINCIDENT_EDGE_EPS || e3 < COINCIDENT_EDGE_EPS) { mergedIndex[i + 1] = a; mergedIndex[i + 2] = a; }
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
    _sourceIndices: entries.map((e) => e._origIndex).sort((a, b) => a - b),
  };
}

export function mergeClusterMeshesByMaterial(clusterMeshes, nodeMatrices) {
  if (!clusterMeshes || !clusterMeshes.length) return clusterMeshes || [];

  const byMaterial = new Map();
  for (let i = 0; i < clusterMeshes.length; i++) {
    const mat = clusterMeshes[i].material;
    let list = byMaterial.get(mat);
    if (!list) { list = []; byMaterial.set(mat, list); }
    list.push(i);
  }

  const out = [];
  const consumed = new Set();
  for (const [, indices] of byMaterial) {
    if (indices.length < 2) continue;
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
  }

  for (let i = 0; i < clusterMeshes.length; i++) {
    if (!consumed.has(i)) out.push({ ...clusterMeshes[i], _sourceIndices: [i] });
  }

  out.sort((a, b) => a._sourceIndices[0] - b._sourceIndices[0]);

  return out;
}

export { _mergeGroup, _bakeAttribute, _transformAabb, _transformSphere };
export default { mergeClusterMeshesByMaterial };
