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

`src/webgpu-hiz-tier.js` `WebGpuHizTier` + `src/webgpu-hiz-shaders.js` run the
per-cluster GPU frustum + HiZ occlusion cull. The invariant is that this cull
EQUALS the CPU cull above, not approximately: `scripts/webgpu-hiz-cull-parity-witness.mjs`
drives both culls over one 16-cluster mesh in a real accelerated browser and
counts disagreements per frame (CPU-culls-but-GPU-draws, GPU-culls-but-CPU-draws,
LOD mismatch); zero is a pass. It once reported 164 disagreements over a 12-frame
sweep because `CULL_LOD_WGSL` did not compile at all (`operator >> (i32, i32)`
in `selectHzbLevel`), so the pipeline was invalid and the cull emitted ZERO
indirect draws while the CPU drew every cluster -- a shader that fails to compile
is a silent no-op, not a visible error. It no longer is: `createPipelineScoped`
wraps every creation in `device.pushErrorScope('validation')`/`popErrorScope()`
and `_settlePipelines` raises `WebGPUPipelineError` (`reasonCode:
webgpu-pipeline-invalid`) instead of letting a dispatch happen, after which
`supported()` answers false so the tier is never used with a dead pipeline.
Await `ensurePipelinesValidated()` at init to refuse before the first frame.
`scripts/webgpu-pipeline-validation-refusal-witness.mjs` pins it, including the
mutation that removes the scope. So the cull reads the CPU's own inputs
(screen height from the drawing buffer, `tanHalf` from the camera fov, hysteresis
and thresholds from the mesh, and the pre-frame LOD index `_pickLod` read,
published as `ClusterLodMesh._lodStateIn`) rather than keeping a second copy that
drifts, uses three's own six-plane set over the eight world AABB corners, and
mirrors `_render`'s full-LOD0 fallback group in `fallbackMain`, keyed off a
frustum-visible count and not off the occluded draw count. The pyramid is one
mip chain with per-level storage views (`textureLoad` at an arbitrary level needs
`mipLevelCount > 1` on the view), reduces with `max`, and reads every texel the
footprint touches, so occlusion errs towards drawing.

The entity-level tier (`runQueries(camera, candidates)` / `isOccluded(entity)`) drives
itself end to end, and four facts about how it does are load-bearing:

- **The pyramid is built by `runQueries`, not by a caller.** `buildHzb` had no
  production caller, so `runOcclusionQueries` reached a `!this._hzbLevels` guard every
  frame and the cull was inert with no error. `runQueries` now seeds and reduces at the
  top of the frame it culls, and P11 of the parity witness asserts the counter moved.
- **The depth to read is the frame buffer target's, not the canvas's.** three renders
  the scene into an internal frame buffer target whenever tone mapping or the output
  colour-space conversion needs one (`needsFrameBufferTarget`, true by default), so the
  canvas depth attachment stays empty while the picture is correct. `_sceneTarget()`
  resolves the target `render()` actually drew into and reads its depth through
  `renderer._textures.get(target).depthTexture` — `RenderTarget.depthTexture` itself is
  null there. An unwritten depth texture is a legal `texture_depth_2d` that reads all
  zeros, and an all-zero pyramid reports every entity occluded, so this was a silent
  false cull and not a visible error.
- **The app renders 4x MSAA.** A multisampled depth texture cannot bind as
  `texture_depth_2d`, which is a per-frame validation error
  (`Sample count (4) ... doesn't match expectation`), so the seed has a
  `texture_depth_multisampled_2d` variant (`HZB_SEED_MSAA_WGSL`) reducing with max over
  samples — max is the conservative direction, since the pyramid holds the FARTHEST
  depth a texel reaches. The count comes off the `GPUTexture`, never off
  `renderer.currentSamples`: the two disagree, and the frame buffer target keeps its own
  sample count.
- **Indirect attachment is refused on a compact mesh.** Every shipped cluster primitive
  is `_compact` (`cap === lod0Count`), so its element buffer is LOD0 only and a coarse
  `firstIndex` from the cull reads out of range; `attachIndirect` returns null and
  counts `indirectAttachRefused`. A refusal with no counter would have been the same
  silence as the missing `buildHzb` caller.

`isOccluded(entity)` reads the last landed verdict snapshot and fails open, so an entity
with no verdict is visible. `runOcclusionQueries` returns early below
`occlusionMinCandidates` (32 from `client/ModelPoolAdapter.js`), which is a cost
heuristic and not an off switch — but it is counted, as
`stats.occlusionCandidates` / `stats.occlusionSkippedBelowMin`, because a silent return
made "never ran" and "ran and found nothing" the same observation. Worlds with only a
couple of pooled entities (`tps-game` has 1-2) therefore never reach the cull at all.
Measured pop-out after an occluder disappears is 1 frame, the one-frame-stale pyramid
being the floor (`scripts/webgpu-hiz-cull-parity-witness.mjs`, P14 and P21).

Measured in `tps-game` with the gate lowered to 1 so the cull actually ran
(`scripts/draw-instrument-witness.mjs --backend=webgpu --gpu=accelerated`, 20 frames,
both arms inside one GPU lock hold): `wgpuDrawsPerFrame` 74, against 74 for the
cull-inert arm minutes later; 1 candidate tested, 0 occluded, 35 pyramids built,
24 verdict readbacks, 0 `skippedNoPyramid`, indirect refused on both of the world's
cluster meshes and attached on none, and no uncaptured device error - the per-frame
sample-count storm that preceded the multisampled seed is gone. A 181-draw reading
taken between two other lanes' commits was foreign, not the cull: on a work tree this
contended only a paired A/B inside one lock hold separates the two.

## Bake the corpus

`npm run bake:corpus` (`tools/bake-cluster-corpus.mjs`) walks `../assets`
`manifest.json`, bakes each source to `../assets/streaming-cluster/<name>.cluster.glb`,
and writes `manifest.cluster.json`. Run heavy bakes as separate `node` processes,
never inline in a long-lived host (large clustering OOMs an in-process worker).
`SPOINT_NO_MESHOPT=1` skips the `EXT_meshopt_compression` write, for isolating
client-side meshopt decode when on-disk and browser-decoded geometry disagree.

@.gm/next-step.md
