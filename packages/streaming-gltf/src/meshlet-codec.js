export const CLUSTER_LOD_VERSION = 2;
export const CLUSTER_LOD_EXTRA_KEY = 'EP_cluster_lod';
const SPHERE_WITH_CENTER_LEN = 4;
const SPHERE_RADIUS_ONLY_LEN = 1;
const LOD0_INDEX_STREAM = 0;
const COARSE_INDEX_STREAM = 1;

let _meshopt = null;
async function _ensureMeshopt() {
  if (_meshopt) return _meshopt;
  const { MeshoptClusterizer, MeshoptSimplifier } = await import('meshoptimizer');
  await MeshoptClusterizer.ready;
  await MeshoptSimplifier.ready;
  _meshopt = { MeshoptClusterizer, MeshoptSimplifier };
  return _meshopt;
}

function _seqIndex(vertCount) {
  const ix = new Uint32Array(vertCount);
  for (let i = 0; i < vertCount; i++) ix[i] = i;
  return ix;
}

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

  const position =
    posAttr.array instanceof Float32Array && posAttr.itemSize === 3
      ? posAttr.array
      : _toFloat32Vec3(posAttr.array, posAttr.itemSize);

  const index = geo.index ? _toUint32(geo.index) : _seqIndex(srcVertCount);

  const uvAttr = uvAware ? attrs.find((a) => a.name === 'uv' || a.name === 'texcoord_0') : null;
  const uvArr = uvAttr ? _toFloat32(uvAttr.array, uvAttr.itemSize, 2) : null;

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

  const lodCount = lodRatios.length;
  const newVertexOfOld = new Int32Array(srcVertCount).fill(-1);
  const oldVertexOfNew = new Uint32Array(srcVertCount);
  let appendedVertexCount = 0;
  const index0 = new GrowableUint32Buffer();
  const indexCoarse = new GrowableUint32Buffer();
  const clusters = [];

  const appendTo = (stream, streamTag, glob, n) => {
    const offset = stream.length;
    for (let i = 0; i < n; i++) {
      const old = glob[i];
      let nv = newVertexOfOld[old];
      if (nv === -1) {
        nv = appendedVertexCount;
        newVertexOfOld[old] = nv;
        oldVertexOfNew[appendedVertexCount++] = old;
      }
      stream.push(nv);
    }
    return { offset, count: n, stream: streamTag };
  };

  const uvW = uvArr ? _uvWeights(uvAttr) : null;
  const localPos = new Float32Array(maxVertices * 3);
  const localUv = uvArr ? new Float32Array(maxVertices * 2) : null;
  const maxLocalIdx = maxTriangles * 3;
  const lod0LocalU32 = new Uint32Array(maxLocalIdx);
  const glob = new Uint32Array(maxLocalIdx);
  for (let m = 0; m < mb.meshletCount; m++) {
    const mesh = C.extractMeshlet(mb, m);
    const clusterVerts = mesh.vertices;

    const lv = clusterVerts.length;
    for (let i = 0; i < lv; i++) {
      const g = clusterVerts[i];
      localPos[i * 3] = position[g * 3]; localPos[i * 3 + 1] = position[g * 3 + 1]; localPos[i * 3 + 2] = position[g * 3 + 2];
      if (localUv) { localUv[i * 2] = uvArr[g * 2]; localUv[i * 2 + 1] = uvArr[g * 2 + 1]; }
    }
    const localPosV = lv === maxVertices ? localPos : localPos.subarray(0, lv * 3);
    const localUvV = !localUv ? null : (lv === maxVertices ? localUv : localUv.subarray(0, lv * 2));
    const lod0Local = mesh.triangles;
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
      const ln = local.length;
      for (let i = 0; i < ln; i++) glob[i] = clusterVerts[local[i]];
      lods.push(l === 0 ? appendTo(index0, LOD0_INDEX_STREAM, glob, ln) : appendTo(indexCoarse, COARSE_INDEX_STREAM, glob, ln));
    }

    const b = bounds[m];
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

  const newVertCount = appendedVertexCount;
  const outAttrs = attrs.map((a) => {
    const Ctor = a.array.constructor;
    const src = a.array;
    const sz = a.itemSize;
    const out = new Ctor(newVertCount * sz);
    for (let nv = 0; nv < newVertCount; nv++) {
      const base = oldVertexOfNew[nv] * sz;
      const obase = nv * sz;
      for (let c = 0; c < sz; c++) out[obase + c] = src[base + c];
    }
    return { name: a.name, itemSize: sz, normalized: !!a.normalized, array: out };
  });

  const indicesFitUint16 = newVertCount <= 65536;
  const idxCtor = indicesFitUint16 ? Uint16Array : Uint32Array;
  return {
    vertexCount: newVertCount,
    attributes: outAttrs,
    index: index0.toTyped(idxCtor),
    indexCoarse: indexCoarse.toTyped(idxCtor),
    clusters,
    lodCount,
  };
}

