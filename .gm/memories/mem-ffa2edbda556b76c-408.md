---
key: mem-ffa2edbda556b76c-408
ns: default
created: 1789391408438
updated: 1789391408438
---

project/floating-origin-snapshot-targets-to-render: client/core/SceneGraph.js setEntityTransforms/setPlayerTransforms/setPlayerTransformsFromRing must pass every raw authoritative wire position through floatingOrigin.toRender before storing node.target. Snapshots arrive far more often than rebases, so a path that skips it silently undoes the rebase translate next snapshot (meshes left ~100km from camera).
