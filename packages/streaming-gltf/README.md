# Cluster-LOD glTF renderer

A three.js renderer for large scenes of distinct glTF/GLB models using
**UV-aware spatial meshlet clusters**: each static model is baked into one valid
GLB of spatially coherent clusters, each carrying a hierarchy of UV-aware
simplified LODs, packed into a single unified buffer. At runtime every visible
cluster picks a LOD by projected screen size, and the chosen index ranges become
geometry groups, which three draws with one `drawElements` per group. Textures
never tear (UV-aware simplification), and stock glTF viewers ignore the cluster
metadata and render the full-resolution mesh.

See [AGENTS.md](AGENTS.md) for the format (`EP_cluster_lod` extras +
`EXT_meshopt_compression`) and runtime details.

## Live demo

**https://anentrypoint.github.io/streaming-gltf/** — the stress demo from
`examples/local-progressive/`, published from the former standalone repo. The
package now lives in spoint's `packages/`, which carries no Pages workflow for
it, so that deploy no longer tracks this source. It
ships code only: `three` loads from a CDN (importmap) and the cluster-LOD models
are streamed **cross-origin** from the assets host
(`https://anentrypoint.github.io/assets/`), discovered from its unified
`manifest.json` (`{Category:[{name,path,thumb}]}`, `path =
streaming-cluster/<name>.cluster.glb`). Override the asset source with
`?assets=<baseUrl>`, or `?assets=local` with the dev server (`npm run demo:local`,
which serves the sibling `../assets/streaming-cluster` corpus under `/cluster/`).

## SDK usage

`streaming-gltf` is an importable ES module. `three` and `@pixiv/three-vrm` are
**peer dependencies** — provide them yourself (e.g. via an importmap, or your
bundler); they are not bundled. The importmap must map `three` and
`three/addons/`, because the LOD worker resolves its imports through it.

```js
import { ModelPool } from 'streaming-gltf';

const pool = new ModelPool({ scene, renderer, camera });
const entity = pool.spawn(url, { position: [x, 0, z] });

pool.update();
pool.setTarget(entity, x, y, z, durationMs);
```

Call `pool.update()` once per frame after moving the camera; cluster entities
pick their own LODs in `onBeforeRender`. `setTarget` interpolates an entity to a
position over `durationMs`. Other exports: `ensureSharedKtx2Loader` (runtime),
`ClusterLodMesh`, `attachClusterLod` (cluster mesh), and `buildClusterLod`,
`buildClusterLodExtra`, `parseClusterLod`, `CLUSTER_LOD_EXTRA_KEY` (codec).
Subpath exports: `streaming-gltf/model-pool`, `/draco-loader`,
`/cluster-lod-mesh`, `/meshlet-codec`, `/occlusion-query-tier`, `/bake`.

Bake a source GLB to the cluster-LOD format:

```sh
npm run bake -- path/to/source.glb path/to/out.cluster.glb
npm run bake:corpus            # whole ../assets corpus -> manifest.cluster.json
```

## VRM support

VRM avatars load through `@pixiv/three-vrm` v3 (a peer dependency). When a GLB
carries the `VRMC_vrm` extension, the root `GLTFLoader` is registered with
`VRMLoaderPlugin` and the parsed `gltf.userData.vrm` runtime is driven each frame
by `pool.update()` — humanoid bones, spring bones, expressions, and look-at all
animate.

Skinned primitives are not clustered. The baker writes discrete mesh LOD
siblings for them (ratios 0.4 and 0.15, under `lods/`, declared in
`EP_progressive_lod` with no texture LODs). Siblings load **without** the VRM
plugin, so MToon material setup runs once on the root only, and the pool swaps
sibling geometry onto the root's skeleton.

Multi-driver — every instance animates independently. `@pixiv/three-vrm` v3
exposes no skeleton-rebind clone (`VRM.prototype` is `[constructor, update]` only;
there is no `vrm.clone()` / `VRMUtils.clone`), and its humanoid/spring-bone/
expression managers bind the bones of the scene they were parsed against. Rather
than share one runtime, the pool retains the asset's raw GLB bytes and **re-parses
an independent VRM per driven entity** — each gets its own scene and managers and
is driven by `vrm.update(dt)`. At most 4 parses run at once; the rest queue.
`examples/local-progressive/vrm-multidriver-witness.html` checks two instances.

`entity.dispose()` runs `VRMUtils.deepDispose()` on that entity's own VRM scene,
freeing its spring/collider/expression GPU resources without touching siblings.
`pool.dispose()` tears the pool down (every entity, then every asset).

## Geometry decoding (meshopt + Draco)