class GrowableUint32Buffer {
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
  toTyped(Ctor) {
    if (Ctor === Uint32Array) return this.toUint32();
    const out = new Ctor(this.length);
    out.set(this.buf.subarray(0, this.length));
    return out;
  }
}

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

export function buildClusterLodExtra(result, coarseIndexAccessor = -1, materialBucket = null) {
  const extra = {
    version: CLUSTER_LOD_VERSION,
    clusterCount: result.clusters.length,
    lodCount: result.lodCount,
    coarseIndexAccessor,
    coarseIndexCount: result.indexCoarse.length,
    clusters: result.clusters.map((c) => ({
      aabb: c.aabb.map(_round),
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

function _isValidRawCluster(c) {
  if (!c || typeof c !== 'object') return false;
  if (!Array.isArray(c.aabb) || c.aabb.length !== 6 || !c.aabb.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  if (!Array.isArray(c.sphere) || (c.sphere.length !== SPHERE_WITH_CENTER_LEN && c.sphere.length !== SPHERE_RADIUS_ONLY_LEN) || !c.sphere.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  if (!Array.isArray(c.lods) || !c.lods.length) return false;
  for (const l of c.lods) {
    const offset = Array.isArray(l) ? l[0] : l?.offset;
    const count = Array.isArray(l) ? l[1] : l?.count;
    if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0) return false;
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return false;
  }
  return true;
}

export function lod0OnlyClusterLodExtras(extras) {
  const meta = extras && extras[CLUSTER_LOD_EXTRA_KEY];
  if (!meta || !Array.isArray(meta.clusters)) throw new TypeError('lod0OnlyClusterLodExtras: extras carry no EP_cluster_lod clusters');
  const clusters = meta.clusters.map((c, ci) => {
    const first = Array.isArray(c.lods) ? c.lods[0] : null;
    const stream = Array.isArray(first) ? first[2] || 0 : first?.stream || 0;
    if (!first || stream !== 0) throw new RangeError(`lod0OnlyClusterLodExtras: cluster ${ci} LOD0 is not on primitive.indices (stream ${stream})`);
    return { ...c, lods: [first] };
  });
  return { ...extras, [CLUSTER_LOD_EXTRA_KEY]: { ...meta, lodCount: 1, coarseIndexAccessor: -1, coarseIndexCount: 0, clusters } };
}

export function parseClusterLod(extras) {
  const meta = extras && extras[CLUSTER_LOD_EXTRA_KEY];
  if (!meta || !Array.isArray(meta.clusters) || !meta.clusters.length) return null;
  if (!meta.clusters.every(_isValidRawCluster)) return null;
  const clusters = meta.clusters.map((c) => {
    const sphere = c.sphere.length === SPHERE_WITH_CENTER_LEN
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
    materialBucket: typeof meta.materialBucket === 'string' && meta.materialBucket ? meta.materialBucket : null,
    clusters,
  };
}
