// Runtime cluster-LOD mesh (EP_cluster_lod consumer).
//
// Wraps a single unified geometry (one mesh / one primitive, the full-res LOD0 in
// geometry.index + the coarse LOD1..N indices appended) plus the per-cluster
// metadata parsed from extras.EP_cluster_lod. Each frame it:
//   1. frustum-culls clusters by their bounding AABB (CPU) -- NOT the bounding
//      sphere: a sphere fitted to thin flat geometry (floor/wall/panel slabs
//      ~0.1-0.2m thick) is small and centered, under-covering the slab's actual
//      in-plane extent, which false-culls near frustum edges (parts pop in/out
//      as the camera moves). The AABB is exact-fit to the same LOD0 vertices and
//      was already computed + stored per cluster (meshlet-codec.js's `c.aabb`),
//      so this swaps the test, not the source data. The bounding sphere is still
//      used for the LOD projected-size estimate below (cheap distance/radius
//      proxy, not a cull test, so its under-coverage doesn't matter there).
//   2. picks a LOD per visible cluster from projected screen size,
//   3. accumulates the chosen index sub-ranges as geometry GROUPS, and
//   4. lets three's normal render pipeline issue one drawElements call PER
//      GROUP against the unified element buffer. NOT a raw WEBGL_multi_draw
//      call: three's object.onBeforeRender fires BEFORE renderBufferDirect
//      binds the mesh's VAO, so a manual gl draw there would run against
//      stale/wrong buffer state (see _compute()'s inline comment for the
//      GL_INVALID failure mode this replaced). Groups still land in ONE render
//      pass with correct attributes and no extra buffers or double-draws --
//      just not collapsed into a single GPU submission the way a true
//      multi-draw extension call would.
//
// WHEN steps 1-3 run (cluster-lod-prepass): in a once-per-render PRE-PASS, `prepare(renderer,
// camera)`, driven by ModelPool's scene.onBeforeRender hook (model-pool.js prepareClusterFrame).
// THREE fires scene.onBeforeRender INSIDE renderer.render() after scene/camera matrices are updated
// and BEFORE projectObject reads geometry.groups to build the renderList (node_modules/three/src/
// renderers/WebGLRenderer.js: scene.onBeforeRender ~1650, projectObject ~1682, info.render.frame++
// ~1700, renderObject -> object.onBeforeRender ~2126). Computing the groups in object.onBeforeRender
// (the previous design) was therefore always ONE FRAME STALE: projectObject had already pushed one
// renderList entry per geometry.groups[i] (holding direct references to the pooled group objects)
// before any onBeforeRender ran, so the cull/LOD result of frame N only shaped frame N+1's draw list.
// The object-level onBeforeRender (_render) is kept only as a guard + legacy fallback for a render()
// call that had no pre-pass (a scene this class's pool did not hook -- impostor-bake/warm scenes) so
// behaviour there is byte-identical to before.
//
// The whole index buffer = LOD0 of every cluster, so if this object is ever drawn
// by the stock three pipeline (no onBeforeRender override applied) it still renders
// the correct full-resolution mesh.

import * as THREE from 'three';
import { parseClusterLod } from './meshlet-codec.js';

const _sphere = new THREE.Sphere();
const _box = new THREE.Box3();
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _size = new THREE.Vector2();
// Preallocated camera-position holder for _camCache (was `_v.clone()` per camera-change, i.e. one
// Vector3 allocation per render() call -- pure GC churn on the hot per-frame path).
const _camPos = new THREE.Vector3();

// Per-frame cache of the camera-only inputs shared by every ClusterLodMesh instance drawn in the
// same renderer.render() call: projScreen/frustum/camPos/screen-height/tanHalf depend only on
// (renderer, camera), not on this.matrixWorld, so N instances recomputing them per frame is pure
// waste. Keyed on renderer.info.render.frame -- camera/renderer state cannot change between
// onBeforeRender calls within one render() pass.
let _camCache = { renderer: null, camera: null, frame: -1, sh: 1080, tanHalf: 1, tanHalfSq: 1, camPos: _camPos };

