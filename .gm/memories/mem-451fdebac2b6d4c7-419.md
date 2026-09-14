---
key: mem-451fdebac2b6d4c7-419
ns: default
created: 1789392310440
updated: 1789392310440
---

project/entity-primitive-shared-cache-invariants: client/EntityLoader.js _primGeoKey must use the same ||-defaults as EntityLoaderMeshBuild MESH_BUILDERS (capsule r0.3/h1.8 also mirrors AppPhysics capsule collider and EditorHandlers). Cached geo/materials carry userData._spointShared: never dispose per entity (_disposeOwned) and clone before any per-entity mutation (repaintEntity copy-on-write) or siblings recolour.
