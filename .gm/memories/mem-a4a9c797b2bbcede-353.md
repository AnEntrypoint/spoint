---
key: mem-a4a9c797b2bbcede-353
ns: default
created: 1789392337684
updated: 1789392337684
---

project/veg-impostor-zero-area-lod-bbox-bvh: VegImpostorTier createSharedImpostorMesh stamps a +-1 boundingBox (not only a radius-1 sphere) on its zero-area near-LOD geo and plane: @three.ez computeBVH builds leaves from geometry.boundingBox, so a zero-volume box silently culls 100% of instances (count stays 0, no error, instancesCount looks healthy).
