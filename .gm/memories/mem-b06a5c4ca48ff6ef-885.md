---
key: mem-b06a5c4ca48ff6ef-885
ns: default
created: 1790056640717
updated: 1790056640717
---

## Resolved mutable: tsl-impostor-wrap-arbitrary-material-needs-nodematerial

Read packages/streaming-gltf/src/octahedral-impostor-ez.js lines 203-266 (createOctahedralImpostorMaterial/overrideMaterialCompilation: onBeforeCompile string-splice at #include points, applied to new BaseType()). exec_js live witness: const src=new THREE.MeshStandardMaterial(...); const atlasMat=makeAtlasCaptureMaterialTSL(src); atlasMat.isNodeMaterial===true, atlasMat.mrtNode/normalNode populated -- confirms TSL's real composition surface is positionNode/normalNode/colorNode/mrtNode properties on a *NodeMaterial instance, not a textual include-point splice available on an arbitrary Material subclass. Recorded as a design finding requiring the wrapped material to already be a NodeMaterial; not mechanically portable, out of scope for this pass's atlas-bake port (which IS complete and witnessed).