Baked GLBs use `EXT_meshopt_compression`; the baker strips
`KHR_draco_mesh_compression`. meshopt decodes via three's `MeshoptDecoder`.
Unbaked Draco sources decode via **[draco.js](https://github.com/mrdoob/draco.js)**,
mrdoob's pure-JavaScript port of the Draco decoder, vendored at
`src/draco-loader.js` as a drop-in for three's own `DRACOLoader`: no `.wasm`
fetch and no runtime CDN. It is decode-only (the baker reads Draco sources with
the `draco3dgltf` Node module, a dev-time dependency not shipped to the browser).

The LOD web worker (`lod-worker.js`) is a module worker that imports the page's
own three build: `ModelPool` resolves `three`, `GLTFLoader`, the meshopt decoder
and this vendored Draco module through the page importmap (`import.meta.resolve`)
and passes those URLs as worker query params, and `worker-module-remap.js`
rewrites their bare `three` imports (module workers do not inherit the
importmap). No CDN is contacted, so Draco+meshopt sibling LODs decode off-thread
against the same three revision as the page. The worker registers a
geometry-only GLTFLoader plugin, so it never decodes textures (KTX2 included)
it would discard anyway. Decoder logic is a port of
Google Draco (Apache-2.0); the loader API mirrors three.js's `DRACOLoader` (MIT).

## Textures

The baker leaves textures as they are in the source, apart from dropping texture
entries that have no image. At runtime, a `ModelPool` constructed with a
`renderer` installs one shared `KTX2Loader` (Basis transcoder vendored in
`src/basis/`, mip count capped per device tier by `ktx2-mip-cap.js`), so
`KHR_texture_basisu` textures transcode to GPU-compressed formats.
`ensureSharedKtx2Loader(renderer)` returns that loader for other loaders to reuse.

## Layout

- `index.js` — package entry (the exports above).
- `src/` — runtime: `model-pool.js` (`ModelPool`), `cluster-lod-mesh.js`,
  `meshlet-codec.js`, `degenerate-triangles.js`, `cluster-material-merge.js`,
  `texture-array-atlas.js`, `material-bucket-batcher.js`, `batched-far-tier.js`,
  `occlusion-query-tier.js`, `hzb-tier.js`, `webgpu-hiz-tier.js`,
  `octahedral-impostor-ez*.js`, the LOD worker (`lod-worker.js`,
  `worker-module-remap.js`, `grid-decimate.js`), `draco-loader.js`, `basis/`, and
  loading/budget helpers (`deferred-load-queue.js`, `lod-unload-manager.js`,
  `frustum-cache.js`, `material-*.js`, `ktx2-mip-cap.js`).
- `tools/` — `bake-cluster.mjs` (bake one GLB), `bake-cluster-corpus.mjs` (bake
  the `../assets` corpus), `spatial-split.mjs` (split a large GLB into an X/Z tile
  grid and cluster-bake each tile, writing `<name>.tiles.json`),
  `validate-extension.mjs` (`EP_progressive_lod` conformance check).
- `examples/local-progressive/` — `stress.html` → `stress.js` (the stress demo,
  with `draw-call-batching.js` / `multi-draw-*.js`), `serve.mjs` (dev server),
  `measure-fps.mjs` and `gpu-lerp-check.mjs` (headless harnesses), and single-
  feature witness pages (`cluster-lod-test.html`, `model-pool-cluster-test.html`,
  `vrm-multidriver-witness.html`, `webgpu-*.html`).
- `extensions/EP_progressive_lod/` — spec and JSON Schema.

## Usage

```
npm install
npm run demo:local                # http://127.0.0.1:5180/
CHANNEL=chrome npm run measure -- 500 1000   # steady-state FPS per entity count
```

## glTF extension: `EP_progressive_lod`

The baker emits **`EP_progressive_lod`** only for skinned primitives: it
declares their discrete mesh LOD siblings (`storage: "sibling-file"`,
`textures: []`). It is listed in `extensionsUsed`, never `extensionsRequired`, so
a viewer that ignores it renders the full-resolution base. The runtime reads it,
or the pre-rename `extras.LOCAL_progressive` payload. The spec and
`validate-extension.mjs` also define a `single-glb-range` storage mode, but
nothing in this package bakes or streams it any more.

- Spec + JSON Schema: [`extensions/EP_progressive_lod/`](extensions/EP_progressive_lod/README.md)
- Conformance check: `node tools/validate-extension.mjs <model.glb>`

**Registration status:** the `EP` vendor prefix is *not yet registered* with
the Khronos glTF extension registry; the name is provisional until a
registration PR to [KhronosGroup/glTF](https://github.com/KhronosGroup/glTF)
lands.

## Octahedral impostors (final LOD)

Opt-in (`ModelPool` option `useImpostorFinalLod`, or the demo's `?impostor=1`).
Past the `BatchedMesh` far tier, a model below `impostorPx` (default 14) screen
pixels collapses to a camera-facing billboard rendering **lit** impostors
(`octahedral-impostor-ez-tier.js`): the atlas is a 2-target render (albedo +
packed normal/depth) per asset, so the billboard receives scene lighting (a
`MeshStandardMaterial`-based material) and blends the three nearest captured
views. The atlas is 1024 px by default (`impostorTextureSize`), and at most
`impostorMaxAssets` (default 64) assets get one. Each impostor'd asset gets its
own `InstancedMesh`, so the far population draws in **N draw calls for N
distinct assets**. The sampling/baking code is localized from
[@three.ez/octahedron-imposter](https://github.com/agargaro/octahedral-impostor)
(`octahedral-impostor-ez.js`).

The atlas is rendered **on the fly** the first time an asset reaches impostor
distance — no bake step, no extra download. The bake is **incremental**:
`impostorCellBudget` octahedral cells (default 4) per frame, doubled when FPS is
more than 10 above `targetFps` and halved below it. An opt-in dithered
mesh<->impostor crossfade (`impostorFade`, `impostorFadeBandPx`, default 6)
replaces the hard cut.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes per version.

## Notes

- The renderer is draw-call-bound at scale. The far tier collapses many distinct
  models into one `THREE.BatchedMesh` draw, and the FPS controller scales LOD
  distance (`_lodDistanceScale`) to hold `targetFps` (default 50).
- Baked `examples/local-progressive/output_*/` assets are git-ignored.

## Credits

- **[@three.ez/octahedron-imposter](https://github.com/agargaro/octahedral-impostor)**
  by Andrea Gargaro (MIT) — the lit octahedral impostor (atlas capture + sampling
  shaders) is localized into `src/octahedral-impostor-ez.js`
  (TS ported to JS, GLSL inlined, full-octahedron encode/decode completed).
- **[draco.js](https://github.com/mrdoob/draco.js)** by mrdoob (Apache-2.0) —
  vendored pure-JS Draco decoder (`draco-loader.js`).
