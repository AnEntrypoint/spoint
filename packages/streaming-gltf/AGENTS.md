# streaming-gltf — agent notes

Cluster-LOD glTF renderer. Static geometry is cluster-based end to end; the
discrete/progressive sibling-LOD format survives only for skinned primitives
(see below). No backwards compatibility with pre-2.0.0 bakes.

## Format: EP_cluster_lod (single valid GLB)

`tools/bake-cluster.mjs` (`bakeCluster(inGlb, outGlb)`, also `npm run bake`) turns
each unskinned static primitive into:

- **One unified vertex+index buffer.** `MeshoptClusterizer.buildMeshletsSpatial`
  partitions the mesh into spatially coherent meshlets (<=128 tris). For each
  cluster a hierarchy of LODs is produced by UV-aware `simplifyWithAttributes`
  (TEXCOORD weights + `LockBorder` so texture seams never tear). Vertices are
  reordered to index order for GPU fetch locality.
- **`primitive.indices` = LOD0 of every cluster = the full-res mesh.** A stock
  glTF viewer that ignores extras draws this once and renders the full model.
- **Coarse LOD1..N indices** live in a sidecar accessor referenced by
  `extras.EP_cluster_lod.coarseIndexAccessor`.
- **`extras.EP_cluster_lod`** (JSON only): `{version, clusterCount, lodCount,
  coarseIndexAccessor, coarseIndexCount, clusters:[{aabb:[6], sphere:[4],
  lods:[[offset,count,stream]]}]}`. `stream` 0 = `primitive.indices`, 1 = coarse
  accessor.
- **`EXT_meshopt_compression`** applied at write with `method: FILTER` (lossless,
  NO reorder/quantize — reorder would scramble the cluster offset table). The
  baker also strips the now-dead `KHR_draco_mesh_compression` so stock loaders
  need no DRACOLoader.
- The baker runs `dedup()` only: never the `meshopt()` transform (its `reorder()`
  scrambles the cluster offset table) and never `prune()` (it garbage-collects the
  coarse accessors, which only extras reference). `_fixCoarseIndexEncoding` finds
  each coarse accessor by name after write, appends its indices uncompressed in a
  new bufferView, and patches its final index into `coarseIndexAccessor`.

Skinned / morph-target primitives are not clustered (cluster-LOD is static-only).
`_bakeSkinnedLods` writes meshopt-simplified discrete siblings (ratios 0.4, 0.15)
under `<outDir>/lods/` and splices `extensions.EP_progressive_lod` into the root
JSON chunk, always with `textures: []` because `model-pool.js` iterates it; the
runtime swaps sibling geometry onto the root's skeleton.

## Runtime

`src/meshlet-codec.js` holds the bake-side `buildClusterLod`/`buildClusterLodExtra`
and the browser-safe `parseClusterLod`; `attachClusterLod` lives in
`src/cluster-lod-mesh.js`.

`src/cluster-lod-mesh.js` `ClusterLodMesh` (a `THREE.Mesh`)
holds the unified geometry (LOD0 + coarse concatenated into one element buffer) and
the parsed cluster set. Its `onBeforeRender` each frame: frustum-culls clusters by
bounding sphere, picks a LOD per visible cluster by projected screen size (with
hysteresis), and declares the chosen index ranges as geometry GROUPS -- three's
normal pipeline then issues one `drawElements` per group with the correct VAO/
attributes (NOT a raw `WEBGL_multi_draw` call: `onBeforeRender` fires before three
binds the VAO, so a manual multi-draw there hit stale buffer state). When no
cluster survives culling, `_render()` emits one fallback group spanning the full
LOD0, and the constructor seeds that same group for the first frame.

`model-pool.js` detects `EP_cluster_lod` at asset load, prepares the cluster
geometry once, and each spawned `Entity` renders a `ClusterLodMesh` — bypassing
the discrete-LOD machinery entirely (`trackedMeshes` stays empty; `_update` is a
no-op for cluster entities; the per-cluster LOD self-drives off the camera).

`src/occlusion-query-tier.js` `OcclusionQueryTier`
(opt-in via `new ModelPool({..., useOcclusionQuery: true})`) adds entity-level
"cull each other" culling on top of per-cluster frustum culling: WebGL2 native
`ANY_SAMPLES_PASSED_CONSERVATIVE` query objects test each frustum-visible
entity's bounding box against the real depth buffer, one frame of latency
(query issued frame N, resolved+applied frame N+1 to avoid a GPU sync stall).
The app must call `pool.runOcclusionQueries()` once per frame AFTER
`renderer.render(scene, camera)` (needs that frame's real depth buffer as the
occluder source). Fail-open: an entity with no resolved verdict yet stays
visible. A previously-occluded entity stays a query candidate forever (its
LOD/distance work is skipped while hidden, but it keeps getting re-tested) so
a moving/disappearing occluder doesn't leave it permanently hidden.

## Bake the corpus

`npm run bake:corpus` (`tools/bake-cluster-corpus.mjs`) walks `../assets`
`manifest.json`, bakes each source to `../assets/streaming-cluster/<name>.cluster.glb`,
and writes `manifest.cluster.json`. Run heavy bakes as separate `node` processes,
never inline in a long-lived host (large clustering OOMs an in-process worker).
`SPOINT_NO_MESHOPT=1` skips the `EXT_meshopt_compression` write, for isolating
client-side meshopt decode when on-disk and browser-decoded geometry disagree.

@.gm/next-step.md