// thresholds: projected sphere radius (px-ish, screenH * r / dist) above which a
// given LOD is used. Index i is chosen when projected size > thresholds[i].
// Descending: big on screen -> LOD0, small -> coarsest.
const DEFAULT_LOD_THRESHOLDS = [120, 40]; // LOD0 if >120, LOD1 if >40, else LOD2

export class ClusterLodMesh extends THREE.Mesh {
  // geometry: BufferGeometry whose .index already contains [LOD0 ... | coarse ...]
  //   concatenated (lod0Count = number of LOD0 indices; coarse indices follow).
  // clusterSet: output of parseClusterLod(extras) with cluster.lods[].stream/offset/count.
  // opts: { lodThresholds, screenHeight, hysteresis }
  constructor(geometry, material, clusterSet, opts = {}) {
    // THREE only issues one drawElements call PER GEOMETRY GROUP when object.material is an
    // ARRAY (WebGLRenderer.projectObject's Array.isArray(material) branch, three.module.js
    // ~17669) -- with a single (non-array) material every renderList entry gets group:null,
    // and renderBufferDirect's `if (group !== null)` clamp (~16986) never fires, so it draws
    // geometry.drawRange (this class never restricts it) intersected with the FULL index.count,
    // completely ignoring whatever _render() just wrote to geometry.groups. Confirmed live: on
    // the real deployed build, groupsSum (the LOD-selected sub-range this class computes) was
    // always LESS than indexCount (the full LOD0+coarse buffer) for every ClusterLodMesh, and
    // materialIsArray was false -- meaning every cluster-LOD mesh has been drawing its FULL
    // index buffer every frame regardless of camera distance/frustum culling since this class
    // was written; the whole per-cluster cull/LOD system has had zero effect on the actual draw.
    // Wrapping material in a 1-element array costs nothing (still one real material, one
    // program) but flips THREE onto the per-group renderList path, so drawStart/drawEnd
    // actually clamp to each group's real [start,count) -- restoring real LOD culling.
    super(geometry, Array.isArray(material) ? material : [material]);
    this.clusterSet = clusterSet;
    this.lod0Count = opts.lod0Count != null ? opts.lod0Count : _inferLod0Count(clusterSet);
    this.lodThresholds = opts.lodThresholds || DEFAULT_LOD_THRESHOLDS;
    this._screenHeight = opts.screenHeight || 1080;
    this._hyst = opts.hysteresis != null ? opts.hysteresis : 0.15;
    this._curLod = new Int8Array(clusterSet.clusters.length).fill(-1);

    // Per-frame scratch (sized to worst case = every cluster drawn).
    const n = clusterSet.clusters.length;
    this._starts = new Int32Array(n); // byte offsets into element buffer
    this._counts = new Int32Array(n);
    this._drawCount = 0;

    // Per-cluster world-AABB cache: applyMatrix4 on the 8-corner box is redone only when this
    // instance's OWN matrixWorld has actually changed since the last _render call (the vast
    // majority of clustered entities -- static architecture/props -- never move after placement).
    // _worldAabbMin/Max are flat Float32Arrays [x,y,z per cluster]; _lastMatrixEls is a copy of the
    // 16 matrixWorld elements from the frame that produced them, compared cheaply before reuse.
    this._worldAabbMin = new Float32Array(n * 3);
    this._worldAabbMax = new Float32Array(n * 3);
    this._worldAabbValid = false;
    this._lastMatrixEls = new Float32Array(16);
    // World-space sphere cache (center xyz + radius) + the scale scalar used to derive world
    // radius from the local sphere.sphere[3] -- computed under the SAME matrixChanged guard as
    // the AABB cache above, so a static (non-moving) cluster's sphere is transformed once per
    // matrix change instead of every frame it's drawn.
    this._worldSphereCenter = new Float32Array(n * 3);
    this._worldSphereRadius = new Float32Array(n);
    this._scale = 1;

    this._ext = null;
    this._extProbed = false;
    // Guards against onBeforeRender re-entrancy within one frame -- see _render()'s inline
    // comment. -1 never matches a real renderer.info.render.frame value (starts at 0/1).
    this._lastRenderFrame = -1;
    this._groupPoolByClusterIndex = [];
    for (let i = 0; i < n; i++) this._groupPoolByClusterIndex.push({ start: 0, count: 0, materialIndex: 0 });

    // Live stats for the browser witness.
    this.stats = { visibleClusters: 0, drawnTris: 0, totalTris: 0, multiDrawSubmissions: 0, ext: null };
    for (const c of clusterSet.clusters) this.stats.totalTris += c.lods[0].count / 3;

    // Take over drawing (guard + legacy fallback only -- see the header's WHEN paragraph; the real
    // per-render work is prepare(), called from the pool's scene.onBeforeRender pre-pass).
    this.onBeforeRender = this._render.bind(this);
    this.frustumCulled = false; // we cull per-cluster ourselves

    // CRITICAL bootstrap: THREE.WebGLRenderer.projectObject's per-group renderList path (needed
    // since the constructor now wraps material in an array, see below) is
    // `for (i=0; i<geometry.groups.length; i++) currentRenderList.push(...)` -- and object.
    // onBeforeRender is only invoked from INSIDE that per-group renderObject() call. A fresh
    // THREE.BufferGeometry's .groups defaults to [] (never set anywhere else in this class before
    // this point), so on the VERY FIRST frame projectObject sees an empty array, pushes ZERO
    // renderList entries, and onBeforeRender (._render, which is the ONLY place that ever
    // populates .groups with something real) never gets invoked at all -- a permanent chicken-
    // and-egg deadlock, not a one-frame startup delay: every subsequent frame's projectObject
    // pass hits the exact same empty array again, forever. Live-witnessed on the deployed
    // gh-pages build: sillos (and in fact every ClusterLodMesh instance, 96/96 in one live
    // session) never rendered a single frame after the array-material fix landed, confirmed via
    // stats.multiDrawSubmissions staying at its constructor default (0) for 130+ seconds of real
    // gameplay. Seed one full-range group here so the first real frame's projectObject pass finds
    // a non-empty array and _render() gets its first chance to run; every frame after that is
    // self-sustaining (this._render always writes a non-empty groups array, whether from real
    // per-cluster culling results or its own n===0 full-range fallback).
    geometry.groups = [{ start: 0, count: this.lod0Count, materialIndex: 0 }];
  }

