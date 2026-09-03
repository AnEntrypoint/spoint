# Changelog

Notable changes to `streaming-gltf`. Version numbers match `package.json` /
npm releases (`chore release vX.Y.Z` commits). Format is loosely
[Keep a Changelog](https://keepachangelog.com/), newest first.

## Unreleased

- fix: hardening pass -- input/type validation on `spawn()`, `bakeCluster()`,
  `parseClusterLod()`, `attachClusterLod()`; idempotent `ModelPool.dispose()`;
  clearer errors for malformed GLB responses and misconfigured queues.
- docs: JSDoc type annotations on the public `index.js` exports; this file.
- feat: publish `OcclusionQueryTier` as a standalone export
  (`streaming-gltf/occlusion-query-tier`). It was already renderer-agnostic
  (any candidate exposing `.root`, a `THREE.Object3D`), previously only
  reachable internally by `ModelPool` -- consumers can now drive the same
  WebGL2 `ANY_SAMPLES_PASSED_CONSERVATIVE` box-query occlusion culling for
  non-model scene layers (e.g. chunked vegetation/terrain) sharing the same
  depth buffer.

## 2.0.14

- perf: throttle `_enforceBudget`'s per-frame eviction scan (was running the
  full O(entities) scan every frame while over budget; now cooldown-gated
  like the sibling unload/stats scans).
- perf: partial-upload the bound-sphere instance attribute via
  `addUpdateRange`; dedupe skinned-LOD disk reads.
- fix(cluster-lod-mesh): frustum-cull clusters against their per-cluster AABB,
  not a bounding sphere (a sphere under-covers thin flat geometry, causing
  false culls near frustum edges).

## 2.0.9 - 2.0.12

- feat(model-pool): opt-in WebGL2 `ANY_SAMPLES_PASSED_CONSERVATIVE`
  occlusion-query culling, and a WebGPU compute-shader occlusion tier
  alongside it.
- perf: cache per-frame camera state and pool `geometry.groups` objects in
  `ClusterLodMesh` (was allocating a fresh group array/object per visible
  cluster per frame).

## 2.0.7 - 2.0.8

- perf(model-pool): partial GPU upload of the per-instance transform texture
  via `addUpdateRange` instead of re-uploading the whole texture on any
  instance change.
- feat(demo): load the cluster corpus from the assets gh-pages unified
  manifest.

## 2.0.5 - 2.0.6

- feat(model-pool): `setRotation(entity, quat)` so pool-routed entities can
  rotate (previously only position interpolation was supported for
  networked/kinematic entities routed through the instanced tiers).

## 2.0.3 - 2.0.4

- fix(model-pool): cluster mode double-applied the source glTF node's TRS,
  producing a tiny, mis-rotated model when the source had a non-identity
  import transform (e.g. a 0.03 scale). Fixed to use a root-relative
  transform, matching the discrete-LOD path's convention.
- fix(cluster-lod): draw visible clusters via `geometry.groups` (three's
  normal render pipeline), not a custom `onBeforeRender` multi-draw call --
  `onBeforeRender` runs before three binds the mesh's VAO, so a custom GL
  draw there raced stale buffer state and produced "Insufficient buffer size"
  errors and FPS collapse on strict drivers (ANGLE/D3D11).

## 2.0.1 - 2.0.2

- perf(meshlet-codec): removed allocation churn from `buildClusterLod`'s hot
  loop.
- feat(bake): emit discrete `EP_progressive_lod` sibling LODs for skinned/VRM
  primitives (cluster-LOD only handles static topology; skinned meshes get a
  meshopt-simplified discrete LOD ladder instead).

## 2.0.0

- feat(cluster-lod): replaced the discrete-LOD system with UV-aware spatial
  meshlet cluster-LOD -- one unified vertex/index buffer per asset, drawn via
  geometry groups with a per-cluster LOD picked by projected screen size.
  Textures never tear (UV-aware simplification), and stock glTF viewers that
  ignore the `EP_cluster_lod` extras still render the full-resolution mesh.

## 1.0.17 - 1.0.19

- feat(textures): one GPU-compressed KTX2 texture per slot (replacing a webp
  size ladder), mip-based LOD, vertex-first streaming order.
- feat(streaming): coarse-first `single-glb-range` storage mode plus a
  `.plod`-style byte-range consumer for regular (non-progressive) glTF.
- feat(bake): resumable corpus baker, non-indexed mesh welding, generic glTF
  compatibility fixes, asset credits.
- feat(impostor): opt-in lit octahedral impostor final-LOD tier (ported from
  agargaro's octahedral-impostor technique).

## Earlier

See `git log` for the full history predating this file.
