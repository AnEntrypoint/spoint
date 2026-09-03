# Cluster-LOD glTF renderer

A self-contained three.js renderer for large scenes of distinct glTF/GLB models
using **UV-aware spatial meshlet clusters**: each model is baked into one valid
GLB of spatially coherent clusters, each carrying a hierarchy of UV-aware
simplified LODs, packed into a single unified buffer. At runtime every visible
cluster picks a LOD by projected screen size and the whole mesh draws in a single
`WEBGL_multi_draw` call. Textures never tear (UV-aware simplification), and stock
glTF viewers ignore the cluster metadata and render the full-resolution mesh.

See [AGENTS.md](AGENTS.md) for the format (`EP_cluster_lod` extras +
`EXT_meshopt_compression`) and runtime details.

## Live demo

**https://anentrypoint.github.io/streaming-gltf/** — the stress demo, deployed
from `examples/local-progressive/` by `.github/workflows/deploy-pages.yml`. It
ships code only: `three` loads from a CDN (importmap) and the cluster-LOD models
are streamed **cross-origin** from the assets host
(`https://anentrypoint.github.io/assets/`), discovered from its unified
`manifest.json` (`{Category:[{name,path,thumb}]}`, `path =
streaming-cluster/<name>.cluster.glb`). Override the asset source with
`?assets=<baseUrl>`, or `?assets=local` with the dev server (`npm run demo:local`,
which serves the sibling `../assets/streaming-cluster` corpus under `/cluster/`).

## SDK usage

`streaming-gltf` is an importable ES module. `three` and `@pixiv/three-vrm` are
**peer dependencies** — provide them yourself (e.g. via an importmap pointing at
a CDN build, or your bundler); they are not bundled.

```js
import { ModelPool } from 'streaming-gltf';
// also exported: ClusterLodMesh, attachClusterLod (runtime),
// buildClusterLod, parseClusterLod, CLUSTER_LOD_EXTRA_KEY (codec).

const pool = new ModelPool({ scene, renderer, camera });
const entity = pool.spawn(url, { position: [x, 0, z] }); // url -> a cluster GLB

// per frame, after advancing the camera (per-cluster LOD + multi-draw self-drive):
pool.update();

// sparse position targets — the GPU interpolates each frame:
pool.setTarget(entity, x, y, z, durationMs);
```

Bake a source GLB to the cluster-LOD format:

```sh
npm run bake -- path/to/source.glb path/to/out.cluster.glb
npm run bake:corpus            # whole ../assets corpus -> manifest.cluster.json
```

## VRM support

VRM avatars load through `@pixiv/three-vrm` v3 (a peer dependency). When a baked
GLB carries the `VRMC_vrm` extension, the `GLTFLoader` is registered with
`VRMLoaderPlugin` and the parsed `gltf.userData.vrm` runtime is driven each frame
by `pool.update()` — humanoid bones, spring bones, expressions, and look-at all
animate. The HUD in the example reports the detected humanoid bone count.

What works:

- Full humanoid / spring-bone / expression / look-at runtime on a VRM avatar.
- Progressive mesh + texture LOD on the avatar's primitives, exactly as for any
  other model. Sibling LOD chunks are loaded **without** the VRM plugin
  (`includeVrm: false`), so MToon material setup runs once on the root only.
- MToon materials are LOD-swapped safely: texture-LOD application matches strictly
  by texture name against the material's existing slots, so it never stamps a
  foreign bitmap into an MToon slot.

Multi-driver — every instance animates independently. `@pixiv/three-vrm` v3
exposes no skeleton-rebind clone (`VRM.prototype` is `[constructor, update]` only;
there is no `vrm.clone()` / `VRMUtils.clone`), and its humanoid/spring-bone/
expression managers bind the bones of the scene they were parsed against. Rather
than share one runtime, the pool retains the asset's raw GLB bytes and **re-parses
an independent VRM per driven entity** — each gets its own scene, its own humanoid/
spring-bone/expression managers, and is driven independently by `vrm.update(dt)`.
N pooled instances of one VRM all animate (distinct spring physics, distinct
expressions); none freeze in bind pose. Per-instance parses are concurrency-bounded
(heavy work) and queue when the limit is reached. This mirrors how a multiplayer
host parses one VRM per player.

`entity.dispose()` runs `VRMUtils.deepDispose()` on that entity's own VRM scene,
freeing its spring/collider/expression GPU resources without touching siblings.
`pool.dispose()` tears the pool down (every entity, then every asset).

## Geometry decoding (Draco + meshopt)