  // Map a cluster lod descriptor to a byte offset into the unified element buffer.
  // stream 0 = LOD0 region (offset as-is); stream 1 = coarse region (after lod0Count).
  _byteOffset(lod, bytesPerIndex) {
    const base = lod.stream === 1 ? this.lod0Count : 0;
    return (base + lod.offset) * bytesPerIndex;
  }

  // Squared-distance form: avoids the sqrt in distanceTo() (callers pass distSq =
  // distanceToSquared) and the per-cluster division in projSize. Original test was
  // `(sh*radius)/(dist*tanHalf) > eff`, i.e. `sh*radius > eff*dist*tanHalf`. Both sides
  // are non-negative (sizes/distances/tanHalf for fov<180deg), so squaring both sides of
  // a `>` between non-negatives preserves direction: `(sh*radius)^2 > eff^2*tanHalf^2*distSq`.
  // sizeSq = (sh*radius)^2 and tanHalfSq = tanHalf^2 are passed in (camera/cluster inputs);
  // this fn just compares against eff^2*tanHalfSq*distSq -- algebraically identical selection,
  // no sqrt or division per cluster.
  _pickLod(ci, sizeSq, distSq, tanHalfSq) {
    const t = this.lodThresholds;
    const cur = this._curLod[ci];
    let lod = t.length; // default coarsest
    for (let i = 0; i < t.length; i++) {
      // hysteresis: to gain detail (lower i) require clearing threshold by +margin;
      // to drop require falling below by -margin. Bias by current level.
      const goingUp = cur < 0 || cur > i;
      const eff = goingUp ? t[i] * (1 + this._hyst) : t[i] * (1 - this._hyst);
      if (sizeSq > eff * eff * tanHalfSq * distSq) { lod = i; break; }
    }
    // clamp to available LODs for this cluster
    const avail = this.clusterSet.clusters[ci].lods.length;
    if (lod >= avail) lod = avail - 1;
    this._curLod[ci] = lod;
    return lod;
  }

