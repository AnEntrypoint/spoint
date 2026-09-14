import * as THREE from 'three';
import {
  createAtlasRenderTarget, renderAtlasCells, createOctahedralImpostorMaterial,
  computeObjectBoundingSphere,
} from './octahedral-impostor-ez.js';

const _box = new THREE.Box3();

export class OctahedralImpostorEzTier {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.spritesPerSide = opts.grid ?? 8;
    this.atlasSize = opts.textureSize ?? 1024;
    this.useHemi = opts.useHemiOctahedron === true;
    this.cameraFactor = opts.cameraFactor ?? 1;
    this.alphaClamp = opts.alphaClamp ?? 0.4;
    this.maxAssets = opts.maxImpostorAssets ?? 64;
    this.maxInstances = opts.maxInstances ?? 8192;
    this.total = this.spritesPerSide * this.spritesPerSide;
    this.useFade = opts.fade === true;
    this.useParallax = opts.parallax === true;
    this.parallaxScale = opts.parallaxScale ?? 0.3;

    this.mesh = new THREE.Group();
    this.mesh.name = 'octahedral-impostor-ez-tier';
    this.mesh.frustumCulled = false;

    this._plane = new THREE.PlaneGeometry(1, 1);

    this._assetLayers = new Map();
    this._assetMeshes = [];
    this._jobs = new Map();
    this._nextLayer = 0;
    this._instances = new Map();
    this._byHandle = new Map();
    this._nextHandle = 0;
    this._mat4 = new THREE.Matrix4();
    this._cellsRendered = 0;

