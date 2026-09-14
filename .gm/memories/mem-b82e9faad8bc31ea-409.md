---
key: mem-b82e9faad8bc31ea-409
ns: default
created: 1789392331130
updated: 1789392331130
---

project/three-shaderchunk-edit-needsupdate-noop: three's program cache key hashes shaderID/defines, not resolved ShaderChunk text, so editing a chunk + material.needsUpdate reuses the old program (silent no-op, live-witnessed). WetnessTint instead registers one shared Float32Array(1) uniform on every ShaderLib entry + UniformsLib.fog (cloneUniforms shares typed arrays by reference) and writes it per frame.
