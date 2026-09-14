---
key: mem-bd41a69bbad2bcd6-382
ns: default
created: 1789392531338
updated: 1789392531338
---

project/batchedmesh-array-material-never-draws: a THREE.BatchedMesh given an array material (GLTFLoader can assign [mat] for one primitive) silently never draws: projectObject iterates geometry.groups for array materials and BatchedMesh groups stay empty (live: 0 draw calls, no error). material-bucket-batcher.js _bucketFor unwraps seedMaterial[0]; every BatchedMesh consumer must.
