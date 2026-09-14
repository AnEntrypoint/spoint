import * as THREE from 'three';
import { parseClusterLod } from './meshlet-codec.js';

const _sphere = new THREE.Sphere();
const _box = new THREE.Box3();
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _size = new THREE.Vector2();

let _camCache = { renderer: null, camera: null, frame: -1, sh: 1080, tanHalf: 1 };

const DEFAULT_LOD_THRESHOLDS = [120, 40];
const MIN_CAMERA_DIST_SQ = 1e-6;
const FAN_EDGE_MAX_CLUSTER_DIAGONALS = 3;

export class ClusterLodMesh extends THREE.Mesh {
  constructor(geometry, material, clusterSet, opts = {}) {
    const perGroupDrawMaterials = Array.isArray(material) ? material : [material];
    super(geometry, perGroupDrawMaterials);
    this.clusterSet = clusterSet;
    this.lod0Count = opts.lod0Count != null ? opts.lod0Count : _inferLod0Count(clusterSet);
    this.lodThresholds = opts.lodThresholds || DEFAULT_LOD_THRESHOLDS;
    this._screenHeight = opts.screenHeight || 1080;
    this._hyst = opts.hysteresis != null ? opts.hysteresis : 0.15;
    this._curLod = new Int8Array(clusterSet.clusters.length).fill(-1);

    const n = clusterSet.clusters.length;
    this._starts = new Int32Array(n);
    this._counts = new Int32Array(n);
    this._drawCount = 0;

    this._worldAabbMin = new Float32Array(n * 3);
    this._worldAabbMax = new Float32Array(n * 3);
    this._worldAabbValid = false;
    this._lastMatrixEls = new Float32Array(16);
    this._worldSphereCenter = new Float32Array(n * 3);
    this._worldSphereRadius = new Float32Array(n);
    this._scale = 1;

    this._ext = null;
    this._extProbed = false;
    this._lastRenderFrame = -1;
    this._groupPoolByClusterIndex = [];
    for (let i = 0; i < n; i++) this._groupPoolByClusterIndex.push({ start: 0, count: 0, materialIndex: 0 });

    this.stats = { visibleClusters: 0, drawnTris: 0, totalTris: 0, multiDrawSubmissions: 0, ext: null };
    for (const c of clusterSet.clusters) this.stats.totalTris += c.lods[0].count / 3;

    this.onBeforeRender = this._render.bind(this);
    this.frustumCulled = false;

    const firstFrameSeedGroup = { start: 0, count: this.lod0Count, materialIndex: 0 };
    geometry.groups = [firstFrameSeedGroup];
  }

  _byteOffset(lod, bytesPerIndex) {
    const base = lod.stream === 1 ? this.lod0Count : 0;
    return (base + lod.offset) * bytesPerIndex;
  }

  _pickLod(ci, sizeSq, distSq, tanHalfSq) {
    const t = this.lodThresholds;
    const cur = this._curLod[ci];
    let lod = t.length;
    for (let i = 0; i < t.length; i++) {
      const goingUp = cur < 0 || cur > i;
      const eff = goingUp ? t[i] * (1 + this._hyst) : t[i] * (1 - this._hyst);
      if (sizeSq > eff * eff * tanHalfSq * distSq) { lod = i; break; }
    }
    const avail = this.clusterSet.clusters[ci].lods.length;
    if (lod >= avail) lod = avail - 1;
    this._curLod[ci] = lod;
    return lod;
  }

