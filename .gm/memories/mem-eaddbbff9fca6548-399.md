---
key: mem-eaddbbff9fca6548-399
ns: default
created: 1789392528623
updated: 1789392528623
---

project/streaming-gltf-ktx2-mip-cap-mirrors-progressive-ktx2: packages/streaming-gltf/src/ktx2-mip-cap.js _stripLeadingLevels is a deliberate copy of client/core/ProgressiveKTX2.js buildPartialKtx2 (streaming-gltf is standalone, must not import client/core). Both need the same rewrites: pixelWidth/Height >> startLevel and BasisLZ SGD imageDescs filtered to kept levels; fix container bugs in both.
