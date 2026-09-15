---
key: mem-a8bff79abaf37b53-795
ns: default
created: 1789411868814
updated: 1789411868814
---

project/streaming-gltf-bake-skinned-lod-siblings: bake-cluster.mjs _bakeSkinnedLods gives skinned/morph prims (not clusterable) discrete meshopt simplify() LODs at ratios 0.4/0.15 as sibling GLBs under <outDir>/lods/ (simplify keeps JOINTS_0/WEIGHTS_0 and morph deltas since the simplified index is a vertex subset). Each ratio uses cloneDocument(srcDoc) because simplify is destructive and chaining ratios compounds error; the sibling is stripped to one primitive because the LOD worker takes the first mesh. decodeAABB = POSITION min/max before quantization (worker rescales decoded positions with it). _spliceProgressiveLod must write textures: [] explicitly: model-pool Asset._load iterates ext.textures, and omitting it aborted every skinned bake's load with 'ext.textures is not iterable'.
