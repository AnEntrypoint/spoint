// octahedral-impostor-ez-tier.js — FINAL-LOD impostor tier built on the
// localized @three.ez/octahedron-imposter (octahedral-impostor-ez.js): LIT
// impostors (albedo + baked normal/depth -> scene lighting) with 3-sprite
// plane-projected view blending. This is the sole octahedral impostor tier
// (see draw-call-audit-impostor-array-tier-deprecation-decision -- a sibling
// unlit sampler2DArray tier, octahedral-impostor.js/octahedral-impostor-tier.js,
// was deleted after an audit found it unreachable on every real serving path:
// client/ModelPoolAdapter.js, the only real ModelPool consumer, hardcoded the
// lit variant, and no device-tier gating ever wired the unlit fallback live).
//
// The EZ material is per-asset (its own albedo+normalDepth + impostorTransform),
// so each impostor'd asset gets its own InstancedMesh inside one Group: N draws
// for N distinct impostor'd assets (capped by maxImpostorAssets, default 64).
// Draw count is not this scene's bottleneck (triangle/fill is), and N is small
// + farthest-LOD; the win is lit, higher-quality impostors that support ~1M-tri
// source models via a 1024 atlas. The bake is INCREMENTAL (cell-budget/frame)
// -> no swap stall. If N-draws-for-N-assets ever becomes the bottleneck, the
// deleted array tier's real differentiator (1 draw for ALL assets via
// sampler2DArray, unlit) is the concrete idea to fold in as an opt-in mode --
// see draw-call-audit-impostor-array-mode-fold-in.

import * as THREE from 'three';
import {
  createAtlasRenderTarget, renderAtlasCells, createOctahedralImpostorMaterial,
  computeObjectBoundingSphere,
} from './octahedral-impostor-ez.js';

const _box = new THREE.Box3();

export class OctahedralImpostorEzTier {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    // `grid` (pool option name) == sprites per atlas side. 1024/8 = 128px/view.
    this.spritesPerSide = opts.grid ?? 8;
    this.atlasSize = opts.textureSize ?? 1024;     // 1024^2 MRT -> ~1M-tri source models, general/compatible
    this.useHemi = opts.useHemiOctahedron === true; // default full-sphere (works from any angle)
    this.cameraFactor = opts.cameraFactor ?? 1;
    this.alphaClamp = opts.alphaClamp ?? 0.4;
    this.maxAssets = opts.maxImpostorAssets ?? 64;  // VRAM cap: ~ atlasSize^2 * 8B/asset
    this.maxInstances = opts.maxInstances ?? 8192;
    this.total = this.spritesPerSide * this.spritesPerSide;
    // Dithered mesh<->impostor crossfade (opt-in, default off -- see EZ_FADE in
    // octahedral-impostor-ez.js). When on, every per-asset InstancedMesh gets an
    // `instanceFade` InstancedBufferAttribute the caller drives via setFade();
    // acquire() seeds new instances at fade=1 (fully opaque) so a caller that
    // never calls setFade sees byte-identical behaviour to fade disabled.
    this.useFade = opts.fade === true;
    // Parallax-corrected impostors (opt-in, default off -- see EZ_PARALLAX in octahedral-impostor-ez.js).
    // Pure material/uniform config, no per-instance attribute needed (unlike fade), so no geometry
    // clone / instance buffer plumbing required here.
    this.useParallax = opts.parallax === true;
    this.parallaxScale = opts.parallaxScale ?? 0.3;

    // One Group holds every per-asset InstancedMesh; the pool adds it to the
    // scene once. Per-asset meshes are added as their atlas finishes baking.
    this.mesh = new THREE.Group();
    this.mesh.name = 'octahedral-impostor-ez-tier';
    this.mesh.frustumCulled = false;

    // Shared billboard geometry (unit XY plane, [-0.5,0.5], uv [0,1]); the EZ
    // material's vertex shader builds the camera-facing quad from it.
    this._plane = new THREE.PlaneGeometry(1, 1);

    this._assetLayers = new Map();   // asset.url -> { layer, radius, center }
    this._assetMeshes = [];          // layer -> { mesh, rt, radius, free[], highWater, entityCount }
    this._jobs = new Map();          // asset.url -> { layer, rt, cellsDone, sphere }
    this._nextLayer = 0;
    this._instances = new Map();     // entity -> handle
    this._byHandle = new Map();      // handle -> { layer, localIdx }
    this._nextHandle = 0;
    this._mat4 = new THREE.Matrix4();
    this._cellsRendered = 0;         // witness: per-frame delta <= budget