Baked GLBs are compressed with both meshopt and Draco
(`KHR_draco_mesh_compression`). meshopt decodes via three's
`MeshoptDecoder`. Draco decodes via **[draco.js](https://github.com/mrdoob/draco.js)**,
mrdoob's pure-JavaScript port of the Draco decoder, vendored at
`src/draco-loader.js` as a drop-in for three's own
`DRACOLoader`.

This replaces the WASM Draco decoder. The win is deployment simplicity: no
`.wasm` fetch and no runtime CDN — the previous setup pulled the decoder from
`https://www.gstatic.com/draco/versioned/decoders/...` on first decode, a
third-party runtime dependency with cross-origin/CSP exposure. draco.js is one
~24 KB-gzipped ES module that ships with the page. It is decode-only (the
bake-time encoder in `tools/bake-progressive.mjs` still uses the `draco3dgltf`
WASM module, which is a dev-time Node dependency, not shipped to the browser),
and implements the EdgeBreaker triangle-mesh path that glTF/Draco content uses.
WASM is faster in absolute terms (~1.4-1.6x on large meshes) but the decode is
byte-for-byte equivalent.

The LOD web worker (`lod-worker.js`) loads the same vendored module, rewriting
its bare `three` import to the esm.sh URL the worker already uses, so
Draco+meshopt sibling LODs decode off-thread too. Decoder logic is a port of
Google Draco (Apache-2.0); the loader API mirrors three.js's `DRACOLoader` (MIT).

## Textures (single GPU-compressed KTX2)

Each texture is baked to **one** mipmapped **KTX2 (Basis Universal)** file
(`KHR_texture_basisu`) -- no per-size webp ladder. Color maps use **ETC1S**
(sRGB, smallest), normal/ORM maps use **UASTC** (linear; ETC1S wrecks normals).
At runtime a `KTX2Loader` (transcoder vendored at
`examples/local-progressive/basis/`, served locally) transcodes it to a
**GPU-compressed** texture for the device (BC7/BCn on desktop, ASTC/ETC2 on
mobile) -- witnessed `isCompressedTexture` with a 10-level mip chain. The GPU mip
chain handles distance LOD, so **texture streaming is eliminated**: progressive
streaming is now geometry/vertex-only. Far entities render vertex-colored
geometry (baked to match the texture); the single KTX2 arrives with the root GLB
for the near/textured view -- vertices first, then texture.

Downscaled to `BAKE_TEX_SIZE` (default 1024; set e.g. `512` to compress harder)
before encoding. `KHR_texture_basisu` is a standard Khronos extension, so any
loader with a KTX2 transcoder (three, Babylon, model-viewer) opens it; it is
declared required (KTX2 carries no fallback image), but the untextured
geometry+vertex-color far path covers loaders without it. Encoded with
**ktx2-encoder** (Basis); the transcoder is three.js's vendored Binomial Basis
wasm (Apache-2.0).

## Layout

- `examples/local-progressive/` — the renderer (latest). Entry: `stress.html` →
  `stress.js` → `model-pool.js` (+ `draw-call-batching.js`, `batched-far-tier.js`,
  `material-pool.js`, `deferred-load-queue.js`, `lod-unload-manager.js`,
  `frustum-cache.js`, `multi-draw-optimizer.js` / `multi-draw-utils.js`,
  `vertex-compression.js`, `draw-call-sorter.js`, `buffer-pool.js`,
  `lod-worker.js`, `octahedral-impostor-ez.js` / `octahedral-impostor-ez-tier.js`).
  `serve.mjs` is the dev server; `measure-fps.mjs` the steady-state FPS harness.
- `tools/` — the conversion + download pipeline:
  - `bake-progressive.mjs` — convert one source GLB into a progressive GLB
    (meshopt decimation + sharp texture resizing + a `EP_progressive_lod`
    extension referencing sibling LOD files).
  - `bake-all.mjs` — batch-bake every model under a source dir.
  - `bake-streaming.mjs` — download + bake for the streaming workflow.
- `models/` — source models fed to the bake tools.

## Usage

Install deps once:

```
npm install
```

Convert source models into the progressive format the renderer loads
(`examples/local-progressive/output_<name>/`):

```
npm run bake:local -- models/<model>.glb examples/local-progressive/output_<name>
# or batch every model under a directory:
npm run bake:all -- models
```

Run the renderer (serves the stress demo at `/`):

```
npm run demo:local
# open http://127.0.0.1:5180/
```

Measure steady-state FPS (hardware GPU via system Chrome):

```
CHANNEL=chrome npm run measure -- 500
```

## glTF extension: `EP_progressive_lod`

The bake pipeline emits a glTF extension, **`EP_progressive_lod`**, that
declares the progressive LOD ladder (per-mesh and per-texture) the renderer
consumes. The base glTF always carries the *coarsest* LOD, and the extension is
declared in `extensionsUsed` — never `extensionsRequired` — so a viewer that
does not implement it simply renders that coarse base and ignores the rest. Two
storage modes are covered by one extension, discriminated by a `storage` field:
`sibling-file` (higher LODs in sibling files, `bake-progressive.mjs`) and
`single-glb-range` (all LODs packed as `bufferView` byte ranges in one GLB,
range-fetched on demand, `bake-streaming.mjs`).

### Progressive (".plod-style") load on a regular glTF

`single-glb-range` is baked **coarse-first**: the base LOD (coarsest geometry +
smallest textures) is packed immediately after the JSON chunk, and the default
primitives/images reference it. So the one `model.streaming.glb` is a **valid
glTF any loader opens** (it renders the coarse base; `EP_progressive_lod` is
`extensionsUsed`, never required), AND a byte-prefix is the renderable base — a
client can **HTTP-Range-fetch the prefix to show coarse, then range-fetch finer
LODs as they arrive**, the progressive behaviour of a custom `.plod` stream but
on a standard file. `examples/local-progressive/plod-gltf-stream.js` is the
range consumer (`loadStreamingHeader` -> `streamMeshLods` coarse->fine); the dev
server (`serve.mjs`) supports HTTP Range. Witnessed: the coarse base builds from
~58 KB of a 362 KB file (6 range requests) without downloading the whole model.

Size note: `single-glb-range` packs LOD attributes **uncompressed** (so each
bufferView is a clean range to fetch), which is larger than the draco/meshopt
`sibling-file` format. When download size matters more than single-file
range-streaming, prefer `sibling-file` (the default), which also loads
coarse-first and progressively. `single-glb-range` could adopt per-bufferView
`EXT_meshopt_compression` to remove that size delta.

- Spec + JSON Schema: [`extensions/EP_progressive_lod/`](extensions/EP_progressive_lod/README.md)
- Conformance check: `node tools/validate-extension.mjs <model.glb>`

**Registration status:** the `EP` vendor prefix is *not yet registered* with
the Khronos glTF extension registry; the name is provisional until a
registration PR to [KhronosGroup/glTF](https://github.com/KhronosGroup/glTF)
lands. Assets baked before the rename (payload under `extras.LOCAL_progressive`)
are still read by the runtime via a compatibility fallback.

## Octahedral impostors (final LOD)

Opt-in (`ModelPool` option `useImpostorFinalLod`, or the demo's `?impostor=1`).
Past the vertex-color `BatchedMesh` far tier, a model below `impostorPx` (default
14) screen pixels collapses to a single camera-facing billboard rendering **lit**
impostors (`octahedral-impostor-ez-tier.js`): the on-the-fly atlas is a 2-target
render (albedo + packed normal/depth) per asset, so the billboard receives scene
lighting (a real `MeshStandardMaterial`) and blends the three nearest captured
views with per-sprite plane-projected UVs. It bakes a 1024 atlas (handles
~1M-triangle source models) incrementally, capped by `impostorMaxAssets` (default
64). Each impostor'd asset gets its own `InstancedMesh`, so the far population
draws in **N draw calls for N distinct assets** — not this renderer's bottleneck
(triangle/fill is), and N is small at the farthest LOD. The impostor
sampling/baking code is localized from
[@three.ez/octahedron-imposter](https://github.com/agargaro/octahedral-impostor)
(`octahedral-impostor-ez.js`).

The atlas is rendered **on the fly** in-browser the first time an asset reaches
impostor distance — no bake step, no extra download. To avoid frame stalls, the
bake is **incremental**: `impostorCellBudget` octahedral cells (default 4) are
rendered per frame and the atlas accumulates over a few frames; each asset's
render targets are eager-allocated at first bake so per-frame VRAM allocation is
off the swap path. The budget is **headroom-gated** (like the LOD warm loader) —
doubled when FPS sits above target so coverage converges faster, halved under
target so baking never deepens a frame deficit.

An opt-in dithered mesh<->impostor crossfade (`impostorFade`, `impostorFadeBandPx`)
ramps the impostor's opacity in via a screen-space interleaved-gradient-noise
discard as it acquires, so the LOD swap is a soft crossfade instead of a hard cut.

**History:** a sibling unlit `sampler2DArray`-atlas tier
(`octahedral-impostor.js` / `octahedral-impostor-tier.js`, 1 draw for ALL
assets vs the lit tier's N-draws-for-N-assets) existed alongside this one,
selected via a `useImpostorEz:false` opt-out. It was deleted (see
`draw-call-audit-impostor-array-tier-deprecation-decision` in the spoint repo's
PRD history) after an audit found it unreachable on every real serving path —
the sole real `ModelPool` consumer hardcoded the lit variant, and no
low-tier-device gating was ever wired to reach the unlit fallback. If
N-draws-for-N-assets ever becomes a real bottleneck, the deleted tier's
single-draw-via-array-texture idea is the concrete approach to fold back in as
an opt-in mode on this tier, rather than reviving unlit dead code.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes per version.

## Notes

- The renderer is draw-call-bound at scale; the FAR tier collapses many distinct
  models into a single `THREE.BatchedMesh` draw and the FPS controller adjusts
  LOD *distance* (not a global ceiling) to hold the target frame rate.
- Baked `output_*/` assets are git-ignored (regenerate with the bake tools).

## Credits

- **[@three.ez/octahedron-imposter](https://github.com/agargaro/octahedral-impostor)**
  by Andrea Gargaro (MIT) — the lit octahedral impostor (atlas capture + sampling
  shaders) is localized into `src/octahedral-impostor-ez.js`
  (TS ported to JS, GLSL inlined, full-octahedron encode/decode completed). The
  related `@three.ez/batched-mesh-extensions` was evaluated but not vendored: its
  draw/cull wins are non-binding here (the far tier already draws in one call).
- **[draco.js](https://github.com/mrdoob/draco.js)** by mrdoob (Apache-2.0) —
  vendored pure-JS Draco decoder (`draco-loader.js`).