  // Once-per-render PRE-PASS entry (cluster-lod-prepass, see header). Called from
  // ModelPool.prepareClusterFrame inside THREE's scene.onBeforeRender, i.e. after this.matrixWorld and
  // camera.matrixWorldInverse are current for THIS render() call and before projectObject reads
  // geometry.groups. renderer.info.render.frame is still the PREVIOUS render's value at this point
  // (WebGLRenderer increments it after projectObject, before the draw loop), so the per-render guard
  // is armed at frame+1: every object.onBeforeRender (_render) of this same render() call then reads
  // frame+1 and no-ops, and the legacy in-draw compute only ever runs for a render() that had no
  // pre-pass at all.
  prepare(renderer, camera) {
    const geometry = this.geometry;
    if (!geometry) return;
    const frame = renderer.info.render.frame + 1;
    if (this._lastRenderFrame === frame) return;
    this._lastRenderFrame = frame;
    this._compute(renderer, camera, geometry, frame);
  }

  _render(renderer, scene, camera, geometry) {
    const frame = renderer.info.render.frame;

    // CRITICAL re-entrancy guard: THREE.WebGLRenderer.projectObject (Array.isArray(material)
    // branch, since the constructor wraps material in an array -- see that comment) pushes ONE
    // renderList entry PER GEOMETRY GROUP, and WebGLRenderer.renderObject calls
    // object.onBeforeRender (this method) once per renderList entry -- i.e. once PER GROUP, not
    // once per object/frame. A mesh with N visible groups this frame gets THIS function called N
    // times in the same frame (live-witnessed: a real sillos ClusterLodMesh with 12 groups saw
    // exactly 12 onBeforeRender calls per frame). Every call below re-runs the FULL per-cluster
    // frustum-cull + LOD-select pass and OVERWRITES the pooled `_groupPool` entries in place, then
    // reassigns `geometry.groups = view` (a fresh array, but wrapping the SAME pooled objects).
    // projectObject already captured DIRECT REFERENCES to those pooled group objects into every
    // renderList entry for this frame (`currentRenderList.push(object, geometry, groupMaterial,
    // groupOrder, z, group)` where `group` IS `_groupPool[i]`) BEFORE any drawing/onBeforeRender
    // happens. So group-0's draw call (which triggers the FIRST _render() invocation) is fine, but
    // by the time group-1's renderList entry actually draws, its `group` reference may already
    // have been mutated by a SECOND, THIRD, ... _render() call (fired for group-1's own
    // onBeforeRender, group-2's, etc.) that recomputed a possibly-different cull/LOD result this
    // same frame and rewrote the pool's `.start`/`.count` fields out from under the earlier
    // entries -- corrupting which index sub-range each already-queued draw call actually uses.
    // This is a real, live-reproduced root cause of the sillos "864-byte buffer" scramble class of
    // bug (a small/stale group's leftover start/count silently substituted into a different,
    // larger draw call): NOT a GPU/VAO binding-state issue, but plain JS aliasing between a pooled
    // mutate-in-place array and multiple renderList entries holding live references into it within
    // one frame. Fix: do the expensive cull/LOD/pool-mutation work AT MOST ONCE per instance per
    // frame; every subsequent same-frame call (group 2..N's onBeforeRender) is a no-op, since
    // geometry.groups (and every pooled object it references) is already correct and stable for
    // the rest of this frame's draws once the first call finishes.
    //
    // With the pre-pass (prepare() above) this guard is ALSO what makes the in-draw path a no-op on
    // every normally-hooked render(): prepare() already stamped _lastRenderFrame = frame for this
    // render call, so this returns immediately and geometry.groups stays exactly what projectObject
    // built the renderList from. Only a render() with no pre-pass (unhooked scene) falls through.
    if (this._lastRenderFrame === frame) return;
    this._lastRenderFrame = frame;
    this._compute(renderer, camera, geometry, frame);
  }