  _render(renderer, scene, camera, geometry) {
    const index = geometry.index;
    if (!index || !this.clusterSet) return;

    const frame = renderer.info.render.frame;

    const alreadyRenderedThisFrame = this._lastRenderFrame === frame;
    if (alreadyRenderedThisFrame) return;
    this._lastRenderFrame = frame;
    if (_camCache.renderer !== renderer || _camCache.camera !== camera || _camCache.frame !== frame) {
      _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_projScreen);
      _v.setFromMatrixPosition(camera.matrixWorld);
      let sh = this._screenHeight;
      try { const sz = renderer.getDrawingBufferSize(_size); if (sz.y > 0) sh = sz.y; } catch (_) {}
      const tanHalf = camera.isPerspectiveCamera ? Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) : 1;
      _camCache.renderer = renderer; _camCache.camera = camera; _camCache.frame = frame;
      _camCache.camPos = _v.clone(); _camCache.sh = sh; _camCache.tanHalf = tanHalf;
      _camCache.tanHalfSq = tanHalf * tanHalf;
    }
    const camPos = _camCache.camPos, sh = _camCache.sh, tanHalfSq = _camCache.tanHalfSq;
    const me = this.matrixWorld.elements;

    const last = this._lastMatrixEls;
    let matrixChanged = !this._worldAabbValid;
    if (!matrixChanged) {
      for (let i = 0; i < 16; i++) { if (last[i] !== me[i]) { matrixChanged = true; break; } }
    }
    if (matrixChanged) {
      const sq0 = me[0] * me[0] + me[1] * me[1] + me[2] * me[2];
      const sq1 = me[4] * me[4] + me[5] * me[5] + me[6] * me[6];
      const sq2 = me[8] * me[8] + me[9] * me[9] + me[10] * me[10];
      this._scale = Math.sqrt(Math.max(sq0, sq1, sq2));
      last.set(me); this._worldAabbValid = true;
    }
    const scale = this._scale;

    let drawnTris = 0, visible = 0, n = 0;
    const pool = this._groupPoolByClusterIndex;
    const drawnCi = this._drawnCi || (this._drawnCi = []);
    drawnCi.length = 0;
    const clusters = this.clusterSet.clusters;
    for (let ci = 0; ci < clusters.length; ci++) {
      const c = clusters[ci];
      const o3 = ci * 3;
      if (matrixChanged) {
        const a = c.aabb;
        _box.min.set(a[0], a[1], a[2]);
        _box.max.set(a[3], a[4], a[5]);
        _box.applyMatrix4(this.matrixWorld);
        this._worldAabbMin[o3] = _box.min.x; this._worldAabbMin[o3 + 1] = _box.min.y; this._worldAabbMin[o3 + 2] = _box.min.z;
        this._worldAabbMax[o3] = _box.max.x; this._worldAabbMax[o3 + 1] = _box.max.y; this._worldAabbMax[o3 + 2] = _box.max.z;

        _sphere.center.set(c.sphere[0], c.sphere[1], c.sphere[2]).applyMatrix4(this.matrixWorld);
        _sphere.radius = c.sphere[3] * scale;
        this._worldSphereCenter[o3] = _sphere.center.x; this._worldSphereCenter[o3 + 1] = _sphere.center.y; this._worldSphereCenter[o3 + 2] = _sphere.center.z;
        this._worldSphereRadius[ci] = _sphere.radius;
      } else {
        _box.min.set(this._worldAabbMin[o3], this._worldAabbMin[o3 + 1], this._worldAabbMin[o3 + 2]);
        _box.max.set(this._worldAabbMax[o3], this._worldAabbMax[o3 + 1], this._worldAabbMax[o3 + 2]);
      }
      if (!this._spointNoClusterCull && !_frustum.intersectsBox(_box)) continue;
      visible++;
      if (!matrixChanged) {
        _sphere.center.set(this._worldSphereCenter[o3], this._worldSphereCenter[o3 + 1], this._worldSphereCenter[o3 + 2]);
        _sphere.radius = this._worldSphereRadius[ci];
      }
      const distSq = Math.max(MIN_CAMERA_DIST_SQ, _sphere.center.distanceToSquared(camPos));
      const sizeSq = (sh * _sphere.radius) * (sh * _sphere.radius);
      const lodIdx = this._pickLod(ci, sizeSq, distSq, tanHalfSq);
      const lod = c.lods[lodIdx];
      if (!lod.count) continue;
      const base = lod.stream === 1 ? this.lod0Count : 0;
      const g = pool[ci];
      g.start = base + lod.offset; g.count = lod.count; g.materialIndex = 0;
      drawnCi.push(ci);
      n++;
      drawnTris += lod.count / 3;
    }
    const view = this._groupView || (this._groupView = []);
    view.length = 0;
    if (n === 0) {
      const fb = this._fallbackGroup || (this._fallbackGroup = { start: 0, count: 0, materialIndex: 0 });
      fb.start = 0; fb.count = this.lod0Count; fb.materialIndex = 0;
      view.push(fb);
      drawnTris = this.lod0Count / 3;
    } else {
      for (let i = 0; i < drawnCi.length; i++) view.push(pool[drawnCi[i]]);
    }
    geometry.groups = view;
    this.stats.visibleClusters = visible;
    this.stats.drawnTris = drawnTris;
    this.stats.multiDrawSubmissions = geometry.groups.length;
  }
}