    // Persistent bake group so the live entity root can be reparented in for the
    // capture (transform neutralised -> asset-local) and restored before the
    // frame's main render (bake runs in update(), pre-render -> no flicker).
    this._bakeScene = new THREE.Scene();
  }

  hasAsset(asset) { return this._assetLayers.has(asset.url); }
  hasJob(asset) { return this._jobs.has(asset.url); }
  layerFor(asset) { const d = this._assetLayers.get(asset.url); return d ? d.layer : -1; }

  // Incremental bake: render up to `cellBudget` more octahedral cells of this
  // asset's per-asset atlas this frame. On the final cell the per-asset lit
  // InstancedMesh + material are created and the asset promotes to _assetLayers.
  bakeChunk(asset, object3D, cellBudget) {
    if (this._assetLayers.has(asset.url) || !object3D) return 0;
    let job = this._jobs.get(asset.url);
    if (!job) {
      if (this._nextLayer >= this.maxAssets) return 0; // cap -> stay on far tier (graceful degrade)
      job = { layer: this._nextLayer++, rt: null, cellsDone: 0, sphere: new THREE.Sphere() };
      this._jobs.set(asset.url, job);
    }
    if (cellBudget <= 0 || job.cellsDone >= this.total) return 0;

    // Reparent + neutralise transform so the capture is ASSET-LOCAL.
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

    // Restore object to its live parent + transform/visibility.
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
    // impostorTransform scales the unit plane to the asset's DIAMETER (no
    // translation: the atlas is centred on the bounding sphere, and the pool
    // composes the world centre into the per-instance matrix).
    const transform = new THREE.Matrix4().makeScale(2 * radius, 2 * radius, 2 * radius);
    const material = createOctahedralImpostorMaterial({
      albedo: job.rt.textures[0], normalDepth: job.rt.textures[1],
      useHemiOctahedron: this.useHemi, spritesPerSide: this.spritesPerSide,
      transform, alphaClamp: this.alphaClamp, fade: this.useFade,
      parallax: this.useParallax, parallaxScale: this.parallaxScale,
    });
    // The per-instance `instanceFade` attribute must live on a geometry unique to
    // THIS asset's InstancedMesh -- the base `_plane` is shared across every
    // per-asset mesh in the tier, so writing a fade attribute onto it would leak
    // one asset's fade state into every other asset's draw. Clone (cheap: a
    // 4-vertex/1-index plane) only when fade is enabled; non-fade assets keep
    // sharing `_plane` unchanged (zero cost regression for the default path).
    const geo = this.useFade ? this._plane.clone() : this._plane;
    const mesh = new THREE.InstancedMesh(geo, material, this.maxInstances);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.name = `octahedral-impostor-ez:${job.layer}`;
    let fadeAttr = null;
    if (this.useFade) {
      // Pre-fill 1.0 (fully opaque) so an entity acquired without an explicit
      // setFade call renders exactly as it did pre-fade (no silent regression).
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

  // Entity-facing: place/refresh this entity's impostor on the asset's per-asset
  // InstancedMesh (`layer` indexes _assetMeshes). Returns an opaque handle.
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

  // Set this entity's impostor crossfade amount, 0 (invisible) .. 1 (fully
  // opaque). No-op when the tier was built without opts.fade (EZ_FADE never
  // compiled into the shader, so the attribute write would be inert anyway).
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
    const s = wr / rec.radius; // entity world-scale relative to the baked asset radius
    this._mat4.makeScale(s, s, s);
    this._mat4.setPosition(x, y, z);
    rec.mesh.setMatrixAt(idx, this._mat4);
    this._markInstMatDirty(rec, idx);
  }

  // Insert local instance idx's 16-float component range into `rec`'s merged
  // disjoint-run list (identical shape to InstancedSlot._markInstanceTexDirty
  // in model-pool.js) so N scattered per-frame movers on the SAME per-asset
  // mesh upload O(N) instances instead of O(maxInstances) instances.
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

  // Upload only the touched component runs per per-asset mesh via
  // addUpdateRange instead of a full-buffer needsUpdate re-upload every frame
  // any instance on that mesh moved. Call once per frame after all
  // acquire/setCenter/release calls have landed.
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
    // Park at degenerate scale so it rasterizes nothing until recycled.
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
      // Fade mode clones `_plane` per-asset (own instanceFade attribute) -- dispose
      // each clone; non-fade mode shares `_plane` itself, disposed once below.
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
