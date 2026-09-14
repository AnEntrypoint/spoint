---
key: mem-f2bbde1d76216bdd-410
ns: default
created: 1789391587165
updated: 1789391587165
---

project/mapspinner-geomorph-crackfree-rules: terrain.glsl VS geomorph ratio is per-VERTEX from a level-keyed range (defOffset.z*uMorphSplitDist*uMorphDistFactor .. x2), never per-quad/instance (siblings differ -> seam gaps). Skirt/ring verts (vertex.z>0.5) are excluded (morph slid the curtain off the edge -> live crack). Snap in face-absolute metres to 2l/uGrid; a per-quad snap is exact only for even uGrid.