    this._bakeScene = new THREE.Scene();
  }

  hasAsset(asset) { return this._assetLayers.has(asset.url); }
  hasJob(asset) { return this._jobs.has(asset.url); }
  layerFor(asset) { const d = this._assetLayers.get(asset.url); return d ? d.layer : -1; }

  bakeChunk(asset, object3D, cellBudget) {
    if (this._assetLayers.has(asset.url) || !object3D) return 0;
    let job = this._jobs.get(asset.url);
    if (!job) {
      if (this._nextLayer >= this.maxAssets) return 0;
      job = { layer: this._nextLayer++, rt: null, cellsDone: 0, sphere: new THREE.Sphere() };
      this._jobs.set(asset.url, job);
    }
    if (cellBudget <= 0 || job.cellsDone >= this.total) return 0;

    const prevParent = object3D.parent;
    const prevAuto = object3D.matrixAutoUpdate;
    const prevPos = object3D.position.clone();
    const prevQuat = object3D.quaternion.clone();
    const prevScale = object3D.scale.clone();
    const prevVisible = object3D.visible;
    const visSaves = [];
    object3D.traverse((o) => { if (o.isMesh) { visSaves.push(o); o._impSaveVis = o.visible; o.visible = true; } });
    object3D.visible = true;
    object3D.position.set(0, 0, 0); object3D.quaternion.identity(); object3D.scale.set(1, 1, 1);
    object3D.matrixAutoUpdate = false;
    this._bakeScene.add(object3D);
    object3D.updateWorldMatrix(true, true);

    let take = 0, empty = false;
    if (job.cellsDone === 0) {
      computeObjectBoundingSphere(object3D, job.sphere, true);
      if (!(job.sphere.radius > 0)) empty = true;
      else job.rt = createAtlasRenderTarget(this.atlasSize);
    }
    if (!empty) {
      take = Math.min(cellBudget, this.total - job.cellsDone);
      renderAtlasCells(this.renderer, object3D, job.rt, {
        atlasSize: this.atlasSize, countPerSide: this.spritesPerSide, bSphere: job.sphere,
        cameraFactor: this.cameraFactor, useHemiOctahedron: this.useHemi,
        cellStart: job.cellsDone, cellCount: take,
      });
      job.cellsDone += take;
      this._cellsRendered += take;
    }

    if (prevParent) prevParent.add(object3D); else this._bakeScene.remove(object3D);
    object3D.position.copy(prevPos); object3D.quaternion.copy(prevQuat); object3D.scale.copy(prevScale);
    object3D.matrixAutoUpdate = prevAuto; object3D.visible = prevVisible;
    for (const o of visSaves) { o.visible = o._impSaveVis; delete o._impSaveVis; }
    object3D.updateWorldMatrix(true, true);

    if (empty) { this._jobs.delete(asset.url); return 0; }
    if (job.cellsDone >= this.total) this._finishAsset(asset, job);
    return take;
  }

  _finishAsset(asset, job) {
    const radius = job.sphere.radius;
    const diameter = 2 * radius;
    const transform = new THREE.Matrix4().makeScale(diameter, diameter, diameter);
    const material = createOctahedralImpostorMaterial({
      albedo: job.rt.textures[0], normalDepth: job.rt.textures[1],
      useHemiOctahedron: this.useHemi, spritesPerSide: this.spritesPerSide,
      transform, alphaClamp: this.alphaClamp, fade: this.useFade,
      parallax: this.useParallax, parallaxScale: this.parallaxScale,
    });
    const geo = this.useFade ? this._plane.clone() : this._plane;
    const mesh = new THREE.InstancedMesh(geo, material, this.maxInstances);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.name = `octahedral-impostor-ez:${job.layer}`;
    let fadeAttr = null;
    if (this.useFade) {
      const arr = new Float32Array(this.maxInstances).fill(1);
      fadeAttr = new THREE.InstancedBufferAttribute(arr, 1);
      fadeAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('instanceFade', fadeAttr);
    }
    this.mesh.add(mesh);
    this._assetMeshes[job.layer] = { mesh, rt: job.rt, radius, free: [], highWater: 0, entityCount: 0, fadeAttr };
    this._assetLayers.set(asset.url, { layer: job.layer, radius, center: job.sphere.center.clone() });
    this._jobs.delete(asset.url);
  }

  acquire(entity, layer, cx, cy, cz, wr) {
    const rec = this._assetMeshes[layer];
    if (!rec) return -1;
    let h = this._instances.get(entity);
    let localIdx;
    if (h == null) {
      localIdx = rec.free.length ? rec.free.pop() : rec.highWater++;
      h = this._nextHandle++;
      this._instances.set(entity, h);
      this._byHandle.set(h, { layer, localIdx });
      rec.entityCount++;
      if (rec.highWater > rec.mesh.count) rec.mesh.count = rec.highWater;
    } else {
      localIdx = this._byHandle.get(h).localIdx;
    }
    this._writeInstance(rec, localIdx, cx, cy, cz, wr);
    return h;
  }

  setCenter(h, x, y, z, wr) {
    const m = this._byHandle.get(h);
    if (!m) return;
    const rec = this._assetMeshes[m.layer];
    if (rec) this._writeInstance(rec, m.localIdx, x, y, z, wr ?? rec.radius);
  }

  setFade(h, fade) {
    if (!this.useFade) return;
    const m = this._byHandle.get(h);
    if (!m) return;
    const rec = this._assetMeshes[m.layer];
    if (!rec || !rec.fadeAttr) return;
    rec.fadeAttr.setX(m.localIdx, fade);
    rec.fadeAttr.needsUpdate = true;
  }

  _writeInstance(rec, idx, x, y, z, wr) {
    const scaleVsBakedRadius = wr / rec.radius;
    this._mat4.makeScale(scaleVsBakedRadius, scaleVsBakedRadius, scaleVsBakedRadius);
    this._mat4.setPosition(x, y, z);
    rec.mesh.setMatrixAt(idx, this._mat4);
    this._markInstMatDirty(rec, idx);
  }

  _markInstMatDirty(rec, idx) {
    const runs = rec.dirtyRuns || (rec.dirtyRuns = []);
    const lo = idx * 16, hi = lo + 15;
    let i = 0;
    while (i < runs.length && runs[i][1] < lo - 1) i++;
    let mergedLo = lo, mergedHi = hi;
    let j = i;
    while (j < runs.length && runs[j][0] <= hi + 1) {
      if (runs[j][0] < mergedLo) mergedLo = runs[j][0];
      if (runs[j][1] > mergedHi) mergedHi = runs[j][1];
      j++;
    }
    runs.splice(i, j - i, [mergedLo, mergedHi]);
  }

  flush() {
    for (const rec of this._assetMeshes) {
      if (!rec || !rec.dirtyRuns || rec.dirtyRuns.length === 0) continue;
      const attr = rec.mesh.instanceMatrix;
      if (typeof attr.addUpdateRange === 'function') {
        attr.clearUpdateRanges();
        for (const [lo, hi] of rec.dirtyRuns) attr.addUpdateRange(lo, hi - lo + 1);
      }
      attr.needsUpdate = true;
      rec.dirtyRuns.length = 0;
    }
  }

  release(entity) {
    const h = this._instances.get(entity);
    if (h == null) return;
    this._instances.delete(entity);
    const m = this._byHandle.get(h);
    this._byHandle.delete(h);
    if (!m) return;
    const rec = this._assetMeshes[m.layer];
    if (!rec) return;
    this._mat4.makeScale(0, 0, 0);
    rec.mesh.setMatrixAt(m.localIdx, this._mat4);
    this._markInstMatDirty(rec, m.localIdx);
    rec.free.push(m.localIdx);
    rec.entityCount = Math.max(0, rec.entityCount - 1);
  }

  instanceIdFor(entity) {
    const h = this._instances.get(entity);
    return h == null ? -1 : h;
  }

  dispose() {
    for (const rec of this._assetMeshes) {
      if (!rec) continue;
      this.mesh.remove(rec.mesh);
      rec.rt.dispose();
      rec.mesh.material.dispose();
      if (rec.mesh.geometry !== this._plane) rec.mesh.geometry.dispose();
    }
    for (const job of this._jobs.values()) if (job.rt) job.rt.dispose();
    this._plane.dispose();
    this._assetMeshes.length = 0;
    this._assetLayers.clear();
    this._jobs.clear();
    this._instances.clear();
    this._byHandle.clear();
  }
}

export default { OctahedralImpostorEzTier };