function _inferLod0Count(clusterSet) {
  let n = 0;
  for (const c of clusterSet.clusters) {
    const l0 = c.lods[0];
    if (l0.stream === 0) n = Math.max(n, l0.offset + l0.count);
  }
  return n;
}

export function attachClusterLod(geometry, extras, coarseIndexArray) {
  const clusterSet = parseClusterLod(extras);
  if (!clusterSet) return null;

  const lod0 = geometry.index ? geometry.index.array : null;
  if (!lod0) return null;
  const lod0Count = lod0.length;
  const coarse = coarseIndexArray || new Uint32Array(0);

  const maxVid = geometry.attributes.position.count - 1;
  let coarseMax = 0;
  for (let i = 0; i < coarse.length; i++) if (coarse[i] > coarseMax) coarseMax = coarse[i];
  const Ctor = (maxVid > 65535 || coarseMax > 65535) ? Uint32Array : Uint16Array;
  const combined = new Ctor(lod0Count + coarse.length);
  combined.set(lod0, 0);
  combined.set(coarse, lod0Count);
  _collapseDegenerateTriangles(combined, geometry.attributes.position.array);
  _collapseFanTriangles(combined, geometry.attributes.position.array, clusterSet);
  geometry.setIndex(new THREE.BufferAttribute(combined, 1));

  return { clusterSet, lod0Count };
}

function _triArea(pos, a, b, c) {
  const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
  const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
  const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const cxp = uy * vz - uz * vy, cyp = uz * vx - ux * vz, czp = ux * vy - uy * vx;
  return 0.5 * Math.hypot(cxp, cyp, czp);
}
function _collapseDegenerateTriangles(index, pos) {
  const EPS_AREA = 1e-4;
  let collapsed = 0;
  for (let i = 0; i + 2 < index.length; i += 3) {
    const a = index[i], b = index[i + 1], c = index[i + 2];
    if (_triArea(pos, a, b, c) < EPS_AREA) { index[i + 1] = a; index[i + 2] = a; collapsed++; }
  }
  if (collapsed) console.warn(`[cluster-lod-mesh] collapsed ${collapsed} degenerate (zero-area) triangle(s) at runtime combine`);
}

function _collapseFanTriangles(index, pos, clusterSet) {
  let fixed = 0;
  for (const cluster of clusterSet.clusters) {
    const [mnx, mny, mnz, mxx, mxy, mxz] = cluster.aabb;
    const diag = Math.hypot(mxx - mnx, mxy - mny, mxz - mnz);
    const maxLegitEdgeSq = (diag * FAN_EDGE_MAX_CLUSTER_DIAGONALS) * (diag * FAN_EDGE_MAX_CLUSTER_DIAGONALS);
    for (const lod of cluster.lods) {
      const start = lod.offset, end = lod.offset + lod.count;
      for (let i = start; i + 2 < end && i + 2 < index.length; i += 3) {
        const a = index[i], b = index[i + 1], c = index[i + 2];
        const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
        const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
        const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
        const e1Sq = (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2;
        const e2Sq = (bx - cx) ** 2 + (by - cy) ** 2 + (bz - cz) ** 2;
        const e3Sq = (ax - cx) ** 2 + (ay - cy) ** 2 + (az - cz) ** 2;
        if (e1Sq > maxLegitEdgeSq || e2Sq > maxLegitEdgeSq || e3Sq > maxLegitEdgeSq) {
          index[i + 1] = a; index[i + 2] = a; fixed++;
        }
      }
    }
  }
  if (fixed) console.warn(`[cluster-lod-mesh] collapsed ${fixed} fan (out-of-cluster-bounds) triangle(s) at runtime combine`);
}
