// streaming-gltf — public SDK entry.
//
// Cluster-LOD glTF renderer: each asset is baked into UV-aware spatial meshlet
// clusters with per-cluster hierarchical LODs packed into one unified buffer
// (EP_cluster_lod extras + EXT_meshopt_compression, a 100%-valid single GLB). At
// runtime each visible cluster picks a LOD by projected size and the whole mesh
// draws in a single WEBGL_multi_draw call. Stock glTF viewers ignore the extras
// and render the full-resolution mesh.
//
// `three` is a peer dependency — provide it yourself (e.g. via an importmap
// pointing at a CDN build, or your bundler). This package does not bundle three.
//
//   import { ModelPool } from 'streaming-gltf';
//   const pool = new ModelPool({ scene, renderer, camera });
//   const e = pool.spawn(url, { position: [x, 0, z] });
//   pool.update(); // per-frame, after advancing the camera
//   pool.setTarget(e, x, y, z, durationMs); // GPU-interpolated position targets
//
// Bake a GLB to the cluster-LOD format with `npm run bake -- <in.glb> <out.glb>`
// (tools/bake-cluster.mjs) or a whole corpus with `npm run bake:corpus`.

/**
 * @typedef {Object} ModelPoolOptions
 * @property {import('three').Scene} scene
 * @property {import('three').WebGLRenderer|import('three').WebGPURenderer} [renderer]
 * @property {import('three').Camera} [camera]
 * @property {number} [targetFps=50]
 * @property {boolean} [useBatchedFarTier=false] Collapse distinct far-asset draws into one BatchedMesh.
 * @property {boolean} [useImpostorFinalLod=false] Enable the octahedral-impostor final LOD tier (lit albedo+normal/depth atlas, one InstancedMesh draw per distinct asset).
 * @property {boolean} [useOcclusionQuery=false] Opt-in GPU occlusion-query culling (WebGL2 conservative queries, or a WebGPU compute tier).
 * @property {number} [byteBudget] VRAM byte budget; auto-estimated from the GPU if omitted.
 * @property {number} [maxConcurrentFetches=6]
 */

/**
 * @typedef {Object} SpawnOptions
 * @property {[number,number,number]} [position]
 * @property {[number,number,number]} [rotation] Euler angles in radians.
 * @property {number} [scale] Uniform scale factor.
 * @property {boolean} [static=false] Disable per-frame matrix auto-update for entities that never move after spawn.
 */

/**
 * `ModelPool` — the main entry point. Construct one per scene with
 * `new ModelPool(opts)` ({@link ModelPoolOptions}), then per frame:
 *
 *   pool.spawn(url, opts)                       -> Entity-like proxy ({@link SpawnOptions})
 *   pool.update()                                 per-frame tick (call after advancing the camera)
 *   pool.setTarget(entity, x, y, z, durationMs)   GPU-interpolated position target
 *   pool.setRotation(entity, quaternion)          set an entity's orientation
 *   pool.dispose()                                tear down every entity/asset/GPU resource (idempotent)
 *
 * `spawn()` returns synchronously; the returned proxy emits `'ready'` once the
 * asset has loaded and the first LOD is applied, and `'error'` if loading fails
 * (malformed GLB, network failure, etc). Call `.dispose()` on the returned
 * proxy/entity to release it (safe to call before the asset has resolved).
 */
export { ModelPool, ensureSharedKtx2Loader } from './src/model-pool.js';

/**
 * `ClusterLodMesh` — a `THREE.Mesh` subclass that self-drives per-cluster
 * frustum culling + LOD selection + drawing off the live camera in
 * `onBeforeRender`. Constructed internally by `ModelPool` for cluster-LOD
 * assets; exported for advanced/standalone use.
 *
 * `attachClusterLod(geometry, extras, coarseIndexArray)` concatenates a
 * primitive's LOD0 index buffer with its coarse (LOD1+) index buffer into one
 * combined element buffer and returns `{ clusterSet, lod0Count }`, or `null`
 * if `extras` carries no valid `EP_cluster_lod` payload or `geometry` has no
 * index.
 */
export { ClusterLodMesh, attachClusterLod } from './src/cluster-lod-mesh.js';

/**
 * Cluster-LOD codec (`EP_cluster_lod`), used by the bake tools + runtime:
 *
 *   buildClusterLod(geo, opts)               bake-time: builds a unified cluster-LOD buffer from raw geometry
 *   buildClusterLodExtra(result, coarseIdx)  bake-time: serializes a build result into the glTF extras JSON shape
 *   parseClusterLod(extras)                  runtime: parses+validates a primitive's extras[CLUSTER_LOD_EXTRA_KEY];
 *                                             returns null (fail-open) on any missing/malformed structure
 *   CLUSTER_LOD_EXTRA_KEY                    the extras key name ('EP_cluster_lod')
 */
export { buildClusterLod, buildClusterLodExtra, parseClusterLod, CLUSTER_LOD_EXTRA_KEY } from './src/meshlet-codec.js';
