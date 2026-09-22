---
key: mem-beedafd24ddcce93-1231
ns: default
created: 1790064255741
updated: 1790064255741
---

## Resolved mutable: tsl-batched-far-tier-onbeforecompile-silent-noop

Superseded by a real port, resolved in the same pass as sibling mutable tsl-batchedfartier-relies-on-batchedmesh-raw-glsl-chunks: packages/streaming-gltf/src/batched-far-tier-tsl.js now gives BatchedFarTier's WebGPU path the SAME GPU lerp-interpolation and gamma-correct vertex color it always had under WebGL, via material.positionNode/colorNode composing on top of NodeMaterial's automatic batch() application (see node_modules/three/src/materials/nodes/NodeMaterial.js:790-806) rather than the previously-accepted 'safe silent no-op, feature-less' fallback. batched-far-tier.js's constructor now branches on pool.renderer.isWebGPURenderer to build the TSL material via makeBatchedFarTierMaterialTSL instead of always building the WebGL onBeforeCompile MeshBasicMaterial. LIVE-WITNESSED via gm browser verb against a real WebGPU device: a real THREE.BatchedMesh instance's rendered pixel-cluster centroid moved from cx=127.5 (uNow=0, lerp start) to cx=204 (uNow=2, lerp end), a genuine ~76px shift matching the configured world +6 unit lerp target, zero WebGPU validation errors -- confirms the far-tier fallback is no longer a silent no-op under ?webgpu=1.