  // The real per-render cull + LOD-select + group-build body, shared by prepare() (pre-pass, the
  // normal path) and _render() (legacy in-draw fallback) so there is exactly one implementation.
  // `frame` is the caller's per-render key (see prepare()'s frame+1 note) for the shared camera cache.
  _compute(renderer, camera, geometry, frame) {
    const index = geometry.index;
    if (!index || !this.clusterSet) return; // nothing to do; default draw renders full LOD0

    // Camera-only inputs (projScreen/frustum/camPos/screen-height/tanHalf) are identical for every
    // ClusterLodMesh drawn in this render() pass -- recompute once per frame, not once per instance.
    if (_camCache.renderer !== renderer || _camCache.camera !== camera || _camCache.frame !== frame) {
      _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_projScreen);
      _v.setFromMatrixPosition(camera.matrixWorld); // camera.matrixWorld is already current inside onBeforeRender; avoids getWorldPosition's redundant parent-chain re-update+decompose
      // Live viewport height from the renderer's drawing buffer (falls back to the
      // constructor value) so projected-size LOD thresholds track the real canvas.
      let sh = this._screenHeight;
      try { const sz = renderer.getDrawingBufferSize(_size); if (sz.y > 0) sh = sz.y; } catch (_) {}
      const tanHalf = camera.isPerspectiveCamera ? Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) : 1;
      _camCache.renderer = renderer; _camCache.camera = camera; _camCache.frame = frame;
      _camPos.copy(_v); _camCache.sh = sh; _camCache.tanHalf = tanHalf;
      _camCache.tanHalfSq = tanHalf * tanHalf;
    }
    const camPos = _camCache.camPos, sh = _camCache.sh, tanHalfSq = _camCache.tanHalfSq;
    const me = this.matrixWorld.elements;

    // Static-entity fast path: this instance's matrixWorld is identical to the frame that last
    // computed _worldAabbMin/Max (and now the world-sphere cache below), so every cluster's world
    // AABB/sphere is already correct -- skip the per-cluster applyMatrix4 (8-corner transform) and
    // sphere transform entirely for the (common) non-moving case.
    const last = this._lastMatrixEls;
    let matrixChanged = !this._worldAabbValid;
    if (!matrixChanged) {
      for (let i = 0; i < 16; i++) { if (last[i] !== me[i]) { matrixChanged = true; break; } }
    }
    // Scale scalar (magnitude of the largest basis column) is only needed to derive world sphere
    // radius from local radius, and that derivation only happens under matrixChanged below -- so
    // only recompute it when the matrix actually changed; otherwise reuse the cached value.
    // Math.sqrt(max of squared lengths) is one sqrt total instead of three Math.hypot calls (each
    // of which is itself a sqrt internally), since we only need the MAX column length, not all three.
    if (matrixChanged) {
      const sq0 = me[0] * me[0] + me[1] * me[1] + me[2] * me[2];
      const sq1 = me[4] * me[4] + me[5] * me[5] + me[6] * me[6];
      const sq2 = me[8] * me[8] + me[9] * me[9] + me[10] * me[10];
      this._scale = Math.sqrt(Math.max(sq0, sq1, sq2));
      last.set(me); this._worldAabbValid = true;
    }
    const scale = this._scale;

    // GEOMETRY GROUPS (not a custom multiDraw). onBeforeRender runs BEFORE three binds this mesh's
    // VAO, so a custom gl draw here ran with the wrong/stale element+vertex state -> GL_INVALID
    // 'Insufficient buffer size' storms on strict drivers (ANGLE/D3D11: context degrades, FPS
    // collapse) and, when it drew, wrong normals/uvs + collapsed verts. Instead we declare which
    // index sub-ranges to draw as geometry GROUPS and let three's NORMAL pipeline draw them: three
    // sets up the full correct VAO and issues one drawElements per group, with correct attributes,
    // no double-draw, no extra buffers, and Mesh.raycast still works (it walks the full index, not
    // groups). Each group uses materialIndex 0 (single material). Per-cluster LOD selection by
    // projected size is preserved; an empty group set falls back to drawing the full index (LOD0).
    let drawnTris = 0, visible = 0, n = 0;
    const pool = this._groupPoolByClusterIndex;
    const drawnCi = this._drawnCi || (this._drawnCi = []);
    drawnCi.length = 0;
    const clusters = this.clusterSet.clusters;
    for (let ci = 0; ci < clusters.length; ci++) {
      const c = clusters[ci];
      // Cull test uses the per-cluster AABB (exact-fit to the cluster's LOD0 verts),
      // not the bounding sphere: a sphere under-covers thin flat geometry (slabs),
      // false-culling near frustum edges. box3.min/max in local space -> world AABB
      // via applyMatrix4 (re-fits axis-aligned bounds correctly under rotation,
      // unlike scaling a sphere radius). Run BEFORE any sphere work below so a
      // culled cluster never pays for a world-sphere transform it won't use.
      const o3 = ci * 3;
      if (matrixChanged) {
        // Both the AABB and the world sphere are cached unconditionally here (NOT gated on the
        // cull test below), because the cull test's OUTCOME can change frame-to-frame even when
        // matrixChanged stays false (the camera moves, changing the frustum, while this object's
        // own matrixWorld does not) -- if a cluster's sphere were only cached when it happened to
        // also pass the cull test on the matrixChanged frame, a later frame where it becomes
        // visible under the SAME (unchanged) matrix would read a stale/never-written cache entry.
        // Caching both under matrixChanged alone, independent of visibility, keeps the invariant
        // "cache is valid whenever matrixChanged is false" true for every cluster, not just the
        // ones visible on the frame the matrix last changed.
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
      // Sphere center/radius still drive the projected-size LOD estimate (cheap distance/radius
      // proxy, not a cull test -- under-coverage doesn't matter here). Read from the cache here
      // (populated above, either freshly this frame or on a prior matrixChanged frame); the
      // per-cluster transform itself is skipped for AABB-culled clusters since we only reach here
      // after the cull test has already passed.
      if (!matrixChanged) {
        _sphere.center.set(this._worldSphereCenter[o3], this._worldSphereCenter[o3 + 1], this._worldSphereCenter[o3 + 2]);
        _sphere.radius = this._worldSphereRadius[ci];
      }
      // Squared form: distSq via distanceToSquared (no sqrt), sizeSq = (sh*radius)^2
      // compared against eff^2*tanHalf^2*distSq -- see _pickLod's algebra comment.
      // The original 1e-3 floor guarded `dist` before division-by-dist; squared form
      // guards the same divide-by-~0 case by flooring distSq at 1e-6 (= (1e-3)^2).
      const distSq = Math.max(1e-6, _sphere.center.distanceToSquared(camPos));
      const sizeSq = (sh * _sphere.radius) * (sh * _sphere.radius);
      const lodIdx = this._pickLod(ci, sizeSq, distSq, tanHalfSq);
      const lod = c.lods[lodIdx];
      if (!lod.count) continue;
      const base = lod.stream === 1 ? this.lod0Count : 0;     // start in ELEMENTS (groups use element offsets)
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

// Given a decoded primitive's geometry (LOD0 in geometry.index) and the coarse
// index typed-array (from the accessor referenced by extras.coarseIndexAccessor),
// produce ONE concatenated element buffer [LOD0 | coarse] and attach it as the
// geometry index, returning {clusterSet, lod0Count}. Tolerates absent extras
// (returns null -> caller renders the geometry as a plain full-res mesh).
export function attachClusterLod(geometry, extras, coarseIndexArray) {
  const clusterSet = parseClusterLod(extras);
  if (!clusterSet) return null;

  const lod0 = geometry.index ? geometry.index.array : null;
  if (!lod0) return null;
  const lod0Count = lod0.length;
  const coarse = coarseIndexArray || new Uint32Array(0);

  // One element buffer big enough for both; promote to Uint32 if needed. The
  // vertex-count check alone isn't sufficient: a malformed/hand-edited coarse
  // accessor could itself contain an out-of-range index value even when the
  // real vertex count fits in 16 bits, and a Uint16Array constructor would
  // silently truncate/wrap that value rather than throwing -- so also check
  // the actual max value present in the coarse array.
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

// Client-side final defense against degenerate (near-zero-area) triangles: a
// bake-time check (packages/streaming-gltf/tools/bake-cluster.mjs) already
// scans the pre-cluster AND post-cluster geometry per source primitive, but a
// source file can still carry TWO vertices at the same position referenced by
// DIFFERENT, non-adjacent triangles in the original export -- individually
// non-degenerate there, yet MeshoptClusterizer's own vertex append/reorder
// (which packs cluster-local vertex tables independently per cluster) can end
// up placing both at adjacent indices inside the SAME cluster, forming a NEW
// triangle that IS degenerate -- a combination the bake-time per-primitive
// checks cannot see since it only exists after this runtime combine step.
// Collapsing in place (not removing) keeps every array length and every
// cluster's recorded offset/count exactly unchanged.
//
// AREA, not edge length: a zero-length edge (coincident vertices) is one cause
// of a degenerate triangle, but three DISTINCT, well-separated vertices that
// happen to be collinear also produce a zero-area sliver invisible to an
// edge-length check (every edge can be arbitrarily long while the cross
// product -- and therefore the area -- is exactly zero). This function used
// an edge-length<1e-6 check alone until a live browser scan of the actual
// rendered geometry (window.__scene traversal, ClusterLodMesh.geometry.index)
// found 9715 real degenerate triangles STILL shipping in aim_sillos.glb's
// combined LOD0+coarse buffer despite the bake-time area-based checks
// (bake-cluster.mjs's _dropDegenerateTriangles/_checkClusterLodResultForDegenerates,
// both already fixed to EPS_AREA=1e-4 real triangle area) reporting zero
// fixes -- this THIRD, independent client-side check was the one still
// silently reintroducing/missing them, on both counts: wrong metric (edge
// length instead of area) AND a stale threshold (1e-6, never updated
// alongside the other two checks' 1e-4). EPS_AREA matches those two checks
// exactly -- see AGENTS.md project/degenerate-triangle-threshold-is-not-a-
// tunable-guess for how that value was derived (a real measured gap in this
// asset's triangle-area histogram, not a guess).
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

// Fan-triangle defect (distinct from the zero-area class above): a real,
// live-witnessed defect on aim_sillos.glb's PROGRESSIVE load path -- a shared-
// apex vertex reused across non-adjacent clusters can end up forming a real-
// area sliver that spans clear across the mesh once combined here. The bake-
// time fix (packages/streaming-gltf/tools/bake-cluster.mjs's own
// _collapseFanTriangles) only covers the offline bake pipeline; this runtime
// combine step (model-pool.js's cluster-mode load path, used for progressively-
// streamed entities) parses clusters independently and never got the same
// check -- confirmed live via window.__scene: entity_4_model.progressive.glb's
// combined LOD0+coarse buffer still carried a 59.7-unit edge (real area
// 7.15m^2, not caught by EPS_AREA) inside a mesh whose own bounding box
// diagonal is ~63 units. Same fix as the bake-time version: any triangle edge
// exceeding 3x its OWN cluster's AABB diagonal is definitionally wrong
// (clusters are spatially coherent meshlets by construction), collapsed the
// same way as an EPS_AREA hit so downstream offset/count tables stay unchanged.
function _collapseFanTriangles(index, pos, clusterSet) {
  let fixed = 0;
  for (const cluster of clusterSet.clusters) {
    const [mnx, mny, mnz, mxx, mxy, mxz] = cluster.aabb;
    const diag = Math.hypot(mxx - mnx, mxy - mny, mxz - mnz);
    const maxLegitEdgeSq = (diag * 3) * (diag * 3);
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
